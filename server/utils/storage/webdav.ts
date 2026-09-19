import { Readable } from 'node:stream'
import { contentTypeFromKey } from '../content-type'
import { validateImageKey } from '../image-key'
import type {
  ServingMode,
  StoredImage,
  StoredImageMeta,
  StorageBackend,
  WebdavBackendConfig,
  WebdavBackendSecrets
} from './types'

/**
 * WebDAV 存储后端。
 *
 * 基于标准 WebDAV 方法（PUT / GET / HEAD / DELETE / MKCOL / PROPFIND）实现，
 * 直接使用运行时内置的 fetch，不依赖任何第三方 WebDAV 客户端库，
 * 因此对 802.1 通用 WebDAV 服务（Nextcloud、坚果云、Alist、Apache mod_dav、
 * 群晖/威联通、wsgidav 等）都具备良好兼容性。
 *
 * 目录结构：`{baseUrl}/{path}/{图片 key}`，例如
 *   https://dav.example.com/remote.php/dav/files/user + pichost + images/2026/09/xxx.webp
 */

/** 去掉末尾斜杠，保留 baseUrl 自身可能携带的路径（如 /dav） */
export function normalizeWebdavBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** 归一化存储路径：去掉首尾斜杠、折叠重复斜杠 */
export function normalizeWebdavPath(raw: string | undefined): string {
  if (!raw) return ''
  return raw
    .trim()
    .split('/')
    .filter(segment => segment && segment !== '.')
    .join('/')
}

function splitSegments(value: string | undefined): string[] {
  if (!value) return []
  return value.split('/').filter(Boolean)
}

/**
 * 拼接 WebDAV 对象路径（不含 baseUrl），逐段编码以兼容中文/空格文件名。
 * 过滤 `..` 防止目录穿越。
 */
export function buildWebdavObjectPath(
  pathPrefix: string | undefined,
  key?: string
): string {
  const segments = [...splitSegments(pathPrefix), ...splitSegments(key)]
  return segments
    .filter(segment => segment !== '..')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

export function parseWebdavConfig(raw: string): WebdavBackendConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WebdavBackendConfig>
    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : ''
    if (!baseUrl) return null
    return {
      baseUrl: normalizeWebdavBaseUrl(baseUrl),
      path: normalizeWebdavPath(parsed.path)
    }
  } catch {
    return null
  }
}

/** 允许用户名为空（匿名 WebDAV）；仅在 JSON 无法解析时返回 null */
export function parseWebdavSecrets(raw: string): WebdavBackendSecrets | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WebdavBackendSecrets>
    return {
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: typeof parsed.password === 'string' ? parsed.password : ''
    }
  } catch {
    return null
  }
}

export function validateWebdavConfig(config: WebdavBackendConfig): string | null {
  if (!config.baseUrl.startsWith('http')) {
    return '服务器地址需为 http(s) 地址'
  }
  try {
    // 校验是否为合法 URL
    void new URL(config.baseUrl)
  } catch {
    return '服务器地址格式无效'
  }
  const path = config.path ?? ''
  if (path.split('/').includes('..')) {
    return '存储路径不能包含 ..'
  }
  return null
}

/** 从 PROPFIND 响应中提取属性值（兼容各种命名空间前缀） */
function extractProp(xml: string, localName: string): string | null {
  const match = xml.match(
    new RegExp(`<[^>]*\\b${localName}\\b[^>]*>([\\s\\S]*?)</[^>]*\\b${localName}\\b>`, 'i')
  )
  return match?.[1]?.trim() ?? null
}

/** MKCOL 的成功语义：201 新建 / 405 已存在 / 301·302 部分服务器重定向到已存在集合 */
function isCollectionOk(status: number): boolean {
  return status === 201 || status === 405 || status === 301 || status === 302 || status === 200
}

/**
 * Uint8Array 在运行时就是合法的 fetch body。
 * TS 6 起 Uint8Array 带泛型参数，无法直接匹配 BodyInit，故转换为 ArrayBuffer。
 * 仅当视图正好覆盖整个底层 buffer 时复用，否则复制，避免把池化 Buffer 的额外字节发出去。
 */
function toBodyInit(bytes: Uint8Array): BodyInit {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer
}

export class WebdavStorageBackend implements StorageBackend {
  readonly id: string
  readonly type = 'webdav' as const
  readonly servingMode: ServingMode
  readonly publicUrl: string
  private readonly baseUrl: string
  private readonly pathPrefix: string
  private readonly username: string
  private readonly password: string
  /** 进程内缓存已确认存在的集合，避免每张图片重复 MKCOL */
  private readonly ensuredCollections = new Set<string>()

  constructor(
    id: string,
    config: WebdavBackendConfig,
    secrets: WebdavBackendSecrets,
    servingMode: ServingMode = 'proxy',
    publicUrl = ''
  ) {
    this.id = id
    this.servingMode = servingMode
    this.publicUrl = publicUrl
    this.baseUrl = normalizeWebdavBaseUrl(config.baseUrl)
    this.pathPrefix = normalizeWebdavPath(config.path)
    this.username = secrets.username ?? ''
    this.password = secrets.password ?? ''
  }

  private authHeaders(): Record<string, string> {
    if (!this.username && !this.password) return {}
    const token = Buffer.from(
      `${this.username}:${this.password}`,
      'utf8'
    ).toString('base64')
    return { Authorization: `Basic ${token}` }
  }

  /** 对象完整 URL；key 省略时返回存储根目录 URL */
  private urlFor(key?: string): string {
    const suffix = buildWebdavObjectPath(this.pathPrefix, key)
    return suffix ? `${this.baseUrl}/${suffix}` : this.baseUrl
  }

  private async ensureCollection(url: string): Promise<void> {
    if (this.ensuredCollections.has(url)) return

    const response = await fetch(url, {
      method: 'MKCOL',
      headers: this.authHeaders()
    })

    if (!isCollectionOk(response.status)) {
      throw new Error(`WebDAV 无法创建目录「${decodeURIComponent(url)}」（HTTP ${response.status}）`)
    }
    this.ensuredCollections.add(url)
  }

  /** 逐级创建存储根目录与 key 的父目录 */
  private async ensureParentCollections(key: string): Promise<void> {
    const segments = [
      ...splitSegments(this.pathPrefix),
      ...splitSegments(key).slice(0, -1)
    ]
    if (!segments.length) return

    let current = this.baseUrl
    for (const segment of segments) {
      current = `${current}/${encodeURIComponent(segment)}`
      await this.ensureCollection(current)
    }
  }

  /** HEAD 不可用时退回 PROPFIND（部分 WebDAV 实现屏蔽了 HEAD） */
  private async propsViaPropfind(url: string): Promise<{
    size: number
    contentType: string
    lastModified: string
  } | null> {
    const response = await fetch(url, {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), Depth: '0' }
    })
    if (response.status !== 207 && !response.ok) return null

    const xml = await response.text()
    const length = extractProp(xml, 'getcontentlength')
    if (length === null) return null

    return {
      size: Number(length) || 0,
      contentType: extractProp(xml, 'getcontenttype') ?? '',
      lastModified: extractProp(xml, 'getlastmodified') ?? ''
    }
  }

  async put(key: string, bytes: Uint8Array, meta: StoredImageMeta): Promise<void> {
    await this.ensureParentCollections(key)

    const response = await fetch(this.urlFor(key), {
      method: 'PUT',
      headers: {
        ...this.authHeaders(),
        'Content-Type': meta.contentType || 'application/octet-stream'
      },
      body: toBodyInit(bytes)
    })

    if (!response.ok) {
      throw new Error(`WebDAV 上传失败「${key}」（HTTP ${response.status}）`)
    }
  }

  async head(key: string): Promise<StoredImage | null> {
    if (!validateImageKey(key)) return null

    const url = this.urlFor(key)
    let size: number
    let contentType: string
    let lastModified: string

    const response = await fetch(url, { method: 'HEAD', headers: this.authHeaders() })

    if (response.ok) {
      size = Number(response.headers.get('content-length') ?? 0) || 0
      contentType = response.headers.get('content-type') ?? ''
      lastModified = response.headers.get('last-modified') ?? ''
    } else if (response.status === 405 || response.status === 501 || response.status === 400) {
      const props = await this.propsViaPropfind(url)
      if (!props) return null
      size = props.size
      contentType = props.contentType
      lastModified = props.lastModified
    } else {
      return null
    }

    const modified = lastModified ? Date.parse(lastModified) : Number.NaN
    const mtimeMs = Number.isFinite(modified) ? modified : Date.now()

    return {
      key,
      size,
      mtimeMs,
      contentType: contentType.split(';')[0]?.trim() || contentTypeFromKey(key),
      originalName: key.split('/').pop() ?? 'image',
      uploadedAt: new Date(mtimeMs).toISOString(),
      userId: null,
      backendId: this.id
    }
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(this.urlFor(key), {
      method: 'DELETE',
      headers: this.authHeaders()
    })

    // 404 视为已删除，保证幂等
    if (!response.ok && response.status !== 404) {
      throw new Error(`WebDAV 删除失败「${key}」（HTTP ${response.status}）`)
    }
  }

  async createStream(
    key: string,
    range?: { start: number, end: number }
  ): Promise<Readable> {
    const response = await fetch(this.urlFor(key), {
      method: 'GET',
      headers: {
        ...this.authHeaders(),
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {})
      }
    })

    if (!response.ok) {
      throw new Error(`WebDAV 读取失败「${key}」（HTTP ${response.status}）`)
    }
    if (!response.body) {
      throw new Error('WebDAV 响应体为空')
    }

    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  }

  async testConnection(): Promise<{ ok: boolean, message: string }> {
    try {
      // 1) 先探测服务器地址本身，用于区分「鉴权失败」与「路径不存在」
      const root = await fetch(this.baseUrl, {
        method: 'PROPFIND',
        headers: { ...this.authHeaders(), Depth: '0' }
      })
      if (root.status === 401 || root.status === 403) {
        return {
          ok: false,
          message: `鉴权失败（HTTP ${root.status}），请检查用户名与密码`
        }
      }
      if (root.status !== 207 && !root.ok) {
        return {
          ok: false,
          message: `无法访问服务器地址（HTTP ${root.status}）`
        }
      }

      // 2) 确保存储目录存在
      if (this.pathPrefix) {
        await this.ensureCollection(this.urlFor())
      }

      // 3) 校验存储路径可访问
      const target = await fetch(this.urlFor(), {
        method: 'PROPFIND',
        headers: { ...this.authHeaders(), Depth: '0' }
      })
      if (target.status === 401 || target.status === 403) {
        return {
          ok: false,
          message: `鉴权失败（HTTP ${target.status}），请检查用户名与密码`
        }
      }
      if (target.status !== 207 && !target.ok) {
        return {
          ok: false,
          message: `无法访问存储路径（HTTP ${target.status}）`
        }
      }

      // 4) 写入探针校验写权限，随后清理
      const probeKey = `__pichost-probe-${Date.now()}.txt`
      const probeBytes = new TextEncoder().encode('pichost-probe')
      await this.put(probeKey, probeBytes, {
        originalName: probeKey,
        uploadedAt: new Date().toISOString(),
        contentType: 'text/plain',
        size: probeBytes.byteLength
      })
      await this.delete(probeKey)

      return { ok: true, message: '连接成功' }
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败'
      return { ok: false, message }
    }
  }

  async getUsageStats(): Promise<{ count: number, bytes: number }> {
    return { count: 0, bytes: 0 }
  }
}

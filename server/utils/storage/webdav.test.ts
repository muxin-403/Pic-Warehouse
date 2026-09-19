import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Readable } from 'node:stream'
import {
  buildWebdavObjectPath,
  normalizeWebdavBaseUrl,
  normalizeWebdavPath,
  parseWebdavConfig,
  parseWebdavSecrets,
  validateWebdavConfig,
  WebdavStorageBackend
} from './webdav'

const CONFIG = {
  baseUrl: 'https://dav.example.com/remote.php/dav/files/user',
  path: 'pichost'
}
const SECRETS = { username: 'alice', password: 's3cret' }

function createBackend(overrides?: {
  config?: Partial<typeof CONFIG>
  secrets?: Partial<typeof SECRETS>
}) {
  return new WebdavStorageBackend(
    'webdav-test',
    { ...CONFIG, ...overrides?.config },
    { ...SECRETS, ...overrides?.secrets }
  )
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** 构造可记录调用的 fetch 桩；handler 决定每个请求的响应 */
function stubFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>
): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebDAV helpers', () => {
  it('normalizes base url and storage path', () => {
    expect(normalizeWebdavBaseUrl('  https://dav.example.com/dav/  ')).toBe(
      'https://dav.example.com/dav'
    )
    expect(normalizeWebdavPath('/pichost//images/')).toBe('pichost/images')
    expect(normalizeWebdavPath(undefined)).toBe('')
    expect(normalizeWebdavPath('./')).toBe('')
  })

  it('builds encoded object paths and blocks traversal', () => {
    expect(buildWebdavObjectPath('pichost', 'images/2026/09/a.webp')).toBe(
      'pichost/images/2026/09/a.webp'
    )
    expect(buildWebdavObjectPath('/pichost/', 'images/a.webp')).toBe(
      'pichost/images/a.webp'
    )
    expect(buildWebdavObjectPath('', 'images/a.webp')).toBe('images/a.webp')
    // 中文文件名与空格需逐段编码
    expect(buildWebdavObjectPath('pichost', 'images/我的 图.webp')).toBe(
      'pichost/images/%E6%88%91%E7%9A%84%20%E5%9B%BE.webp'
    )
    // 目录穿越被丢弃
    expect(buildWebdavObjectPath('pichost', '../../etc/passwd')).toBe(
      'pichost/etc/passwd'
    )
  })

  it('parses config and secrets', () => {
    expect(parseWebdavConfig('{}')).toBeNull()
    expect(parseWebdavConfig(JSON.stringify({
      baseUrl: 'https://dav.example.com/dav/',
      path: '/pichost/'
    }))).toEqual({
      baseUrl: 'https://dav.example.com/dav',
      path: 'pichost'
    })

    expect(parseWebdavSecrets('not-json')).toBeNull()
    expect(parseWebdavSecrets('{}')).toEqual({ username: '', password: '' })
    expect(parseWebdavSecrets(JSON.stringify(SECRETS))).toEqual(SECRETS)
  })

  it('validates config', () => {
    expect(validateWebdavConfig({ baseUrl: 'ftp://dav.example.com' })).toBeTruthy()
    expect(validateWebdavConfig({ baseUrl: 'not-a-url' })).toBeTruthy()
    expect(validateWebdavConfig({
      baseUrl: 'https://dav.example.com/dav',
      path: '../escape'
    })).toBeTruthy()
    expect(validateWebdavConfig(CONFIG)).toBeNull()
  })
})

describe('WebdavStorageBackend', () => {
  it('creates parent collections then PUTs the object with basic auth', async () => {
    const calls = stubFetch(() => new Response(null, { status: 201 }))
    const backend = createBackend()

    await backend.put('images/2026/09/a.webp', new Uint8Array([1, 2, 3]), {
      originalName: 'a.webp',
      uploadedAt: '2026-09-19T00:00:00.000Z',
      contentType: 'image/webp',
      size: 3
    })

    expect(calls.map(call => call.method)).toEqual([
      'MKCOL', // pichost
      'MKCOL', // images
      'MKCOL', // images/2026
      'MKCOL', // images/2026/09
      'PUT'
    ])

    const put = calls.at(-1)!
    expect(put.url).toBe(
      'https://dav.example.com/remote.php/dav/files/user/pichost/images/2026/09/a.webp'
    )
    expect(put.headers.Authorization).toBe(
      `Basic ${Buffer.from('alice:s3cret').toString('base64')}`
    )
    expect(put.headers['Content-Type']).toBe('image/webp')
    expect(put.body).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(put.body as ArrayBuffer))).toEqual([1, 2, 3])
  })

  it('sends only the view bytes when given a pooled buffer slice', async () => {
    const calls = stubFetch(() => new Response(null, { status: 201 }))
    const pool = new Uint8Array([9, 9, 9, 4, 5, 6, 9, 9])
    // 模拟 Node Buffer 池：byteOffset 非 0，仅有中间 3 字节属于图片
    const view = pool.subarray(3, 6)

    await createBackend().put('images/a.webp', view, {
      originalName: 'a.webp',
      uploadedAt: '2026-09-19T00:00:00.000Z',
      contentType: 'image/webp',
      size: 3
    })

    const body = calls.at(-1)!.body as ArrayBuffer
    expect(Array.from(new Uint8Array(body))).toEqual([4, 5, 6])
  })

  it('treats 405 on MKCOL as an already existing collection', async () => {
    const calls = stubFetch(call => new Response(null, {
      status: call.method === 'MKCOL' ? 405 : 201
    }))
    const backend = createBackend()

    await expect(backend.put('images/a.webp', new Uint8Array([1]), {
      originalName: 'a.webp',
      uploadedAt: '2026-09-19T00:00:00.000Z',
      contentType: 'image/webp',
      size: 1
    })).resolves.toBeUndefined()

    expect(calls.filter(call => call.method === 'MKCOL')).toHaveLength(2)
  })

  it('sends no Authorization header for anonymous access', async () => {
    const calls = stubFetch(() => new Response(null, { status: 201 }))
    const backend = createBackend({ secrets: { username: '', password: '' } })

    await backend.put('images/a.webp', new Uint8Array([1]), {
      originalName: 'a.webp',
      uploadedAt: '2026-09-19T00:00:00.000Z',
      contentType: 'image/webp',
      size: 1
    })

    expect(calls.at(-1)!.headers.Authorization).toBeUndefined()
  })

  it('throws a descriptive error when PUT fails', async () => {
    stubFetch(call => new Response(null, {
      status: call.method === 'PUT' ? 507 : 201
    }))
    const backend = createBackend()

    await expect(backend.put('images/a.webp', new Uint8Array([1]), {
      originalName: 'a.webp',
      uploadedAt: '2026-09-19T00:00:00.000Z',
      contentType: 'image/webp',
      size: 1
    })).rejects.toThrow(/PUT|上传失败|507/)
  })

  it('reads metadata from HEAD', async () => {
    stubFetch(() => new Response(null, {
      status: 200,
      headers: {
        'content-length': '2048',
        'content-type': 'image/webp',
        'last-modified': 'Sat, 19 Sep 2026 10:00:00 GMT'
      }
    }))

    const stored = await createBackend().head('images/2026/09/a.webp')

    expect(stored).toMatchObject({
      key: 'images/2026/09/a.webp',
      size: 2048,
      contentType: 'image/webp',
      backendId: 'webdav-test'
    })
    expect(stored?.mtimeMs).toBe(Date.parse('Sat, 19 Sep 2026 10:00:00 GMT'))
  })

  it('falls back to PROPFIND when HEAD is unsupported', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'HEAD') return new Response(null, { status: 405 })
      return new Response(
        `<?xml version="1.0"?>
         <D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop>
           <D:getcontentlength>4096</D:getcontentlength>
           <D:getcontenttype>image/png</D:getcontenttype>
           <D:getlastmodified>Sat, 19 Sep 2026 11:00:00 GMT</D:getlastmodified>
         </D:prop></D:propstat></D:response></D:multistatus>`,
        { status: 207, headers: { 'content-type': 'application/xml' } }
      )
    })

    const stored = await createBackend().head('images/a.png')

    expect(calls.map(call => call.method)).toEqual(['HEAD', 'PROPFIND'])
    expect(stored).toMatchObject({ size: 4096, contentType: 'image/png' })
  })

  it('returns null when the object does not exist', async () => {
    stubFetch(() => new Response(null, { status: 404 }))
    await expect(createBackend().head('images/missing.webp')).resolves.toBeNull()
  })

  it('rejects invalid image keys without any network call', async () => {
    const calls = stubFetch(() => new Response(null, { status: 200 }))
    await expect(createBackend().head('../secret.txt')).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('streams object content and forwards Range requests', async () => {
    const calls = stubFetch(() => new Response(Buffer.from('hello-webdav'), {
      status: 206,
      headers: { 'content-type': 'image/webp' }
    }))

    const stream = await createBackend().createStream(
      'images/2026/09/a.webp',
      { start: 0, end: 4 }
    )

    const chunks: Buffer[] = []
    for await (const chunk of stream as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello-webdav')
    expect(calls[0]!.headers.Range).toBe('bytes=0-4')
    expect(calls[0]!.url).toContain('/pichost/images/2026/09/a.webp')
  })

  it('deletes objects and treats 404 as success', async () => {
    const calls = stubFetch(() => new Response(null, { status: 404 }))
    await expect(createBackend().delete('images/a.webp')).resolves.toBeUndefined()
    expect(calls[0]!.method).toBe('DELETE')
  })

  it('reports a failed connection for wrong credentials', async () => {
    stubFetch(() => new Response(null, { status: 401 }))
    await expect(createBackend().testConnection()).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('鉴权失败')
    })
  })

  it('probes write access and cleans up on testConnection', async () => {
    const calls = stubFetch((call) => {
      // MKCOL → 201 新建；PROPFIND → 207 Multi-Status；PUT/DELETE → 2xx
      if (call.method === 'MKCOL') return new Response(null, { status: 201 })
      if (call.method === 'PROPFIND') {
        return new Response(
          '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>',
          { status: 207, headers: { 'content-type': 'application/xml' } }
        )
      }
      return new Response(null, { status: 200 })
    })

    await expect(createBackend().testConnection()).resolves.toEqual({
      ok: true,
      message: '连接成功'
    })

    const methods = calls.map(call => call.method)
    expect(methods).toContain('PROPFIND')
    expect(methods).toContain('MKCOL')
    expect(methods).toContain('PUT')
    expect(methods).toContain('DELETE')
    expect(calls.find(call => call.method === 'PUT')?.url).toMatch(
      /__pichost-probe-\d+\.txt$/
    )
  })
})

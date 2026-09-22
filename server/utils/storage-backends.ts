import type { DatabaseSync } from 'node:sqlite'
import { getDb } from './db'
import { LocalStorageBackend } from './storage/local'
import {
  parseS3Config,
  parseS3Secrets,
  S3StorageBackend
} from './storage/s3'
import {
  parseWebdavConfig,
  parseWebdavSecrets,
  WebdavStorageBackend
} from './storage/webdav'
import type {
  S3BackendConfig,
  S3BackendSecrets,
  ServingMode,
  StorageBackendInfo,
  StorageBackendRow,
  StorageBackendType,
  WebdavBackendConfig,
  WebdavBackendSecrets
} from './storage/types'

export const LOCAL_BACKEND_ID = 'local'
export const S3_BACKEND_ID = 's3-primary'
export const WEBDAV_BACKEND_ID = 'webdav-primary'

const CREATE_STORAGE_BACKENDS_TABLE = `
    CREATE TABLE IF NOT EXISTS storage_backends (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('local', 's3', 'webdav')),
      config_json TEXT NOT NULL DEFAULT '{}',
      secret_json TEXT NOT NULL DEFAULT '{}',
      serving_mode TEXT NOT NULL DEFAULT 'proxy' CHECK(serving_mode IN ('proxy', 'public')),
      public_url TEXT NOT NULL DEFAULT '',
      quota_bytes INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );`

function migrateStorageTables(database: DatabaseSync): void {
  database.exec(`
    ${CREATE_STORAGE_BACKENDS_TABLE}
    CREATE TABLE IF NOT EXISTS images (
      key TEXT PRIMARY KEY,
      backend_id TEXT NOT NULL,
      user_id INTEGER,
      folder TEXT NOT NULL,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      FOREIGN KEY (backend_id) REFERENCES storage_backends(id)
    );
    CREATE INDEX IF NOT EXISTS idx_images_uploaded_at ON images(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_images_backend_id ON images(backend_id);
    CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id);
    CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);
  `)
  migrateStorageBackendTypeConstraint(database)
}

/**
 * 老库的 storage_backends 建表时 CHECK 约束只允许 ('local', 's3')，
 * SQLite 无法直接修改 CHECK 约束，需重建表以支持 webdav 类型。
 */
function migrateStorageBackendTypeConstraint(database: DatabaseSync): void {
  const row = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'storage_backends'
  `).get() as { sql: string } | undefined

  if (!row?.sql || /'webdav'/.test(row.sql)) return

  // PRAGMA foreign_keys 在事务内无效，必须在 BEGIN 之前设置
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN')
  try {
    database.exec(`
      CREATE TABLE storage_backends_migrated (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('local', 's3', 'webdav')),
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_json TEXT NOT NULL DEFAULT '{}',
        serving_mode TEXT NOT NULL DEFAULT 'proxy' CHECK(serving_mode IN ('proxy', 'public')),
        public_url TEXT NOT NULL DEFAULT '',
        quota_bytes INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO storage_backends_migrated
        (id, name, type, config_json, secret_json, serving_mode, public_url,
         quota_bytes, enabled, is_default, sort_order)
      SELECT id, name, type, config_json, secret_json, serving_mode, public_url,
             quota_bytes, enabled, is_default, sort_order
      FROM storage_backends;
      DROP TABLE storage_backends;
      ALTER TABLE storage_backends_migrated RENAME TO storage_backends;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

export function ensureStorageSchema(): void {
  migrateStorageTables(getDb())
}

export function ensureDefaultBackends(): void {
  ensureStorageSchema()
  const db = getDb()

  const local = db.prepare(`
    SELECT id FROM storage_backends WHERE id = ?
  `).get(LOCAL_BACKEND_ID)

  if (!local) {
    db.prepare(`
      INSERT INTO storage_backends
        (id, name, type, config_json, secret_json, serving_mode, public_url,
         quota_bytes, enabled, is_default, sort_order)
      VALUES (?, ?, 'local', '{}', '{}', 'proxy', '', NULL, 1, 1, 0)
    `).run(LOCAL_BACKEND_ID, '本地磁盘')
  }

  // 环境变量引导的后端同步落库：images.backend_id 有外键约束，
  // 若 storage_backends 无对应行，上传时索引写入会直接失败
  const envBackend = getStorageBackendFromEnv()
  if (envBackend) {
    const envId = envBackend.type === 'webdav' ? WEBDAV_BACKEND_ID : S3_BACKEND_ID
    const exists = db.prepare(`
      SELECT id FROM storage_backends WHERE id = ?
    `).get(envId)
    if (!exists) {
      db.prepare(`
        INSERT INTO storage_backends
          (id, name, type, config_json, secret_json, serving_mode, public_url,
           quota_bytes, enabled, is_default, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, 0)
      `).run(
        envId,
        envBackend.type === 'webdav' ? 'WebDAV（环境变量）' : 'S3（环境变量）',
        envBackend.type,
        JSON.stringify(envBackend.config),
        JSON.stringify(envBackend.secrets),
        envBackend.servingMode,
        envBackend.publicUrl
      )
    }
  }

  cleanupPlaceholderS3Backend(db)
}

/** 移除早期版本自动种下的空 S3 占位（未配置、未启用、非默认、无图片） */
function cleanupPlaceholderS3Backend(db: DatabaseSync): void {
  const row = db.prepare(`
    SELECT * FROM storage_backends WHERE id = ?
  `).get(S3_BACKEND_ID) as StorageBackendRow | undefined

  if (!row || row.type !== 's3' || row.is_default === 1) {
    return
  }

  const config = parseS3Config(row.config_json)
  const secrets = parseS3Secrets(row.secret_json)
  const configured = Boolean(
    config?.bucket?.trim()
    || config?.endpoint?.trim()
    || secrets?.accessKeyId?.trim()
    || secrets?.secretAccessKey?.trim()
  )
  if (configured) {
    return
  }

  const usage = getBackendUsageStats(S3_BACKEND_ID)
  if (usage.count > 0) {
    return
  }

  db.prepare('DELETE FROM storage_backends WHERE id = ?').run(S3_BACKEND_ID)
}

function rowToInfo(row: StorageBackendRow, _maskSecrets = true): StorageBackendInfo & {
  secretsMasked: Record<string, string>
} {
  const config: StorageBackendInfo['config'] = row.type === 's3'
    ? (parseS3Config(row.config_json) ?? {})
    : row.type === 'webdav'
      ? (parseWebdavConfig(row.config_json) ?? {})
      : {}

  let secretsMasked: Record<string, string> = {}
  if (row.type === 's3') {
    const secrets = parseS3Secrets(row.secret_json)
    secretsMasked = {
      accessKeyId: secrets?.accessKeyId
        ? maskSecret(secrets.accessKeyId)
        : '',
      secretAccessKey: secrets?.secretAccessKey
        ? maskSecret(secrets.secretAccessKey)
        : ''
    }
  } else if (row.type === 'webdav') {
    const secrets = parseWebdavSecrets(row.secret_json)
    secretsMasked = {
      // 用户名不属于机密，明文返回便于管理员确认当前使用的账号
      username: secrets?.username ?? '',
      password: secrets?.password ? maskSecret(secrets.password) : ''
    }
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config,
    servingMode: row.serving_mode,
    publicUrl: row.public_url,
    quotaBytes: row.quota_bytes,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
    secretsMasked
  }
}

function maskSecret(value: string): string {
  if (value.length <= 4) return '****'
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(8, value.length - 4))}`
}

export function listStorageBackendRows(): StorageBackendRow[] {
  ensureDefaultBackends()
  return getDb().prepare(`
    SELECT id, name, type, config_json, secret_json, serving_mode, public_url,
           quota_bytes, enabled, is_default, sort_order
    FROM storage_backends
    ORDER BY sort_order ASC, id ASC
  `).all() as unknown as StorageBackendRow[]
}

export function listStorageBackends(maskSecrets = true): Array<StorageBackendInfo & {
  secretsMasked: Record<string, string>
}> {
  return listStorageBackendRows().map(row => rowToInfo(row, maskSecrets))
}

export function listStorageBackendNameMap(): Map<string, {
  name: string
  type: StorageBackendType
}> {
  ensureStorageSchema()
  const rows = getDb().prepare(`
    SELECT id, name, type FROM storage_backends
  `).all() as Array<{ id: string, name: string, type: StorageBackendType }>
  return new Map(rows.map(row => [row.id, { name: row.name, type: row.type }]))
}

export function getStorageBackendRow(id: string): StorageBackendRow | null {
  ensureDefaultBackends()
  const row = getDb().prepare(`
    SELECT id, name, type, config_json, secret_json, serving_mode, public_url,
           quota_bytes, enabled, is_default, sort_order
    FROM storage_backends
    WHERE id = ?
  `).get(id) as StorageBackendRow | undefined
  return row ?? null
}

export function getDefaultBackendRow(): StorageBackendRow | null {
  ensureDefaultBackends()
  const row = getDb().prepare(`
    SELECT id, name, type, config_json, secret_json, serving_mode, public_url,
           quota_bytes, enabled, is_default, sort_order
    FROM storage_backends
    WHERE is_default = 1 AND enabled = 1
    LIMIT 1
  `).get() as StorageBackendRow | undefined
  return row ?? null
}

export function getBackendIdForKey(key: string): string | null {
  ensureStorageSchema()
  const row = getDb().prepare(`
    SELECT backend_id FROM images WHERE key = ?
  `).get(key) as { backend_id: string } | undefined
  return row?.backend_id ?? null
}

export function setDefaultBackend(id: string): void {
  ensureDefaultBackends()
  const db = getDb()
  db.exec('UPDATE storage_backends SET is_default = 0')
  db.prepare(`
    UPDATE storage_backends SET is_default = 1, enabled = 1 WHERE id = ?
  `).run(id)
}

export interface StorageBackendPatch {
  name?: string
  config?: Record<string, unknown>
  secrets?: {
    accessKeyId?: string
    secretAccessKey?: string
    username?: string
    password?: string
  }
  servingMode?: ServingMode
  publicUrl?: string
  quotaBytes?: number | null
  enabled?: boolean
  isDefault?: boolean
}

function currentConfigOf(row: StorageBackendRow): Record<string, unknown> {
  if (row.type === 's3') {
    return (parseS3Config(row.config_json) ?? {}) as unknown as Record<string, unknown>
  }
  if (row.type === 'webdav') {
    return (parseWebdavConfig(row.config_json) ?? {}) as unknown as Record<string, unknown>
  }
  return {}
}

export function updateStorageBackend(id: string, patch: StorageBackendPatch): void {
  const row = getStorageBackendRow(id)
  if (!row) {
    throw new Error(`Storage backend not found: ${id}`)
  }

  const name = patch.name ?? row.name
  let configJson = row.config_json
  let secretJson = row.secret_json

  if (patch.config !== undefined) {
    configJson = JSON.stringify({ ...currentConfigOf(row), ...patch.config })
  }

  if (patch.secrets !== undefined && row.type === 's3') {
    const current = parseS3Secrets(row.secret_json) ?? {
      accessKeyId: '',
      secretAccessKey: ''
    }
    const next: S3BackendSecrets = {
      accessKeyId: patch.secrets.accessKeyId?.trim()
        ? patch.secrets.accessKeyId.trim()
        : current.accessKeyId,
      secretAccessKey: patch.secrets.secretAccessKey?.trim()
        ? patch.secrets.secretAccessKey.trim()
        : current.secretAccessKey
    }
    secretJson = JSON.stringify(next)
  }

  if (patch.secrets !== undefined && row.type === 'webdav') {
    const current = parseWebdavSecrets(row.secret_json) ?? {
      username: '',
      password: ''
    }
    // 用户名可为空串（显式清空），密码留空表示保持原值
    const next: WebdavBackendSecrets = {
      username: patch.secrets.username !== undefined
        ? patch.secrets.username.trim()
        : current.username,
      password: patch.secrets.password?.trim()
        ? patch.secrets.password.trim()
        : current.password
    }
    secretJson = JSON.stringify(next)
  }

  const servingMode = patch.servingMode ?? row.serving_mode
  const publicUrl = patch.publicUrl ?? row.public_url
  const quotaBytes = patch.quotaBytes !== undefined
    ? patch.quotaBytes
    : row.quota_bytes
  const enabled = patch.enabled !== undefined
    ? (patch.enabled ? 1 : 0)
    : row.enabled

  getDb().prepare(`
    UPDATE storage_backends
    SET name = ?, config_json = ?, secret_json = ?, serving_mode = ?,
        public_url = ?, quota_bytes = ?, enabled = ?
    WHERE id = ?
  `).run(name, configJson, secretJson, servingMode, publicUrl, quotaBytes, enabled, id)

  if (patch.isDefault) {
    setDefaultBackend(id)
  }
}

export function isStorageEnvConfigured(): boolean {
  return getStorageBackendFromEnv() !== null
}

export interface StorageBackendEnvConfig {
  type: StorageBackendType
  config: Record<string, unknown>
  secrets: Record<string, string>
  servingMode: ServingMode
  publicUrl: string
}

/**
 * 通过环境变量引导默认后端，便于容器化部署。
 * - S3：STORAGE_BACKEND=s3 + S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY …
 * - WebDAV：STORAGE_BACKEND=webdav + WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD / WEBDAV_PATH
 */
export function getStorageBackendFromEnv(): StorageBackendEnvConfig | null {
  const backendType = process.env.STORAGE_BACKEND?.trim()

  if (backendType === 'webdav') {
    const baseUrl = process.env.WEBDAV_URL?.trim() ?? ''
    if (!baseUrl) return null

    const publicUrl = process.env.WEBDAV_PUBLIC_URL?.trim() ?? ''
    return {
      type: 'webdav',
      config: {
        baseUrl,
        path: process.env.WEBDAV_PATH?.trim() || undefined
      },
      secrets: {
        username: process.env.WEBDAV_USERNAME?.trim() ?? '',
        password: process.env.WEBDAV_PASSWORD ?? ''
      },
      servingMode: publicUrl ? 'public' : 'proxy',
      publicUrl
    }
  }

  if (backendType !== 's3') return null

  const endpoint = process.env.S3_ENDPOINT?.trim() ?? ''
  const region = process.env.S3_REGION?.trim() ?? ''
  const bucket = process.env.S3_BUCKET?.trim() ?? ''
  const accessKeyId = process.env.S3_ACCESS_KEY?.trim() ?? ''
  const secretAccessKey = process.env.S3_SECRET_KEY?.trim() ?? ''

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null
  }

  return {
    type: 's3',
    config: {
      endpoint,
      region: region || 'auto',
      bucket,
      prefix: process.env.S3_PREFIX?.trim() || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true'
    },
    secrets: { accessKeyId, secretAccessKey },
    servingMode: process.env.S3_PUBLIC_URL?.trim() ? 'public' : 'proxy',
    publicUrl: process.env.S3_PUBLIC_URL?.trim() ?? ''
  }
}

export function createBackendInstance(row: StorageBackendRow) {
  if (row.type === 'local') {
    return new LocalStorageBackend(
      row.id,
      row.serving_mode,
      row.public_url
    )
  }

  if (row.type === 'webdav') {
    const config = parseWebdavConfig(row.config_json)
    const secrets = parseWebdavSecrets(row.secret_json)
    if (!config || !secrets) {
      throw new Error(`Invalid WebDAV configuration for backend ${row.id}`)
    }

    return new WebdavStorageBackend(
      row.id,
      config,
      secrets,
      row.serving_mode,
      row.public_url
    )
  }

  const config = parseS3Config(row.config_json)
  const secrets = parseS3Secrets(row.secret_json)
  if (!config || !secrets) {
    throw new Error(`Invalid S3 configuration for backend ${row.id}`)
  }

  return new S3StorageBackend(
    row.id,
    config,
    secrets,
    row.serving_mode,
    row.public_url
  )
}

export function createBackendFromEnv() {
  const env = getStorageBackendFromEnv()
  if (!env) return null

  if (env.type === 'webdav') {
    return new WebdavStorageBackend(
      WEBDAV_BACKEND_ID,
      env.config as unknown as WebdavBackendConfig,
      env.secrets as unknown as WebdavBackendSecrets,
      env.servingMode,
      env.publicUrl
    )
  }

  return new S3StorageBackend(
    S3_BACKEND_ID,
    env.config as unknown as S3BackendConfig,
    env.secrets as unknown as S3BackendSecrets,
    env.servingMode,
    env.publicUrl
  )
}

export function getBackendUsageStats(backendId: string): { count: number, bytes: number } {
  ensureStorageSchema()
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
    FROM images
    WHERE backend_id = ?
  `).get(backendId) as { count: number, bytes: number }
  return { count: row.count, bytes: row.bytes }
}

function getNextSortOrder(): number {
  const row = getDb().prepare(`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM storage_backends
  `).get() as { max_order: number }
  return row.max_order + 1
}

export type ObjectStorageIdPrefix = 'r2' | 'cos' | 'oss' | 's3' | 'webdav'

/** 根据表单预设或 endpoint 推断新建后端的 id 前缀 */
export function resolveObjectStorageIdPrefix(
  config: Pick<S3BackendConfig, 'endpoint'>,
  provider?: string
): ObjectStorageIdPrefix {
  const normalized = provider?.trim().toLowerCase()
  if (normalized === 'webdav') return 'webdav'
  if (normalized === 'r2' || normalized === 'cos' || normalized === 'oss') {
    return normalized
  }
  if (normalized === 'aws' || normalized === 's3') {
    return 's3'
  }

  const endpoint = config.endpoint.trim().toLowerCase()
  if (endpoint.includes('r2.cloudflarestorage.com')) return 'r2'
  if (endpoint.includes('myqcloud.com')) return 'cos'
  if (endpoint.includes('aliyuncs.com')) return 'oss'
  return 's3'
}

export function generateStorageBackendId(prefix: ObjectStorageIdPrefix = 's3'): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}-${suffix}`
}

/** 统一的存储后端插入逻辑，供 S3 / WebDAV 复用 */
function insertBackendRow(input: {
  id: string
  name: string
  type: StorageBackendType
  config: Record<string, unknown>
  secrets: Record<string, unknown>
  servingMode?: ServingMode
  publicUrl?: string
  quotaBytes?: number | null
  enabled?: boolean
  isDefault?: boolean
}): void {
  getDb().prepare(`
    INSERT INTO storage_backends
      (id, name, type, config_json, secret_json, serving_mode, public_url,
       quota_bytes, enabled, is_default, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    input.id,
    input.name,
    input.type,
    JSON.stringify(input.config),
    JSON.stringify(input.secrets),
    input.servingMode ?? 'proxy',
    input.publicUrl ?? '',
    input.quotaBytes ?? null,
    input.enabled === false ? 0 : 1,
    getNextSortOrder()
  )

  if (input.isDefault) {
    setDefaultBackend(input.id)
  }
}

export function insertStorageBackend(input: {
  id?: string
  name: string
  provider?: string
  config: S3BackendConfig
  secrets: S3BackendSecrets
  servingMode?: ServingMode
  publicUrl?: string
  quotaBytes?: number | null
  enabled?: boolean
  isDefault?: boolean
}): string {
  ensureDefaultBackends()
  const idPrefix = resolveObjectStorageIdPrefix(input.config, input.provider)
  const id = input.id ?? generateStorageBackendId(idPrefix)

  insertBackendRow({
    id,
    name: input.name,
    type: 's3',
    config: input.config as unknown as Record<string, unknown>,
    secrets: input.secrets as unknown as Record<string, unknown>,
    servingMode: input.servingMode,
    publicUrl: input.publicUrl,
    quotaBytes: input.quotaBytes,
    enabled: input.enabled,
    isDefault: input.isDefault
  })

  return id
}

export function insertWebdavStorageBackend(input: {
  id?: string
  name: string
  config: WebdavBackendConfig
  secrets: WebdavBackendSecrets
  servingMode?: ServingMode
  publicUrl?: string
  quotaBytes?: number | null
  enabled?: boolean
  isDefault?: boolean
}): string {
  ensureDefaultBackends()
  const id = input.id ?? generateStorageBackendId('webdav')

  insertBackendRow({
    id,
    name: input.name,
    type: 'webdav',
    config: input.config as unknown as Record<string, unknown>,
    secrets: input.secrets as unknown as Record<string, unknown>,
    servingMode: input.servingMode,
    publicUrl: input.publicUrl,
    quotaBytes: input.quotaBytes,
    enabled: input.enabled,
    isDefault: input.isDefault
  })

  return id
}

export function deleteStorageBackend(id: string): void {
  if (id === LOCAL_BACKEND_ID) {
    throw new Error('Cannot delete local backend')
  }

  const usage = getBackendUsageStats(id)
  if (usage.count > 0) {
    throw new Error('Cannot delete backend with stored images')
  }

  const row = getStorageBackendRow(id)
  if (!row) {
    throw new Error(`Storage backend not found: ${id}`)
  }

  if (row.is_default) {
    throw new Error('Cannot delete the default backend')
  }

  getDb().prepare('DELETE FROM storage_backends WHERE id = ?').run(id)
}

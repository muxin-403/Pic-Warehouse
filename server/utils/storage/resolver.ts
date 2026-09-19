import {
  createBackendFromEnv,
  createBackendInstance,
  getBackendIdForKey,
  getDefaultBackendRow,
  getStorageBackendFromEnv,
  getStorageBackendRow,
  LOCAL_BACKEND_ID,
  ensureDefaultBackends
} from '../storage-backends'
import type { StorageBackend, StorageBackendRow } from './types'

/** 环境变量引导的后端在列表/详情中的占位行 */
function envBackendRow(): StorageBackendRow | null {
  const env = getStorageBackendFromEnv()
  if (!env) return null

  return {
    id: env.type === 'webdav' ? 'webdav-primary' : 's3-primary',
    name: env.type === 'webdav' ? 'WebDAV（环境变量）' : 'S3（环境变量）',
    type: env.type,
    config_json: '{}',
    secret_json: '{}',
    serving_mode: env.servingMode,
    public_url: env.publicUrl,
    quota_bytes: null,
    enabled: 1,
    is_default: 1,
    sort_order: 0
  }
}

export async function getActiveBackend(): Promise<StorageBackend> {
  const fromEnv = createBackendFromEnv()
  if (fromEnv) return fromEnv

  ensureDefaultBackends()
  const row = getDefaultBackendRow()
  if (!row) {
    return createBackendInstance({
      id: LOCAL_BACKEND_ID,
      name: '本地磁盘',
      type: 'local',
      config_json: '{}',
      secret_json: '{}',
      serving_mode: 'proxy',
      public_url: '',
      quota_bytes: null,
      enabled: 1,
      is_default: 1,
      sort_order: 0
    })
  }

  return createBackendInstance(row)
}

export async function getBackendForKey(key: string): Promise<StorageBackend> {
  const fromEnv = createBackendFromEnv()
  if (fromEnv) return fromEnv

  ensureDefaultBackends()
  const backendId = getBackendIdForKey(key) ?? LOCAL_BACKEND_ID
  const row = getStorageBackendRow(backendId)

  if (!row || !row.enabled) {
    return createBackendInstance(fallbackLocalRow())
  }

  try {
    return createBackendInstance(row)
  } catch {
    return createBackendInstance(fallbackLocalRow())
  }
}

export function getActiveBackendRow(): StorageBackendRow | null {
  const fromEnv = envBackendRow()
  if (fromEnv) return fromEnv

  ensureDefaultBackends()
  return getDefaultBackendRow()
}

export async function getBackendRowForKey(key: string): Promise<StorageBackendRow> {
  const fromEnv = envBackendRow()
  if (fromEnv) return fromEnv

  ensureDefaultBackends()
  const backendId = getBackendIdForKey(key) ?? LOCAL_BACKEND_ID
  return getStorageBackendRow(backendId) ?? fallbackLocalRow()
}

function fallbackLocalRow(): StorageBackendRow {
  return {
    id: LOCAL_BACKEND_ID,
    name: '本地磁盘',
    type: 'local',
    config_json: '{}',
    secret_json: '{}',
    serving_mode: 'proxy',
    public_url: '',
    quota_bytes: null,
    enabled: 1,
    is_default: 1,
    sort_order: 0
  }
}

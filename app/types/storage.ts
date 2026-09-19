export type ServingMode = 'proxy' | 'public'
export type StorageBackendType = 'local' | 's3' | 'webdav'

export interface StorageCapacity {
  totalBytes: number | null
  usedBytes: number
  freeBytes: number | null
  percent: number | null
  source: 'disk' | 'quota'
}

export interface StorageBackendItem {
  id: string
  name: string
  type: StorageBackendType
  config: {
    endpoint?: string
    region?: string
    bucket?: string
    prefix?: string
    forcePathStyle?: boolean
    /** WebDAV 服务器地址 */
    baseUrl?: string
    /** WebDAV 存储路径 */
    path?: string
  }
  secretsMasked: {
    accessKeyId?: string
    secretAccessKey?: string
    username?: string
    password?: string
  }
  servingMode: ServingMode
  publicUrl: string
  quotaBytes: number | null
  enabled: boolean
  isDefault: boolean
  usage: { count: number, bytes: number }
  capacity: StorageCapacity
}

export interface StorageListResponse {
  backends: StorageBackendItem[]
  activeBackendId: string
  envOverride: boolean
}

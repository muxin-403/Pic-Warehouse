import type { H3Event } from 'h3'
import { requireAdminAuth } from '../../../utils/access'
import { createApiError } from '../../../utils/api-error'
import {
  insertStorageBackend,
  insertWebdavStorageBackend,
  isStorageEnvConfigured
} from '../../../utils/storage-backends'
import { validateS3Config } from '../../../utils/storage/s3'
import { validateWebdavConfig } from '../../../utils/storage/webdav'
import { parseQuotaBytes } from '../../../utils/storage-capacity'
import type { ServingMode, StorageBackendType } from '../../../utils/storage/types'

interface StorageCreateBody {
  name?: string
  type?: StorageBackendType
  provider?: string
  config?: {
    endpoint?: string
    region?: string
    bucket?: string
    prefix?: string
    forcePathStyle?: boolean
    baseUrl?: string
    path?: string
  }
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

export default defineEventHandler(async (event) => {
  await requireAdminAuth(event)

  if (isStorageEnvConfigured()) {
    createApiError(event, 'FORBIDDEN', '存储配置已由环境变量覆盖，无法在后台修改', 409)
  }

  const body = await readBody<StorageCreateBody>(event).catch(
    (): StorageCreateBody => ({})
  )

  // 显式 type 优先；兼容仅传 provider 的旧前端
  const backendType: StorageBackendType = body.type === 'webdav'
    || body.provider?.trim().toLowerCase() === 'webdav'
    ? 'webdav'
    : 's3'

  if (body.servingMode && body.servingMode !== 'proxy' && body.servingMode !== 'public') {
    createApiError(event, 'INVALID_REQUEST', '访问方式无效', 400)
  }

  const quotaBytes = parseQuotaBytes(body.quotaBytes)
  if (!quotaBytes) {
    createApiError(event, 'INVALID_REQUEST', '请填写有效的存储套餐总量', 400)
  }

  const id = backendType === 'webdav'
    ? createWebdavBackend(event, body, quotaBytes)
    : createS3Backend(event, body, quotaBytes)

  return { success: true, id }
})

function createS3Backend(
  event: H3Event,
  body: StorageCreateBody,
  quotaBytes: number
): string {
  const name = body.name?.trim() || 'S3 兼容存储'
  const config = {
    endpoint: body.config?.endpoint?.trim() ?? '',
    region: body.config?.region?.trim() || 'auto',
    bucket: body.config?.bucket?.trim() ?? '',
    prefix: body.config?.prefix?.trim() || undefined,
    forcePathStyle: body.config?.forcePathStyle ?? false
  }

  const error = validateS3Config(config)
  if (error) {
    createApiError(event, 'INVALID_REQUEST', error, 400)
  }

  const accessKeyId = body.secrets?.accessKeyId?.trim() ?? ''
  const secretAccessKey = body.secrets?.secretAccessKey?.trim() ?? ''
  if (!accessKeyId || !secretAccessKey) {
    createApiError(event, 'INVALID_REQUEST', 'Access Key 与 Secret Key 不能为空', 400)
  }

  return insertStorageBackend({
    name,
    provider: body.provider?.trim(),
    config,
    secrets: { accessKeyId, secretAccessKey },
    servingMode: body.servingMode,
    publicUrl: body.publicUrl?.trim(),
    quotaBytes,
    enabled: body.enabled,
    isDefault: body.isDefault
  })
}

function createWebdavBackend(
  event: H3Event,
  body: StorageCreateBody,
  quotaBytes: number
): string {
  const name = body.name?.trim() || 'WebDAV 存储'
  const config = {
    baseUrl: body.config?.baseUrl?.trim() ?? '',
    path: body.config?.path?.trim() || undefined
  }

  const error = validateWebdavConfig(config)
  if (error) {
    createApiError(event, 'INVALID_REQUEST', error, 400)
  }

  return insertWebdavStorageBackend({
    name,
    config,
    secrets: {
      username: body.secrets?.username?.trim() ?? '',
      password: body.secrets?.password ?? ''
    },
    servingMode: body.servingMode,
    publicUrl: body.publicUrl?.trim(),
    quotaBytes,
    enabled: body.enabled,
    isDefault: body.isDefault
  })
}

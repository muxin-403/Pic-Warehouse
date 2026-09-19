<script setup lang="ts">
import type { QuotaUnit } from '~/composables/useFileSize'
import type { StorageBackendItem } from '~/types/storage'

type StorageProvider = 'r2' | 'cos' | 'oss' | 'aws' | 'custom' | 'webdav'
type StorageProviderType = 's3' | 'webdav'

export interface StorageFormPayload {
  name: string
  type: StorageProviderType
  provider: StorageProvider
  config: {
    endpoint: string
    region: string
    bucket: string
    prefix?: string
    forcePathStyle: boolean
    baseUrl: string
    path: string
  }
  secrets: {
    accessKeyId: string
    secretAccessKey: string
    username: string
    password: string
  }
  servingMode: 'proxy' | 'public'
  publicUrl: string
  quotaValue: string
  quotaUnit: QuotaUnit
}

const props = defineProps<{
  backend?: StorageBackendItem | null
  createMode?: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  submit: [payload: StorageFormPayload]
  cancel: []
}>()

const { t } = useI18n()
const { bytesToQuotaInput, QUOTA_UNITS } = useFileSize()

const name = ref('')
const provider = ref<StorageProvider>('r2')
const endpoint = ref('')
const region = ref('auto')
const bucket = ref('')
const prefix = ref('')
const forcePathStyle = ref(false)
const baseUrl = ref('')
const webdavPath = ref('')
const accessKeyId = ref('')
const secretAccessKey = ref('')
const username = ref('')
const password = ref('')
const servingMode = ref<'proxy' | 'public'>('proxy')
const publicUrl = ref('')
const quotaValue = ref('')
const quotaUnit = ref<QuotaUnit>('GB')

const isWebdav = computed(() => provider.value === 'webdav')
const backendType = computed<StorageProviderType>(() => (isWebdav.value ? 'webdav' : 's3'))

const quotaUnitOptions = computed(() =>
  QUOTA_UNITS.map(unit => ({ label: unit, value: unit }))
)

const providerOptions = computed(() => [
  { label: t('storage.providerWebdav'), value: 'webdav' as const },
  { label: t('storage.providerR2'), value: 'r2' as const },
  { label: t('storage.providerCos'), value: 'cos' as const },
  { label: t('storage.providerOss'), value: 'oss' as const },
  { label: t('storage.providerAws'), value: 'aws' as const },
  { label: t('storage.providerCustom'), value: 'custom' as const }
])

const servingModeOptions = computed(() => [
  { label: t('storage.servingProxy'), value: 'proxy' },
  { label: t('storage.servingPublic'), value: 'public' }
])

function providerLabel(value: StorageProvider): string {
  return providerOptions.value.find(option => option.value === value)?.label
    ?? t('storage.backendCloud')
}

function applyProviderTemplate(value: StorageProvider) {
  if (!props.createMode && props.backend) return
  if (props.createMode) {
    name.value = value === 'webdav' ? t('storage.backendWebdav') : providerLabel(value)
  }
  switch (value) {
    case 'r2':
      endpoint.value = 'https://{account_id}.r2.cloudflarestorage.com'
      region.value = 'auto'
      forcePathStyle.value = false
      break
    case 'cos':
      endpoint.value = 'https://cos.{region}.myqcloud.com'
      region.value = 'ap-guangzhou'
      forcePathStyle.value = true
      break
    case 'oss':
      endpoint.value = 'https://oss-{region}.aliyuncs.com'
      region.value = 'cn-hangzhou'
      forcePathStyle.value = false
      break
    case 'aws':
      endpoint.value = 'https://s3.{region}.amazonaws.com'
      region.value = 'us-east-1'
      forcePathStyle.value = false
      break
    case 'webdav':
      baseUrl.value = baseUrl.value || 'https://dav.example.com/remote.php/dav/files/user'
      webdavPath.value = webdavPath.value || 'pichost'
      break
    default:
      break
  }
}

function detectProvider(backend: StorageBackendItem): StorageProvider {
  if (backend.type === 'webdav') return 'webdav'
  const ep = backend.config.endpoint ?? ''
  if (ep.includes('r2.cloudflarestorage.com')) return 'r2'
  if (ep.includes('myqcloud.com')) return 'cos'
  if (ep.includes('aliyuncs.com')) return 'oss'
  if (ep.includes('amazonaws.com')) return 'aws'
  return 'custom'
}

function resetFields() {
  name.value = ''
  provider.value = 'webdav'
  endpoint.value = ''
  region.value = 'auto'
  bucket.value = ''
  prefix.value = ''
  forcePathStyle.value = false
  baseUrl.value = ''
  webdavPath.value = ''
  accessKeyId.value = ''
  secretAccessKey.value = ''
  username.value = ''
  password.value = ''
  servingMode.value = 'proxy'
  publicUrl.value = ''
  quotaValue.value = ''
  quotaUnit.value = 'GB'
}

function loadBackend(backend: StorageBackendItem | null | undefined) {
  if (!backend) {
    if (props.createMode) {
      resetFields()
      provider.value = 'r2'
      applyProviderTemplate('r2')
    }
    return
  }
  if (backend.type === 'local') return

  name.value = backend.name
  provider.value = detectProvider(backend)
  servingMode.value = backend.servingMode
  publicUrl.value = backend.publicUrl
  const quota = bytesToQuotaInput(backend.quotaBytes)
  quotaValue.value = quota.value
  quotaUnit.value = quota.unit

  if (backend.type === 'webdav') {
    baseUrl.value = backend.config.baseUrl ?? ''
    webdavPath.value = backend.config.path ?? ''
    username.value = backend.secretsMasked.username ?? ''
    password.value = ''
    return
  }

  endpoint.value = backend.config.endpoint ?? ''
  region.value = backend.config.region ?? 'auto'
  bucket.value = backend.config.bucket ?? ''
  prefix.value = backend.config.prefix ?? ''
  forcePathStyle.value = backend.config.forcePathStyle ?? false
  accessKeyId.value = ''
  secretAccessKey.value = ''
}

watch(() => props.backend, loadBackend, { immediate: true })

watch(provider, (value) => {
  if (props.createMode) {
    applyProviderTemplate(value)
  }
})

function handleSubmit() {
  emit('submit', {
    name: name.value.trim() || providerLabel(provider.value),
    type: backendType.value,
    provider: provider.value,
    config: {
      endpoint: endpoint.value.trim(),
      region: region.value.trim() || 'auto',
      bucket: bucket.value.trim(),
      prefix: prefix.value.trim() || undefined,
      forcePathStyle: forcePathStyle.value,
      baseUrl: baseUrl.value.trim(),
      path: webdavPath.value.trim()
    },
    secrets: {
      accessKeyId: accessKeyId.value.trim(),
      secretAccessKey: secretAccessKey.value.trim(),
      username: username.value.trim(),
      password: password.value
    },
    servingMode: servingMode.value,
    publicUrl: publicUrl.value.trim(),
    quotaValue: String(quotaValue.value ?? '').trim(),
    quotaUnit: quotaUnit.value
  })
}
</script>

<template>
  <form
    class="space-y-4"
    @submit.prevent="handleSubmit"
  >
    <div class="space-y-2">
      <label class="text-sm">{{ t('storage.provider') }}</label>
      <USelect
        v-model="provider"
        :items="providerOptions"
        class="w-full"
      />
    </div>

    <div class="space-y-2">
      <label class="text-sm">{{ t('storage.backendName') }}</label>
      <UInput
        v-model="name"
        class="w-full"
      />
    </div>

    <!-- WebDAV：服务器地址 + 存储路径 -->
    <template v-if="isWebdav">
      <div class="space-y-2">
        <label class="text-sm">
          {{ t('storage.webdavUrl') }}
          <span class="text-error">*</span>
        </label>
        <UInput
          v-model="baseUrl"
          :placeholder="t('storage.webdavUrlPlaceholder')"
          class="w-full font-mono text-sm"
          required
        />
        <p class="text-xs text-muted">
          {{ t('storage.webdavUrlHint') }}
        </p>
      </div>

      <div class="space-y-2">
        <label class="text-sm">{{ t('storage.webdavPath') }}</label>
        <UInput
          v-model="webdavPath"
          :placeholder="t('storage.webdavPathPlaceholder')"
          class="w-full font-mono text-sm"
        />
        <p class="text-xs text-muted">
          {{ t('storage.webdavPathHint') }}
        </p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-2">
          <label class="text-sm">{{ t('storage.webdavUsername') }}</label>
          <UInput
            v-model="username"
            :placeholder="backend?.secretsMasked.username || ''"
            class="w-full font-mono text-sm"
            autocomplete="off"
          />
        </div>
        <div class="space-y-2">
          <label class="text-sm">{{ t('storage.webdavPassword') }}</label>
          <UInput
            v-model="password"
            type="password"
            :placeholder="backend?.secretsMasked.password || ''"
            class="w-full font-mono text-sm"
            autocomplete="new-password"
          />
        </div>
      </div>
      <p class="text-xs text-muted">
        {{ t('storage.webdavCredentialsHint') }}
      </p>
    </template>

    <!-- S3 兼容存储字段 -->
    <template v-else>
      <div class="space-y-2">
        <label class="text-sm">{{ t('storage.endpoint') }}</label>
        <UInput
          v-model="endpoint"
          class="w-full font-mono text-sm"
        />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-2">
          <label class="text-sm">{{ t('storage.region') }}</label>
          <UInput
            v-model="region"
            class="w-full font-mono text-sm"
          />
        </div>
        <div class="space-y-2">
          <label class="text-sm">
            {{ t('storage.bucket') }}
            <span class="text-error">*</span>
          </label>
          <UInput
            v-model="bucket"
            class="w-full font-mono text-sm"
            required
          />
        </div>
      </div>

      <div class="space-y-2">
        <label class="text-sm">{{ t('storage.prefix') }}</label>
        <UInput
          v-model="prefix"
          :placeholder="t('storage.prefixPlaceholder')"
          class="w-full font-mono text-sm"
        />
      </div>

      <label class="flex cursor-pointer items-center gap-2">
        <UCheckbox v-model="forcePathStyle" />
        <span class="text-sm">{{ t('storage.forcePathStyle') }}</span>
      </label>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-2">
          <label class="text-sm">
            {{ t('storage.accessKey') }}
            <span
              v-if="createMode"
              class="text-error"
            >*</span>
          </label>
          <UInput
            v-model="accessKeyId"
            :placeholder="backend?.secretsMasked.accessKeyId || ''"
            class="w-full font-mono text-sm"
            :required="createMode"
          />
        </div>
        <div class="space-y-2">
          <label class="text-sm">
            {{ t('storage.secretKey') }}
            <span
              v-if="createMode"
              class="text-error"
            >*</span>
          </label>
          <UInput
            v-model="secretAccessKey"
            type="password"
            :placeholder="backend?.secretsMasked.secretAccessKey || ''"
            class="w-full font-mono text-sm"
            :required="createMode"
          />
        </div>
      </div>
    </template>

    <div class="space-y-2">
      <label class="text-sm">{{ t('storage.servingMode') }}</label>
      <URadioGroup
        v-model="servingMode"
        :items="servingModeOptions"
      />
      <p class="text-xs text-muted">
        {{ isWebdav ? t('storage.webdavServingHint') : t('storage.servingHint') }}
      </p>
    </div>

    <div
      v-if="servingMode === 'public'"
      class="space-y-2"
    >
      <label class="text-sm">{{ t('storage.publicUrl') }}</label>
      <UInput
        v-model="publicUrl"
        :placeholder="t('storage.publicUrlPlaceholder')"
        class="w-full font-mono text-sm"
      />
    </div>

    <div class="space-y-2">
      <label class="text-sm">
        {{ t('storage.quotaTotal') }}
        <span class="text-error">*</span>
      </label>
      <div class="flex gap-2">
        <UInput
          :model-value="String(quotaValue)"
          type="number"
          min="0"
          step="any"
          required
          :placeholder="t('storage.quotaPlaceholder')"
          class="min-w-0 flex-1"
          @update:model-value="quotaValue = String($event ?? '')"
        />
        <USelect
          v-model="quotaUnit"
          :items="quotaUnitOptions"
          class="w-24 shrink-0"
        />
      </div>
      <p class="text-xs text-muted">
        {{ t('storage.quotaHint') }}
      </p>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <UButton
        type="button"
        :label="t('common.cancel')"
        variant="outline"
        color="neutral"
        @click="emit('cancel')"
      />
      <UButton
        type="submit"
        :label="t('common.save')"
        icon="i-lucide-save"
        :loading="saving"
      />
    </div>
  </form>
</template>

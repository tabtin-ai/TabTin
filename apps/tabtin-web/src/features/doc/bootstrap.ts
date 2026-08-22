/**
 * Web 端 TabDoc 编辑器 bootstrap
 *
 * 为共享编辑器组件提供 Web 平台特定的能力注入：
 * - 认证：从 localStorage 读取 token
 * - 协作：WebSocket URL
 * - 图片上传：通过 Web API client
 */
import type {
  TabDocAuthPort,
  TabDocImageUploadPort,
} from '@tabtin/tabdoc-ui'
import { authAdapter, STORAGE_KEYS } from '@/platform'
import { getApiClient } from '@/services/api-client'
import { refreshAccessToken } from '@/services/token-refresh'
import { useAuthStore } from '@/stores/auth-store'

export const webAuthPort: TabDocAuthPort = {
  getAccessToken: async () => localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
  refreshAccessToken: async () => {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN)
    if (!refreshToken) return null
    const result = await refreshAccessToken(refreshToken, authAdapter)
    return result?.access_token ?? null
  },
  getCurrentUser: () => {
    const user = useAuthStore.getState().user
    if (!user) return null
    return {
      id: user.id,
      nickname: user.nickname ?? null,
      username: user.username ?? null,
      email: user.email ?? null,
    }
  },
}

export const webImageUploadPort: TabDocImageUploadPort = {
  upload: async (file, options) => {
    const client = getApiClient()
    const formData = new FormData()
    formData.append('file', file)
    if (options.folder) formData.append('folder', options.folder)
    if (options.module) formData.append('module', options.module)
    if (options.contextType) formData.append('context_type', options.contextType)
    if (options.contextId) formData.append('context_id', options.contextId)
    formData.append('is_public', 'false')

    const response = await client.raw('POST', '/oss/direct-upload', {
      body: formData,
      rawResponse: true,
    }) as Response

    const payload = await response.json() as {
      data?: { access_url?: string; url?: string; file_id?: string; file_key?: string }
      access_url?: string
      url?: string
      file_id?: string
      file_key?: string
    }
    const data = payload.data ?? payload
    return {
      url: data.access_url || data.url || '',
      fileId: data.file_id || '',
      ...(data.file_key ? { fileKey: data.file_key } : {}),
    }
  },
  validate: (file) => {
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']

    if (!ALLOWED_TYPES.includes(file.type)) {
      return { valid: false, reason: 'fileTypeNotSupported' }
    }
    if (file.size > MAX_IMAGE_SIZE) {
      return { valid: false, reason: 'fileTooLarge', maxSizeLabel: '10 MB' }
    }
    return { valid: true }
  },
}

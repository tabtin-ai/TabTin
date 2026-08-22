import { type TabTinApiClient, createApiClient } from '@tabtin/api-client'
import { API_BASE_URL, buildApiUrl } from './client'

let _client: TabTinApiClient | null = null

function clearAuthAndRedirect() {
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  localStorage.removeItem('user')
  localStorage.removeItem('auth-storage')
  window.location.href = '/login'
}

export function getApiClient(): TabTinApiClient {
  if (!_client) {
    _client = createApiClient({
      baseUrl: API_BASE_URL || `${window.location.origin}/api`,
      clientType: 'admindash',
      getToken: () => localStorage.getItem('access_token'),
      onUnauthorized: clearAuthAndRedirect,
      refresh: {
        getRefreshToken: () => localStorage.getItem('refresh_token'),
        onRefreshToken: async (refreshToken) => {
          if (!refreshToken) return null
          const resp = await fetch(buildApiUrl('/auth/refresh-token'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }),
          })
          if (!resp.ok) return null
          const raw = await resp.json()
          const data = raw?.success === true && raw?.data ? raw.data : raw
          if (!data?.access_token) return null
          localStorage.setItem('access_token', data.access_token)
          if (data.refresh_token) {
            localStorage.setItem('refresh_token', data.refresh_token)
          }
          return { access_token: data.access_token, refresh_token: data.refresh_token }
        },
        onRefreshFailed: clearAuthAndRedirect,
      },
    })
  }
  return _client
}

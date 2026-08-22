/**
 * Axios-style wrapper around ApiService.
 *
 * Provides `.get()`, `.post()`, `.patch()`, `.put()`, `.delete()` helpers
 * so that callers can use an axios-like `{ data }` return shape while
 * all requests still flow through the Electron IPC proxy in ApiService.
 */

import { apiService } from './api'

type AxiosLikeResponse<T = any> = { data: T }

interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
}

function buildQueryString(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return ''
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
}

async function request<T>(method: string, url: string, data?: unknown, opts?: RequestOptions): Promise<AxiosLikeResponse<T>> {
  const fullUrl = url + buildQueryString(opts?.params)
  const result = await apiService.request<T>({
    method,
    url: fullUrl,
    data: data as any,
    headers: opts?.headers as any,
  })
  return { data: result }
}

export const apiClient = {
  get<T = any>(url: string, opts?: RequestOptions) {
    return request<T>('GET', url, undefined, opts)
  },
  post<T = any>(url: string, data?: unknown, opts?: RequestOptions) {
    return request<T>('POST', url, data, opts)
  },
  put<T = any>(url: string, data?: unknown, opts?: RequestOptions) {
    return request<T>('PUT', url, data, opts)
  },
  patch<T = any>(url: string, data?: unknown, opts?: RequestOptions) {
    return request<T>('PATCH', url, data, opts)
  },
  delete<T = any>(url: string, opts?: RequestOptions) {
    return request<T>('DELETE', url, undefined, opts)
  },
}

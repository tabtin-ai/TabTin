import { initializeTableHostRuntime, type TableHostRuntimeOptions } from '@tabtin/table-host-runtime'
import type { TableHttpRequest, TableHttpResponse } from '@tabtin/table-core'
import { setTableFetch } from '@tabtin/table-core'
import i18n from '@/i18n'
import { API_BASE_URL } from '@/config/api'
import { STORAGE_KEYS } from '@/platform'
import { getApiClient } from '@/services/api-client'
import { createLooseTranslate } from '@/types/table-adapters'

type WebTableRuntimeContext = {
  organizationId?: string | null
  spaceId?: string | null
  tableShareId?: string | null
  tableSharePassword?: string | null
}

let lastRuntimeSignature = ''
let lastRuntimeContext: WebTableRuntimeContext = {}
const RUNTIME_WINDOW_ID =
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `tabtin-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const getResolvedBaseApiUrl = (): string => {
  if (API_BASE_URL && API_BASE_URL.trim().length > 0) {
    return API_BASE_URL
  }
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/api`
  }
  return '/api'
}

const resolveRawPath = (url: string, baseApiUrl: string): string => {
  const candidates = [baseApiUrl.replace(/\/$/, '')]

  if (typeof window !== 'undefined') {
    candidates.push(`${window.location.origin}${baseApiUrl.startsWith('/') ? '' : '/'}${baseApiUrl}`.replace(/\/$/, ''))
    candidates.push(window.location.origin.replace(/\/$/, ''))
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    if (url === candidate) return '/'
    if (url.startsWith(candidate)) {
      const next = url.slice(candidate.length)
      return next.startsWith('/') ? next : `/${next}`
    }
  }

  return url
}

const normalizeHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

const buildTableShareHeaders = (context: WebTableRuntimeContext): Record<string, string> => ({
  ...(context.tableShareId ? { 'X-Table-Share-Id': context.tableShareId } : {}),
  ...(context.tableSharePassword ? { 'X-Table-Share-Password': context.tableSharePassword } : {}),
})

const mergeFetchHeaders = (
  initHeaders: HeadersInit | undefined,
  extraHeaders: Record<string, string>,
): Headers => {
  const headers = new Headers(initHeaders)
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value)
  }
  return headers
}

const createWebTableFetch = (context: WebTableRuntimeContext): typeof globalThis.fetch => {
  const shareHeaders = buildTableShareHeaders(context)
  if (Object.keys(shareHeaders).length === 0) {
    return globalThis.fetch.bind(globalThis)
  }
  return (input, init) => {
    const nextInit: RequestInit = {
      ...(init ?? {}),
      headers: mergeFetchHeaders(init?.headers, shareHeaders),
    }
    return globalThis.fetch(input, nextInit)
  }
}

const requestViaWebApiClient = async <T = unknown>(
  options: TableHttpRequest,
  baseApiUrl: string,
  context: WebTableRuntimeContext,
): Promise<TableHttpResponse<T>> => {
  const client = getApiClient()
  const rawPath = resolveRawPath(options.url, baseApiUrl)
  const response = await client.raw(options.method, rawPath, {
    headers: {
      ...(options.headers ?? {}),
      ...buildTableShareHeaders(context),
    },
    body: options.body ? JSON.parse(options.body) : undefined,
    rawResponse: true,
  }) as Response

  let data: T
  const contentType = response.headers.get('content-type') ?? ''
  if (response.status === 204 || contentType.length === 0) {
    data = undefined as T
  } else if (contentType.includes('application/json')) {
    data = (await response.json()) as T
  } else {
    data = (await response.text()) as T
  }

  return {
    data,
    status: response.status,
    statusText: response.statusText,
    headers: normalizeHeaders(response.headers),
  }
}

export const configureWebTableRuntime = (context: WebTableRuntimeContext = {}): void => {
  const baseApiUrl = getResolvedBaseApiUrl()
  const isSharedTableRoute =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/shared/tables/')
  if (isSharedTableRoute && lastRuntimeContext.tableShareId && !context.tableShareId) {
    return
  }
  const nextSignature = JSON.stringify({
    baseApiUrl,
    organizationId: context.organizationId ?? null,
    spaceId: context.spaceId ?? null,
    tableShareId: context.tableShareId ?? null,
    tableSharePassword: context.tableSharePassword ?? null,
  })

  if (nextSignature === lastRuntimeSignature) {
    return
  }

  const options: TableHostRuntimeOptions = {
    baseApiUrl,
    organizationId: context.organizationId ?? null,
    spaceId: context.spaceId ?? null,
    windowId: RUNTIME_WINDOW_ID,
    getAccessToken: async () => localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
    request: (request) => requestViaWebApiClient(request, baseApiUrl, context),
    i18n: {
      // 与 Electron useTranslation(['view','common','table']) 对齐：无前缀键默认落 view
      t: createLooseTranslate(i18n.getFixedT(null, ['view', 'common', 'table'])),
    },
    file: {
      downloadBlob: (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      },
    },
  }

  initializeTableHostRuntime(options)
  setTableFetch(createWebTableFetch(context))

  lastRuntimeSignature = nextSignature
  lastRuntimeContext = { ...context }
}

export const ensureWebTableRuntimeConfigured = (): void => {
  configureWebTableRuntime()
}

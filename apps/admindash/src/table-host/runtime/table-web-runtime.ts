import { API_BASE_URL } from '@/api/client'
import { browserFilePort } from '@/table-host/runtime/browser-file-port'
import {
  type TableApiPort,
  type TableHttpRequest,
  type TableHttpResponse,
  configureTableDataClient,
  configureTableRuntime,
} from '@tabtin/table-core'

let runtimeInitialized = false

const headersToObject = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

const parseResponseData = async <T>(response: Response): Promise<T> => {
  if (response.status === 204) {
    return null as T
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return (await response.json()) as T
  }

  return (await response.text()) as T
}

const webApiPort: TableApiPort = {
  request: async <T = unknown>(options: TableHttpRequest): Promise<TableHttpResponse<T>> => {
    const response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      credentials: 'same-origin',
    })

    return {
      data: await parseResponseData<T>(response),
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
    }
  },
  getAccessToken: async () => localStorage.getItem('access_token'),
}

export const ensureTableWebRuntime = (): void => {
  if (runtimeInitialized) {
    return
  }

  configureTableRuntime({
    api: webApiPort,
    file: browserFilePort,
    i18n: {
      t: (key, options) => (typeof options?.defaultValue === 'string' ? options.defaultValue : key),
    },
  })

  configureTableDataClient({
    baseURL: API_BASE_URL ?? '',
  })

  runtimeInitialized = true
}

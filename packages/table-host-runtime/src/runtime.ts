import { createDirectAppClient } from '@tabtin/app-host-sdk/host'
import type { AppHttpRequest } from '@tabtin/contracts/app'
import {
  configureTableDataClient,
  configureTableRuntime,
  DEFAULT_TABLE_DATA_ENDPOINTS,
  setAppHostClient,
  type TableApiPort,
  type TableDataEndpoints,
  type TableFilePort,
  type TableHttpRequest,
  type TableHttpResponse,
  type TableI18nPort,
  type TableTelemetryPort,
  type TableUploadPort,
} from '@tabtin/table-core'

export interface TableHostRuntimeOptions {
  appId?: string
  baseApiUrl: string
  organizationId?: string | null
  spaceId?: string | null
  getAccessToken: TableApiPort['getAccessToken']
  request: <T = unknown>(options: TableHttpRequest) => Promise<TableHttpResponse<T>>
  windowId?: string | null
  i18n?: TableI18nPort
  file?: TableFilePort
  upload?: TableUploadPort
  telemetry?: TableTelemetryPort
  endpoints?: Partial<TableDataEndpoints>
}

const createWindowId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `table-host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const createTableApiPort = (options: TableHostRuntimeOptions): TableApiPort => {
  const resolvedWindowId = options.windowId === undefined ? createWindowId() : options.windowId

  return {
    request: options.request,
    getAccessToken: options.getAccessToken,
    getWindowId: () => resolvedWindowId ?? null,
  }
}

export const initializeTableHostRuntime = (options: TableHostRuntimeOptions): TableApiPort => {
  const apiPort = createTableApiPort(options)

  const endpoints: TableDataEndpoints = options.endpoints
    ? { ...DEFAULT_TABLE_DATA_ENDPOINTS, ...options.endpoints }
    : DEFAULT_TABLE_DATA_ENDPOINTS

  configureTableDataClient({
    baseURL: options.baseApiUrl,
    endpoints,
  })

  configureTableRuntime({
    api: apiPort,
    ...(options.i18n ? { i18n: options.i18n } : {}),
    ...(options.file ? { file: options.file } : {}),
    ...(options.upload ? { upload: options.upload } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })

  const client = createDirectAppClient({
    appId: options.appId ?? 'tabdata',
    spaceId: options.spaceId ?? null,
    organizationId: options.organizationId ?? null,
    baseApiUrl: options.baseApiUrl,
    getAccessToken: () => apiPort.getAccessToken(),
    httpTransport: (request: AppHttpRequest) => apiPort.request(request),
  })

  setAppHostClient(client)
  return apiPort
}

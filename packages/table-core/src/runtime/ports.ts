export type TableHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export interface TableHttpRequest {
  url: string
  method: TableHttpMethod
  headers?: Record<string, string>
  body?: string
}

export interface TableHttpResponse<T = unknown> {
  data: T
  status: number
  headers?: Record<string, string>
  statusText?: string
}

export interface TableApiPort {
  request<T = unknown>(options: TableHttpRequest): Promise<TableHttpResponse<T>>
  getAccessToken(): Promise<string | null>
  getWindowId?(): string | null
}

export interface TableRealtimeSubscription {
  unsubscribe(): void
}

export interface TableRealtimePort {
  subscribeTableEvents?(tableId: string, onEvent: (event: unknown) => void): Promise<TableRealtimeSubscription>
}

export interface TableUploadPort {
  uploadFile?(file: File): Promise<unknown>
}

export interface TableI18nPort {
  t?(key: string, options?: Record<string, unknown>): string
}

export interface TableTelemetryPort {
  track?(eventName: string, payload?: Record<string, unknown>): void
}

export interface TableFilePort {
  downloadBlob?(blob: Blob, filename: string): void
}

export interface TableRuntimePorts {
  api: TableApiPort
  realtime?: TableRealtimePort
  upload?: TableUploadPort
  file?: TableFilePort
  i18n?: TableI18nPort
  telemetry?: TableTelemetryPort
}

declare module '@tabtin/smartsheet-adapter-electron/renderer' {
  import type { TableHttpRequest, TableHttpResponse } from '@tabtin/table-core'

  export interface RendererApiAdapter {
    request<T = unknown>(options: TableHttpRequest): Promise<TableHttpResponse<T>>
    getAccessToken(): Promise<string | null>
  }

  export function getApiAdapter(): RendererApiAdapter
}

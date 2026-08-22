export interface McpContentApiPort {
  get(path: string): Promise<unknown>
  request(path: string, init?: RequestInit): Promise<unknown>
}

export interface McpMutationResult {
  success: boolean
  data?: unknown
  errors: Array<{ code: string; message: string }>
}

export interface McpTablePort {
  createTable(input: any): Promise<McpMutationResult>
  updateTable(input: any): Promise<McpMutationResult>
  deleteTable(input: any): Promise<McpMutationResult>
  archiveTable(input: any): Promise<McpMutationResult>
  restoreTable(input: any): Promise<McpMutationResult>
  createField(input: any): Promise<McpMutationResult>
  updateField(input: any): Promise<McpMutationResult>
  deleteField(input: any): Promise<McpMutationResult>
  createView(input: any): Promise<McpMutationResult>
  updateView(input: any): Promise<McpMutationResult>
  deleteView(input: any): Promise<McpMutationResult>
  createRecord(input: any): Promise<McpMutationResult>
  updateRecord(input: any): Promise<McpMutationResult>
  deleteRecord(input: any): Promise<McpMutationResult>
  batchCreateRecords(input: any): Promise<McpMutationResult>
  batchUpdateRecords(input: any): Promise<McpMutationResult>
  batchDeleteRecords(input: any): Promise<McpMutationResult>
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
}

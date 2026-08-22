import type { McpContentApiPort, McpMutationResult, McpTablePort } from '../ports.js'

const SERVICE_UNAVAILABLE = -32001

export class McpDomainSupport {
  constructor(
    protected readonly contentApi: McpContentApiPort,
    protected readonly table?: McpTablePort,
  ) {}

  protected get(path: string): Promise<unknown> { return this.contentApi.get(path) }
  protected request(path: string, init: RequestInit = {}): Promise<unknown> { return this.contentApi.request(path, init) }

  protected requireTable(): McpTablePort {
    if (this.table) return this.table
    const error = new Error('Table service is unavailable. Table mutations and SQL require a fully initialized daemon.')
    ;(error as any).mcpErrorCode = SERVICE_UNAVAILABLE
    throw error
  }

  protected requireArgs(args: Record<string, unknown>, ...keys: string[]): void {
    const missing = keys.filter(key => args[key] == null || args[key] === '')
    if (missing.length) throw new Error(`Missing required parameters: ${missing.join(', ')}`)
  }

  protected formatResult(result: McpMutationResult): Record<string, unknown> {
    if (result.success) return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, ...(result.data as Record<string, unknown> ?? {}) }, null, 2) }],
    }
    return {
      content: [{ type: 'text', text: `Failed: ${result.errors.map(error => `${error.code}: ${error.message}`).join('; ')}` }],
      isError: true,
    }
  }
}

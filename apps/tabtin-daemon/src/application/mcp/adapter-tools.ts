import { getToolManifests, type ActionExecutorAdapter } from '@tabtin/action-tools/headless'
import type { McpToolDefinition } from './contracts.js'

const HIDDEN_TOOLS = new Set(getToolManifests()
  .filter(manifest => (manifest as { llm_facing?: boolean }).llm_facing === false)
  .map(manifest => manifest.name))

export class McpAdapterTools {
  private cache: McpToolDefinition[] | null = null
  private cachedAt = 0

  constructor(
    private readonly adapter: ActionExecutorAdapter | null,
    private readonly localNames: ReadonlySet<string>,
    private readonly workspaceRoot?: string,
  ) {}

  list(): McpToolDefinition[] {
    if (!this.adapter) return []
    if (this.cache && Date.now() - this.cachedAt < 60_000) return this.cache
    this.cache = this.adapter.getRegisteredTools().flatMap(name => {
      if (this.localNames.has(name) || HIDDEN_TOOLS.has(name)) return []
      const definition = this.adapter!.getToolDefinition(name)
      return [{ name, description: definition?.description ?? `Action: ${name}`, inputSchema: definition?.parameters ?? { type: 'object', properties: {}, required: [] } }]
    })
    this.cachedAt = Date.now()
    return this.cache
  }

  isHidden(name: string): boolean { return HIDDEN_TOOLS.has(name) }
  hiddenNames(): string[] { return [...HIDDEN_TOOLS] }
  canExecute(name: string): boolean { return !!this.adapter?.hasToolForAction(name) && !this.localNames.has(name) }

  async execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.adapter) throw new Error(`No adapter registered for '${name}'`)
    const params = { ...args }
    if (this.workspaceRoot && !params._workspace_root) params._workspace_root = this.workspaceRoot
    const requestId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await this.adapter.executeAction({ task_id: requestId, type: name, params, thread_id: requestId })
    if (!result.success) return { content: [{ type: 'text', text: `Error: ${result.error ?? 'Unknown error'}` }], isError: true }
    const { success: _success, error: _error, frontend_execution_time_ms: _time, ...payload } = result
    return { content: [{ type: 'text', text: JSON.stringify(Object.keys(payload).length ? payload : { success: true }, null, 2) }] }
  }
}

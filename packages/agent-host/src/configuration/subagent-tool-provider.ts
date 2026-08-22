import type { Tool, ToolProvider } from '@tabtin/agent-runtime/engine'

const SUBAGENT_OMITTED_TOOLS = new Set(['todo'])

export function createSubagentToolProvider(base: ToolProvider): ToolProvider {
  return {
    getTools: () => base.getTools().filter(isSubagentTool),
    refreshTools: base.refreshTools
      ? async () => {
          await base.refreshTools!()
        }
      : undefined,
  }
}

function isSubagentTool(tool: Tool): boolean {
  return !SUBAGENT_OMITTED_TOOLS.has(tool.name)
}

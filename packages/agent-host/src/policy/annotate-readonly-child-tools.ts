/**
 * readonly 子 Agent 工具标注（ Stage 4）。
 *
 * 自 agent-runtime/subagent-readonly 迁出；产品 ask-mode annotate 留在宿主。
 */

import { annotateToolsForMode } from '@tabtin/agent-modes'
import type { Tool, ToolProvider } from '@tabtin/agent-runtime/engine'

export function annotateReadonlyChildTools(tools: Tool[]): Tool[] {
  return annotateToolsForMode(tools, 'ask')
}

export function wrapToolProviderForAskMode(base: ToolProvider): ToolProvider {
  return {
    getTools: () => annotateReadonlyChildTools(base.getTools()),
    refreshTools: base.refreshTools
      ? async () => {
          await base.refreshTools!()
        }
      : undefined,
  }
}

/**
 * ToolGate 宿主适配器（ Stage 4）。
 *
 * 包装 `@tabtin/agent-modes` 的受限模式判定与工具软拒；
 * 供 Electron / Daemon 注入 EngineConfig.toolGate。
 */

import {
  isPlanModeGuardActive,
  evaluateAgentModeToolAccess,
  PLAN_TARGET_GUARDED_TOOLS,
  type AgentModeName,
} from '@tabtin/agent-modes'
import type { ToolGate } from '@tabtin/agent-runtime/engine'

export interface CreateAgentModesToolGateDeps {
  getAgentMode: () => string | undefined
  getWorkspaceRoot?: () => string | undefined
}

export function createAgentModesToolGate(
  deps: CreateAgentModesToolGateDeps,
): ToolGate {
  return {
    isRestrictedMode: () =>
      isPlanModeGuardActive(deps.getAgentMode() as AgentModeName | undefined),
    evaluate: ({ toolName, isReadOnly, input }) => {
      const verdict = evaluateAgentModeToolAccess({
        tool: { name: toolName, isReadOnly },
        toolInput: input,
        agentMode: deps.getAgentMode() as AgentModeName | undefined,
        workspaceRoot: deps.getWorkspaceRoot?.(),
      })
      return {
        allowed: verdict.allowed,
        reason: verdict.allowed ? undefined : verdict.error?.error,
      }
    },
    isPlanTargetGuarded: (toolName) => PLAN_TARGET_GUARDED_TOOLS.has(toolName),
  }
}

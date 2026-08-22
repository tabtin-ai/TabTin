/**
 * 测试用 ToolGate——包装 @tabtin/agent-modes（与宿主适配器同形）。
 * 不可放进 src（会进 baseline）；亦不可引用宿主包（AH-003）。
 */

import {
  isPlanModeGuardActive,
  evaluateAgentModeToolAccess,
  PLAN_TARGET_GUARDED_TOOLS,
  type AgentModeName,
} from '@tabtin/agent-modes'
import type { ToolGate } from '../../src/engine/contracts/kernel.js'

export function createTestAgentModesToolGate(deps: {
  getAgentMode: () => string | undefined
  getWorkspaceRoot?: () => string | undefined
}): ToolGate {
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

/** 组装根常用：按 EngineConfig.agentMode 绑定。 */
export function bindTestAgentModesToolGate(config: {
  agentMode?: string
  workspaceRoot?: string
}): ToolGate {
  return createTestAgentModesToolGate({
    getAgentMode: () => config.agentMode,
    getWorkspaceRoot: () => config.workspaceRoot,
  })
}

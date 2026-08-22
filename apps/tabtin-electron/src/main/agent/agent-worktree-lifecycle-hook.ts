import type { EngineHooks } from '@tabtin/agent-runtime/engine'
import type { AgentWorktreeTransitionQueue } from './agent-worktree-transition.js'

export interface AgentWorktreeLifecycleHookOptions {
  transitions: AgentWorktreeTransitionQueue
}

/**
 * Electron 宿主中的 worktree 工具生命周期适配器。
 *
 * hook 只把 runtime 的通用工具边界事件翻译为 Electron 状态机操作；
 * 创建、切换、等待、绑定与续跑仍由主进程完成。
 */
export function buildAgentWorktreeLifecycleHook(
  options: AgentWorktreeLifecycleHookOptions,
): EngineHooks {
  return {
    async beforeTool(ctx) {
      if (!options.transitions.peekRun(ctx.runId)) return
      ctx.skipCurrentTool('agent_worktree_transition_pending')
    },
    async afterToolResult(ctx) {
      let reachedTransitionBoundary = false
      for (const result of ctx.results) {
        if (options.transitions.markToolBoundary(ctx.runId, result.toolUseId)) {
          reachedTransitionBoundary = true
        }
      }
      if (reachedTransitionBoundary) {
        ctx.requestStopAfterToolResults('agent_worktree_transition')
      }
    },
  }
}

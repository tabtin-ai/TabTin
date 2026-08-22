/**
 * end_turn 待办收尾 nudge 文案（ Stage 2c）。
 */

import { buildTodoCompletionNudgeBody } from '@tabtin/agent-prompt'
import type {
  TodoCompletionNudgeProvider,
  TodoNudgeItem,
} from '@tabtin/agent-runtime/engine'

export function createTodoCompletionNudgeProvider(): TodoCompletionNudgeProvider {
  return {
    buildNudgeBody(unfinished: readonly TodoNudgeItem[]): string {
      return buildTodoCompletionNudgeBody(unfinished)
    },
    // 产品语义：仅 agent 模式（或缺省）催收尾；受限 / group 等不打扰。
    isEnabledForMode(agentMode: string | undefined): boolean {
      return agentMode === undefined || agentMode === 'agent'
    },
  }
}

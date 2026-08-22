import type { AgentModeName } from '../shared/types'

/**
 * ：历史恢复回填 agentMode。
 * 已有 live 值（如 ModeSwitch / Plan 执行刚切到 agent）时不得被旧 metadata 盖回。
 */
export function mergeRestoredSessionAgentMode(
  liveMode: AgentModeName | undefined,
  restoredMode: AgentModeName | undefined,
): AgentModeName | undefined {
  return liveMode ?? restoredMode
}

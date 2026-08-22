/**
 * ：跨轮模式权威（sticky）——防止 switch_mode / UI 已批准的执行模式
 * 被下一条消息里陈旧的 plan/ask/study IPC 打回。
 *
 * 规则：仅当 sticky 是「非 shell 受限」模式，而 request 仍是受限模式时，
 * 以 sticky 为准。用户经 `notify-mode-switched` 主动切回 plan 时会把 sticky
 * 写成 plan，此时不再拦截。
 */

import type { AgentModeName } from '@tabtin/agent-modes'

const SHELL_RESTRICTED_MODES = new Set<AgentModeName>(['plan', 'ask', 'study'])

export function isShellRestrictedAgentMode(mode: AgentModeName): boolean {
  return SHELL_RESTRICTED_MODES.has(mode)
}

/**
 * 用 Host 侧粘性模式校正本轮请求 mode。
 * sticky 缺失时原样返回 requestedMode。
 */
export function resolveRuntimeModeAgainstSticky(
  requestedMode: AgentModeName,
  stickyMode: AgentModeName | undefined,
): AgentModeName {
  if (
    stickyMode
    && !isShellRestrictedAgentMode(stickyMode)
    && isShellRestrictedAgentMode(requestedMode)
  ) {
    return stickyMode
  }
  return requestedMode
}

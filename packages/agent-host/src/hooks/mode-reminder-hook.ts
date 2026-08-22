/**
 * Mode Reminder Hook —— 每轮 query iteration 0 注入 sparse mode reminder。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildModeReminderInjectorHook`，
 * 住在 `@tabtin/agent-runtime` 的 `capability/injectors/mode-reminder-injector.ts`。
 * 因它依赖 `@tabtin/agent-modes` + `@tabtin/agent-prompt`，随「引擎零业务依赖」重构
 * 迁到宿主 `@tabtin/agent-host/hooks`。行为逐字节一致，仅换归属与工厂名
 * （`buildModeReminderInjectorHook` → `buildModeReminderHook`）。
 *
 * 每轮向 messages 注入 mode 约束的 `<system-reminder>`（总控 D5）；默认每轮注入，
 * `turnsBetween` 可设为 5 做节流。
 *
 * Phase 3：用户批准 switch_mode 后于下一轮 iteration 0 **一次性**注入
 * mode-transition-reminder。本 hook 一次可注入 0/1/2 条消息、filter 两个 marker，
 * 与单块注入模型不匹配，故不走 message-inject 原语、保持独立实现（对齐原设计）。
 */

import { getAgentModeSparseReminder, getModeTransitionReminder } from '@tabtin/agent-modes'
import type { AgentModeName } from '@tabtin/agent-modes'
import { buildUserContextWrapper, type UserContextWrapperType } from '@tabtin/agent-prompt'
import type { Message, EngineHooks, IterationHookContext } from '@tabtin/agent-runtime/engine'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
  findLastRealUserIndex,
  isRealUserMessage,
} from '@tabtin/agent-runtime/engine'

// ─── Public Types ────────────────────────────────────────────────────

export interface PendingModeTransition {
  fromMode: AgentModeName
  toMode: AgentModeName
}

export interface ModeReminderHookOptions {
  getAgentMode: () => AgentModeName | undefined
  /** 默认 1 = 每轮；5 = 节流（隔 5 轮注入一次）。 */
  turnsBetween?: number
  /**
   * Plan 模式主 plan 文件路径（可选；无则 plan-sparse 省略路径占位）。
   *
   * **TD-16 决策**：TabTin Plan 概念是 TabDoc document_id，不是本地文件路径。
   * 生产 Electron / Daemon 当前均不注入此回调；`{{planFilePath}}` 占位符会替换为
   * 空字符串，文案优雅 fallback。主要服务未来扩展（path-aware 草稿 / 第三方 host）。
   */
  getActivePlanFilePath?: () => string | undefined
  /**
   * 任意 mode 切换后由宿主置入 from/to；本 hook 注入 mode-transition reminder 后
   * 立即调 `clearPendingModeTransition` 清标记（仅一次）。
   */
  getPendingModeTransition?: () => PendingModeTransition | undefined
  clearPendingModeTransition?: () => void
}

const MODE_REMINDER_MARKER = INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION
const MODE_TRANSITION_REMINDER_MARKER = INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER

const PER_TURN_MODES = new Set<AgentModeName>(['ask', 'plan', 'study'])

function buildInjectionMessage(
  contextType: UserContextWrapperType,
  inner: string,
  marker: typeof MODE_REMINDER_MARKER | typeof MODE_TRANSITION_REMINDER_MARKER,
): Message {
  const text = buildUserContextWrapper(contextType, inner)
  return setInternalMarker(
    {
      role: 'system',
      content: [{ type: 'text', text }],
    },
    marker,
  )
}

/**
 * 自上次 mode reminder 以来累计的真实 user turn 数。无历史 reminder → 视为应注入。
 */
export function shouldInjectModeReminderThisTurn(
  messages: readonly Message[],
  turnsBetween: number,
): boolean {
  if (turnsBetween <= 1) return true

  let turnsSinceLast = 0
  let foundPrevious = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (hasInternalMarker(msg, MODE_REMINDER_MARKER)) {
      foundPrevious = true
      break
    }
    if (isRealUserMessage(msg)) {
      turnsSinceLast++
    }
  }

  if (!foundPrevious) return true
  return turnsSinceLast >= turnsBetween
}

export function buildModeReminderHook(
  options: ModeReminderHookOptions,
): EngineHooks {
  const turnsBetween = options.turnsBetween ?? 1

  return {
    async beforeIteration(ctx: IterationHookContext): Promise<void> {
      const state = ctx.state
      if (ctx.iteration !== 0) return

      const mode = options.getAgentMode() ?? 'agent'

      // 清掉旧 marker（mode 切换后 reminder 应消失）
      const filtered = state.messages.filter(
        (m) =>
          !hasInternalMarker(m, MODE_REMINDER_MARKER) &&
          !hasInternalMarker(m, MODE_TRANSITION_REMINDER_MARKER),
      )

      const insertAfter = findLastRealUserIndex(filtered)
      if (insertAfter < 0) {
        state.messages = filtered
        return
      }

      const injections: Message[] = []

      // 一次性 mode transition reminder（优先于 sparse mode reminder）。
      const pendingTransition = options.getPendingModeTransition?.()
      if (pendingTransition) {
        const transitionSparse = getModeTransitionReminder(pendingTransition)
        const transitionInner = `<system-reminder>\n${transitionSparse}\n</system-reminder>`
        injections.push(
          buildInjectionMessage('mode-transition-reminder', transitionInner, MODE_TRANSITION_REMINDER_MARKER),
        )
        options.clearPendingModeTransition?.()
      }

      if (PER_TURN_MODES.has(mode)) {
        if (shouldInjectModeReminderThisTurn(filtered, turnsBetween)) {
          const sparseMode = mode as 'ask' | 'plan' | 'study'
          const sparse = getAgentModeSparseReminder(sparseMode, {
            activePlanFilePath: options.getActivePlanFilePath?.(),
          })
          const inner = `<system-reminder>\n${sparse}\n</system-reminder>`
          injections.push(
            buildInjectionMessage('mode-reminder', inner, MODE_REMINDER_MARKER),
          )
        }
      }

      if (injections.length === 0) {
        state.messages = filtered
        return
      }

      const next = filtered.slice()
      next.splice(insertAfter + 1, 0, ...injections)
      state.messages = next
    },
  }
}

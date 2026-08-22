/**
 * ：点券充值 / 余额恢复后，消掉对话里粘滞的「组织可用点券余额不足」卡。
 *
 * 侧栏失败 `!`：
 * - 旧后端无 run_state：消息启发式走 resolveMessageErrorState；标
 *   billingErrorResolved 后不再当错误，感叹号随之消失。
 * - 新后端有权威 run_state.failed： 禁止客户端再写 local-terminal /
 *   markRunTerminal overlay；侧栏展示层只在 run 失败类别与已消警消息都指向
 *   billing 时隐藏失败徽标，不改写服务端运行事实。
 *
 * 铃铛 balance_low 未读不在此处理。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '@/stores/chat/useChatStore'
import { resolveMessageErrorState } from '@/components/chat/message'

/** 写在 message.metadata：resolveMessageErrorState 见此则视为已消警 */
export const BILLING_ERROR_RESOLVED_META_KEY = 'billingErrorResolved'

const BALANCE_ERROR_CATEGORIES = new Set([
  'organization_insufficient_credits',
  'insufficient_credits',
  'billing',
])

const BALANCE_ERROR_CLASSES = new Set([
  'LLM_BILLING_ORG_INSUFFICIENT',
  'LLM_BILLING_ERROR',
])

export function isBalanceBillingErrorClass(errorClass: string | null | undefined): boolean {
  return !!errorClass && BALANCE_ERROR_CLASSES.has(errorClass)
}

function readMeta(message: ChatMessage): Record<string, unknown> {
  return (message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata))
    ? message.metadata as Record<string, unknown>
    : {}
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readBillingCategory(source: Record<string, unknown> | undefined): string {
  const extras = readObject(source?.errorExtras ?? source?.error_extras)
  return typeof source?.errorCategory === 'string'
    ? source.errorCategory
    : typeof source?.error_category === 'string'
      ? source.error_category
      : typeof source?.error_type === 'string'
        ? source.error_type
        : typeof extras?.error_category === 'string'
          ? extras.error_category
          : typeof extras?.error_type === 'string'
            ? extras.error_type
            : ''
}

function readBillingClass(source: Record<string, unknown> | undefined): string {
  return typeof source?.errorClass === 'string'
    ? source.errorClass
    : typeof source?.error_class === 'string'
      ? source.error_class
      : ''
}

export function isBalanceBillingErrorMessage(message: ChatMessage): boolean {
  const meta = readMeta(message)
  if (meta[BILLING_ERROR_RESOLVED_META_KEY] === true) return false

  const state = resolveMessageErrorState(message)
  if (state.errorCategory && BALANCE_ERROR_CATEGORIES.has(state.errorCategory)) {
    return true
  }
  if (state.errorClass && BALANCE_ERROR_CLASSES.has(state.errorClass)) {
    return true
  }
  const extras = state.errorExtras
  const extrasCategory = typeof extras?.error_category === 'string'
    ? extras.error_category
    : typeof extras?.error_type === 'string'
      ? extras.error_type
      : ''
  return BALANCE_ERROR_CATEGORIES.has(extrasCategory)
}

export function isResolvedBalanceBillingErrorMessage(message: ChatMessage): boolean {
  const meta = readMeta(message)
  if (meta[BILLING_ERROR_RESOLVED_META_KEY] !== true) return false
  const info = readObject(message.error_info_json)
  return BALANCE_ERROR_CATEGORIES.has(readBillingCategory(meta))
    || BALANCE_ERROR_CLASSES.has(readBillingClass(meta))
    || BALANCE_ERROR_CATEGORIES.has(readBillingCategory(info))
    || BALANCE_ERROR_CLASSES.has(readBillingClass(info))
}

/**
 * 将内存中所有会话里未消警的余额不足消息标为已恢复。
 * @returns 被标记的消息条数
 */
export function clearBalanceBillingErrorsInChatStore(): number {
  const store = useChatStore.getState()
  const bySession = store.messagesBySessionId
  let marked = 0

  for (const [sessionId, messages] of Object.entries(bySession)) {
    if (!messages?.length) continue
    for (const message of messages) {
      if (!isBalanceBillingErrorMessage(message)) continue
      store.patchMessageById(sessionId, message.id, (prev) => {
        const prevMeta = readMeta(prev)
        if (prevMeta[BILLING_ERROR_RESOLVED_META_KEY] === true) return prev
        marked += 1
        return {
          ...prev,
          metadata: {
            ...prevMeta,
            [BILLING_ERROR_RESOLVED_META_KEY]: true,
            billingErrorResolvedAt: new Date().toISOString(),
          },
        }
      })
    }
  }

  return marked
}

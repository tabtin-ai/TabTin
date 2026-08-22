/**
 * TabCode「发送给 Agent」统一入口
 *
 * 文件树 / 预览 / worktree outcome 等入口共用，内部走会话级
 * deliverContextInjectToChat，不依赖 ChatPanel 是否挂载。
 */

import {
  deliverContextInjectToChat,
  type DeliverContextInjectResult,
} from '@/services/deliverContextInjectToChat'
import type { ContextInjectPayload } from '@stores/useContextInjectionStore'

export function sendCodeContextToChat(
  payload: ContextInjectPayload,
): DeliverContextInjectResult {
  return deliverContextInjectToChat(payload)
}

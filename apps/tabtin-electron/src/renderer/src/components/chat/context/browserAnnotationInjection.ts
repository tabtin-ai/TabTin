import type { ChatAttachment, ContextRef } from '../types'

export const BROWSER_ANNOTATION_INJECT_EVENT = 'tabtin:inject-browser-annotation-to-chat'

export interface BrowserAnnotationInjectPayload {
  contextRef: ContextRef
  attachment?: ChatAttachment
  /**
   * 投递确认：挂载中且接收全局输入事件的 ChatInput 真正消费 payload 时置位。
   * CustomEvent 派发是同步的——dispatchEvent 返回后读取该标记即可判断有没有 composer 接住。
   */
  consumed?: boolean
}

/**
 * 广播「把网页注释/截图注入对话」事件。
 *
 * @returns 是否被某个挂载中的 composer 消费。false = 当前没有可用对话输入框
 *（如工作台全屏浏览器场景），调用方应走「自动开新任务草稿」兜底而不是谎报成功。
 */
export function emitBrowserAnnotationInject(payload: BrowserAnnotationInjectPayload): boolean {
  if (typeof window === 'undefined') return false
  window.dispatchEvent(new CustomEvent(BROWSER_ANNOTATION_INJECT_EVENT, { detail: payload }))
  return payload.consumed === true
}

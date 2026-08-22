/**
 * Assistant 会话级 in-memory 状态（Wave 4a 拆出来的 utility）。
 *
 * **重构背景**：原 `assistantHandler.ts` 既包含老协议 handler（ASSISTANT /
 * REASONING / CONTENT_RESET）又包含一组跨 handler 共用的会话级 in-memory map
 * （active thinking 状态 / 错误元信息）。Wave 4a 物理删除老协议 handler，
 * 但这组 utility 在新协议下**仍然需要**：
 *   - lifecycleHandler 在 phase=end/error/terminated 时清 active thinking
 *   - sendMessageAction 在 onDone 时消费 error meta 拼最终消息错误归类
 *
 * 长远（W4b/W5）这些状态应当迁到 `useChatRuntimeStore` per-session 字段，
 * 但 W4a 范围有限——这里先用 module-local Map 维持等价语义，文件命名上
 * 与 `_activeThinkingBySession` / `_errorMetaBySession` 的语义一致。
 *
 * **写入方**：W4a 暂留空——老 handler 已删，新 handler（contentBlockHandler）
 * 不再写 thinking active map（同等语义通过 contentBlocks 块 `finalized`
 * 字段表达）。本文件只暴露**读 / 清**操作。下一个 Wave 接通新协议的
 * thinking 块时如需重新维护 active state，再在此文件内补 setter。
 */

export interface AssistantErrorMeta {
  isErrorMessage: true
  errorCategory?: string
  suggestedAction?: string
  errorClass?: string
}

const _activeThinkingBySession = new Map<string, { id: string; detail: string }>()
const _errorMetaBySession = new Map<string, AssistantErrorMeta>()

export function consumeAssistantErrorMeta(sessionId: string): AssistantErrorMeta | undefined {
  const meta = _errorMetaBySession.get(sessionId)
  if (meta) _errorMetaBySession.delete(sessionId)
  return meta
}

export function clearAssistantErrorMeta(sessionId: string): void {
  _errorMetaBySession.delete(sessionId)
}

export function clearActiveThinking(sessionId: string): void {
  _activeThinkingBySession.delete(sessionId)
}

/**
 * 测试用：重置内部状态（仅在 unit test 调用，避免跨 case 状态泄漏）。
 */
export function __resetAssistantSessionStateForTests(): void {
  _activeThinkingBySession.clear()
  _errorMetaBySession.clear()
}

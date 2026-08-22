/**
 * ImConversationCanvasContext —— 「当前处于某条 IM 会话的桌面」信号。
 *
 * 只有当 shell 渲染出「IM 会话桌面」（im-chat + 解析到用户默认 Workspace 执行现场）时，
 * AppLayout 才提供非空值。会话内的资源卡（IMResourceCard）/ 资产列表行据此把资源
 * **就地打开在本会话画布**（im:{conversationId} 标签组），而不是跳到 Agent tab。
 *
 * 值为 null 的场景（保持既有「跳转打开」行为）：
 * - 无默认 Workspace 的兜底全屏聊天
 * - Project 频道右侧 rail / placeholder
 * - 独立私信窗口（AppDetachedIM，不渲染本 Provider）
 */
import { createContext, useContext } from 'react'

export interface ImConversationCanvasTarget {
  /** 当前 IM 会话 id。 */
  conversationId: string
  /** 会话桌面的标签组 scope key（im:{conversationId}）。 */
  scopeKey: string
  /** 承载资源 tab 的执行现场（用户默认工作空间）id。 */
  executionSpaceId: string
}

const ImConversationCanvasContext = createContext<ImConversationCanvasTarget | null>(null)
ImConversationCanvasContext.displayName = 'ImConversationCanvasContext'

export const ImConversationCanvasProvider = ImConversationCanvasContext.Provider

/** 返回当前 IM 会话桌面目标；不在会话桌面时为 null。 */
export function useImConversationCanvas(): ImConversationCanvasTarget | null {
  return useContext(ImConversationCanvasContext)
}

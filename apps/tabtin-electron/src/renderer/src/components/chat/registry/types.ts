/**
 * Electron-specific registry types.
 *
 * Extends the platform-agnostic CardDescriptor from @tabtin/chat-client
 * with React component references.
 */

import type React from 'react'
import type { ToolCardDescriptor, ToolOutputData } from '@tabtin/chat-client'

/** Props every card renderer receives */
export interface CardRendererProps {
  /** Unique tool-call id (for keying) */
  id: string
  /** Tool name from backend */
  toolName: string
  /** Execution phase */
  phase: 'start' | 'running' | 'end' | 'error'
  /** Raw input from the tool call */
  input?: unknown
  /** Raw output from the tool call */
  output?: unknown
  /** Extracted structured data (if extractor succeeded) */
  data?: ToolOutputData | null
  /** Duration in milliseconds */
  durationMs?: number
  /** User-visible purpose supplied by runtime tool-call metadata. */
  intent?: string
  /**
   * Tool start timestamp (Date.now ms).
   *
   * Used by long-running terminal cards to show elapsed time even before any
   * stdout arrives (for commands like `du -sh ~` that stay silent until the end).
   */
  startedAt?: number
  /** Error message (when phase === 'error') */
  error?: string | null
  /**
   * 该工具调用所属的 chat session id；可选，仅渲染需要订阅 `tool_call_args_delta`
   * 流式 buffer 的卡片用得上（FileWriteCard / 未来其它流式卡片）。历史消息回放
   * 时该字段为 undefined——卡片应当 fallback 到 `output.data` 等持久化数据。
   */
  sessionId?: string | null
  /**
   * 当前 UI 标签组 scope（`conversation:<id>` / `desktop:...`，缺省退化 space.id）。
   *
   * 右侧工作台面板按此 key 读 `itemsBySpace[tabScopeKey]` 渲染标签；卡片里
   * 「打开/查看资源」类动作（如 TerminalCard 的跳转）必须用它作为 `openResourceTab`
   * 的桶 key，否则 tab 写进 raw spaceId 桶、面板读不到 → 打开无反应。
   */
  tabScopeKey?: string | null
}

/** A React component that can render a tool card's expanded body */
export type CardRendererComponent = React.FC<CardRendererProps>

/** Runtime registry entry: descriptor + resolved React renderer */
export interface ResolvedToolCard {
  descriptor: ToolCardDescriptor
  Renderer: CardRendererComponent
}

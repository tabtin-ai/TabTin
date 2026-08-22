import React from 'react'
import type { BlockRendererProps, ContentBlockEntry } from '../blocks/types'

export interface BlockTimelineRendererProps {
  /** 顺序的 ContentBlockEntry 数组（按 index 升序）——来自 useContentBlocks */
  blocks: readonly ContentBlockEntry[]
  /** 所属 session id；BlockRenderer 子组件订阅 buffer 用 */
  sessionId: string | null
  /** 当前 UI 标签组 scope；Markdown 资源链接打开时用来写入正确标签桶。 */
  tabScopeKey?: string | null
  /** 子 Agent run 反查专用 session id（缺省 = `sessionId`）。 */
  subagentRunSessionId?: string | null
  /** 本 message 的 owner（`subagent_run_id`）——聚合卡 live 反查子 Agent run 的作用域。 */
  ownerRunId?: string
  /** 所属 message id；用于 React key + ErrorBoundary resetKeys */
  messageId: string
  /** 是否最后一条 assistant message */
  isLastAssistantMsg?: boolean
  /** 当前 session 是否流式中 */
  isStreaming?: boolean
  /** 消息级错误卡已表达中断时，隐藏 block 级 partial 文案。 */
  suppressPartialReason?: boolean
  /** 会话级等待壳 / Thinking 流式可见时，block 内 inline loading 让位，避免双 spinner。 */
  suppressInlineLoading?: boolean
  /** 点击富内容资源 ref 时的导航回调 */
  onResourceNavigate?: BlockRendererProps['onResourceNavigate']
  /** 右键资源 ref 卡片时的菜单请求回调 */
  onResourceContextMenu?: BlockRendererProps['onResourceContextMenu']
}

export type BlockTimelineRenderer = React.ComponentType<BlockTimelineRendererProps>

let renderer: BlockTimelineRenderer | null = null

export function registerBlockTimelineRenderer(component: BlockTimelineRenderer): void {
  renderer = component
}

export function getBlockTimelineRenderer(): BlockTimelineRenderer | null {
  return renderer
}

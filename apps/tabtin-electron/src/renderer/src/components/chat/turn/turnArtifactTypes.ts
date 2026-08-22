/**
 * 「本轮产物」共享类型 —— 供 boundary / rich / 编排层引用，避免循环依赖。
 */
import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'

/**
 * 取一条消息的内容块——统一读入口：只读 `message.blocks`
 * （实时 commit / 入口 hydrate）。默认即走它，调用方不再注入 resolver 补丁
 * （流式期产物 / 图片 / doc create 也进轮次卡）。参数保留以便单测按需覆盖。
 */
export type TurnBlocksResolver = (msg: ChatMessage) => MessageBlock[]

export type TurnArtifactKind = 'file' | 'doc' | 'table' | 'resource' | 'widget'

export interface TurnArtifact {
  id: string
  kind: TurnArtifactKind
  title: string
  href: string
  subtitleKey: TurnArtifactSubtitleKey
  /** 云资源验收前的真实归属；与承载执行会话的 Project scope 分离。 */
  resourceSpaceId?: string
  /** local_file / oss_file 已知体积（字节）；共享会话超限禁用预览用。 */
  fileSize?: number
  /** widget：来源消息，供 Lightbox openFromMessage */
  sourceMessageId?: string
  /** widget：widget_id */
  widgetId?: string
  /**
   * ：来自子代理的交付物时展示来源名 badge（role → label → description）。
   * 主 Agent 本轮产物卡使用；子详情 transcript 不再挂本轮产物卡。
   */
  sourceSubagentName?: string
}

export type TurnArtifactSubtitleKey =
  | 'previewFile'
  | 'previewDoc'
  | 'previewTable'
  | 'previewResource'
  | 'previewOrDownload'
  | 'previewWidget'

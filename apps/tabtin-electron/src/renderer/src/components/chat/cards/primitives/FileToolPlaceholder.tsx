/**
 * FileToolPlaceholder — 文件工具专用的流式占位卡片。
 *
 * **为什么不用 LoadingPlaceholder**：通用 LoadingPlaceholder 是两条
 * `bg-muted/30` 的 pulse skeleton，在浅色界面几乎不可见——文件工具走的
 * 是 chat 流主区（FileOperationBlocks），用户在 `tool_call_start` 到
 * `tool_call_args_delta` 之间的窗口期会看到一片"空白"，不知所措。
 *
 * **本占位的设计**：明确告诉用户"工具开始执行了"，包含：
 *   - 完整卡片边框 + 浅色填充（视觉上等同最终卡片，体感连续）
 *   - 工具图标（FilePenLine / FilePlus2 / FileText / FileX2）
 *   - 文案（"准备编辑文件…" / "Preparing edit…"）
 *   - 旋转 spinner
 *
 * 一旦 `path` 流出来，DiffCard / FileWriteCard 自身就会切到带文件名的
 * "Editing…" 头部——本占位**只**承担最早一帧的"工具已启动"信号。
 */

import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
  ANIMATION,
} from '../../registry/chatDesignTokens'

export interface FileToolPlaceholderProps {
  /** 工具图标（由调用方传 FilePenLine / FilePlus2 / FileText / FileX2 等）。 */
  icon: React.ReactNode
  /** 占位主文案，比如 "准备编辑文件…"。 */
  text: string
}

export const FileToolPlaceholder: React.FC<FileToolPlaceholderProps> = React.memo(
  ({ icon, text }) => (
    <div
      className={cn(
        CARD_RADIUS,
        'border overflow-hidden',
        BORDER.default,
        BG.card,
      )}
    >
      <div
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          CARD_HEADER_PADDING.x,
          CARD_HEADER_PADDING.y,
          BG.header,
          'border-b',
          BORDER.subtle,
        )}
      >
        {icon}
        <span className={cn(TEXT.code, TEXT_COLOR.muted, 'min-w-0 flex-1 truncate')}>
          {text}
        </span>
        <Loader2
          className={cn(ICON_SIZE.sm, ANIMATION.spin, TEXT_COLOR.faint, 'shrink-0')}
        />
      </div>
    </div>
  ),
)

FileToolPlaceholder.displayName = 'FileToolPlaceholder'

export default FileToolPlaceholder

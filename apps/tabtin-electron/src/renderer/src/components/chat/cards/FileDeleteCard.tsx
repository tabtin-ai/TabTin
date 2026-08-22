/**
 * FileDeleteCard — 极简删除文件卡片（cursor 风格）。
 *
 * **设计取向（W14 Wave A·向 cursor 靠齐）**：
 *   - 头部克制：文件格式图标 + 文件名 + `deleted` 红色 chip
 *   - 不再用红底卡片（BG.error）+ 中文"已删除"徽章——按 chat 设计语言 point-only
 *     原则，状态语义靠图标/文字色承担，不压整张卡的 bg
 *   - 单行 layout：路径太长时 truncate；hover 在 FileCardHeader 的 button title
 *     里显示完整路径
 *   - 标题点击仍打开父目录的 TabCode（即使文件已删，父目录通常还在）
 *
 * **错误态**：删除失败时显示同款卡片 + 一行 ErrorBanner，让用户知道是哪个文件失败
 * 以及失败原因。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import { ErrorBanner } from './primitives'
import { FileCardHeader } from './primitives/FileCardHeader'
import {
  TEXT,
  DIFF,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'

interface FileDeleteCardProps {
  path: string
  /** 工具是否成功删除（end ✓ / error ✗）。 */
  success: boolean
}

const FileDeleteCard: React.FC<FileDeleteCardProps> = React.memo(({ path, success }) => {
  const { t } = useTranslation('chat')

  const chipLabel = success
    ? t('card.fileDelete.deletedChip', { defaultValue: 'deleted' })
    : t('card.fileDelete.failedChip', { defaultValue: 'failed' })

  // body-only：外层折叠行 + 下沉外框由 ToolStepCard 统一提供。
  return (
    <FileCardHeader
      filePath={path}
      meta={
        // -deleted chip。失败用 destructive 色
        <span className={cn(DIFF.removeText, TEXT.meta, 'font-mono shrink-0')}>
          -{chipLabel}
        </span>
      }
    />
  )
})

FileDeleteCard.displayName = 'FileDeleteCard'

const FileDeleteCardRenderer: React.FC<CardRendererProps> = ({ input, output, error, phase }) => {
  const inp = ((input as Record<string, unknown> | undefined)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const out = ((output as Record<string, unknown> | undefined)?.data ?? output ?? {}) as Record<string, unknown>
  const path = String(inp.path ?? out.path ?? '')

  if (error || phase === 'error') {
    return (
      <div className="space-y-1.5">
        <FileDeleteCard path={path} success={false} />
        {error && <ErrorBanner error={error} />}
      </div>
    )
  }

  return <FileDeleteCard path={path} success={phase === 'end'} />
}

FileDeleteCardRenderer.displayName = 'FileDeleteCardRenderer'

registerCardRenderer('FileDeleteCard', FileDeleteCardRenderer)

export { FileDeleteCard, FileDeleteCardRenderer }
export default FileDeleteCard

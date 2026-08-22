/**
 * MediaImageInlineCard — 对话流内联生图：等待画布 → 原地变成成品图。
 *
 * 不渲染终端卡；成功后从 tool stdout 解析 URL，用 RichImage 淡入。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { RichContentBlock } from '@tabtin/chat-client'
import { TEXT, TEXT_COLOR } from '../registry/chatDesignTokens'
import { ImageGeneratingCard, type ImageGeneratingPhase } from './ImageGeneratingCard'
import { formatMediaImageFailureDetails } from './formatMediaImageFailureDetails'
import { isShellBackgroundRunningOutput } from './isShellBackgroundRunningOutput'
import { markMediaImageShown } from './mediaImageInlineShown'
import { parseMediaImageGenerateResult } from './parseMediaImageGenerateResult'
import { hasFormalMediaImageArtifactForTool } from './mediaImageArtifactDedup'
import { RichImage } from '../richContent/RichImage'
import { useSessionBlocksRecord } from '@stores/chat/messages/messageBlocks'

export type MediaImageInlineCardProps = {
  /** ToolUseBlockView 的 phase */
  phase: 'start' | 'running' | 'end' | 'error'
  command?: string | null
  promptPreview?: string
  output?: unknown
  startedAtMs?: number
  sessionId?: string | null
  messageId?: string
  sourceToolUseId?: string
}

function mapPhase(phase: MediaImageInlineCardProps['phase']): ImageGeneratingPhase {
  if (phase === 'error') return 'failed'
  if (phase === 'end') return 'success'
  return 'running'
}

export const MediaImageInlineCard: React.FC<MediaImageInlineCardProps> = React.memo(
  ({ phase, command, promptPreview, output, startedAtMs, sessionId, messageId, sourceToolUseId }) => {
    const { t } = useTranslation('chat')
    const [showDetails, setShowDetails] = useState(false)
    const imagePhase = mapPhase(phase)
    const sessionBlocksRecord = useSessionBlocksRecord(sessionId)
    const hasFormalArtifact = useMemo(
      () => hasFormalMediaImageArtifactForTool(sessionBlocksRecord, sourceToolUseId),
      [sessionBlocksRecord, sourceToolUseId],
    )
    const imageUrl = useMemo(
      () => parseMediaImageGenerateResult(output),
      [output],
    )
    const stillBackgroundRunning = useMemo(
      () => isShellBackgroundRunningOutput(output),
      [output],
    )
    const failureDetails = useMemo(
      () => formatMediaImageFailureDetails(output, command),
      [output, command],
    )

    useEffect(() => {
      if (imageUrl) markMediaImageShown(sessionId, imageUrl)
    }, [imageUrl, sessionId])

    // 只有时间线已经观察到同一 tool_use 的正式图片，才让它接管正文和产物区。
    // stored_files 先于正式消息到达时仍保留预览，避免投递竞态造成白屏。
    if (hasFormalArtifact) return null

    // 有 URL 即原地出成品（即使 phase 仍短暂为 running/end 竞态）
    if (imageUrl) {
      const block = {
        type: 'rich_content',
        kind: 'image',
        url: imageUrl,
        summary: promptPreview ?? t('richContent.imageGenerating', { defaultValue: '正在生成图片' }),
      } as RichContentBlock
      return (
        <div data-testid="media-image-inline-card" data-state="ready" className="my-1">
          <RichImage block={block} messageId={messageId} sessionId={sessionId} />
        </div>
      )
    }

    // ：wait_ms 耗尽返回 status:running 时，lifecycle phase 会变 end，
    // 但进程仍在跑、尚无 URL——保持等待态，勿误显「生成失败」。
    if (stillBackgroundRunning) {
      return (
        <div data-testid="media-image-inline-card" data-state="running" className="my-1">
          <ImageGeneratingCard
            phase="running"
            startedAtMs={startedAtMs}
            promptPreview={promptPreview}
          />
        </div>
      )
    }

    // 真终态却无 URL → 失败态（含 ok:true / status:succeeded 但 result_urls 空）
    const displayPhase: ImageGeneratingPhase =
      imagePhase === 'success' && !imageUrl ? 'failed' : imagePhase

    return (
      <div data-testid="media-image-inline-card" data-state={displayPhase} className="my-1">
        <ImageGeneratingCard
          phase={displayPhase}
          startedAtMs={startedAtMs}
          promptPreview={promptPreview}
        />
        {displayPhase === 'failed' && (
          <button
            type="button"
            data-testid="media-image-inline-toggle-details"
            onClick={() => setShowDetails((v) => !v)}
            className={cn(
              'mt-1 text-caption text-muted-foreground/60 hover:text-foreground transition-colors',
            )}
          >
            {showDetails
              ? t('richContent.imageGenerateHideDetails', { defaultValue: '收起详情' })
              : t('richContent.imageGenerateViewDetails', { defaultValue: '查看详情' })}
          </button>
        )}
        {displayPhase === 'failed' && showDetails && (
          <pre
            data-testid="media-image-inline-details"
            className={cn(
              'mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-md',
              'border border-border/40 bg-muted/30 px-2 py-1.5',
              TEXT.code,
              TEXT_COLOR.muted,
            )}
          >
            {failureDetails}
          </pre>
        )}
      </div>
    )
  },
)

MediaImageInlineCard.displayName = 'MediaImageInlineCard'

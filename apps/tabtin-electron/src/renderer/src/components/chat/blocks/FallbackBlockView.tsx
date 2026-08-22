/**
 * FallbackBlockView — 未知 block.type / 渲染异常的兜底卡片（v2 §3.5.5）。
 *
 * 触发条件：
 *   1. block.type 不在 22 已知 case 内（前向兼容未来的 `code_artifact_v3` 等）
 *   2. block.type 已知但子 BlockRenderer 内部抛错（ErrorBoundary 接住）
 *   3. tabtin_rich_content + kind 未知（dispatcher 内 fallback 路径）
 *
 * 设计意图：让客户端永远不崩。新协议块上线时，老客户端展示一句"此内容暂不
 * 支持，请在桌面端查看"+ summary 兜底，不影响主对话流。
 */

import React from 'react'
import { Box } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import {
  CARD_RADIUS,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
} from '../registry/chatDesignTokens'

interface FallbackBlockViewProps {
  /** block 原始类型 string（譬如 'code_artifact_v3'），仅 dev 调试用 */
  blockType?: string
  /** 可选 summary 文本（rich_content 子 kind 未知时来自 block.summary） */
  summary?: string
  /** 可选 error 文本（子 renderer 抛错时由 ErrorBoundary 注入） */
  error?: string
  /** dispatcher 路由时透传的 entry（兼容 BlockRendererProps 签名） */
  entry?: { block?: { type?: string; summary?: string } }
}

export const FallbackBlockView: React.FC<FallbackBlockViewProps> = React.memo(
  (props) => {
    const blockType = props.blockType ?? (props.entry?.block as { type?: string } | undefined)?.type
    const summary = props.summary ?? (props.entry?.block as { summary?: string } | undefined)?.summary
    const error = props.error
    const { t } = useTranslation('chat')
    return (
      <div
        className={cn(
          'my-1 border px-3 py-2',
          CARD_RADIUS,
          BORDER.subtle,
          BG.header,
        )}
        data-testid="block-fallback"
      >
        <div className={cn('flex items-center gap-1.5', TEXT.body, TEXT_COLOR.muted)}>
          <Box className={cn(ICON_SIZE.sm, 'flex-shrink-0')} />
          <span className="min-w-0 flex-1 break-words">
            {t('blockTimeline.fallback.unsupported', {
              defaultValue: '此内容暂不支持，请更新到最新版本查看',
            })}
          </span>
        </div>
        {summary && (
          <div className={cn('mt-1 pl-5', TEXT.body, TEXT_COLOR.secondary, 'whitespace-pre-wrap break-words')}>
            {summary}
          </div>
        )}
        {(blockType || error) && (
          <div className={cn('mt-1 pl-5', TEXT.meta, TEXT_COLOR.faint, 'font-mono')}>
            {blockType ? `type=${blockType}` : null}
            {blockType && error ? ' · ' : null}
            {error ?? null}
          </div>
        )}
      </div>
    )
  },
)
FallbackBlockView.displayName = 'FallbackBlockView'

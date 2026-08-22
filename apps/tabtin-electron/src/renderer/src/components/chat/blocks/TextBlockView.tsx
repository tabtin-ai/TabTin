/**
 * TextBlockView — text block 渲染。
 *
 * 设计：直接走 MarkdownRenderer。流式期间 block.text 已经走
 * `ensureClosedFences()` 收敛（W4a-L17），不需要本组件自己 fence。
 *
 * v2 §3.5.1.g：partial=true（被截断的 text）灰色斜线背景 + "…内容被截断"提示。
 *
 * **W4c · W4a-L12 partialReason 区分文案**：
 *   - `'stream_interrupted'` → "等待响应超时"（watchdog 兜底）
 *   - `'aborted'` → "已中断"（用户主动 cancel / lifecycle terminated）
 *   - `'message_stop_fallback'` / undefined → "…内容被截断"（兜底通用文案）
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TextBlock } from '@tabtin/agent-wire'
import { cn } from '@utils/cn'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import {
  CollapsibleMessage,
  MSG_COLLAPSE_CHAR_THRESHOLD,
  MSG_COLLAPSE_ENABLED,
} from '../message'
import { TEXT, TEXT_COLOR } from '../registry/chatDesignTokens'
import { ensureClosedFences } from '@/stores/chat/execution/markdownStreamUtils'
import { blockEntryEqual, partialReasonText, type BlockRendererProps } from './types'
import { useTypewriterText } from './useTypewriterText'

export const TextBlockView: React.FC<BlockRendererProps> = React.memo(({ entry, tabScopeKey, isStreaming, suppressPartialReason }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as TextBlock
  const fullText = block.text ?? ''
  // 平滑流式揭示（typewriter reveal）：delta chunk 不整块闪出，摊到后续帧
  // 逐字揭示（详见 useTypewriterText）。finalize 后恒为全量文本；
  // 用户停止（partialReason=aborted）冻结揭示，避免「已中断」后仍再打几个字。
  const revealActive = !entry.finalized
  const freezeReveal = entry.partialReason === 'aborted'
  const revealedText = useTypewriterText(fullText, revealActive, freezeReveal)
  // store 层的 ensureClosedFences 是对全量文本做的；揭示前缀可能瞬时切开
  // 代码围栏（``` 内被截断），这里对前缀再收敛一次，避免半个代码块按普通
  // 文本渲染的闪烁。finalize 后若仍在平滑排空尾部，同样需要补临时围栏。
  const content = useMemo(
    () => (revealedText.length < fullText.length
      ? ensureClosedFences(revealedText)
      : revealedText),
    [revealedText, fullText.length],
  )
  // 流式中不折叠（CollapsibleMessage 在 shouldCollapse false→true 时保持展开，
  // 刚生成完的长回复不会突然收起）；历史回放的长文本默认折叠。
  const liveStreaming = !!isStreaming && !entry.finalized
  const shouldCollapse =
    MSG_COLLAPSE_ENABLED
    && !liveStreaming
    && entry.finalized
    && fullText.length > MSG_COLLAPSE_CHAR_THRESHOLD
  // 流式期间用 lightweight=false 保留 markdown 完整能力（fence 已闭合）；
  // 历史回放也走 full markdown——TextBlockView 是 v2 §3.5.1.b 的一等公民。
  return (
    <div
      className={cn(
        // 正文上下留更大呼吸空间，与紧凑的工具卡 / 思考折叠栏拉开层次。
        'my-2.5 min-w-0 max-w-full break-words text-foreground [overflow-wrap:anywhere]',
      )}
      data-testid="block-text"
      data-streaming-text={liveStreaming ? 'true' : undefined}
    >
      <CollapsibleMessage
        messageId={entry.block_id}
        content={fullText}
        shouldCollapse={shouldCollapse}
      >
        {() => (
          <MarkdownRenderer
            content={content}
            tabScopeKey={tabScopeKey}
            lightweight={false}
            renderLevel={1}
            isStreaming={liveStreaming}
          />
        )}
      </CollapsibleMessage>
      {entry.partial && !suppressPartialReason && (
        <div className={cn('mt-1', TEXT.meta, TEXT_COLOR.faint, 'italic')}>
          {partialReasonText(entry.partialReason, t)}
        </div>
      )}
    </div>
  )
}, blockEntryEqual)
TextBlockView.displayName = 'TextBlockView'

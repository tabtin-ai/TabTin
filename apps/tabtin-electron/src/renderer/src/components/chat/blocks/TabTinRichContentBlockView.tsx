/**
 * TabTinRichContentBlockView — TabTin 扩展 + 富内容家族 dispatcher。
 *
 * 承载多种 block.type：
 *   - tabtin_rich_content（kind: image / table_preview / resource_ref / file /
 *     widget / cli_output_table / cli_output_record / search_results /
 *     memory_card / document_excerpt 等；历史 task_episode 走 RichFallback）
 *   - tabtin_skill_invocation（skill 注入卡片）
 *   - tabtin_source_ref（5 种 ref_kind 嵌套）
 *   - tabtin_approval_request（v2 §3.5.1.h 审批占位）
 *   - tabtin_composer_preset / tabtin_ask_user_fields（用户 echo 卡片）
 *   - container_upload / search_result（标准但稀有，简化渲染）
 *
 * **设计要点**：
 *   - tabtin_rich_content 通过 adapter 转成老 RichContentBlock 形态，复用现有
 *     RichImage / RichTablePreview / RichWidget / ... 组件——零侵入接通。
 *   - 未知 kind 走 RichFallback（v2 §3.5.5 第 3 条）。
 *   - skill_invocation 用 SkillInjectionInlineCard。
 *   - approval_request 用 RequestApprovalPanel（v2 §3.5.1.h 设计：审批占位
 *     视觉权重高，黄色 + 用户必须操作才能继续）。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Link2, ChevronDown, ChevronRight, Upload } from 'lucide-react'
import type { TabTinRichContentBlock, TabTinSkillInvocationBlock, TabTinSourceRefBlock, TabTinApprovalRequestBlock } from '@tabtin/agent-wire'
import type { RichContentBlock, RichContentKind, MessageBlock } from '@tabtin/chat-client'
import { cn } from '@utils/cn'
import {
  RichImage,
  RichTablePreview,
  RichResourceRef,
  RichFile,
  RichFallback,
  RichWidget,
  RichCliOutputTable,
  RichCliOutputRecord,
  RichSearchResults,
  RichMemoryCard,
  RichDocumentExcerpt,
} from '../richContent'
import { SkillInjectionInlineCard } from '../skill/SkillInjectionInlineCard'
import { PlanProposalCard, planMetadataFromRichBlock } from '../../plan-proposal/PlanProposalCard'
import { CARD_RADIUS, TEXT, TEXT_COLOR, BORDER, BG, ICON_SIZE } from '../registry/chatDesignTokens'
import { FallbackBlockView } from './FallbackBlockView'
import { blockEntryEqual, type BlockRendererProps } from './types'
import { wasMediaImageShown } from '../cards/mediaImageInlineShown'
import { isLegacyWebSearchResultsBlock } from '../../../stores/chat/domain/webSearchArtifactPolicy'

/**
 * Adapter: wire schema 的 TabTinRichContentBlock → 老 RichContentBlock。
 *
 * 字段映射：
 *   - type: 'tabtin_rich_content' → 'rich_content'（老前端期望）
 *   - kind + summary + group_id: 原样
 *   - payload.*: 全部展开到顶层（老 RichContentBlock 字段就是扁平的）
 *
 * 字段缺失时丢 RichFallback。
 */
function adaptToLegacyRichBlock(block: TabTinRichContentBlock): RichContentBlock | null {
  if (!block || typeof block !== 'object' || block.type !== 'tabtin_rich_content') return null
  const kind = block.kind
  const summary = block.summary ?? ''
  const groupId = block.group_id
  const payload = (block.payload && typeof block.payload === 'object') ? block.payload : {}
  const flat: MessageBlock = {
    type: 'rich_content',
    kind: kind as RichContentKind,
    summary,
    group_id: groupId,
    ...payload,
  } as MessageBlock
  return flat as RichContentBlock
}

const RichKindRouter: React.FC<{
  block: RichContentBlock
  sessionId: string | null
  tabScopeKey?: string | null
  messageId: string
  onResourceNavigate?: BlockRendererProps['onResourceNavigate']
  onResourceContextMenu?: BlockRendererProps['onResourceContextMenu']
}>
  = ({ block, sessionId, tabScopeKey, messageId, onResourceNavigate, onResourceContextMenu }) => {
    switch (block.kind) {
      case 'image':
        // CLI 生图内联卡已展示同 URL 时，抑制 present_to_user 重复图卡
        if (sessionId && typeof block.url === 'string' && wasMediaImageShown(sessionId, block.url)) {
          return null
        }
        return <RichImage block={block} messageId={messageId} sessionId={sessionId} />
      case 'table_preview':
        return <RichTablePreview block={block} />
      case 'resource_ref':
        return (
          <RichResourceRef
            block={block}
            tabScopeKey={tabScopeKey}
            onNavigate={onResourceNavigate}
            onContextMenuRequest={onResourceContextMenu}
          />
        )
      case 'file':
        return <RichFile block={block} tabScopeKey={tabScopeKey} />
      case 'widget':
        return <RichWidget block={block} sessionId={sessionId} messageId={messageId} />
      case 'cli_output_table':
        return <RichCliOutputTable block={block} />
      case 'cli_output_record':
        return <RichCliOutputRecord block={block} />
      case 'search_results':
        return <RichSearchResults block={block} />
      case 'memory_card':
        return <RichMemoryCard block={block} />
      case 'document_excerpt':
        return <RichDocumentExcerpt block={block} onResourceNavigate={onResourceNavigate} />
      case 'plan': {
        // ：plan 持久化 block（payload 已摊平到顶层）→ PlanProposalCard。
        const planMeta = planMetadataFromRichBlock(block as unknown as Record<string, unknown>)
        if (!planMeta) return <RichFallback block={block} />
        return <PlanProposalCard metadata={planMeta} sessionId={sessionId} messageId={messageId} />
      }
      default:
        // v2 §3.5.5 fallback 链第 3 条：未知 kind 走 RichFallback（显示 summary）
        return <RichFallback block={block} />
    }
  }
RichKindRouter.displayName = 'RichKindRouter'

const TabTinRichContentRouter: React.FC<{
  entry: BlockRendererProps['entry']
  sessionId: string | null
  tabScopeKey?: string | null
  messageId: string
  onResourceNavigate?: BlockRendererProps['onResourceNavigate']
  onResourceContextMenu?: BlockRendererProps['onResourceContextMenu']
}>
  = ({ entry, sessionId, tabScopeKey, messageId, onResourceNavigate, onResourceContextMenu }) => {
    const adapted = useMemo(() => adaptToLegacyRichBlock(entry.block as TabTinRichContentBlock), [entry.block])
    if (!adapted) {
      // adapter 失败兜底 — 不应发生但防御性写法
      const summary = (entry.block as { summary?: string })?.summary
      return <FallbackBlockView blockType={(entry.block as { type?: string })?.type} summary={summary} />
    }
    if (isLegacyWebSearchResultsBlock(adapted)) return null
    return (
      <div className="my-1" data-testid="block-rich-content">
        <RichKindRouter
          block={adapted}
          sessionId={sessionId}
          tabScopeKey={tabScopeKey}
          messageId={messageId}
          onResourceNavigate={onResourceNavigate}
          onResourceContextMenu={onResourceContextMenu}
        />
      </div>
    )
  }
TabTinRichContentRouter.displayName = 'TabTinRichContentRouter'

const SkillInvocationView: React.FC<{ entry: BlockRendererProps['entry'] }> = ({ entry }) => {
  const block = entry.block as TabTinSkillInvocationBlock
  const text = block.injected_text ?? block.injected_text_summary ?? ''
  return (
    <div className="my-1" data-testid="block-skill-invocation">
      <SkillInjectionInlineCard content={text} />
    </div>
  )
}
SkillInvocationView.displayName = 'SkillInvocationView'

const SourceRefView: React.FC<{ entry: BlockRendererProps['entry'] }> = ({ entry }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as TabTinSourceRefBlock
  const snapshot = block.snapshot
  const kind = block.ref_kind
  const title = (snapshot && 'title' in snapshot && snapshot.title)
    || (snapshot && 'url' in snapshot && snapshot.url)
    || (snapshot && 'doc_id' in snapshot && snapshot.doc_id)
    || (snapshot && 'table_id' in snapshot && snapshot.table_id)
    || (snapshot && 'file_path' in snapshot && snapshot.file_path)
    || (snapshot && 'memo_id' in snapshot && snapshot.memo_id)
    || t('blockTimeline.sourceRef.unknownTitle', { defaultValue: '引用源' })
  return (
    <div
      className={cn(
        'my-1 inline-flex items-center gap-1.5 max-w-full px-2.5 py-1 border',
        CARD_RADIUS,
        BORDER.subtle,
        BG.header,
      )}
      data-testid="block-source-ref"
    >
      <Link2 className={cn(ICON_SIZE.md, 'text-accent/80 flex-shrink-0')} />
      <span className={cn(TEXT.body, TEXT_COLOR.secondary, 'min-w-0 truncate')}>{String(title)}</span>
      <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'flex-shrink-0 font-mono')}>{kind}</span>
    </div>
  )
}
SourceRefView.displayName = 'SourceRefView'

const ApprovalRequestView: React.FC<{ entry: BlockRendererProps['entry'] }> = ({ entry }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as TabTinApprovalRequestBlock
  // approval_request 占位卡片（v2 §3.5.1.h）：黄色高权重背景 + prompt + 选项 chip。
  // 真正的审批交互由 RequestApprovalPanel（顶部独立组件）处理；本卡片仅作为
  // BlockTimeline 视觉占位让用户**看见**"对话在这里等待审批"。
  return (
    <div
      className={cn(
        'my-1.5 border px-3 py-2',
        CARD_RADIUS,
        BORDER.warning,
        'bg-warning/5',
      )}
      data-testid="block-approval-request"
    >
      <div className={cn('flex items-center gap-1.5', TEXT.body, 'text-warning')}>
        <Sparkles className={cn(ICON_SIZE.status, 'flex-shrink-0')} />
        <span className="font-medium">
          {t('blockTimeline.approvalRequest.title', { defaultValue: '需要您的审批' })}
        </span>
      </div>
      <p className={cn('mt-1 break-words', TEXT.body, TEXT_COLOR.secondary)}>{block.prompt}</p>
      {block.options && block.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {block.options.map((opt) => (
            <span
              key={opt.id}
              className={cn(
                'inline-flex items-center px-2 py-0.5 rounded border',
                BORDER.warning,
                'text-warning',
                TEXT.meta,
              )}
            >
              {opt.label}
            </span>
          ))}
        </div>
      )}
      <p className={cn('mt-1', TEXT.meta, TEXT_COLOR.muted)}>
        {t('blockTimeline.approvalRequest.howTo', {
          defaultValue: '请在上方审批面板中处理',
        })}
      </p>
    </div>
  )
}
ApprovalRequestView.displayName = 'ApprovalRequestView'

const ContainerUploadView: React.FC<{ entry: BlockRendererProps['entry'] }> = ({ entry }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as { type: 'container_upload'; file_id: string; container_id: string }
  return (
    <div
      className={cn(
        'my-1 inline-flex items-center gap-1.5 max-w-full px-2.5 py-1 border',
        CARD_RADIUS,
        BORDER.subtle,
        BG.header,
      )}
      data-testid="block-container-upload"
    >
      <Upload className={cn(ICON_SIZE.md, 'text-accent/80 flex-shrink-0')} />
      <span className={cn(TEXT.body, TEXT_COLOR.secondary)}>
        {t('blockTimeline.containerUpload.title', { defaultValue: '容器文件上传' })}
      </span>
      <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'font-mono')}>{block.file_id}</span>
    </div>
  )
}
ContainerUploadView.displayName = 'ContainerUploadView'

const ComposerPresetEchoView: React.FC<{ entry: BlockRendererProps['entry'] }> = ({ entry }) => {
  // tabtin_composer_preset / tabtin_ask_user_fields 是 user echo——
  // MessageBubble 在 user 分支已经渲染 ComposerPresetBlockCard，本组件
  // 在 assistant 分支不应出现。保险起见走 FallbackBlockView 兜底。
  const block = entry.block as { type?: string; summary?: string }
  return <FallbackBlockView blockType={block.type} summary={block.summary} />
}
ComposerPresetEchoView.displayName = 'ComposerPresetEchoView'

export const TabTinRichContentBlockView: React.FC<BlockRendererProps> = React.memo(
  ({ entry, sessionId, tabScopeKey, messageId, onResourceNavigate, onResourceContextMenu }) => {
    const blockType = (entry.block as { type?: string })?.type
    switch (blockType) {
      case 'tabtin_rich_content':
        return (
          <TabTinRichContentRouter
            entry={entry}
            sessionId={sessionId}
            tabScopeKey={tabScopeKey}
            messageId={messageId}
            onResourceNavigate={onResourceNavigate}
            onResourceContextMenu={onResourceContextMenu}
          />
        )
      case 'tabtin_skill_invocation':
        return <SkillInvocationView entry={entry} />
      case 'tabtin_source_ref':
        return <SourceRefView entry={entry} />
      case 'tabtin_approval_request':
        return <ApprovalRequestView entry={entry} />
      case 'container_upload':
        return <ContainerUploadView entry={entry} />
      case 'tabtin_composer_preset':
      case 'tabtin_ask_user_fields':
      case 'search_result':
        return <ComposerPresetEchoView entry={entry} />
      default:
        return <FallbackBlockView blockType={blockType} />
    }
  },
  blockEntryEqual,
)
TabTinRichContentBlockView.displayName = 'TabTinRichContentBlockView'

/**
 * HandoffCard — IM 上下文交接卡片。
 *
 * 卡片是交接包的展示面：metadata.card 只带 handoff_id + 快照，
 * 详情（四区块 / 接收者状态 / 材料鉴权结果）挂载后从 getHandoff 实时拉取，
 * IM 卡片投影版本变化时（useIMStore.handoffVersions 变化）自动重拉。
 *
 * 接收者：「由我继续」先走 take_over 状态机，成功后弹执行目标向导
 * （选 Agent × Workspace）→ 服务端把冻结快照物化成接收人自己的新会话并进入
 * （，替代旧的「草稿注入」链路）；已接手再点直接开向导（端点幂等）。
 * scope=view_only 的交接不提供「由我继续」，只留查看类交互。
 * 发起人可撤销。材料行只负责查看（会话快照 / 跳原消息 / 打开文档表格）。
 * 无权 / 已删除 / 已撤销显示结构化占位（不静默消失）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRightLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquareQuote,
  MessagesSquare,
  Paperclip,
  Table2,
  Undo2,
  UserCheck,
  XCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useUserProfileCache, useDisplayName } from '@stores/useUserProfileCache'
import {
  actOnHandoff,
  getHandoff,
  revokeHandoff,
  type HandoffAction,
  type HandoffPackage,
  type HandoffRecipientInfo,
  type HandoffReferenceInfo,
} from '@/services/tabchatApi'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openIMResourceFromChat } from './IMResourceCard'
import { markdownComponents } from './imMarkdownComponents'
import { openOssFilePreviewById } from '../chat/preview/openOssFilePreview'
import { ExecutionTargetWizard } from '../chat/shared-view/ExecutionTargetWizard'
import { takeOverHandoffSession } from '@/services/handoffTakeOverApi'
import { enterChatSession } from '@/services/chatSessionNavigation'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'

const log = createLogger('HandoffCard')

interface Props {
  handoffId: string
  conversationId: string
  /** metadata.card 快照，详情加载前的骨架内容 */
  goalSnapshot?: string
  initiatorType?: 'user' | 'agent'
  initiatorId?: string
}

// ─── 子组件 ──────────────────────────────────────────────────────

const RecipientName: React.FC<{ userId: string }> = ({ userId }) => {
  const name = useDisplayName(userId)
  return <>{name || userId.slice(0, 8)}</>
}

const RECIPIENT_STATE_LABELS: Record<string, { key: string; defaultValue: string }> = {
  sent: { key: 'handoffStateSent', defaultValue: '未查看' },
  viewed: { key: 'handoffStateViewed', defaultValue: '已查看' },
  acknowledged: { key: 'handoffStateAcknowledged', defaultValue: '已了解' },
  taking_over: { key: 'handoffStateTakingOver', defaultValue: '由 TA 继续' },
  delegated_to_agent: { key: 'handoffStateDelegated', defaultValue: '已交给 Agent' },
  rejected: { key: 'handoffStateRejected', defaultValue: '已拒绝' },
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1048576).toFixed(1)} MB`
}

function ReferenceRow({
  reference,
  conversationId,
  revoked,
  initiatorName,
}: {
  reference: HandoffReferenceInfo
  conversationId: string
  revoked: boolean
  initiatorName?: string
}) {
  const { t } = useTranslation('tabchat')
  const disabled = !reference.accessible || revoked
  const [transcriptOpen, setTranscriptOpen] = useState(false)

  const deniedLabel = useMemo(() => {
    if (revoked || reference.denied_reason === 'revoked') {
      return t('handoffRefRevoked', { defaultValue: '交接已撤销' })
    }
    if (reference.denied_reason === 'deleted') {
      return t('handoffRefDeleted', { defaultValue: '内容已删除' })
    }
    if (reference.denied_reason === 'access_denied') {
      return t('handoffRefNoAccess', { defaultValue: '无权访问' })
    }
    if (reference.denied_reason === 'error') {
      return t('handoffRefError', { defaultValue: '暂时无法访问' })
    }
    return null
  }, [reference.denied_reason, revoked, t])

  const handleOpen = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
    if (disabled) return
    if (reference.ref_type === 'chat_session') {
      // 只读看冻结快照；接手续聊走底部「由我继续」
      setTranscriptOpen(true)
      return
    }
    if (reference.ref_type === 'im_message') {
      const messageId = reference.source_link.message_id
      const convId = reference.source_link.conversation_id ?? conversationId
      if (messageId != null) {
        useIMStore.getState().navigateToMessage(convId, messageId)
      }
      return
    }
    if (reference.ref_type === 'document' || reference.ref_type === 'table') {
      void openIMResourceFromChat(
        {
          resourceType: reference.ref_type,
          resourceId: reference.resource_id,
          name: reference.title,
          spaceId: reference.source_link.space_id,
          organizationId: reference.source_link.organization_id,
        },
        t,
      )
    }
  }, [disabled, reference, conversationId, t])

  const Icon = reference.ref_type === 'table'
    ? Table2
    : reference.ref_type === 'document'
      ? FileText
      : reference.ref_type === 'chat_session'
        ? MessagesSquare
        : MessageSquareQuote

  const label = reference.title
    || reference.summary
    || (reference.ref_type === 'chat_session'
      ? t('handoffRefSession', { defaultValue: 'Agent 会话记录' })
      : t('handoffRefMessage', { defaultValue: '会话消息' }))

  // 材料行只有会话标题时，接收人看不出里面带附件——数一下冻结快照里的附件给提示。
  const attachmentCount = useMemo(() => {
    const turns = reference.frozen_snapshot?.turns ?? []
    return turns.reduce((sum, turn) => sum + (turn.attachments?.length ?? 0), 0)
  }, [reference.frozen_snapshot])

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={cn(
          'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
          disabled
            ? 'cursor-default bg-muted/20 opacity-60'
            : 'bg-muted/25 hover:bg-muted/45',
        )}
      >
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
            disabled ? 'bg-muted/40 text-muted-foreground' : 'bg-background/80 text-accent',
          )}
        >
          {disabled ? <Ban className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-body text-foreground/90">{label}</span>
        {attachmentCount > 0 && !deniedLabel && (
          <span className="flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground">
            <Paperclip className="h-3 w-3" />
            {attachmentCount}
          </span>
        )}
        {deniedLabel ? (
          <span className="shrink-0 text-caption text-muted-foreground">{deniedLabel}</span>
        ) : !disabled ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground" />
        ) : null}
      </button>

      {reference.ref_type === 'chat_session' && (
        <TranscriptViewer
          open={transcriptOpen}
          onOpenChange={setTranscriptOpen}
          reference={reference}
          initiatorName={initiatorName}
        />
      )}
    </>
  )
}

/** 冻结快照附件点击：按 file_id 换新鲜 access_url 后应用内预览（快照里的 url 会过期）。 */
function openFrozenAttachment(
  fileId: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<void> {
  if (!fileId) return Promise.resolve()
  return openOssFilePreviewById(fileId, {
    unsupported: t('handoffAttachmentPreviewUnsupported', { defaultValue: '暂不支持预览此类型文件' }),
    unavailable: t('handoffAttachmentUnavailable', { defaultValue: '附件暂时无法访问' }),
  })
}

/**
 * 只读会话记录查看器：展示冻结的清洗版 Agent 会话历史。
 *
 * 关闭时必须整棵卸载 Dialog（见 NewAgentButton）：若只靠 Radix Presence 退场，
 * 在 Space OverlayContainer / Activity 场景下可能卡成幽灵遮罩，导致材料只能点开一次。
 */
function TranscriptViewer({
  open,
  onOpenChange,
  reference,
  initiatorName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reference: HandoffReferenceInfo
  initiatorName?: string
}) {
  const { t } = useTranslation('tabchat')
  const snapshot = reference.frozen_snapshot
  const turns = snapshot?.turns ?? []

  if (!open) return null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        container={null}
        className="flex w-[520px] max-w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2.5 border-b border-border/40 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/40 text-accent">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-subtitle font-medium">
              {snapshot?.title || t('handoffRefSession', { defaultValue: 'Agent 会话记录' })}
            </DialogTitle>
            <p className="text-caption text-muted-foreground">
              {t('handoffTranscriptHint', { defaultValue: '交接时的只读快照，不含思考过程与工具参数' })}
            </p>
          </div>
        </div>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-4">
          {turns.length === 0 ? (
            <p className="text-body text-muted-foreground">
              {t('handoffTranscriptEmpty', { defaultValue: '没有可显示的会话内容。' })}
            </p>
          ) : (
            turns.map((turn, i) => {
              const isUser = turn.role === 'user'
              return (
                <div key={i} className="space-y-1.5">
                  <div className="text-caption font-medium text-muted-foreground">
                    {isUser
                      ? (initiatorName || t('forwardSessionRoleUser', { defaultValue: '我' }))
                      : t('forwardSessionRoleAI', { defaultValue: 'AI' })}
                  </div>
                  {(turn.text || turn.tools.length > 0 || turn.attachments.length > 0) && (
                    <div
                      className={cn(
                        'rounded-xl px-3 py-2.5',
                        isUser ? 'bg-muted/35' : 'bg-accent/8',
                      )}
                    >
                      {turn.text && (
                        <div className="prose-sm max-w-none text-body text-foreground/90">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {turn.text}
                          </ReactMarkdown>
                        </div>
                      )}
                      {turn.tools.length > 0 && (
                        <div className={cn('flex flex-wrap gap-1', turn.text && 'mt-2')}>
                          {turn.tools.map((tool, j) => (
                            <span
                              key={j}
                              className="rounded-md bg-background/70 px-2 py-0.5 text-caption text-muted-foreground"
                            >
                              {tool.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {turn.attachments.length > 0 && (
                        <div className={cn('space-y-1.5', (turn.text || turn.tools.length > 0) && 'mt-2')}>
                          {turn.attachments.map((att, j) =>
                            typeof att === 'string' ? (
                              <div key={j} className="text-caption text-muted-foreground/80">{att}</div>
                            ) : (
                              <button
                                key={j}
                                type="button"
                                disabled={!att.file_id}
                                onClick={() => { void openFrozenAttachment(att.file_id, t) }}
                                className={cn(
                                  'flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2 text-left transition-colors',
                                  att.file_id
                                    ? 'hover:bg-background'
                                    : 'cursor-default opacity-60',
                                )}
                              >
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-caption font-medium text-foreground/90">
                                    {att.filename}
                                  </div>
                                  {att.size > 0 && (
                                    <div className="text-caption text-muted-foreground/70">
                                      {formatFileSize(att.size)}
                                    </div>
                                  )}
                                </div>
                                {att.file_id && (
                                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                                )}
                              </button>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
          {snapshot?.truncated && (
            <p className="text-caption text-muted-foreground/80">
              {t('handoffTranscriptTruncated', { defaultValue: '（会话较长，仅展示前一部分）' })}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── 主组件 ──────────────────────────────────────────────────────

export const HandoffCard: React.FC<Props> = ({
  handoffId,
  conversationId,
  goalSnapshot,
  initiatorType,
  initiatorId,
}) => {
  const { t } = useTranslation('tabchat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const version = useIMStore((s) => s.handoffVersions[handoffId] ?? 0)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)

  const [detail, setDetail] = useState<HandoffPackage | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [acting, setActing] = useState<HandoffAction | 'revoke' | null>(null)
  // ：take_over 成功后弹执行目标向导（选 Agent × Workspace → 服务端建会话）
  const [takeOverWizardOpen, setTakeOverWizardOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    getHandoff(handoffId)
      .then((pkg) => {
        if (cancelled) return
        setDetail(pkg)
        setLoadFailed(false)
      })
      .catch((err) => {
        if (cancelled) return
        log.warn('load handoff detail failed', { handoffId, err })
        setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [handoffId, version])

  // 预热发起人 + 接收者昵称
  useEffect(() => {
    const ids = new Set<string>()
    const packageInitiator = detail?.initiator_user_id ?? (initiatorType === 'user' ? initiatorId : null)
    if (packageInitiator) ids.add(packageInitiator)
    detail?.recipients.forEach((r) => {
      if (r.user_id) ids.add(r.user_id)
    })
    if (ids.size > 0) ensureProfiles([...ids])
  }, [detail, initiatorId, initiatorType, ensureProfiles])

  const effectiveInitiatorType = detail?.initiator_type ?? initiatorType ?? 'user'
  const initiatorUserId = detail?.initiator_user_id ?? (effectiveInitiatorType === 'user' ? initiatorId : null)
  const initiatorName = useDisplayName(initiatorUserId ?? '')

  const isInitiator = !!currentUserId && initiatorUserId === currentUserId
  const myRecipient: HandoffRecipientInfo | undefined = detail?.recipients.find(
    (r) => r.user_id === currentUserId,
  )
  const revoked = detail?.status === 'revoked'
  const goal = detail?.goal ?? goalSnapshot ?? ''

  const runAction = useCallback(
    async (action: HandoffAction) => {
      if (acting) return
      setActing(action)
      try {
        const updated = await actOnHandoff(handoffId, action)
        setDetail(updated)
        if (action === 'take_over') {
          // ：状态机落定后进入执行目标向导，由服务端物化接手会话
          setTakeOverWizardOpen(true)
        }
      } catch (err) {
        log.warn('handoff action failed', { handoffId, action, err })
        toast({
          title: t('handoffActionFailed', { defaultValue: '操作失败' }),
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        })
      } finally {
        setActing(null)
      }
    },
    [acting, handoffId, t],
  )

  const runRevoke = useCallback(async () => {
    if (acting) return
    setActing('revoke')
    try {
      const updated = await revokeHandoff(handoffId)
      setDetail(updated)
    } catch (err) {
      log.warn('handoff revoke failed', { handoffId, err })
      toast({
        title: t('handoffActionFailed', { defaultValue: '操作失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setActing(null)
    }
  }, [acting, handoffId, t])

  // 接收者可用动作（转发场景：不在 recipients 列表但详情加载成功，视为新接收者可操作）
  const isNewRecipient = !!detail && !isInitiator && !myRecipient
  // scope=view_only：只留查看类交互，不提供「由我继续」
  const isViewOnly = detail?.scope === 'view_only'
  const canTakeOver = !revoked && !isViewOnly && (
    (!!myRecipient && ['sent', 'viewed', 'acknowledged'].includes(myRecipient.state))
    || isNewRecipient
  )
  // 已接手后按钮仍保留：再点直接开向导（take-over-session 幂等返回既有会话）
  const alreadyTookOver = !revoked && !isViewOnly && myRecipient?.state === 'taking_over'
  const showContinue = canTakeOver || alreadyTookOver

  const handleContinue = useCallback(async () => {
    if (acting) return
    if (canTakeOver) {
      await runAction('take_over')
      return
    }
    if (alreadyTookOver) {
      setTakeOverWizardOpen(true)
    }
  }, [acting, alreadyTookOver, canTakeOver, runAction])

  /** 向导确认：服务端物化接手会话（幂等）→ 收起 IM → 进入新会话。 */
  const handleTakeOverConfirm = useCallback(async (agentId: string, workspaceId: string) => {
    const session = await takeOverHandoffSession(handoffId, { agentId, workspaceId })
    setTakeOverWizardOpen(false)
    useIMStore.getState().closeIM()
    const hostSpaceId = session.space_id ?? session.workspace_id ?? workspaceId
    await enterChatSession(hostSpaceId, session.id, {
      organizationId: session.organization_id,
    })
    toast({ title: t('handoffTakeOverSessionCreated', { defaultValue: '已接手，进入任务会话' }) })
  }, [handoffId, t])

  const renderChecklist = (
    items: Array<{ text: string; checked?: boolean; high_risk?: boolean }> | undefined,
    titleKey: string,
    titleDefault: string,
    variant: 'progress' | 'next' | 'risk',
  ) => {
    if (!items || items.length === 0) return null
    return (
      <div className="space-y-1.5">
        <div className="text-caption font-medium text-muted-foreground">
          {t(titleKey, { defaultValue: titleDefault })}
        </div>
        <ul className="space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-body text-foreground/90">
              {variant === 'next' ? (
                <Check
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    item.checked ? 'text-emerald-500' : 'text-muted-foreground/40',
                  )}
                />
              ) : (
                <span
                  className={cn(
                    'mt-2 h-1 w-1 shrink-0 rounded-full',
                    variant === 'risk' && item.high_risk ? 'bg-red-500' : 'bg-muted-foreground/50',
                  )}
                />
              )}
              <span className={variant === 'risk' && item.high_risk ? 'text-red-600 dark:text-red-400' : ''}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const showRevoke = Boolean(detail && !revoked && isInitiator && detail.status === 'sent')
  const showActions = Boolean(detail && !revoked && (showContinue || showRevoke))

  return (
    <div className="w-[320px] max-w-full overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      {/* 头部：类型 + 状态 */}
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-accent">
          <ArrowRightLeft className="h-3.5 w-3.5" />
          {t('handoffCardTitle', { defaultValue: '上下文交接' })}
        </span>
        {effectiveInitiatorType === 'agent' && (
          <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-caption text-muted-foreground">
            {t('handoffFromAgent', { defaultValue: 'Agent 发起' })}
          </span>
        )}
        {isViewOnly && (
          <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-caption text-muted-foreground">
            {t('handoffScopeViewOnlyBadge', { defaultValue: '仅供查看' })}
          </span>
        )}
        <span className="flex-1" />
        {revoked && (
          <span className="text-caption text-muted-foreground">
            {t('handoffRevoked', { defaultValue: '已撤销' })}
          </span>
        )}
      </div>

      {/* 目标 */}
      <div className={cn('space-y-1 px-3.5 pb-3 pt-2', revoked && 'opacity-60')}>
        <div className="text-subtitle font-semibold leading-snug text-foreground">{goal}</div>
        {initiatorName && (
          <div className="text-caption text-muted-foreground">
            {t('handoffInitiator', { defaultValue: '发起人' })} · {initiatorName}
          </div>
        )}
      </div>

      {loadFailed && (
        <div className="px-3.5 pb-3 text-caption text-muted-foreground">
          {t('handoffLoadFailed', { defaultValue: '交接详情加载失败' })}
        </div>
      )}

      {detail && !revoked && (
        <div className="space-y-3 border-t border-border/40 px-3.5 py-3">
          {renderChecklist(detail.progress, 'handoffProgress', '当前进展', 'progress')}
          {renderChecklist(detail.next_steps, 'handoffNextSteps', '下一步', 'next')}
          {renderChecklist(detail.risks, 'handoffRisks', '待确认 / 风险', 'risk')}

          {detail.references && detail.references.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-caption font-medium text-muted-foreground">
                {t('handoffMaterials', { defaultValue: '相关材料' })}
              </div>
              <div className="space-y-1">
                {detail.references.map((ref) => (
                  <ReferenceRow
                    key={ref.id}
                    reference={ref}
                    conversationId={conversationId}
                    revoked={revoked}
                    initiatorName={isInitiator ? undefined : initiatorName}
                  />
                ))}
              </div>
            </div>
          )}

          {detail.recipients.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-caption font-medium text-muted-foreground">
                {t('handoffRecipients', { defaultValue: '接收者' })}
              </div>
              <div className="space-y-1">
                {detail.recipients.map((r) => {
                  const stateMeta = RECIPIENT_STATE_LABELS[r.state] ?? RECIPIENT_STATE_LABELS.sent
                  return (
                    <div
                      key={r.user_id ?? r.agent_id ?? ''}
                      className="flex items-center gap-2 text-body"
                    >
                      {r.state === 'taking_over' ? (
                        <UserCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : r.state === 'rejected' ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                      ) : r.state === 'acknowledged' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/35" />
                      )}
                      <span className="min-w-0 truncate text-foreground/90">
                        {r.user_id ? <RecipientName userId={r.user_id} /> : r.agent_id}
                      </span>
                      <span className="shrink-0 text-caption text-muted-foreground">
                        {t(stateMeta.key, { defaultValue: stateMeta.defaultValue })}
                      </span>
                      {r.note && (
                        <span className="min-w-0 truncate text-caption text-muted-foreground">
                          — {r.note}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {showActions && (
        <div className="flex items-center gap-1.5 border-t border-border/40 px-3.5 py-2">
          {showContinue && (
            <button
              type="button"
              disabled={!!acting}
              onClick={() => { void handleContinue() }}
              className="flex items-center gap-1 rounded-interactive bg-accent px-2.5 py-1.5 text-body font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {acting === 'take_over' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('handoffActionTakeOver', { defaultValue: '由我继续' })}
            </button>
          )}
          <span className="flex-1" />
          {showRevoke && (
            <button
              type="button"
              disabled={!!acting}
              onClick={runRevoke}
              className="flex items-center gap-1 rounded-interactive px-2 py-1.5 text-body text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              {acting === 'revoke' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Undo2 className="h-3.5 w-3.5" />
              )}
              {t('handoffActionRevoke', { defaultValue: '撤销' })}
            </button>
          )}
        </div>
      )}

      {/* ：接手执行目标向导（take-over-session 幂等，重复确认返回既有会话） */}
      <ExecutionTargetWizard
        open={takeOverWizardOpen}
        onOpenChange={setTakeOverWizardOpen}
        title={t('handoffTakeOverWizardTitle', { defaultValue: '接手交接任务' })}
        onConfirm={handleTakeOverConfirm}
      />
    </div>
  )
}

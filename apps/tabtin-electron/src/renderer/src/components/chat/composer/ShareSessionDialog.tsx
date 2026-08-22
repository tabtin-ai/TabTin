/**
 * ShareSessionDialog — 让同事进入当前任务，或冻结上下文后转交继续。
 *
 * 参与会授予原任务权限；转交只创建接收方独立任务，不授予原任务权限。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Search,
  Share2,
  Users,
  X,
} from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  toast,
} from '@components/ui'
import type { ChatSession } from '@tabtin/chat-client'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  createSessionContinuation,
  searchOrganizationMembers,
  type SearchMemberResult,
} from '@/services/tabchatApi'
import { createSessionShareFromChat } from '@/services/sessionShareApi'
import { useIMStore } from '@stores/useIMStore'
import { ColorAvatar } from '@components/tabchat/ColorAvatar'
import { resolveCurrentAgentDisplay } from '@components/chat/model/resolveAgentDisplayName'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META } from '../registry/chatDesignTokens'
import {
  SessionShareModeField,
  shareTierToFlags,
  type ShareTierLevel,
  type SessionShareMode,
} from '@components/tabchat/sessionSharePresentation'
import {
  buildSessionShareIntentKey,
  forgetPendingShareIntent,
  rememberPendingShareIntent,
  resolvePendingShareClientRequestId,
} from '@components/tabchat/sessionSharePendingIntent'

const log = createLogger('ShareSessionDialog')

const MEMBER_ROW_CLASS = cn(
  'flex w-full min-w-0 items-center gap-2.5 rounded-interactive px-2.5 py-2 text-left transition-colors',
)

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  /** 优先从该 Space 的会话缓存解析任务标题 / Agent；缺省时全库扫描 */
  spaceId?: string | null
}

type ShareIntent = 'participate' | 'continue'

const SESSION_STATUS_LABELS: Record<string, { key: string; defaultValue: string }> = {
  active: { key: 'shareSession.statusActive', defaultValue: '进行中' },
  archived: { key: 'shareSession.statusArchived', defaultValue: '已归档' },
  completed: { key: 'shareSession.statusCompleted', defaultValue: '已完成' },
}

function memberLabel(member: SearchMemberResult, fallback: string): string {
  return member.nickname || member.username || fallback
}

function findSessionInCache(sessionId: string, spaceId?: string | null): ChatSession | undefined {
  const store = useChatStore.getState()
  if (spaceId) {
    return store.sessionsBySpaceId[spaceId]?.find((session) => session.id === sessionId)
  }
  for (const sessions of Object.values(store.sessionsBySpaceId)) {
    const found = sessions?.find((session) => session.id === sessionId)
    if (found) return found
  }
  return undefined
}

interface ShareSessionContextBarProps {
  title: string
  agentName: string | null
  statusLabel: string | null
}

const ShareSessionContextBar: React.FC<ShareSessionContextBarProps> = ({
  title,
  agentName,
  statusLabel,
}) => {
  const { t } = useTranslation('chat')
  const meta = [agentName, statusLabel].filter(Boolean).join(' · ')

  return (
    <div className="rounded-lg bg-muted/25 px-3 py-2.5">
      <div className="truncate text-body font-medium text-foreground" title={title}>
        {title || t('shareSession.untitledTask', { defaultValue: '未命名任务' })}
      </div>
      {meta ? (
        <div className="mt-0.5 truncate text-caption text-muted-foreground">{meta}</div>
      ) : null}
    </div>
  )
}

interface MemberPickerEmptyProps {
  organizationId: string
  loading: boolean
  query: string
}

const MemberPickerEmpty: React.FC<MemberPickerEmptyProps> = ({
  organizationId,
  loading,
  query,
}) => {
  const { t } = useTranslation('chat')

  if (!organizationId) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
        <Users className="h-7 w-7 text-muted-foreground/30" aria-hidden />
        <p className="text-body text-muted-foreground">
          {t('shareSession.noOrg', { defaultValue: '请先选择组织' })}
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="text-body">
          {query.trim()
            ? t('shareSession.searching', { defaultValue: '搜索中…' })
            : t('shareSession.loading', { defaultValue: '加载中…' })}
        </span>
      </div>
    )
  }

  if (query.trim()) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
        <Search className="h-7 w-7 text-muted-foreground/30" aria-hidden />
        <p className="text-body text-muted-foreground">
          {t('shareSession.searchEmpty', {
            query: query.trim(),
            defaultValue: `没有匹配「${query.trim()}」的同事`,
          })}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
      <Users className="h-7 w-7 text-muted-foreground/30" aria-hidden />
      <p className="text-body text-muted-foreground">
        {t('shareSession.membersEmpty', { defaultValue: '组织里暂无其他成员' })}
      </p>
      <p className={cn(COMPOSER_TEXT_META, 'max-w-[240px]')}>
        {t('shareSession.membersEmptyHint', {
          defaultValue: '共享会发到你与对方的私聊，并附带任务卡片。',
        })}
      </p>
    </div>
  )
}

export const ShareSessionDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  sessionId,
  spaceId,
}) => {
  const { t } = useTranslation('chat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? '')
  const agentCache = useSpaceStore((s) => s.agentCache)
  const selectedAgent = useSpaceStore((s) => s.selectedAgent)

  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<SearchMemberResult[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [selected, setSelected] = useState<SearchMemberResult | null>(null)
  const [intent, setIntent] = useState<ShareIntent>('participate')
  const [tier, setTier] = useState<ShareTierLevel>('view')
  const [submitting, setSubmitting] = useState(false)
  const pendingShareIntentRef = useRef<{
    key: string
    clientRequestId: string
  } | null>(null)

  const sessionContext = useMemo(() => {
    if (!open) return null
    const session = findSessionInCache(sessionId, spaceId)
    const agentDisplay = resolveCurrentAgentDisplay({
      sessionAgentId: session?.agent_id,
      selectedAgent,
      agentCache,
    })
    const statusMeta = session?.status ? SESSION_STATUS_LABELS[session.status] : undefined
    return {
      title: session?.title?.trim() || '',
      agentName: agentDisplay?.displayName ?? null,
      statusLabel: statusMeta
        ? t(statusMeta.key, { defaultValue: statusMeta.defaultValue })
        : null,
    }
  }, [open, sessionId, spaceId, agentCache, selectedAgent, t])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(null)
    setIntent('participate')
    setTier('view')
  }, [open])

  useEffect(() => {
    if (!open || !organizationId || selected) {
      if (selected) setMembers([])
      return
    }
    let cancelled = false
    setMembers([])
    setMembersLoading(true)
    searchOrganizationMembers(organizationId, query)
      .then((res) => {
        if (cancelled) return
        setMembers((res ?? []).filter((member) => member.id && member.id !== currentUserId))
      })
      .catch((err) => {
        if (cancelled) return
        log.warn('load contacts failed', { err })
        toast({
          title: t('shareSession.contactsLoadFailed', { defaultValue: '加载成员失败' }),
          variant: 'destructive',
        })
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, organizationId, query, selected, currentUserId, t])

  const canSubmit = Boolean(selected && !submitting && organizationId)

  const selectedName = selected
    ? memberLabel(selected, t('shareSession.memberFallback', { defaultValue: '同事' }))
    : ''
  const submitLabel = selected
    ? intent === 'continue'
      ? t('shareSession.continueSubmitTo', {
        name: selectedName,
        defaultValue: `交给 ${selectedName}`,
      })
      : t('shareSession.submitTo', {
        name: selectedName,
        defaultValue: `发给 ${selectedName}`,
      })
    : t('shareSession.submitPickRecipient', { defaultValue: '选择同事' })

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selected) return
    const intentKey = buildSessionShareIntentKey({
      organizationId,
      sessionId,
      granteeUserId: selected.id,
      tier: intent === 'continue' ? 'continuation' : tier,
    })
    const clientRequestId = resolvePendingShareClientRequestId({
      intentKey,
      memoryIntent: pendingShareIntentRef.current,
    })
    pendingShareIntentRef.current = { key: intentKey, clientRequestId }
    rememberPendingShareIntent(intentKey, clientRequestId)
    setSubmitting(true)
    try {
      if (intent === 'continue') {
        const continuation = await createSessionContinuation({
          sourceSessionId: sessionId,
          recipientUserId: selected.id,
          clientRequestId,
        })
        useIMStore.getState().setSessionContinuation(continuation)
        forgetPendingShareIntent(intentKey)
        pendingShareIntentRef.current = null
        toast({
          title: t('shareSession.continueSuccess', { defaultValue: '已发送工作转交' }),
        })
        onOpenChange(false)
        return
      }
      const flags = shareTierToFlags(tier)
      const created = await createSessionShareFromChat({
        session_id: sessionId,
        grantee_user_id: selected.id,
        can_fork: flags.canFork,
        can_chat: flags.canChat,
        client_request_id: clientRequestId,
      })
      if (created.conversation_id) {
        useIMStore.getState().bumpSessionShareListVersion(created.conversation_id)
      }
      if (created.id) {
        const imState = useIMStore.getState()
        imState.patchSessionShare(created.id, {
          session_id: created.session_id,
          session_title: created.session_title,
          owner_user_id: created.owner_user_id,
          grantee_user_id: created.grantee_user_id,
          can_fork: created.can_fork,
          can_chat: created.can_chat,
          status: created.status,
          forked_session_id: created.forked_session_id,
          created_at: created.created_at,
          revoked_at: created.revoked_at,
          conversation_id: created.conversation_id,
        })
        imState.bumpSessionShareDetailVersion(created.id)
      }
      forgetPendingShareIntent(intentKey)
      pendingShareIntentRef.current = null
      toast({ title: t('shareSession.success', { defaultValue: '已共享并发送到私聊' }) })
      onOpenChange(false)
    } catch (err) {
      log.warn('share session failed', { sessionId, clientRequestId, err })
      toast({
        title: t('shareSession.failed', { defaultValue: '共享失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [
    canSubmit,
    intent,
    onOpenChange,
    organizationId,
    selected,
    sessionId,
    t,
    tier,
  ])

  const mode: SessionShareMode = intent === 'continue' ? 'continue' : tier

  const handleModeChange = useCallback((next: SessionShareMode) => {
    if (next === 'continue') {
      setIntent('continue')
      return
    }
    setIntent('participate')
    setTier(next)
  }, [])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent className="w-[440px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Share2 className="h-4 w-4 text-accent" aria-hidden />
          <DialogTitle className="text-body font-medium">
            {t('shareSession.dialogTitle', { defaultValue: '共享任务' })}
          </DialogTitle>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
          {sessionContext ? (
            <ShareSessionContextBar
              title={sessionContext.title}
              agentName={sessionContext.agentName}
              statusLabel={sessionContext.statusLabel}
            />
          ) : null}

          <section className="space-y-2">
            <span className="block text-body font-medium text-foreground">
              {t('shareSession.recipientLabel', { defaultValue: '发给' })}
            </span>

            {selected ? (
              <div className="flex items-center gap-2.5 rounded-interactive bg-foreground/[0.04] px-3 py-2 dark:bg-foreground/[0.06]">
                <ColorAvatar
                  name={memberLabel(selected, t('shareSession.memberFallback', { defaultValue: '同事' }))}
                  seed={selected.id}
                  imageUrl={selected.avatar || undefined}
                  className="h-8 w-8"
                  fallbackClassName="text-caption"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium text-foreground">
                    {memberLabel(selected, t('shareSession.memberFallback', { defaultValue: '同事' }))}
                  </div>
                  {selected.username ? (
                    <div className="truncate text-caption text-muted-foreground">
                      @{selected.username}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={submitting}
                  aria-label={t('shareSession.clearRecipient', { defaultValue: '重新选择' })}
                  onClick={() => setSelected(null)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
                    aria-hidden
                  />
                  <input
                    value={query}
                    disabled={submitting}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('shareSession.searchMembers', { defaultValue: '搜索同事' })}
                    className="h-9 w-full rounded-interactive bg-muted/30 pl-8 pr-3 text-body outline-none placeholder:text-muted-foreground/60 focus:bg-muted/45"
                    autoFocus
                  />
                </div>
                <div className="max-h-44 overflow-y-auto rounded-interactive bg-muted/15">
                  {members.length === 0 ? (
                    <MemberPickerEmpty
                      organizationId={organizationId}
                      loading={membersLoading}
                      query={query}
                    />
                  ) : (
                    members.map((member) => {
                      const label = memberLabel(
                        member,
                        t('shareSession.memberFallback', { defaultValue: '同事' }),
                      )
                      return (
                        <button
                          key={member.id}
                          type="button"
                          disabled={submitting}
                          onClick={() => setSelected(member)}
                          className={cn(
                            MEMBER_ROW_CLASS,
                            'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                          )}
                        >
                          <ColorAvatar
                            name={label}
                            seed={member.id}
                            imageUrl={member.avatar || undefined}
                            className="h-8 w-8"
                            fallbackClassName="text-caption"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-body text-foreground">{label}</div>
                            {member.username ? (
                              <div className="truncate text-caption text-muted-foreground">
                                @{member.username}
                              </div>
                            ) : null}
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </>
            )}
          </section>

          <SessionShareModeField
            value={mode}
            disabled={submitting}
            onChange={handleModeChange}
          />
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('shareSession.cancel', { defaultValue: '取消' })}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * SessionSharePickerDialog — 选一个自己的任务，邀请当前 DM 对端参与或接手。
 *
 * 多 Workspace：左栏选「最近 / 现场」，右栏列任务；单 Workspace 保持单栏。
 * 已共享用户以行内头像堆展示。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MessagesSquare, Search, Share2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  toast,
} from '@components/ui'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import {
  createSessionContinuation,
  createSessionShare,
  listSessionSharesBySession,
  type SessionShareInfo,
} from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'
import {
  SessionShareModeField,
  clampToSelectableShareTier,
  resolveShareTierLevel,
  shareTierToFlags,
  type ShareTierLevel,
  type SessionShareMode,
} from './sessionSharePresentation'
import { ShareSessionPickerNav } from './ShareSessionPickerNav'
import { ShareSessionPickerRow } from './ShareSessionPickerRow'
import {
  buildSharePickerNavItems,
  filterSharePickerSessionsByScope,
  matchesSharePickerSearch,
  mergeSharePickerSessions,
  sortSharePickerEntriesByActivity,
  type SharePickerScopeKey,
  type SharePickerSessionContext,
} from './sessionSharePickerPresentation'
import {
  buildSessionShareIntentKey,
  forgetPendingShareIntent,
  rememberPendingShareIntent,
  resolvePendingShareClientRequestId,
} from './sessionSharePendingIntent'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'

const log = createLogger('SessionSharePickerDialog')
type ShareIntent = 'participate' | 'continue'

interface Props {
  isOpen: boolean
  onClose: () => void
  conversationId: string
  organizationId: string | null
  granteeUserId: string | null
}

function activeSharesOf(shares: SessionShareInfo[] | undefined): SessionShareInfo[] {
  return (shares ?? []).filter((share) => share.status === 'active')
}

export const SessionSharePickerDialog: React.FC<Props> = ({
  isOpen,
  onClose,
  conversationId,
  organizationId,
  granteeUserId,
}) => {
  const { t } = useTranslation('tabchat')
  const sessionsBySpaceId = useChatStore((s) => s.sessionsBySpaceId)
  const spaces = useSpaceStore((s) => s.spaces)
  const agentCache = useSpaceStore((s) => s.agentCache)
  const selectedAgent = useSpaceStore((s) => s.selectedAgent)
  const [query, setQuery] = useState('')
  const [scopeKey, setScopeKey] = useState<SharePickerScopeKey>('recent')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [intent, setIntent] = useState<ShareIntent>('participate')
  const [tier, setTier] = useState<ShareTierLevel>('view')
  const [loading, setLoading] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [sharesBySessionId, setSharesBySessionId] = useState<Record<string, SessionShareInfo[]>>({})
  const [sharesLoading, setSharesLoading] = useState(false)
  const pendingShareIntentRef = useRef<{
    key: string
    clientRequestId: string
  } | null>(null)
  // 用户在共享行返回前手选过权限档时，不让迟到的预填把选择改回去
  const userAdjustedTierRef = useRef(false)

  const personalSpaces = useMemo(
    () => spaces.filter((space) => (
      !space.is_archived
      && space.type !== 'team_space'
      && (!organizationId || space.organization_id === organizationId)
    )),
    [spaces, organizationId],
  )
  const personalSpaceIds = useMemo(
    () => personalSpaces.map((space) => space.id),
    [personalSpaces],
  )
  const personalSpaceKey = personalSpaceIds.join(',')
  const useSplitLayout = personalSpaces.length > 1

  const spaceNameById = useMemo(
    () => Object.fromEntries(personalSpaces.map((space) => [space.id, space.name])),
    [personalSpaces],
  )

  const basePickerContext = useMemo<Omit<SharePickerSessionContext, 'showWorkspaceSource'>>(() => ({
    agentCache,
    selectedAgent,
    spaceNameById,
  }), [agentCache, selectedAgent, spaceNameById])

  const allEntries = useMemo(
    () => mergeSharePickerSessions(personalSpaceIds, sessionsBySpaceId),
    [personalSpaceIds, sessionsBySpaceId],
  )

  useEffect(() => {
    if (!isOpen || !organizationId || personalSpaceIds.length === 0) return
    let cancelled = false
    setLoading(true)
    void Promise.allSettled(
      personalSpaceIds.map((spaceId) =>
        useChatStore.getState().loadSessions(spaceId, organizationId),
      ),
    ).then((results) => {
      if (cancelled) return
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        log.warn('load sessions for share picker partially failed', { failed })
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, organizationId, personalSpaceKey])

  useEffect(() => {
    if (!isOpen) {
      pendingShareIntentRef.current = null
      setQuery('')
      setScopeKey('recent')
      setSelectedSessionId(null)
      setIntent('participate')
      setTier('view')
      setSharing(false)
      setSharesBySessionId({})
      setSharesLoading(false)
    }
  }, [isOpen])

  useEffect(() => {
    pendingShareIntentRef.current = null
  }, [conversationId, granteeUserId, intent, selectedSessionId, tier])

  useEffect(() => {
    if (!isOpen) setSharesBySessionId({})
  }, [isOpen])

  // 只读取当前选中任务，避免任务列表分批更新时重复扫描全部任务。
  useEffect(() => {
    if (!isOpen || !selectedSessionId) {
      setSharesLoading(false)
      return
    }
    if (sharesBySessionId[selectedSessionId] !== undefined) {
      setSharesLoading(false)
      return
    }
    let cancelled = false
    setSharesLoading(true)
    void listSessionSharesBySession(selectedSessionId)
      .then((shares) => {
        if (cancelled) return
        setSharesBySessionId((current) => ({
          ...current,
          [selectedSessionId]: shares,
        }))
      })
      .catch((err) => {
        if (cancelled) return
        log.warn('list session shares for selected picker row failed', {
          sessionId: selectedSessionId,
          err,
        })
        setSharesBySessionId((current) => ({
          ...current,
          [selectedSessionId]: [],
        }))
      })
      .finally(() => {
        if (!cancelled) setSharesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, selectedSessionId, sharesBySessionId])

  useEffect(() => {
    userAdjustedTierRef.current = false
  }, [selectedSessionId])

  // 选中任务时按已缓存共享行预填当前对端权限档
  useEffect(() => {
    if (!selectedSessionId) return
    const shares = sharesBySessionId[selectedSessionId]
    if (shares === undefined) {
      setTier('view')
      return
    }
    if (userAdjustedTierRef.current) return
    if (!granteeUserId) {
      setTier('view')
      return
    }
    const peerShare = activeSharesOf(shares).find(
      (share) => share.grantee_user_id === granteeUserId,
    )
    if (peerShare) {
      setTier(
        clampToSelectableShareTier(
          resolveShareTierLevel(Boolean(peerShare.can_fork), Boolean(peerShare.can_chat)),
        ),
      )
      return
    }
    setTier('view')
  }, [granteeUserId, selectedSessionId, sharesBySessionId])

  const navItems = useMemo(
    () => buildSharePickerNavItems(personalSpaces, allEntries, t),
    [allEntries, personalSpaces, t],
  )

  const isSearching = query.trim().length > 0

  const visibleEntries = useMemo(() => {
    const searchContext: SharePickerSessionContext = {
      ...basePickerContext,
      showWorkspaceSource: useSplitLayout && (isSearching || scopeKey === 'recent'),
    }
    const searched = allEntries.filter((entry) =>
      matchesSharePickerSearch(entry.session, query, searchContext, entry.sourceSpaceId),
    )
    const scoped = isSearching
      ? searched
      : filterSharePickerSessionsByScope(searched, scopeKey)
    return sortSharePickerEntriesByActivity(scoped)
  }, [allEntries, basePickerContext, isSearching, query, scopeKey, useSplitLayout])

  const pickerContext = useMemo<SharePickerSessionContext>(() => ({
    ...basePickerContext,
    showWorkspaceSource: useSplitLayout && (isSearching || scopeKey === 'recent'),
  }), [basePickerContext, isSearching, scopeKey, useSplitLayout])

  const activeScopeLabel = useMemo(() => {
    if (isSearching) {
      return t('sessionSharePicker.searchScope', { defaultValue: '全部任务' })
    }
    if (!useSplitLayout) return null
    return navItems.find((item) => item.key === scopeKey)?.label ?? null
  }, [isSearching, navItems, scopeKey, t, useSplitLayout])

  const mode: SessionShareMode = intent === 'continue' ? 'continue' : tier

  const handleModeChange = useCallback((next: SessionShareMode) => {
    if (next === 'continue') {
      setIntent('continue')
      return
    }
    setIntent('participate')
    userAdjustedTierRef.current = true
    setTier(next)
  }, [])

  const handleToggleSession = useCallback((sessionId: string) => {
    setSelectedSessionId((current) => (current === sessionId ? null : sessionId))
  }, [])

  const handleShare = useCallback(async () => {
    if (
      !selectedSessionId
      || !granteeUserId
      || sharing
      || (intent !== 'continue' && sharesLoading)
    ) return
    const intentKey = buildSessionShareIntentKey({
      organizationId,
      sessionId: selectedSessionId,
      granteeUserId,
      tier: intent === 'continue' ? 'continuation' : tier,
    })
    const clientRequestId = resolvePendingShareClientRequestId({
      intentKey,
      memoryIntent: pendingShareIntentRef.current,
    })
    pendingShareIntentRef.current = { key: intentKey, clientRequestId }
    rememberPendingShareIntent(intentKey, clientRequestId)
    setSharing(true)
    try {
      if (intent === 'continue') {
        const continuation = await createSessionContinuation({
          sourceSessionId: selectedSessionId,
          recipientUserId: granteeUserId,
          conversationId,
          clientRequestId,
        })
        useIMStore.getState().setSessionContinuation(continuation)
        forgetPendingShareIntent(intentKey)
        pendingShareIntentRef.current = null
        toast({ title: t('shareSession.continueSuccess', { defaultValue: '已发送工作转交' }) })
        onClose()
        return
      }
      const flags = shareTierToFlags(tier)
      const created = await createSessionShare({
        sessionId: selectedSessionId,
        granteeUserId,
        canFork: flags.canFork,
        canChat: flags.canChat,
        conversationId,
        clientRequestId,
      })
      if (created.conversation_id) {
        useIMStore.getState().bumpSessionShareListVersion(created.conversation_id)
      }
      if (created.id) {
        const imState = useIMStore.getState()
        imState.setSessionShare(created)
        imState.bumpSessionShareDetailVersion(created.id)
      }
      forgetPendingShareIntent(intentKey)
      pendingShareIntentRef.current = null
      toast({ title: t('sessionShareCreated', { defaultValue: '已共享任务，共享卡已发送' }) })
      onClose()
    } catch (err) {
      const errorStatus = (
        typeof err === 'object'
        && err !== null
        && 'status' in err
      ) ? (err as { status?: unknown }).status : undefined
      log.warn('create session share failed', {
        sessionId: selectedSessionId,
        conversationId,
        clientRequestId,
        errorName: err instanceof Error ? err.name : 'UnknownError',
        errorMessage: err instanceof Error ? err.message : String(err),
        status: typeof errorStatus === 'number' ? errorStatus : null,
      })
      toast({
        title: t('sessionShareCreateFailed', { defaultValue: '共享任务失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSharing(false)
    }
  }, [conversationId, granteeUserId, intent, onClose, organizationId, selectedSessionId, sharesLoading, sharing, t, tier])

  const shareActionDisabled = (
    !selectedSessionId
    || !granteeUserId
    || sharing
    || (intent !== 'continue' && sharesLoading)
  )

  const sessionListBody = (
    <>
      {loading && visibleEntries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          <span className="text-body">{t('loading', { defaultValue: '加载中…' })}</span>
        </div>
      ) : !organizationId ? (
        <div className="flex items-center justify-center px-4 py-10 text-center text-body text-muted-foreground">
          {t('sessionSharePickerMissingOrganization', {
            defaultValue: '无法确定当前组织，暂不能加载任务',
          })}
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <MessagesSquare className="h-8 w-8 text-muted-foreground/30" aria-hidden />
          <p className="text-body text-muted-foreground">
            {query.trim()
              ? t('sessionSharePickerSearchEmpty', {
                query: query.trim(),
                defaultValue: `没有匹配「${query.trim()}」的任务`,
              })
              : t('sessionSharePickerEmptyScope', {
                defaultValue: '这个范围下没有可共享的任务',
              })}
          </p>
        </div>
      ) : (
        visibleEntries.map(({ session, sourceSpaceId }) => (
          <ShareSessionPickerRow
            key={session.id}
            session={session}
            sourceSpaceId={sourceSpaceId}
            selected={session.id === selectedSessionId}
            disabled={sharing}
            context={pickerContext}
            activeShares={activeSharesOf(sharesBySessionId[session.id])}
            highlightUserId={granteeUserId}
            onSelect={handleToggleSession}
            t={t}
          />
        ))
      )}
    </>
  )

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className={cn(
          'flex max-h-[580px] max-w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0',
          useSplitLayout ? 'w-[640px]' : 'w-[480px]',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Share2 className="h-4 w-4 text-accent" aria-hidden />
          <DialogTitle className="text-body font-medium">
            {t('sessionSharePickerTitle', { defaultValue: '共享任务' })}
          </DialogTitle>
        </div>

        <div className="border-b border-border/40 px-4 py-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sessionSharePickerSearch', {
                defaultValue: '搜索任务、摘要或 Agent',
              })}
              className="h-9 w-full rounded-interactive bg-muted/30 pl-8 pr-3 text-body outline-none placeholder:text-muted-foreground/60 focus:bg-muted/45"
              autoFocus
            />
          </div>
        </div>

        <div className="flex min-h-[220px] min-w-0 flex-1 overflow-hidden">
          {useSplitLayout && !isSearching ? (
            <ShareSessionPickerNav
              items={navItems}
              activeKey={scopeKey}
              ariaLabel={t('sessionSharePicker.scopeAriaLabel', { defaultValue: '任务范围' })}
              disabled={sharing}
              onSelect={setScopeKey}
            />
          ) : null}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!loading && visibleEntries.length > 0 ? (
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-3 py-1.5">
                <span className="truncate text-caption text-muted-foreground">
                  {activeScopeLabel
                    ?? t('sessionSharePickerCount', {
                      count: visibleEntries.length,
                      defaultValue: `共 ${visibleEntries.length} 个任务`,
                    })}
                </span>
                <span className="shrink-0 text-caption tabular-nums text-muted-foreground/60">
                  {visibleEntries.length}
                </span>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {sessionListBody}
            </div>
          </div>
        </div>

        <div className="border-t border-border/40 px-4 py-3">
          <SessionShareModeField
            value={mode}
            disabled={sharing}
            onChange={handleModeChange}
          />
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={sharing}>
            {t('sessionSharePickerCancel', { defaultValue: '取消' })}
          </Button>
          <Button
            disabled={shareActionDisabled}
            onClick={() => { void handleShare() }}
          >
            {sharing
              ? t('sessionShareSharing', { defaultValue: '发送中…' })
              : intent === 'continue'
                ? t('shareSession.continueSubmit', { defaultValue: '发送转交' })
                : t('sessionShareConfirm', { defaultValue: '共享' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

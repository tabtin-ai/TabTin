/**
 * ChatSplitPane - A single pane inside the chat split layout.
 *
 * Renders a full chat conversation for a given `sessionId`, reading messages
 * directly from `messagesBySessionId` in the store so multiple panes can
 * display different sessions simultaneously.
 *
 * Session surface (messages / HITL / decision stream / busy) comes from
 * `useSessionChatSurface` — shared with ChatContent so split and main stay aligned.
 *
 * Each pane has its own streaming state via `useSessionBusy(sessionId)`.
 * Sending a message passes an explicit `targetSessionId` to `sendMessage`,
 * avoiding any mutation of the global `currentSessionId` and eliminating
 * race conditions when multiple panes send concurrently.
 */

import React, { useCallback, useEffect, useMemo } from 'react'
import { ScrollArea, ConfirmDialog } from '@tabtin/smartsheet-ui'
import { X, MessageSquarePlus, Loader2, Square } from 'lucide-react'
import { cn } from '@utils/cn'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { isSessionBusy } from '@/stores/chat/execution/sessionRunProjection'
import { useAuthStore, selectIsAuthenticated } from '@/stores/useAuthStore'
import { useBillingStore } from '@/stores/useBillingStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSessionReadStore } from '@/stores/useSessionReadStore'
import { resolveSessionHasUnreadReply } from '@/stores/chat/session/sessionReadProjection'
import { MessageList } from '../message'
import { ChatInput, type ChatInputSendOptions } from '../composer/ChatInput'
import { composerDraftScopeKey } from '../composer/chatInputDraft'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { RestoreOverlay } from '../checkpoint/RestoreOverlay'
import {
  TrackerRunBreadcrumb,
  resolveTrackerRunSessionTitle,
} from '../tracker/TrackerRunBreadcrumb'
import { TrackerRunStatusIndicator } from '../tracker/TrackerRunStatusIndicator'
import { useComposerPresetInjection } from '../composer-presets/useComposerPresetInjection'
import { useTranslation } from 'react-i18next'
import type { ChatSession } from '@tabtin/chat-client'
import type { ChatAttachment } from '../types'
import { useContextInjection } from '../context/useContextInjection'
import { useRemoteExecutionGate } from '../hooks/useRemoteExecutionGate'
import { RemoteExecutionNoticeGate } from '../notice/RemoteExecutionNoticeGate'
import { useSessionChatSurface } from '../hooks/useSessionChatSurface'
import { useSessionScopedComposerModel } from '../hooks/useSessionScopedComposerModel'
import { useSessionComposerAgentIdentityPolicy } from '../hooks/useSessionComposerAgentIdentityPolicy'
import { useRetryLastMessageListener } from '../hooks/useRetryLastMessageListener'
import { continueAgentAfterError } from '@/stores/chat/messages/actions/continueAgentAfterError'
import { usePendingRevertSend } from '../hooks/usePendingRevertSend'

interface ChatSplitPaneProps {
  paneId: string
  sessionId: string | null
  spaceId: string
  organizationId: string
  isActive: boolean
  isSplit: boolean
  sessions: ChatSession[]
  onActivate: () => void
  onClose: () => void
  onSelectSession: (sessionId: string) => void
}

export const ChatSplitPane: React.FC<ChatSplitPaneProps> = ({
  paneId: _paneId,
  sessionId,
  spaceId,
  organizationId,
  isActive,
  isSplit,
  sessions,
  onActivate,
  onClose,
  onSelectSession,
}) => {
  const { t } = useTranslation('chat')
  const isAuthenticated = useAuthStore(selectIsAuthenticated)

  const {
    messages,
    isMessagesLoading,
    hasMore,
    isLoadingMore,
    onLoadMore,
    isBusy,
    isReverted,
    isRestoring,
    queueCount,
    isSendInFlight,
    hitlProps,
  } = useSessionChatSurface(sessionId)

  const sendMessage = useChatStore((s) => s.sendMessage)
  const abortStream = useChatStore((s) => s.abortStream)

  const spaceName = useSpaceStore(
    useCallback(
      (s) => s.spaces.find(space => space.id === spaceId)?.name ?? null,
      [spaceId],
    ),
  )
  const contextInjection = useContextInjection(sessionId, isActive)
  useComposerPresetInjection(sessionId, isActive)

  const session = useMemo(
    () => sessions.find((candidate) => candidate.id === sessionId) ?? null,
    [sessions, sessionId],
  )
  const {
    sendableModels,
    currentModel,
    currentContextTier,
    currentModelParamOverrides,
    isLoadingModels,
    modelLoadError,
    hasSendableChatModel,
    modelDisabledReason,
    onModelChange,
    onRetryLoadModels,
  } = useSessionScopedComposerModel({
    sessionId,
    session,
    organizationId,
    enabled: Boolean(isAuthenticated && organizationId && isActive),
  })
  const agentIdentity = useSessionComposerAgentIdentityPolicy(spaceId)
  const memberLimitReached = useBillingStore(s => s.memberLimitReached)
  const memberLimitReason = useBillingStore(s => s.memberLimitReason)
  const remoteExecution = useRemoteExecutionGate(spaceId)
  const canSend = Boolean(
    isAuthenticated
    && organizationId
    && spaceId
    && sessionId
    && hasSendableChatModel
    && !memberLimitReached
    && !remoteExecution.isBlocked,
  )

  const lastMessageAt = useMemo(() => {
    if (messages.length === 0) return null
    return messages[messages.length - 1].created_at ?? null
  }, [messages])

  const markViewed = useSessionReadStore(s => s.markViewed)
  const legacyUnread = useSessionReadStore(
    useCallback(
      (s) => (sessionId && !isActive) ? s.isUnread(sessionId, lastMessageAt) : false,
      [sessionId, isActive, lastMessageAt],
    ),
  )
  const hasUnread = isActive
    ? false
    : resolveSessionHasUnreadReply(session, legacyUnread)

  useEffect(() => {
    // ACK 必须晚于真实消息历史加载；避免仅切换 pane 就提前清掉未读。
    if (isActive && sessionId && !isMessagesLoading && messages.length > 0) {
      markViewed(sessionId)
    }
  }, [isActive, sessionId, isMessagesLoading, messages.length, markViewed])

  const {
    deferOrRun,
    confirmPending,
    clearPending,
    dialogOpen,
  } = usePendingRevertSend()

  // Abort stream on pane unmount to prevent orphaned StreamSlots
  useEffect(() => {
    return () => {
      if (sessionId && isSessionBusy(sessionId)) {
        abortStream(sessionId)
      }
    }
  }, [sessionId, abortStream])

  const trackerRun = session?.tracker_run ?? null

  const handleSend = useCallback(
    async (
      message: string,
      attachments?: ChatAttachment[],
      contextBlocks?: Array<Record<string, unknown>>,
      options?: ChatInputSendOptions,
    ) => {
      if (!canSend) return
      if (isBusy) return
      if (!sessionId) return

      await deferOrRun(
        isReverted,
        { message, attachments, contextBlocks, options },
        async (payload) => {
          await sendMessage(payload.message, true, payload.attachments, payload.contextBlocks, sessionId, {
            ...payload.options,
            spaceId,
          })
        },
      )
    },
    [canSend, deferOrRun, isBusy, isReverted, sendMessage, sessionId, spaceId],
  )

  const handleContinueAfterError = useCallback(() => {
    if (!sessionId) return
    void deferOrRun(
      isReverted,
      { message: '', continueAfterError: true },
      async () => {
        await continueAgentAfterError(sessionId)
      },
    )
  }, [deferOrRun, isReverted, sessionId])

  useRetryLastMessageListener({
    sessionId,
    isStreaming: isBusy,
    messages,
    onContinue: handleContinueAfterError,
    requireExplicitSessionMatch: true,
  })

  const handleStop = useCallback(() => {
    if (sessionId) {
      useChatRuntimeStore.getState().setCancellingForSession(sessionId, true)
      abortStream(sessionId)
    }
  }, [sessionId, abortStream])

  if (!sessionId) {
    return (
      <div
        className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground/60 cursor-pointer"
        onClick={onActivate}
      >
        <MessageSquarePlus className="h-8 w-8 opacity-40" />
        <p className="text-body">{t('split.pickSession', '选择一个对话')}</p>
        <ScrollArea className="max-h-48 w-full">
          <div className="flex flex-col gap-1 px-6">
          {sessions.slice(0, 8).map((s) => (
            <button
              key={s.id}
              className="text-left text-body px-3 py-1.5 rounded-lg hover:bg-muted/30 truncate text-foreground/80"
              onClick={(e) => {
                e.stopPropagation()
                onSelectSession(s.id)
              }}
            >
              {s.title || t('panel.newChat', '新任务')}
            </button>
          ))}
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'h-full min-w-0 flex flex-col overflow-hidden relative rounded-lg',
        isSplit && 'border border-border/25 bg-background/35',
        isActive && isSplit && 'border-primary/35 ring-1 ring-primary/25',
      )}
      onClick={onActivate}
    >
      <RestoreOverlay sessionId={sessionId} />
      {isSplit && (
        <div className="flex min-w-0 items-center h-8 gap-2 px-2 flex-shrink-0 border-b border-border/20 bg-muted/10">
          {hasUnread && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-accent shrink-0 animate-in fade-in duration-300"
              title={t('split.unread', '有新消息')}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground/60">
            {trackerRun
              ? resolveTrackerRunSessionTitle(trackerRun, t)
              : (session?.title || t('panel.newChat', '新任务'))}
          </span>
          {trackerRun ? <TrackerRunBreadcrumb trackerRun={trackerRun} /> : null}
          {isBusy && !isActive && (
            <ChatIconTooltip content={t('split.stopStreaming', '停止输出')}>
              <button
                className="h-5 w-5 flex items-center justify-center rounded text-destructive/60 hover:text-destructive hover:bg-destructive/5 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  handleStop()
                }}
                aria-label={t('split.stopStreaming', '停止输出')}
              >
                <Square className="h-2.5 w-2.5 fill-current" />
              </button>
            </ChatIconTooltip>
          )}
          <ChatIconTooltip content={t('split.closePane', '关闭窗格')}>
            <button
              className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/30 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              aria-label={t('split.closePane', '关闭窗格')}
            >
              <X className="h-3 w-3" />
            </button>
          </ChatIconTooltip>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className={cn('flex-1 flex flex-col w-full h-full overflow-hidden', 'max-w-4xl mx-auto')}>
          {isMessagesLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : (
            <MessageList
              sessionId={sessionId}
              isLoading={false}
              isLoadingMore={isLoadingMore}
              hasMore={hasMore}
              onLoadMore={onLoadMore}
            />
          )}
          {trackerRun && <TrackerRunStatusIndicator trackerRun={trackerRun} />}
        </div>
      </div>

      <div
        className="px-3 pb-3 pt-2 flex-shrink-0 overflow-visible space-y-1.5"
        onFocusCapture={onActivate}
      >
        <RemoteExecutionNoticeGate gate={remoteExecution} />
        <ChatInput
          key={composerDraftScopeKey(sessionId, spaceId)}
          onSend={async (msg, attachments, contextBlocks, options) => {
            await handleSend(msg, attachments, contextBlocks, options)
          }}
          onStop={handleStop}
          disabled={!canSend || isRestoring || isLoadingModels || isSendInFlight}
          disabledReason={
            memberLimitReached
              ? memberLimitReason ?? 'member_monthly_limit'
              : remoteExecution.isBlocked
                ? (remoteExecution.controlDeviceOffline ? 'remote_device_offline' : 'remote_device')
                : modelDisabledReason ?? undefined
          }
          isStreaming={isBusy || isRestoring}
          models={sendableModels}
          currentModel={currentModel}
          currentContextTier={currentContextTier}
          currentModelParamOverrides={currentModelParamOverrides}
          onModelChange={onModelChange}
          isLoadingModels={isLoadingModels}
          modelLoadError={modelLoadError}
          onRetryLoadModels={onRetryLoadModels}
          contextRefs={contextInjection.contextRefs}
          onAddContextRef={contextInjection.addContextRef}
          onRemoveContextRef={contextInjection.removeRef}
          onClearContextRefs={contextInjection.clearRefs}
          {...hitlProps}
          queueCount={queueCount}
          isSendInFlight={isSendInFlight}
          sessionId={sessionId}
          spaceId={spaceId}
          spaceName={spaceName}
          showAgentIdentity={agentIdentity.showAgentIdentity}
          canChangeAgent={agentIdentity.canChangeAgent}
          enableAgentPicker={agentIdentity.enableAgentPicker}
          acceptGlobalInputEvents={isActive}
        />
      </div>

      <ConfirmDialog
        open={dialogOpen}
        onOpenChange={(open) => { if (!open) clearPending() }}
        title={t('checkpoint.sendWhileRevertedTitle', { defaultValue: '确认继续' })}
        description={t('checkpoint.sendWhileRevertedDesc', { defaultValue: '发送新消息后，被回退的对话将被永久删除且无法撤销。确定继续？' })}
        variant="destructive"
        onConfirm={() => confirmPending(async (payload) => {
          if (payload.continueAfterError) {
            if (sessionId) await continueAgentAfterError(sessionId)
            return
          }
          await sendMessage(payload.message, true, payload.attachments, payload.contextBlocks, sessionId, {
            ...payload.options,
            spaceId,
          })
        })}
      />
    </div>
  )
}

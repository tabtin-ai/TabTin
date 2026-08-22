/**
 * ChatPanel - Chat Agent 主面板（布局壳）
 *
 * 职责：嵌入式聊天壳。内容渲染委托给 ChatContent，生命周期委托给 useChatPanelLifecycle。
 */

import React, { useMemo, useCallback } from 'react'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useChatSplitStore } from '@/stores/useChatSplitStore'
import { useAuthStore, selectIsAuthenticated } from '../../../stores/useAuthStore'
import { useTableStore } from '../../../stores/useTableStore'
import { useSpaceStore } from '../../../stores/useSpaceStore'
import { useSpaceViewPrefsStore } from '../../../stores/useSpaceViewPrefsStore'
import { useContextInjection } from '../context/useContextInjection'
import { useComposerPresetInjection } from '../composer-presets/useComposerPresetInjection'
import { resolveComposerPresetScopeId } from '../composer-presets/scope'
import { installComposerPresetsWindowAPI } from '../composer-presets/windowApi'
import '../composer-presets/presets'

installComposerPresetsWindowAPI()
import { RestoreOverlay } from '../checkpoint/RestoreOverlay'
import { RewindPreviewPanel } from '../checkpoint/RewindPreviewPanel'
import { useChatActions } from '../hooks/useChatActions'
import { useChatPanelContext } from '../hooks/useChatPanelContext'
import { useChatPanelLifecycle } from '../hooks/useChatPanelLifecycle'
import { useChatCallbacks } from '../hooks/useChatCallbacks'
import { ChatContent } from './ChatContent'
import { ResourceOpenExecutionSpaceContext } from './ResourceOpenExecutionSpaceContext'
import { ChatSessionBar } from '../session/ChatSessionBar'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import type { ChatSession } from '@tabtin/chat-client'
import {
  buildConversationDraftScopeKey,
  resolveWorkspaceContextState,
} from '@components/layout/workspaceContextState'
import type { DraftScopePointerOptions } from '@/stores/chat/session/slices/sessionPointerSlice'
import { buildStableConversationDraftScopeKey } from '@/stores/chat/session/draftMessageLegacyAdapter'
import { isProjectCompanionWorkspace } from '@/utils/projectExecutionTarget'
import {
  useSessionAccessStore,
  type SharedSessionAccessDescriptor,
} from '@/stores/chat/session/sessionAccessStore'
import { toast } from '@components/ui'
import { deleteExternalArchive } from '@components/onboarding/external-import/deleteExternalArchive'
import type { ExternalArchiveDeleteTarget } from '../session/ExternalArchiveDeleteDialog'
import { createLogger } from '@/utils/logger'

const EMPTY_CHAT_SESSIONS: ChatSession[] = []
const log = createLogger('ChatPanel')

export interface ChatPanelProps {
  isActive?: boolean
  variant?: 'panel' | 'embedded'
  hideSessionTabs?: boolean
  surfaceTone?: 'canvas' | 'background'
  panelActions?: React.ReactNode
  /**
   * 是否在嵌入式顶部 toolbar 左侧渲染「新话题」入口。
   * ChatSidePanel 这种 hideSessionTabs 的场景需要打开它——否则用户在
   * 聊天面板内没有任何「新建会话」按钮可触达，只能去侧边栏发起。
   * 仅嵌入式生效。
   */
  showInlineNewTopicButton?: boolean
  /**
   * 是否在 `hideSessionTabs` 场景的顶部 toolbar 渲染「最近对话」横向标签条
   * （ChatSessionHistoryMenu）。缺省沿用 `hideSessionTabs`——隐藏了完整 session
   * tabs 时用它兜底快速切会话。
   * 当外部已有可见的会话列表（如「任务」模式下侧边栏的 SidebarConversationList）
   * 时，这条标签条与侧栏重复，调用方可显式传 false 关掉。
   */
  showInlineHistory?: boolean
  spaceContext?: SpaceContext | null
  organizationId?: string | null
  /**
   * 会话列表范围。默认保持工作空间主界面行为：展示同团队下所有工作空间的会话。
   * Project 的任务页需要固定委托到 owner execution Space，使用 selectedSpaceOnly
   * 避免误选到其它工作空间的历史会话。
   */
  sessionListScope?: 'organization' | 'selectedSpaceOnly'
  /** 嵌入式会话工作台可固定展示某条会话，而不改写全局首页选中态。 */
  controlledSessionId?: string
  /** 嵌入式工作台沿用宿主 scope（例如 `im:{conversationId}`）承载产物标签。 */
  tabScopeKeyOverride?: string
  /** 持久共享标签恢复时同步提供，确保首次请求不退回普通会话链路。 */
  sharedSessionAccess?: SharedSessionAccessDescriptor | null
  /** 侧边受控会话主动拉取历史；owner 不携带 shareId，grantee 携带。 */
  forceControlledSessionHydration?: boolean
}

export const ChatPanel: React.FC<ChatPanelProps> = React.memo(({
  isActive,
  variant = 'panel',
  hideSessionTabs,
  surfaceTone = 'canvas',
  panelActions,
  showInlineNewTopicButton = false,
  showInlineHistory,
  spaceContext = null,
  organizationId,
  sessionListScope = 'organization',
  controlledSessionId,
  tabScopeKeyOverride,
  sharedSessionAccess: providedSharedSessionAccess,
  forceControlledSessionHydration = false,
}) => {
  const compactLeft = variant === 'embedded'
  const panelSurfaceClass = variant === 'embedded'
    ? 'bg-transparent'
    : surfaceTone === 'background'
      ? 'bg-background'
      : 'chat-panel-surface'

  // ── Actions ──
  const {
    sendMessage, abortStreamFromComposer, syncContext,
    ensureSessionForSpace, startDraftSessionForSpace, loadSessions, selectSession, deleteSession, renameSession, forkSession,
    loadModels, switchModel, switchContextTier, setModelParamOverride,
  } = useChatActions()
  const { isForeground } = useSpaceActivity()
  const selectedSpace = spaceContext
  const selectedSpaceId = selectedSpace?.id ?? null
  const resolvedOrganizationId = useMemo(() => {
    return organizationId || selectedSpace?.organization_id || null
  }, [selectedSpace?.organization_id, organizationId])
  const currentUserId = useAuthStore(s => s.user?.id ?? null)

  // ── Store 状态 ──
  const isPanelOpen = useChatStore(s => s.isPanelOpen)
  const globalCurrentSessionId = useChatStore(s => s.currentSessionId)
  const currentSessionIdBySpaceId = useChatStore(s => s.currentSessionIdBySpaceId)
  const currentSessionId = controlledSessionId ?? (sessionListScope === 'selectedSpaceOnly' && selectedSpaceId
    ? (currentSessionIdBySpaceId[selectedSpaceId] ?? null)
    : globalCurrentSessionId)
  const storedSharedSessionAccess = useSessionAccessStore(s => (
    currentSessionId ? s.bySessionId[currentSessionId] ?? null : null
  ))
  const sharedSessionAccess = providedSharedSessionAccess !== undefined
    ? (providedSharedSessionAccess?.sessionId === currentSessionId ? providedSharedSessionAccess : null)
    : storedSharedSessionAccess
  const sharedSessionOwner = sharedSessionAccess?.role === 'owner'
  const sidebarMode = useSpaceViewPrefsStore(
    useCallback(
      (s) => s.getSidebarMode(resolvedOrganizationId, currentUserId, selectedSpaceId),
      [resolvedOrganizationId, currentUserId, selectedSpaceId],
    ),
  )
  const workspaceContext = useMemo(() => resolveWorkspaceContextState({
    workbenchMode: 'space',
    sidebarMode,
    organizationId: resolvedOrganizationId,
    userId: currentUserId,
    executionSpaceId: selectedSpaceId,
    sessionId: currentSessionId,
  }), [
    currentSessionId,
    currentUserId,
    resolvedOrganizationId,
    selectedSpaceId,
    sidebarMode,
  ])
  const draftExecutionSpaceIdByWorkspaceKey = useChatStore(s => s.draftExecutionSpaceIdByWorkspaceKey)
  const setDraftExecutionSpaceForWorkspace = useChatStore(s => s.setDraftExecutionSpaceForWorkspace)
  const getSessionById = useChatStore(s => s.getSessionById)
  const spaces = useSpaceStore(s => s.spaces)
  // ：草稿态（无 currentSession）读 draft map；已打开会话跟会话所属
  // 工作空间，避免 desktop 下「先改 draft 再开历史」徽章与发送目标分叉。
  // 预建已关，切工作空间会 startDraft 清指针，不会再被假 session 锁死。
  const draftExecutionSpaceId = draftExecutionSpaceIdByWorkspaceKey[workspaceContext.key] ?? selectedSpaceId
  const currentSession = currentSessionId ? getSessionById(currentSessionId) : undefined
  const sharedGranteeReadSpaceId = sharedSessionAccess && !sharedSessionOwner
    ? (selectedSpaceId ?? sharedSessionAccess.workspaceId ?? null)
    : null
  const currentSessionExecutionSpaceId = sharedSessionAccess && !sharedSessionOwner
    ? sharedGranteeReadSpaceId
    : currentSession?.workspace_id ?? currentSession?.space_id ?? null
  const executionSpaceId = sessionListScope === 'selectedSpaceOnly'
    ? selectedSpaceId
    : currentSessionId
      ? (currentSessionExecutionSpaceId ?? draftExecutionSpaceId)
      : draftExecutionSpaceId
  const executionSpace = useMemo(() => {
    if (!executionSpaceId) return selectedSpace
    return spaces.find(space => space.id === executionSpaceId) ?? selectedSpace
  }, [executionSpaceId, selectedSpace, spaces])
  const executionSpaceOrganizationId = executionSpace?.organization_id ?? resolvedOrganizationId
  const chatSessionSpaceIds = useMemo(() => {
    if (sessionListScope === 'selectedSpaceOnly') {
      return executionSpaceId ? [executionSpaceId] : []
    }
    const organizationId = executionSpaceOrganizationId ?? resolvedOrganizationId
    if (organizationId) {
      const ids = spaces
        .filter(space => (
          space.organization_id === organizationId
          && !space.is_archived
          && space.type !== 'team_space'
          && !isProjectCompanionWorkspace(space)
        ))
        .map(space => space.id)
      if (ids.length > 0) return ids
    }
    return executionSpaceId && !isProjectCompanionWorkspace(executionSpace)
      ? [executionSpaceId]
      : []
  }, [executionSpace, executionSpaceId, executionSpaceOrganizationId, resolvedOrganizationId, sessionListScope, spaces])
  const sessionsBySpaceId = useChatStore(s => s.sessionsBySpaceId)
  const sessions = useMemo(() => {
    if (chatSessionSpaceIds.length === 0) return EMPTY_CHAT_SESSIONS
    const seen = new Set<string>()
    const result: ChatSession[] = []
    for (const targetSpaceId of chatSessionSpaceIds) {
      for (const session of sessionsBySpaceId[targetSpaceId] ?? EMPTY_CHAT_SESSIONS) {
        if (seen.has(session.id)) continue
        seen.add(session.id)
        result.push(resolveSessionScopeId(session) ? session : { ...session, space_id: targetSpaceId })
      }
    }
    return result
  }, [chatSessionSpaceIds, sessionsBySpaceId])
  const sessionSpaceIdById = useMemo(() => {
    const map = new Map<string, string>()
    for (const session of sessions) {
      const scopeId = resolveSessionScopeId(session)
      if (scopeId) {
        map.set(session.id, scopeId)
      }
    }
    return map
  }, [sessions])
  const resolveSessionSpaceId = useCallback((sessionId: string) => {
    return sessionSpaceIdById.get(sessionId) ?? executionSpaceId ?? null
  }, [executionSpaceId, sessionSpaceIdById])
  const isDraftSession = useChatStore(
    useCallback(
      (s) => Boolean(
        (selectedSpaceId && s.draftSessionBySpaceId[selectedSpaceId]) ||
        (executionSpaceId && s.draftSessionBySpaceId[executionSpaceId]),
      ),
      [executionSpaceId, selectedSpaceId],
    ),
  )
  const rewindPreview = useChatStore(s => s.rewindPreview)
  const cancelRewindPreview = useChatStore(s => s.cancelRewindPreview)
  const confirmRewindPreview = useChatStore(s => s.confirmRewindPreview)
  const tables = useTableStore(s => s.tables)
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const chatTabScopeKey = tabScopeKeyOverride ?? workspaceContext.key
  /**
   * 稳定新草稿 scope A：由产品宿主（Project / 工作空间 = spaceContext）构造，
   * 与当前会话 scope `conversation:S`、execution 工作空间 B 解耦。
   * 历史态 / 草稿态都保持同一 A，禁止从 chatTabScopeKey 或 B 推导。
   */
  const stableConversationDraftScopeKey = useMemo(
    () => buildStableConversationDraftScopeKey(selectedSpaceId),
    [selectedSpaceId],
  )
  const selectSessionWithDraftScope = useCallback(
    (spaceId: string, sessionId: string, options?: DraftScopePointerOptions) => {
      return selectSession(spaceId, sessionId, {
        ...options,
        draftScopeKey: options?.draftScopeKey ?? stableConversationDraftScopeKey ?? undefined,
        organizationId: options?.organizationId ?? executionSpaceOrganizationId,
      })
    },
    [executionSpaceOrganizationId, selectSession, stableConversationDraftScopeKey],
  )
  const startDraftSessionWithScope = useCallback(
    (spaceId: string, syncCurrent?: boolean, options?: DraftScopePointerOptions) => {
      startDraftSessionForSpace(spaceId, syncCurrent, {
        ...options,
        draftScopeKey: options?.draftScopeKey ?? stableConversationDraftScopeKey ?? undefined,
        organizationId: options?.organizationId ?? executionSpaceOrganizationId,
      })
    },
    [executionSpaceOrganizationId, startDraftSessionForSpace, stableConversationDraftScopeKey],
  )

  // ── 上下文解析 ──
  const {
    activeContextType, activeTable,
    activeAppMeta, openTabs,
    contextDisplay,
  } = useChatPanelContext({ selectedSpace: executionSpace, tabScopeKey: chatTabScopeKey, tables, variant })

  const panelActive = (isActive ?? isPanelOpen) && isForeground
  const togglePinSession = useChatSplitStore(s => s.togglePinSession)

  // ── 生命周期 hook ──
  const lifecycle = useChatPanelLifecycle({
    isForeground,
    panelActive,
    isAuthenticated,
    selectedSpace: executionSpace,
    selectedSpaceId: executionSpaceId,
    conversationHostSpaceId: selectedSpaceId,
    resolvedOrganizationId: executionSpaceOrganizationId,
    currentSessionId,
    tabScopeKey: chatTabScopeKey,
    draftScopeKey: stableConversationDraftScopeKey,
    sessions,
    activeContextType,
    activeAppMeta,
    openTabs,
    loadSessions,
    loadModels,
    syncContext,
    switchModel,
  })

  const {
    effectiveGraphType,
    isRestoring, canSend, disabledReason, currentModel, currentContextTier, currentModelParamOverrides, tokenUsage,
    pendingModelId, setPendingModelId, setPendingModelParamOverride,
    replacePendingModelParamOverrides,
  } = lifecycle

  const presetScopeId = useMemo(
    () => resolveComposerPresetScopeId(currentSessionId, executionSpaceId),
    [currentSessionId, executionSpaceId],
  )

  // ── Context injection ──
  const enablePrimaryInputInjection = isForeground
  const contextInjection = useContextInjection(presetScopeId, enablePrimaryInputInjection)
  useComposerPresetInjection(presetScopeId, enablePrimaryInputInjection)

  // ── 回调函数 ──
  const callbacks = useChatCallbacks({
    selectedSpaceId: executionSpaceId,
    resolvedOrganizationId: executionSpaceOrganizationId,
    currentSessionId,
    controlledSessionId,
    selectedSpace: executionSpace,
    tabScopeKey: chatTabScopeKey,
    draftScopeKey: stableConversationDraftScopeKey,
    conversationHostSpaceId: selectedSpaceId,
    resolveSessionSpaceId,
    effectiveGraphType,
    activeContextType,
    activeAppMeta,
    openTabs,
    pendingModelId,
    setPendingModelId,
    setPendingModelParamOverride,
    replacePendingModelParamOverrides,
    selectSession: selectSessionWithDraftScope,
    startDraftSessionForSpace: startDraftSessionWithScope,
    deleteSession,
    renameSession,
    forkSession,
    ensureSessionForSpace,
    sendMessage,
    abortStreamFromComposer,
    syncContext,
    switchModel,
    switchContextTier,
    setModelParamOverride,
    togglePinSession,
  })

  const handleDeleteExternalArchive = useCallback(async (
    target: ExternalArchiveDeleteTarget,
  ) => {
    if (!executionSpaceOrganizationId) {
      toast({
        title: '删除失败',
        description: '缺少组织信息，请稍后重试。',
        variant: 'destructive',
      })
      return
    }
    try {
      const result = await deleteExternalArchive({
        organizationId: executionSpaceOrganizationId,
        source: target.source,
        sourceSessionId: target.sourceSessionId,
        openedSessionId: target.openedSessionId,
      })
      if (result.deleted <= 0) {
        toast({ title: '删除外部档案失败', variant: 'destructive' })
        return
      }
      if (target.openedSessionId) {
        try {
          await callbacks.handleDeleteSession(target.openedSessionId)
        } catch (sessionError) {
          log.warn('外部档案已删，但清理展开会话失败', {
            sessionId: target.openedSessionId,
            source: target.source,
            sourceSessionId: target.sourceSessionId,
          }, sessionError)
        }
      }
      toast({ title: '已删除外部档案' })
    } catch (error) {
      log.error('删除外部档案失败', {
        source: target.source,
        sourceSessionId: target.sourceSessionId,
      }, error)
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '请稍后重试。',
        variant: 'destructive',
      })
    }
  }, [callbacks, executionSpaceOrganizationId])

  const effectiveHideSessionTabs = Boolean(hideSessionTabs)

  // ── ChatContent 共享 props ──
  // PRD §5 / 红线 #12：旧的 SubagentDetailDrawer portal 已迁移到工作台
  // `subagent_session` Context Tab，详见
  const chatContentProps = {
    currentSessionId,
    sharedAccessShareId: sharedSessionAccess?.role === 'owner'
      ? null
      : sharedSessionAccess?.shareId ?? null,
    forceSessionHydration: forceControlledSessionHydration,
    selectedSpace: sharedSessionAccess && !sharedSessionOwner ? null : executionSpace,
    selectedSpaceId: executionSpaceId,
    onExecutionSpaceChange: sharedSessionAccess || sessionListScope === 'selectedSpaceOnly'
      ? undefined
      : (nextSpaceId: string) => {
          // 先写当前 key，再写 startDraft 后会落到的 draft key，避免 conversations
          // 模式下 key 从 conversation:{sessionId} 漂到 conversation:draft:… 后 orphan。
          const draftKeys = new Set<string>([workspaceContext.key])
          if (workspaceContext.kind === 'conversation') {
            draftKeys.add(buildConversationDraftScopeKey(selectedSpaceId))
          }
          for (const key of draftKeys) {
            setDraftExecutionSpaceForWorkspace(key, nextSpaceId)
          }
          // 清会话指针进草稿欢迎态；真实建会话仍走首发 pre_send（预建已关，）。
          // conversation draft scope 保持 A；nextSpaceId 仅作执行工作空间元数据，不得改写领域主键。
          const conversationDraftScope = [...draftKeys].find((key) =>
            key.startsWith('conversation:draft:'),
          )
          startDraftSessionWithScope(nextSpaceId, true, {
            draftScopeKey: conversationDraftScope ?? stableConversationDraftScopeKey,
            executionWorkspaceId: nextSpaceId,
            // ：只换执行现场，保留草稿里已选的 Mode / Agent / Model / Tier
            preserveDraftMessageIntent: true,
          })
        },
    tabScopeKey: chatTabScopeKey,
    draftScopeKey: stableConversationDraftScopeKey,
    compactLeft,
    effectiveGraphType,
    isRestoring,
    canSend: sharedSessionOwner ? canSend : sharedSessionAccess ? false : canSend,
    disabledReason: sharedSessionOwner ? disabledReason : sharedSessionAccess ? '共享会话当前为只读' : disabledReason,
    currentModel,
    currentContextTier,
    currentModelParamOverrides,
    tokenUsage,
    presetScopeId,
    activeTable,
    activeContextType,
    contextDisplay,
    contextInjection,
    onSendMessage: callbacks.handleSendMessage,
    onStop: callbacks.handleStop,
    onModelChange: callbacks.handleModelChange,
  }

  return (
    <ResourceOpenExecutionSpaceContext.Provider value={executionSpaceId}>
      <div
        className={`relative flex h-full w-full min-w-0 ${panelSurfaceClass}`}
      >
      <RestoreOverlay />
      {rewindPreview && (
        <RewindPreviewPanel
          sessionId={rewindPreview.sessionId}
          targetMessageId={rewindPreview.targetMessageId}
          mode={rewindPreview.mode}
          resendIntent={rewindPreview.resendIntent}
          onConfirm={confirmRewindPreview}
          onCancel={cancelRewindPreview}
        />
      )}
      <div className="relative flex-1 flex flex-col min-w-0 z-sticky bg-transparent">
        <ChatSessionBar
          selectedSpaceId={sharedSessionAccess ? null : executionSpaceId}
          draftBadgeSpaceId={sharedSessionAccess ? null : executionSpaceId}
          sessions={sessions}
          currentSessionId={currentSessionId}
          showDraftSession={isDraftSession}
          showSessionTabs={!effectiveHideSessionTabs}
          compactLeft={compactLeft}
          panelActions={panelActions}
          showInlineNewTopicAction={showInlineNewTopicButton}
          showInlineHistoryAction={showInlineHistory ?? effectiveHideSessionTabs}
          onSelectSession={callbacks.handleTabClick}
          onCreateSession={callbacks.handleNewSession}
          onDeleteSession={callbacks.handleDeleteSession}
          onDeleteExternalArchive={handleDeleteExternalArchive}
          onRenameSession={callbacks.handleRenameSession}
          onForkSession={callbacks.handleForkSession}
        />
        <ChatContent {...chatContentProps} />
      </div>
      </div>
    </ResourceOpenExecutionSpaceContext.Provider>
  )
})
ChatPanel.displayName = 'ChatPanel'

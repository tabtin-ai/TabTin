/**
 * 协作文档编辑器 Hook (V3) — 宿主无关版本
 *
 * 基于 @tabtin/collab-core 的 useCollabProvider 实现：
 * - HocuspocusProvider: Y.js WebSocket 同步
 * - IndexedDB 本地缓存
 * - 协作光标展示
 * - 文档事件流 (doc.events.*)
 * - Force-close 处理
 * - Feature flag 降级
 *
 * 宿主通过 TabDocEditorConfigProvider 注入 auth/collab 配置。
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { recordProbeEvent } from '@tabtin/doc-editor'
import { useDocEditor, type UseDocEditorInput, type UseDocEditorReturn } from './useDocEditor'
import { useTabDocEditorConfigOptional } from './TabDocEditorConfigContext'
import { toast } from '@tabtin/smartsheet-ui'
import { subscribeDocMultiTabPresence } from './docMultiTabPresence'
import {
  useCollabProvider,
  CollabStatus,
  getUserColor,
  type CollabConnectionStatus,
  type CollabProvider,
  type CollabProviderOptions,
  type CollabPeerState,
  type CollabSyncMode,
  type CollabSyncModeReason,
  type ForceCloseMessage,
} from '@tabtin/collab-core'
import type { TabDocEventStreamEvent, TabDocEventStreamSubscription } from './ports'
import type { TabDocCollaborationUser } from './editor/collaboration-extensions'
import {
  applyExternalDocumentSaveReconcile,
  canForceReconnectAfterExternalSave,
  shouldReconcileExternalDocumentSaveForMode,
} from './externalDocumentSave'

// ── 配置 ──

let _collabRuntimeOverride: boolean | null = null

/** : 进程内所有 TabDoc 实例共享一次 collab token refresh */
let sharedCollabTokenRefreshPromise: Promise<void> | null = null

export function useCollabConfig() {
  const config = useTabDocEditorConfigOptional()
  const [, forceUpdate] = useState(0)

  const enabled = _collabRuntimeOverride ?? (config?.collab.enabled ?? false)

  const setEnabled = useCallback((v: boolean) => {
    _collabRuntimeOverride = v
    forceUpdate((n) => n + 1)
  }, [])

  return { enabled, setEnabled } as const
}

export function setCollabEnabled(v: boolean | null): void {
  _collabRuntimeOverride = v
}

// ── 类型 ──

export interface CollaborativeState {
  status: CollabStatus
  /** Provider 连接生命周期；stuck-connecting = 握手持久挂起 */
  connectionStatus: CollabConnectionStatus
  isCollaborating: boolean
  readOnly: boolean
  canEdit: boolean
  activeEditors: ActiveEditor[]
  isAgentEditing: boolean
  eventStreamStatus: string
  forceCloseMessage: ForceCloseMessage | null
  /** 协作 lastError（如 missing_collab_token），供实时/REST 路径决策 */
  lastError: string | null
  /**
   * HocuspocusProvider 世代（认证恢复重建时递增，Y.Doc 不变）。
   * 编辑器用它做 CollaborationCursor 受控 remount，避免绑定到已 destroy 的 provider。
   */
  providerGeneration: number
  isFallback: boolean
  syncMode: CollabSyncMode
  syncModeReason?: CollabSyncModeReason
  /** IndexedDB 是否已同步（ hydrate 门控） */
  isCacheReady: boolean
  /** IndexedDB 中是否有缓存内容（ hydrate 门控） */
  hasCachedContent: boolean
}

export interface ActiveEditor {
  id: string
  name: string
  type: 'user' | 'agent'
  color: string
}

export interface BlockAttribution {
  blockId: string
  editorType: 'user' | 'agent'
  editorId: string
  timestamp: number
}

export interface UseCollaborativeDocEditorReturn extends UseDocEditorReturn {
  collaborative: CollaborativeState
  blockAttributions: Map<string, BlockAttribution>
  peers: CollabPeerState[]
  ydoc: Y.Doc | null
  hocuspocusProvider: HocuspocusProvider | null
  collaborationUser: TabDocCollaborationUser | null
  triggerForceReconnect: () => void
  /**
   * 手动重连：重建底层 Provider，保留 Y.Doc 与 IndexedDB（离线编辑不丢）。
   * 挂起（STUCK_CONNECTING）/ 断线场景的用户入口；
   * 区别于 triggerForceReconnect 的丢弃语义（版本恢复/checkpoint 回滚用）。
   */
  triggerManualReconnect: () => void
}

export interface UseCollaborativeDocEditorInput extends UseDocEditorInput {
  t?: (key: string, options?: Record<string, unknown>) => string
}

export function useCollaborativeDocEditor(
  input: UseCollaborativeDocEditorInput,
): UseCollaborativeDocEditorReturn {
  const config = useTabDocEditorConfigOptional()
  const { enabled: collabEnabled } = useCollabConfig()

  const t = input.t ?? ((key: string) => key)
  const tRef = useRef(t)
  tRef.current = t
  const collabEnabledRef = useRef(collabEnabled)
  collabEnabledRef.current = collabEnabled

  const collabProviderRef = useRef<CollabProvider | null>(null)

  const triggerForceReconnect = useCallback(() => {
    try {
      collabProviderRef.current?.forceReconnect()
    } catch (err) {
      console.warn('[useCollaborativeDocEditor] forceReconnect failed:', err)
    }
  }, [])

  const triggerManualReconnect = useCallback(() => {
    try {
      collabProviderRef.current?.recoverConnection('manual')
    } catch (err) {
      console.warn('[useCollaborativeDocEditor] manual reconnect failed:', err)
    }
  }, [])

  const docEditor = useDocEditor(input)

  // ── 协作状态 ──
  const [activeEditors, setActiveEditors] = useState<ActiveEditor[]>([])
  const [isAgentEditing, setIsAgentEditing] = useState(false)
  const blockAttributions = useMemo(() => new Map<string, BlockAttribution>(), [])
  const [token, setToken] = useState<string>('')

  // ── 多标签页并发编辑检测 ──
  const multiTabToastShownRef = useRef(false)
  useEffect(() => {
    const docId = input.documentId
    multiTabToastShownRef.current = false
    if (!docId) return

    const unsubscribe = subscribeDocMultiTabPresence(docId, () => {
      if (collabEnabledRef.current || multiTabToastShownRef.current) return

      multiTabToastShownRef.current = true
      toast({
        title: tRef.current('multiTabWarning', {
          defaultValue: '此文档已在其他标签页中打开',
        }),
        description: tRef.current('multiTabWarningDesc', {
          defaultValue: '非协作模式下，多标签页同时编辑可能导致内容丢失。建议仅在一个标签页中编辑，或开启协作模式。',
        }),
        variant: 'destructive',
      })
    })

    return () => {
      unsubscribe()
      multiTabToastShownRef.current = false
    }
  }, [input.documentId])

  const currentUser = config?.auth.getCurrentUser() ?? null
  const collaborationUser = useMemo<TabDocCollaborationUser | null>(() => {
    if (!collabEnabled) return null
    const userId = currentUser?.id || 'anonymous'
    return {
      id: userId,
      name: currentUser?.nickname || currentUser?.username || currentUser?.email || t('defaultUserName'),
      color: getUserColor(userId),
      type: 'user',
    }
  }, [collabEnabled, currentUser?.id, currentUser?.nickname, currentUser?.username, currentUser?.email, t])

  useEffect(() => {
    if (!collabEnabled || !config?.auth) return
    config.auth.getAccessToken()
      .then(t => setToken(prev => t || prev))
      .catch((err: unknown) => { console.warn('[collab] getAuthToken failed:', err) })
  }, [currentUser?.id, collabEnabled, config?.auth])

  const refreshCollabToken = useCallback(async () => {
    const auth = config?.auth
    if (!auth) return

    // : 多文档同时 auth_failed 时单飞，避免串行打爆 refresh 限流
    if (sharedCollabTokenRefreshPromise) {
      await sharedCollabTokenRefreshPromise
      try {
        const nextToken = await auth.getAccessToken()
        if (nextToken) setToken(nextToken)
      } catch (err: unknown) {
        console.warn('[collab] getAccessToken after shared refresh failed:', err)
      }
      return
    }

    sharedCollabTokenRefreshPromise = (async () => {
      try {
        const refreshedToken = await auth.refreshAccessToken?.()
        const nextToken = refreshedToken || await auth.getAccessToken()
        if (nextToken) {
          setToken(nextToken)
        } else {
          console.warn('[collab] token refresh completed without an access token')
        }
      } catch (err: unknown) {
        console.warn('[collab] token refresh failed:', err)
      }
    })().finally(() => {
      sharedCollabTokenRefreshPromise = null
    })

    await sharedCollabTokenRefreshPromise
  }, [config?.auth])

  const canStartCollab = Boolean(
    collabEnabled
      && input.documentId
      && docEditor.currentDocument?.id === input.documentId
      && !docEditor.isLoadingDetail
      && !docEditor.loadError,
  )

  // ── 构建 CollabProvider 配置 ──
  const collabOptions = useMemo<CollabProviderOptions | null>(() => {
    if (!canStartCollab || !input.documentId || !token || !config?.collab.wsUrl) return null

    const userId = collaborationUser?.id || currentUser?.id || 'anonymous'
    const userName = collaborationUser?.name || t('defaultUserName')
    const userColor = collaborationUser?.color || getUserColor(userId)
    const userType = collaborationUser?.type || 'user'

    return {
      serverUrl: config.collab.wsUrl,
      documentName: `docs:${input.documentId}`,
      token,
      user: {
        id: userId,
        name: userName,
        color: userColor,
        type: userType,
      },
      enableIndexedDB: true,
      onTokenRefreshRequired: refreshCollabToken,
    }
  }, [
    canStartCollab,
    input.documentId,
    token,
    currentUser?.id,
    collaborationUser?.id,
    collaborationUser?.name,
    collaborationUser?.color,
    collaborationUser?.type,
    config?.collab.wsUrl,
    refreshCollabToken,
    t,
  ])

  // ── 核心：useCollabProvider ──
  const collab = useCollabProvider(collabOptions)

  collabProviderRef.current = collab.provider

  // 探针：协作连接状态流转（origin 由当前驱动批次决定）
  // ：附带 Y.Doc clientID / cache readiness，不含正文或 token
  const ydocClientId = collab.ydoc?.clientID ?? null
  const ydocLifecycleRef = useRef<{
    clientID: number | null
    generation: number
  }>({ clientID: null, generation: 0 })
  useEffect(() => {
    if (ydocClientId == null) {
      if (ydocLifecycleRef.current.clientID != null) {
        recordProbeEvent({
          component: 'collab',
          event: 'collab.ydoc.destroy',
          docId: input.documentId ?? undefined,
          payload: {
            clientID: ydocLifecycleRef.current.clientID,
            generation: ydocLifecycleRef.current.generation,
            status: collab.status,
          },
        })
        ydocLifecycleRef.current = { clientID: null, generation: ydocLifecycleRef.current.generation }
      }
      return
    }
    if (ydocLifecycleRef.current.clientID !== ydocClientId) {
      const generation = ydocLifecycleRef.current.generation + 1
      ydocLifecycleRef.current = { clientID: ydocClientId, generation }
      recordProbeEvent({
        component: 'collab',
        event: 'collab.ydoc.create',
        docId: input.documentId ?? undefined,
        payload: {
          clientID: ydocClientId,
          generation,
          status: collab.status,
          isCacheReady: collab.isCacheReady,
          hasCachedContent: collab.hasCachedContent,
        },
      })
    }
  }, [
    ydocClientId,
    collab.status,
    collab.isCacheReady,
    collab.hasCachedContent,
    input.documentId,
  ])

  useEffect(() => {
    recordProbeEvent({
      component: 'collab',
      event: 'collab.status',
      docId: input.documentId ?? undefined,
      payload: {
        status: collab.status,
        clientID: ydocClientId,
        generation: ydocLifecycleRef.current.generation,
        isCacheReady: collab.isCacheReady,
        hasCachedContent: collab.hasCachedContent,
      },
    })
  }, [
    collab.status,
    collab.isCacheReady,
    collab.hasCachedContent,
    ydocClientId,
    input.documentId,
  ])

  useEffect(() => {
    if (!collab.isCacheReady) return
    recordProbeEvent({
      component: 'collab',
      event: 'collab.cache-ready',
      docId: input.documentId ?? undefined,
      payload: {
        clientID: ydocClientId,
        generation: ydocLifecycleRef.current.generation,
        hasCachedContent: collab.hasCachedContent,
        status: collab.status,
      },
    })
  }, [
    collab.isCacheReady,
    collab.hasCachedContent,
    collab.status,
    ydocClientId,
    input.documentId,
  ])

  useEffect(() => {
    if (collab.status !== CollabStatus.SYNCED) return
    recordProbeEvent({
      component: 'collab',
      event: 'collab.server-synced',
      docId: input.documentId ?? undefined,
      payload: {
        clientID: ydocClientId,
        generation: ydocLifecycleRef.current.generation,
        isCacheReady: collab.isCacheReady,
        hasCachedContent: collab.hasCachedContent,
      },
    })
  }, [
    collab.status,
    collab.isCacheReady,
    collab.hasCachedContent,
    ydocClientId,
    input.documentId,
  ])

  const isFallback = collab.syncMode === 'legacy'

  const isFallbackRef = useRef(isFallback)
  isFallbackRef.current = isFallback
  const syncModeRef = useRef(collab.syncMode)
  syncModeRef.current = collab.syncMode
  const collabStatusRef = useRef(collab.status)
  collabStatusRef.current = collab.status
  const collabLastErrorRef = useRef(collab.lastError)
  collabLastErrorRef.current = collab.lastError

  const fallbackConcurrentToastShownRef = useRef(false)
  useEffect(() => {
    if (!isFallback) {
      fallbackConcurrentToastShownRef.current = false
      return
    }
    if (activeEditors.length > 1 && !fallbackConcurrentToastShownRef.current) {
      fallbackConcurrentToastShownRef.current = true
      toast({
        title: t('collabFallbackWarning', {
          defaultValue: '当前为单人模式，其他编辑者的更改可能不可见',
        }),
        description: t('collabFallbackWarningDesc', {
          defaultValue: '协作功能暂不可用，请注意保存您的工作以避免冲突。',
        }),
        variant: 'destructive',
      })
    }
  }, [isFallback, activeEditors.length, t])

  // 服务端持久化失败通知（从 Electron 版本合并）
  useEffect(() => {
    if (!collab.storeFailed) return
    recordProbeEvent({
      component: 'collab',
      event: 'collab.storeFailed',
      docId: input.documentId ?? undefined,
      payload: { message: String(collab.storeFailed) },
    })
    if (config?.collab.onStoreFailed) {
      config.collab.onStoreFailed(collab.storeFailed)
    } else {
      toast({
        title: t('storeFailed', { defaultValue: '内容保存失败，请检查网络连接' }),
        variant: 'destructive',
      })
    }
  }, [collab.storeFailed, config?.collab.onStoreFailed, t])

  useEffect(() => {
    if (collab.longOfflineDetected) {
      toast({
        id: 'collab-long-offline',
        title: t('longOfflineWarning', {
          defaultValue: '您已离线较长时间',
        }),
        description: t('longOfflineWarningDesc', {
          defaultValue: '文档内容已自动合并，建议检查是否与预期一致。如需查看 Agent 的操作记录，请切换到对话面板。',
        }),
        duration: 10000,
      })
      collab.acknowledgeLongOffline()
    }
  }, [collab.longOfflineDetected, collab.acknowledgeLongOffline, t])

  // 从 peers 同步到 activeEditors
  useEffect(() => {
    if (collab.peers.length > 0) {
      const editors: ActiveEditor[] = collab.peers.map(p => ({
        id: p.user.id,
        name: p.user.name,
        type: (p.user.type === 'agent' ? 'agent' : 'user') as 'user' | 'agent',
        color: p.user.color,
      }))
      setActiveEditors(editors)
      setIsAgentEditing(editors.some(e => e.type === 'agent'))
      recordProbeEvent({
        component: 'collab',
        event: 'collab.activeEditors',
        docId: input.documentId ?? undefined,
        payload: {
          count: editors.length,
          hasAgent: editors.some(e => e.type === 'agent'),
        },
      })
    } else {
      setActiveEditors(prev => (prev.length === 0 ? prev : []))
      setIsAgentEditing(prev => (prev ? false : prev))
    }
  }, [collab.peers, collab.status])

  const patchCurrentDocumentRef = useRef(docEditor.patchCurrentDocument)
  patchCurrentDocumentRef.current = docEditor.patchCurrentDocument
  const retryLoadRef = useRef(docEditor.retryLoad)
  retryLoadRef.current = docEditor.retryLoad
  const recoverFromExternalUpdateRef = useRef(docEditor.recoverFromExternalUpdate)
  recoverFromExternalUpdateRef.current = docEditor.recoverFromExternalUpdate
  const markAwaitingRemoteApplyRef = useRef(docEditor.markAwaitingRemoteApply)
  markAwaitingRemoteApplyRef.current = docEditor.markAwaitingRemoteApply
  const markDocumentSyncedRef = useRef(docEditor.markDocumentSynced)
  markDocumentSyncedRef.current = docEditor.markDocumentSynced
  const documentSyncStateRef = useRef(docEditor.syncState)
  documentSyncStateRef.current = docEditor.syncState
  const autoSaveControllerRef = docEditor.autoSaveControllerRef
  const saveStateRef = useRef(docEditor.saveState)
  saveStateRef.current = docEditor.saveState
  const localVersionRef = useRef(docEditor.currentDocument?.latest_version)
  localVersionRef.current = docEditor.currentDocument?.latest_version

  useEffect(() => {
    const ydoc = collab.ydoc
    if (!ydoc) return
    const onUpdate = () => {
      if (documentSyncStateRef.current === 'awaiting_remote_apply') {
        markDocumentSyncedRef.current()
      }
    }
    ydoc.on('update', onUpdate)
    return () => ydoc.off('update', onUpdate)
  }, [collab.ydoc])

  // ── 文档事件流（Gateway doc.events.*；协作/非协作均订阅以处理外部 save-content） ──
  const handleDocEvent = useCallback((event: TabDocEventStreamEvent) => {
    switch (event.event) {
      case 'doc.events.editor': {
        const { editor_type, editor_id, editor_name, action } = event.data || {}
        if (editor_type === 'agent') {
          setIsAgentEditing(action === 'start')
        }
        if (action === 'start') {
          setActiveEditors(prev => {
            if (prev.some(e => e.id === editor_id)) return prev
            return [...prev, {
              id: (editor_id as string) || '',
              name: (editor_name as string) || (editor_type === 'agent' ? t('agentName') : t('defaultUserName')),
              type: (editor_type === 'agent' ? 'agent' : 'user') as 'user' | 'agent',
              color: editor_type === 'agent' ? '#8b5cf6' : '#3b82f6',
            }]
          })
        } else if (action === 'stop') {
          setActiveEditors(prev => prev.filter(e => e.id !== editor_id))
        }
        break
      }
      case 'doc.events.save': {
        const { latest_version, updated_at } = event.data || {}
        const patch: { latest_version?: number; updated_at?: string | null } = {}
        if (typeof latest_version === 'number') {
          patch.latest_version = latest_version
        }
        // : 同步 updated_at，避免标题 PATCH 带着过期 base_updated_at 打出同版本伪冲突
        if (typeof updated_at === 'string') {
          patch.updated_at = updated_at
        }
        // React saveState can lag one render behind the synchronous autosave controller.
        const isAutoSaveInFlight = Boolean(autoSaveControllerRef.current?.isSaving())
        if (isAutoSaveInFlight) {
          if (Object.keys(patch).length > 0) {
            patchCurrentDocumentRef.current(patch)
          }
          break
        }
        const shouldReconcile = shouldReconcileExternalDocumentSaveForMode({
          syncMode: syncModeRef.current,
          incomingVersion: latest_version,
          localVersion: localVersionRef.current,
          saveState: saveStateRef.current,
          collabStatus: collabStatusRef.current,
          collabLastError: collabLastErrorRef.current,
        })
        const hasUnsavedLegacyDraft = Boolean(autoSaveControllerRef.current?.isDirty())
        if (shouldReconcile && hasUnsavedLegacyDraft) {
          // Preserve before advancing the local version baseline.  A patch here
          // used to make the following retry overwrite the remote document.
          void recoverFromExternalUpdateRef.current().then((resolution) => {
            if (resolution.action === 'blocked') {
              triggerForceReconnect()
            }
          })
          break
        }
        if (Object.keys(patch).length > 0) {
          patchCurrentDocumentRef.current(patch)
        }
        if (shouldReconcile) {
          applyExternalDocumentSaveReconcile({
            retryLoad: () => retryLoadRef.current(),
            triggerForceReconnect,
            collabEnabled: collabEnabledRef.current,
            isFallback: !collabEnabledRef.current || isFallbackRef.current,
            canForceReconnect: canForceReconnectAfterExternalSave({
              collabEnabled: collabEnabledRef.current,
              isFallback: !collabEnabledRef.current || isFallbackRef.current,
              collabStatus: collabStatusRef.current,
              collabLastError: collabLastErrorRef.current,
            }),
          })
        } else if (typeof latest_version === 'number' && latest_version > (localVersionRef.current ?? -1)) {
          markAwaitingRemoteApplyRef.current()
        }
        break
      }
    }
  }, [t, triggerForceReconnect])

  // 旧事件流：仍可接收元数据/活动状态；内容 reconcile 按协作健康状态决策。
  const [eventStreamStatus, setEventStreamStatus] = useState('idle')
  const eventStreamSubRef = useRef<TabDocEventStreamSubscription | null>(null)

  useEffect(() => {
    if (!input.documentId || !config?.eventStream) {
      eventStreamSubRef.current?.unsubscribe()
      eventStreamSubRef.current = null
      setEventStreamStatus('idle')
      return
    }

    const sub = config.eventStream.subscribe(input.documentId, handleDocEvent)
    eventStreamSubRef.current = sub

    const interval = setInterval(() => {
      setEventStreamStatus(sub.status)
    }, 1000)

    return () => {
      clearInterval(interval)
      sub.unsubscribe()
      eventStreamSubRef.current = null
    }
  }, [input.documentId, config?.eventStream, handleDocEvent])

  // 降级转换时将 Y.Doc 内容刷新到 IndexedDB
  const prevFallbackRef = useRef(isFallback)
  useEffect(() => {
    if (isFallback && !prevFallbackRef.current && collab.provider) {
      collab.provider.flushToIndexedDB().catch((err) => {
        console.error('[useCollaborativeDocEditor] flushToIndexedDB failed:', err)
        toast({
          title: t('idbFlushFailed', {
            defaultValue: '本地缓存写入失败',
          }),
          description: t('idbFlushFailedDesc', {
            defaultValue: '编辑内容可能未保存到本地，请确保网络连接正常以同步到服务器。',
          }),
          variant: 'destructive',
        })
      })
    }
    prevFallbackRef.current = isFallback
  }, [isFallback, collab.provider, t])

  useEffect(() => {
    if (!collab.provider || collab.status === CollabStatus.FORCE_CLOSED) return
    const timer = setInterval(() => {
      collab.provider?.flushToIndexedDB().catch(() => {})
    }, 5_000)
    return () => clearInterval(timer)
  }, [collab.provider, collab.status])

  useEffect(() => {
    if (!collab.provider) return
    const handler = () => {
      collab.provider?.flushToIndexedDB().catch(() => {})
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [collab.provider])

  // ── 暴露 Y.Doc 和 HocuspocusProvider 给编辑器 ──
  const ydoc = (!isFallback && collab.ydoc) ? collab.ydoc : null
  const hocuspocusProvider = (!isFallback && collab.provider)
    ? collab.provider.getProvider()
    : null

  // ── 组合返回 ──
  const isCollaborating = collab.status === CollabStatus.SYNCED || collab.status === CollabStatus.SYNCING

  // linked worktree 验证时常把 node_modules junction 到主仓；主仓 dist 可能尚无该字段，运行时从 provider state 兜底
  const providerGeneration = (() => {
    const fromHook = (collab as { providerGeneration?: number }).providerGeneration
    if (typeof fromHook === 'number') return fromHook
    const fromProvider = collab.provider?.getState() as { providerGeneration?: number } | undefined
    return fromProvider?.providerGeneration ?? 0
  })()

  const collaborative = useMemo<CollaborativeState>(() => ({
    status: collab.status,
    connectionStatus: collab.connectionStatus,
    isCollaborating,
    readOnly: collab.readOnly,
    canEdit: collab.canEdit,
    activeEditors,
    isAgentEditing,
    eventStreamStatus: config?.eventStream ? eventStreamStatus : collab.status,
    forceCloseMessage: collab.forceCloseMessage,
    lastError: collab.lastError ?? null,
    providerGeneration,
    isFallback,
    syncMode: collab.syncMode,
    syncModeReason: collab.syncModeReason,
    isCacheReady: collab.isCacheReady,
    hasCachedContent: collab.hasCachedContent,
  }), [
    collab.status,
    collab.connectionStatus,
    isCollaborating,
    collab.readOnly,
    collab.canEdit,
    activeEditors,
    isAgentEditing,
    config?.eventStream,
    eventStreamStatus,
    collab.forceCloseMessage,
    collab.lastError,
    providerGeneration,
    isFallback,
    collab.syncMode,
    collab.syncModeReason,
    collab.isCacheReady,
    collab.hasCachedContent,
  ])

  return {
    ...docEditor,
    collaborative,
    blockAttributions,
    peers: collab.peers,
    ydoc,
    hocuspocusProvider,
    collaborationUser,
    triggerForceReconnect,
    triggerManualReconnect,
  }
}

// Re-export 协作相关类型，让宿主无需直接依赖 yjs / @hocuspocus/provider
export type { Doc as YDoc } from 'yjs'
export type { HocuspocusProvider } from '@hocuspocus/provider'
export type { TabDocCollaborationUser } from './editor/collaboration-extensions'

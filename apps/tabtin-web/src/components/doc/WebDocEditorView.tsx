/**
 * WebDocEditorView — Web 端文档编辑器
 *
 * 基于共享的 DocEditorViewShell 渲染，无宿主特有扩展。
 */
import '@tabtin/tabdoc-ui/editor/prosemirror.css'
import './web-doc-mobile.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Eye, Pencil } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui/toast'
import {
  RemovedFromResourceOverlay,
  useResourceShareDowngrade,
  isPermissionInsufficientForEditing,
  shouldShowRemovedOverlay,
  selectResourceShareNotifications,
} from '@tabtin/smartsheet-ui'
import { useNavigate } from 'react-router-dom'
import type { TabdocDocument } from '@tabtin/tabdoc-ui/api-client'
import type { SaveState } from '@tabtin/tabdoc-ui/use-doc-editor'
import {
  useDocEditorViewState,
  DocEditorViewShell,
} from '@tabtin/tabdoc-ui/editor'
import type {
  CollaborativeState,
  YDoc,
  HocuspocusProvider,
  TabDocCollaborationUser,
} from '@tabtin/tabdoc-ui/use-collaborative-doc-editor'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { useNotificationStore } from '@/stores/useNotificationStore'
import { buildPublicShareUrlPrefix } from '@/config/api'
import { useWebPresentation } from '@/components/layout/WebPresentationContext'
import {
  isPhoneWebPresentation,
  isTabletWebPresentation,
} from '@/components/layout/WebPresentationEnvironment'
import {
  resolveMobileDocAccess,
  resolveMobileEditorAvailableHeight,
  type MobileDocMode,
} from './mobileDocPresentation'

interface WebDocEditorViewProps {
  document: TabdocDocument | null
  initialPmJson: Record<string, unknown>
  initialMarkdown: string
  editorKey: number
  isLoading: boolean
  saveState: SaveState
  saveMessage: string
  showRevisions: boolean
  onEditorUpdate: (markdown: string, pmJson: Record<string, unknown>) => void
  onDraftSync?: (markdown: string, pmJson: Record<string, unknown>) => void
  onManualSave: () => void
  onToggleRevisions: () => void
  onTitleChange?: (newTitle: string) => void
  onDocumentPropertyChange?: (
    updates: Record<string, unknown>,
    options?: { silentError?: boolean },
  ) => void | Promise<void>
  onContentFlushedBeforeExport?: (document: Partial<TabdocDocument>) => void
  getSaveBaseline?: () => { baseVersion: number | null; baseUpdatedAt: string | null }
  onSaveVersion?: () => void
  ydoc?: YDoc | null
  hocuspocusProvider?: HocuspocusProvider | null
  collaborationUser?: TabDocCollaborationUser | null
  collaborative?: CollaborativeState | null
  loadError?: string | null
  onRetryLoad?: () => void
}

function useAdaptiveDocViewportHeight(adaptive: boolean) {
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !adaptive) return

    const visualViewport = window.visualViewport
    if (!visualViewport) return

    let animationFrame = 0
    const updateAvailableHeight = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        const availableHeight = resolveMobileEditorAvailableHeight({
          viewportOffsetTop: visualViewport.offsetTop,
          viewportHeight: visualViewport.height,
          containerTop: surface.getBoundingClientRect().top,
        })
        if (availableHeight !== null) {
          surface.style.setProperty('--tabdoc-mobile-available-height', `${availableHeight}px`)
        }
      })
    }

    updateAvailableHeight()
    visualViewport.addEventListener('resize', updateAvailableHeight)
    visualViewport.addEventListener('scroll', updateAvailableHeight)
    window.addEventListener('resize', updateAvailableHeight)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      visualViewport.removeEventListener('resize', updateAvailableHeight)
      visualViewport.removeEventListener('scroll', updateAvailableHeight)
      window.removeEventListener('resize', updateAvailableHeight)
      surface.style.removeProperty('--tabdoc-mobile-available-height')
    }
  }, [adaptive])

  return surfaceRef
}

export function WebDocEditorView({
  document: doc,
  initialPmJson,
  initialMarkdown,
  editorKey,
  isLoading,
  saveState,
  saveMessage,
  showRevisions,
  onEditorUpdate,
  onDraftSync,
  onManualSave,
  onToggleRevisions,
  onTitleChange,
  onDocumentPropertyChange,
  onContentFlushedBeforeExport,
  getSaveBaseline,
  onSaveVersion,
  ydoc,
  hocuspocusProvider,
  collaborationUser,
  collaborative,
  loadError,
  onRetryLoad,
}: WebDocEditorViewProps) {
  const { t } = useTranslation('tabdoc')
  const client = useAppHostClient()
  const { layout, input, mobileHost } = useWebPresentation()
  const tablet = isTabletWebPresentation({ layout, input, mobileHost })
  // 原生宿主声明的 tablet 优先于瞬时窄窗口，避免分屏时误显示手机 modebar。
  const compact = !tablet && isPhoneWebPresentation({ layout, mobileHost })
  const [requestedMobileMode, setRequestedMobileMode] = useState<MobileDocMode>('reading')
  const surfaceRef = useAdaptiveDocViewportHeight(compact || tablet)

  const collabStatus = collaborative && !collaborative.isFallback ? collaborative.status : null

  // D10 + Wave 5 §D：后端 GET /tabdoc/documents/{id} 已回填 current_user_role；
  // 这是 SSOT，前端不再做 owner_id / organization role 旁路。
  const currentUserRole = doc?.current_user_role
  const canManageShare = useMemo(() => {
    const role = currentUserRole
    return role === 'owner' || role === 'admin'
  }, [currentUserRole])
  const organizationIdForShare = doc?.organization_id || client.getOrganizationId() || ''

  // Wave 4 F6 (PRD §五块 2.3 末段):订阅 NotificationStore,实时降级响应。
  // 订阅整个 notifications(store 内引用稳定),外层 useMemo 派生 — 避免 selector 每次返回新数组
  // 触发 zustand v5 + React useSyncExternalStore 的 "getSnapshot should be cached" 无限循环。
  const navigate = useNavigate()
  const allNotifications = useNotificationStore((s) => s.notifications)
  const resourceNotifications = useMemo(
    () => selectResourceShareNotifications(allNotifications, 'doc', doc?.id ?? null),
    [allNotifications, doc?.id],
  )
  const downgrade = useResourceShareDowngrade('doc', doc?.id ?? null, resourceNotifications)
  const downgradeInsufficient = isPermissionInsufficientForEditing(downgrade.changedPermission)
  // ：仅当 role 在 removed 通知之后重新拉取确认 viewer+ 时，才压住历史遮罩
  const [roleFetchedAtMs, setRoleFetchedAtMs] = useState(0)
  useEffect(() => {
    if (doc?.id && currentUserRole) {
      setRoleFetchedAtMs(Date.now())
    }
  }, [doc?.id, currentUserRole])
  const showRemovedOverlay = shouldShowRemovedOverlay({
    isRemoved: downgrade.isRemoved,
    role: currentUserRole,
    removedAt: downgrade.sourceCreatedAt,
    roleFetchedAtMs,
  })

  // 权限降级 toast — 仅当从 editor+ 降到 viewer 时触发一次
  const lastToastedNotifIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!downgradeInsufficient || !downgrade.sourceNotificationId) return
    if (lastToastedNotifIdRef.current === downgrade.sourceNotificationId) return
    lastToastedNotifIdRef.current = downgrade.sourceNotificationId
    const permLabel = downgrade.changedPermission
      ? t(`share.permission.${downgrade.changedPermission}Label`, {
          ns: 'common',
          defaultValue: downgrade.changedPermission,
        })
      : ''
    toast({
      title: t('share.editor.permissionChanged.toast', {
        ns: 'common',
        permission: permLabel,
        defaultValue: `你的权限已变更为 ${permLabel},编辑器已切换为只读`,
      }) as string,
    })
  }, [downgradeInsufficient, downgrade.sourceNotificationId, downgrade.changedPermission, t])

  // 返回空间:路由回到 SpaceHome
  const handleReturnFromRemoved = useCallback(() => {
    const wtId = doc?.organization_id
    const spId = doc?.space_id
    if (wtId && spId) {
      navigate(`/organizations/${wtId}/spaces/${spId}`)
    } else if (spId) {
      navigate(`/spaces/${spId}`)
    } else {
      navigate('/')
    }
  }, [doc?.organization_id, doc?.space_id, navigate])

  const roleReadonly = isPermissionInsufficientForEditing(currentUserRole)
  const collabReadonly = Boolean(collaborative && !collaborative.isFallback && collaborative.readOnly)
  const effectiveReadonly = Boolean(roleReadonly || collabReadonly || downgradeInsufficient)
  const mobileAccess = resolveMobileDocAccess({
    compact,
    canEdit: !effectiveReadonly,
    requestedMode: requestedMobileMode,
  })
  const surfaceReadonly = effectiveReadonly || mobileAccess.readOnly

  useEffect(() => {
    if (effectiveReadonly) setRequestedMobileMode('reading')
  }, [effectiveReadonly])

  useEffect(() => {
    setRequestedMobileMode('reading')
  }, [doc?.id, editorKey])

  const guardedEditorUpdate = useCallback((markdown: string, pmJson: Record<string, unknown>) => {
    if (surfaceReadonly) return
    onEditorUpdate(markdown, pmJson)
  }, [surfaceReadonly, onEditorUpdate])

  const guardedDraftSync = useCallback((markdown: string, pmJson: Record<string, unknown>) => {
    if (surfaceReadonly) return
    onDraftSync?.(markdown, pmJson)
  }, [surfaceReadonly, onDraftSync])

  const guardedManualSave = useCallback(() => {
    if (surfaceReadonly) return
    onManualSave()
  }, [surfaceReadonly, onManualSave])

  const guardedSaveVersion = useCallback(() => {
    if (surfaceReadonly) return
    onSaveVersion?.()
  }, [surfaceReadonly, onSaveVersion])

  const viewState = useDocEditorViewState({
    document: doc,
    initialPmJson,
    initialMarkdown,
    editorKey,
    isLoading,
    saveState,
    saveMessage,
    showRevisions,
    onEditorUpdate: guardedEditorUpdate,
    onDraftSync: guardedDraftSync,
    onManualSave: guardedManualSave,
    onToggleRevisions,
    onTitleChange,
    onDocumentPropertyChange,
    onContentFlushedBeforeExport,
    getSaveBaseline,
    onSaveVersion: guardedSaveVersion,
    ydoc,
    hocuspocusProvider,
    collaborationUser,
    collaborative,
    t: (key, opts) => t(key, opts) as string,
    toolbarExtraProps: {
      collabStatus,
      organizationId: organizationIdForShare,
      shareUrlPrefix: buildPublicShareUrlPrefix('doc'),
      canManage: canManageShare,
      canEdit: !surfaceReadonly,
    },
  })

  // F6: 实时降级时叠加 editable=false,覆盖默认 editorProps
  const downgradeAwareEditorProps = useMemo(
    () => ({
      ...viewState.editorProps,
      editable: () => !surfaceReadonly,
    }),
    [viewState.editorProps, surfaceReadonly],
  )

  return (
    <div
      ref={surfaceRef}
      className={`web-doc-surface flex h-full min-h-0 flex-col web-doc-surface--${mobileAccess.mode}${compact ? ' web-doc-surface--phone' : ''}${tablet ? ' web-doc-surface--tablet' : ''}`}
      data-mobile-doc-mode={compact ? mobileAccess.mode : undefined}
      data-web-doc-layout={layout}
    >
      <div
        className="web-doc-mobile-modebar"
        role="toolbar"
        aria-label={t('mobile.modeToolbar', { defaultValue: '阅读与编辑模式' })}
      >
        <span className="web-doc-mobile-mode-label" aria-live="polite">
          {mobileAccess.mode === 'editing' ? (
            <><Pencil aria-hidden="true" />{t('mobile.editing', { defaultValue: '编辑中' })}</>
          ) : (
            <><Eye aria-hidden="true" />{t('mobile.reading', { defaultValue: '阅读模式' })}</>
          )}
        </span>
        {mobileAccess.mode === 'editing' ? (
          <button type="button" onClick={() => setRequestedMobileMode('reading')}>
            <Check aria-hidden="true" />
            {t('mobile.finishEditing', { defaultValue: '完成' })}
          </button>
        ) : mobileAccess.canEnterEditMode ? (
          <button type="button" onClick={() => setRequestedMobileMode('editing')}>
            <Pencil aria-hidden="true" />
            {t('mobile.startEditing', { defaultValue: '编辑' })}
          </button>
        ) : (
          <span className="web-doc-mobile-readonly">
            {t('mobile.readonly', { defaultValue: '只读' })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <DocEditorViewShell
          document={doc}
          isLoading={isLoading}
          loadError={loadError}
          onRetryLoad={onRetryLoad}
          showRevisions={showRevisions}
          ydoc={ydoc}
          t={(key, opts) => t(key, opts) as string}
          viewState={viewState}
          editorProps={downgradeAwareEditorProps}
          readOnly={surfaceReadonly}
        >
          {/* Wave 4 F6: 被移出资源后的全屏遮罩（ 有实时权限时不盖） */}
          {showRemovedOverlay && doc && (
            <RemovedFromResourceOverlay
              resourceTitle={downgrade.resourceTitle || doc.title || ''}
              action={downgrade.removalAction || 'removed'}
              onReturn={handleReturnFromRemoved}
              t={(key: string, opts?: Record<string, unknown>) => t(key, { ns: 'common', ...(opts ?? {}) }) as string}
            />
          )}
        </DocEditorViewShell>
      </div>
    </div>
  )
}

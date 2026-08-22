import React, { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, OVERLAY_SURFACE_CLASS } from '@tabtin/smartsheet-ui'

import type { OverlayConfirmPayload, OverlayGlobalSearchPayload, OverlayNotificationPayload, OverlayUpdatePromptPayload } from '@shared/overlay/types'
import { invalidateNotifications } from '@/hooks/queries/notification'
import { useInvitationInboxStore } from '@stores/useInvitationInboxStore'
import { useNotificationStore } from '@stores/useNotificationStore'
import type { NotificationItem } from '@services/notificationApi'
import { GlobalSearch } from '@components/global-search/GlobalSearch'
import { SavePasswordBar } from '@components/crawl/SavePasswordBar'
import { AutofillSuggestionOverlay } from '@components/crawl/AutofillSuggestionOverlay'
import { OverlayToaster } from './components/OverlayToaster'
import { OverlayNotificationPanel } from './components/OverlayNotificationPanel'
import { UpdatePromptOverlay } from './components/UpdatePromptOverlay'
import { applyOverlayLocale } from '@/utils/overlayLocaleSync'
import { useOverlayPushListener } from './hooks/useOverlayPushListener'

type OverlayRole = 'modal' | 'toast'

type ConfirmState = Omit<OverlayConfirmPayload, 'type'>
type GlobalSearchContext = {
  organizationId: string | null
  activeSpaceId: string | null
  tabScopeKey: string | null
}

function resolveRole(): OverlayRole {
  if (typeof window === 'undefined') return 'toast'
  const role = new URLSearchParams(window.location.search).get('role')
  return role === 'modal' ? 'modal' : 'toast'
}

function readLocalNotifications(payload: OverlayNotificationPayload): NotificationItem[] {
  if (!Array.isArray(payload.localNotifications)) return []
  return payload.localNotifications.filter((item): item is NotificationItem => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<NotificationItem>
    return typeof candidate.id === 'string'
      && candidate.id.startsWith('local-')
      && typeof candidate.type === 'string'
      && typeof candidate.title === 'string'
      && typeof candidate.created_at === 'string'
      && typeof candidate.is_read === 'boolean'
  })
}

/**
 * Toast 层 — 跑在透明 toast 子窗口（全屏透明、默认整窗鼠标穿透）。
 * 卡片带 `data-overlay-track`，悬停时临时取消穿透以便关闭钮可点。
 * 子窗口铺满主窗口，CSS 顶部居中即正确定位，无需 bounds reporter。
 */
function OverlayToastLayer() {
  useOverlayPushListener()
  return <OverlayToaster />
}

/**
 * 全屏模态层 — 跑在透明子 BrowserWindow（窗口级合成，半透明 mask 真透出底层网页）。
 */
function OverlayModalLayer() {
  const queryClient = useQueryClient()
  const initShownListener = useNotificationStore((state) => state.initShownListener)
  const replaceLocalNotifications = useNotificationStore((state) => state.replaceLocalNotifications)
  const refreshPendingInvitations = useInvitationInboxStore((state) => state.refreshPending)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [globalSearchContext, setGlobalSearchContext] = useState<GlobalSearchContext>({
    organizationId: null,
    activeSpaceId: null,
    tabScopeKey: null,
  })
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [updatePrompt, setUpdatePrompt] = useState<OverlayUpdatePromptPayload | null>(null)
  const [notification, setNotification] = useState<OverlayNotificationPayload | null>(null)

  React.useEffect(() => initShownListener(), [initShownListener])

  const listenerOptions = useMemo(
    () => ({
      onGlobalSearchChange: (open: boolean, payload: OverlayGlobalSearchPayload) => {
        setGlobalSearchOpen(open)
        setGlobalSearchContext({
          organizationId: payload.organizationId ?? null,
          activeSpaceId: payload.activeSpaceId ?? null,
          tabScopeKey: payload.tabScopeKey ?? null,
        })
      },
      onConfirmOpen: (state: OverlayConfirmPayload | null) =>
        setConfirmState(state ? { ...state } : null),
      onUpdatePromptChange: setUpdatePrompt,
      onNotificationChange: (payload: OverlayNotificationPayload | null) => {
        if (payload) {
          applyOverlayLocale(payload.locale)
          replaceLocalNotifications(readLocalNotifications(payload))
        }
        setNotification(payload)
      },
      // ：主窗 WS 新通知 → 本窗独立 QueryClient 重拉 list/unread + 邀请卡
      onNotificationRefresh: () => {
        invalidateNotifications(queryClient)
        void refreshPendingInvitations()
      },
    }),
    [queryClient, refreshPendingInvitations, replaceLocalNotifications],
  )
  useOverlayPushListener(listenerOptions)

  const resolveConfirm = useCallback((confirmed: boolean) => {
    setConfirmState((current) => {
      if (current) {
        window.tabtin?.overlay?.sendConfirmResult?.({
          type: 'confirm-result',
          requestId: current.requestId,
          confirmed,
        })
      }
      return null
    })
  }, [])

  // 子窗口模态需要捕获点击（clickaway + 按钮）；overlay.html 的 #root 是
  // pointer-events:none（toast 穿透用），这里用 auto wrapper 覆盖，让 fixed
  // 子元素（DOM 上继承本 wrapper）能响应鼠标。
  return (
    <div className="pointer-events-auto">
      {globalSearchOpen ? (
        <GlobalSearch
          open={globalSearchOpen}
          organizationId={globalSearchContext.organizationId}
          activeSpaceId={globalSearchContext.activeSpaceId}
          tabScopeKey={globalSearchContext.tabScopeKey}
          onClose={() => {
            setGlobalSearchOpen(false)
            window.tabtin?.overlay?.syncGlobalSearchClosed?.()
          }}
        />
      ) : null}
      {confirmState ? (
        <OverlayConfirmCard state={confirmState} onResolve={resolveConfirm} />
      ) : null}
      {updatePrompt?.state ? (
        <UpdatePromptOverlay state={updatePrompt.state} />
      ) : null}
      {notification ? (
        <OverlayNotificationPanel
          open
          anchor={notification.anchor}
          organizationId={notification.organizationId ?? null}
          onClose={() => {
            setNotification(null)
            window.tabtin?.overlay?.notificationClosed?.()
          }}
        />
      ) : null}
      {/* 保存密码提示条 + 自动填充建议——都需要可点交互，跑在
          modal 子窗口（focusable、真捕获点击）。各自订阅主进程发来的
          `credential-vault:save-prompt` / `credential-vault:autofill-suggest`，并在
          有可见内容时通过 overlay.setModalSourceOpen 驱动 modal 子窗口 show/hide。 */}
      <SavePasswordBar />
      <AutofillSuggestionOverlay />
    </div>
  )
}

function OverlayConfirmCard({
  state,
  onResolve,
}: {
  state: ConfirmState
  onResolve: (confirmed: boolean) => void
}) {
  return (
    <div
      className="pointer-events-auto fixed inset-0 z-global flex items-center justify-center"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="overlay-confirm-title"
    >
      <div
        className="absolute inset-0 bg-modal-scrim"
        aria-hidden="true"
        onClick={() => onResolve(false)}
      />
      <div className={`relative z-10 mx-4 w-full max-w-md rounded-interactive p-6 ${OVERLAY_SURFACE_CLASS}`}>
        <h2 id="overlay-confirm-title" className="text-title font-semibold leading-none tracking-tight">
          {state.title}
        </h2>
        {state.description ? (
          <p className="mt-2 text-body text-muted-foreground">{state.description}</p>
        ) : null}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2">
          <Button variant="outline" onClick={() => onResolve(false)}>
            {state.cancelLabel ?? '取消'}
          </Button>
          <Button
            variant={state.destructive ? 'destructive' : 'default'}
            onClick={() => onResolve(true)}
          >
            {state.confirmLabel ?? '确认'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function OverlayApp() {
  const role = resolveRole()
  return role === 'modal' ? <OverlayModalLayer /> : <OverlayToastLayer />
}

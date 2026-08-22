import { useEffect } from 'react'

import { getMessageController, message } from '@tabtin/smartsheet-ui/toast'
import type {
  OverlayConfirmPayload,
  OverlayGlobalSearchPayload,
  OverlayNotificationPayload,
  OverlayNotificationRefreshPayload,
  OverlayPushPayload,
  OverlayToastControlPayload,
  OverlayToastPayload,
  OverlayUpdatePromptPayload,
} from '@shared/overlay/types'

type UseOverlayPushListenerOptions = {
  onGlobalSearchChange?: (open: boolean, payload: OverlayGlobalSearchPayload) => void
  onConfirmOpen?: (state: OverlayConfirmPayload | null) => void
  onUpdatePromptChange?: (state: OverlayUpdatePromptPayload | null) => void
  onNotificationChange?: (state: OverlayNotificationPayload | null) => void
  onNotificationRefresh?: (payload: OverlayNotificationRefreshPayload) => void
}

const TOAST_VIEWPORT_CENTER_X_VAR = '--tabtin-toast-viewport-center-x'
const TOAST_VIEWPORT_WIDTH_VAR = '--tabtin-toast-viewport-width'

function syncToastViewport(payload: OverlayToastPayload): void {
  const root = document.documentElement
  const viewport = payload.viewport
  if (!viewport || viewport.width <= 0) {
    root.style.removeProperty(TOAST_VIEWPORT_CENTER_X_VAR)
    root.style.removeProperty(TOAST_VIEWPORT_WIDTH_VAR)
    return
  }
  root.style.setProperty(TOAST_VIEWPORT_CENTER_X_VAR, `${Math.round(viewport.centerX)}px`)
  root.style.setProperty(TOAST_VIEWPORT_WIDTH_VAR, `${Math.round(viewport.width)}px`)
}

function variantToType(
  variant: OverlayToastPayload['variant'] | undefined,
): 'info' | 'success' | 'error' | 'warning' {
  if (variant === 'destructive') return 'error'
  if (variant === 'success') return 'success'
  if (variant === 'warning') return 'warning'
  return 'info'
}

function handleToastPayload(payload: OverlayToastPayload): void {
  syncToastViewport(payload)
  message.open({
    key: payload.id,
    type: variantToType(payload.variant),
    content: payload.title,
    description: payload.description,
    duration: payload.duration,
  })
}

function handleToastControl(payload: OverlayToastControlPayload): void {
  if (payload.action === 'destroy-all') {
    message.destroy()
    return
  }
  if (payload.action === 'destroy') {
    if (payload.id) message.destroy(payload.id)
    return
  }
  if (payload.action === 'update' && payload.id) {
    const controller = getMessageController()
    const existing = controller
      .getItems()
      .find((item) => item.key === payload.id && item.open !== false)

    if (existing) {
      // 只覆盖明确下发的字段，避免 undefined 冲掉原 type/文案/常驻 duration
      controller.update({
        key: payload.id,
        ...(payload.variant !== undefined ? { type: variantToType(payload.variant) } : {}),
        ...(payload.title !== undefined ? { content: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.duration !== undefined ? { duration: payload.duration } : {}),
      })
      return
    }

    message.open({
      key: payload.id,
      type: payload.variant !== undefined ? variantToType(payload.variant) : 'info',
      content: payload.title,
      description: payload.description,
      duration: payload.duration,
    })
  }
}

export function useOverlayPushListener(options: UseOverlayPushListenerOptions = {}): void {
  useEffect(() => {
    const unsubscribe = window.tabtin?.overlay?.subscribePush?.((payload: OverlayPushPayload) => {
      if (payload.type === 'toast') {
        handleToastPayload(payload)
        return
      }
      if (payload.type === 'toast-control') {
        handleToastControl(payload)
        return
      }
      if (payload.type === 'global-search') {
        options.onGlobalSearchChange?.(payload.open, payload)
        if (payload.open) {
          window.tabtin?.overlay?.focusOverlay?.()
        }
        return
      }
      if (payload.type === 'confirm') {
        options.onConfirmOpen?.(payload)
        window.tabtin?.overlay?.focusOverlay?.()
        return
      }
      if (payload.type === 'update-prompt') {
        options.onUpdatePromptChange?.(payload.open ? payload : null)
        if (payload.open) {
          window.tabtin?.overlay?.focusOverlay?.()
        }
        return
      }
      if (payload.type === 'notification') {
        // modal renderer 拥有独立 QueryClient，且通知到达时窗口可能尚未 ready，
        // 会漏掉 notification-refresh。每次打开都先把列表与未读缓存标脏，
        // 再挂载面板触发权威重拉，避免入口/弹窗/详情出现 2/1/2 分叉。
        if (payload.open) {
          options.onNotificationRefresh?.({
            type: 'notification-refresh',
            organizationId: payload.organizationId,
          })
        }
        options.onNotificationChange?.(payload.open ? payload : null)
        if (payload.open) {
          window.tabtin?.overlay?.focusOverlay?.()
        }
        return
      }
      if (payload.type === 'notification-refresh') {
        options.onNotificationRefresh?.(payload)
      }
    })
    const readyTimer = window.setTimeout(() => {
      window.tabtin?.overlay?.notifyReady?.()
    }, 0)

    return () => {
      window.clearTimeout(readyTimer)
      unsubscribe?.()
    }
  }, [options])
}

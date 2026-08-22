import type { OverlayConfirmPayload, OverlayPushPayload, OverlayToastPayload } from '@shared/overlay/types'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { GLOBAL_SEARCH_UI_ENABLED } from '@/utils/featureFlags'

export type NotifyConfirmOptions = Omit<OverlayConfirmPayload, 'type' | 'requestId'>

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export const notify = {
  toast(payload: Omit<OverlayToastPayload, 'type'>): void {
    void window.tabtin?.overlay?.push({
      type: 'toast',
      ...payload,
    })
  },

  openGlobalSearch(): void {
    if (!GLOBAL_SEARCH_UI_ENABLED) return
    void window.tabtin?.overlay?.push({
      type: 'global-search',
      open: true,
      organizationId: useOrganizationStore.getState().selectedOrganization?.id ?? null,
      activeSpaceId: useSpaceStore.getState().selectedSpace?.id ?? null,
    })
  },

  closeGlobalSearch(): void {
    void window.tabtin?.overlay?.push({ type: 'global-search', open: false })
  },

  async confirm(options: NotifyConfirmOptions): Promise<boolean> {
    const overlay = window.tabtin?.overlay
    if (!overlay?.push || !overlay.onConfirmResult) {
      return window.confirm([options.title, options.description].filter(Boolean).join('\n\n'))
    }

    const requestId = createRequestId()
    return new Promise((resolve) => {
      const unsubscribe = overlay.onConfirmResult((result) => {
        if (result.requestId !== requestId) return
        unsubscribe()
        resolve(result.confirmed)
      })

      void overlay.push({ type: 'confirm', requestId, ...options })
    })
  },

  push(payload: OverlayPushPayload): void {
    void window.tabtin?.overlay?.push(payload)
  },
}

export type { OverlayPushPayload }

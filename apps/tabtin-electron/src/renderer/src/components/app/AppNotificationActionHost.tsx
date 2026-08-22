import { useEffect } from 'react'
import { toast } from '@tabtin/smartsheet-ui/toast'

import type { OverlayNotificationActionPayload } from '@shared/overlay/types'
import { useInvitationInboxStore } from '@stores/useInvitationInboxStore'
import { useNotificationStore } from '@stores/useNotificationStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useMarkReadMutation, useMarkAllReadMutation } from '@/hooks/queries/notification'
import { navigateToTarget } from '@services/notificationNavigation'
import type { NotificationItem } from '@services/notificationApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('NotificationCenter')

/**
 * 通知面板动作执行宿主（主 renderer）。
 *
 * 通知面板 UI 在透明 modal 子窗口，点击产生的动作经 IPC 回传这里执行——导航 / markRead /
 * markAllRead / 邀请 / tracker 都依赖主窗口的 store / query / mutation，且 mutation 在主
 * renderer 执行才能让铃铛角标的 query 缓存同步刷新。
 */
export function AppNotificationActionHost() {
  const organizationId = useNotificationStore((state) => state.currentOrganizationId)
  const navigateToNotification = useNotificationStore((state) => state.navigateToNotification)
  const openFromNotification = useInvitationInboxStore((state) => state.openFromNotification)
  const selectInvitation = useInvitationInboxStore((state) => state.selectInvitation)
  const markReadMutation = useMarkReadMutation(organizationId)
  const markAllReadMutation = useMarkAllReadMutation(organizationId)

  useEffect(() => {
    const unsubscribe = window.tabtin?.overlay?.onNotificationAction?.((raw) => {
      const action = raw as OverlayNotificationActionPayload | undefined
      if (!action) return
      const notif = action.notif as NotificationItem | undefined

      const markReadIfNeeded = (n: NotificationItem) => {
        if (!n.is_read) {
          markReadMutation.mutate({ notificationId: n.id, wasUnread: true })
        }
      }
      const resolveSpaceId = (n: NotificationItem) =>
        n.space_id || (n.metadata?.space_id as string | undefined)

      switch (action.kind) {
        case 'open-center': {
          log.info('用户从快速面板打开通知中心', { organizationId })
          if (notif) markReadIfNeeded(notif)
          useAppPageStore.getState().openAppPage('notification')
          break
        }
        case 'mark-read': {
          if (notif) markReadIfNeeded(notif)
          break
        }
        case 'navigate': {
          if (!notif) break
          markReadIfNeeded(notif)
          void navigateToNotification(notif).catch((error) => {
            log.warn('通知快速面板目标导航失败', { notificationId: notif.id, error })
          })
          break
        }
        case 'view-artifact': {
          if (!notif || !action.appId) break
          markReadIfNeeded(notif)
          const spaceId = resolveSpaceId(notif)
          void navigateToTarget({
            type: 'agentspace-app',
            id: action.appId,
            ...(spaceId ? { spaceId } : {}),
            ...(notif.organization_id ? { organizationId: notif.organization_id } : {}),
          }).catch(() => {})
          break
        }
        case 'view-run-detail': {
          if (!notif || !action.trackerId) break
          markReadIfNeeded(notif)
          const spaceId = resolveSpaceId(notif)
          void navigateToTarget({
            type: 'tracker',
            id: action.trackerId,
            ...(spaceId ? { spaceId } : {}),
            ...(notif.organization_id ? { organizationId: notif.organization_id } : {}),
          }).catch(() => {})
          break
        }
        case 'open-invitation': {
          if (!notif) break
          markReadIfNeeded(notif)
          void openFromNotification(notif)
          break
        }
        case 'select-invitation': {
          if (!action.invitation) break
          selectInvitation(action.invitation as Parameters<typeof selectInvitation>[0])
          break
        }
        case 'mark-all-read': {
          markAllReadMutation.mutate()
          break
        }
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [
    navigateToNotification,
    openFromNotification,
    selectInvitation,
    markReadMutation,
    markAllReadMutation,
    organizationId,
  ])

  useEffect(() => {
    const unsubscribe = window.tabtin?.notification?.onToastFallback?.((payload) => {
      if (payload.type === 'download.failed') {
        toast({ title: payload.title, description: payload.body, variant: 'destructive' })
      } else if (payload.type === 'download.completed') {
        toast({ title: payload.title, description: payload.body, variant: 'success' })
      } else {
        toast({ title: payload.title, description: payload.body })
      }
    })
    return () => unsubscribe?.()
  }, [])

  return null
}

/**
 * useNotificationNavigator — 订阅通知点击跳转事件
 *
 * 监听 notification:navigate IPC，委托 notificationNavigation 执行跳转。
 */

import { useEffect } from 'react'
import { navigateToTarget } from '@/services/notificationNavigation'

export function useNotificationNavigator(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true

  useEffect(() => {
    if (!enabled) return

    const unsubNavigate = window.tabtin?.notification?.onNavigate?.((data) => {
      if (!data?.type || !data?.id) return
      void navigateToTarget(data).catch(() => {})
    })

    return () => {
      unsubNavigate?.()
    }
  }, [enabled])
}

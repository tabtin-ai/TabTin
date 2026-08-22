import { useEffect, useRef } from 'react'

import { useOrganizationStore } from '@stores/useOrganizationStore'

/**
 * 团队切换双向同步 —— 主窗口 ↔ 私信独立窗口。
 *
 * 主窗口与私信窗口是两个独立的 renderer 进程，各自持有一份 useOrganizationStore，
 * 冷启动时通过共享 localStorage 对齐一次，但运行时任一窗口切换团队后另一窗口
 * 不会自动跟随。这里通过主进程转发的 `im:syncOrganization` / `im:organizationSynced`
 * 实现实时双向同步：
 *   - 本窗口 selectedOrganization 变化 → 广播 organizationId 给其它窗口；
 *   - 收到其它窗口的 organizationId → 在本窗口 selectOrganization 切到同一团队。
 *
 * 防回环：收到远端同步后记录该 id，本窗口随之产生的 selectedOrganization 变化不再回播。
 */
export function useOrganizationSync(): void {
  const selectedOrganizationId = useOrganizationStore((state) => state.selectedOrganization?.id ?? null)
  // 记录刚从远端同步过来的 organizationId：本窗口随之触发的 effect 不应再广播回去。
  const appliedFromRemoteRef = useRef<string | null>(null)
  // 跳过挂载首帧广播：冷启动两窗口已通过共享 localStorage 对齐，无需回播。
  const isFirstRunRef = useRef(true)

  useEffect(() => {
    const off = window.tabtin?.im?.onOrganizationSynced?.((payload) => {
      const organizationId = payload?.organizationId
      if (!organizationId) return
      const store = useOrganizationStore.getState()
      if (store.selectedOrganization?.id === organizationId) return
      const target = store.organizations.find((w) => w.id === organizationId)
      if (!target) return
      appliedFromRemoteRef.current = organizationId
      void store.selectOrganization(target)
    })
    return () => {
      off?.()
    }
  }, [])

  useEffect(() => {
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false
      return
    }
    if (!selectedOrganizationId) return
    if (appliedFromRemoteRef.current === selectedOrganizationId) {
      appliedFromRemoteRef.current = null
      return
    }
    window.tabtin?.im?.syncOrganization?.({ organizationId: selectedOrganizationId })
  }, [selectedOrganizationId])
}

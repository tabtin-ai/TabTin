/**
 * 协作挂起 → 主进程网络栈软自愈的渲染进程聚合器
 *
 * collab-core 的 CONNECTING watchdog 每次触发都会在 window 上广播
 * COLLAB_STUCK_CONNECTING_EVENT（detail 携带该 provider 的连续触发计数）。
 * 任一协作实例（表格 / TabDoc / 画板…）的计数达到阈值，说明握手挂起已
 * 持续约 3 个 watchdog 周期（~3 分钟）——超出 syncMode 降级阈值（2 次），
 * 大概率是 Chromium network service 层坏死，仅靠 provider 重建无法恢复。
 * 此时请求主进程 closeAllConnections + clearHostResolverCache 软重启网络栈。
 *
 * 主进程有 10 分钟全局冷却；这里再做一层同窗口节流，避免多文档同时挂起
 * 造成 IPC 风暴。
 */

import { COLLAB_STUCK_CONNECTING_EVENT } from '@tabtin/collab-core'

/** 达到该连续 watchdog 次数才请求网络栈自愈（≈3 分钟挂起） */
export const NETWORK_RECOVERY_STUCK_THRESHOLD = 3

/** 渲染进程侧的上报节流窗口，与主进程冷却对齐 */
const RENDERER_THROTTLE_MS = 10 * 60 * 1000

let lastRequestAt = 0
let disposer: (() => void) | null = null

type StuckDetail = { documentName?: string; watchdogTriggerCount?: number }

async function requestRecovery(detail: StuckDetail): Promise<void> {
  const now = Date.now()
  if (lastRequestAt > 0 && now - lastRequestAt < RENDERER_THROTTLE_MS) return
  lastRequestAt = now

  const recoverStack = window.tabtin?.network?.recoverStack
  if (typeof recoverStack !== 'function') return

  try {
    const result = await recoverStack({
      reason: `collab_stuck_connecting:${detail.documentName ?? 'unknown'}:${detail.watchdogTriggerCount ?? 0}`,
    })
    console.warn('[CollabNetworkRecovery] recover-stack requested', {
      documentName: detail.documentName,
      watchdogTriggerCount: detail.watchdogTriggerCount,
      ...result,
    })
  } catch (err) {
    console.error('[CollabNetworkRecovery] recover-stack failed:', err)
  }
}

export function initCollabNetworkRecovery(): void {
  if (disposer) return

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<StuckDetail>).detail ?? {}
    if ((detail.watchdogTriggerCount ?? 0) < NETWORK_RECOVERY_STUCK_THRESHOLD) return
    void requestRecovery(detail)
  }

  window.addEventListener(COLLAB_STUCK_CONNECTING_EVENT, handler)
  disposer = () => {
    window.removeEventListener(COLLAB_STUCK_CONNECTING_EVENT, handler)
    disposer = null
  }
}

/** 仅供测试。 */
export const __internal = {
  requestRecovery,
  resetThrottle: () => {
    lastRequestAt = 0
  },
  dispose: () => {
    disposer?.()
  },
}

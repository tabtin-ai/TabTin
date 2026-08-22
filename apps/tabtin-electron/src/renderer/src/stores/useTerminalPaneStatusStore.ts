/** @store-category session */

/**
 * Terminal Pane Status Store
 *
 * 存储每个 PTY session 的运行状态（idle / running / exited），
 * 由主进程通过 IPC 事件 `pty:pane-status` 驱动更新。
 */

import { create } from 'zustand'
import type { PaneStatus, PaneStatusEntry } from '@shared/types/terminal'

export type { PaneStatus, PaneStatusEntry } from '@shared/types/terminal'

interface TerminalPaneStatusState {
  statuses: Record<string, PaneStatusEntry>
  setStatus: (sessionId: string, status: PaneStatus, exitCode?: number | null) => void
  removeStatus: (sessionId: string) => void
  getStatus: (sessionId: string) => PaneStatus
  getAggregatedStatus: (sessionIds: string[]) => PaneStatus
}

export const useTerminalPaneStatusStore = create<TerminalPaneStatusState>()(
  (set, get) => ({
    statuses: {},

    setStatus: (sessionId, status, exitCode) => {
      set(state => ({
        statuses: {
          ...state.statuses,
          [sessionId]: { status, exitCode },
        },
      }))
    },

    removeStatus: (sessionId) => {
      set(state => {
        const next = { ...state.statuses }
        delete next[sessionId]
        return { statuses: next }
      })
    },

    getStatus: (sessionId) => {
      return get().statuses[sessionId]?.status ?? 'idle'
    },

    getAggregatedStatus: (sessionIds) => {
      const statuses = get().statuses
      let hasRunning = false
      let hasExited = false
      for (const id of sessionIds) {
        const entry = statuses[id]
        if (!entry) continue
        if (entry.status === 'running') hasRunning = true
        if (entry.status === 'exited') hasExited = true
      }
      if (hasRunning) return 'running'
      if (hasExited) return 'exited'
      return 'idle'
    },
  }),
)

let _unsubscribe: (() => void) | null = null

export function initPaneStatusListener(): void {
  if (_unsubscribe) return
  const tabtin = window.tabtin
  if (!tabtin?.pty?.onPaneStatus) return

  _unsubscribe = tabtin.pty.onPaneStatus((event) => {
    useTerminalPaneStatusStore.getState().setStatus(
      event.sessionId,
      event.status,
      event.exitCode,
    )
  })

  tabtin.pty.getPaneStatuses?.().then((result) => {
    if (!result?.success || !result.statuses) return
    const store = useTerminalPaneStatusStore.getState()
    for (const [sessionId, status] of Object.entries(result.statuses)) {
      store.setStatus(sessionId, status)
    }
  }).catch(() => {})
}

export function destroyPaneStatusListener(): void {
  _unsubscribe?.()
  _unsubscribe = null
}

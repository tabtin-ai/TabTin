/**
 * Terminal Snapshot Manager
 *
 * 负责周期性序列化所有活跃终端的内容，
 * 通过 IPC 保存到磁盘，供下次冷启动恢复使用。
 *
 * 保存策略：
 * - 每 15 秒自动保存（缩短间隔以降低异常退出时的数据丢失）
 * - beforeunload 时尝试最后一次保存（异步 IPC，不保证成功）
 */

import {
  serializeTerminalSnapshot,
  getAllCachedSessionIds,
  isTerminalDirtyForSnapshot,
} from './terminalRuntime'
import { useTerminalSessionStore } from '@components/context-space/sources/terminal'
import { traceTabRestore } from '@/utils/tabRestoreTrace'

const PERIODIC_SNAPSHOT_INTERVAL_MS = 15_000

let periodicTimer: ReturnType<typeof setInterval> | null = null
let beforeUnloadHandler: (() => void) | null = null

function collectSnapshots(dirtyOnly = false): Array<{
  sessionId: string
  ansiOutput: string
  cwd: string
  cols: number
  rows: number
  scrollbackLines: number
  capturedAt: number
}> {
  const sessionIds = getAllCachedSessionIds()
  if (sessionIds.length === 0) return []

  const allSessions = useTerminalSessionStore.getState().sessionsBySpace
  const cwdMap = new Map<string, string>()
  for (const sessions of Object.values(allSessions)) {
    for (const s of sessions) {
      if (s.cwd) cwdMap.set(s.id, s.cwd)
    }
  }

  const snapshots: ReturnType<typeof collectSnapshots> = []
  for (const sessionId of sessionIds) {
    if (dirtyOnly && !isTerminalDirtyForSnapshot(sessionId)) continue
    const snapshot = serializeTerminalSnapshot(sessionId, cwdMap.get(sessionId) ?? '')
    if (snapshot) {
      snapshots.push(snapshot)
    }
  }

  return snapshots
}

async function saveSnapshots(): Promise<void> {
  const tabtin = window.tabtin
  if (!tabtin?.pty?.snapshotSave) return

  const snapshots = collectSnapshots(true)
  if (snapshots.length === 0) return
  traceTabRestore('terminalSnapshots:save', {
    count: snapshots.length,
    sessions: snapshots.map(snapshot => ({
      sessionId: snapshot.sessionId,
      cwd: snapshot.cwd,
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollbackLines: snapshot.scrollbackLines,
    })),
  })

  try {
    await tabtin.pty.snapshotSave(snapshots)
  } catch (err) {
    console.warn('[SnapshotManager] 保存快照失败:', err)
  }
}

export function initSnapshotManager(): void {
  if (periodicTimer) return

  periodicTimer = setInterval(() => {
    saveSnapshots().catch(() => {})
  }, PERIODIC_SNAPSHOT_INTERVAL_MS)

  beforeUnloadHandler = () => {
    const tabtin = window.tabtin
    if (!tabtin?.pty?.snapshotSaveSync) return
    const snapshots = collectSnapshots(true)
    if (snapshots.length === 0) return
    traceTabRestore('terminalSnapshots:beforeunloadSaveSync', {
      count: snapshots.length,
      savedCount: Math.min(snapshots.length, 5),
      sessionIds: snapshots.map(snapshot => snapshot.sessionId),
    })
    tabtin.pty.snapshotSaveSync(snapshots.slice(0, 5))
  }
  window.addEventListener('beforeunload', beforeUnloadHandler)
}

export function destroySnapshotManager(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler)
    beforeUnloadHandler = null
  }
}

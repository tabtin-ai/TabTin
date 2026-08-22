/**
 * Terminal Shared Types
 *
 * 终端模块的共享类型定义，供主进程、渲染进程、preload 三层统一引用。
 * 避免 PaneStatus / TerminalSnapshot 等类型在多处重复定义。
 */

export type PaneStatus = 'idle' | 'running' | 'exited'

export interface PaneStatusEvent {
  sessionId: string
  status: PaneStatus
  exitCode?: number | null
}

export interface PaneStatusEntry {
  status: PaneStatus
  exitCode?: number | null
}

export type SnapshotCheckpointType = 'auto' | 'manual' | 'exit'

export interface TerminalSnapshot {
  sessionId: string
  ansiOutput: string
  cwd: string
  cols: number
  rows: number
  scrollbackLines?: number
  capturedAt: number
  /** 快照类型：auto=Agent命令执行前自动保存, manual=手动触发, exit=应用退出时保存 */
  checkpointType?: SnapshotCheckpointType
  /**
   * 尺寸不匹配标记：当前终端 cols/rows 与快照保存时差距过大时为 true。
   * 恢复此类快照可能导致 ANSI 布局错乱。
   */
  sizeMismatch?: boolean
}

export interface SnapshotManifest {
  version: number
  capturedAt: number
  sessions: Array<{
    sessionId: string
    cwd: string
    cols: number
    rows: number
  }>
}

import { ipcRenderer } from 'electron'
import type { CheckpointKind } from '@tabtin/checkpoint-core'

interface CheckpointCommitPolicy {
  kind?: CheckpointKind
  trigger?: CheckpointKind
  allowEmpty?: boolean
  visibleInHistory?: boolean
  anchor?: string
  baselineHash?: string
}

interface CheckpointRestoreOptions {
  moveHead?: boolean
}

/**
 * Checkpoint 检查点系统类型定义
 *
 * 失败时主进程返 `{success: false, error, errorType?}`，errorType 取自
 * `CheckpointErrorType`（见 `apps/tabtin-electron/src/main/checkpoint/checkpoint-ipc.ts`）。
 * renderer 端通过 `services/checkpointIpc.ts` 的 unwrapLegacyEnvelope
 * 自动把 errorType 挂到抛出的 `CheckpointError` 上。
 */
export interface CheckpointApi {
  init: (projectPath: string) => Promise<{ success: boolean; error?: string; errorType?: string }>
  commit: (projectPath: string, policy?: CheckpointCommitPolicy) => Promise<{ success: boolean; commitHash: string | null; error?: string; errorType?: string }>
  writeTree: (projectPath: string) => Promise<{ success: boolean; treeHash: string | null; error?: string }>
  initial: (projectPath: string) => Promise<{ success: boolean; commitHash: string | null; error?: string; errorType?: string }>
  restore: (projectPath: string, commitHash: string, options?: CheckpointRestoreOptions) => Promise<{ success: boolean; error?: string; errorType?: string }>
  diff: (projectPath: string, fromHash: string, toHash?: string) => Promise<{
    success: boolean
    diffs: Array<{ relativePath: string; absolutePath: string; before: string; after: string }>
    error?: string
    errorType?: string
  }>
  diffSummary: (projectPath: string, commitHash: string, baseHash?: string) => Promise<{
    success: boolean
    files: Array<{ file: string; insertions: number; deletions: number; binary: boolean }>
    summary: { changed: number; insertions: number; deletions: number }
    error?: string
  }>
  listCommits: (projectPath: string, options?: { limit?: number; skip?: number }) => Promise<{
    success: boolean
    commits: Array<{ hash: string; message: string; date: string }>
    error?: string
    errorType?: string
  }>
  gc: (projectPath: string) => Promise<{ success: boolean; error?: string; errorType?: string }>
  destroy: (projectPath: string) => Promise<{ success: boolean; error?: string; errorType?: string }>
  diskUsage: (projectPath: string) => Promise<{
    success: boolean
    sizeBytes: number
    sizeHuman: string
    error?: string
  }>
}

/** 创建 Checkpoint IPC 桥接实现 */
export function createCheckpointApi(): CheckpointApi {
  return {
    init: (projectPath: string) => ipcRenderer.invoke('checkpoint:init', projectPath),
    commit: (projectPath: string, policy?: CheckpointCommitPolicy) => ipcRenderer.invoke('checkpoint:commit', projectPath, policy),
    writeTree: (projectPath: string) => ipcRenderer.invoke('checkpoint:writeTree', projectPath),
    initial: (projectPath: string) => ipcRenderer.invoke('checkpoint:initial', projectPath),
    restore: (projectPath: string, commitHash: string, options?: CheckpointRestoreOptions) =>
      ipcRenderer.invoke('checkpoint:restore', projectPath, commitHash, options),
    diff: (projectPath: string, fromHash: string, toHash?: string) =>
      ipcRenderer.invoke('checkpoint:diff', projectPath, fromHash, toHash),
    diffSummary: (projectPath: string, commitHash: string, baseHash?: string) =>
      ipcRenderer.invoke('checkpoint:diffSummary', projectPath, commitHash, baseHash),
    listCommits: (projectPath: string, options?: { limit?: number; skip?: number }) =>
      ipcRenderer.invoke('checkpoint:listCommits', projectPath, options),
    gc: (projectPath: string) => ipcRenderer.invoke('checkpoint:gc', projectPath),
    destroy: (projectPath: string) => ipcRenderer.invoke('checkpoint:destroy', projectPath),
    diskUsage: (projectPath: string) => ipcRenderer.invoke('checkpoint:diskUsage', projectPath),
  }
}

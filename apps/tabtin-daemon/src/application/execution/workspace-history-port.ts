export interface CheckpointExecutionPort {
  init(projectPath: string): Promise<string>
  commit(projectPath: string, policy?: unknown): Promise<string | undefined>
  restore(projectPath: string, commitHash: string, moveHead: boolean): Promise<void>
  diff(projectPath: string, fromHash: string, toHash?: string): Promise<unknown[]>
  destroy(projectPath: string): Promise<void>
  initialCommit(projectPath: string): Promise<string | null>
  gc(projectPath: string): Promise<void>
  writeTree(projectPath: string): Promise<string | undefined>
  diffSummary(projectPath: string, commitHash: string, baseHash?: string): Promise<unknown>
  affectedPaths(projectPath: string, commitHash: string): Promise<string[]>
  dispose(): Promise<void>
}

export interface FileHistoryExecutionPort {
  rewind(
    threadId: string,
    anchorId: string,
    pathGuard: (filePath: string) => { allowed: boolean },
  ): Promise<{
    filesRestored: string[]
    filesDeleted: string[]
    failedFiles: unknown[]
  } | null>
  affectedPaths(threadId: string, anchorId: string): Promise<string[] | null>
}

/** Workspace mutation history needed by Action Execution, independent of storage implementation. */
export interface ActionWorkspaceHistoryPort {
  readonly checkpoints: CheckpointExecutionPort
  readonly files: FileHistoryExecutionPort
}

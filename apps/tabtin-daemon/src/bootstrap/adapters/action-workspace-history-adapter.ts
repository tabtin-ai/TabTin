import type { CheckpointCommitPolicy } from '@tabtin/checkpoint-core'

import type {
  ActionWorkspaceHistoryPort,
  CheckpointExecutionPort,
  FileHistoryExecutionPort,
} from '../../application/execution/workspace-history-port.js'
import {
  destroyAllCheckpointServices,
  destroyCheckpointService,
  getCheckpointService,
} from '../../platform/workspace/checkpoint/CheckpointService.js'
import { getOrResumeFileHistory } from '../../platform/workspace/file-history/file-history-registry.js'

const checkpoints: CheckpointExecutionPort = {
  init: (projectPath) => getCheckpointService(projectPath).init(),
  commit: (projectPath, policy) =>
    getCheckpointService(projectPath).commit(policy as CheckpointCommitPolicy | undefined),
  restore: (projectPath, commitHash, moveHead) =>
    getCheckpointService(projectPath).restore(commitHash, { moveHead }),
  diff: (projectPath, fromHash, toHash) => getCheckpointService(projectPath).getDiff(fromHash, toHash),
  destroy: destroyCheckpointService,
  initialCommit: (projectPath) => getCheckpointService(projectPath).getInitialCommitHash(),
  gc: (projectPath) => getCheckpointService(projectPath).gc(),
  writeTree: (projectPath) => getCheckpointService(projectPath).writeTree(),
  diffSummary: (projectPath, commitHash, baseHash) =>
    getCheckpointService(projectPath).getDiffSummary(commitHash, baseHash),
  affectedPaths: (projectPath, commitHash) =>
    getCheckpointService(projectPath).getAffectedPaths(commitHash),
  dispose: destroyAllCheckpointServices,
}

const files: FileHistoryExecutionPort = {
  async rewind(threadId, anchorId, pathGuard) {
    const history = await getOrResumeFileHistory(threadId)
    return history ? history.rewind(anchorId, { pathGuard }) : null
  },
  async affectedPaths(threadId, anchorId) {
    const history = await getOrResumeFileHistory(threadId)
    return history ? history.getAffectedPaths(anchorId) : null
  },
}

export function createActionWorkspaceHistoryAdapter(): ActionWorkspaceHistoryPort {
  return { checkpoints, files }
}

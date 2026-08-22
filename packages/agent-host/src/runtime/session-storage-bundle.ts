/**
 * Session storage bundle — shared createRuntime W6a slice.
 *
 * Owns the archive path resolution + SessionStorage / SnapshotStorage /
 * EventStorage / ToolLogWriter / FileToolResultStorage construction that
 * Electron and Daemon previously duplicated inside createRuntimeForSession.
 *
 * Platform differences stay outside:
 *  - which threadId keys the archive (Electron businessThreadId vs Daemon sessionId)
 *  - which threadId goes into sessionConfig (Electron runtimeThreadId vs Daemon sessionId)
 *  - skills ensure / reconcile (platform-owned)
 *  - workspaceRoot reachability fallback (Electron-only)
 *
 *  / （硬切）：会话归档落在
 * `{dataRoot}/users/{userId}/organizations/{org}/workspaces/{workspaceId}/conversations/`。
 * `dataRoot` + `userId` 均为必填 —— 不再支持 legacy `platformDataRoot` 回落。
 */

import {
  SessionStorage,
  SnapshotStorage,
  EventStorage,
  ToolLogWriter,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
} from '@tabtin/agent-runtime'
import { FileToolResultStorage } from '@tabtin/agent-runtime/engine'

export interface SessionStorageBundleLogger {
  warn(message: string, ...args: unknown[]): void
}

export interface CreateSessionStorageBundleInput {
  /**  硬切：组织 ID 必填（禁止 `_unscoped`）。 */
  organizationId: string
  /**  硬切：workspace ID 必填（字段名沿用 spaceId）。 */
  spaceId: string
  /**
   * Thread id used for SessionStorage / SnapshotStorage / EventStorage.
   * Electron: business conversation thread; Daemon: sessionId.
   */
  archiveThreadId: string
  /**
   * Thread id written into EngineConfig.sessionConfig.
   * Electron: runtimeThreadId; Daemon: sessionId.
   */
  sessionConfigThreadId: string
  /** ToolLogWriter session key (both platforms: sessionId). */
  toolLogSessionId: string
  /**  数据根（`getDataRoot()` / `resolveDataRoot()`）。必填。 */
  dataRoot: string
  /**  当前登录用户。必填。 */
  userId: string
  log: SessionStorageBundleLogger
}

export interface SessionStorageBundle {
  sessionDir: string
  toolLogsDir: string
  sessionStorage: SessionStorage
  snapshotStorage: SnapshotStorage
  eventStorage: EventStorage
  toolLogWriter: ToolLogWriter | null
  toolResultStorage: FileToolResultStorage
  sessionConfig: { sessionDir: string; threadId: string }
}

function resolveArchiveDirs(input: CreateSessionStorageBundleInput): {
  sessionDir: string
  toolLogsDir: string
} {
  if (!input.dataRoot || !input.userId || !input.organizationId || !input.spaceId) {
    throw new Error(
      'createSessionStorageBundle requires dataRoot+userId+organizationId+spaceId ( / )',
    )
  }
  return {
    sessionDir: resolveWorkspaceSessionArchiveDir(
      input.dataRoot,
      input.userId,
      input.organizationId,
      input.spaceId,
    ),
    toolLogsDir: resolveWorkspaceToolLogsDir(
      input.dataRoot,
      input.userId,
      input.organizationId,
      input.spaceId,
    ),
  }
}

/**
 * Build the per-session disk storage bundle used by createRuntimeForSession.
 */
export function createSessionStorageBundle(
  input: CreateSessionStorageBundleInput,
): SessionStorageBundle {
  const { sessionDir, toolLogsDir } = resolveArchiveDirs(input)

  const sessionStorage = new SessionStorage({
    sessionDir,
    // §17.6 D4：SessionConfig.sessionId → threadId（业务对话 thread）。
    threadId: input.archiveThreadId,
  })
  const snapshotStorage = new SnapshotStorage(sessionDir, input.archiveThreadId)
  const eventStorage = new EventStorage(sessionDir, input.archiveThreadId)

  let toolLogWriter: ToolLogWriter | null = null
  try {
    toolLogWriter = new ToolLogWriter({
      toolLogsDir,
      sessionId: input.toolLogSessionId,
      onError: (err) =>
        input.log.warn('[ToolLogWriter] write error:', err.message),
    })
  } catch (err) {
    input.log.warn('[ToolLogWriter] init failed, tool logs disabled:', err)
  }

  const toolResultStorage = new FileToolResultStorage(sessionDir, {
    logger: {
      warn: (msg, extra) => {
        if (extra) input.log.warn(msg, extra)
        else input.log.warn(msg)
      },
    },
  })

  return {
    sessionDir,
    toolLogsDir,
    sessionStorage,
    snapshotStorage,
    eventStorage,
    toolLogWriter,
    toolResultStorage,
    sessionConfig: {
      sessionDir,
      threadId: input.sessionConfigThreadId,
    },
  }
}

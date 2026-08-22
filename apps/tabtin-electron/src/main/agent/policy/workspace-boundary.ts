/**
 * WorkspaceBoundary owns the Electron host's per-Space workspace access state.
 *
 * Its interface is intentionally small:
 * - apply a renderer/user command;
 * - resolve the effective allowed paths for a Space;
 * - hydrate a runtime snapshot when a session is created.
 *
 * The pending cold-start buffer is private implementation state. Callers no
 * longer need to coordinate peek/consume/derive ordering themselves.
 */

import type { WorkspaceSnapshot, WorkspaceSources } from '@tabtin/security-policy'
import { isDangerouslyBroadPath } from '@tabtin/security-policy'
import { tabtinAgentTasksDir } from '@tabtin/terminal-core'

export interface WorkspaceBoundarySession {
  readonly sessionId?: string
  readonly spaceId: string | undefined
  workspaceSnapshot: WorkspaceSnapshot | null | undefined
}

export interface WorkspacePathsChangedPayload {
  readonly spaceId?: unknown
  readonly workingDir?: unknown
  /** @deprecated Single-root Spaces ignore this field. */
  readonly tabcodeProjects?: unknown
  /** @deprecated Single-root Spaces ignore this field. */
  readonly tabfolderDirs?: unknown
}

export interface AppendSessionApprovedPathPayload {
  readonly spaceId?: unknown
  /** 可选；提供后只授权这条会话，不向同 Space 其它会话广播。 */
  readonly sessionId?: unknown
  readonly path?: unknown
}

export type WorkspaceBoundaryCommand =
  | { type: 'paths-changed'; payload: WorkspacePathsChangedPayload }
  | { type: 'session-path-approved'; payload: AppendSessionApprovedPathPayload }

export type WorkspaceSnapshotReconcileCommand =
  | { type: 'refresh' }
  | { type: 'consume-pending'; spaceId: string }

export interface WorkspaceBoundaryResult {
  readonly mutated: boolean
  readonly warning: string | null
}

export interface WorkspaceBoundary {
  apply(
    sessions: Iterable<WorkspaceBoundarySession>,
    command: WorkspaceBoundaryCommand,
  ): WorkspaceBoundaryResult

  /**
   * Resolve the effective snapshot without consuming pending cold-start
   * state. Before session creation this returns a partial snapshot built from
   * pending paths, which is sufficient for path checks and the security panel.
   */
  getSnapshot(
    sessions: Iterable<WorkspaceBoundarySession>,
    spaceId: string,
  ): WorkspaceSnapshot | null

  /**
   * Reconcile a snapshot using one explicit mode:
   * - refresh: re-derive from the snapshot's current authoritative sources;
   * - consume-pending: apply one Space's pending state, then re-derive.
   *
   * Explicit commands prevent an absent Space id from accidentally changing
   * the runtime's initial permission snapshot.
   */
  reconcileSnapshot(
    snapshot: WorkspaceSnapshot,
    command: WorkspaceSnapshotReconcileCommand,
  ): boolean
}

interface PendingWorkspaceHydrate {
  workingDir: string
  sessionApprovedPaths: string[]
}

function pickWorkingDir(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (isDangerouslyBroadPath(value)) return ''
  return value
}

function deriveAllowedPaths(sources: WorkspaceSources): string[] {
  const paths = new Set<string>()
  if (sources.sandbox.length > 0 && !isDangerouslyBroadPath(sources.sandbox)) {
    paths.add(sources.sandbox)
  }
  const workingDir = sources.workingDir ?? ''
  if (workingDir.length > 0 && !isDangerouslyBroadPath(workingDir)) {
    paths.add(workingDir)
  }
  for (const approvedPath of sources.sessionApprovedPaths ?? []) {
    if (
      typeof approvedPath === 'string'
      && approvedPath.length > 0
      && !isDangerouslyBroadPath(approvedPath)
    ) {
      paths.add(approvedPath)
    }
  }
  paths.add(tabtinAgentTasksDir())
  return [...paths]
}

function derivePendingAllowedPaths(pending: PendingWorkspaceHydrate): string[] {
  return deriveAllowedPaths({
    sandbox: '',
    workingDir: pending.workingDir,
    sessionApprovedPaths: pending.sessionApprovedPaths,
    attachedFiles: [],
  })
}

class DefaultWorkspaceBoundary implements WorkspaceBoundary {
  private readonly pendingBySpaceId = new Map<string, PendingWorkspaceHydrate>()

  apply(
    sessions: Iterable<WorkspaceBoundarySession>,
    command: WorkspaceBoundaryCommand,
  ): WorkspaceBoundaryResult {
    if (command.type === 'paths-changed') {
      return this.applyPathsChanged(sessions, command.payload)
    }
    return this.applyApprovedPath(sessions, command.payload)
  }

  getSnapshot(
    sessions: Iterable<WorkspaceBoundarySession>,
    spaceId: string,
  ): WorkspaceSnapshot | null {
    if (!spaceId) return null
    for (const session of sessions) {
      if (session.spaceId === spaceId && session.workspaceSnapshot) {
        return session.workspaceSnapshot
      }
    }
    const pending = this.pendingBySpaceId.get(spaceId)
    if (!pending) return null
    return {
      sources: {
        sandbox: '',
        workingDir: pending.workingDir,
        sessionApprovedPaths: [...pending.sessionApprovedPaths],
        attachedFiles: [],
      },
      allowedPaths: derivePendingAllowedPaths(pending),
      allowedFiles: [],
      // Pending state exists before a runtime/session is created.
      spaceSessionId: '',
    }
  }

  reconcileSnapshot(
    snapshot: WorkspaceSnapshot,
    command: WorkspaceSnapshotReconcileCommand,
  ): boolean {
    if (command.type === 'refresh') {
      snapshot.allowedPaths = deriveAllowedPaths(snapshot.sources)
      return false
    }
    const pending = this.pendingBySpaceId.get(command.spaceId)
    if (!pending) return false
    snapshot.sources.workingDir = pending.workingDir
    snapshot.sources.sessionApprovedPaths = [...pending.sessionApprovedPaths]
    this.pendingBySpaceId.delete(command.spaceId)
    snapshot.allowedPaths = deriveAllowedPaths(snapshot.sources)
    return true
  }

  private applyPathsChanged(
    sessions: Iterable<WorkspaceBoundarySession>,
    payload: WorkspacePathsChangedPayload,
  ): WorkspaceBoundaryResult {
    if (!payload || typeof payload !== 'object') {
      return {
        mutated: false,
        warning: 'workspace:paths-changed: payload not an object; ignored',
      }
    }
    const spaceId = payload.spaceId
    if (typeof spaceId !== 'string' || spaceId.length === 0) {
      return {
        mutated: false,
        warning: 'workspace:paths-changed: missing spaceId; payload ignored',
      }
    }
    const workingDir = pickWorkingDir(payload.workingDir)

    let mutated = false
    for (const session of sessions) {
      if (session.spaceId !== spaceId || !session.workspaceSnapshot) continue
      session.workspaceSnapshot.sources.workingDir = workingDir
      this.reconcileSnapshot(session.workspaceSnapshot, { type: 'refresh' })
      mutated = true
    }

    if (mutated) {
      this.pendingBySpaceId.delete(spaceId)
      return { mutated: true, warning: null }
    }

    const existing = this.pendingBySpaceId.get(spaceId)
    this.pendingBySpaceId.set(spaceId, {
      workingDir,
      sessionApprovedPaths: existing?.sessionApprovedPaths ?? [],
    })
    return {
      mutated: false,
      warning:
        `workspace:paths-changed: no session for spaceId=${spaceId}; `
        + 'stashed to pending buffer (will replay on createRuntimeForSession).',
    }
  }

  private applyApprovedPath(
    sessions: Iterable<WorkspaceBoundarySession>,
    payload: AppendSessionApprovedPathPayload,
  ): WorkspaceBoundaryResult {
    if (!payload || typeof payload !== 'object') {
      return {
        mutated: false,
        warning: 'workspace:append-session-allowed-path: payload not object',
      }
    }
    const spaceId = payload.spaceId
    const requestedSessionId = payload.sessionId
    const approvedPath = payload.path
    if (typeof spaceId !== 'string' || spaceId.length === 0) {
      return {
        mutated: false,
        warning: 'workspace:append-session-allowed-path: missing spaceId',
      }
    }
    if (typeof approvedPath !== 'string' || approvedPath.length === 0) {
      return {
        mutated: false,
        warning: 'workspace:append-session-allowed-path: missing path',
      }
    }
    if (
      requestedSessionId !== undefined
      && (typeof requestedSessionId !== 'string' || requestedSessionId.length === 0)
    ) {
      return {
        mutated: false,
        warning: 'workspace:append-session-allowed-path: invalid sessionId',
      }
    }
    if (isDangerouslyBroadPath(approvedPath)) {
      return {
        mutated: false,
        warning: `workspace:append-session-allowed-path: path too broad: ${approvedPath}`,
      }
    }

    let mutated = false
    let matchedSnapshot = false
    for (const session of sessions) {
      if (session.spaceId !== spaceId || !session.workspaceSnapshot) continue
      if (requestedSessionId && session.sessionId !== requestedSessionId) continue
      matchedSnapshot = true
      const current = session.workspaceSnapshot.sources.sessionApprovedPaths ?? []
      if (current.includes(approvedPath)) continue
      session.workspaceSnapshot.sources.sessionApprovedPaths = [...current, approvedPath]
      this.reconcileSnapshot(session.workspaceSnapshot, { type: 'refresh' })
      mutated = true
    }

    if (mutated) {
      this.pendingBySpaceId.delete(spaceId)
      return { mutated: true, warning: null }
    }
    if (matchedSnapshot) {
      return { mutated: false, warning: null }
    }

    // 精确会话授权不能降级为 Space pending buffer，否则目标会话尚未创建时，
    // 路径会在下一条同 Space 会话启动时被错误消费。
    if (requestedSessionId) {
      return {
        mutated: false,
        warning:
          `workspace:append-session-allowed-path: no session for `
          + `spaceId=${spaceId} sessionId=${requestedSessionId}; ignored`,
      }
    }

    const existing = this.pendingBySpaceId.get(spaceId) ?? {
      workingDir: '',
      sessionApprovedPaths: [],
    }
    if (!existing.sessionApprovedPaths.includes(approvedPath)) {
      this.pendingBySpaceId.set(spaceId, {
        ...existing,
        sessionApprovedPaths: [...existing.sessionApprovedPaths, approvedPath],
      })
    }
    return {
      mutated: false,
      warning:
        `workspace:append-session-allowed-path: no session for spaceId=${spaceId}; `
        + 'stashed to pending buffer (will replay on createRuntimeForSession).',
    }
  }
}

export function createWorkspaceBoundary(): WorkspaceBoundary {
  return new DefaultWorkspaceBoundary()
}

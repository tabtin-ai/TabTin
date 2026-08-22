import { createLogger } from '@/utils/logger'
import type { BindSessionCodeRootOutcome } from '@/services/sessionCodeRootBinding'
import {
  resolveCreateWorktreeBranch,
  validateCreateWorktreeInput,
  type CreateWorktreeValidationReason,
} from './validateCreateWorktreeInput'
import { switchSessionWorktree } from './switchSessionWorktree'

const log = createLogger('CreateSessionWorktree')

export type CreateSessionWorktreeResult =
  | { ok: true; created: true; switched: true; rootPath: string }
  | {
      ok: true
      created: true
      switched: false
      rootPath: string
      switchResult: BindSessionCodeRootOutcome
    }
  | { ok: false; phase: 'validate'; reason: CreateWorktreeValidationReason }
  | { ok: false; phase: 'authorize' }
  | { ok: false; phase: 'create'; error?: string }
  | { ok: false; phase: 'ipc' }

export interface CreateSessionWorktreeInput {
  sessionId: string
  spaceId: string
  tabScopeKey: string
  repoRoot: string
  previousRootPath: string
  path: string
  branch: string
  createBranch: boolean
  baseBranch?: string
  currentBranch?: string
  existingBranchNames: string[]
}

export async function createSessionWorktree(
  input: CreateSessionWorktreeInput,
): Promise<CreateSessionWorktreeResult> {
  const reason = validateCreateWorktreeInput({
    path: input.path,
    branch: input.branch,
    createBranch: input.createBranch,
    existingBranchNames: input.existingBranchNames,
  })
  if (reason) return { ok: false, phase: 'validate', reason }

  const pathValue = input.path.trim()
  const branchValue = resolveCreateWorktreeBranch(input)
  const baseBranch = input.baseBranch?.trim() || undefined
  const git = window.tabtin?.git
  if (!git?.createWorktree) {
    log.warn('createWorktree IPC unavailable')
    return { ok: false, phase: 'ipc' }
  }

  if (input.spaceId) {
    try {
      await window.tabtin?.workspace?.appendSessionAllowedPath?.({
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        path: pathValue,
      })
    } catch (err) {
      log.warn('appendSessionAllowedPath before creating worktree failed', {
        errorType: err instanceof Error ? err.name : typeof err,
      })
      return { ok: false, phase: 'authorize' }
    }
  }

  log.info('creating worktree', {
    createBranch: input.createBranch,
    hasBaseBranch: Boolean(baseBranch),
  })
  let created: { success: boolean; error?: string }
  try {
    created = await git.createWorktree(input.repoRoot, {
      path: pathValue,
      branch: branchValue || undefined,
      createBranch: input.createBranch,
      baseBranch,
    })
  } catch (err) {
    log.error('createWorktree threw', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
    return {
      ok: false,
      phase: 'create',
      error: err instanceof Error ? err.message : undefined,
    }
  }

  if (!created?.success) {
    log.warn('createWorktree rejected', {
      errorType: created?.error ? 'git_error' : 'unknown',
    })
    return { ok: false, phase: 'create', error: created?.error }
  }

  let switchResult
  try {
    switchResult = await switchSessionWorktree({
      sessionId: input.sessionId,
      spaceId: input.spaceId,
      tabScopeKey: input.tabScopeKey,
      rootPath: pathValue,
      previousRootPath: input.previousRootPath,
      branch: branchValue || null,
    })
  } catch (err) {
    log.warn('worktree created but session switch threw', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
    return {
      ok: true,
      created: true,
      switched: false,
      rootPath: pathValue,
      switchResult: {
        success: false,
        error: err instanceof Error ? err.message : 'switch threw',
        reason: 'ipc_unavailable',
      },
    }
  }

  if (!switchResult.success) {
    log.warn('worktree created but session switch failed', {
      reason: switchResult.reason ?? 'unknown',
    })
    return {
      ok: true,
      created: true,
      switched: false,
      rootPath: pathValue,
      switchResult,
    }
  }

  return {
    ok: true,
    created: true,
    switched: true,
    rootPath: switchResult.rootPath ?? pathValue,
  }
}

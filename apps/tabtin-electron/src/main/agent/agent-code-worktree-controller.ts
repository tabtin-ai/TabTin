import fs from 'node:fs'
import path from 'node:path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import type {
  CodeWorktreeAgentContext,
  CodeWorktreeController,
  CodeWorktreeControllerResult,
} from '@tabtin/cli-routes'
import {
  belongsToSameGitRepository,
  createGitWorktree,
  listGitWorktrees,
  worktreePathsMatch,
} from '../git/worktree-service.js'
import type { AgentWorktreeTransitionQueue } from './agent-worktree-transition.js'
import {
  buildManagedAgentWorktreeBasePath,
  chooseAvailableAgentWorktreePath,
} from './agent-worktree-path.js'

export interface TrustedAgentWorktreeRun {
  sessionId: string
  runId: string
  toolUseId: string
  rootPath: string
  spaceId?: string
  tabScopeKey?: string
  bindingRevision?: number
}

export interface AgentCodeWorktreeControllerOptions {
  resolveTrustedRun(context: CodeWorktreeAgentContext): TrustedAgentWorktreeRun | null
  authorizePath(run: TrustedAgentWorktreeRun, targetPath: string): void
  transitions: AgentWorktreeTransitionQueue
  listWorktrees?: typeof listGitWorktrees
  createWorktree?: typeof createGitWorktree
  sameRepository?: typeof belongsToSameGitRepository
  managedWorktreeRoot?: string
}

const UNSAFE_GIT_REF_PATTERN = /[\x00-\x20\x7f~^:\\?*\[\]]/

function failure(
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): CodeWorktreeControllerResult {
  return { ok: false, status, code, message, ...(detail === undefined ? {} : { detail }) }
}

function readAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) return null
  return path.normalize(value.trim())
}

function readSafeGitRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ref = value.trim()
  const components = ref.split('/')
  if (
    !ref
    || ref === '@'
    || ref.startsWith('-')
    || ref.endsWith('/')
    || ref.includes('..')
    || ref.includes('//')
    || ref.includes('@{')
    || UNSAFE_GIT_REF_PATTERN.test(ref)
    || components.some((component) => (
      !component
      || component.startsWith('.')
      || component.endsWith('.')
      || component.endsWith('.lock')
    ))
  ) {
    return null
  }
  return ref
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export class AgentCodeWorktreeController implements CodeWorktreeController {
  private readonly listWorktrees: typeof listGitWorktrees
  private readonly createWorktree: typeof createGitWorktree
  private readonly sameRepository: typeof belongsToSameGitRepository

  constructor(private readonly options: AgentCodeWorktreeControllerOptions) {
    this.listWorktrees = options.listWorktrees ?? listGitWorktrees
    this.createWorktree = options.createWorktree ?? createGitWorktree
    this.sameRepository = options.sameRepository ?? belongsToSameGitRepository
  }

  resolveRoot(context: CodeWorktreeAgentContext): string | null {
    return this.options.resolveTrustedRun(context)?.rootPath ?? null
  }

  async current(context: CodeWorktreeAgentContext): Promise<CodeWorktreeControllerResult> {
    const run = this.options.resolveTrustedRun(context)
    if (!run) return this.untrusted()
    try {
      const worktrees = await this.listWorktrees(run.rootPath)
      const current = worktrees.find((item) => worktreePathsMatch(item.path, run.rootPath))
      return {
        ok: true,
        data: {
          root_path: run.rootPath,
          branch: current?.branch ?? null,
          binding_revision: run.bindingRevision ?? null,
          pending: this.options.transitions.peekRun(run.runId) != null,
        },
      }
    } catch (error) {
      return failure(400, 'NOT_GIT_WORKTREE', gitErrorMessage(error))
    }
  }

  async list(context: CodeWorktreeAgentContext): Promise<CodeWorktreeControllerResult> {
    const run = this.options.resolveTrustedRun(context)
    if (!run) return this.untrusted()
    try {
      const worktrees = await this.listWorktrees(run.rootPath)
      return {
        ok: true,
        data: {
          current_root: run.rootPath,
          worktrees: worktrees.map((item) => ({
            path: item.path,
            branch: item.branch,
            commit_hash: item.commitHash,
            is_current: worktreePathsMatch(item.path, run.rootPath),
            is_main_worktree: item.isMainWorktree,
            is_detached: item.isDetached,
            is_bare: item.isBare,
            is_locked: item.isLocked,
            lock_reason: item.lockReason ?? null,
          })),
        },
      }
    } catch (error) {
      return failure(400, 'NOT_GIT_WORKTREE', gitErrorMessage(error))
    }
  }

  async switch(
    context: CodeWorktreeAgentContext,
    input: { path?: unknown },
  ): Promise<CodeWorktreeControllerResult> {
    const run = this.options.resolveTrustedRun(context)
    if (!run) return this.untrusted()
    const targetPath = readAbsolutePath(input.path)
    if (!targetPath) return failure(400, 'VALIDATION_ERROR', '--path 必须是绝对路径')
    if (!fs.existsSync(targetPath)) return failure(404, 'WORKTREE_NOT_FOUND', `worktree 不存在: ${targetPath}`)
    if (worktreePathsMatch(run.rootPath, targetPath)) {
      return {
        ok: true,
        data: {
          changed: false,
          scheduled: false,
          root_path: run.rootPath,
          message: '当前对话已经绑定到该 worktree',
        },
      }
    }

    const available = this.options.transitions.canSchedule(
      run.sessionId,
      run.runId,
      run.toolUseId,
    )
    if (!available.ok) return failure(409, available.code, available.message)
    if (!(await this.sameRepository(run.rootPath, targetPath))) {
      return failure(400, 'DIFFERENT_REPOSITORY', '目标路径不属于当前代码根的同一 Git 仓库')
    }

    let target
    try {
      const worktrees = await this.listWorktrees(run.rootPath)
      target = worktrees.find((item) => worktreePathsMatch(item.path, targetPath))
    } catch (error) {
      return failure(400, 'NOT_GIT_WORKTREE', gitErrorMessage(error))
    }
    if (!target) return failure(400, 'NOT_LINKED_WORKTREE', '目标路径不是当前仓库登记的 worktree')

    const stillAvailable = this.options.transitions.canSchedule(
      run.sessionId,
      run.runId,
      run.toolUseId,
    )
    if (!stillAvailable.ok) {
      return failure(409, stillAvailable.code, stillAvailable.message)
    }
    try {
      this.options.authorizePath(run, target.path)
    } catch (error) {
      return failure(403, 'PATH_AUTHORIZATION_FAILED', gitErrorMessage(error))
    }
    const scheduled = this.options.transitions.schedule({
      sessionId: run.sessionId,
      runId: run.runId,
      toolUseId: run.toolUseId,
      previousRootPath: run.rootPath,
      targetRootPath: target.path,
      branch: target.branch ?? undefined,
      spaceId: run.spaceId,
      tabScopeKey: run.tabScopeKey,
      created: false,
    })
    if (!scheduled.ok) return failure(409, scheduled.code, scheduled.message)
    this.options.transitions.markOperationCompleted(run.runId)
    return {
      ok: true,
      data: {
        changed: true,
        scheduled: true,
        previous_root: run.rootPath,
        target_root: target.path,
        branch: target.branch,
        continuation: 'same_conversation_after_safe_boundary',
      },
    }
  }

  async create(
    context: CodeWorktreeAgentContext,
    input: {
      path?: unknown
      new_branch?: unknown
      existing_branch?: unknown
      base?: unknown
    },
  ): Promise<CodeWorktreeControllerResult> {
    const run = this.options.resolveTrustedRun(context)
    if (!run) return this.untrusted()
    const newBranch = input.new_branch == null ? null : readSafeGitRef(input.new_branch)
    const existingBranch = input.existing_branch == null ? null : readSafeGitRef(input.existing_branch)
    const base = input.base == null ? null : readSafeGitRef(input.base)
    if ((input.new_branch != null && !newBranch) || (input.existing_branch != null && !existingBranch) || (input.base != null && !base)) {
      return failure(400, 'VALIDATION_ERROR', '分支或 base ref 非法')
    }
    if (Boolean(newBranch) === Boolean(existingBranch)) {
      return failure(400, 'VALIDATION_ERROR', '--new-branch 与 --existing-branch 必须且只能提供一个')
    }
    if (existingBranch && base) {
      return failure(400, 'VALIDATION_ERROR', '--base 只能与 --new-branch 同用')
    }
    const requestedPath = input.path == null ? null : readAbsolutePath(input.path)
    if (input.path != null && !requestedPath) {
      return failure(400, 'VALIDATION_ERROR', '--path 提供时必须是绝对路径')
    }
    const branch = newBranch ?? existingBranch
    const targetPath = requestedPath ?? chooseAvailableAgentWorktreePath(
      buildManagedAgentWorktreeBasePath({
        managedRoot: this.options.managedWorktreeRoot ?? getHomeTabtinPath('worktrees'),
        repositoryRoot: run.rootPath,
        branch: branch!,
      }),
    )
    if (fs.existsSync(targetPath)) {
      return failure(409, 'WORKTREE_PATH_EXISTS', `目标路径已存在: ${targetPath}`)
    }
    const available = this.options.transitions.canSchedule(
      run.sessionId,
      run.runId,
      run.toolUseId,
    )
    if (!available.ok) return failure(409, available.code, available.message)
    const scheduled = this.options.transitions.schedule({
      sessionId: run.sessionId,
      runId: run.runId,
      toolUseId: run.toolUseId,
      previousRootPath: run.rootPath,
      targetRootPath: targetPath,
      branch: branch ?? undefined,
      spaceId: run.spaceId,
      tabScopeKey: run.tabScopeKey,
      created: true,
    })
    if (!scheduled.ok) return failure(409, scheduled.code, scheduled.message)

    if (!requestedPath) {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      } catch (error) {
        this.options.transitions.cancelPending(run.runId)
        return failure(
          400,
          'WORKTREE_CREATE_FAILED',
          `无法创建 Agent worktree 托管目录：${gitErrorMessage(error)}`,
        )
      }
    }

    try {
      await this.createWorktree(run.rootPath, {
        path: targetPath,
        branch: branch ?? undefined,
        createBranch: Boolean(newBranch),
        baseBranch: base ?? undefined,
      })
    } catch (error) {
      this.options.transitions.cancelPending(run.runId)
      return failure(400, 'WORKTREE_CREATE_FAILED', gitErrorMessage(error))
    }
    try {
      this.options.authorizePath(run, targetPath)
    } catch (error) {
      this.options.transitions.cancelPending(run.runId)
      return failure(403, 'PATH_AUTHORIZATION_FAILED', gitErrorMessage(error), {
        created: true,
        root_path: targetPath,
        retained: true,
      })
    }

    let createdPath = targetPath
    let createdBranch = branch
    try {
      const worktrees = await this.listWorktrees(run.rootPath)
      const created = worktrees.find((item) => worktreePathsMatch(item.path, targetPath))
      if (created) {
        createdPath = created.path
        createdBranch = created.branch ?? createdBranch
      }
    } catch {
      // The physical worktree exists; readiness below still leaves bind-time validation authoritative.
    }
    const completed = this.options.transitions.markOperationCompleted(run.runId, {
      targetRootPath: createdPath,
      branch: createdBranch ?? undefined,
    })
    if (!completed) {
      return failure(409, 'TRANSITION_CANCELLED', 'worktree 创建完成，但当前 Agent run 已结束', {
        created: true,
        root_path: createdPath,
        retained: true,
      })
    }
    return {
      ok: true,
      data: {
        created: true,
        scheduled: true,
        previous_root: run.rootPath,
        target_root: createdPath,
        branch: createdBranch,
        continuation: 'same_conversation_after_safe_boundary',
      },
    }
  }

  private untrusted(): CodeWorktreeControllerResult {
    return failure(403, 'UNTRUSTED_AGENT_RUN', '请求不属于当前顶层 Agent run')
  }
}

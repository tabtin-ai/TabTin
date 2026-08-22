/**
 * Git worktree domain service shared by renderer IPC and Agent CLI flows.
 * It owns argument construction, porcelain parsing, and same-repository checks;
 * callers remain responsible for product permission decisions.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitWorktreeInfo } from '@shared/git-types'

const execFileAsync = promisify(execFile)

export interface CreateGitWorktreeOptions {
  path: string
  branch?: string
  createBranch?: boolean
  baseBranch?: string
}

export type GitCommandRunner = (args: string[]) => Promise<string>

function normalizeFsPath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/').normalize('NFC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalExistingPath(value: string): string {
  return normalizeFsPath(fs.realpathSync.native(path.resolve(value)))
}

async function defaultGitRunner(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1',
    },
  })
  return stdout
}

export function parseWorktrees(raw: string, currentPath: string): GitWorktreeInfo[] {
  const entries = raw.trim().split('\n\n').filter(Boolean)
  const currentKey = normalizeFsPath(currentPath)

  return entries.map((entry, index): GitWorktreeInfo | null => {
    const info: GitWorktreeInfo = {
      path: '',
      branch: null,
      commitHash: null,
      isCurrent: false,
      isMainWorktree: index === 0,
      isDetached: false,
      isBare: false,
      isLocked: false,
    }

    for (const line of entry.split('\n')) {
      if (line.startsWith('worktree ')) {
        info.path = line.slice('worktree '.length).trim()
        info.isCurrent = normalizeFsPath(info.path) === currentKey
      } else if (line.startsWith('HEAD ')) {
        info.commitHash = line.slice('HEAD '.length).trim() || null
      } else if (line.startsWith('branch ')) {
        info.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '') || null
      } else if (line === 'detached') {
        info.isDetached = true
      } else if (line === 'bare') {
        info.isBare = true
      } else if (line === 'locked') {
        info.isLocked = true
      } else if (line.startsWith('locked ')) {
        info.isLocked = true
        info.lockReason = line.slice('locked '.length).trim()
      }
    }
    return info.path ? info : null
  }).filter((entry): entry is GitWorktreeInfo => entry !== null)
}

export async function listGitWorktrees(
  cwd: string,
  runner: GitCommandRunner = (args) => defaultGitRunner(cwd, args),
): Promise<GitWorktreeInfo[]> {
  const [currentPath, raw] = await Promise.all([
    runner(['rev-parse', '--show-toplevel']),
    runner(['worktree', 'list', '--porcelain']),
  ])
  return parseWorktrees(raw, currentPath.trim())
}

export function buildCreateWorktreeArgs(options: CreateGitWorktreeOptions): string[] {
  const worktreePath = options.path.trim()
  const branch = options.branch?.trim() || ''
  const baseBranch = options.baseBranch?.trim() || ''
  if (!worktreePath) throw new Error('worktree path is required')

  const args = ['worktree', 'add']
  if (options.createBranch) {
    if (!branch) throw new Error('branch is required when createBranch=true')
    args.push('-b', branch, worktreePath)
    if (baseBranch) args.push(baseBranch)
  } else {
    args.push(worktreePath)
    if (branch) args.push(branch)
  }
  return args
}

export async function createGitWorktree(
  cwd: string,
  options: CreateGitWorktreeOptions,
  runner: GitCommandRunner = (args) => defaultGitRunner(cwd, args),
): Promise<void> {
  await runner(buildCreateWorktreeArgs(options))
}

export async function resolveGitCommonDir(
  cwd: string,
  runner: GitCommandRunner = (args) => defaultGitRunner(cwd, args),
): Promise<string> {
  const raw = (await runner(['rev-parse', '--git-common-dir'])).trim()
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  return canonicalExistingPath(absolute)
}

export async function belongsToSameGitRepository(
  sourceRoot: string,
  targetRoot: string,
): Promise<boolean> {
  try {
    const [sourceCommonDir, targetCommonDir] = await Promise.all([
      resolveGitCommonDir(sourceRoot),
      resolveGitCommonDir(targetRoot),
    ])
    return sourceCommonDir === targetCommonDir
  } catch {
    return false
  }
}

export function worktreePathsMatch(left: string, right: string): boolean {
  try {
    return canonicalExistingPath(left) === canonicalExistingPath(right)
  } catch {
    return normalizeFsPath(path.resolve(left)) === normalizeFsPath(path.resolve(right))
  }
}

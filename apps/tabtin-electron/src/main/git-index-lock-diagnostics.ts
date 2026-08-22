/**
 * Git index.lock 现场采集。
 *
 * 只返回脱敏后的状态、时长和数量；绝对路径、进程命令行与 Git stderr
 * 都不会进入日志或诊断包。
 */

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** 无活跃 Git 进程且锁龄超过该阈值时，视为可安全清理的陈旧锁（默认 5 分钟） */
export const INDEX_LOCK_STALE_THRESHOLD_MS = 5 * 60 * 1_000

/**
 * 进程探测不可用时的兜底阈值：仅对空锁（0 字节）且锁龄超过该值才尝试清理，
 * 避免 ps/tasklist 失败时误删并发 Git 刚创建的锁。
 */
export const INDEX_LOCK_FORCE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1_000

export interface GitIndexLockDiagnostics {
  lockState: 'present' | 'missing' | 'unavailable'
  lockAgeMs?: number
  lockSizeBytes?: number
  lockProbeErrorCode?: string
  activeGitProcessCount: number | null
  processProbe: 'ok' | 'unsupported' | 'unavailable'
  processScope: 'system-wide'
}

interface ErrorWithCode {
  code?: unknown
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as ErrorWithCode).code
  return typeof code === 'string' || typeof code === 'number'
    ? String(code).slice(0, 32)
    : undefined
}

async function resolveGitDirectory(cwd: string): Promise<string> {
  const dotGitPath = path.join(cwd, '.git')
  const dotGitStat = await fs.promises.stat(dotGitPath)
  if (dotGitStat.isDirectory()) return dotGitPath
  if (!dotGitStat.isFile()) {
    throw Object.assign(new Error('unsupported Git metadata entry'), { code: 'GITDIR_TYPE' })
  }

  const pointer = await fs.promises.readFile(dotGitPath, 'utf8')
  const firstLine = pointer.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const match = /^gitdir:\s*(.+)$/i.exec(firstLine)
  if (!match?.[1]) {
    throw Object.assign(new Error('invalid Git metadata pointer'), { code: 'GITDIR_POINTER' })
  }
  return path.resolve(cwd, match[1])
}

export async function inspectIndexLock(
  cwd: string,
  now = Date.now,
): Promise<Pick<
  GitIndexLockDiagnostics,
  'lockState' | 'lockAgeMs' | 'lockSizeBytes' | 'lockProbeErrorCode'
>> {
  let gitDirectory: string
  try {
    gitDirectory = await resolveGitDirectory(cwd)
  } catch (error) {
    return {
      lockState: 'unavailable',
      lockProbeErrorCode: errorCode(error) ?? 'GITDIR_PROBE_FAILED',
    }
  }

  try {
    const lockStat = await fs.promises.stat(path.join(gitDirectory, 'index.lock'))
    return {
      lockState: 'present',
      lockAgeMs: Math.max(0, Math.round(now() - lockStat.mtimeMs)),
      lockSizeBytes: lockStat.size,
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { lockState: 'missing' }
    return {
      lockState: 'unavailable',
      lockProbeErrorCode: errorCode(error) ?? 'LOCK_PROBE_FAILED',
    }
  }
}

export function countGitProcessesFromOutput(
  platform: NodeJS.Platform,
  output: string,
): number {
  if (platform === 'win32') {
    return output
      .split(/\r?\n/)
      .map((line) => /^"([^"]+)"/.exec(line.trim())?.[1]?.toLowerCase())
      .filter((name) => name === 'git.exe')
      .length
  }

  return output
    .split(/\r?\n/)
    .map((line) => path.basename(line.trim()).toLowerCase())
    .filter((name) => name === 'git')
    .length
}

async function inspectActiveGitProcesses(): Promise<Pick<
  GitIndexLockDiagnostics,
  'activeGitProcessCount' | 'processProbe' | 'processScope'
>> {
  const platform = process.platform
  let command: string
  let args: string[]
  if (platform === 'win32') {
    command = 'tasklist'
    args = ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH']
  } else if (platform === 'darwin' || platform === 'linux') {
    command = 'ps'
    args = ['-A', '-o', 'comm=']
  } else {
    return {
      activeGitProcessCount: null,
      processProbe: 'unsupported',
      processScope: 'system-wide',
    }
  }

  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    })
    return {
      activeGitProcessCount: countGitProcessesFromOutput(platform, stdout),
      processProbe: 'ok',
      processScope: 'system-wide',
    }
  } catch {
    // 进程探测是诊断增强项；权限或平台命令不可用时不能影响 Git 操作。
    return {
      activeGitProcessCount: null,
      processProbe: 'unavailable',
      processScope: 'system-wide',
    }
  }
}

export async function collectGitIndexLockDiagnostics(
  cwd: string,
): Promise<GitIndexLockDiagnostics> {
  const [lock, processes] = await Promise.all([
    inspectIndexLock(cwd),
    inspectActiveGitProcesses(),
  ])
  return { ...lock, ...processes }
}

export function isStaleIndexLockCandidate(
  diagnostics: GitIndexLockDiagnostics,
  staleThresholdMs = INDEX_LOCK_STALE_THRESHOLD_MS,
): boolean {
  if (diagnostics.lockState !== 'present') return false
  if (diagnostics.lockAgeMs == null || diagnostics.lockAgeMs <= staleThresholdMs) {
    return false
  }
  if (diagnostics.processProbe === 'ok') {
    return diagnostics.activeGitProcessCount === 0
  }
  // 进程探测失败时，仅对极老空锁兜底（典型中断残留）。
  return (
    diagnostics.processProbe === 'unavailable' &&
    diagnostics.lockAgeMs >= INDEX_LOCK_FORCE_STALE_THRESHOLD_MS &&
    diagnostics.lockSizeBytes === 0
  )
}

export interface StaleIndexLockRemovalResult {
  removed: boolean
  staleLockCandidate: boolean
  removeErrorCode?: string
}

/**
 * 在确认无活跃 Git 进程且锁已超龄时，尝试删除陈旧 index.lock。
 * 不返回仓库路径；调用方自行记录脱敏诊断字段。
 */
export async function tryRemoveStaleIndexLock(
  cwd: string,
  now = Date.now,
): Promise<StaleIndexLockRemovalResult> {
  const lock = await inspectIndexLock(cwd, now)
  if (lock.lockState !== 'present') {
    return { removed: false, staleLockCandidate: false }
  }
  if (lock.lockAgeMs == null || lock.lockAgeMs <= INDEX_LOCK_STALE_THRESHOLD_MS) {
    return { removed: false, staleLockCandidate: false }
  }

  const processes = await inspectActiveGitProcesses()
  const diagnostics: GitIndexLockDiagnostics = { ...lock, ...processes }
  if (!isStaleIndexLockCandidate(diagnostics)) {
    return { removed: false, staleLockCandidate: false }
  }

  let gitDirectory: string
  try {
    gitDirectory = await resolveGitDirectory(cwd)
  } catch (error) {
    return {
      removed: false,
      staleLockCandidate: true,
      removeErrorCode: errorCode(error) ?? 'GITDIR_PROBE_FAILED',
    }
  }

  try {
    const lockPath = path.join(gitDirectory, 'index.lock')
    const [recheckLock, recheckProcesses] = await Promise.all([
      inspectIndexLock(cwd, now),
      inspectActiveGitProcesses(),
    ])
    const recheckDiagnostics: GitIndexLockDiagnostics = {
      ...recheckLock,
      ...recheckProcesses,
    }
    if (recheckLock.lockState !== 'present') {
      return { removed: false, staleLockCandidate: false }
    }
    if (!isStaleIndexLockCandidate(recheckDiagnostics)) {
      return {
        removed: false,
        staleLockCandidate: true,
        removeErrorCode: 'LOCK_STATE_CHANGED',
      }
    }
    await fs.promises.unlink(lockPath)
    return { removed: true, staleLockCandidate: true }
  } catch (error) {
    return {
      removed: false,
      staleLockCandidate: true,
      removeErrorCode: errorCode(error) ?? 'LOCK_REMOVE_FAILED',
    }
  }
}

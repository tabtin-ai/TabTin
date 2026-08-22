/**
 * DesktopUseLock — 桌面操控文件锁互斥
 *
 * 同一时间只允许一个 Agent session 操控桌面。
 * 使用 ~/.tabtin/desktop-use.lock (JSON: { sessionId, pid, acquiredAt })
 * 通过 O_EXCL 原子创建防竞争，死进程自动回收（PID 探活）。
 *
 * 桌面互斥锁设计说明
 */

import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createLogger } from '../logger'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'

const log = createLogger('DesktopUseLock')

const TABTIN_DIR = getHomeTabtinPath()
const LOCK_FILENAME = 'desktop-use.lock'

function getLockPath(): string {
  return join(TABTIN_DIR, LOCK_FILENAME)
}

// ---------------------------------------------------------------------------
// Lock payload
// ---------------------------------------------------------------------------

interface DesktopUseLockPayload {
  readonly sessionId: string
  readonly pid: number
  readonly acquiredAt: number
}

function isValidPayload(value: unknown): value is DesktopUseLockPayload {
  if (typeof value !== 'object' || value === null) return false
  return (
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'acquiredAt' in value &&
    typeof value.acquiredAt === 'number'
  )
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type AcquireResult =
  | { readonly kind: 'acquired'; readonly fresh: boolean }
  | { readonly kind: 'blocked'; readonly by: string }

export type CheckResult =
  | { readonly kind: 'free' }
  | { readonly kind: 'held_by_self' }
  | { readonly kind: 'blocked'; readonly by: string }

const FRESH: AcquireResult = { kind: 'acquired', fresh: true }
const REENTRANT: AcquireResult = { kind: 'acquired', fresh: false }

// ---------------------------------------------------------------------------
// 内部状态：当前进程是否持有锁
// ---------------------------------------------------------------------------

let heldSessionId: string | undefined
let cleanupRegistered = false

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

async function readLock(): Promise<DesktopUseLockPayload | undefined> {
  try {
    const raw = await readFile(getLockPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isValidPayload(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * PID 探活：signal 0 不发送信号，仅检查进程是否存在。
 * PID 复用概率极低，可接受。
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * O_EXCL 原子创建：操作系统保证至多一个进程成功创建。
 */
async function tryCreateExclusive(payload: DesktopUseLockPayload): Promise<boolean> {
  try {
    await writeFile(getLockPath(), JSON.stringify(payload), { flag: 'wx' })
    return true
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw e
  }
}

function registerProcessCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  app.on('before-quit', (e) => {
    if (!heldSessionId) return
    e.preventDefault()
    const doCleanup = async () => {
      try {
        const existing = await readLock()
        if (existing && existing.sessionId === heldSessionId) {
          await unlink(getLockPath()).catch(() => {})
        }
      } catch {
        // best-effort
      }
      heldSessionId = undefined
      app.quit()
    }
    doCleanup()
  })

  process.on('exit', () => {
    if (!heldSessionId) return
    try {
      const data = readFileSync(getLockPath(), 'utf8')
      const parsed = JSON.parse(data)
      if (parsed?.sessionId === heldSessionId) {
        unlinkSync(getLockPath())
      }
    } catch {
      // best-effort
    }
  })
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 零 syscall 快速检查：当前进程是否持有锁。
 * 用于 guard 逻辑中避免不必要的磁盘 IO。
 */
export function isHeldLocally(): boolean {
  return heldSessionId !== undefined
}

/**
 * 检查锁状态（不获取）。
 * 执行死进程回收，但不创建新锁。
 */
export async function check(sessionId: string): Promise<CheckResult> {
  const existing = await readLock()
  if (!existing) return { kind: 'free' }

  if (existing.sessionId === sessionId) return { kind: 'held_by_self' }

  if (isProcessRunning(existing.pid)) {
    return { kind: 'blocked', by: existing.sessionId }
  }

  // 死进程锁回收
  log.info(`回收死进程锁: session=${existing.sessionId}, pid=${existing.pid}`)
  await unlink(getLockPath()).catch(() => {})
  return { kind: 'free' }
}

/**
 * 尝试获取桌面操控锁。
 *
 * - acquired + fresh=true: 首次获取，调用者应触发 enter 通知
 * - acquired + fresh=false: 重入，同 session 已持有
 * - blocked: 另一个活跃 session 持有，fail-fast 不排队
 */
export async function tryAcquire(sessionId: string): Promise<AcquireResult> {
  const payload: DesktopUseLockPayload = {
    sessionId,
    pid: process.pid,
    acquiredAt: Date.now(),
  }

  await mkdir(TABTIN_DIR, { recursive: true })

  // 尝试原子创建
  if (await tryCreateExclusive(payload)) {
    heldSessionId = sessionId
    registerProcessCleanup()
    return FRESH
  }

  const existing = await readLock()

  // 锁文件损坏/不可解析——视为 stale
  if (!existing) {
    await unlink(getLockPath()).catch(() => {})
    if (await tryCreateExclusive(payload)) {
      heldSessionId = sessionId
      registerProcessCleanup()
      return FRESH
    }
    return { kind: 'blocked', by: (await readLock())?.sessionId ?? 'unknown' }
  }

  // 同 session 重入
  if (existing.sessionId === sessionId) {
    heldSessionId = sessionId
    return REENTRANT
  }

  // 其他活跃 session 持有——blocked
  if (isProcessRunning(existing.pid)) {
    return { kind: 'blocked', by: existing.sessionId }
  }

  // 死进程锁回收后重试
  log.info(`回收死进程锁: session=${existing.sessionId}, pid=${existing.pid}`)
  await unlink(getLockPath()).catch(() => {})

  if (await tryCreateExclusive(payload)) {
    heldSessionId = sessionId
    registerProcessCleanup()
    return FRESH
  }

  return { kind: 'blocked', by: (await readLock())?.sessionId ?? 'unknown' }
}

/**
 * 释放锁。仅当前 session 拥有时才释放。
 * 返回 true 表示实际释放了（调用者应触发 exit 通知），false 表示不持有。
 * 幂等：多次调用安全。
 */
export async function release(sessionId: string): Promise<boolean> {
  if (heldSessionId !== sessionId) return false

  heldSessionId = undefined

  const existing = await readLock()
  if (!existing || existing.sessionId !== sessionId) return false

  try {
    await unlink(getLockPath())
    log.info('桌面操控锁已释放')
    return true
  } catch {
    return false
  }
}

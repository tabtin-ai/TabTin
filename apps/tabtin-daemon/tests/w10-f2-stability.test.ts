/**
 * W10-F2: Stability & product fixes
 *
 * S5-01: File operation concurrency lock (per-path serialization)
 *
 * **Wave 1.5（2026-05-13）规约迁移**：
 *   - S5-01 原规约「Daemon action-bridge.ts 持有 `fileLockManager =
 *     new FileLockManager()` + 包 `FILE_POLICY_ACTIONS` 外层锁」已废弃。
 *     新规约：Daemon action-bridge 不再持锁；锁的责任收口到
 *     `@tabtin/action-tools/adapters/ActionExecutorAdapter` 一侧的
 *     `withFileLock`，所有 4 个写入口（agent-runtime adapter /
 *     ActionExecutorAdapter / FAB / action-bridge / Daemon MCP）共享同一
 *     个 module-level lockMap（详见 PRD §四.5 §1.5.B/C/D）。
 *   - S5-01 原 action type 字符串 `'file_write'` / `'file_edit'` 为 W10
 *     时拼写错误（生产代码实际是 `write_file` / `edit_file`），本期顺手修。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ACTION_BRIDGE_PATH = path.resolve(__dirname, '../src/application/execution/action-bridge.ts')
const ACTION_EXECUTOR_ADAPTER_PATH = path.resolve(
  __dirname,
  '../../../packages/action-tools/src/adapters/ActionExecutorAdapter.ts',
)

const bridgeSrc = fs.readFileSync(ACTION_BRIDGE_PATH, 'utf-8')
const adapterSrc = fs.readFileSync(ACTION_EXECUTOR_ADAPTER_PATH, 'utf-8')

// ---------------------------------------------------------------------------
// S5-01 (Wave 1.5 迁移)：File operation per-path serialization lock
// ---------------------------------------------------------------------------
describe('S5-01 (Wave 1.5) — Daemon action-bridge no longer holds fileLockManager', () => {
  it('Daemon action-bridge does NOT import FileLockManager / resolveFileLockPath', () => {
    // Wave 1.5：旧的 FileLockManager class + resolveFileLockPath 函数已彻底
    // 删除，daemon action-bridge 不再 import 它们。锁责任收口到
    // ActionExecutorAdapter（下方 it 验证）。
    expect(bridgeSrc).not.toMatch(/import\s*\{[^}]*FileLockManager[^}]*\}/)
    expect(bridgeSrc).not.toMatch(/import\s*\{[^}]*resolveFileLockPath[^}]*\}/)
  })

  it('Daemon action-bridge does NOT instantiate FileLockManager', () => {
    expect(bridgeSrc).not.toContain('new FileLockManager()')
  })

  it('Daemon action-bridge does NOT call fileLockManager.withLock', () => {
    expect(bridgeSrc).not.toContain('fileLockManager.withLock(')
  })

  it('Daemon action-bridge does NOT call resolveFileLockPath', () => {
    expect(bridgeSrc).not.toContain('resolveFileLockPath(')
  })

  it('Daemon action-bridge does NOT call fileLockManager.dispose', () => {
    expect(bridgeSrc).not.toContain('fileLockManager.dispose(')
  })

  it('Daemon action-bridge still maintains FILE_POLICY_ACTIONS for sandbox boundary', () => {
    // FILE_POLICY_ACTIONS 集合本身保留 —— enforcePolicy / afterAction 等位置
    // 用作「需要 sandbox boundary 检查的文件操作」标记，不只是锁专用。
    expect(bridgeSrc).toContain('FILE_POLICY_ACTIONS')
    const match = bridgeSrc.match(/const FILE_POLICY_ACTIONS = new Set\(\[([^\]]+)\]\)/)
    expect(match).not.toBeNull()
    const items = match![1]
    // 修正 W10 拼写：实际 action type 是 write_file / edit_file（不是 file_write / file_edit）
    expect(items).toContain("'write_file'")
    expect(items).toContain("'edit_file'")
    expect(items).toContain("'delete_file'")
    expect(items).not.toContain('execute_in_terminal')
    expect(items).not.toContain('tabdata_create_record')
  })
})

describe('S5-01 (Wave 1.5) — ActionExecutorAdapter holds the per-file lock', () => {
  it('ActionExecutorAdapter imports withFileLock and lets withFileLock canonicalize internally', () => {
    expect(adapterSrc).toMatch(/import\s*\{[^}]*withFileLock[^}]*\}\s*from\s*['"][^'"]*file-lock/)
    expect(adapterSrc).not.toMatch(/import\s*\{[^}]*canonicalizePath[^}]*\}\s*from\s*['"][^'"]*canonical-path/)
  })

  it('ActionExecutorAdapter declares FILE_LOCK_ACTIONS with the 3 file write types', () => {
    const match = adapterSrc.match(/const FILE_LOCK_ACTIONS = new Set\(\[([^\]]+)\]\)/)
    expect(match).not.toBeNull()
    const items = match![1]
    expect(items).toContain("'write_file'")
    expect(items).toContain("'edit_file'")
    expect(items).toContain("'delete_file'")
  })

  it('ActionExecutorAdapter wraps FILE_LOCK_ACTIONS in withFileLock', () => {
    expect(adapterSrc).toContain('FILE_LOCK_ACTIONS.has(type)')
    // Wave 3 L-19：withFileLock 内部负责 canonicalizePath，Adapter 不再先算 lockKey。
    // 这里守住 rawPath + baseDir + abortSignal 透传，避免重复 realpathSync。
    expect(adapterSrc).toMatch(
      /withFileLock\(\s*rawPath,\s*executeCore,\s*\{[^}]*baseDir:\s*wsRoot[^}]*abortSignal:\s*signal[^}]*\}\s*\)/s,
    )
  })

  it('ActionExecutorAdapter passes workspace_root as withFileLock baseDir', () => {
    expect(adapterSrc).toContain('baseDir: wsRoot')
    expect(adapterSrc).not.toMatch(/^\s*(?:const|let)\s+\w+\s*=\s*canonicalizePath\(rawPath,\s*wsRoot\)/m)
  })
})

describe('S5-01 (Wave 1.5) — withFileLock unit serialization logic', () => {
  it('serializes same-path operations, allows different-path parallel', async () => {
    // Wave 1.5：本测试同款 Wave 1 file-lock 14 条单测 + ActionExecutorAdapter 13 条
    // action-executor-lock 单测覆盖。此处保留最小回归验证「FIFO 同 key
    // 串行 + 不同 key 并行」语义，跟生产实现解耦。
    const locks = new Map<string, Promise<void>>()

    async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
      const normalized = path.resolve(filePath)
      const prev = locks.get(normalized) ?? Promise.resolve()
      let releaseLock!: () => void
      const next = new Promise<void>(r => { releaseLock = r })
      locks.set(normalized, next)
      try {
        await prev
        return await fn()
      } finally {
        releaseLock()
        if (locks.get(normalized) === next) {
          locks.delete(normalized)
        }
      }
    }

    const order: string[] = []

    const op1 = withFileLock('/a.txt', async () => {
      order.push('a1-start')
      await new Promise(r => setTimeout(r, 30))
      order.push('a1-end')
    })

    const op2 = withFileLock('/a.txt', async () => {
      order.push('a2-start')
      await new Promise(r => setTimeout(r, 10))
      order.push('a2-end')
    })

    const op3 = withFileLock('/b.txt', async () => {
      order.push('b1-start')
      await new Promise(r => setTimeout(r, 10))
      order.push('b1-end')
    })

    await Promise.all([op1, op2, op3])

    const a1End = order.indexOf('a1-end')
    const a2Start = order.indexOf('a2-start')
    expect(a2Start).toBeGreaterThan(a1End)

    const b1Start = order.indexOf('b1-start')
    expect(b1Start).toBeLessThan(a1End)
  })
})

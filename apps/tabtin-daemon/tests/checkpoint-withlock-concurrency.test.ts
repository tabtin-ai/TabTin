/**
 * CG-003 & CG-007 回归测试：withLock 超时拒绝并发写
 *
 * CG-007: 超时时拒绝新操作（而非强制并发执行）
 * CG-003: 由 CG-007 修复消除——addFiles 不再可能并发进入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('simple-git', () => {
  const gitMock = {
    init: vi.fn().mockResolvedValue(undefined),
    addConfig: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ commit: 'abc123' }),
    raw: vi.fn().mockResolvedValue('1'),
    getConfig: vi.fn().mockResolvedValue({ value: '/tmp/test-project' }),
    revparse: vi.fn().mockResolvedValue('abc123'),
    diffSummary: vi.fn().mockResolvedValue({ files: [] }),
    show: vi.fn().mockResolvedValue(''),
    reset: vi.fn().mockResolvedValue(undefined),
  }
  return { default: vi.fn(() => gitMock) }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  }
})

import { CheckpointService } from '../src/platform/workspace/checkpoint/CheckpointService.js'

const LOCK_TIMEOUT_MS = 120_000

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any
}

describe('CG-007: withLock rejects on timeout instead of concurrent execution', () => {
  let service: CheckpointService
  let logger: ReturnType<typeof createLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    logger = createLogger()
    service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', logger)
    ;(service as any).initialized = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects the new operation when the previous one exceeds timeout', async () => {
    const withLock = (service as any).withLock.bind(service)

    let resolveA!: () => void
    const opA = withLock(() => new Promise<string>((r) => { resolveA = r }))
    const opB = withLock(() => Promise.resolve('b-result'))

    const opBCheck = expect(opB).rejects.toThrow(/Lock acquisition timed out/)
    await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS + 100)
    await opBCheck

    resolveA()
    await vi.advanceTimersByTimeAsync(0)
    await opA.catch(() => {})
  })

  it('logs a warning when rejecting due to timeout', async () => {
    const withLock = (service as any).withLock.bind(service)

    let resolveA!: () => void
    const opA = withLock(() => new Promise<void>((r) => { resolveA = r }))
    const opB = withLock(() => Promise.resolve('ok'))

    const opBCatch = opB.catch(() => {})
    await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS + 100)
    await opBCatch

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejecting current operation'),
    )

    resolveA()
    await vi.advanceTimersByTimeAsync(0)
    await opA.catch(() => {})
  })

  it('does NOT reject when previous operation completes before timeout', async () => {
    const withLock = (service as any).withLock.bind(service)

    const resultA = await withLock(() => Promise.resolve('a-result'))
    expect(resultA).toBe('a-result')

    const resultB = await withLock(() => Promise.resolve('b-result'))
    expect(resultB).toBe('b-result')
  })

  it('queue recovers after timeout rejection — subsequent ops proceed normally', async () => {
    const withLock = (service as any).withLock.bind(service)

    let resolveA!: (v: string) => void
    const opA = withLock(() => new Promise<string>((r) => { resolveA = r }))
    const opB = withLock(() => Promise.resolve('b-result'))

    const opBCheck = expect(opB).rejects.toThrow(/Lock acquisition timed out/)
    await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS + 100)
    await opBCheck

    resolveA('a-result')
    await vi.advanceTimersByTimeAsync(0)
    expect(await opA).toBe('a-result')

    const resultC = await withLock(() => Promise.resolve('c-result'))
    expect(resultC).toBe('c-result')
  })
})

describe('CG-003: concurrent addFiles is prevented by withLock rejection (regression)', () => {
  let service: CheckpointService
  let logger: ReturnType<typeof createLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    logger = createLogger()
    service = new CheckpointService('/tmp/test-project', '/tmp/checkpoints', logger)
    ;(service as any).initialized = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('only one fn executes at a time — second is rejected on timeout', async () => {
    const withLock = (service as any).withLock.bind(service)
    let concurrency = 0
    let maxConcurrency = 0

    let resolveA!: () => void
    const opA = withLock(async () => {
      concurrency++
      maxConcurrency = Math.max(maxConcurrency, concurrency)
      await new Promise<void>((r) => { resolveA = r })
      concurrency--
      return 'a'
    })

    const opB = withLock(async () => {
      concurrency++
      maxConcurrency = Math.max(maxConcurrency, concurrency)
      concurrency--
      return 'b'
    })

    const opBCheck = expect(opB).rejects.toThrow(/Lock acquisition timed out/)
    await vi.advanceTimersByTimeAsync(LOCK_TIMEOUT_MS + 100)
    await opBCheck

    expect(maxConcurrency).toBe(1)

    resolveA()
    await vi.advanceTimersByTimeAsync(0)
    expect(await opA).toBe('a')
  })

  it('serializes operations correctly when no timeout occurs', async () => {
    const executionOrder: string[] = []
    const withLock = (service as any).withLock.bind(service)

    const op1 = withLock(async () => {
      executionOrder.push('op1-start')
      await Promise.resolve()
      executionOrder.push('op1-end')
      return 'op1'
    })

    const op2 = withLock(async () => {
      executionOrder.push('op2-start')
      await Promise.resolve()
      executionOrder.push('op2-end')
      return 'op2'
    })

    await vi.advanceTimersByTimeAsync(1)

    const [r1, r2] = await Promise.all([op1, op2])
    expect(r1).toBe('op1')
    expect(r2).toBe('op2')
    expect(executionOrder).toEqual(['op1-start', 'op1-end', 'op2-start', 'op2-end'])
  })
})

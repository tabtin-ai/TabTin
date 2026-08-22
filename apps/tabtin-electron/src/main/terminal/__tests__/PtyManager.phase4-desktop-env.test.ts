import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyManager } from '../PtyManager'
import type { PtyHostClient, PtyHostSession } from '../PtyHost'

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: () => null,
}))

/**
 * Phase 4（PRD §1.5）回归：桌面终端（noSpaceBinding）不绑任何执行 Space。
 *
 * 背景：cli-context 把当前活跃 Space 写进全局 `process.env.TABTIN_SPACE_ID`；
 * PtyManager.spawn 既会在无显式 spaceId 时从该 env 兜底，又会 `...process.env` 展开
 * 进子进程 env。若不处理，桌面终端 shell 内的 tabtin CLI 会静默落到当前活跃 Space
 * （执行串台）。本测试钉住「noSpaceBinding 时两个 Space 变量都不进 PTY env」。
 */
class MockHostSession implements PtyHostSession {
  pid = 4321
  write = vi.fn()
  pauseOutput = vi.fn()
  resumeOutput = vi.fn()
  resize = vi.fn()
  kill = vi.fn()
  onSpawned = vi.fn(() => ({ dispose: vi.fn() }))
  onData = vi.fn(() => ({ dispose: vi.fn() }))
  onExit = vi.fn(() => ({ dispose: vi.fn() }))
}

class MockPtyHostClient implements PtyHostClient {
  lastEnv: Record<string, string> | undefined
  spawn = vi.fn((opts: { env?: Record<string, string> }) => {
    this.lastEnv = opts.env
    return new MockHostSession()
  })
}

describe('PtyManager Phase4 桌面终端 env 隔离', () => {
  const prevSpace = process.env.TABTIN_SPACE_ID
  const prevAgentSpace = process.env.TABTIN_AGENT_SPACE_ID
  let hostClient: MockPtyHostClient
  let manager: PtyManager

  beforeEach(() => {
    hostClient = new MockPtyHostClient()
    manager = new PtyManager(hostClient, { terminateTree: vi.fn() } as never)
    // 模拟「当前有活跃 Space」：cli-context 会这样写全局 env。
    process.env.TABTIN_SPACE_ID = 'space-active'
    process.env.TABTIN_AGENT_SPACE_ID = 'space-active'
  })

  afterEach(() => {
    manager.cleanup()
    if (prevSpace == null) delete process.env.TABTIN_SPACE_ID
    else process.env.TABTIN_SPACE_ID = prevSpace
    if (prevAgentSpace == null) delete process.env.TABTIN_AGENT_SPACE_ID
    else process.env.TABTIN_AGENT_SPACE_ID = prevAgentSpace
  })

  it('noSpaceBinding=true（桌面终端）→ 子进程 env 不含活跃 Space 变量', () => {
    expect(manager.spawn('desktop-term', { noSpaceBinding: true })).toBe(true)
    const env = hostClient.lastEnv ?? {}
    expect(env.TABTIN_SPACE_ID).toBeUndefined()
    expect(env.TABTIN_AGENT_SPACE_ID).toBeUndefined()
  })

  it('显式 spaceId（执行终端）→ 子进程 env 带该 Space，不受活跃 env 干扰', () => {
    expect(manager.spawn('exec-term', { spaceId: 'space-x' })).toBe(true)
    const env = hostClient.lastEnv ?? {}
    expect(env.TABTIN_SPACE_ID).toBe('space-x')
    expect(env.TABTIN_AGENT_SPACE_ID).toBe('space-x')
  })

  it('既无 spaceId 也无 noSpaceBinding → 保留既有 env 兜底（不改非桌面调用方语义）', () => {
    expect(manager.spawn('legacy-term', {})).toBe(true)
    const env = hostClient.lastEnv ?? {}
    expect(env.TABTIN_SPACE_ID).toBe('space-active')
  })
})

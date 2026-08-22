import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const {
  createdUnsubscribers,
  closedUnsubscribers,
  mockListWithStatus,
  mockOnAgentSessionClosed,
  mockOnAgentSessionCreated,
  mockSpaceState,
  mockTerminalState,
  mockTranscriptState,
  mockTabsState,
} = vi.hoisted(() => ({
  createdUnsubscribers: [] as Array<ReturnType<typeof vi.fn>>,
  closedUnsubscribers: [] as Array<ReturnType<typeof vi.fn>>,
  mockListWithStatus: vi.fn().mockResolvedValue({ sessions: [] }),
  mockOnAgentSessionCreated: vi.fn(),
  mockOnAgentSessionClosed: vi.fn(),
  mockSpaceState: {
    selectedSpace: { id: 'space-1' } as { id: string } | null,
    spaces: [{ id: 'space-1' }, { id: 'space-2' }] as Array<{ id: string }>,
  },
  mockTerminalState: {
    sessionsBySpace: {} as Record<string, unknown[]>,
    addSpaceSession: vi.fn(),
    markSpaceSessionClosed: vi.fn(),
    updateSpaceSessionCwd: vi.fn(),
    removeSpaceSession: vi.fn(),
  },
  mockTranscriptState: {
    transcriptsById: {} as Record<string, unknown>,
    upsertTranscript: vi.fn(),
    markTranscriptClosed: vi.fn(),
    removeTranscript: vi.fn(),
  },
  mockTabsState: {
    itemsBySpace: {} as Record<string, Record<string, { tabKey: string; type: string; id: string }>>,
  },
}))

const useTerminalSessionStoreMock = Object.assign(
  (selector: (state: typeof mockTerminalState) => unknown) => selector(mockTerminalState),
  {
    getState: () => mockTerminalState,
  },
)

const useAgentTerminalTranscriptStoreMock = Object.assign(
  (selector: (state: typeof mockTranscriptState) => unknown) => selector(mockTranscriptState),
  {
    getState: () => mockTranscriptState,
  },
)

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof mockSpaceState) => unknown) => selector(mockSpaceState),
}))

const useSpaceContextTabsStoreMock = Object.assign(
  (selector: (state: typeof mockTabsState) => unknown) => selector(mockTabsState),
  {
    getState: () => mockTabsState,
  },
)

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: useSpaceContextTabsStoreMock,
}))

// 全量 mock（不能 importActual 真实模块——它会经 contextRegistry 拖入 homeRegistry
// 整条依赖链，在测试环境模块加载即崩）。deriveAgentTerminalSpaceId 用忠实复刻的实现：
// 真实实现的正则正确性已由 sources/terminal.test.ts 直接覆盖真身锁死，这里的副本只为
// 让 B2 回填集成测试拿到与生产一致的反解结果验证 hook 编排（回填 + P2 护栏 + 对账）。
vi.mock('@components/context-space/sources/terminal', () => ({
  useAgentTerminalTranscriptStore: useAgentTerminalTranscriptStoreMock,
  useTerminalSessionStore: useTerminalSessionStoreMock,
  // ⚠️ 漂移护栏：下面这行正则是 sources/terminal.ts 中 deriveAgentTerminalSpaceId 真身的
  // 逐字符副本。改真身正则时必须同步改这里，否则集成测试会拿到与生产不一致的反解结果。
  // 真身的正确性边界由 sources/terminal.test.ts 直接覆盖（此处副本仅驱动 hook 编排）。
  deriveAgentTerminalSpaceId: (sessionId: string | null | undefined): string | null => {
    if (!sessionId?.startsWith('agent-')) return null
    const rest = sessionId.slice('agent-'.length)
    const match = rest.match(/^(.+)-\d{10,17}(?:-[a-z0-9]+)?$/i)
    return match?.[1] || null
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: () => 'Agent Terminal',
  },
}))

describe('useAgentTerminalSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createdUnsubscribers.length = 0
    closedUnsubscribers.length = 0

    mockSpaceState.selectedSpace = { id: 'space-1' }
    mockSpaceState.spaces = [{ id: 'space-1' }, { id: 'space-2' }]
    mockTerminalState.sessionsBySpace = {}
    mockTranscriptState.transcriptsById = {}
    mockTabsState.itemsBySpace = {}

    mockOnAgentSessionCreated.mockImplementation(() => {
      const unsubscribe = vi.fn()
      createdUnsubscribers.push(unsubscribe)
      return unsubscribe
    })
    mockOnAgentSessionClosed.mockImplementation(() => {
      const unsubscribe = vi.fn()
      closedUnsubscribers.push(unsubscribe)
      return unsubscribe
    })

    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        pty: {
          onAgentSessionCreated: mockOnAgentSessionCreated,
          onAgentSessionClosed: mockOnAgentSessionClosed,
          listWithStatus: mockListWithStatus,
        },
      },
    })
  })

  it('始终建立单次全局订阅（不按 spaceId 拆分），并在卸载时退订', async () => {
    // ER-9 修复后：N 个 spaceId 也只发 1 次 IPC 订阅，避免重复 ×N。
    // PtyEventRouter 的 getSubscriberIds 会自动 merge 全局订阅者到任何 scope，
    // hook 内按 info.spaceId + knownSpaceIds 自己路由。
    //
    // D3 退役 agent-session-title 后：只剩 created / closed 两个 channel。
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    const { unmount } = renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockListWithStatus).toHaveBeenCalledTimes(1)
    })

    expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    expect(mockOnAgentSessionClosed).toHaveBeenCalledTimes(1)

    // 全局订阅：第一个参数是回调函数（不是 spaceId 字符串），第二个参数 undefined
    expect(typeof mockOnAgentSessionCreated.mock.calls[0][0]).toBe('function')
    expect(typeof mockOnAgentSessionClosed.mock.calls[0][0]).toBe('function')
    expect(mockOnAgentSessionCreated.mock.calls[0][1]).toBeUndefined()
    expect(mockOnAgentSessionClosed.mock.calls[0][1]).toBeUndefined()

    unmount()

    createdUnsubscribers.forEach((unsubscribe) => {
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })
    closedUnsubscribers.forEach((unsubscribe) => {
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })
  })

  it('在 space 上下文尚未就绪时仍保留单次全局兜底订阅', async () => {
    mockSpaceState.selectedSpace = null
    mockSpaceState.spaces = []
    mockTerminalState.sessionsBySpace = {}

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockListWithStatus).toHaveBeenCalledTimes(1)
    })

    expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    expect(mockOnAgentSessionClosed).toHaveBeenCalledTimes(1)

    expect(typeof mockOnAgentSessionCreated.mock.calls[0][0]).toBe('function')
    expect(typeof mockOnAgentSessionClosed.mock.calls[0][0]).toBe('function')
    expect(mockOnAgentSessionCreated.mock.calls[0][1]).toBeUndefined()
    expect(mockOnAgentSessionClosed.mock.calls[0][1]).toBeUndefined()
  })

  it('全局订阅：未知 spaceId 的事件被忽略，已知 spaceId 的事件被路由', async () => {
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    // 拿到 hook 注册的全局回调
    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
    }) => void
    const closedCallback = mockOnAgentSessionClosed.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
    }) => void

    // 已知 spaceId 的事件：只登记隐藏 transcript，不自动打开 Space tab。
    // title fallback：description 为空 → 用 `${i18n} · ${sessionId 后 6 位}`
    createdCallback({ sessionId: 'sess-known', spaceId: 'space-1', threadId: null, cwd: '/tmp' })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'sess-known', 'Agent Terminal · -known', '/tmp',
    )
    expect(mockTerminalState.addSpaceSession).not.toHaveBeenCalled()
    expect(mockTerminalState.updateSpaceSessionCwd).not.toHaveBeenCalled()

    closedCallback({ sessionId: 'sess-known', spaceId: 'space-1' })
    expect(mockTranscriptState.markTranscriptClosed).toHaveBeenCalledWith('space-1', 'sess-known')
    expect(mockTerminalState.markSpaceSessionClosed).toHaveBeenCalledWith('space-1', 'sess-known')

    // 重置后再发未知 spaceId 的事件：应被全部忽略
    mockTranscriptState.upsertTranscript.mockClear()
    mockTranscriptState.markTranscriptClosed.mockClear()
    mockTerminalState.markSpaceSessionClosed.mockClear()

    createdCallback({ sessionId: 'sess-x', spaceId: 'space-unknown', threadId: null, cwd: '/tmp' })
    closedCallback({ sessionId: 'sess-x', spaceId: 'space-unknown' })

    expect(mockTranscriptState.upsertTranscript).not.toHaveBeenCalled()
    expect(mockTranscriptState.markTranscriptClosed).not.toHaveBeenCalled()
    expect(mockTerminalState.markSpaceSessionClosed).not.toHaveBeenCalled()
  })

  it('D3b：同 space 下连发多条 agent-session-created → 每条只登记隐藏 transcript', async () => {
    // 业务核心：每次 Agent 命令独占 transcript session，但不自动打开 Space tab。
    // 多个并发 Agent session 各自登记，用户点击工具卡片时再显式打开。
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
      description?: string
    }) => void

    createdCallback({ sessionId: 'agent-sess-001abc', spaceId: 'space-1', threadId: null, cwd: '/work/a' })
    createdCallback({ sessionId: 'agent-sess-002def', spaceId: 'space-1', threadId: null, cwd: '/work/b' })
    createdCallback({ sessionId: 'agent-sess-003ghi', spaceId: 'space-1', threadId: null, cwd: '/work/c' })

    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledTimes(3)
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      1, 'space-1', 'agent-sess-001abc', 'Agent Terminal · 001abc', '/work/a',
    )
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      2, 'space-1', 'agent-sess-002def', 'Agent Terminal · 002def', '/work/b',
    )
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      3, 'space-1', 'agent-sess-003ghi', 'Agent Terminal · 003ghi', '/work/c',
    )

    // 3 个 title 全部不同，用户点击工具卡片打开时仍能区分
    const titles = mockTranscriptState.upsertTranscript.mock.calls.map((call) => call[2])
    expect(new Set(titles).size).toBe(3)
  })

  it('D3：description 字段优先于 sessionId 后缀（WP2 后续补字段后 hook 自动消费）', async () => {
    // 当 WP2 main 端 emit 补上 description（如命令首行截断）时，hook 优先用
    // description 作为 transcript 标题，sessionId 后缀降级为次选 fallback。
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
      description?: string
    }) => void

    createdCallback({
      sessionId: 'agent-sess-future',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      description: 'pnpm test --filter @tabtin/utils',
    })

    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-sess-future', 'pnpm test --filter @tabtin/utils', '/work',
    )

    // 空 / 纯空格 description 应 fallback 到 sessionId 后缀（trim 后为空，command 也未传）
    mockTranscriptState.upsertTranscript.mockClear()
    createdCallback({
      sessionId: 'agent-sess-emptydesc',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      description: '   ',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-sess-emptydesc', 'Agent Terminal · tydesc', '/work',
    )
  })

  // L-WP6-1：三级 fallback 中间级——description 缺失 + command 有值时走命令首行截断。
  // dogfood 场景：LLM 调 run_terminal_command 没显式传 description（最常见路径），
  // 用 command 首行作 transcript title，让「连跑 3 条命令」用户点开时能区分。
  it('L-WP6-1：description 缺失时用 command 首行作 transcript title', async () => {
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
      description?: string | null
      command?: string | null
    }) => void

    // 场景 1：短命令（dogfood 场景 2 之一）
    createdCallback({
      sessionId: 'agent-cmd-001abc',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: 'ls -la /home',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-cmd-001abc', 'ls -la /home', '/work',
    )

    // 场景 2：dogfood 场景 3「sleep 30」
    mockTranscriptState.upsertTranscript.mockClear()
    createdCallback({
      sessionId: 'agent-cmd-002def',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: 'sleep 30',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-cmd-002def', 'sleep 30', '/work',
    )

    // 场景 3：dogfood 场景 4「pnpm test --watch」
    mockTranscriptState.upsertTranscript.mockClear()
    createdCallback({
      sessionId: 'agent-cmd-003ghi',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: 'pnpm test --watch',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-cmd-003ghi', 'pnpm test --watch', '/work',
    )

    // 场景 4：长命令截断到 60 chars
    mockTranscriptState.upsertTranscript.mockClear()
    const longCommand =
      'pnpm exec eslint --fix --cache --max-warnings 0 apps/tabtin-electron/src/main/'
    createdCallback({
      sessionId: 'agent-cmd-004jkl',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: longCommand,
    })
    const expectedTitle = longCommand.slice(0, 60)
    expect(expectedTitle.length).toBe(60)
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-cmd-004jkl', expectedTitle, '/work',
    )

    // 场景 5：多行命令只取第一行（heredoc / 多行脚本）
    mockTranscriptState.upsertTranscript.mockClear()
    createdCallback({
      sessionId: 'agent-cmd-005mno',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: 'cat <<EOF\nhello\nworld\nEOF',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-cmd-005mno', 'cat <<EOF', '/work',
    )
  })

  // L-WP6-1：description 优先于 command —— LLM 明确传 description 时走第一级
  it('L-WP6-1：description 与 command 同时存在时优先用 description', async () => {
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
      description?: string | null
      command?: string | null
    }) => void

    createdCallback({
      sessionId: 'agent-both-001',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      description: '列出 home 目录文件',
      command: 'ls -la /home',
    })

    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-both-001', '列出 home 目录文件', '/work',
    )
  })

  // L-WP6-1：description 和 command 都缺失时走终极兜底（4 件套人控路径）
  it('L-WP6-1：description 和 command 都缺失时退化到 sessionId 后缀（人控路径）', async () => {
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
      description?: string | null
      command?: string | null
    }) => void

    // 模拟 PtyManager.spawnAgentSession 人控路径 emit（不带 command / description）
    createdCallback({
      sessionId: 'agent-human-001abcdef',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
    })

    // sessionId 后 6 位 = 'bcdef '？算一下：'agent-human-001abcdef' length=21, slice(-6)='abcdef'
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-human-001abcdef', 'Agent Terminal · abcdef', '/work',
    )

    // 空字符串 command 也走兜底（避免空串当成有效首行）
    mockTranscriptState.upsertTranscript.mockClear()
    createdCallback({
      sessionId: 'agent-empty-cmd-xyz789',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: '',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-empty-cmd-xyz789', 'Agent Terminal · xyz789', '/work',
    )

    // 纯空格 command（trim 后为空）也走兜底
    mockTranscriptState.upsertTranscript.mockClear()
    createdCallback({
      sessionId: 'agent-blank-cmd-uvw456',
      spaceId: 'space-1',
      threadId: null,
      cwd: '/work',
      command: '    ',
    })
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-blank-cmd-uvw456', 'Agent Terminal · uvw456', '/work',
    )
  })

  it('D3b：跨 space 并发 agent-session-created → 各自登记隐藏 transcript', async () => {
    // 并发场景下两个 space 同时收到事件，各自路由到自己的隐藏 transcript 记录
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
    }) => void

    createdCallback({ sessionId: 'agent-aaa-001', spaceId: 'space-1', threadId: null, cwd: '/a' })
    createdCallback({ sessionId: 'agent-bbb-002', spaceId: 'space-2', threadId: null, cwd: '/b' })

    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledTimes(2)
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      1, 'space-1', 'agent-aaa-001', 'Agent Terminal · aa-001', '/a',
    )
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      2, 'space-2', 'agent-bbb-002', 'Agent Terminal · bb-002', '/b',
    )
  })

  it('agent-session-created 携带空 cwd 时：第 5 参 fallback 为 undefined，不污染 session.cwd', async () => {
    // bridge 实现层在某些边界（如 process.cwd() 抛错）下可能返回空 string；
    // hook 把空 string 视为缺失，让 store 走 undefined fallback，避免下游
    // 把 "" 误当成有效路径展示在 tab UI。
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
    }) => void

    createdCallback({ sessionId: 'agent-emptycwd-1', spaceId: 'space-1', threadId: null, cwd: '' })

    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
      'space-1', 'agent-emptycwd-1', 'Agent Terminal · ycwd-1', undefined,
    )
  })

  it('R1 P1-4：同一 sessionId 重复 emit → hook 不去重，转交 store dedup 兜底', async () => {
    // hook 的注释明示"重复 emit 由 store 内部 dedup 兜底"——这是 D3 防御性
    // 设计：hook 只做"事件→Tab"映射，不在 hook 层做幂等逻辑（让 store 单点
    // 处理避免双层 dedup 漂移）。本用例锁住这个不变量：未来若有人在 hook
    // 加 dedup（破坏分层），测试会失败提醒。
    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockOnAgentSessionCreated).toHaveBeenCalledTimes(1)
    })

    const createdCallback = mockOnAgentSessionCreated.mock.calls[0][0] as (info: {
      sessionId: string
      spaceId?: string
      threadId: string | null
      cwd: string
    }) => void

    // 同一个 sessionId 连发 2 次（PtyManager bug 或网络抖动 IPC 重发场景）
    createdCallback({ sessionId: 'agent-dup-001', spaceId: 'space-1', threadId: null, cwd: '/x' })
    createdCallback({ sessionId: 'agent-dup-001', spaceId: 'space-1', threadId: null, cwd: '/x' })

    // hook 不去重 → transcript upsert 调用 2 次（store 内部保留同一 id）
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledTimes(2)
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      1, 'space-1', 'agent-dup-001', 'Agent Terminal · up-001', '/x',
    )
    expect(mockTranscriptState.upsertTranscript).toHaveBeenNthCalledWith(
      2, 'space-1', 'agent-dup-001', 'Agent Terminal · up-001', '/x',
    )
  })

  it('R1 P1-5：window.tabtin.pty / onAgentSessionCreated 未注入时 hook 不崩，cleanup 安全', async () => {
    // preload 初始化失败 / IPC API 缺失 / 测试环境裸跑等场景下，
    // hook 内部用可选链 `pty?.onAgentSessionCreated?.()` 防御。本用例锁住
    // 这条 silent-noop 路径：渲染 + 卸载全程不抛错。
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { pty: {} }, // pty 存在但所有方法都缺失
    })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    const { unmount } = renderHook(() => useAgentTerminalSync())

    // 异步路径（syncFromMainProcess）也走 listWithStatus?.() 兜底——不应抛错
    await new Promise(resolve => setTimeout(resolve, 10))

    // 卸载不应抛错（cleanup 内 unsubCreated?.() / unsubClosed?.() 是 undefined 调用）
    expect(() => unmount()).not.toThrow()

    // 没有 IPC API 时不会调任何 store 方法
    expect(mockTranscriptState.upsertTranscript).not.toHaveBeenCalled()
    expect(mockTerminalState.markSpaceSessionClosed).not.toHaveBeenCalled()
  })

  it('R1 P1-5：window.tabtin 整体缺失时 hook 不崩', async () => {
    // 极端场景：preload 完全没注入 window.tabtin
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: undefined,
    })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')

    expect(() => {
      const { unmount } = renderHook(() => useAgentTerminalSync())
      unmount()
    }).not.toThrow()
  })

  it('R3 P1-5：B2 回填——live agent 会话回填到 derived spaceId，且回填项不被假运行对账标 closed', async () => {
    // 让 upsert mock 真正写入 transcriptsById，使后续「假运行对账」循环能遍历到回填项，
    // 由此验证「先回填再对账」的顺序正确：回填项在 liveIds 里 → 对账不会误标 closed。
    // createdAt 设为 60s 前（> FRESH_WINDOW 10s），确保「不被标 closed」靠的是 liveIds
    // 成员判定，而不是 fresh 窗口豁免——否则测试无法区分两条护栏。
    mockTranscriptState.upsertTranscript.mockImplementationOnce(
      (spaceId: string, sessionId: string, title: string | undefined, cwd: string | undefined) => {
        mockTranscriptState.transcriptsById[sessionId] = {
          id: sessionId,
          spaceId,
          title: title ?? 't',
          createdAt: Date.now() - 60_000,
          source: 'agent',
          status: 'active',
          cwd,
        }
      },
    )
    // live 含两条：① derived spaceId 已知（space-1）→ 应回填；② derived spaceId 未知
    //（space-unknown，不在 knownSpaceIds）→ 被 P2 护栏挡掉，避免幻影「未知 Agent」分组。
    mockListWithStatus.mockResolvedValueOnce({
      sessions: [
        { id: 'agent-space-1-1700000000000', cwd: '/work/a' },
        { id: 'agent-space-unknown-1700000000000', cwd: '/work/b' },
      ],
    })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')
    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledWith(
        'space-1', 'agent-space-1-1700000000000', undefined, '/work/a',
      )
    })

    // 仅回填已知 spaceId（space-1）；未知 spaceId（space-unknown）被 P2 护栏挡掉
    expect(mockTranscriptState.upsertTranscript).toHaveBeenCalledTimes(1)

    // 回填项在 liveIds 里 → 假运行对账不会把它误标 closed。关键护栏是 liveIds 成员判定
    //（回填的会话本就活着，必在 liveIds 中），与下方「对账该关则关」正面用例配对，
    // 共同锁住「活着的回填项不被误杀、真死掉的才标 closed」这条治假运行主线。
    expect(mockTranscriptState.markTranscriptClosed).not.toHaveBeenCalled()
  })

  it('R3 P1-5：假运行对账——transcript 的 PTY 已不在且过 fresh 窗口 → 主动标 closed', async () => {
    // 正面用例（防对账主线整体失效）：transcript 已登记 active，但 listWithStatus 不含它
    //（PTY 已退 / 重载漏收 agent-session-closed 事件），且 createdAt 过了 fresh 窗口
    //（排除"刚创建还没进 PTY 列表"竞态）→ 必须被主动标 closed，否则总览一直脉冲"运行中"。
    // 与上方回填用例互为正反：删掉对账循环时本用例翻红，删掉 liveIds 护栏时上方翻红。
    mockTranscriptState.transcriptsById = {
      'agent-space-1-1700000000000': {
        id: 'agent-space-1-1700000000000',
        spaceId: 'space-1',
        title: 'stale',
        createdAt: Date.now() - 60_000,
        source: 'agent',
        status: 'active',
      },
    }
    mockListWithStatus.mockResolvedValueOnce({ sessions: [] })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')
    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockTranscriptState.markTranscriptClosed).toHaveBeenCalledWith(
        'space-1', 'agent-space-1-1700000000000',
      )
    })
  })

  it('#2726：zombie-GC——active agent 会话 PTY 已不在且过 fresh 窗口且无可见 tab → 移除', async () => {
    // 无 tab 场景：materialize 出来的 agent 会话 PTY 已退、过了 fresh 窗口、
    // 且 itemsBySpace 里没有对应 terminal item（用户已关或从没真正打开）→ 走原
    // 僵尸清理，从 sessionsBySpace 移除。锁住"该清的还得清"这条主线不被豁免误伤。
    mockTerminalState.sessionsBySpace = {
      'conversation:sess-1': [
        {
          id: 'agent-space-1-1700000000000',
          title: 'ls',
          createdAt: Date.now() - 60_000,
          source: 'agent',
          status: 'active',
        },
      ],
    }
    mockListWithStatus.mockResolvedValueOnce({ sessions: [] })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')
    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockTerminalState.removeSpaceSession).toHaveBeenCalledWith(
        'conversation:sess-1', 'agent-space-1-1700000000000',
      )
    })
  })

  it('#2726：用户打开的历史终端 tab 豁免自动回收——itemsBySpace 有对应 terminal item → 不移除', async () => {
    // 核心回归：修复「点开查看终端后过一会儿自动关闭」。同一条会话（active、PTY
    // 已退、过 fresh 窗口），但 itemsBySpace 里存在对应 terminal item（用户此刻正
    // 开着它回看快照）→ 豁免僵尸清理，像其它资源 tab 一样「手动关才关」。
    mockTerminalState.sessionsBySpace = {
      'conversation:sess-1': [
        {
          id: 'agent-space-1-1700000000000',
          title: 'ls',
          createdAt: Date.now() - 60_000,
          source: 'agent',
          status: 'active',
        },
      ],
    }
    mockTabsState.itemsBySpace = {
      'conversation:sess-1': {
        'terminal:agent-space-1-1700000000000': {
          tabKey: 'terminal:agent-space-1-1700000000000',
          type: 'terminal',
          id: 'agent-space-1-1700000000000',
        },
      },
    }
    mockListWithStatus.mockResolvedValueOnce({ sessions: [] })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')
    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockListWithStatus).toHaveBeenCalledTimes(1)
    })
    // 给对账循环留出执行窗口后确认：有可见 tab 的会话不被移除
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mockTerminalState.removeSpaceSession).not.toHaveBeenCalled()
  })

  it('#2726：closed retention-GC 同样豁免仍有可见 tab 的会话', async () => {
    // closed + 超 5min 保留期，但用户还开着 tab → 不移除（手动关才关）。
    mockTerminalState.sessionsBySpace = {
      'conversation:sess-1': [
        {
          id: 'agent-space-1-1700000000000',
          title: 'ls',
          createdAt: Date.now() - 10 * 60_000,
          closedAt: Date.now() - 10 * 60_000,
          source: 'agent',
          status: 'closed',
        },
      ],
    }
    mockTabsState.itemsBySpace = {
      'conversation:sess-1': {
        'terminal:agent-space-1-1700000000000': {
          tabKey: 'terminal:agent-space-1-1700000000000',
          type: 'terminal',
          id: 'agent-space-1-1700000000000',
        },
      },
    }
    mockListWithStatus.mockResolvedValueOnce({ sessions: [] })

    const { useAgentTerminalSync } = await import('../useAgentTerminalSync')
    renderHook(() => useAgentTerminalSync())

    await waitFor(() => {
      expect(mockListWithStatus).toHaveBeenCalledTimes(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mockTerminalState.removeSpaceSession).not.toHaveBeenCalled()
  })
})

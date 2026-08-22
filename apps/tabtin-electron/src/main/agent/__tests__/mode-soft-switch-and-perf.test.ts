/**
 * W1-A-LEG-1/2/3 — mode 切换软切换 + loadCLIReference 异步缓存 + ToolProvider 工具缓存。
 *
 * 测试边界：
 *   - 不依赖 Electron 主进程 API（vi.mock 隔离）
 *   - 直接构造 ElectronToolProvider 验证缓存与 reconfigure 行为
 *   - 源码契约扫描验证 ElectronAgentHost 软切换路径存在
 */

import {
  describe,
  it,
  expect,
  vi,
} from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}))
vi.mock('electron-log', () => {
  const noop = () => {}
  const logObj = { info: noop, warn: noop, error: noop, debug: noop }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logObj,
      scope: () => logObj,
      info: noop, warn: noop, error: noop, debug: noop,
    },
  }
})
vi.mock('../../../services/local-mcp-agent-tools', () => ({
  localMcpAgentTools: [],
}))
vi.mock('../../../services/LocalMcpService', () => ({
  getLocalMcpService: () => ({
    listAttachedServers: () => [],
    onToolCacheInvalidated: () => () => {},
  }),
}))

const { ElectronToolProvider } = await import('../capabilities/ElectronToolProvider')
type AgentModeName = 'ask' | 'agent' | 'plan' | 'study' | 'group'

// ─── LEG-3: ElectronToolProvider getTools 缓存 ──────────────────────

describe('LEG-3: ElectronToolProvider.getTools() caching', () => {
  function makeProvider(mode?: AgentModeName) {
    return new ElectronToolProvider({
      securityPreset: 'collaborative',
      agentMode: mode,
    })
  }

  it('returns cached result on second call (referential equality)', () => {
    const provider = makeProvider('agent')
    const first = provider.getTools()
    const second = provider.getTools()
    expect(second).toBe(first)
  })

  it('cache hit contains same tools as fresh build', () => {
    const provider = makeProvider('agent')
    const first = provider.getTools()
    const names1 = first.map(t => t.name).sort()
    const second = provider.getTools()
    const names2 = second.map(t => t.name).sort()
    expect(names2).toEqual(names1)
  })

  it('invalidateToolCache forces rebuild', () => {
    const provider = makeProvider('agent')
    const first = provider.getTools()
    provider.invalidateToolCache()
    const second = provider.getTools()
    expect(second).not.toBe(first)
    expect(second.map(t => t.name).sort()).toEqual(first.map(t => t.name).sort())
  })

  it('different provider instances do not share cache', () => {
    const p1 = makeProvider('agent')
    const p2 = makeProvider('plan')
    const tools1 = p1.getTools()
    const tools2 = p2.getTools()
    expect(tools1).not.toBe(tools2)
    const names1 = new Set(tools1.map(t => t.name))
    const names2 = new Set(tools2.map(t => t.name))
    // **Agent mode Phase 1（2026-05-27）**：filterToolsForMode 退化为 identity。
    // plan 模式仍能"看到" edit_file，但 description 末尾追加 mode annotation；
    // 调用时由 judge.ts step 0 / plan-mode-guard 软拒。
    expect(names1.has('edit_file')).toBe(true)
    expect(names2.has('edit_file')).toBe(true)
    // 验证 plan 模式下 edit_file 的 description 携带 [Plan mode] annotation
    const planEdit = tools2.find(t => t.name === 'edit_file')
    expect(planEdit?.description).toMatch(/\[Plan mode\]/)
    // 对照：agent 模式 edit_file 不应携带 annotation
    const agentEdit = tools1.find(t => t.name === 'edit_file')
    expect(agentEdit?.description).not.toMatch(/\[Plan mode\]/)
  })
})

// ─── LEG-1: ElectronToolProvider.reconfigure (soft switch) ──────────

describe('LEG-1: ElectronToolProvider.reconfigure (soft switch)', () => {
  function makeProvider(mode?: AgentModeName) {
    return new ElectronToolProvider({
      securityPreset: 'collaborative',
      agentMode: mode,
    })
  }

  it('reconfigure changes agentMode and invalidates cache', () => {
    const provider = makeProvider('agent')
    expect(provider.getAgentMode()).toBe('agent')
    const firstTools = provider.getTools()
    const firstEdit = firstTools.find(t => t.name === 'edit_file')
    expect(firstEdit).toBeDefined()
    expect(firstEdit?.description).not.toMatch(/\[Plan mode\]/)

    provider.reconfigure({ agentMode: 'plan' })
    expect(provider.getAgentMode()).toBe('plan')

    const secondTools = provider.getTools()
    expect(secondTools).not.toBe(firstTools)
    // **Agent mode Phase 1**：plan 模式仍含 edit_file（filter 退化为 identity），
    // 但 description 末尾追加 [Plan mode] mode annotation；调用时由 guard 软拒。
    const secondEdit = secondTools.find(t => t.name === 'edit_file')
    expect(secondEdit).toBeDefined()
    expect(secondEdit?.description).toMatch(/\[Plan mode\]/)
  })

  it('reconfigure from plan to agent removes mode annotation from edit_file', () => {
    const provider = makeProvider('plan')
    const planEdit = provider.getTools().find(t => t.name === 'edit_file')
    expect(planEdit?.description).toMatch(/\[Plan mode\]/)

    provider.reconfigure({ agentMode: 'agent' })
    const agentEdit = provider.getTools().find(t => t.name === 'edit_file')
    expect(agentEdit).toBeDefined()
    expect(agentEdit?.description).not.toMatch(/\[Plan mode\]/)
  })

  it('reconfigure updates agentToolDeps.agentMode for child agents', () => {
    const agentToolDeps = {
      provider: {} as any,
      permissionHandler: {} as any,
      sessionConfig: { sessionDir: '/tmp', threadId: 'test' },
      model: 'test',
      budgetTracker: {} as any,
      agentMode: 'agent' as AgentModeName,
    }

    const provider = new ElectronToolProvider({
      securityPreset: 'collaborative',
      agentMode: 'agent',
      agentToolDeps,
    })

    expect(agentToolDeps.agentMode).toBe('agent')
    provider.reconfigure({ agentMode: 'plan' })
    expect(agentToolDeps.agentMode).toBe('plan')
  })

  it('reconfigure falls back to "agent" for unknown mode', () => {
    const provider = makeProvider('plan')
    provider.reconfigure({ agentMode: 'xxxx-bad' as unknown as AgentModeName })
    expect(provider.getAgentMode()).toBe('agent')
  })
})

// ─── LEG-1: Host 源码契约 — 软切换路径存在且保留 budget ─────────────

describe('LEG-1: ElectronAgentHost source contract (soft switch)', () => {
  // soft-reconfigure / factory adapter 已抽到 ElectronRuntimeAssembly；
  // HostState 类型在 electron-agent-types.ts。
  const runtimePath = path.resolve(__dirname, '..', 'runtime', 'electron-runtime-assembly.ts')
  const typesPath = path.resolve(__dirname, '..', 'electron-agent-types.ts')
  const source = fs.readFileSync(runtimePath, 'utf-8')
  const typesSource = fs.readFileSync(typesPath, 'utf-8')

  it('delegates reuse decision to the shared RuntimeSessionFactory adapter', () => {
    // 阶段 1：reuse / soft-reconfigure / rebuild 决策下沉到共享 factory；
    // assembly 适配器暴露 canSoftReconfigure + softReconfigure 钩子。
    expect(source).toContain('canSoftReconfigure: (existing, request) =>')
    expect(source).toContain('canSoftReconfigureByShellTier(existing.agentMode, request.mode)')
    expect(source).toContain('softReconfigure: async (existing, request) =>')
    expect(source).toContain('this.softReconfigureExisting(existing, request.mode, request.input)')
  })

  it('soft switch branch does NOT dispose sessionStorage or syncQueue', () => {
    const softSwitchBlock = extractBlock(
      source,
      'async softReconfigureExisting(',
      // 方法边界：紧随其后的 `async buildHostState(` 出现即视作结束。
      'async buildHostState(',
    )
    expect(softSwitchBlock).toBeTruthy()
    expect(softSwitchBlock).not.toContain('syncQueue.dispose')
    expect(softSwitchBlock).not.toContain('sessionStorage.dispose')
  })

  it('soft switch branch reconfigures toolProvider', () => {
    const softSwitchBlock = extractBlock(
      source,
      'async softReconfigureExisting(',
      'async buildHostState(',
    )
    expect(softSwitchBlock).toContain('toolProvider.reconfigure')
  })

  it('soft switch branch retains enabled App metadata in the rebuilt prompt', () => {
    const softSwitchBlock = extractBlock(
      source,
      'async softReconfigureExisting(',
      'async buildHostState(',
    )
    expect(softSwitchBlock).toContain('enabledApps: input.enabledApps')
  })

  it('soft switch branch mutates engineConfig.systemPrompt and engineConfig.agentMode', () => {
    const softSwitchBlock = extractBlock(
      source,
      'async softReconfigureExisting(',
      'async buildHostState(',
    )
    expect(softSwitchBlock).toContain('engineConfig.systemPrompt')
    expect(softSwitchBlock).toContain('engineConfig.agentMode')
  })

  it('soft switch clears active plans only when leaving plan family for non-plan mode', () => {
    const softSwitchBlock = extractBlock(
      source,
      'async softReconfigureExisting(',
      'async buildHostState(',
    )
    expect(softSwitchBlock).toContain('clearAllActivePlansForSession')
    expect(softSwitchBlock).toContain('leavingPlanFamily && !enteringPlanFamily')
    // PlanApprovalCoordinator 已删除：mode_soft_switch dispose reason 不再使用。
    expect(softSwitchBlock).not.toContain('mode_soft_switch')
  })

  it('HostState includes engineConfig field', () => {
    expect(typesSource).toContain('engineConfig: EngineConfig')
  })

  //  回归守护：受限↔非受限模式切换时 shell 白名单档位变化，ShellCap
  // restrictedShellChecker 创建期烘焙无法热更，必须走完整重建而非软切换。
  it('#712: soft switch is gated by shell restriction tier change', () => {
    // 判定共享化后统一走 `canSoftReconfigureByShellTier`（Electron/Daemon 同款）。
    // 断言 shared 谓词的接线保持稳定，防止未来被换回本地 diff 时静默回归。
    expect(source).toContain('canSoftReconfigureByShellTier')
    expect(source).toContain('canSoftReconfigure: (existing, request) =>')
    expect(source).toContain('canSoftReconfigureByShellTier(existing.agentMode, request.mode)')
  })
})

// ─── LEG-2: Host 源码契约 — loadCLIReference 异步 + 缓存 ────────────

describe('LEG-2: ElectronAgentHost source contract (async CLI reference)', () => {
  const runtimePath = path.resolve(__dirname, '..', 'runtime', 'electron-runtime-assembly.ts')
  const source = fs.readFileSync(runtimePath, 'utf-8')

  it('does NOT use execSync for CLI reference loading', () => {
    expect(source).not.toMatch(/execSync\s*\(/)
  })

  // ：旧 baked cliReference（loadCLIReferenceAsync + cliReferenceCache/TTL 常量）已下线，
  // CLI 能力改由 CliCap 两区注入；原「execFileAsync loadCLIReferenceAsync」「CLI reference cache」
  // 两条源码契约断言随之移除。CliCap 装配契约见下方「assembles CliCap」。

  it('does NOT have buildDefaultSystemPrompt (replaced by @tabtin/agent-prompt)', () => {
    expect(source).not.toContain('buildDefaultSystemPrompt')
  })

  it('imports system-prompt types from @tabtin/agent-prompt', () => {
    expect(source).toContain("from '@tabtin/agent-prompt'")
  })

  // ：旧 baked cliReference（loadCLIReferenceAsync / invalidateCLIReferenceCache）已下线，
  // CLI 能力改由 CliCap 两区注入；system prompt 经 assembleSystemPrompt 装配。
  it('assembles CliCap for two-zone CLI injection', () => {
    expect(source).toContain('new CliCap(')
    expect(source).toContain('createGatedCliListingFetcher(organizationId)')
    expect(source).toContain('assembleSystemPrompt(')
  })
})

// ─── LEG-3: Host 源码契约 — ToolProvider 缓存 ───────────────────────

describe('LEG-3: ElectronToolProvider source contract (tool cache)', () => {
  const providerPath = path.resolve(__dirname, '..', 'capabilities', 'ElectronToolProvider.ts')
  const source = fs.readFileSync(providerPath, 'utf-8')

  it('has cachedTools field', () => {
    expect(source).toContain('cachedTools')
  })

  it('getTools checks cache before building', () => {
    expect(source).toMatch(/if\s*\(\s*this\.cachedTools\s*\)/)
  })

  it('getTools stores result in cache after building', () => {
    expect(source).toContain('this.cachedTools = result')
  })

  it('invalidateToolCache sets cache to null', () => {
    expect(source).toContain('invalidateToolCache')
    expect(source).toMatch(/this\.cachedTools\s*=\s*null/)
  })

  it('reconfigure method body sets cachedTools to null', () => {
    const methodStart = source.indexOf('reconfigure(opts:')
    const bodyStart = source.indexOf('{', methodStart)
    const relevantSlice = source.slice(bodyStart, bodyStart + 500)
    expect(relevantSlice).toContain('this.cachedTools = null')
  })

  it('implements refreshTools to invalidate cache', () => {
    expect(source).toContain('async refreshTools')
  })
})

// ─── P0-3: run_terminal_command shell 受限提示 ──────────────────────
//
// **历史 dogfood 痛点**：受限模式（plan/ask/study）下 `run_terminal_command`
// 在 contract `allowToolNames` 里，所以原 annotateToolsForMode 跳过它（因为
// isToolAllowedByPolicy 返回 true）。模型完全不知道 shell 受
// `tabtin-readonly` allowlist 过滤，本能调 `ls -la` → 撞墙 → 才学到边界。
//
// P0-3 修复：annotateToolsForMode 对 `run_terminal_command` **始终额外注入**
// shell 受限提示（不论它是否在 allow 列表）。本测试集守护：
//   - plan/ask/study 模式：run_terminal_command.description 含 `[X mode] Shell is restricted`
//   - 替代工具映射（ls→glob_search 等）出现在 description
//   - agent/yolo/group 模式不注入（不限制 shell）

describe('P0-3: run_terminal_command shell 受限提示注入', () => {
  function makeProvider(mode?: AgentModeName) {
    return new ElectronToolProvider({
      securityPreset: 'collaborative',
      agentMode: mode,
    })
  }

  it.each([
    ['plan', 'Plan'],
    ['ask', 'Ask'],
    ['study', 'Study'],
  ] as const)('%s 模式：run_terminal_command 含 shell 受限提示', (mode, label) => {
    const provider = makeProvider(mode)
    const shellTool = provider.getTools().find(t => t.name === 'run_terminal_command')
    // run_terminal_command 由 ShellCap 装配（非 ToolProvider），这里 mock 场景
    // 下可能不存在。仅当存在时断言注入；不存在则跳过（不算 fail）。
    if (!shellTool) {
      // ToolProvider 中没有 run_terminal_command（由 ShellCap 在装配阶段加入），
      // 我们直接对 annotateToolsForMode 做单元测试（下方独立 describe 覆盖）。
      return
    }
    expect(shellTool.description, `${mode} mode shell tool should be annotated`)
      .toMatch(new RegExp(`\\[${label} mode\\] Shell is restricted`))
    expect(shellTool.description).toMatch(/ls→glob_search/)
    expect(shellTool.description).toMatch(/cat→read_file/)
  })

  it('agent 模式：run_terminal_command 不带 shell 受限提示', () => {
    const provider = makeProvider('agent')
    const shellTool = provider.getTools().find(t => t.name === 'run_terminal_command')
    if (!shellTool) return
    expect(shellTool.description).not.toMatch(/Shell is restricted/)
  })
})

describe('P0-3: annotateToolsForMode 单元测试（直接对 SSoT 函数）', () => {
  // ToolProvider 不一定装载 run_terminal_command（由 ShellCap 注入），所以这里
  // 直接对 annotateToolsForMode 单元测试，避免依赖装配链。
  //
  // 通过包入口 `@tabtin/agent-runtime` re-export 路径访问（ 批次 13 engine
  // barrel 收敛后 agent-modes 出口在包入口），与 ElectronToolProvider 实际 import
  // 路径一致（避免直接走 `@tabtin/agent-modes` 在 vitest alias 链未配置时
  // 报"Failed to resolve import"）。
  it('plan/ask/study 模式对 run_terminal_command 注入 shell 受限提示', async () => {
    const { annotateToolsForMode } = await import('@tabtin/agent-modes')
    const fakeShell = {
      name: 'run_terminal_command',
      description: 'Run a shell command.',
      isReadOnly: false,
    }

    for (const [mode, label] of [['plan', 'Plan'], ['ask', 'Ask'], ['study', 'Study']] as const) {
      const annotated = annotateToolsForMode([fakeShell], mode)
      expect(annotated[0]?.description, `${mode} mode injects shell restriction hint`)
        .toMatch(new RegExp(`\\[${label} mode\\] Shell is restricted`))
      expect(annotated[0]?.description).toMatch(/tabtin readonly subcommands/)
      expect(annotated[0]?.description).toMatch(/ls→glob_search/)
      expect(annotated[0]?.description).toMatch(/cat→read_file/)
      expect(annotated[0]?.description).toMatch(/Writing commands.*will be rejected/)
    }
  })

  it('agent / yolo / group 模式不注入 shell 提示（保持原始 description）', async () => {
    const { annotateToolsForMode } = await import('@tabtin/agent-modes')
    const fakeShell = {
      name: 'run_terminal_command',
      description: 'Run a shell command.',
      isReadOnly: false,
    }
    for (const mode of ['agent', 'yolo', 'group'] as const) {
      const annotated = annotateToolsForMode([fakeShell], mode)
      expect(annotated[0]?.description, `${mode} mode should not annotate shell`).toBe('Run a shell command.')
    }
  })
})

// ─── Helper ─────────────────────────────────────────────────────────

function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker)
  if (startIdx === -1) return ''
  const endIdx = source.indexOf(endMarker, startIdx)
  if (endIdx === -1) return source.slice(startIdx)
  return source.slice(startIdx, endIdx + endMarker.length)
}

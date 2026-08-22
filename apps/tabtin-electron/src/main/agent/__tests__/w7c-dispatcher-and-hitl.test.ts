/**
 * W7c P0-1 / P0-2 / P0-3 单元覆盖
 *
 * 范围（PRD 第七章 7.4 / 7.5 / 7.11）：
 *   - P0-1：HITL WS 通道使用 LocalRuntimeEvents.* 命名（不与 ACP `agent.permission.response`
 *           冲突），ElectronAgentHost HITL 经 AgentHost.commands.userResponse；
 *   - P0-3：Agent 入站收口 AgentHost + electronAgentTransport；
 *           decodeForwardRequest 的字段映射；
 *
 * 覆盖思路：
 *   - 用 vi.mock 隔离 Electron / WS gateway，以纯函数/契约验证关键不变量
 *   - 不实际启动 host 或建 WS 连接，避免单测里跑 IPC/网络栈
 *
 * P0-2（observer mirror）的 React hook 单测放在 renderer/hooks 测试套件，
 * 这里只覆盖主进程侧逻辑。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Electron / WS / preload 桩 ────────────────────────────────────────
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
vi.mock('../../../ws/ElectronWsGateway', () => ({
  electronWsGateway: {
    getDeviceId: () => 'device-test-fp',
    on: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockResolvedValue({ ok: true }),
    unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    request: vi.fn().mockResolvedValue({ ok: true, payload: {} }),
    getStatus: () => 'idle',
  },
}))

// ─── P0-3：分流器 + envelope 解析（行为契约） ─────────────────────────

describe('W7c P0-3: ElectronAgentService dual-path dispatcher', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  /**
   * Agent 入站命令已收口到 `@tabtin/agent-host`：ElectronAgentService 只管
   * gateway 连接生命周期；Host 经 electronAgentTransport + AgentHost.start 接线。
   */
  it('source contract: ElectronAgentService no longer owns Agent command routing', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const serviceSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'ElectronAgentService.ts'),
      'utf-8',
    )
    const hostSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'ElectronAgentHost.ts'),
      'utf-8',
    )
    const transportSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'platform', 'electron-agent-transport.ts'),
      'utf-8',
    )
    // Service 不再逐事件 on(prompt.*)
    expect(serviceSrc).not.toMatch(/electronWsGateway\.on\('agent\.prompt\.forward'/)
    expect(serviceSrc).not.toMatch(/electronWsGateway\.on\('agent\.prompt\.cancel'/)
    expect(serviceSrc).not.toMatch(/electronWsGateway\.on\('agent\.subagent\.cancel'/)
    expect(serviceSrc).not.toMatch(/EXTERNAL_BACKEND_TYPES/)
    expect(serviceSrc).not.toMatch(/AgentBridge/)
    // Host 经共享 AgentHost + transport 接线
    expect(hostSrc).toMatch(/AgentHost\.start/)
    expect(hostSrc).toMatch(/electronAgentTransport/)
    expect(transportSrc).toMatch(/onAnyEvent/)
    expect(hostSrc).toMatch(/handleAbortFromEnvelope/)
    expect(hostSrc).toMatch(/handleSubagentCancelFromEnvelope/)
  })

  it('source contract: ElectronAgentHost exposes handleQueryFromForward + parses envelope', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const hostSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'ElectronAgentHost.ts'),
      'utf-8',
    )
    const conversationSource = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'packages', 'agent-host', 'src', 'conversation', 'forward-request-decoder.ts'),
      'utf-8',
    )
    expect(hostSource).toMatch(/async handleQueryFromForward/)
    // Stage 1b：Electron 侧 forward 入口从 `decodeForwardRequest` 升级到
    // `decodeForwardRequestDetailed`（能区分 schema 失败 / missing-content
    // 并把错误上报到日志），旧 `decodeForwardRequest(envelope, log)` 断言随之
    // 放宽为「共享 decoder 入口存在」。
    expect(hostSource).toMatch(/decodeForwardRequestDetailed\(envelope,\s*log\)/)
    // 字段映射覆盖（部分关键字段；W6 M3 加 workspace_snapshot）
    for (const f of ['task_id', 'agent_id', 'agent_mode', 'custom_rules', 'model_id', 'workspace_snapshot']) {
      expect(conversationSource).toContain(f)
    }
    // 没有 sender 时走 NOOP_STREAM_SINK（确保 IPC sender 无关分支不破坏 stream 循环）
    expect(hostSource).toMatch(/NOOP_STREAM_SINK/)
    // handleQueryInternal 接受 StreamEventSink 抽象（IPC sender 与 noop sink 共用）
    expect(hostSource).toMatch(/handleQueryInternal/)
    expect(hostSource).toMatch(/StreamEventSink/)
    // 跨设备 cancel：handleAbortFromEnvelope（WS 入口）与 handleAbort（IPC 入口）共享逻辑
    expect(hostSource).toMatch(/handleAbortFromEnvelope/)
    // ：abortSessionByKey = abort（active）+ abortConversationRuns（强制清队）。
    expect(hostSource).toMatch(/requireSharedHost\(\)\.abort\(identity\)/)
    expect(hostSource).toMatch(/requireSharedHost\(\)\.abortConversationRuns\(identity\)/)
    // Stop / 插队必须清 mode-switch F7 pending，否则后续 switch_mode 被 already_pending 误挡。
    expect(hostSource).toMatch(/_modeSwitchHandler\?\.clearSession/)
    expect(hostSource).toMatch(/#6582：host 停路径组合/)
    //  review：跨设备 cancel 缺少 task_id/thread_id 时必须 fail-closed，
    // 不能回退到 handleAbort(undefined) 全停本机所有会话。
    expect(hostSource).toContain("agent.prompt.cancel without any id — ignored")
    expect(hostSource).not.toContain("agent.prompt.cancel without any id — aborting all sessions")
    // W5-a：跨-Electron 子 Agent cancel 对称入口（解 child_id → 模块级 cancelSubagent）
    expect(hostSource).toMatch(/handleSubagentCancelFromEnvelope/)
    // L-W6-02 (W6 M3)：decodeForwardRequest 解码 workspace_snapshot
    // 字段；空数组防御实施在 handleQueryInternal mutate 段（"empty 数组视作 omit"）。
    expect(conversationSource).toMatch(/decodeForwardWorkspaceSnapshot/)
  })

  it('uses forwarded Workspace iteration limit when maxTurns is absent', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const hostSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'ElectronAgentHost.ts'),
      'utf-8',
    )
    const queryParamsStart = hostSource.indexOf('buildQueryParams: (base, query) => {')
    expect(queryParamsStart).toBeGreaterThan(-1)
    const queryParamsBlock = hostSource.slice(queryParamsStart, queryParamsStart + 1800)

    // 移动端 / prompt.forward 不带 IPC 专用 maxTurns；Electron 必须回落
    // 到 Django 已解析下发的 execution_limits，不能再静默使用默认 200。
    expect(queryParamsBlock).toContain(
      'request.maxTurns\n          ?? request.executionLimits?.max_iterations_per_run',
    )
    expect(queryParamsBlock).toContain(
      '?? request.executionLimits?.max_iterations_per_run\n          ?? undefined',
    )
    expect(queryParamsBlock).toContain('maxTurns: effectiveMaxTurns')
  })

  it('source contract: local submitHitlBatch resolves shared approvals before backend forwarding', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.resolve(
      __dirname,
      '..',
      'ElectronAgentHost.ts',
    )
    const src = fs.readFileSync(file, 'utf-8')
    const fnStart = src.indexOf('private handleSubmitHitlBatchLocal')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = src.slice(fnStart, fnStart + 2500)

    // 人工交互 pending map 统一由 AgentHostCoordinator.interactions 拥有；
    // 平台审批不再维护第二套 resolver。
    expect(fnBody).toMatch(/this\.core\.interactions\.resolve\(payload\.batchId/)
    expect(fnBody).not.toMatch(/resolveSharedApprovalResponse/)

    const submitStart = src.indexOf('private async handleSubmitHitlBatch')
    expect(submitStart).toBeGreaterThan(-1)
    const submitBody = src.slice(submitStart, submitStart + 1500)
    expect(submitBody.indexOf('this.handleSubmitHitlBatchLocal({')).toBeGreaterThan(-1)
    expect(submitBody.indexOf('this.forwardUserResponseToBackend')).toBeGreaterThan(
      submitBody.indexOf('this.handleSubmitHitlBatchLocal({'),
    )
  })

  // ── PR4-yolo (PRD v3 §5.6 / DR-15)：fix/yolo-daemon-wire-and-contextvar ──
  // Task 2：decodeForwardRequest 白名单加 'yolo'。
  // Task 4：parser 解 payload.is_group_space → request.isGroupSpace（H5 fail-open 修复链路）。
  it('decodeForwardRequest accepts agent_mode=yolo + is_group_space', async () => {
    const { decodeForwardRequest } = await import('@tabtin/agent-host/conversation')
    const request = decodeForwardRequest(
      {
        thread_id: 'chat-session-session-1',
        payload: {
          prompt: 'continue',
          task_id: 'prompt-1',
          workspace_id: 'workspace-1',
          // Stage 1b：共享 decoder 走 `PromptForwardPayloadSchema.safeParse`，
          // agent_config 是强制字段（AgentBackendConfigSchema.type: string）。
          agent_config: { type: 'local' },
          agent_mode: 'yolo',
          is_group_space: true,
        },
      } as never,
      { warn: vi.fn(), debug: vi.fn() },
    )

    expect(request?.agentMode).toBe('yolo')
    expect(request?.isGroupSpace).toBe(true)
  })
})

// ─── L-W6-02 (W6 M3)：decodeForwardWorkspaceSnapshot 行为单测 ─────────
//
// review 第二轮发现 Electron 端 decode 与 Daemon 端原本不一致（allowedFiles
// 缺失时 Electron 整条丢 snapshot，Daemon 用 [] 兜底）—— 加这组单测把"两宿主
// 行为对齐"固定成回归保护。同时验证："形态完整 + 空数组"通过 decode（mutate
// 层负责"空数组视作 omit"防御，本层不做）。

describe('L-W6-02: decodeForwardWorkspaceSnapshot', () => {
  // 直接 import 纯函数文件（不经 ElectronAgentHost.ts），避免传递地拉
  // NotificationService / electron-log transports / cli-server 等 main-process
  // side effect — ElectronAgentHost.ts 顶层 import 链触发的 mock 噪声会让
  // 这种"纯函数行为单测"无法干净跑。

  it('returns undefined for non-object / array / null', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    for (const bad of [null, undefined, 'foo', 42, true, [], [1, 2]]) {
      expect(decodeForwardWorkspaceSnapshot(bad)).toBeUndefined()
    }
  })

  it('returns undefined when sources / allowedPaths / spaceSessionId missing', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    expect(decodeForwardWorkspaceSnapshot({
      allowedPaths: [], allowedFiles: [], spaceSessionId: 'x',
    })).toBeUndefined()
    expect(decodeForwardWorkspaceSnapshot({
      sources: { sandbox: '/s', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
      allowedFiles: [], spaceSessionId: 'x',
    })).toBeUndefined()
    expect(decodeForwardWorkspaceSnapshot({
      sources: { sandbox: '/s', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
      allowedPaths: [], allowedFiles: [],
    })).toBeUndefined()
  })

  it('uses [] fallback when allowedFiles missing (Daemon-parity, Review #2 P1)', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: { sandbox: '/s', tabcodeProjects: ['/p'], tabfolderDirs: [], attachedFiles: [] },
      allowedPaths: ['/s', '/p'],
      // allowedFiles intentionally omitted — Daemon decodeWorkspaceSnapshot 用 []
      // 兜底；Electron 端要求一致行为，否则同一 wire payload 在两宿主上 forward
      // 路径行为分裂。
      spaceSessionId: 'space::sess',
    })
    expect(out).toBeDefined()
    expect(out?.allowedFiles).toEqual([])
    // 单根契约：sources 现在只有 sandbox + workingDir + attachedFiles。
    // 老主控端 wire 里如还带 tabcodeProjects 数组，decode 端不再消费。
    expect(out?.sources.workingDir).toBe('')
    expect(out?.allowedPaths).toEqual(['/s', '/p'])
  })

  it('coerces sources sub-fields to safe defaults', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {}, // sandbox/projects/dirs/files all missing
      allowedPaths: [],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out).toBeDefined()
    expect(out?.sources.sandbox).toBe('')
    expect(out?.sources.workingDir).toBe('')
    expect(out?.sources.attachedFiles).toEqual([])
  })

  it('filters non-string entries from arrays', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/s',
        tabcodeProjects: ['/a', 42, null, '/b'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/a', { not: 'string' }, '/b'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    // 单根契约：sources 不再有 tabcodeProjects 字段；wire 里残留的数组被 decode 忽略
    expect(out?.sources.workingDir).toBe('')
    expect(out?.allowedPaths).toEqual(['/a', '/b'])
  })

  it('shape-complete empty snapshot still decodes (mutate layer handles "empty as omit")', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: { sandbox: '', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
      allowedPaths: [],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out).toBeDefined()
    expect(out?.allowedPaths).toEqual([])
    // mutate 层 (handleQueryInternal) 看到这种全空 snapshot 时应该一字段都不
    // 改写 session.workspaceSnapshot —— 见 "L-W6-02 (W6 M3)：每次 handleQuery
    // 入口同步 workspaceSnapshot" 段的 length > 0 条件。本单测断言：decode
    // 不在源头丢 shape-complete 数据（保持 forward 协议中性），保护责任在 mutate。
  })

  // ─── M3.1 硬化补丁：过宽 allowedPath 防护（与 Daemon 严格对齐） ─────────
  //
  // 北极星：远程 Daemon 拿到的 `workspace_snapshot.allowedPaths` 里绝对不能
  // 有 `/` 或等价的"整盘"路径让整个家目录都变成 workspace。Electron forward
  // 路径是同一条 wire 协议，必须做同款过滤；任何宿主行为分歧都是潜在 bug。

  it('M3.1: 过滤过宽 path（`/`）但保留合法项目', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/me/.tabtin/sandbox',
        tabcodeProjects: ['/Users/me/dev/midscene'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/', '/Users/me/.tabtin/sandbox', '/Users/me/dev/midscene'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out).toBeDefined()
    expect(out?.allowedPaths).toEqual([
      '/Users/me/.tabtin/sandbox',
      '/Users/me/dev/midscene',
    ])
  })

  it('M3.1: 全是过宽 path → 返回 undefined（fail-closed 退化 sandbox）', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
      allowedPaths: ['/', '/Users', '/home', '/tmp'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out).toBeUndefined()
  })

  it('M3.1: 过滤 `/Users` `/home` `/tmp` 等顶级目录', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/me/.tabtin/sandbox',
        tabcodeProjects: ['/Users/me/dev/proj'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/Users', '/home', '/tmp', '/Users/me/dev/proj'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out?.allowedPaths).toEqual(['/Users/me/dev/proj'])
  })

  it('M3.1.1 方向 C: 家目录本身 `/Users/me` 保留为合法 workspace（撤 isUserHomeRoot 后）', async () => {
    // M3.1.1 起：单用户家目录 /Users/<name> 视为合法 workspace
    // （用户拍板方向 C：放宽家目录但用 sensitive_path_list 把凭据子目录敲门补回）
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/me/.tabtin/sandbox',
        tabcodeProjects: ['/Users/me'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/Users/me', '/Users/me/dev/proj'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out?.allowedPaths).toEqual(['/Users/me', '/Users/me/dev/proj'])
  })

  it('M3.1: sandbox = `/Users` 清空字段（让 host 兜底）', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users',
        tabcodeProjects: ['/Users/me/dev/proj'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/Users/me/dev/proj'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out?.sources.sandbox).toBe('')
  })

  it('M3.1: tabcodeProjects 含过宽 path → 过滤；保留合法项作为 workingDir', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/me/.tabtin/sandbox',
        tabcodeProjects: ['/', '/Users', '/Users/me/dev/proj'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['/Users/me/dev/proj'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    // 单根契约：sources 不再有 tabcodeProjects 字段；wire 里残留的过滤后数组被 decode 忽略
    expect(out?.sources.workingDir).toBe('')
  })

  it('M3.1: 相对路径 / `~` / 空串 / Windows 盘符根全部过滤', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/me/.tabtin/sandbox',
        tabcodeProjects: ['/Users/me/dev/proj'],
        tabfolderDirs: [],
        attachedFiles: [],
      },
      allowedPaths: ['', '~', '~/dev', '../..', 'dev/foo', 'C:/', 'C:\\', '/C:/', '/Users/me/dev/proj'],
      allowedFiles: [],
      spaceSessionId: 'space::sess',
    })
    expect(out?.allowedPaths).toEqual(['/Users/me/dev/proj'])
  })

  it('M3.1: allowedFiles 含过宽 path → 过滤', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: { sandbox: '/Users/me/.tabtin/sandbox', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: ['/Users/me/Downloads/brief.md'] },
      allowedPaths: ['/Users/me/.tabtin/sandbox'],
      allowedFiles: ['/', '/Users', '/Users/me/Downloads/brief.md'],
      spaceSessionId: 'space::sess',
    })
    expect(out?.allowedFiles).toEqual(['/Users/me/Downloads/brief.md'])
  })

  it('M3.1: 合法 payload 不被误挡（正例不破坏既有路径）', async () => {
    const { decodeForwardWorkspaceSnapshot } = await import('@tabtin/agent-host/conversation')
    const out = decodeForwardWorkspaceSnapshot({
      sources: {
        sandbox: '/Users/developer/.tabtin/sandbox',
        tabcodeProjects: ['/Users/developer/dev/midscene'],
        tabfolderDirs: ['/Users/developer/Documents/work'],
        attachedFiles: ['/Users/developer/Downloads/brief.md'],
      },
      allowedPaths: [
        '/Users/developer/.tabtin/sandbox',
        '/Users/developer/dev/midscene',
        '/Users/developer/Documents/work',
      ],
      allowedFiles: ['/Users/developer/Downloads/brief.md'],
      spaceSessionId: 'space::sess',
    })
    expect(out).toBeDefined()
    expect(out?.allowedPaths).toEqual([
      '/Users/developer/.tabtin/sandbox',
      '/Users/developer/dev/midscene',
      '/Users/developer/Documents/work',
    ])
  })
})

// ─── P0-1：HITL 双通道合流（envelope handler 契约） ─────────────────────

describe('W7c P0-1: ElectronAgentHost HITL via AgentHost', () => {
  it('source contract: HITL user_response lands in sharedHost commands', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'ElectronAgentHost.ts'),
      'utf-8',
    )
    // 不再私有 installWsHitlHandlers / 设备 topic 手订；AgentRealtime 订阅 device topic
    expect(src).not.toMatch(/installWsHitlHandlers/)
    expect(src).toMatch(/handleSharedHostUserResponse/)
    expect(src).toMatch(/LocalRuntimeEvents\.USER_RESPONSE_DELIVERY/)
    expect(src).toMatch(/handleSubmitHitlBatchLocal/)
    expect(src).toMatch(/handleSubmitAskUserResponseLocal/)
    // plan 审批已重构成「PlanProposalCard 直接执行」，不再有 plan_approval WS handler
    expect(src).not.toMatch(/PLAN_APPROVAL_RESPONSE/)
    expect(src).not.toMatch(/handleSubmitPlanApproval/)
    expect(src).not.toMatch(/wsHitlUnsubscribers/)
  })
})

// ─── P0-2：观察端 hook 源码契约（renderer 测试套件无法 import 主进程包，
// 这里仅断言 hook 文件存在并接到关键 API） ─────────────────────────────

describe('W7c P0-2: renderer observer mirror hook contract', () => {
  it('source contract: observer 来源命令式接入并订阅 gateway topic', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'renderer',
      'src',
      'services',
      'agentService',
      'streamSources.ts',
    )
    const src = fs.readFileSync(file, 'utf-8')
    //  单源终态：来源区分与 WS 订阅收口主进程；渲染进程只 watchSession 声明观察意图 +
    // 挂常驻单源，不再自持 subscribeGatewayTopic / attachStream('ws')。
    expect(src).not.toMatch(/subscribeGatewayTopic/)
    expect(src).not.toMatch(/attachStream\('ws'/)
    expect(src).toMatch(/watchSession/)
    // ：streamSources 退化为薄壳——envelope 一律转交枢纽唯一分发点 handle.dispatch，
    // round/observer 的区分收口到 SessionStreamHub.dispatch 内部，本文件不再自带分支。
    expect(src).toMatch(/dispatch/)
    expect(src).not.toMatch(/shouldSkipObserverEventForLocalIpcSession/)
  })

  it('source contract:  出入站收口在同一 agentService（不再散落 store / 不另起枢纽）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const hubFile = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'renderer',
      'src',
      'services',
      'agentService',
      'index.ts',
    )
    const hubSrc = fs.readFileSync(hubFile, 'utf-8')
    // 出站（abort → 主进程 abortRun 一次 IPC）+ 入站（单源常驻 + 轮 tap）收口同一枢纽。
    // ：chat.cancel 兜底已下沉主进程 handleAbortRun；owner 仲裁删除（单源无需）。
    expect(hubSrc).toMatch(/abortRun/)
    expect(hubSrc).toMatch(/attachStream/)
    expect(hubSrc).toMatch(/waitForExecution/)
    expect(hubSrc).not.toMatch(/beginRound/)
    expect(hubSrc).not.toMatch(/hasOriginatedHere/)
    expect(hubSrc).not.toMatch(/isSourceOwner/)

    // 收口后 store 不再各自维护 originatedHere 旗子。
    const storeFile = path.resolve(
      __dirname, '..', '..', '..', 'renderer', 'src', 'stores', 'useChatRuntimeStore.ts',
    )
    const storeSrc = fs.readFileSync(storeFile, 'utf-8')
    expect(storeSrc).not.toMatch(/originatedHereBySessionId/)
  })

  it('source contract:  Layer B sendMessageAction 经 hub attach ipc-main 源', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'renderer',
      'src',
      'stores',
      'chat',
      'messages',
      'actions',
      'sendMessageAction.ts',
    )
    const src = fs.readFileSync(file, 'utf-8')
    // 不再手动 markSessionOriginatedHere；ipc-main 源已内化到 hub send()（自动置 originated，）。
    expect(src).toMatch(/getSessionController\(sessionId\)\.send\(/)
    expect(src).not.toMatch(/markSessionOriginatedHere/)
  })
})

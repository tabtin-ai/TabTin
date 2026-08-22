/**
 * ：ElectronAgentHost.relayBackgroundTaskTerminalResult **本机 live 投递**契约测试。
 *
 * **背景**：后台命令终结时，host 把 `background-task-completed` 通知翻译成终态
 * tool_result mini-message（4 件套）。Django relay 广播按  以发送方 channel 做
 * exclude_channel（其前提是"发送方 UI 已由 localStream 渲染"），而本路径是 query 外
 * 合成的终态 mini-message，本机并未渲染过——`sharedHost.publish` 这条本机投递是
 * **发起端本机能 live 刷新的唯一通道**。
 *
 * **关键不变量**：publish 第一个参数必须是 `env.target.threadId` 的**裸 session
 * UUID**——publish 按 targetsBySession 查 watcher，watcher 由 renderer
 * `watchSession(rawUuid)` 注册；重构 id 形态（如包一层前缀）会让本机投递静默失效，
 * 发起端终端卡片继续转圈。
 *
 * 测试策略（与 electron-agent-host-cloud-summary.test.ts 同款）：
 *   - vi.mock 全部 main 进程依赖（electron / electron-log / auth / config / cli-server …）
 *   - `Object.create(ElectronAgentHost.prototype)` 跳过完整 constructor，
 *     `Object.assign` 注入 `sharedHost.publish` / `relayPersistence.send` mock
 *     （relayPersistence 是 readonly 字段初始化器，prototype  hack 下本就不存在，
 *     必须显式注入以断网）
 *   - 直接调用私有方法 `relayBackgroundTaskTerminalResult`（TS private 仅编译期约束）
 *   - `output_file_path` 用 node:os tmpdir 临时文件写 fake stdout——
 *     buildBackgroundTaskTerminalResult 会真实 readFileTailSafe 读 tail 进 content
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// ─── 必须在 import ElectronAgentHost 之前 mock 所有 main 进程依赖 ─────
// （与 electron-agent-host-cloud-summary.test.ts 同一套 mock 集合）

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
    on: () => undefined,
    once: () => undefined,
    whenReady: () => Promise.resolve(),
  },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: class FakeBrowserWindow {
    static getAllWindows() { return [] }
    static fromWebContents() { return null }
    webContents = { send: () => undefined }
  },
  webContents: {
    fromId: () => null,
    getAllWebContents: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  powerMonitor: {
    on: () => undefined,
    off: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  },
  net: {
    isOnline: () => true,
  },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: () => undefined },
    },
  },
  shell: {
    openExternal: () => Promise.resolve(),
  },
}))

vi.mock('electron-log', () => {
  const noop = () => {}
  const logObj = {
    info: noop, warn: noop, error: noop, debug: noop,
    log: noop, verbose: noop, silly: noop,
  }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logObj,
      scope: () => logObj,
      ...logObj,
    },
  }
})

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'https://api.test.local',
  WS_BASE_URL: 'wss://api.test.local',
  DAEMON_CONTROL_ENABLED: false,
}))

vi.mock('../../cli/cli-server', () => ({
  getCLIOrganizationRoot: () => null,
  getCLISpaceId: () => undefined,
  getCLIOrganizationId: () => undefined,
  syncCLISpaceContextFromQueryRequest: () => undefined,
  setCLIWorkspaceScopeKey: () => undefined,
  setCLIOrganizationRootIfMissing: () => undefined,
  CLIWorkspaceScopeTurnLeaseManager: class {
    start(): void {}
    settle(): void {}
  },
}))

vi.mock('@tabtin/cli-server-core/surfaces/agent-security', () => ({
  createAgentSecuritySurfaces: () => [],
}))
vi.mock('@tabtin/cli-server-core/surfaces/skill-list', () => ({
  createSkillListSurface: () => ({}),
}))
vi.mock('@tabtin/cli-server-core/surfaces/skill-materialize-app', () => ({
  createSkillMaterializeAppSurface: () => ({}),
}))

vi.mock('@tabtin/app-shell/agent-config-v2', () => ({
  normalizeExecutionLimitsForCostCap: (v: unknown) => v,
}))

const { ElectronAgentHost } = await import('../ElectronAgentHost')
const { SHELL_NOTIFICATION_KIND } = await import('@tabtin/terminal-core')

// ─── 测试 harness ────────────────────────────────────────────────────

type PublishMock = ReturnType<typeof vi.fn>
type SendMock = ReturnType<typeof vi.fn>

interface RelayHarness {
  relayBackgroundTaskTerminalResult: (env: import('@tabtin/terminal-core').NotificationEnvelope) => void
}

function createHarness(): { harness: RelayHarness; publish: PublishMock; send: SendMock } {
  const publish = vi.fn()
  const send = vi.fn().mockResolvedValue(undefined)
  const harness = Object.assign(
    Object.create(ElectronAgentHost.prototype),
    {
      sharedHost: { publish },
      relayPersistence: { send, activateOwner: vi.fn() },
    },
  ) as RelayHarness
  return { harness, publish, send }
}

/** 裸 session UUID——publish 按它查 renderer watchSession(rawUuid) 注册的 watcher。 */
const RAW_THREAD_ID = '3f8a2c7e-9b1d-4e5f-a6c7-8d9e0f1a2b3c'
const FAKE_STDOUT_MARKER = 'fake stdout marker bg-terminal-relay'
const FILE_ID = '550e8400-e29b-41d4-a716-446655440000'

let tmpDir: string
let outputFilePath: string

beforeAll(() => {
  // buildBackgroundTaskTerminalResult 会真实 readFileTailSafe(output_file_path)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-bg-terminal-relay-'))
  outputFilePath = path.join(tmpDir, 'output.log')
  fs.writeFileSync(outputFilePath, `line1\n${FAKE_STDOUT_MARKER}\nline3\n`, 'utf-8')
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeEnvelope(
  over: Partial<import('@tabtin/terminal-core').NotificationEnvelope> = {},
): import('@tabtin/terminal-core').NotificationEnvelope {
  return {
    kind: SHELL_NOTIFICATION_KIND,
    target: { spaceId: 'space-1', threadId: RAW_THREAD_ID },
    priority: 'later',
    payload: {
      agent_session_id: 'agent-session-1',
      tool_use_id: 'run_terminal_command:0',
      command: 'sleep 1 && echo done',
      exit_code: 0,
      exited_by: 'normal_exit',
      duration_ms: 1050,
      output_file_path: outputFilePath,
      cwd: '/repo',
    },
    enqueuedAt: Date.now(),
    dedupKey: 'agent-session-1',
    ...over,
  }
}

describe('ElectronAgentHost.relayBackgroundTaskTerminalResult —  本机 live 投递', () => {
  it('background-task-completed → 本机 publish 4 件套，第一参数为裸 threadId', () => {
    const { harness, publish, send } = createHarness()

    harness.relayBackgroundTaskTerminalResult(makeEnvelope())

    // 终态 mini-message 4 件套全部经 AgentRealtime broadcast 投给本机 watcher
    expect(publish).toHaveBeenCalledTimes(4)

    // 关键不变量：第一参数必须是裸 session UUID（env.target.threadId 原样）。
    // watcher 由 renderer watchSession(rawUuid) 注册、publish 按 targetsBySession
    // 查表——id 形态被重构（加前缀等）会让本机投递静默失效。
    for (const call of publish.mock.calls) {
      expect(call[0]).toBe(RAW_THREAD_ID)
    }

    const types = publish.mock.calls.map((call) => (call[1] as { event: { type: string } }).event.type)
    expect(types).toEqual([
      'agent.stream.message_start',
      'agent.stream.content_block_start',
      'agent.stream.content_block_stop',
      'agent.stream.message_stop',
    ])

    // content_block_start 的 tool_result content 带 _terminal_update 标记
    // （Django reassembler 据此替换 running 快照），且 stdout tail 真实读自临时文件。
    const blockStart = (publish.mock.calls[1]![1] as { event: { payload: unknown } }).event
    const block = (blockStart.payload as { block: { type: string; content: string } }).block
    expect(block.type).toBe('tool_result')
    expect(block.content).toContain('_terminal_update')
    expect(block.content).toContain(FAKE_STDOUT_MARKER)

    // Django relay 通道同时走（fire-and-forget，send 已 mock 断网），threadId 一致。
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toBe(RAW_THREAD_ID)
  })

  it('drain 路由是 childId 时，本机 publish / relay 仍走业务 thread', () => {
    const { harness, publish, send } = createHarness()
    const childRouteId = '32a8d48c-2cc4-438a-acd3-75e80acf02be'
    harness.relayBackgroundTaskTerminalResult(makeEnvelope({
      target: { spaceId: 'space-1', threadId: childRouteId },
      payload: {
        agent_session_id: 'agent-session-1',
        tool_use_id: 'run_terminal_command:0',
        command: 'sleep 1 && echo done',
        exit_code: 0,
        exited_by: 'normal_exit',
        duration_ms: 1050,
        output_file_path: outputFilePath,
        cwd: '/repo',
        business_thread_id: RAW_THREAD_ID,
      },
    }))

    expect(publish).toHaveBeenCalled()
    for (const call of publish.mock.calls) {
      expect(call[0]).toBe(RAW_THREAD_ID)
      expect(call[0]).not.toBe(childRouteId)
    }
    expect(send.mock.calls[0]![1]).toBe(RAW_THREAD_ID)
  })

  it('sharedHost 缺失（host 未 start）→ 不炸，Django relay 仍走', () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const harness = Object.assign(
      Object.create(ElectronAgentHost.prototype),
      { sharedHost: null, relayPersistence: { send, activateOwner: vi.fn() } },
    ) as RelayHarness

    expect(() => harness.relayBackgroundTaskTerminalResult(makeEnvelope())).not.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('后台生图成功 → 终态后追加带 file_id 的正式图片产物', () => {
    const cliOutput = JSON.stringify({
      ok: true,
      data: {
        success: true,
        status: 'succeeded',
        storage_status: 'succeeded',
        stored_files: [{
          index: 0,
          file_id: FILE_ID,
          file_name: 'mountain.png',
          mime_type: 'image/png',
          file_size: 2048,
          access_url: 'https://oss.example/mountain.png',
        }],
      },
    })
    fs.writeFileSync(outputFilePath, cliOutput, 'utf-8')
    const { harness, publish, send } = createHarness()
    const envelope = makeEnvelope()
    ;(envelope.payload as { command: string }).command =
      'tabtin media image generate --prompt "月照金山" --format json'

    harness.relayBackgroundTaskTerminalResult(envelope)

    // 终端终态 4 件套 + 正式图片产物 5 件套。
    expect(publish).toHaveBeenCalledTimes(9)
    const artifactStart = (publish.mock.calls[4]![1] as {
      event: { payload: { message_kind?: string } }
    }).event
    expect(artifactStart.payload.message_kind).toBe('tool_artifact')
    const artifactBlock = (publish.mock.calls[5]![1] as {
      event: { payload: { block: Record<string, unknown> } }
    }).event.payload.block
    expect(artifactBlock).toMatchObject({
      type: 'tabtin_rich_content',
      kind: 'image',
      payload: {
        file_id: FILE_ID,
        source_tool_use_id: 'run_terminal_command:0',
      },
    })
    expect(send.mock.calls[0]![2]).toHaveLength(9)

    // 不让本用例的 CLI JSON 污染其它默认命令用例。
    fs.writeFileSync(outputFilePath, `line1\n${FAKE_STDOUT_MARKER}\nline3\n`, 'utf-8')
  })

  it('非 background-task-completed kind → 不触发本机 publish / Django relay', () => {
    const { harness, publish, send } = createHarness()

    harness.relayBackgroundTaskTerminalResult(makeEnvelope({ kind: 'subagent-completed' }))

    expect(publish).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

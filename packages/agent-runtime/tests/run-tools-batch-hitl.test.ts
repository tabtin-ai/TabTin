/**
 * W1.5-轮 1 主北极星测试 — orchestration `executeBatchParallel` 三段式 + 批量审批
 *
 * 业务问题（修前 dogfood）：用户说"了解这个项目"，Agent 一轮发出 `list_directory`
 * + `read_file` 两个并发工具调用 → runtime emit 2 条独立 review_required →
 * 前端 store 单值覆盖 → 用户只看到 1 张卡片 → 30s IpcStream 心跳超时 → "发送失败"。
 *
 * 修复方案（PRD §6.10.2）：
 *   - Phase A · Collect：先 sync 跑 OS 黑名单短路；剩余进 askQueue
 *   - Phase B · Decide：对 askQueue 一次 `permissionHandler.requestPermissionsBatch`，
 *     handler 内部一次 emit `agent.stream.approval_requested`（payload.action_requests
 *     含 N 条），一次 await `waitForUserInput(batchId)`
 *   - Phase C · Dispatch：allow 的 Promise.allSettled 并发执行；deny 直接生成
 *     ToolResult；不再有"前端 store 第二条覆盖第一条"的 bug
 *
 * 4 个用例覆盖：
 *   1. 2 个 read 工具均 ask → 1 次 emit + 1 次 wait + 并发执行
 *   2. 3 个工具混合（1 allow + 1 deny + 1 ask）→ 1 次 batch 1 条 → 各自分发
 *   3. 5 个工具全 ask → 1 次 batch 5 条
 *   4. N=1 退化路径（unsafe write 工具的 executeSingleTool 路径走同一接口）
 *
 * 详
 *   - `packages/agent-runtime/docs/prd/05-permissions-and-sandbox.md` §6.10
 */

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runTools, type ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js'
import { LocalPermissionHandler } from '../src/permissions/local-permission-handler.js'
import { ApprovalRequestedPayloadSchema } from '@tabtin/agent-wire'
import { StreamEvents } from '../src/engine/contracts/stream-events.js'
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../src/engine/contracts/tools.js';
import type { ToolRegistry } from '../src/engine/tooling/tool-system.js'

// ─── Helpers ────────────────────────────────────────────────────────

function makeReadOnlyTool(name: string): Tool {
  return {
    name,
    description: `${name} stub`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: vi.fn(async () => ({ content: `${name} ran` }) as ToolResult),
  }
}

function makeWriteTool(name: string): Tool {
  return {
    name,
    description: `${name} stub`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: false,
    execute: vi.fn(async () => ({ content: `${name} ran` }) as ToolResult),
  }
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map(t => [t.name, t]))
  return {
    findTool: (name: string) => map.get(name) ?? null,
    findToolWithSuggestions: (name: string) => ({
      tool: map.get(name) ?? null,
      suggestions: [],
    }),
    getAllTools: () => tools,
  } as unknown as ToolRegistry
}

interface BatchHarness {
  events: StreamEvent[]
  emit: (event: StreamEvent) => void
  /** 模拟 waitForUserInput 的响应。key 为 toolCallId。 */
  responses: Map<string, 'allow' | 'deny'>
  waitForUserInput: ReturnType<typeof vi.fn>
}

function makeBatchHarness(decisionsByToolCallId: Record<string, 'allow' | 'deny'>): BatchHarness {
  const events: StreamEvent[] = []
  const responses = new Map(Object.entries(decisionsByToolCallId))
  // 模拟主进程 batch resolver：waitForUserInput(batchId) 收到 promise resolve
  // 时返回 { batch_id, decisions: [...] }，按 events 里 emit 的 action_requests
  // 顺序回灌每个 toolCallId 的决策。
  const waitForUserInput = vi.fn(async (batchId: string) => {
    // 找到最近 emit 的 APPROVAL_REQUESTED 事件，按其中的 action_requests 顺序回响
    const approvalEvents = events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
    const lastEvent = approvalEvents[approvalEvents.length - 1]
    if (!lastEvent) {
      throw new Error('No APPROVAL_REQUESTED event emitted before waitForUserInput')
    }
    const payload = lastEvent.payload as { batch_id: string; action_requests: Array<{ tool_call_id: string }> }
    if (payload.batch_id !== batchId) {
      throw new Error(`batchId mismatch: got ${batchId}, expected ${payload.batch_id}`)
    }
    return {
      batch_id: batchId,
      decisions: payload.action_requests.map(ar => ({
        tool_call_id: ar.tool_call_id,
        decision: responses.get(ar.tool_call_id) ?? 'deny',
      })),
    }
  })
  return { events, emit: (e) => { events.push(e) }, responses, waitForUserInput }
}

function makeContext(harness: BatchHarness): ToolContext {
  return {
    threadId: 'thread-batch',
    runtimeId: 'sess-batch',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    emitStreamEvent: harness.emit,
    waitForUserInput: harness.waitForUserInput,
  }
}

async function drain(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
  sink: StreamEvent[],
): Promise<ToolExecutionResult[]> {
  let result: ToolExecutionResult[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) {
      result = next.value
      break
    }
    sink.push(next.value)
  }
  return result
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('W1.5 主北极星 · executeBatchParallel 批量审批合并代数', () => {
  it('用例 1：2 个 read 工具均 ask → 1 次 emit APPROVAL_REQUESTED (action_requests.length === 2) + 用户 batch approve + 并发执行', async () => {
    // dogfood 复现：list_directory + read_file 两个并发工具调用
    const listTool = makeReadOnlyTool('list_directory')
    const readTool = makeReadOnlyTool('read_file')
    const registry = makeRegistry([listTool, readTool])

    const harness = makeBatchHarness({
      'tu-1': 'allow',
      'tu-2': 'allow',
    })

    // permissionMode='default' = cautious：所有非 unknown 工具都不自动批准 → 必走审批
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-1', name: 'list_directory', input: { path: '/' } },
      { type: 'tool_use', id: 'tu-2', name: 'read_file', input: { path: 'README.md' } },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: makeContext(harness),
      permissionHandler: handler,
    })

    const results = await drain(gen, harness.events)

    // 主北极星断言 1：1 次 emit APPROVAL_REQUESTED
    const approvalEvents = harness.events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
    expect(approvalEvents).toHaveLength(1)
    // 主北极星断言 2：payload.action_requests.length === 2
    const payload = approvalEvents[0].payload
    const parsed = ApprovalRequestedPayloadSchema.parse(payload)
    expect(parsed.action_requests).toHaveLength(2)
    expect(parsed.action_requests.map(a => a.tool_call_id).sort()).toEqual(['tu-1', 'tu-2'])
    expect(parsed.batch_id).toBeTruthy()
    expect(parsed.approval_type).toBe('tool_permission')
    expect(parsed.runtime_mode).toBe('interactive')
    // 主北极星断言 3：1 次 waitForUserInput
    expect(harness.waitForUserInput).toHaveBeenCalledTimes(1)
    // 主北极星断言 4：旧 REVIEW_REQUIRED 事件已下线（W4.5 第三波 C1 wire 常量
    // 物理删后改字面量）
    expect(harness.events.filter(e => e.type === 'agent.stream.review_required')).toHaveLength(0)
    // 主北极星断言 5：两个工具都执行
    expect(listTool.execute).toHaveBeenCalledTimes(1)
    expect(readTool.execute).toHaveBeenCalledTimes(1)
    // 结果按原始顺序
    expect(results.map(r => r.toolUseId)).toEqual(['tu-1', 'tu-2'])
    expect(results.every(r => !r.result.isError)).toBe(true)
  })

  it('用例 2：3 个工具全进 batch（用户 2 allow + 1 deny）→ 1 次 batch 含 3 条 → 各自分发', async () => {
    //  Phase 2：shouldAutoApprove 短路已删除，handler 不自动批准任何请求
    // ——3 个工具全部进同一 batch 弹审批；用户对 read/beta allow、alpha deny。
    const autoAllowTool = makeReadOnlyTool('read_file')
    const customA = makeReadOnlyTool('custom_alpha')
    const customB = makeReadOnlyTool('custom_beta')
    const registry = makeRegistry([autoAllowTool, customA, customB])

    const harness = makeBatchHarness({
      'tu-read': 'allow',
      'tu-a': 'deny',
      'tu-b': 'allow',
    })

    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'a.md' } },
      { type: 'tool_use', id: 'tu-a', name: 'custom_alpha', input: { x: 1 } },
      { type: 'tool_use', id: 'tu-b', name: 'custom_beta', input: { y: 2 } },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: makeContext(harness),
      permissionHandler: handler,
    })

    const results = await drain(gen, harness.events)

    // 关键断言 1：仅 1 次 emit APPROVAL_REQUESTED（三工具合并进同一 batch）
    const approvalEvents = harness.events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
    expect(approvalEvents).toHaveLength(1)
    // 关键断言 2：payload.action_requests 含 3 条（ Phase 2 后无自动批准）
    const parsed = ApprovalRequestedPayloadSchema.parse(approvalEvents[0].payload)
    expect(parsed.action_requests).toHaveLength(3)
    expect(parsed.action_requests.map(a => a.tool_call_id).sort()).toEqual(['tu-a', 'tu-b', 'tu-read'])
    // 关键断言 3：1 次 waitForUserInput
    expect(harness.waitForUserInput).toHaveBeenCalledTimes(1)
    // 关键断言 4：分发 — read_file 用户 allow + 执行；custom_alpha deny + 不执行；custom_beta allow + 执行
    expect(autoAllowTool.execute).toHaveBeenCalledTimes(1)
    expect(customA.execute).not.toHaveBeenCalled()
    expect(customB.execute).toHaveBeenCalledTimes(1)
    // 结果：3 条按原顺序；custom_alpha 是 isError，其它不是
    expect(results).toHaveLength(3)
    const byId = new Map(results.map(r => [r.toolUseId, r]))
    expect(byId.get('tu-read')!.result.isError).toBeFalsy()
    expect(byId.get('tu-a')!.result.isError).toBe(true)
    expect(String(byId.get('tu-a')!.result.content)).toContain('Permission denied')
    expect(byId.get('tu-b')!.result.isError).toBeFalsy()
  })

  it('用例 3：5 个工具全 ask → 1 次 batch 含 5 条 action_requests', async () => {
    // 5 个并发只读工具 + permissionMode='default'（全部需审批）
    const tools = ['read_file', 'list_directory', 'grep', 'tree', 'search_files'].map(makeReadOnlyTool)
    const registry = makeRegistry(tools)

    const blocks: ToolUseBlock[] = tools.map((t, i) => ({
      type: 'tool_use' as const,
      id: `tu-${i}`,
      name: t.name,
      input: {},
    }))
    const harness = makeBatchHarness(Object.fromEntries(blocks.map(b => [b.id, 'allow' as const])))

    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: makeContext(harness),
      permissionHandler: handler,
    })

    const results = await drain(gen, harness.events)

    // 关键断言：1 次 emit + payload.action_requests 含 5 条
    const approvalEvents = harness.events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
    expect(approvalEvents).toHaveLength(1)
    const parsed = ApprovalRequestedPayloadSchema.parse(approvalEvents[0].payload)
    expect(parsed.action_requests).toHaveLength(5)
    // 1 次 waitForUserInput（不再是 5 次串行）
    expect(harness.waitForUserInput).toHaveBeenCalledTimes(1)
    // 5 个工具全部并发执行
    for (const t of tools) {
      expect(t.execute).toHaveBeenCalledTimes(1)
    }
    expect(results).toHaveLength(5)
    expect(results.every(r => !r.result.isError)).toBe(true)
  })

  it('用例 4：N=1 退化路径 — unsafe write 工具的 executeSingleTool 路径走同一 batch 接口', async () => {
    // executeSingleTool 路径下，单工具也走 N=1 batch（统一接口避免双路径漂移）。
    // 期望：emit 1 条 APPROVAL_REQUESTED + payload.action_requests 含 1 条 + 1 次 waitForUserInput。
    const writeTool = makeWriteTool('write_file')
    const registry = makeRegistry([writeTool])

    const harness = makeBatchHarness({ 'tu-write': 'allow' })

    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-write', name: 'write_file', input: { path: 'b.md', content: 'x' } },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: makeContext(harness),
      permissionHandler: handler,
    })

    const results = await drain(gen, harness.events)

    const approvalEvents = harness.events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
    expect(approvalEvents).toHaveLength(1)
    const parsed = ApprovalRequestedPayloadSchema.parse(approvalEvents[0].payload)
    expect(parsed.action_requests).toHaveLength(1)
    expect(parsed.action_requests[0].tool_call_id).toBe('tu-write')
    expect(harness.waitForUserInput).toHaveBeenCalledTimes(1)
    expect(writeTool.execute).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(results[0].result.isError).toBeFalsy()
  })

  it('反向断言：批内 1 条 deny 不传染其它条（PRD §6.10.5 合并代数 #1）', async () => {
    const a = makeReadOnlyTool('read_a')
    const b = makeReadOnlyTool('read_b')
    const c = makeReadOnlyTool('read_c')
    const registry = makeRegistry([a, b, c])

    const harness = makeBatchHarness({
      'tu-a': 'allow',
      'tu-b': 'deny',  // 唯一 deny
      'tu-c': 'allow',
    })

    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-a', name: 'read_a', input: {} },
      { type: 'tool_use', id: 'tu-b', name: 'read_b', input: {} },
      { type: 'tool_use', id: 'tu-c', name: 'read_c', input: {} },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: makeContext(harness),
      permissionHandler: handler,
    })

    const results = await drain(gen, harness.events)

    // 1 次 batch（不会因为 deny 触发额外 emit）
    expect(harness.events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)).toHaveLength(1)
    // a, c 执行；b 不执行
    expect(a.execute).toHaveBeenCalledTimes(1)
    expect(b.execute).not.toHaveBeenCalled()
    expect(c.execute).toHaveBeenCalledTimes(1)
    // 结果：3 条按原顺序，b 是 isError
    const byId = new Map(results.map(r => [r.toolUseId, r]))
    expect(byId.get('tu-a')!.result.isError).toBeFalsy()
    expect(byId.get('tu-b')!.result.isError).toBe(true)
    expect(byId.get('tu-c')!.result.isError).toBeFalsy()
  })

  it('fail-closed：handler.requestPermissionsBatch 直接抛错 → 整批 deny + 控制台 warn 可观测', async () => {
    // 与 enforce 路径 channel_error 元数据对称的 legacy 路径检查：
    // permissionHandler.requestPermissionsBatch 抛错时 decidePermissionsBatch
    // 不静默吞，而是 console.warn 让排障可追溯（仍 fail-closed 整批 deny）。
    const a = makeReadOnlyTool('read_a')
    const b = makeReadOnlyTool('read_b')
    const registry = makeRegistry([a, b])

    const events: StreamEvent[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handler = {
      requestPermissionsBatch: vi.fn(async () => {
        throw new Error('Mock IPC failure')
      }),
    }

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-a', name: 'read_a', input: {} },
      { type: 'tool_use', id: 'tu-b', name: 'read_b', input: {} },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: {
        threadId: 'thread-batch',
        runtimeId: 'sess-batch',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        emitStreamEvent: (e) => { events.push(e) },
        waitForUserInput: vi.fn(),
      },
      permissionHandler: handler,
    })

    const results = await drain(gen, events)

    // 整批 deny + 工具不执行
    expect(a.execute).not.toHaveBeenCalled()
    expect(b.execute).not.toHaveBeenCalled()
    expect(results.every(r => r.result.isError === true)).toBe(true)
    // 关键：排障可观测（避免空 catch）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Mock IPC failure'),
    )
    warnSpy.mockRestore()
  })

  it('fail-closed：handler 返回 decisions 缺项 → 缺项 fail-closed deny + 已声明项尊重原值', async () => {
    // 边界：handler 应该按 requests 顺序回 N 条 decisions，但实装 bug 可能漏返。
    // decidePermissionsBatch 必须保证缺项 deny（fail-closed）。
    const a = makeReadOnlyTool('read_a')
    const b = makeReadOnlyTool('read_b')
    const registry = makeRegistry([a, b])

    const events: StreamEvent[] = []
    // handler 故意只回 1 条决策（漏返 tu-b）
    const handler = {
      requestPermissionsBatch: vi.fn(async (req: { requests: Array<{ toolCallId?: string }> }) => [
        { toolCallId: req.requests[0].toolCallId ?? '', decision: 'allow' as const },
      ]),
    }

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-a', name: 'read_a', input: {} },
      { type: 'tool_use', id: 'tu-b', name: 'read_b', input: {} },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: {
        threadId: 'thread-batch',
        runtimeId: 'sess-batch',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        emitStreamEvent: (e) => { events.push(e) },
        waitForUserInput: vi.fn(),
      },
      permissionHandler: handler,
    })

    const results = await drain(gen, events)

    // a 执行（handler 明确 allow）；b 不执行（缺项 fail-closed deny）
    expect(a.execute).toHaveBeenCalledTimes(1)
    expect(b.execute).not.toHaveBeenCalled()
    const byId = new Map(results.map(r => [r.toolUseId, r]))
    expect(byId.get('tu-a')!.result.isError).toBeFalsy()
    expect(byId.get('tu-b')!.result.isError).toBe(true)
  })

  it('fail-closed：handler 返回重复 toolCallId → 后写覆盖（实装 bug 保护性测试）', async () => {
    // 边界：上游若错误地用同一 toolCallId 回多条决策，行为应可预测（后写覆盖）。
    // 当前实现：Map.set 后写覆盖 → "最后一条"决议生效。
    // 这个测试钉死该行为，便于将来若需改为"任一 deny → 整体 deny"反传染时
    // 有迹可循。
    const a = makeReadOnlyTool('read_a')
    const registry = makeRegistry([a])

    const events: StreamEvent[] = []
    const handler = {
      requestPermissionsBatch: vi.fn(async (_req: unknown) => [
        // 同一 tool_call_id 回两条：先 allow 后 deny
        { toolCallId: 'tu-a', decision: 'allow' as const },
        { toolCallId: 'tu-a', decision: 'deny' as const },
      ]),
    }

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-a', name: 'read_a', input: {} },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: {
        threadId: 'thread-batch',
        runtimeId: 'sess-batch',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        emitStreamEvent: (e) => { events.push(e) },
        waitForUserInput: vi.fn(),
      },
      permissionHandler: handler,
    })

    const results = await drain(gen, events)
    // 后写覆盖：deny 生效；工具不执行
    expect(a.execute).not.toHaveBeenCalled()
    expect(results[0].result.isError).toBe(true)
  })

  it('fail-closed：waitForUserInput 抛错 → 整批 deny（与 PRD §6.10.5 一致 + LocalPermissionHandler 既有契约）', async () => {
    const a = makeReadOnlyTool('read_a')
    const b = makeReadOnlyTool('read_b')
    const registry = makeRegistry([a, b])

    const events: StreamEvent[] = []
    const waitForUserInput = vi.fn(async () => {
      throw new Error('IPC disconnected')
    })

    const handler = new LocalPermissionHandler({
      emitStreamEvent: (e) => { events.push(e) },
      waitForUserInput,
    })

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-a', name: 'read_a', input: {} },
      { type: 'tool_use', id: 'tu-b', name: 'read_b', input: {} },
    ]

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: {
        threadId: 'thread-batch',
        runtimeId: 'sess-batch',
        toolUseId: 'mock-tool-use',
        abortSignal: new AbortController().signal,
        messages: [],
        emitStreamEvent: (e) => { events.push(e) },
        waitForUserInput,
      },
      permissionHandler: handler,
    })

    const results = await drain(gen, events)

    // 仍然 emit 1 次 APPROVAL_REQUESTED（错误发生在 wait 之后）
    expect(events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)).toHaveLength(1)
    // 整批 deny → 工具不执行
    expect(a.execute).not.toHaveBeenCalled()
    expect(b.execute).not.toHaveBeenCalled()
    expect(results.every(r => r.result.isError === true)).toBe(true)
  })

  // 占位 — 避免 randomUUID 未使用警告（保留供未来扩展）
  void randomUUID
})

// ─── 2026-05-17 dogfood 事故回归：批处理 settle 顺序 yield ───────────
//
// 现场：用户问"检查硬盘占用"，LLM 一轮发 3 个并发 read 工具
// （df -h / / du -sh ~/* / find ~ -size +500M）。df 毫秒级、find 秒级、
// du 跑到 120s 超时。旧版 `Promise.allSettled` 等整批全完成才统一 yield
// `tool_completed` notice → 前端 3 张卡同时卡 2 分钟才一起出结果。
//
// 修复：每个 promise settle 立刻 yield 自己的 end/error notice。
// `allResults` 仍按 chunk-input 顺序返回（Anthropic 协议契约：user
// message 里 tool_result 顺序必须配 assistant message 里 tool_use 顺序）。
describe('2026-05-17 dogfood 回归 · 批处理 settle 顺序 yield', () => {
  // Mock handler：所有工具直接 allow，绕过审批 UI 路径
  function makeAllowAllHandler() {
    return {
      async requestPermissionsBatch(
        request: { batchId: string; requests: Array<{ toolCallId?: string; tool: { name: string } }> },
      ): Promise<Array<{ toolCallId: string; decision: 'allow' }>> {
        return request.requests.map((r) => ({
          toolCallId: r.toolCallId ?? r.tool.name,
          decision: 'allow' as const,
        }))
      },
    } as unknown as Parameters<typeof runTools>[0]['permissionHandler']
  }

  function makeDelayedTool(name: string, delayMs: number, fail = false): Tool {
    return {
      name,
      description: `${name} delays ${delayMs}ms`,
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, delayMs))
        if (fail) return { content: `${name} 失败`, isError: true } as ToolResult
        return { content: `${name} ok` } as ToolResult
      }),
    }
  }

  function makeNoopContext(events: StreamEvent[]): ToolContext {
    return {
      threadId: 'thread-batch',
      runtimeId: 'sess-batch',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      emitStreamEvent: (e) => { events.push(e) },
      waitForUserInput: vi.fn(),
    }
  }

  // 从事件流里抽出 tool 生命周期 notice（按 yield 时序）
  function extractToolLifecycleOrder(events: StreamEvent[]): Array<{ id: string; phase: string }> {
    return events
      .filter((e) => e.type === StreamEvents.SYSTEM_NOTICE)
      .map((e) => e.payload as { notice_type?: string; tool_call_id?: string; phase?: string })
      .filter((p): p is { notice_type: string; tool_call_id: string; phase: string } => {
        return (
          (p.notice_type === 'tool_completed' || p.notice_type === 'tool_failed')
          && typeof p.tool_call_id === 'string'
          && typeof p.phase === 'string'
        )
      })
      .map((p) => ({ id: p.tool_call_id, phase: p.phase }))
  }

  it('快慢混合并发：快的 end notice 在慢的之前 yield（不再被慢的拖死）', async () => {
    // df 模拟（5ms） / find 模拟（30ms） / du 模拟（150ms）
    const fast = makeDelayedTool('read_fast', 5)
    const mid = makeDelayedTool('read_mid', 30)
    const slow = makeDelayedTool('read_slow', 150)
    const registry = makeRegistry([fast, mid, slow])

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-slow', name: 'read_slow', input: {} },
      { type: 'tool_use', id: 'tu-fast', name: 'read_fast', input: {} },
      { type: 'tool_use', id: 'tu-mid', name: 'read_mid', input: {} },
    ]

    const events: StreamEvent[] = []
    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: blocks,
        registry,
        context: makeNoopContext(events),
        permissionHandler: makeAllowAllHandler(),
      }),
      events,
    )

    const completionOrder = extractToolLifecycleOrder(events)
    // 3 个工具都该 emit end notice
    expect(completionOrder).toHaveLength(3)
    // 关键契约：notice 按 settle 时序 yield —— fast → mid → slow，不是 chunk-input 顺序
    expect(completionOrder.map((c) => c.id)).toEqual(['tu-fast', 'tu-mid', 'tu-slow'])
    expect(completionOrder.every((c) => c.phase === 'end')).toBe(true)

    // 不变量保护：allResults 仍按 chunk-input 顺序（Anthropic 协议）
    expect(results.map((r) => r.toolUseId)).toEqual(['tu-slow', 'tu-fast', 'tu-mid'])
    expect(results.every((r) => !r.result.isError)).toBe(true)
  })

  it('快成功 + 慢失败：失败 notice 用 phase=error 单独 yield，allResults 顺序保持', async () => {
    const fast = makeDelayedTool('read_fast', 5)
    const slowFail = makeDelayedTool('read_slow_fail', 100, /* fail */ true)
    const registry = makeRegistry([fast, slowFail])

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-slowfail', name: 'read_slow_fail', input: {} },
      { type: 'tool_use', id: 'tu-fast', name: 'read_fast', input: {} },
    ]

    const events: StreamEvent[] = []
    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: blocks,
        registry,
        context: makeNoopContext(events),
        permissionHandler: makeAllowAllHandler(),
      }),
      events,
    )

    const completionOrder = extractToolLifecycleOrder(events)
    expect(completionOrder).toEqual([
      { id: 'tu-fast', phase: 'end' },
      { id: 'tu-slowfail', phase: 'error' },
    ])

    expect(results.map((r) => r.toolUseId)).toEqual(['tu-slowfail', 'tu-fast'])
    expect(results[0].result.isError).toBe(true)
    expect(results[1].result.isError).toBeFalsy()
  })

  it('铁律回归：并行批内某工具「后处理」抛错 → 仅该工具降级为 error，不打断 loop、不连累同批其他工具', async () => {
    // 缝隙：executeBatchParallel 里 settle 之后的后处理（maybeSanitize /
    // extractToolErrorCode / makeToolLifecycleNotice）原先跑在 promise 的
    // try/catch 之外——某个工具后处理抛意外异常会冒出 runTools 生成器 →
    // query.ts drain（无兜底）→ 顶层 catch 让整个 run 以 error DONE 收尾，
    // 连累同批其他工具结果一起丢。加固后：后处理异常只降级该工具。
    //
    // 触发方式：让 evil 工具返回一个 `content` getter 抛错的结果——
    // maybeSanitize 首个 `applyLlmStripKeys(result)` 读 content 即抛。
    const good = makeReadOnlyTool('read_good')
    const evil: Tool = {
      name: 'read_evil',
      description: 'result whose content getter throws during post-processing',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: vi.fn(async () => ({
        get content(): string { throw new Error('boom in post-processing') },
        isError: false,
      }) as unknown as ToolResult),
    }
    const registry = makeRegistry([good, evil])

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-evil', name: 'read_evil', input: {} },
      { type: 'tool_use', id: 'tu-good', name: 'read_good', input: {} },
    ]

    const events: StreamEvent[] = []
    // 关键：drain 不得抛（loop 不崩）
    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: blocks,
        registry,
        context: makeNoopContext(events),
        permissionHandler: makeAllowAllHandler(),
      }),
      events,
    )

    // 两条结果都在（同批其他工具没被连累）
    expect(results).toHaveLength(2)
    const byId = new Map(results.map((r) => [r.toolUseId, r]))
    // evil 被降级为 error（errorToToolResult 以工具名包裹）
    expect(byId.get('tu-evil')!.result.isError).toBe(true)
    expect(String(byId.get('tu-evil')!.result.content)).toContain('read_evil')
    // good 正常返回，未受影响
    expect(byId.get('tu-good')!.result.isError).toBeFalsy()
    expect(String(byId.get('tu-good')!.result.content)).toContain('read_good ran')
    // evil 至少发了一条 error 生命周期 notice
    const evilErrorNotice = events
      .filter((e) => e.type === StreamEvents.SYSTEM_NOTICE)
      .map((e) => e.payload as { notice_type?: string; tool_call_id?: string; phase?: string })
      .find((p) => p.tool_call_id === 'tu-evil' && p.phase === 'error')
    expect(evilErrorNotice).toBeTruthy()
  })

  it('单 chunk 内多工具：start notice 全部先发（chunk-input 顺序），end notice 按 settle 顺序', async () => {
    // start notice 是预先一次性 emit 的，不受 settle 影响。
    const a = makeDelayedTool('read_a', 10)
    const b = makeDelayedTool('read_b', 60)
    const c = makeDelayedTool('read_c', 30)
    const registry = makeRegistry([a, b, c])

    const blocks: ToolUseBlock[] = [
      { type: 'tool_use', id: 'tu-a', name: 'read_a', input: {} },
      { type: 'tool_use', id: 'tu-b', name: 'read_b', input: {} },
      { type: 'tool_use', id: 'tu-c', name: 'read_c', input: {} },
    ]

    const events: StreamEvent[] = []
    await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: blocks,
        registry,
        context: makeNoopContext(events),
        permissionHandler: makeAllowAllHandler(),
      }),
      events,
    )

    const allNotices = events
      .filter((e) => e.type === StreamEvents.SYSTEM_NOTICE)
      .map((e) => e.payload as { notice_type?: string; tool_call_id?: string; phase?: string })
      .filter((p): p is { notice_type: string; tool_call_id: string; phase: string } => {
        return (
          ['tool_started', 'tool_completed', 'tool_failed'].includes(p.notice_type ?? '')
          && typeof p.tool_call_id === 'string'
        )
      })

    // 前 3 条必须是 start（按 chunk-input 顺序）
    const firstThree = allNotices.slice(0, 3)
    expect(firstThree.map((n) => n.phase)).toEqual(['start', 'start', 'start'])
    expect(firstThree.map((n) => n.tool_call_id)).toEqual(['tu-a', 'tu-b', 'tu-c'])

    // 后 3 条必须全部是 end（按 settle 时序：a 10ms → c 30ms → b 60ms）
    const lastThree = allNotices.slice(3)
    expect(lastThree.map((n) => n.phase)).toEqual(['end', 'end', 'end'])
    expect(lastThree.map((n) => n.tool_call_id)).toEqual(['tu-a', 'tu-c', 'tu-b'])
  })
})

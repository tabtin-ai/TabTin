/**
 * LocalPermissionHandler.requestPermissionsBatch · APPROVAL_REQUESTED 事件 payload 形状测试。
 *
 * v0.4 W1.5（PRD 05 §6.7.2 / §6.10）：
 *   - 单 `requestPermission` 接口已按 D6 一刀切删除
 *   - 单工具走 N=1 的 batch；emit 一条 `agent.stream.approval_requested` 事件
 *   - payload 形态：`{ batch_id, action_requests: [{ tool_name, tool_input, ... }] }`
 *
 * 这是 W4 dogfood 阶段发现的 ReviewPanel 崩栈链路第一环延续修法：
 *   - payload 必含完整 `tool_input`（任何 tool 类型都能渲染卡片）
 *   - bash 类工具仍**额外**暴露 `command` 字段，向后兼容旧前端
 *   - 非 bash 类工具 payload 里**不应**出现 `command` 字段（避免误导）
 *   - description / risk_level 字段语义不变，但都迁移到 `action_requests[i]` 子层级
 */

import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { LocalPermissionHandler } from '../src/permissions/local-permission-handler.js'
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolResult,
  ToolContext,
} from '../src/engine/contracts/tools.js';
import type {
  PermissionRequest,
} from '../src/engine/contracts/hitl.js';

class StubTool implements Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema = {}
  readonly isReadOnly: boolean

  constructor(name: string, isReadOnly = false) {
    this.name = name
    this.description = `${name} stub`
    this.isReadOnly = isReadOnly
  }

  async execute(_input: unknown, _context: ToolContext): Promise<ToolResult> {
    return { content: '' }
  }
}

interface CapturedHarness {
  events: StreamEvent[]
  emit: (event: StreamEvent) => void
  waitForUserInput: ReturnType<typeof vi.fn>
}

/**
 * 模拟用户对 batch 的响应：approve / deny。
 *
 * v0.4 W1.5（D6 一刀切）：响应 schema 严格走 batch 形态——
 * `{ batch_id, decisions: [{ tool_call_id, outcome: 'allow'|'deny' }] }`。
 *
 * 旧 `{ approved: bool }` 整批同决策格式已删除；本 helper 内部从 emit 出去
 * 的 APPROVAL_REQUESTED event 反查每条 actionRequest 的 tool_call_id，自动
 * 构造 decisions 数组（让原有用例文本不受 schema 升级波及）。
 */
function makeHarness(approved = true): CapturedHarness {
  const events: StreamEvent[] = []
  const outcome: 'allow' | 'deny' = approved ? 'allow' : 'deny'
  return {
    events,
    emit: (e) => { events.push(e) },
    waitForUserInput: vi.fn().mockImplementation(async (batchId: string) => {
      // 在 emit 流上找到最近一条与 batchId 匹配的 APPROVAL_REQUESTED，提取 action_requests
      const matching = [...events].reverse().find(e => {
        if (e.type !== StreamEvents.APPROVAL_REQUESTED) return false
        const p = e.payload as Record<string, unknown>
        return p.batch_id === batchId
      })
      const actionRequests = (matching?.payload as Record<string, unknown> | undefined)
        ?.action_requests as Array<Record<string, unknown>> | undefined ?? []
      const decisions = actionRequests.map((ar) => ({
        request_id: ar.request_id as string,
        tool_call_id: ar.tool_call_id as string,
        outcome,
      }))
      return { batch_id: batchId, decisions }
    }),
  }
}

function buildRequest(
  toolName: string,
  input: unknown,
  isReadOnly = false,
): PermissionRequest {
  return {
    tool: new StubTool(toolName, isReadOnly),
    input,
    threadId: 'thread-test',
    riskLevel: isReadOnly ? 'low' : 'medium',
    toolCallId: `tu-${randomUUID()}`,
  }
}

/**
 * 走 N=1 batch 路径，并返回单条 ActionRequest payload（断言专用 helper）。
 */
async function runSinglePermission(
  handler: LocalPermissionHandler,
  request: PermissionRequest,
): Promise<{ decision: 'allow' | 'deny' | 'allow_session'; payload: Record<string, unknown>; actionRequest: Record<string, unknown> }> {
  const decisions = await handler.requestPermissionsBatch({
    batchId: randomUUID(),
    requests: [request] ,
      agentRunId: 'test-run',
    })
  const decision = decisions[0]?.decision ?? 'deny'
  return { decision, payload: {} as Record<string, unknown>, actionRequest: {} as Record<string, unknown> }
}

describe('LocalPermissionHandler.requestPermissionsBatch · APPROVAL_REQUESTED payload 形状', () => {
  it('web_search 等无 command 字段的工具：action_requests[0] 含完整 tool_input，不出现 command 键', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      // default 模式 = cautious：所有非 unknown 工具都不自动批准 → 必走审批路径
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const toolInput = { search_term: 'tabtin', explanation: '了解 tabtin 是什么' }
    const { decision } = await runSinglePermission(
      handler,
      buildRequest('web_search', toolInput, true),
    )

    expect(decision).toBe('allow')
    const events = harness.events.filter(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )
    expect(events).toHaveLength(1)
    // 关键反向断言：runtime 不再 emit 旧 REVIEW_REQUIRED（W4.5 第三波 C1
    // 2026-05-13 wire `StreamEvents.REVIEW_REQUIRED` 已物理删，断言改字面量）
    expect(harness.events.find(e => e.type === 'agent.stream.review_required')).toBeUndefined()

    const payload = events[0].payload as Record<string, unknown>
    expect(payload.batch_id).toBeTruthy()
    expect(payload.approval_type).toBe('tool_permission')
    expect(payload.runtime_mode).toBe('interactive')
    expect(payload.schema_version).toBe(1)
    // ：卡片 message_id 与 hitl_interaction persist 同源
    expect(typeof payload.message_id).toBe('string')
    expect(payload.message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    const persistEvents = harness.events.filter(
      e => e.type === StreamEvents.PERSIST_MESSAGE,
    )
    const hitlPersist = persistEvents.find(
      e => (e.payload as Record<string, unknown>).message_kind === 'hitl_interaction',
    )
    expect(hitlPersist).toBeTruthy()
    expect((hitlPersist!.payload as Record<string, unknown>).message_id).toBe(payload.message_id)

    const actionRequests = payload.action_requests as Array<Record<string, unknown>>
    expect(actionRequests).toHaveLength(1)
    const ar = actionRequests[0]
    expect(ar.tool_name).toBe('web_search')
    expect(ar.tool_input).toEqual(toolInput)
    expect(ar.risk_level).toBe('low')
    // web_search 不应有 command 字段（不会误导旧前端按 bash 渲染）
    expect('command' in ar).toBe(false)
    expect(typeof ar.description).toBe('string')
    expect(ar.request_id).toBeTruthy()
    expect(ar.tool_call_id).toBeTruthy()
  })

  it('bash 类工具：action_requests[0] 同时含 tool_input + command（向后兼容旧前端）', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const toolInput = { command: 'echo hello-from-bash', cwd: '/tmp' }
    await runSinglePermission(handler, buildRequest('bash', toolInput))

    const events = harness.events.filter(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )
    expect(events).toHaveLength(1)
    const ar = (events[0].payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>
    expect(ar[0].tool_name).toBe('bash')
    // 两个字段都有，旧前端读 command、新前端读 tool_input 都不破
    expect(ar[0].tool_input).toEqual(toolInput)
    expect(ar[0].command).toBe('echo hello-from-bash')
  })

  it('非对象 toolInput（字符串）：tool_input 透传字符串，仍能被前端展示', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await runSinglePermission(
      handler,
      buildRequest('text_summarize', 'a long text body to summarize', true),
    )

    const ar = ((harness.events.find(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )!.payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>)[0]
    expect(ar.tool_input).toBe('a long text body to summarize')
    expect('command' in ar).toBe(false)
  })

  it('用户拒绝时不影响 payload 形状（回归保护）', async () => {
    const harness = makeHarness(false)
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const { decision } = await runSinglePermission(
      handler,
      buildRequest('web_search', { search_term: 'foo' }, true),
    )
    expect(decision).toBe('deny')

    const ar = ((harness.events.find(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )!.payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>)[0]
    expect(ar.tool_input).toEqual({ search_term: 'foo' })
  })

  it('search_term 字段会被 extractOperationSummary 识别成 query（产品 review 反馈修复）', async () => {
    // 修前 description 会落成 JSON.stringify(toolInput)；
    // 修后 description 应渲染为"查询：tabtin"——用户看得懂的人话。
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await runSinglePermission(
      handler,
      buildRequest('web_search', { search_term: 'tabtin', explanation: 'foo' }, true),
    )
    const ar = ((harness.events.find(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )!.payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>)[0]
    expect(ar.description).toBe('查询：tabtin')
  })

  it('skill_invoke 的 {skill, args} 渲染成人话而非裸 JSON', async () => {
    // 修前 description 落成 {"skill":"...","args":"..."}；
    // 修后应渲染为"技能：<key>（<用户原话>）"——审批卡片用户看得懂。
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await runSinglePermission(
      handler,
      buildRequest(
        'skill_invoke',
        { skill: 'app:tabmemo/tabmemo-operator', args: '帮我创建一个名为dd的笔记' },
        true,
      ),
    )
    const ar = ((harness.events.find(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )!.payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>)[0]
    expect(ar.description).toBe('技能：app:tabmemo/tabmemo-operator（帮我创建一个名为dd的笔记）')
  })

  it('skill_invoke 无 args 时只显示技能 key', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await runSinglePermission(
      handler,
      buildRequest('skill_invoke', { skill: 'user:code-style-check' }, true),
    )
    const ar = ((harness.events.find(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )!.payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>)[0]
    expect(ar.description).toBe('技能：user:code-style-check')
  })

  it('request.input === null：tool_input 透传 null，description 退化但不崩', async () => {
    // 边界：某些 mock / 早期工具调用没有 input，input 直接为 null。
    // payload 仍要安全产出，前端处理 null 走 fallback 分支，整链路不崩。
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await runSinglePermission(handler, buildRequest('web_search', null, true))
    const ar = ((harness.events.find(
      e => e.type === StreamEvents.APPROVAL_REQUESTED,
    )!.payload as Record<string, unknown>).action_requests as Array<Record<string, unknown>>)[0]
    expect(ar.tool_input).toBeNull()
    expect(ar.description).toBe('（无具体参数）')
    expect('command' in ar).toBe(false)
  })

  it('runtime 不再 emit REVIEW_REQUIRED（v0.4 W1.5 一刀切）', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await runSinglePermission(handler, buildRequest('web_search', { x: 1 }, true))

    // 关键反向断言：旧事件已下线（W4.5 第三波 C1 wire 常量也已物理删，字面量替代）
    const reviewEvents = harness.events.filter(e => e.type === 'agent.stream.review_required')
    expect(reviewEvents).toHaveLength(0)
    // 新事件正确发出
    const approvalEvents = harness.events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
    expect(approvalEvents).toHaveLength(1)
  })
})

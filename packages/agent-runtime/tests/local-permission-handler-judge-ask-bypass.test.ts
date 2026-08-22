/**
 * /#5394 安全不变量测试：到达 LocalPermissionHandler 的请求必弹审批卡。
 *
 * 历史背景（ 复现）：handler 曾有 legacy `shouldAutoApprove(toolName,
 * permissionMode)` 短路，宿主装配 'auto-approve-edits' 时 judge 判 ask 的
 * write 类工具被静默 allow（工作区外写 workspace_out 形同虚设）。
 *  Phase 2 起该短路机制整体删除——handler 不再自动批准任何请求，
 * 本测试守护「judge 判 ask → emit approval_requested 必发生」不回归。
 */

import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { LocalPermissionHandler } from '../src/permissions/local-permission-handler.js'
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js'
import type { Tool, ToolResult, ToolContext } from '../src/engine/contracts/tools.js'
import type { PermissionRequest } from '../src/engine/contracts/hitl.js'

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

interface Harness {
  events: StreamEvent[]
  emit: (event: StreamEvent) => void
  waitForUserInput: ReturnType<typeof vi.fn>
}

/** 模拟前端：收到 approval_requested 后整批 allow。 */
function makeHarness(): Harness {
  const events: StreamEvent[] = []
  return {
    events,
    emit: (e) => { events.push(e) },
    waitForUserInput: vi.fn().mockImplementation(async (batchId: string) => {
      const matching = [...events].reverse().find(e => {
        if (e.type !== StreamEvents.APPROVAL_REQUESTED) return false
        return (e.payload as Record<string, unknown>).batch_id === batchId
      })
      const actionRequests = ((matching?.payload as Record<string, unknown> | undefined)
        ?.action_requests ?? []) as Array<Record<string, unknown>>
      return {
        batch_id: batchId,
        decisions: actionRequests.map(ar => ({
          request_id: ar.request_id as string,
          tool_call_id: ar.tool_call_id as string,
          outcome: 'allow',
        })),
      }
    }),
  }
}

/** 构造一条「judge 已判 ask」的请求：decisionReason 携带 judge 判决理由。 */
function buildJudgeAskRequest(toolName: string): PermissionRequest {
  return {
    tool: new StubTool(toolName),
    input: { file_path: '/tmp/outside-workspace.txt', content: 'x' },
    threadId: 'thread-5393',
    riskLevel: 'medium',
    toolCallId: `tu-${randomUUID()}`,
    // judge step 4 file 分支的真实判决理由：路径不在工作区 → ask
    decisionReason: { type: 'workspace_out', path: '/tmp/outside-workspace.txt', kind: 'path' },
    userVisibleReason: '该路径不在当前工作区内',
  }
}

function approvalRequestedEvents(events: StreamEvent[]): StreamEvent[] {
  return events.filter(e => e.type === StreamEvents.APPROVAL_REQUESTED)
}

describe('#5393/#5394 judge-ask 必弹审批卡（自动批准机制已不存在）', () => {
  it('write_file（judge 判 workspace_out ask）必须弹审批卡', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [buildJudgeAskRequest('write_file')] ,
      agentRunId: 'test-run',
    })

    // 安全不变量：judge 判 ask → 必须 emit approval_requested 走人工确认
    expect(approvalRequestedEvents(harness.events)).toHaveLength(1)
    expect(harness.waitForUserInput).toHaveBeenCalledTimes(1)
  })

  it('edit_file（judge 判 ask）同样必须弹审批卡', async () => {
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [buildJudgeAskRequest('edit_file')] ,
      agentRunId: 'test-run',
    })

    expect(approvalRequestedEvents(harness.events)).toHaveLength(1)
  })

  it('不带 decisionReason 的直连请求（不走 judge 的冷门路径）也弹审批卡，不再自动批', async () => {
    //  Phase 2：删除 shouldAutoApprove 后 handler 对任何请求都不自动批准
    // ——read 类工具的放行由 judge / pre-start 快路径在上游完成，能落到
    // handler 的一律问人（fail-ask）。
    const harness = makeHarness()
    const handler = new LocalPermissionHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
    })

    const directRequest: PermissionRequest = {
      tool: new StubTool('read_file', true),
      input: { file_path: '/workspace/a.txt' },
      threadId: 'thread-5393',
      riskLevel: 'low',
      toolCallId: `tu-${randomUUID()}`,
      // 无 decisionReason —— 非 judge 路径（直连 handler）
    }

    const decisions = await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [directRequest] ,
      agentRunId: 'test-run',
    })

    // harness 模拟用户整批 allow → 最终 allow，但必须经过审批卡
    expect(approvalRequestedEvents(harness.events)).toHaveLength(1)
    expect(decisions[0]?.decision).toBe('allow')
  })
})

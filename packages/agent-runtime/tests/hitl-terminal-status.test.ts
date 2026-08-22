/**
 * （第二刀）：HITL 终态语义对齐。
 *
 * 覆盖 `local-permission-handler.ts` 与 `ask-tools.ts` 里
 * `HitlInteractionEvent.status` 与真实决策语义的映射：
 *
 * | 触发                                | 期望 status | wire outcome           |
 * |------------------------------------|-------------|------------------------|
 * | 用户 allow / deny                  | 'resolved'  | 'allow' / 'deny'       |
 * | mode 切换 / rollback / dismiss     | 'cancelled' | 'cancelled'            |
 * | timeout / waiter reject            | 'expired'   | 'expired'              |
 *
 * 第一刀之前的实装始终把 status 写成 'resolved'，让 hitl_interaction 消息终态与
 * PendingInteraction / renderer UI 状态漂移，是「面板 dismiss 后再打开还在 pending」
 * 幽灵卡的直接根因。本文件锁定新语义。
 */

import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { StreamEvents } from '@tabtin/agent-wire'
import { LocalPermissionHandler } from '../src/permissions/local-permission-handler.js'
import { createAskTools, __resetAskUserDedupForTest } from '../src/tools/ask-tools.js'
import { createInterruptAdapter } from '../src/permissions/interrupt-adapter.js'
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js'
import type { Tool, ToolContext, ToolResult } from '../src/engine/contracts/tools.js'
import type { PermissionRequest } from '../src/engine/contracts/hitl.js'

class StubTool implements Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema = {}
  readonly isReadOnly = true

  constructor(name: string) {
    this.name = name
    this.description = `${name} stub`
  }

  async execute(_input: unknown, _context: ToolContext): Promise<ToolResult> {
    return { content: '' }
  }
}

function buildRequest(toolName: string): PermissionRequest {
  return {
    tool: new StubTool(toolName),
    input: {},
    threadId: 'thread-test',
    riskLevel: 'low',
    toolCallId: `tu-${randomUUID()}`,
  }
}

function collectHitlInteractionStatuses(events: StreamEvent[]): string[] {
  const statuses: string[] = []
  for (const e of events) {
    if (e.type !== StreamEvents.PERSIST_MESSAGE) continue
    const p = e.payload as Record<string, unknown>
    if (p.message_kind !== 'hitl_interaction') continue
    const meta = (p.metadata as Record<string, unknown> | undefined)?.hitl as
      | { status?: string }
      | undefined
    if (typeof meta?.status === 'string') statuses.push(meta.status)
  }
  return statuses
}

describe('LocalPermissionHandler 终态 status（ 第二刀）', () => {
  it('用户 allow → hitl_interaction 消息落 resolved', async () => {
    const events: StreamEvent[] = []
    const handler = new LocalPermissionHandler({
      emitStreamEvent: (e) => events.push(e),
      waitForUserInput: vi.fn().mockImplementation(async (batchId: string) => {
        const req = events
          .filter((e) => e.type === StreamEvents.APPROVAL_REQUESTED)
          .map((e) => e.payload as Record<string, unknown>)
          .find((p) => p.batch_id === batchId)
        const actionRequests = (req?.action_requests ?? []) as Array<Record<string, unknown>>
        return {
          batch_id: batchId,
          decisions: actionRequests.map((ar) => ({
            request_id: ar.request_id as string,
            tool_call_id: ar.tool_call_id as string,
            outcome: 'allow' as const,
          })),
        }
      }),
    })
    await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [buildRequest('web_search')] ,
      agentRunId: 'test-run',
    })
    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'resolved'])
  })

  it('mode 切换 / rollback 触发 outcome=cancelled → hitl_interaction 消息落 cancelled', async () => {
    const events: StreamEvent[] = []
    const handler = new LocalPermissionHandler({
      emitStreamEvent: (e) => events.push(e),
      // 模拟 cancelAllPendingHitlRequests / applyCancelledByRollbackToHitl 走
      // 的 resolver payload —— 与 mode-switch-execute 内部触发的 cancel 同构。
      waitForUserInput: vi.fn().mockImplementation(async (batchId: string) => ({
        batch_id: batchId,
        decisions: [
          {
            request_id: '__mode_switch_cancel__',
            tool_call_id: '__mode_switch_cancel__',
            outcome: 'cancelled',
            rejection_message: 'agent mode changed',
          },
        ],
      })),
    })
    await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [buildRequest('shell')] ,
      agentRunId: 'test-run',
    })
    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'cancelled'])

    // ApprovalResolvedEvent 的 payload.decisions[*].outcome 也整批归 'cancelled'
    // ——Django `_derive_approval_terminal_status` 才能推出 PendingInteraction
    // 的 'cancelled' 状态；否则 PG 会与 ChatMessage.metadata.hitl.status 漂移。
    const resolved = events.find((e) => e.type === StreamEvents.APPROVAL_RESOLVED)
    expect(resolved).toBeTruthy()
    const decisions = (resolved!.payload as { decisions: Array<{ outcome: string }> }).decisions
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe('cancelled')
  })

  it('waiter timeout（Promise.race 抛错） → hitl_interaction 消息落 expired', async () => {
    const events: StreamEvent[] = []
    const handler = new LocalPermissionHandler({
      emitStreamEvent: (e) => events.push(e),
      // 立刻抛错模拟 30 分钟超时的最终状态（真实 timeout 走 setTimeout；用
      // reject 等价、跑得快）。
      waitForUserInput: vi.fn().mockImplementation(async () => {
        throw new Error('Permission batch timed out (test)')
      }),
    })
    await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [buildRequest('web_search')] ,
      agentRunId: 'test-run',
    })
    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'expired'])

    const resolved = events.find((e) => e.type === StreamEvents.APPROVAL_RESOLVED)
    expect(resolved).toBeTruthy()
    const decisions = (resolved!.payload as { decisions: Array<{ outcome: string }> }).decisions
    // timeout → 整批 outcome 归 'expired'，让 Django 侧同样落 'expired'。
    expect(decisions.every((d) => d.outcome === 'expired')).toBe(true)
  })

  it('scheduled 模式 fail-fast reject → 归 expired（无人及时响应语义等价）', async () => {
    const events: StreamEvent[] = []
    const handler = new LocalPermissionHandler({
      emitStreamEvent: (e) => events.push(e),
      waitForUserInput: vi.fn().mockImplementation(async () => {
        throw new Error('Permission batch fail-fast (mode=scheduled)')
      }),
      runtimeMode: 'scheduled',
    })
    await handler.requestPermissionsBatch({
      batchId: randomUUID(),
      requests: [buildRequest('web_search')] ,
      agentRunId: 'test-run',
    })
    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'expired'])
  })
})

describe('ask-tools emitAndWait 终态 status（ 第二刀）', () => {
  it('renderer dismiss（response.cancelled=true） → hitl_interaction 消息落 cancelled', async () => {
    __resetAskUserDedupForTest()
    const events: StreamEvent[] = []
    const emitter = (e: StreamEvent) => events.push(e)
    const [askUser] = createAskTools({ emitStreamEvent: emitter })

    const waitForUserInput = vi.fn().mockImplementation(async () => ({
      cancelled: true,
      reason: 'User closed the ask panel from the client UI.',
    }))

    const context: ToolContext = {
      messages: [],
      emitStreamEvent: emitter,
      waitForUserInput,
      threadId: 'thread-cancel-ask',
      agentRunId: 'test-run',
      interrupt: createInterruptAdapter({
        emitStreamEvent: emitter,
        waitForUserInput,
        threadId: 'thread-cancel-ask',
      }),
    } as unknown as ToolContext

    const result = await askUser.execute(
      {
        title: 'test',
        questions: [
          {
            id: 'q1',
            prompt: 'pick one',
            header: 'q1',
            options: [
              { id: 'a', label: 'A', description: 'opt a' },
              { id: 'b', label: 'B', description: 'opt b' },
            ],
          },
        ],
      },
      context,
    )

    // cancelled 走 jsonError（isError:true 语义），LLM 拿到「用户取消」文案
    expect(typeof result.content).toBe('string')
    expect(String(result.content)).toContain('dismissed')

    // ask 三件套走 kind='ask_choice'（HITL_KIND_BY_EVENT 映射，见 ask-tools.ts）
    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'cancelled'])

    // single_hitl_resolved 也带 outcome='cancelled'——Django relay_handler 据此
    // 落 PendingInteraction.status='cancelled'（本刀 relay_handler 同步修）。
    const resolved = events.find((e) => e.type === StreamEvents.SINGLE_HITL_RESOLVED)
    expect(resolved).toBeTruthy()
    expect((resolved!.payload as { outcome: string }).outcome).toBe('cancelled')
  })

  it('用户 skipped（既有语义不动） → resolved + outcome=skipped', async () => {
    __resetAskUserDedupForTest()
    const events: StreamEvent[] = []
    const emitter = (e: StreamEvent) => events.push(e)
    const [askUser] = createAskTools({ emitStreamEvent: emitter })

    const waitForUserInput = vi.fn().mockImplementation(async () => ({ skipped: true }))

    const context: ToolContext = {
      messages: [],
      emitStreamEvent: emitter,
      waitForUserInput,
      threadId: 'thread-skip-ask',
      agentRunId: 'test-run',
      interrupt: createInterruptAdapter({
        emitStreamEvent: emitter,
        waitForUserInput,
        threadId: 'thread-skip-ask',
      }),
    } as unknown as ToolContext

    await askUser.execute(
      {
        title: 'test',
        questions: [
          {
            id: 'q1',
            prompt: 'pick one',
            header: 'q1',
            options: [
              { id: 'a', label: 'A', description: 'opt a' },
              { id: 'b', label: 'B', description: 'opt b' },
            ],
          },
        ],
      },
      context,
    )

    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'resolved'])
    const resolved = events.find((e) => e.type === StreamEvents.SINGLE_HITL_RESOLVED)
    expect((resolved!.payload as { outcome: string }).outcome).toBe('skipped')
  })

  it('waiter timeout → hitl_interaction 消息落 expired（既有语义回归保护）', async () => {
    __resetAskUserDedupForTest()
    const events: StreamEvent[] = []
    const emitter = (e: StreamEvent) => events.push(e)
    const [askUser] = createAskTools({ emitStreamEvent: emitter })

    const waitForUserInput = vi.fn().mockImplementation(async () => {
      throw new Error('waiter forcibly rejected (test)')
    })

    const context: ToolContext = {
      messages: [],
      emitStreamEvent: emitter,
      waitForUserInput,
      threadId: 'thread-timeout-ask',
      agentRunId: 'test-run',
      interrupt: createInterruptAdapter({
        emitStreamEvent: emitter,
        waitForUserInput,
        threadId: 'thread-timeout-ask',
      }),
    } as unknown as ToolContext

    await askUser.execute(
      {
        title: 'test',
        questions: [
          {
            id: 'q1',
            prompt: 'pick one',
            header: 'q1',
            options: [
              { id: 'a', label: 'A', description: 'opt a' },
              { id: 'b', label: 'B', description: 'opt b' },
            ],
          },
        ],
      },
      context,
    )

    expect(collectHitlInteractionStatuses(events)).toEqual(['pending', 'expired'])
  })
})

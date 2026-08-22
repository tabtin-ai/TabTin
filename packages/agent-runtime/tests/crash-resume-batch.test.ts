/**
 * W3-轮 1 主北极星测试 — runtime crash resume 主体（PRD 05 v0.4 §7.1 + §7.2.3）。
 *
 * 业务场景：Solo 模式 Agent 长任务跑到一半 runtime 崩溃 / Daemon 重启后，
 *   - 已批过的 N 个工具：直接 inject `tool_result`，runtime 不重新弹卡片
 *   - 还没批的 1 个工具：通过 `UserInteractiveChannel` 重新挂 ApprovalPanel
 *
 * 6 个用例（与 prompt 对齐）：
 *   1. 同 batch 3 工具：2 已 resolved（allow/deny）+ 1 pending → 2 inject + 1 重挂
 *   2. 跨 batch 混合：batch-A 全 resolved + batch-B 全 pending
 *   3. 全 resolved：no channel 调用 + 全部 inject
 *   4. 全 pending：channel 调用一次 + decisions 注入
 *   5. 边界：pending_approvals 空 / undefined → no-op
 *   6. 边界：expires_at 已过期 / status='expired' → 按 deny 兜底 inject
 *
 * 详
 *   - `packages/agent-runtime/docs/prd/05-permissions-and-sandbox.md` §7.1 + §7.2.3
 */

import { describe, it, expect, vi } from 'vitest'
import {
  applyPendingApprovalsRestore,
  decodeWirePendingApprovals,
  type PendingApprovalsRestoreInput,
} from '../src/permissions/pending-approvals-restorer.js'
import {
  InMemoryApprovalMemoStore,
  applyCancelledByRollbackToHitl,
  type CancelledByRollbackDecision,
} from '../src/permissions/memo-store.js'
import type {
  ToolResultBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  SerializedPendingApproval,
} from '../src/engine/contracts/hitl.js';
import type {
  UserInteractiveChannel,
  BatchApprovalDecision,
} from '../src/permissions/types.js'

// ─── Helpers ────────────────────────────────────────────────────────

function makeTool(name: string, isReadOnly = true): Tool {
  return {
    name,
    description: `${name} stub`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly,
    execute: vi.fn(async () => ({ content: `${name} ran` })),
  }
}

function makeEntry(overrides: Partial<SerializedPendingApproval>): SerializedPendingApproval {
  return {
    batchId: 'batch-1',
    requestId: 'req-1',
    toolCallId: 'tu-1',
    toolName: 'list_directory',
    toolInput: { path: '/' },
    status: 'pending',
    decisionReason: { type: 'fallback_preset', preset: 'crash_resume' },
    allowedScopes: ['once', 'thread', 'always'],
    allowedOutcomes: ['allow', 'deny'],
    riskLevel: 'medium',
    runtimeMode: 'solo',
    createdAt: 1_700_000_000_000,
    expiresAt: Date.now() + 60_000, // 1 min in future by default
    ...overrides,
  }
}

interface ChannelHarness {
  channel: UserInteractiveChannel
  /** 顺序记录被请求的 batchId + actionRequests，便于断言"调了几次 channel"。 */
  calls: Array<{ batchId: string; toolCallIds: string[]; threadId: string; sessionId: string; runtimeMode: string }>
  /** 测试桩：按 toolCallId 给出用户决策；缺省走 deny。 */
  decisionsByToolCallId: Map<string, BatchApprovalDecision>
}

function makeChannelHarness(
  decisions: Record<string, Partial<BatchApprovalDecision>>,
): ChannelHarness {
  const calls: ChannelHarness['calls'] = []
  const decisionsByToolCallId = new Map<string, BatchApprovalDecision>()
  for (const [tcid, partial] of Object.entries(decisions)) {
    decisionsByToolCallId.set(tcid, {
      requestId: partial.requestId ?? `req-for-${tcid}`,
      toolCallId: tcid,
      outcome: partial.outcome ?? 'deny',
      scope: partial.scope,
      rejectionMessage: partial.rejectionMessage,
    })
  }
  const channel: UserInteractiveChannel = {
    requestApprovalsBatch: vi.fn(async (params) => {
      calls.push({
        batchId: params.batchId,
        toolCallIds: params.actionRequests.map((ar) => ar.toolCallId),
        threadId: params.threadId,
        sessionId: params.sessionId,
        runtimeMode: params.runtimeMode,
      })
      return {
        batchId: params.batchId,
        decisions: params.actionRequests.map((ar) => {
          const d = decisionsByToolCallId.get(ar.toolCallId)
          if (!d) {
            return {
              requestId: ar.requestId,
              toolCallId: ar.toolCallId,
              outcome: 'deny' as const,
            }
          }
          // 保证 requestId 与 actionRequest 一致（避免 stub 漏配）
          return { ...d, requestId: ar.requestId }
        }),
      }
    }),
  }
  return { channel, calls, decisionsByToolCallId }
}

function buildInput(
  pendingApprovals: SerializedPendingApproval[],
  opts: {
    channel?: UserInteractiveChannel
    tools?: Tool[]
    runtimeMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
    onLog?: (level: 'info' | 'warn', message: string) => void
  } = {},
): PendingApprovalsRestoreInput {
  const toolMap = new Map<string, Tool>((opts.tools ?? []).map((t) => [t.name, t]))
  return {
    pendingApprovals,
    channel: opts.channel,
    threadId: 'thread-resume',
    runtimeId: 'sess-resume',
    runtimeMode: opts.runtimeMode ?? 'solo',
    resolveTool: (n) => toolMap.get(n),
    onLog: opts.onLog,
  }
}

function getContent(block: ToolResultBlock): string {
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('W3-轮 1 主北极星 · pending-approvals-restorer', () => {
  it('用例 1：同 batch 3 工具混合（2 resolved allow/deny + 1 pending） → 2 inject + 1 重挂 channel', async () => {
    // 用户场景：用户批了 list_directory + 拒了 read_file，第 3 个 write_file 还没决定时崩溃
    const t1 = makeTool('list_directory')
    const t2 = makeTool('read_file')
    const t3 = makeTool('write_file', false)
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'resolved',
        outcome: 'allow',
        scope: 'once',
        approverIdentity: { userId: 'user-1', timestamp: 1_700_000_000_500 },
        resolvedAt: 1_700_000_000_500,
      }),
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-2',
        toolCallId: 'tu-2',
        toolName: 'read_file',
        status: 'resolved',
        outcome: 'deny',
        rejectionMessage: '这个文件包含敏感信息，不能读',
        resolvedAt: 1_700_000_000_600,
      }),
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-3',
        toolCallId: 'tu-3',
        toolName: 'write_file',
        status: 'pending',
      }),
    ]

    // 重启后用户对 tu-3 选 allow（重新挂时返回 allow 决策）
    const harness = makeChannelHarness({ 'tu-3': { outcome: 'allow', scope: 'thread' } })

    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel: harness.channel, tools: [t1, t2, t3] }),
    )

    // 主北极星断言：3 条 tool_result 全 inject（2 + 1）
    expect(result.toolResultBlocks).toHaveLength(3)
    expect(result.injectedToolCallIds.sort()).toEqual(['tu-1', 'tu-2', 'tu-3'])
    // channel 仅调一次，含 1 条 actionRequest（pending 的 tu-3）
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0].batchId).toBe('batch-A')
    expect(harness.calls[0].toolCallIds).toEqual(['tu-3'])
    expect(harness.calls[0].threadId).toBe('thread-resume')
    expect(harness.calls[0].sessionId).toBe('sess-resume')
    expect(harness.calls[0].runtimeMode).toBe('solo')
    // 重新挂收到的新 decision 也记录到 newDecisions
    expect(result.newDecisions).toHaveLength(1)
    expect(result.newDecisions[0].outcome).toBe('allow')

    // 内容断言：allow / deny / new-allow 分别有人话标识
    const tu1 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-1')!
    const tu2 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-2')!
    const tu3 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-3')!
    // W3-轮 1 三视角 review CRITICAL #2 修复：crash resume inject 的 tool_result
    // **任何 outcome** 都走 is_error=true——因为 runtime 实际未执行工具，没有
    // 真实结果可继续使用。文案明确说明"未实际执行 + 请重新调用"配合 is_error
    // 让 LLM 自然走重试路径，而不是误以为已成功。
    expect(tu1.is_error).toBe(true)
    expect(getContent(tu1)).toContain('用户已批准')
    expect(getContent(tu1)).toContain('list_directory')
    expect(getContent(tu1)).toContain('未实际完成')
    expect(tu2.is_error).toBe(true)
    expect(getContent(tu2)).toContain('用户拒绝')
    expect(getContent(tu2)).toContain('这个文件包含敏感信息')
    expect(tu3.is_error).toBe(true)
    expect(getContent(tu3)).toContain('重启后用户已批准')
    expect(getContent(tu3)).toContain('write_file')
    expect(getContent(tu3)).toContain('尚未真正执行')
  })

  it('用例 2：跨 batch 混合（batch-A 全 resolved + batch-B 全 pending）', async () => {
    const t1 = makeTool('list_directory')
    const t2 = makeTool('read_file')
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-A1',
        toolCallId: 'tu-A1',
        toolName: 'list_directory',
        status: 'resolved',
        outcome: 'allow',
      }),
      makeEntry({
        batchId: 'batch-B',
        requestId: 'req-B1',
        toolCallId: 'tu-B1',
        toolName: 'read_file',
        status: 'pending',
      }),
    ]

    const harness = makeChannelHarness({ 'tu-B1': { outcome: 'deny', rejectionMessage: 'no access' } })
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel: harness.channel, tools: [t1, t2] }),
    )

    expect(result.toolResultBlocks).toHaveLength(2)
    expect(result.injectedToolCallIds).toEqual(['tu-A1', 'tu-B1'])
    // channel 只对 batch-B 调一次（batch-A 全 resolved 不需要重挂）
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0].batchId).toBe('batch-B')
    expect(harness.calls[0].toolCallIds).toEqual(['tu-B1'])

    const tuA1 = result.toolResultBlocks[0]
    const tuB1 = result.toolResultBlocks[1]
    expect(tuA1.tool_use_id).toBe('tu-A1')
    // CRITICAL #2 修复：crash resume 工具未实际执行，全部 is_error=true
    expect(tuA1.is_error).toBe(true)
    expect(tuB1.tool_use_id).toBe('tu-B1')
    expect(tuB1.is_error).toBe(true)
    expect(getContent(tuB1)).toContain('重启后用户拒绝')
    expect(getContent(tuB1)).toContain('no access')
  })

  it('用例 3：全 resolved → no channel 调用 + 全部 inject + 主循环可推进', async () => {
    const t1 = makeTool('list_directory')
    const t2 = makeTool('read_file')
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'resolved',
        outcome: 'allow',
      }),
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-2',
        toolCallId: 'tu-2',
        toolName: 'read_file',
        status: 'resolved',
        outcome: 'cancelled',
      }),
    ]

    const harness = makeChannelHarness({})
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel: harness.channel, tools: [t1, t2] }),
    )

    expect(result.toolResultBlocks).toHaveLength(2)
    expect(harness.calls).toHaveLength(0) // 不需要重挂
    expect(harness.channel.requestApprovalsBatch).not.toHaveBeenCalled()
    expect(result.rehangedBatchIds).toHaveLength(0)

    // CRITICAL #2 修复：所有 outcome 走 is_error=true（详见 buildToolResultFromResolved 注释）
    const tu1 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-1')!
    expect(tu1.is_error).toBe(true)
    const tu2 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-2')!
    expect(tu2.is_error).toBe(true)
    expect(getContent(tu2)).toContain('已被取消')
  })

  it('用例 4：全 pending → channel 调用一次 + 重新挂 batch + decisions 注入', async () => {
    const t1 = makeTool('list_directory')
    const t2 = makeTool('read_file')
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'pending',
      }),
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-2',
        toolCallId: 'tu-2',
        toolName: 'read_file',
        status: 'pending',
      }),
    ]

    const harness = makeChannelHarness({
      'tu-1': { outcome: 'allow', scope: 'always' },
      'tu-2': { outcome: 'allow' },
    })
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel: harness.channel, tools: [t1, t2] }),
    )

    // 一次 channel 调用，含 2 条 actionRequest
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0].toolCallIds.sort()).toEqual(['tu-1', 'tu-2'])
    expect(result.toolResultBlocks).toHaveLength(2)
    expect(result.rehangedBatchIds).toEqual(['batch-A'])
    expect(result.newDecisions).toHaveLength(2)
    // 内容含"重启后用户已批准" + is_error=true（CRITICAL #2 修复：工具未实际执行）
    for (const block of result.toolResultBlocks) {
      expect(getContent(block)).toContain('重启后用户已批准')
      expect(block.is_error).toBe(true)
      expect(getContent(block)).toContain('尚未真正执行')
    }
  })

  it('用例 5：边界 — pending_approvals 空数组 / undefined → restore no-op', async () => {
    const harness = makeChannelHarness({})
    const r1 = await applyPendingApprovalsRestore(
      buildInput([], { channel: harness.channel }),
    )
    expect(r1.toolResultBlocks).toHaveLength(0)
    expect(r1.injectedToolCallIds).toHaveLength(0)
    expect(r1.rehangedBatchIds).toHaveLength(0)
    expect(harness.calls).toHaveLength(0)

    // undefined 形态：模拟 host 收到 wire 空数据
    const r2 = await applyPendingApprovalsRestore(
      buildInput((undefined as unknown) as SerializedPendingApproval[], { channel: harness.channel }),
    )
    expect(r2.toolResultBlocks).toHaveLength(0)
  })

  it('用例 6：边界 — expires_at 已过期 / status=expired → 按 deny 兜底 inject "审批已过期"', async () => {
    const t1 = makeTool('list_directory')
    const t2 = makeTool('read_file')
    const t3 = makeTool('write_file', false)
    const entries = [
      // 显式 status='expired'
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'expired',
        outcome: 'expired',
      }),
      // status='pending' 但 expires_at < now（Celery beat 还没扫到）
      makeEntry({
        batchId: 'batch-B',
        requestId: 'req-2',
        toolCallId: 'tu-2',
        toolName: 'read_file',
        status: 'pending',
        expiresAt: Date.now() - 60_000, // 已过期 1 分钟
      }),
      // 同 batch-B 内还有一条真 pending 不过期 —— 重新挂走 channel
      makeEntry({
        batchId: 'batch-B',
        requestId: 'req-3',
        toolCallId: 'tu-3',
        toolName: 'write_file',
        status: 'pending',
        expiresAt: Date.now() + 60_000,
      }),
    ]

    const harness = makeChannelHarness({ 'tu-3': { outcome: 'allow' } })
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel: harness.channel, tools: [t1, t2, t3] }),
    )

    expect(result.toolResultBlocks).toHaveLength(3)
    // 显式 expired
    const tu1 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-1')!
    expect(tu1.is_error).toBe(true)
    expect(getContent(tu1)).toContain('审批请求已过期')
    // pending 但 expires_at < now → 按 expired 兜底
    const tu2 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-2')!
    expect(tu2.is_error).toBe(true)
    expect(getContent(tu2)).toContain('审批请求已过期')
    // tu-3 走重新挂正常 allow
    const tu3 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-3')!
    // CRITICAL #2 修复：工具未真正执行，仍 is_error=true（让 LLM 重新调用）
    expect(tu3.is_error).toBe(true)
    expect(getContent(tu3)).toContain('重启后用户已批准')
    // channel 只对 batch-B 调一次（batch-B 内仅 tu-3 真 pending）
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0].toolCallIds).toEqual(['tu-3'])
  })

  // ── 额外边界：channel 缺失 / tool 找不到 / channel 抛错 ──────────────

  it('额外边界：channel 缺失 + 含 pending 条目 → 全部按 deny 兜底', async () => {
    const t1 = makeTool('list_directory')
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'pending',
      }),
    ]
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { tools: [t1] }), // 无 channel
    )
    expect(result.toolResultBlocks).toHaveLength(1)
    expect(result.toolResultBlocks[0].is_error).toBe(true)
    expect(getContent(result.toolResultBlocks[0])).toContain('审批通道不可用')
    expect(result.rehangedBatchIds).toHaveLength(0)
  })

  it('额外边界：tool 在当前 toolMap 找不到（已卸载/重命名）→ deny 兜底，不调 channel', async () => {
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'mcp_unknown_tool',
        status: 'pending',
      }),
    ]
    const harness = makeChannelHarness({})
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel: harness.channel, tools: [] }),
    )
    expect(result.toolResultBlocks).toHaveLength(1)
    expect(result.toolResultBlocks[0].is_error).toBe(true)
    expect(getContent(result.toolResultBlocks[0])).toContain('已不在当前可用工具集中')
    // tool 都没法构造 actionRequest → channel 不被调
    expect(harness.calls).toHaveLength(0)
  })

  it('额外边界：channel 抛错 → 整批 deny 兜底', async () => {
    const t1 = makeTool('list_directory')
    const channel: UserInteractiveChannel = {
      requestApprovalsBatch: vi.fn(async () => {
        throw new Error('Permission batch timed out (5min)')
      }),
    }
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'pending',
      }),
    ]
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { channel, tools: [t1] }),
    )
    expect(result.toolResultBlocks).toHaveLength(1)
    expect(result.toolResultBlocks[0].is_error).toBe(true)
    expect(getContent(result.toolResultBlocks[0])).toContain('重新挂载审批失败')
    expect(getContent(result.toolResultBlocks[0])).toContain('Permission batch timed out')
  })

  it('额外边界：cancelled_by_rollback outcome 走专用文案，让 LLM 不误以为是用户主动 deny', async () => {
    const t1 = makeTool('list_directory')
    const entries = [
      makeEntry({
        batchId: 'batch-A',
        requestId: 'req-1',
        toolCallId: 'tu-1',
        toolName: 'list_directory',
        status: 'resolved',
        outcome: 'cancelled_by_rollback',
        resolvedAt: Date.now(),
      }),
    ]
    const result = await applyPendingApprovalsRestore(
      buildInput(entries, { tools: [t1] }),
    )
    expect(result.toolResultBlocks).toHaveLength(1)
    expect(getContent(result.toolResultBlocks[0])).toContain('因用户回滚而取消')
    expect(getContent(result.toolResultBlocks[0])).toContain('已撤销了相关操作')
    expect(result.toolResultBlocks[0].is_error).toBe(true)
  })

  // ── W3-轮 1 三视角 review CRITICAL #1 自修：兼容嵌套 batch wire 形态 ──

  it('CRITICAL #1 自修：嵌套 batch wire 形态（Django relay_audit_writer 写入路径）也能 decode + restore', async () => {
    // Django relay_audit_writer 实际写入 PG 是嵌套形态：
    //   [{ batch_id, runtime_mode, expires_at, schema_version, entries: [...] }]
    // 而 PRD §7.1 范例是扁平形态。本期自修：decoder 兼容两种形态。
    const t1 = makeTool('list_directory')
    const t2 = makeTool('read_file')
    const futureExpiresAt = Date.now() + 60_000 // 1 min in future
    const wireRaw = [
      {
        batch_id: 'batch-A',
        approval_type: 'tool_permission',
        runtime_mode: 'solo',
        expires_at: futureExpiresAt,
        schema_version: 1,
        created_at: 1_700_000_000_000,
        entries: [
          {
            request_id: 'req-1',
            tool_call_id: 'tu-1',
            tool_name: 'list_directory',
            tool_namespace: '',
            tool_input_preview: '{"path":"/"}',
            decision_reason: { type: 'fallback_preset', preset: 'legacy_handler' },
            risk_level: 'low',
            status: 'resolved',
            outcome: 'allow',
            scope: 'once',
            approver_user_id: 'user-1',
            rejection_message: '',
            resolved_at: 1_700_000_100_000,
          },
          {
            request_id: 'req-2',
            tool_call_id: 'tu-2',
            tool_name: 'read_file',
            tool_namespace: '',
            tool_input_preview: '{"path":"a.md"}',
            decision_reason: { type: 'user_interactive' },
            risk_level: 'medium',
            status: 'pending',
            outcome: null,
            scope: null,
            rejection_message: '',
            resolved_at: null,
          },
        ],
      },
    ]

    // Step 1：decode 应该展平嵌套 batch + merge batch 元数据到每个 entry
    const decoded = decodeWirePendingApprovals(wireRaw)
    expect(decoded).toHaveLength(2)
    expect(decoded[0].batchId).toBe('batch-A')
    expect(decoded[0].toolCallId).toBe('tu-1')
    expect(decoded[0].status).toBe('resolved')
    expect(decoded[0].outcome).toBe('allow')
    // batch 元数据 merge：runtime_mode / expires_at 从 batch 包络继承
    expect(decoded[0].runtimeMode).toBe('solo')
    expect(decoded[0].expiresAt).toBe(futureExpiresAt)
    expect(decoded[1].batchId).toBe('batch-A') // 同 batch 共享 batch_id
    expect(decoded[1].toolCallId).toBe('tu-2')
    expect(decoded[1].status).toBe('pending')
    expect(decoded[1].runtimeMode).toBe('solo')

    // Step 2：把展平后的条目过 restore，验证端到端"已批 inject + 未批重挂"
    const harness = makeChannelHarness({ 'tu-2': { outcome: 'allow' } })
    const result = await applyPendingApprovalsRestore(
      buildInput(decoded, { channel: harness.channel, tools: [t1, t2] }),
    )
    expect(result.toolResultBlocks).toHaveLength(2)
    expect(result.injectedToolCallIds.sort()).toEqual(['tu-1', 'tu-2'])
    // 同 batch 内未批的 tu-2 重新挂一次
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0].batchId).toBe('batch-A')
    expect(harness.calls[0].toolCallIds).toEqual(['tu-2'])
    // 已批的 tu-1 直接 inject 不调 channel
    const tu1 = result.toolResultBlocks.find((b) => b.tool_use_id === 'tu-1')!
    expect(getContent(tu1)).toContain('用户已批准')
    expect(getContent(tu1)).toContain('list_directory')
  })

  it('CRITICAL #1 自修：扁平 wire 形态（PRD §7.1 范例）也能 decode（向后兼容）', async () => {
    // 直接平铺：每个数组元素本身就是一条审批
    const wireRaw = [
      {
        batch_id: 'batch-A',
        request_id: 'req-1',
        tool_call_id: 'tu-1',
        tool_name: 'list_directory',
        status: 'resolved',
        outcome: 'allow',
        scope: 'once',
        runtime_mode: 'interactive',
      },
    ]
    const decoded = decodeWirePendingApprovals(wireRaw)
    expect(decoded).toHaveLength(1)
    expect(decoded[0].batchId).toBe('batch-A')
    expect(decoded[0].toolCallId).toBe('tu-1')
    expect(decoded[0].outcome).toBe('allow')
  })

  it('CRITICAL #1 自修：嵌套 + 扁平混合 wire 形态（容错性）', () => {
    const wireRaw = [
      // 嵌套形态：batch 含 entries
      {
        batch_id: 'batch-A',
        runtime_mode: 'solo',
        entries: [
          {
            request_id: 'req-A1', tool_call_id: 'tu-A1',
            tool_name: 'bash', status: 'pending',
          },
        ],
      },
      // 扁平形态：直接条目（虽然实际 PG 不会混合，但 decoder 应该宽容）
      {
        batch_id: 'batch-B',
        request_id: 'req-B1', tool_call_id: 'tu-B1',
        tool_name: 'read_file', status: 'resolved', outcome: 'deny',
      },
    ]
    const decoded = decodeWirePendingApprovals(wireRaw)
    expect(decoded).toHaveLength(2)
    expect(decoded.map((e) => e.toolCallId).sort()).toEqual(['tu-A1', 'tu-B1'])
    // 嵌套形态条目继承 batch.runtime_mode='solo'
    const a1 = decoded.find((e) => e.toolCallId === 'tu-A1')!
    expect(a1.runtimeMode).toBe('solo')
  })

  it('CRITICAL #1 自修：嵌套 entry 自身字段优先级高于 batch 包络（不被覆盖）', () => {
    // 同名字段时 entry 自己的值优先（譬如 entry 上有 runtime_mode='batch'）
    const wireRaw = [
      {
        batch_id: 'batch-A',
        runtime_mode: 'solo', // batch 默认
        entries: [
          {
            request_id: 'r', tool_call_id: 'tc',
            tool_name: 'foo', status: 'pending',
            runtime_mode: 'batch', // entry 自定义优先
          },
        ],
      },
    ]
    const decoded = decodeWirePendingApprovals(wireRaw)
    expect(decoded).toHaveLength(1)
    expect(decoded[0].runtimeMode).toBe('batch') // 不被 batch 包络覆盖
  })
})

// ─── decodeWirePendingApprovals 单测 ────────────────────────────────

describe('W3-轮 1 · decodeWirePendingApprovals (wire → camelCase 转换)', () => {
  it('正常解码：完整 wire 字段映射到 camelCase', () => {
    const raw = [
      {
        batch_id: 'batch-A',
        request_id: 'req-1',
        tool_call_id: 'tu-1',
        tool_name: 'list_directory',
        tool_namespace: 'fs',
        tool_input: { path: '/tmp' },
        status: 'resolved',
        outcome: 'allow',
        scope: 'thread',
        rejection_message: '',
        decision_reason: { type: 'memoized_thread' },
        ask_hint: { summary: 'List a tmp', suggested_scope: 'once' },
        allowed_scopes: ['once', 'thread'],
        allowed_outcomes: ['allow'],
        risk_level: 'low',
        runtime_mode: 'solo',
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        resolved_at: 1_700_000_100_000,
        approver_identity: { user_id: 'user-1', client_info: 'electron', timestamp: 1_700_000_100_000 },
      },
    ]
    const out = decodeWirePendingApprovals(raw)
    expect(out).toHaveLength(1)
    const e = out[0]
    expect(e.batchId).toBe('batch-A')
    expect(e.toolCallId).toBe('tu-1')
    expect(e.toolName).toBe('list_directory')
    expect(e.toolNamespace).toBe('fs')
    expect(e.status).toBe('resolved')
    expect(e.outcome).toBe('allow')
    expect(e.scope).toBe('thread')
    expect(e.askHint?.summary).toBe('List a tmp')
    expect(e.askHint?.suggestedScope).toBe('once')
    expect(e.allowedScopes).toEqual(['once', 'thread'])
    expect(e.allowedOutcomes).toEqual(['allow'])
    expect(e.riskLevel).toBe('low')
    expect(e.runtimeMode).toBe('solo')
    expect(e.expiresAt).toBe(1_700_000_300_000)
    expect(e.approverIdentity?.userId).toBe('user-1')
  })

  it('容错：missing required fields → skip + warn', () => {
    const warnings: string[] = []
    const raw = [
      { batch_id: 'b' /* missing rest */ },
      {
        batch_id: 'b',
        request_id: 'r',
        tool_call_id: 'tc',
        tool_name: 'ok_tool',
        status: 'pending',
      },
    ]
    const out = decodeWirePendingApprovals(raw, (level, msg) => {
      if (level === 'warn') warnings.push(msg)
    })
    expect(out).toHaveLength(1)
    expect(out[0].toolName).toBe('ok_tool')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('容错：tool_input 缺失但有 tool_input_preview → 用占位对象包装', () => {
    const raw = [
      {
        batch_id: 'b',
        request_id: 'r',
        tool_call_id: 'tc',
        tool_name: 'bash',
        status: 'pending',
        tool_input_preview: 'rm -rf /tmp/xxx',
      },
    ]
    const out = decodeWirePendingApprovals(raw)
    expect(out).toHaveLength(1)
    expect(out[0].toolInput).toEqual({ __preview: 'rm -rf /tmp/xxx' })
  })

  it('容错：未知 outcome / status / scope → 安全降级', () => {
    const raw = [
      {
        batch_id: 'b',
        request_id: 'r',
        tool_call_id: 'tc',
        tool_name: 'foo',
        status: 'invalid_status',
        outcome: 'invalid_outcome',
        scope: 'invalid_scope',
      },
    ]
    const out = decodeWirePendingApprovals(raw)
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('pending')
    expect(out[0].outcome).toBeUndefined()
    expect(out[0].scope).toBeUndefined()
    expect(out[0].decisionReason).toBeDefined()
    // decision_reason 缺失时用 fallback_preset 兜底
    expect(out[0].decisionReason).toMatchObject({ type: 'fallback_preset' })
  })

  it('空数组 / 非数组 → 空结果', () => {
    expect(decodeWirePendingApprovals([])).toEqual([])
    expect(decodeWirePendingApprovals(null)).toEqual([])
    expect(decodeWirePendingApprovals(undefined)).toEqual([])
    expect(decodeWirePendingApprovals('not-array' as unknown)).toEqual([])
  })
})

// ─── B2 · markPendingApprovalsStale + cancelled_by_rollback envelope helper ──

describe('W3-轮 1 · markPendingApprovalsStale (PRD §7.6.2 接口 B)', () => {
  it('调 host 注入的 cancelClient 透传 thread/reason/rollback_event_id', async () => {
    const cancelClient = vi.fn(async () => ({ cancelledIds: ['req-1', 'req-2'] }))
    const store = new InMemoryApprovalMemoStore({ cancelPendingApprovals: cancelClient })

    const result = await store.markPendingApprovalsStale(
      'thread-x', 'rollback to checkpoint X', 'rb-evt-99',
    )

    expect(result.cancelledIds).toEqual(['req-1', 'req-2'])
    expect(cancelClient).toHaveBeenCalledTimes(1)
    expect(cancelClient).toHaveBeenCalledWith('thread-x', 'rollback to checkpoint X', 'rb-evt-99')
  })

  it('未注入 cancelClient → 抛错（fail-closed，调用方降级处理）', async () => {
    const store = new InMemoryApprovalMemoStore({})
    await expect(
      store.markPendingApprovalsStale('thread-x', 'rb', 'evt-1'),
    ).rejects.toThrow(/no cancelClient wired/)
  })

  it('cancelClient 抛错 → 透传给调用方', async () => {
    const cancelClient = vi.fn(async () => {
      throw new Error('Django HTTP 500')
    })
    const store = new InMemoryApprovalMemoStore({ cancelPendingApprovals: cancelClient })
    await expect(
      store.markPendingApprovalsStale('thread-x', 'rb', 'evt-1'),
    ).rejects.toThrow('Django HTTP 500')
  })
})

describe('W3-轮 1 · applyCancelledByRollbackToHitl (PRD §7.6.2 接口 B host envelope)', () => {
  function makeDecision(
    overrides: Partial<CancelledByRollbackDecision> = {},
  ): CancelledByRollbackDecision {
    return {
      request_id: 'req-x',
      tool_call_id: 'tc-x',
      outcome: 'cancelled_by_rollback',
      ...overrides,
    }
  }

  it('mock channel.requestApprovalsBatch promise 收到 cancelled_by_rollback → resolve cancelled', async () => {
    // 模拟 host 端 LocalPermissionHandler.waitForUserInput(batchId) 等待
    // 此 batch 的决议 promise——这个 promise 注册在 hitlMap 里，等到 host
    // 收到 Django 广播的 cancelled_by_rollback 后通过本 helper 解开。
    let resolveValue: unknown
    const resolver = (v: unknown) => {
      resolveValue = v
    }
    // Phase 3 F1：hitlMap entry 升级为 { sessionId, resolver }
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map([
      ['batch-A', { sessionId: 'sess-1', resolver }],
    ])

    const result = applyCancelledByRollbackToHitl({
      decisions: [
        makeDecision({ request_id: 'req-1', tool_call_id: 'tu-1' }),
        makeDecision({ request_id: 'req-2', tool_call_id: 'tu-2' }),
      ],
      hitlMap,
      batchId: 'batch-A',
      rejectionMessage: 'rollback to X',
    })

    expect(result.resolvedBatchIds).toEqual(['batch-A'])
    expect(result.orphanedRequestIds).toEqual([])
    // hitlMap 中已被 helper 删除（避免后续重复 resolve）
    expect(hitlMap.has('batch-A')).toBe(false)

    // resolver 收到 LocalRtUserResponse batch 形态：
    // outcome 降级为 'cancelled' + rejection_message 携带 rollback 文案
    const r = resolveValue as {
      batch_id: string
      decisions: Array<{
        tool_call_id: string
        outcome: 'cancelled'
        rejection_message: string
      }>
    }
    expect(r.batch_id).toBe('batch-A')
    expect(r.decisions).toHaveLength(2)
    expect(r.decisions[0].outcome).toBe('cancelled')
    expect(r.decisions[0].tool_call_id).toBe('tu-1')
    expect(r.decisions[0].rejection_message).toBe('rollback to X')
    expect(r.decisions[1].tool_call_id).toBe('tu-2')
  })

  it('decisions 含混合 outcome（cancelled_by_rollback + allow）→ 仅 cancelled_by_rollback 触发 resolve', () => {
    let resolveValue: unknown
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map([
      ['batch-A', { sessionId: 'sess-1', resolver: (v: unknown) => { resolveValue = v } }],
    ])
    applyCancelledByRollbackToHitl({
      decisions: [
        makeDecision({ request_id: 'req-1', tool_call_id: 'tu-1' }),
        // 这条不是 rollback —— helper 应忽略
        makeDecision({ request_id: 'req-2', tool_call_id: 'tu-2', outcome: 'allow' }),
      ],
      hitlMap,
      batchId: 'batch-A',
    })
    const r = resolveValue as { decisions: unknown[] }
    expect(r.decisions).toHaveLength(1)
  })

  it('hitlMap 不含 batchId → orphaned IDs 记录，无 resolve（first-resolve race / 进程已 restore）', () => {
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map()
    const result = applyCancelledByRollbackToHitl({
      decisions: [
        makeDecision({ request_id: 'req-1', tool_call_id: 'tu-1' }),
        makeDecision({ request_id: 'req-2', tool_call_id: 'tu-2' }),
      ],
      hitlMap,
      batchId: 'batch-orphan',
    })
    expect(result.resolvedBatchIds).toEqual([])
    expect(result.orphanedRequestIds).toEqual(['req-1', 'req-2'])
  })

  it('decisions 全是非 cancelled_by_rollback → no-op（不动 hitlMap）', () => {
    let resolved = false
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map([
      ['batch-A', { sessionId: 'sess-1', resolver: () => { resolved = true } }],
    ])
    const result = applyCancelledByRollbackToHitl({
      decisions: [
        makeDecision({ outcome: 'allow' }),
        makeDecision({ outcome: 'deny' }),
      ],
      hitlMap,
      batchId: 'batch-A',
    })
    expect(result.resolvedBatchIds).toEqual([])
    expect(resolved).toBe(false)
    expect(hitlMap.has('batch-A')).toBe(true) // 未删除
  })

  it('rejection_message 缺省 → 用内置中文文案兜底', () => {
    let resolveValue: unknown
    const hitlMap: import('../src/permissions/hitl-cancel.js').PendingHitlMap = new Map([
      ['batch-A', { sessionId: 'sess-1', resolver: (v: unknown) => { resolveValue = v } }],
    ])
    applyCancelledByRollbackToHitl({
      decisions: [makeDecision()],
      hitlMap,
      batchId: 'batch-A',
    })
    const r = resolveValue as { decisions: Array<{ rejection_message: string }> }
    expect(r.decisions[0].rejection_message).toContain('因用户回滚而取消')
  })
})

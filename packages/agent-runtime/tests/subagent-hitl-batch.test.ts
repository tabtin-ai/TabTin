/**
 * v0.4 W1.5-轮 4（PRD §7.9）：`createSubagentUserInteractiveChannel` 单元测试。
 *
 * 业务目标 — 子 Agent fork 后并发的 ask 决策走父 channel 一次 batch 决策；
 * 父子审批语义一致；askHint 注入子 Agent 来源标识；fail-closed deny 与父级同构。
 *
 * 覆盖：
 *   1. 父 channel undefined → 子 channel undefined（fail-closed 与父同构）
 *   2. 子 Agent 并发 N 个 ask 决策 → 父 channel 收到 1 条 requestApprovalsBatch
 *      且含 N 条 actionRequests
 *   3. askHint 注入子 Agent 标识（depth 1 / depth >1 / 已存在 askHint 保留 summary）
 *   4. depth 透传 + grand-child 不重复嵌套 "[子 Agent]" 前缀
 *   5. params 透传（batchId / sessionId / threadId / runtimeMode / timeoutMs / abortSignal）
 *   6. 父 channel 返回的 BatchApprovalResponse 原样回灌给子 Agent
 */

import { describe, it, expect, vi } from 'vitest';
import { createSubagentUserInteractiveChannel } from '../src/permissions/subagent-hitl.js';
import type {
  UserInteractiveChannel,
  BatchActionRequest,
  BatchApprovalResponse,
} from '../src/permissions/types.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';

// ─── helpers ────────────────────────────────────────────────────────

const fakeTool: Tool = {
  name: 'fake_tool',
  description: 'test',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  // 我们只需要类型可用，不真的调用
  execute: () => Promise.resolve({ success: true }) as unknown as Promise<unknown>,
} as unknown as Tool;

function makeAR(overrides: Partial<BatchActionRequest> = {}): BatchActionRequest {
  return {
    requestId: overrides.requestId ?? 'r1',
    toolCallId: overrides.toolCallId ?? 'tc1',
    tool: overrides.tool ?? fakeTool,
    toolInput: overrides.toolInput ?? {},
    reason: overrides.reason ?? { type: 'user_interactive', scope: 'once' },
    askHint: overrides.askHint,
    allowedScopes: overrides.allowedScopes ?? ['once', 'thread'],
    allowedOutcomes: overrides.allowedOutcomes ?? ['allow', 'deny'],
    riskLevel: overrides.riskLevel ?? 'low',
  };
}

function makeParentChannel(
  decisionsFactory: (req: BatchActionRequest) => {
    outcome: 'allow' | 'deny' | 'cancelled';
    scope?: 'once' | 'thread' | 'always';
  } = () => ({ outcome: 'allow', scope: 'once' }),
): { channel: UserInteractiveChannel; calls: Array<Parameters<UserInteractiveChannel['requestApprovalsBatch']>[0]> } {
  const calls: Array<Parameters<UserInteractiveChannel['requestApprovalsBatch']>[0]> = [];
  const channel: UserInteractiveChannel = {
    async requestApprovalsBatch(params) {
      calls.push(params);
      const response: BatchApprovalResponse = {
        batchId: params.batchId,
        decisions: params.actionRequests.map((req) => {
          const d = decisionsFactory(req);
          return {
            requestId: req.requestId,
            toolCallId: req.toolCallId,
            outcome: d.outcome,
            scope: d.scope,
          };
        }),
      };
      return response;
    },
  };
  return { channel, calls };
}

// ─── tests ──────────────────────────────────────────────────────────

describe('createSubagentUserInteractiveChannel — fail-closed deny 与父同构', () => {
  it('父 channel 为 undefined 时返回 undefined（子 Agent 走 fail-closed deny 路径）', () => {
    const result = createSubagentUserInteractiveChannel(undefined);
    expect(result).toBeUndefined();
  });

  it('父 channel 为 undefined + 任意 options 仍返回 undefined（不破坏 fail-closed）', () => {
    const result = createSubagentUserInteractiveChannel(undefined, {
      subagentDepth: 5,
      parentToolCallId: 'parent-tc',
    });
    expect(result).toBeUndefined();
  });
});

describe('createSubagentUserInteractiveChannel — N 条 batch 转发', () => {
  it('子 Agent 并发 2 个 ask → 父 channel 收到 1 条 requestApprovalsBatch（含 2 条 actionRequests）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;
    expect(child).toBeDefined();

    const response = await child.requestApprovalsBatch({
      batchId: 'batch-001',
      sessionId: 'sess-A',
      threadId: 'thread-A',
      actionRequests: [
        makeAR({ requestId: 'r1', toolCallId: 'tc1', askHint: { summary: 'list dir', suggestedScope: 'once' } }),
        makeAR({ requestId: 'r2', toolCallId: 'tc2', askHint: { summary: 'read file', suggestedScope: 'once' } }),
      ],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].actionRequests).toHaveLength(2);
    expect(calls[0].batchId).toBe('batch-001');
    expect(response.batchId).toBe('batch-001');
    expect(response.decisions).toHaveLength(2);
    expect(response.decisions[0].toolCallId).toBe('tc1');
    expect(response.decisions[1].toolCallId).toBe('tc2');
  });

  it('父 channel 返回的 decisions 原样回灌（不修改 outcome / scope）', async () => {
    const { channel: parent } = makeParentChannel((req) => {
      if (req.toolCallId === 'tc1') return { outcome: 'allow', scope: 'thread' };
      return { outcome: 'deny' };
    });
    const child = createSubagentUserInteractiveChannel(parent)!;

    const response = await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [
        makeAR({ requestId: 'r1', toolCallId: 'tc1' }),
        makeAR({ requestId: 'r2', toolCallId: 'tc2' }),
      ],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    expect(response.decisions[0].outcome).toBe('allow');
    expect(response.decisions[0].scope).toBe('thread');
    expect(response.decisions[1].outcome).toBe('deny');
  });

  it('params 透传（sessionId / threadId / runtimeMode / timeoutMs / abortSignal）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent)!;
    const ac = new AbortController();

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 'sess-X',
      threadId: 'thread-X',
      actionRequests: [makeAR()],
      runtimeMode: 'solo',
      timeoutMs: 12345,
      abortSignal: ac.signal,
      agentRunId: 'test-run',
    });

    expect(calls[0].sessionId).toBe('sess-X');
    expect(calls[0].threadId).toBe('thread-X');
    expect(calls[0].runtimeMode).toBe('solo');
    expect(calls[0].timeoutMs).toBe(12345);
    expect(calls[0].abortSignal).toBe(ac.signal);
  });
});

describe('createSubagentUserInteractiveChannel — askHint 注入子 Agent 标识', () => {
  it('depth=1 默认前缀 "[子 Agent] " 注入 summary（让 ApprovalDialog 显示来源）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [
        makeAR({ askHint: { summary: '列出工作区目录', suggestedScope: 'once' } }),
      ],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    const enriched = calls[0].actionRequests[0];
    expect(enriched.askHint?.summary).toBe('[子 Agent] 列出工作区目录');
    expect(enriched.askHint?.suggestedScope).toBe('once');
  });

  it('depth>1 时携带"（深度 N）"标识（grand-child / great-grand-child 场景）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 2 })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [
        makeAR({ askHint: { summary: '读取 README', suggestedScope: 'once' } }),
      ],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    expect(calls[0].actionRequests[0].askHint?.summary).toBe('[子 Agent（深度 2）] 读取 README');
  });

  it('actionRequest 缺 askHint 时给通用兜底文案（"请审批此工具调用"）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [makeAR({ askHint: undefined })],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    const enriched = calls[0].actionRequests[0];
    expect(enriched.askHint).toBeDefined();
    expect(enriched.askHint?.summary).toBe('[子 Agent] 请审批此工具调用');
    expect(enriched.askHint?.suggestedScope).toBe('once');
  });

  it('已是 [子 Agent] 标记的 summary 不重复嵌套（grand-child 通过 wrapped channel 提交）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [
        makeAR({ askHint: { summary: '[子 Agent] 已被父子两层包装的请求', suggestedScope: 'thread' } }),
      ],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    const enriched = calls[0].actionRequests[0];
    expect(enriched.askHint?.summary).toBe('[子 Agent] 已被父子两层包装的请求');
    expect(enriched.askHint?.summary.startsWith('[子 Agent] [子 Agent]')).toBe(false);
  });

  it('保留服务端原 suggestedScope（不强制改为 once）', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [
        makeAR({ askHint: { summary: '工具', suggestedScope: 'always' } }),
      ],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    expect(calls[0].actionRequests[0].askHint?.suggestedScope).toBe('always');
  });

  it('其他字段（requestId / toolCallId / tool / toolInput / allowedScopes / riskLevel）原样透传', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;

    const original = makeAR({
      requestId: 'req-X',
      toolCallId: 'tc-X',
      toolInput: { path: '/etc/passwd' },
      allowedScopes: ['once'],
      allowedOutcomes: ['deny'],
      riskLevel: 'high',
      askHint: { summary: 'read', suggestedScope: 'once' },
    });

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [original],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    const enriched = calls[0].actionRequests[0];
    expect(enriched.requestId).toBe('req-X');
    expect(enriched.toolCallId).toBe('tc-X');
    expect(enriched.toolInput).toEqual({ path: '/etc/passwd' });
    expect(enriched.allowedScopes).toEqual(['once']);
    expect(enriched.allowedOutcomes).toEqual(['deny']);
    expect(enriched.riskLevel).toBe('high');
    // 仅 askHint.summary 被前缀，其它字段不动
  });
  it('injects subagent_context when parentToolCallId provided ', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, {
      subagentDepth: 1,
      parentToolCallId: 'toolu_parent_abc',
      subagentRunId: 'run-child-1',
      label: 'Research Agent',
    })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [makeAR({ askHint: { summary: 'list dir', suggestedScope: 'once' } })],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    const enriched = calls[0].actionRequests[0];
    expect(enriched.subagentContext).toEqual({
      parent_tool_call_id: 'toolu_parent_abc',
      subagent_run_id: 'run-child-1',
      label: 'Research Agent',
    });
    expect(enriched.askHint?.summary).toBe('[子 Agent] list dir');
  });

  it('omits subagent_context when parentToolCallId missing', async () => {
    const { channel: parent, calls } = makeParentChannel();
    const child = createSubagentUserInteractiveChannel(parent, { subagentDepth: 1 })!;

    await child.requestApprovalsBatch({
      batchId: 'b',
      sessionId: 's',
      threadId: 't',
      actionRequests: [makeAR()],
      runtimeMode: 'interactive',
      agentRunId: 'test-run',
    });

    expect(calls[0].actionRequests[0].subagentContext).toBeUndefined();
  });
});

describe('createSubagentUserInteractiveChannel — 错误传播', () => {
  it('父 channel 抛错时子 channel 同样抛错（fail-closed 一致性）', async () => {
    const failingParent: UserInteractiveChannel = {
      requestApprovalsBatch: vi.fn().mockRejectedValue(new Error('parent denied')),
    };
    const child = createSubagentUserInteractiveChannel(failingParent, { subagentDepth: 1 })!;

    await expect(
      child.requestApprovalsBatch({
        batchId: 'b',
        sessionId: 's',
        threadId: 't',
        actionRequests: [makeAR()],
        runtimeMode: 'interactive',
        agentRunId: 'test-run',
      }),
    ).rejects.toThrow('parent denied');
  });
});

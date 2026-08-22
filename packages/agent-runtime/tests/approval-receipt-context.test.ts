/**
 * approval-receipt-context.test.ts —  端到端：审批结果进 Agent 上下文。
 *
 * 验证 runTools 在 judge/HITL 判定后，把「批准 / 自动放行」回执前置到对应工具
 * 的 tool_result（与 deny 的上下文回执对称）：
 *   - 用户当场批准 → 含 <approval_note> + 「User approved tool」
 *   - memo「始终允许」自动放行 → 含「auto-approved」回执
 *   - 用户拒绝 → 维持 deny 文案，且不误加批准回执
 *   - 常规（非 memo）allow → 不加回执（避免污染上下文）
 *   - 工具执行出错 → 不叠加回执（已有 <tool_use_error> 语义）
 *   - 审批通道不可用（channelError）→ 整批 deny，不加回执
 *
 * judge 被 vi.mock 成按 tool 名产出受控判决，避免依赖真实策略细节。
 */

import { describe, it, expect, vi } from 'vitest';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

vi.mock('@tabtin/security-policy', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>(
    '@tabtin/security-policy',
  );
  return {
    ...actual,
    judge: (params: { tool: { name: string } }) => {
      const name = params.tool.name;
      if (name === 'memo_tool' || name === 'memo_error') {
        return {
          behavior: 'allow',
          reason: { type: 'memo_allow', key: 'k', createdAt: '2026-01-01', specificity: 'exact' },
        };
      }
      if (name === 'plain_allow') {
        return { behavior: 'allow', reason: { type: 'policy_allow' } };
      }
      // 其余工具走 ask（用户审批）
      return {
        behavior: 'ask',
        reason: { type: 'workspace_out', path: '/outside', kind: 'path' },
        userVisibleReason: '该路径不在当前工作区内',
      };
    },
  };
});

const { runTools } = await import('../src/engine/tooling/tool-orchestration.js');
const { ToolRegistry } = await import('../src/engine/tooling/tool-system.js');
const { createInterruptAdapter } = await import('../src/permissions/interrupt-adapter.js');
import type { EffectivePolicy, MemoStore, WorkspaceSnapshot } from '@tabtin/security-policy';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';
import type { ToolUseBlock } from '../src/engine/contracts/conversation.js';
import type { Tool, ToolContext, ToolProvider } from '../src/engine/contracts/tools.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';

function makeWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    sources: { sandbox: '/ws', workingDir: '/ws', sessionApprovedPaths: [], attachedFiles: [] },
    allowedPaths: ['/ws'],
    allowedFiles: [],
    spaceSessionId: 'sess-receipt',
  };
}

function makePolicy(): EffectivePolicy {
  return {
    approvalMode: 'always_ask',
    workspace: makeWorkspaceSnapshot(),
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

function makeMemoStore(): MemoStore {
  return {
    generation: 0,
    lookup: () => null,
    putAlways: async () => undefined,
    revoke: async () => undefined,
    maybeRefetch: async () => false,
    bootstrap: async () => undefined,
    replaceAll: () => undefined,
  };
}

/** 只读工具（走并行执行路径），默认返回可识别输出；memo_error 返回错误结果。 */
function makeReadTool(name: string): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: vi.fn(async () =>
      name === 'memo_error'
        ? { content: 'boom', isError: true }
        : { content: `OUTPUT:${name}`, isError: false },
    ),
  };
}

function makeContext(): ToolContext {
  return {
    threadId: 'thr-receipt',
    runtimeId: 'sess-receipt',
    toolUseId: 'mock',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: '/ws',
  };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<ToolExecutionResult[]> {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

function contentOf(results: ToolExecutionResult[], id: string): string {
  const r = results.find((x) => x.toolUseId === id)!;
  return typeof r.result.content === 'string' ? r.result.content : JSON.stringify(r.result.content);
}

async function runWith(names: string[], opts?: { channelThrows?: boolean }): Promise<ToolExecutionResult[]> {
  const tools = names.map(makeReadTool);
  const provider: ToolProvider = { getTools: () => tools };
  const registry = new ToolRegistry();
  registry.loadTools(provider);

  const blocks: ToolUseBlock[] = names.map((name) => ({
    type: 'tool_use',
    id: `tu-${name}`,
    name,
    input: {},
  }));

  const userInteractiveChannel = {
    requestApprovalsBatch: vi.fn(
      async (req: { actionRequests: Array<{ toolCallId: string; tool: { name: string } }> }) => {
        if (opts?.channelThrows) throw new Error('synthetic approval channel failure');
        return {
          decisions: req.actionRequests.map((r) => ({
            requestId: r.toolCallId,
            toolCallId: r.toolCallId,
            outcome: r.tool.name === 'deny_tool' ? ('deny' as const) : ('allow' as const),
          })),
        };
      },
    ),
  };

  return drain(
    runTools({
      toolUseBlocks: blocks,
      registry,
      context: makeContext(),
      permissionHandler: {
        requestPermissionsBatch: async (r) =>
          r.requests.map((x) => ({ toolCallId: x.toolCallId ?? x.tool.name, decision: 'allow' as const })),
      },
      options: {
        agentMode: 'agent',
        sessionId: 'sess-receipt',
        toolRiskPolicy: createTestToolRiskPolicyPort({
          buildEffectivePolicy: () => makePolicy(),
          memoStore: makeMemoStore(),
        }),
        interrupt: createInterruptAdapter({
          threadId: 'chat-session-sess-receipt',
          userInteractiveChannel,
        }),
        outputScan: false,
      },
    }),
  );
}

describe('#4760 审批结果进上下文（runTools 端到端）', () => {
  it('用户批准 → tool_result 含批准回执 + 原始输出', async () => {
    const results = await runWith(['approve_tool']);
    const c = contentOf(results, 'tu-approve_tool');
    expect(c).toContain('<approval_note>');
    expect(c).toContain("User approved tool 'approve_tool'.");
    expect(c).toContain('OUTPUT:approve_tool');
  });

  it('memo 自动放行 → 含「auto-approved」回执', async () => {
    const results = await runWith(['memo_tool']);
    const c = contentOf(results, 'tu-memo_tool');
    expect(c).toContain('<approval_note>');
    expect(c).toContain('auto-approved');
    expect(c).toContain('OUTPUT:memo_tool');
  });

  it('用户拒绝 → 维持 deny 文案，不误加批准回执', async () => {
    const results = await runWith(['deny_tool']);
    const r = results.find((x) => x.toolUseId === 'tu-deny_tool')!;
    expect(r.result.isError).toBe(true);
    const c = contentOf(results, 'tu-deny_tool');
    expect(c).toContain('User denied');
    expect(c).not.toContain('<approval_note>');
  });

  it('常规（非 memo）allow → 不加回执', async () => {
    const results = await runWith(['plain_allow']);
    const c = contentOf(results, 'tu-plain_allow');
    expect(c).not.toContain('<approval_note>');
    expect(c).toContain('OUTPUT:plain_allow');
  });

  it('工具执行出错 → 即使已放行也不叠加回执', async () => {
    const results = await runWith(['memo_error']);
    const r = results.find((x) => x.toolUseId === 'tu-memo_error')!;
    expect(r.result.isError).toBe(true);
    const c = contentOf(results, 'tu-memo_error');
    expect(c).not.toContain('<approval_note>');
  });

  it('审批通道不可用（channelError）→ 整批 deny，不加回执', async () => {
    const results = await runWith(['approve_tool'], { channelThrows: true });
    const r = results.find((x) => x.toolUseId === 'tu-approve_tool')!;
    expect(r.result.isError).toBe(true);
    expect(contentOf(results, 'tu-approve_tool')).not.toContain('<approval_note>');
  });

  it('混合批次 → 各工具按自身判决独立注入', async () => {
    const results = await runWith(['approve_tool', 'plain_allow', 'memo_tool', 'deny_tool']);
    expect(contentOf(results, 'tu-approve_tool')).toContain('<approval_note>');
    expect(contentOf(results, 'tu-plain_allow')).not.toContain('<approval_note>');
    expect(contentOf(results, 'tu-memo_tool')).toContain('auto-approved');
    expect(contentOf(results, 'tu-deny_tool')).not.toContain('<approval_note>');
  });
});

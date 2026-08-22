/**
 * W2-轮 1 自修复（产品 Review CRITICAL #2 + 用户视角 CRITICAL #2）：
 * `LocalPermissionHandler.requestPermissionsBatch` 收到用户决策（含 ``scope``）后，
 * 必须按 scope 写入 ``ApprovalMemoStore``，否则 Layer 4 永远 miss。
 *
 * 覆盖矩阵（PRD 05 v0.4 §6.5 + §7.3）：
 *   1. scope='always' → memoStore.putAlways
 *   2. scope='thread' → memoStore.putThread
 *   3. scope='once'   → 不写
 *   4. 缺省 scope     → 不写（向后兼容；客户端没传 scope 视作 once）
 *   5. tool 无 getApprovalKey 走 stableJsonStringify fallback 仍写入
 *   6. tool.getApprovalKey 返回 null → skip 写
 *   7. 多条 batch 各自按自己 scope 路由
 *   8. memoStore 缺失（未注入）→ noop，不抛
 *   9. memoStore.putAlways 抛错 → warn 不污染主决策返回
 *  10. approver_identity / rejection_message 透传到 entry
 */

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { judge as judgeV3 } from '@tabtin/security-policy';
import type {
  EffectivePolicy,
  JudgeContext,
  JudgeTool,
} from '@tabtin/security-policy';
import { LocalPermissionHandler } from '../src/permissions/local-permission-handler.js';
import { InMemoryApprovalMemoStore } from '../src/permissions/memo-store.js';
import { buildApprovalKey } from '../src/permissions/approval-key.js';
import { buildApprovalKey as buildSecurityPolicyApprovalKey } from '@tabtin/security-policy';
import { createJudgeMemoStoreAdapter } from './helpers/judge-memo-store-adapter.js';
import { buildTestMemoPatternKey } from './helpers/tool-risk-policy-port.js';
import type { BuildMemoPatternKeyInput } from '../src/engine/contracts/tool-risk-policy.js';
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
  readonly name: string;
  readonly description: string;
  readonly inputSchema = {};
  readonly isReadOnly: boolean;
  readonly getApprovalKey?: (input: unknown) => { key: string } | null;

  constructor(
    name: string,
    isReadOnly = false,
    getApprovalKey?: (input: unknown) => { key: string } | null,
  ) {
    this.name = name;
    this.description = `${name} stub`;
    this.isReadOnly = isReadOnly;
    if (getApprovalKey) this.getApprovalKey = getApprovalKey;
  }

  async execute(_input: unknown, _context: ToolContext): Promise<ToolResult> {
    return { content: '' };
  }
}

function buildRequest(
  toolName: string,
  input: unknown,
  opts: { isReadOnly?: boolean; getApprovalKey?: (input: unknown) => { key: string } | null } = {},
): PermissionRequest {
  return {
    tool: new StubTool(toolName, opts.isReadOnly ?? false, opts.getApprovalKey),
    input,
    threadId: 'thread-test',
    riskLevel: opts.isReadOnly ? 'low' : 'medium',
    toolCallId: `tu-${randomUUID()}`,
  };
}

function makeHarness(decisionsBuilder: (ar: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) {
  const events: StreamEvent[] = [];
  return {
    events,
    emit: (e: StreamEvent) => {
      events.push(e);
    },
    waitForUserInput: vi.fn().mockImplementation(async (batchId: string) => {
      const matching = [...events].reverse().find((e) => {
        if (e.type !== StreamEvents.APPROVAL_REQUESTED) return false;
        return (e.payload as Record<string, unknown>).batch_id === batchId;
      });
      const actionRequests =
        ((matching?.payload as Record<string, unknown> | undefined)
          ?.action_requests as Array<Record<string, unknown>>) ?? [];
      return { batch_id: batchId, decisions: decisionsBuilder(actionRequests) };
    }),
  };
}


function memoKey(
  tool: Tool,
  toolInput: unknown,
  decisionReason?: BuildMemoPatternKeyInput['decisionReason'],
): string {
  return buildTestMemoPatternKey({
    toolName: tool.name,
    policyActionKind: tool.policyActionKind,
    toolInput,
    extractPolicyParams: tool.extractPolicyParams,
    decisionReason,
  });
}

function makeHandler(opts: ConstructorParameters<typeof LocalPermissionHandler>[0]) {
  return new LocalPermissionHandler({
    buildMemoPatternKey: buildTestMemoPatternKey,
    ...opts,
  });
}

describe('LocalPermissionHandler · memo write-back by scope', () => {
  it('1. scope=always → memoStore.putAlways called with correct entry', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
        approver_identity: { user_id: 'u-42' },
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const tool = new StubTool('bash', false, () => ({ key: 'npm install' }));
    const req: PermissionRequest = {
      tool,
      input: { command: 'npm install express' },
      threadId: 'thread-test',
      riskLevel: 'medium',
      toolCallId: 'tu-1',
    };

    const decisions = await handler.requestPermissionsBatch({ batchId: 'batch-1', requests: [req], agentRunId: 'test-run' });

    expect(decisions[0].decision).toBe('allow');
    const key = memoKey(tool, { command: 'npm install express' });
    const hit = memo.getAlways(key);
    expect(hit).not.toBeNull();
    expect(hit?.decision).toBe('allow');
    expect(hit?.approverUserId).toBe('u-42');
  });

  it('2. scope=thread → memoStore.putThread called, putAlways untouched', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'thread',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const tool = new StubTool('read_file', true, () => ({ key: '/tmp/a' }));
    const req = buildRequest('read_file', { file_path: '/tmp/a' }, {
      isReadOnly: true,
      getApprovalKey: () => ({ key: '/tmp/a' }),
    });

    await handler.requestPermissionsBatch({ batchId: 'b2', requests: [req], agentRunId: 'test-run' });

    const key = memoKey(req.tool, { file_path: '/tmp/a' });
    expect(memo.getThread(key)?.decision).toBe('allow');
    expect(memo.getAlways(key)).toBeNull();
  });

  it('3. scope=once → no write to memoStore', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const putAlwaysSpy = vi.spyOn(memo, 'putAlways');
    const putThreadSpy = vi.spyOn(memo, 'putThread');
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'once',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const req = buildRequest('bash', { command: 'ls' });
    await handler.requestPermissionsBatch({ batchId: 'b3', requests: [req], agentRunId: 'test-run' });
    expect(putAlwaysSpy).not.toHaveBeenCalled();
    expect(putThreadSpy).not.toHaveBeenCalled();
  });

  it('4. scope omitted → no write (treated as once)', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const putAlwaysSpy = vi.spyOn(memo, 'putAlways');
    const putThreadSpy = vi.spyOn(memo, 'putThread');
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    await handler.requestPermissionsBatch({
      batchId: 'b4',
      requests: [buildRequest('bash', { command: 'ls' })],
      agentRunId: 'test-run',
    });
    expect(putAlwaysSpy).not.toHaveBeenCalled();
    expect(putThreadSpy).not.toHaveBeenCalled();
  });

  it('5. tool without getApprovalKey: stableJsonStringify fallback still writes', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const req = buildRequest('web_search', { search_term: 'tabtin' }, { isReadOnly: true });
    await handler.requestPermissionsBatch({ batchId: 'b5', requests: [req], agentRunId: 'test-run' });
    expect(memo.__debugAlwaysSnapshot()).not.toEqual({});
  });

  it('6. tool.getApprovalKey returns null → skip write', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const putAlwaysSpy = vi.spyOn(memo, 'putAlways');
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const tool = new StubTool('sensitive_tool', false, () => null);
    const req: PermissionRequest = {
      tool,
      input: { secret: 'pwd' },
      threadId: 'thread-test',
      riskLevel: 'high',
      toolCallId: 'tu-6',
    };
    await handler.requestPermissionsBatch({ batchId: 'b6', requests: [req], agentRunId: 'test-run' });
    expect(putAlwaysSpy).not.toHaveBeenCalled();
  });

  it('7. multi-decision batch: each routed by its own scope', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar, i) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: i === 0 ? 'always' : 'thread',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const r1 = buildRequest('bash', { command: 'ls' }, { getApprovalKey: () => ({ key: 'ls' }) });
    const r2 = buildRequest('read_file', { file_path: '/x' }, {
      isReadOnly: true,
      getApprovalKey: () => ({ key: '/x' }),
    });
    await handler.requestPermissionsBatch({ batchId: 'b7', requests: [r1, r2], agentRunId: 'test-run' });
    const key1 = memoKey(r1.tool, r1.input);
    const key2 = memoKey(r2.tool, r2.input);
    expect(memo.getAlways(key1)?.decision).toBe('allow');
    expect(memo.getThread(key2)?.decision).toBe('allow');
  });

  it('8. memoStore not injected → no-op, no throw', async () => {
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      // memoStore 不传
    });
    await expect(
      handler.requestPermissionsBatch({
        batchId: 'b8',
        requests: [buildRequest('bash', { command: 'x'  })],
      agentRunId: 'test-run',
    }),
    ).resolves.toHaveLength(1);
  });

  it('9. memoStore.putAlways throws → warned but final decision unaffected', async () => {
    const memo = new InMemoryApprovalMemoStore();
    vi.spyOn(memo, 'putAlways').mockImplementation(() => {
      throw new Error('disk full');
    });
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
      })),
    );
    const warns: string[] = [];
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
      onLog: (level, msg) => {
        if (level === 'warn') warns.push(msg);
      },
    });
    const decisions = await handler.requestPermissionsBatch({
      batchId: 'b9',
      requests: [buildRequest('bash', { command: 'x'  })],
      agentRunId: 'test-run',
    });
    expect(decisions[0].decision).toBe('allow', '即使 memo 写失败，主决策仍按用户答案返回');
    expect(warns.find((w) => w.includes('[Memo]'))).toBeTruthy();
  });

  it('10. approver_identity / rejection_message threaded into entry', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'deny',
        scope: 'always',
        rejection_message: '禁止执行 rm 类破坏性命令',
        approver_identity: { user_id: 'u-99' },
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const tool = new StubTool('bash', false, () => ({ key: 'rm -rf /' }));
    const req: PermissionRequest = {
      tool,
      input: { command: 'rm -rf /' },
      threadId: 'thread-test',
      riskLevel: 'high',
      toolCallId: 'tu-10',
    };
    await handler.requestPermissionsBatch({ batchId: 'b10', requests: [req], agentRunId: 'test-run' });
    const hit = memo.getAlways(memoKey(tool, { command: 'rm -rf /' }));
    expect(hit?.decision).toBe('deny');
    expect(hit?.approverUserId).toBe('u-99');
    expect(hit?.reason).toBe('禁止执行 rm 类破坏性命令');
  });

  // M4.1 L-W6-24：scope_description 端到端写入 memo entry
  it('11. scope_description 写入 memo entry（L-W6-24）', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const scopeDesc = '总是允许向远程仓库推送代码';
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
        scope_description: scopeDesc,
        approver_identity: { user_id: 'u-11' },
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const req = buildRequest('bash', { command: 'git push' }, {
      getApprovalKey: () => ({ key: 'git push' }),
    });
    (req as Record<string, unknown>).toolCallId = 'tu-11';
    await handler.requestPermissionsBatch({ batchId: 'b11', requests: [req], agentRunId: 'test-run' });
    const hit = memo.getAlways(memoKey(req.tool, { command: 'git push' }));
    expect(hit?.decision).toBe('allow');
    // scope_description 必须写入 entry，下次 judge 命中时才能透传给 UI
    expect(hit?.scope_description).toBe(scopeDesc);
  });

  it('12. scope_description 缺失时 entry.scope_description 为 undefined（不污染旧格式）', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
        // 不带 scope_description
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    // 使用明确 getApprovalKey，确保 key 可预测
    const req = buildRequest('bash', { command: 'echo hi' }, {
      getApprovalKey: () => ({ key: 'echo hi' }),
    });
    await handler.requestPermissionsBatch({ batchId: 'b12', requests: [req], agentRunId: 'test-run' });
    const hit = memo.getAlways(memoKey(req.tool, { command: 'echo hi' }));
    expect(hit?.decision).toBe('allow');
    // 无 scope_description 时不写入 entry
    expect(hit?.scope_description).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────
  // M4.2 L-W6-37 端到端：runtime memo putAlways key 与 judge.lookup 接通
  // ──────────────────────────────────────────────────────────────────
  //
  // 历史 bug：从 W6 v3 主路径切换以来 production 上"一直允许"按钮**从未真正工作过**。
  //
  // 根因：
  //   - putAlways 写入 key 走 `memoization-layer.buildApprovalKey(tool, input)`
  //     形态 `<ns>::<tool.name.toLowerCase()>::<stableJsonStringify(input)>`
  //   - judge → JudgeMemoStoreAdapter.lookup → lookupMemo (pattern-key.ts) 查找
  //     形态 `<tool>::<subcmd>:<scope>` （spec 附录 B 三段式）
  //   - 全 production tool 都没实装 `getApprovalKey`，fallback 100% 退化到
  //     stableJsonStringify(input)
  //   - 两套 key 空间永不相交 → memo 永远 miss → 用户点了下次还问
  //
  // dogfood 场景 15 PASS 是因为脚本**直接** `adapter.putAlways('spec-format-key', entry)`
  // 绕过了 LocalPermissionHandler.requestPermissionsBatch 的真路径——典型"测试用
  // mock 简化路径绕过 production hidden bug"，跟 M4.1 reopen P0 同种 bug 模式。
  //
  // M4.2 修法：让 LocalPermissionHandler 优先消费 wire `decisions[].pattern_key`
  // （Electron M4.1 + iOS/Android M4.2 都已上行该字段，按附录 B 算好）。
  //
  // 本测试用**真** LocalPermissionHandler + **真** InMemoryApprovalMemoStore +
  // **真** JudgeMemoStoreAdapter + **真** judge() 端到端走完整链路；测试 fail
  // 即代表修没成功 / 链路某节断 / fallback 反而被走了。
  it('13. L-W6-37 端到端：wire pattern_key → putAlways（spec 附录 B 形态）→ judge.lookup 命中 memo_allow + scope_description 透传', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const scopeDesc = '工作区内的 npm 命令（M4.2 L-W6-37 端到端验证）';
    // 客户端按 spec 附录 B 算好的 scoped key（execute_command + npm + 工作区内）
    const wirePatternKey = 'execute_command::npm:workspace-internal';

    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
        pattern_key: wirePatternKey,
        scope_description: scopeDesc,
        decision_kind: 'pattern',
        approver_identity: { user_id: 'u-m4.2-e2e' },
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });

    // 故意**不传** getApprovalKey —— 复刻 production 现状（grep 已证 12+ tool 都没实装）。
    // 这里如果代码没有切换到 wire pattern_key，会走 fallback `stableJsonStringify(input)`，
    // putAlways 写入 `::execute_command::{"command":"npm install","cwd":"..."}` 旧 key，
    // judge.lookup 算 `execute_command::npm:workspace-internal` 找不到 → 测试断言 fail。
    const tool = new StubTool('execute_command', false);
    const req: PermissionRequest = {
      tool,
      input: { command: 'npm install', cwd: '/Users/me/dev/midscene' },
      threadId: 'thread-test',
      riskLevel: 'medium',
      toolCallId: 'tu-13',
    };

    await handler.requestPermissionsBatch({ batchId: 'b13-l-w6-37', requests: [req], agentRunId: 'test-run' });

    // ── 断言 1：putAlways 用的是 wire pattern_key（spec 附录 B 形态），不是
    //              老 buildApprovalKey 生成的 stableJsonStringify key。
    const directHit = memo.getAlways(wirePatternKey);
    expect(directHit, 'putAlways 必须用 wire pattern_key 作主键').not.toBeNull();
    expect(directHit?.decision).toBe('allow');
    expect(directHit?.scope_description).toBe(scopeDesc);
    expect(directHit?.approverUserId).toBe('u-m4.2-e2e');

    // ── 断言 2：老 buildApprovalKey 形态的 key**不应该**有 entry（证明没走 fallback）。
    const oldFallbackKey = buildApprovalKey(tool, {
      command: 'npm install',
      cwd: '/Users/me/dev/midscene',
    });
    expect(oldFallbackKey).not.toBeNull();
    expect(
      memo.getAlways(oldFallbackKey!),
      'L-W6-37 修对了的话，老 fallback key 应该没人写——必须走 wire pattern_key',
    ).toBeNull();

    // ── 断言 3：把同一个 memoStore 通过 JudgeMemoStoreAdapter 包装传给 judge，
    //              用同样 toolName + subcmd + workspace 调 → 必须命中 memo_allow，
    //              且 scope_description 通过 judge.reason 透传。
    const adapter = createJudgeMemoStoreAdapter(memo);

    // 构造 JudgeTool —— 跟 tool-orchestration.ts:1285-1310 真路径完全一致
    // （extractSubcmd 走 split[0]，跟客户端 ApprovalKeyBuilder.extractShellSubcmd
    //  / Electron handleAlwaysAllow 同算法）。
    const judgeTool: JudgeTool = {
      name: 'execute_command',
      policyActionKind: 'shell',
      extractPath: (input) => {
        const inp = input as Record<string, unknown>;
        return inp.cwd as string | undefined;
      },
      extractSubcmd: (input) => {
        const inp = input as Record<string, unknown>;
        const cmd = inp.command as string | undefined;
        if (!cmd) return undefined;
        const tokens = cmd.trim().split(/\s+/);
        return tokens[0] || undefined;
      },
    };

    const policy: EffectivePolicy = {
      approvalMode: 'always_ask',
      workspace: {
        sources: {
          sandbox: '/Users/me/dev/midscene',
          tabcodeProjects: [],
          tabfolderDirs: [],
          attachedFiles: [],
        },
        // cwd 在 allowedPaths 内 → inWorkspace=true → judge 算 workspace-internal scoped key
        allowedPaths: ['/Users/me/dev/midscene'],
        allowedFiles: [],
        spaceSessionId: 'm4.2-l-w6-37-e2e',
      },
      memo: { generation: memo.generation, entries: {} },
      executionLimits: {},
      planModeGuardActive: false,
    };

    const judgeCtx: JudgeContext = {
      tool: judgeTool,
      input: { command: 'npm install', cwd: '/Users/me/dev/midscene' },
      effectivePolicy: policy,
      memoStore: adapter,
    };

    const decision = judgeV3(judgeCtx);

    expect(decision.behavior, '修对的话必须命中 memo_allow，不应回到 workspace_in').toBe('allow');
    expect(decision.reason.type).toBe('memo_allow');
    if (decision.reason.type === 'memo_allow') {
      expect(decision.reason.scope_description).toBe(scopeDesc);
      expect(decision.reason.specificity).toBe('scoped');
      expect(decision.reason.key).toBe(wirePatternKey);
    }
  });

  it('14. L-W6-37 fallback：wire 缺 pattern_key → security-policy buildMemoPatternKey（与 judge lookup 对齐）', async () => {
    const memo = new InMemoryApprovalMemoStore();
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    const tool = new StubTool('bash', false, () => ({ key: 'fallback-test-cmd' }));
    const req: PermissionRequest = {
      tool,
      input: { command: 'fallback-test-cmd' },
      threadId: 'thread-test',
      riskLevel: 'medium',
      toolCallId: 'tu-14',
      decisionReason: { type: 'workspace_out', path: '/tmp/x', kind: 'cwd' },
    };
    await handler.requestPermissionsBatch({ batchId: 'b14-l-w6-37-fallback', requests: [req], agentRunId: 'test-run' });

    const expectedKey = memoKey(tool, { command: 'fallback-test-cmd' }, req.decisionReason);
    const hit = memo.getAlways(expectedKey);
    expect(hit, '缺 pattern_key 时应写入 security-policy 形态 key').not.toBeNull();
    expect(hit?.decision).toBe('allow');

    const legacyKey = buildApprovalKey(tool, { command: 'fallback-test-cmd' });
    expect(legacyKey).not.toBeNull();
    expect(memo.getAlways(legacyKey!), 'legacy memoization-layer key 不应再写入').toBeNull();

    const spExact = buildSecurityPolicyApprovalKey(
      'bash',
      'fallback-test-cmd',
      { command: 'fallback-test-cmd' },
      false,
      { kind: 'object' },
    );
    expect(expectedKey).toBe(spExact);
  });

  it('15. L-W6-37 优先级：wire pattern_key 即使存在，tool.getApprovalKey 也被忽略（wire 优先）', async () => {
    // 边界：当 tool 自己实装了 getApprovalKey（极少见），又上行 pattern_key 时
    // 应优先用 wire pattern_key——保证 spec 附录 B 形态权威性，避免 tool 自定义 key
    // 跟 judge.lookup 计算 key 形态再次错位。
    const memo = new InMemoryApprovalMemoStore();
    const wirePatternKey = 'execute_command::ls:workspace-external';
    const harness = makeHarness((ars) =>
      ars.map((ar) => ({
        request_id: ar.request_id,
        tool_call_id: ar.tool_call_id,
        outcome: 'allow',
        scope: 'always',
        pattern_key: wirePatternKey,
      })),
    );
    const handler = makeHandler({
      emitStreamEvent: harness.emit,
      waitForUserInput: harness.waitForUserInput,
      memoStore: memo,
    });
    // tool 自定义 getApprovalKey 返回 'tool-defined-key' —— 应被忽略
    const tool = new StubTool('execute_command', false, () => ({ key: 'tool-defined-key' }));
    const req: PermissionRequest = {
      tool,
      input: { command: 'ls /tmp' },
      threadId: 'thread-test',
      riskLevel: 'low',
      toolCallId: 'tu-15',
    };
    await handler.requestPermissionsBatch({ batchId: 'b15-l-w6-37-priority', requests: [req], agentRunId: 'test-run' });

    // wire pattern_key 写入了
    expect(memo.getAlways(wirePatternKey)?.decision).toBe('allow');
    // tool 自定义 key 没被写（wire 优先）
    expect(memo.getAlways('::execute_command::tool-defined-key')).toBeNull();
  });
});

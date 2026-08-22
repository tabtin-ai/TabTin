/**
 * P1-1 修复（2026-05-27）：runJudgeFilter judge 异常 fallback 覆盖。
 *
 * **历史 bug**：`tool-orchestration.ts:1382-1407` 实施了"受限模式（ask/plan/study）
 * judge 异常 → deny；其他模式 → ask"，但 0 个测试断言这条分支。判决路径上
 * 任何静默 fallback bug 都会逃过 CI。
 *
 * 本测试 vi.mock `@tabtin/security-policy::judge` 让它抛错，然后调 runTools
 * 验证 fallback decision：
 *   - ask / plan / study → behavior='deny' + reason.type='plan_blocked' +
 *     reason.deny_code='mode_disallowed_tool'
 *   - agent / yolo / group → behavior='ask' + reason.type='fallback_ask'
 */

import { describe, it, expect, vi } from 'vitest';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import { createTestAgentModesToolGate } from './helpers/agent-modes-tool-gate.js';

// vi.mock 必须在 import runTools 之前 hoist。
vi.mock('@tabtin/security-policy', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/security-policy')>(
    '@tabtin/security-policy',
  );
  return {
    ...actual,
    // judge 强制抛错，触发 runJudgeFilter 的 catch 分支。
    judge: () => {
      throw new Error('synthetic judge failure for P1-1 fallback test');
    },
  };
});

const { runTools } = await import('../src/engine/tooling/tool-orchestration.js');
const { ToolRegistry } = await import('../src/engine/tooling/tool-system.js');
const { createInterruptAdapter } = await import('../src/permissions/interrupt-adapter.js');
import type {
  EffectivePolicy,
  MemoStore,
  WorkspaceSnapshot,
} from '@tabtin/security-policy';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
  ToolProvider,
} from '../src/engine/contracts/tools.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    sources: { sandbox: '/ws', workingDir: '/ws', sessionApprovedPaths: [], attachedFiles: [] },
    allowedPaths: ['/ws'],
    allowedFiles: [],
    spaceSessionId: 'sess-judge-throw',
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

function makeTool(name: string, isReadOnly: boolean): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly,
    execute: vi.fn(async () => ({ content: 'should not run' })),
  };
}

function makeContext(): ToolContext {
  return {
    threadId: 'thr-judge-throw',
    runtimeId: 'sess-judge-throw',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: '/ws',
  };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<{ events: StreamEvent[]; results: ToolExecutionResult[] }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, results: next.value };
}

const RESTRICTED_MODES = ['ask', 'plan', 'study'] as const;
const NON_RESTRICTED_MODES = ['agent', 'yolo', 'group'] as const;

// ─── Tests ──────────────────────────────────────────────────────────

describe('P1-1: runJudgeFilter judge throw fallback × agentMode 矩阵', () => {
  for (const mode of RESTRICTED_MODES) {
    it(`受限模式 ${mode} + judge 抛错 → fail-closed deny (mode_disallowed_tool)`, async () => {
      const writeFile = makeTool('write_file', false);
      const provider: ToolProvider = { getTools: () => [writeFile] };
      const registry = new ToolRegistry();
      registry.loadTools(provider);

      const blocks: ToolUseBlock[] = [
        { type: 'tool_use', id: 'tu-1', name: 'write_file', input: { path: '/ws/a.ts' } },
      ];

      const { events, results } = await drain(
        runTools({
          toolUseBlocks: blocks,
          registry,
          context: makeContext(),
          permissionHandler: {
            requestPermissionsBatch: vi.fn(async (req) =>
              req.requests.map((r) => ({
                toolCallId: r.toolCallId ?? r.tool.name,
                decision: 'allow' as const,
              })),
            ),
          },
          options: {
            agentMode: mode,
            sessionId: 'sess-judge-throw',
            toolGate: createTestAgentModesToolGate({ getAgentMode: () => mode }),
            toolRiskPolicy: createTestToolRiskPolicyPort({
              buildEffectivePolicy: () => makePolicy(),
              memoStore: makeMemoStore(),
            }),
            outputScan: false,
          },
        }),
      );

      // 工具不能被执行
      expect((writeFile.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

      // 结果是 deny
      expect(results).toHaveLength(1);
      expect(results[0].result.isError).toBe(true);
      expect(results[0].permissionDecision).toBe('deny');

      // 校验 SystemNotice payload 携带 mode_restricted 元数据
      const failEvents = events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'tool_failed',
      );
      expect(failEvents).toHaveLength(1);
      const payload = failEvents[0]?.payload as Record<string, unknown>;
      expect(payload.judge_behavior).toBe('deny');
      expect(payload.judge_reason).toBe('plan_blocked');
      // P0-1 metadata 透传：error_code + deny_code
      expect(payload.error_kind).toBe('mode_restricted');
      expect(payload.deny_code).toBe('mode_disallowed_tool');
      expect(payload.agent_mode).toBe(mode);
    });
  }

  for (const mode of NON_RESTRICTED_MODES) {
    it(`非受限模式 ${mode} + judge 抛错 → fallback ask（与 H2-D 历史一致）`, async () => {
      const writeFile = makeTool('write_file', false);
      const provider: ToolProvider = { getTools: () => [writeFile] };
      const registry = new ToolRegistry();
      registry.loadTools(provider);

      // permissionHandler 模拟"用户 allow"，让我们能区分 ask→allow 与
      // restricted deny 两条路径的最终 outcome。
      const permissionHandler = {
        requestPermissionsBatch: vi.fn(async (req: { requests: { tool: { name: string }; toolCallId?: string }[] }) =>
          req.requests.map((r) => ({
            toolCallId: r.toolCallId ?? r.tool.name,
            decision: 'allow' as const,
          })),
        ),
      };

      const blocks: ToolUseBlock[] = [
        { type: 'tool_use', id: 'tu-1', name: 'write_file', input: { path: '/ws/a.ts' } },
      ];

      // userInteractiveChannel: 模拟"用户在卡片上点 allow"
      const userInteractiveChannel = {
        requestApprovalsBatch: vi.fn(async (req: { requests: { toolCallId: string }[] }) => ({
          decisions: req.requests.map((r) => ({
            toolCallId: r.toolCallId,
            outcome: 'allow' as const,
          })),
        })),
      };

      await drain(
        runTools({
          toolUseBlocks: blocks,
          registry,
          context: makeContext(),
          permissionHandler,
          options: {
            agentMode: mode,
            sessionId: 'sess-judge-throw',
            toolGate: createTestAgentModesToolGate({ getAgentMode: () => mode }),
            toolRiskPolicy: createTestToolRiskPolicyPort({
              buildEffectivePolicy: () => makePolicy(),
              memoStore: makeMemoStore(),
            }),
            interrupt: createInterruptAdapter({
              threadId: 'chat-session-sess-judge-throw',
              userInteractiveChannel,
            }),
            outputScan: false,
          },
        }),
      );

      // 非受限模式 → fallback ask → user channel 被调用（fallback_ask 路径走 ask 批准流程）
      expect(userInteractiveChannel.requestApprovalsBatch).toHaveBeenCalledTimes(1);
    });
  }
});

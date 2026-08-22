/**
 * 路径权限治理 Wave 1 · tool-orchestration 透传 permissionContext 单测。
 *
 * 验证：
 *   - enforce 模式（hasJudge）下，runJudgeFilter 通过的 item 在 executeBatchParallel /
 *     executeSingleTool 拿到的 ToolContext 上带 `permissionContext.judgedDecision='allow'`。
 *   - 非 enforce 模式（缺 toolRiskPolicy）保持 context.permissionContext
 *     未注入，与 D3"不留兼容"决策一致。
 *
 * 设计取舍：用 createTestToolRiskPolicyPort + 极简 EffectivePolicy 直接搭最小 enforce 路径——
 * 不依赖 host (Electron / Daemon) 的真实装配，专注 orchestration 层透传逻辑本身。
 */

import { describe, it, expect } from 'vitest';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  EffectivePolicy,
  MemoStore,
  WorkspaceSnapshot,
} from '@tabtin/security-policy';

import { ToolRegistry } from '../src/engine/tooling/tool-system.js';
import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';
import { createMockPermissionHandler } from './test-utils.js';

// ── helpers ────────────────────────────────────────────────────────────

function makeWorkspaceSnapshot(allowedPaths: string[] = ['/ws']): WorkspaceSnapshot {
  return {
    sources: { sandbox: '/ws', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
    allowedPaths,
    allowedFiles: [],
    spaceSessionId: 'test-session',
  };
}

function makeEffectivePolicy(workspace = makeWorkspaceSnapshot()): EffectivePolicy {
  return {
    approvalMode: 'always_ask',
    workspace,
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

function makeMemoStore(): MemoStore {
  return {
    lookup: () => null,
    putAlways: async () => undefined,
    putThread: () => undefined,
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: '/ws',
    ...overrides,
  };
}

function makeBlock(name: string, id: string, input: unknown = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
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

// 一个 readonly file 工具，把收到的 ToolContext 镜像写到 result 里供断言。
function makeContextProbeTool(): Tool {
  return {
    name: 'probe_context',
    description: 'reflect ctx.permissionContext + ctx.workspaceSnapshot to result',
    isReadOnly: true,
    policyActionKind: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    extractPolicyParams: (input: unknown) => {
      const inp = input as Record<string, unknown>;
      return { file_path: inp.path };
    },
    async execute(_input: unknown, ctx: ToolContext) {
      return {
        content: JSON.stringify({
          judged: ctx.permissionContext?.judgedDecision === 'allow',
          allowedPaths: ctx.workspaceSnapshot?.allowedPaths ?? null,
        }),
      };
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────

describe('Wave 1 · tool-orchestration 透传 permissionContext.judgedDecision', () => {
  it('enforce 模式（hasJudge）下，judge 通过的 item 拿到 judgedDecision="allow"', async () => {
    const tool = makeContextProbeTool();
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    // 工作区内路径——judge step 4 file/workspace_in 直接 allow
    const policy = makeEffectivePolicy(makeWorkspaceSnapshot(['/ws']));
    const memoStore = makeMemoStore();

    // ToolContext 也带 workspaceSnapshot（query.ts 在两个构造点填的字段）
    const ctx = makeContext({ workspaceSnapshot: policy.workspace });

    const { results } = await drain(
      runTools({
        toolUseBlocks: [makeBlock('probe_context', '1', { path: '/ws/file.txt' })],
        registry,
        context: ctx,
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].result.isError).toBeUndefined();
    const reflected = JSON.parse(results[0].result.content as string);
    expect(reflected.judged).toBe(true);
    expect(reflected.allowedPaths).toEqual(['/ws']);
  });

  it('非 enforce 模式（缺 toolRiskPolicy）—— ctx.permissionContext 不被透传', async () => {
    const tool = makeContextProbeTool();
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    // 故意不传 toolRiskPolicy —— 走 legacy permissionHandler 路径
    const ctx = makeContext({ workspaceSnapshot: makeWorkspaceSnapshot() });

    const { results } = await drain(
      runTools({
        toolUseBlocks: [makeBlock('probe_context', '1', { path: '/ws/file.txt' })],
        registry,
        context: ctx,
        permissionHandler: createMockPermissionHandler(),
        // 不传 toolRiskPolicy
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].result.isError).toBeUndefined();
    const reflected = JSON.parse(results[0].result.content as string);
    // legacy 路径下 permissionContext 不被注入（D3 不留兼容：只有 enforce 才标）
    expect(reflected.judged).toBe(false);
    // workspaceSnapshot 仍透过 ToolContext 直接传到工具——它跟 enforce 状态独立
    expect(reflected.allowedPaths).toEqual(['/ws']);
  });

  it('enforce 模式 + 工作区外路径 + 没装 channel → deny，工具不执行', async () => {
    let executed = false;
    const probe: Tool = {
      ...makeContextProbeTool(),
      async execute() {
        executed = true;
        return { content: '{}' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [probe] });

    const policy = makeEffectivePolicy(makeWorkspaceSnapshot(['/ws']));
    const memoStore = makeMemoStore();

    const { results } = await drain(
      runTools({
        // /outside-ws 不在 allowedPaths 里 → judge 给 'ask'，但没装 userInteractiveChannel → fail-closed deny
        toolUseBlocks: [makeBlock('probe_context', '1', { path: '/outside-ws/file.txt' })],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
          // 不装 userInteractiveChannel
        },
      }),
    );

    expect(executed).toBe(false);
    expect(results[0].result.isError).toBe(true);
  });
});

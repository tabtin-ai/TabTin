/**
 * 路径权限治理 Wave 1 · query.ts 装配点 + forkQuery 子 Agent 透传 集成测试。
 *
 * 关注点：
 *   1. query.ts 入口处从 `EngineConfig.toolRiskPolicy.resolveSnapshot()?.workspace` 派生
 *      `ToolContext.workspaceSnapshot`——保证 host IPC mutate 后的 snapshot
 *      能在下一轮被工具看到（allowedPaths 同引用 SSoT）。
 *   2. forkQuery 透传 `toolRiskPolicy` 给子 EngineConfig——子 runtime 自己
 *      派生子 ToolContext.workspaceSnapshot 时拿到与父同源的 workspace。
 *
 * 这两条是 P2 补测试要求的"装配点回归保护"。
 */

import { describe, it, expect, vi } from 'vitest';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  EffectivePolicy,
  MemoStore,
  WorkspaceSnapshot,
} from '@tabtin/security-policy';

import { createRuntime } from '../src/runtime-assembly.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMResponseChunk,
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import type { WorkspaceBoundary } from '../src/engine/contracts/tool-risk-policy.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';

// ── helpers ──────────────────────────────────────────────────────────

function makeWorkspaceSnapshot(allowedPaths: string[] = ['/ws']): WorkspaceSnapshot {
  return {
    sources: { sandbox: '/ws', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
    allowedPaths,
    allowedFiles: [],
    spaceSessionId: 'test-session',
  };
}

function makeEffectivePolicy(workspace: WorkspaceSnapshot): EffectivePolicy {
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

/** 单轮 LLM：先 yield 一个 tool_use 调 probe_workspace，再读 tool_result 后 yield 一个 final text。 */
function makeProbeProvider(probeToolCallId: string): LLMProvider {
  let call = 0;
  return {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      if (call === 0) {
        call++;
        // Round 1：调 probe_workspace
        yield {
          type: 'tool_use',
          toolUse: { id: probeToolCallId, name: 'probe_workspace', input: {} },
        };
        yield { type: 'stop', stopReason: 'tool_use' };
        return;
      }
      // Round 2：拿到 tool result 后给 final answer
      yield { type: 'text_delta', text: 'probe finished' };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
  };
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ── tests ────────────────────────────────────────────────────────────

describe('Wave 1 · P2 query.ts 装配点：toolRiskPolicy.resolveSnapshot()?.workspace → ToolContext.workspaceSnapshot', () => {
  it('工具的 ctx.workspaceSnapshot.allowedPaths 与 resolveSnapshot 同源', async () => {
    // 把 host snapshot 做成 mutable —— 模拟 ElectronAgentHost 的 workspaceSnapshotV3
    // 闭包：IPC `workspace:paths-changed` 会就地 mutate allowedPaths。
    const hostSnapshot = makeWorkspaceSnapshot(['/ws/proj-A']);
    const hostPolicy = makeEffectivePolicy(hostSnapshot);
    const toolRiskPolicy = createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => hostPolicy,
      memoStore: makeMemoStore(),
    });

    let capturedSnapshot: WorkspaceBoundary | undefined;
    let capturedAllowedPathsRef: readonly string[] | undefined;

    const probeTool: Tool = {
      name: 'probe_workspace',
      description: 'capture ctx.workspaceSnapshot for assertion',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      policyActionKind: 'object_read',
      async execute(_input: unknown, ctx: ToolContext) {
        capturedSnapshot = ctx.workspaceSnapshot;
        capturedAllowedPathsRef = ctx.workspaceSnapshot?.allowedPaths;
        return { content: '{"ok": true}' };
      },
    };

    const toolCallId = 'probe-1';
    const config: EngineConfig = {
      provider: makeProbeProvider(toolCallId),
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
      model: 'test-model',
      workspaceRoot: '/ws',
      toolRiskPolicy,
    };

    const rt = createRuntime(config);
    await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'probe workspace' }));

    // 工具看到 workspaceSnapshot ✓
    expect(capturedSnapshot).toBeDefined();
    expect(capturedSnapshot?.allowedPaths).toEqual(['/ws/proj-A']);

    // 同引用 SSoT：工具拿到的 allowedPaths 与 host 闭包里的是同一对象
    expect(capturedAllowedPathsRef).toBe(hostSnapshot.allowedPaths);
    expect(capturedSnapshot?.allowedPaths).toBe(
      toolRiskPolicy.resolveSnapshot()?.workspace?.allowedPaths,
    );
  });

  it('host 在轮间 mutate allowedPaths → 下一轮工具看到新值（同引用语义）', async () => {
    // 模拟用户在第一轮和第二轮之间打开了新项目 / 关了原有项目。
    // hostPolicy 是单一引用，allowedPaths 数组通过 IPC handler 重新赋值。
    const hostSnapshot = makeWorkspaceSnapshot(['/ws/proj-A']);
    const hostPolicy = makeEffectivePolicy(hostSnapshot);

    const captures: Array<readonly string[] | undefined> = [];
    let callCount = 0;

    const probeTool: Tool = {
      name: 'probe_workspace',
      description: 'capture each turn',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      policyActionKind: 'object_read',
      async execute(_input: unknown, ctx: ToolContext) {
        captures.push(ctx.workspaceSnapshot?.allowedPaths);
        callCount++;
        // 第一次调用结束后模拟 host IPC mutate：用户打开了 proj-B
        if (callCount === 1) {
          hostSnapshot.allowedPaths = ['/ws/proj-A', '/ws/proj-B'];
        }
        return { content: '{"ok": true}' };
      },
    };

    // 让 LLM 连续调两次 probe_workspace，覆盖"轮间 mutate"语义
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        if (callCount === 0) {
          yield { type: 'tool_use', toolUse: { id: 'probe-1', name: 'probe_workspace', input: {} } };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else if (callCount === 1) {
          yield { type: 'tool_use', toolUse: { id: 'probe-2', name: 'probe_workspace', input: {} } };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
    };

    const config: EngineConfig = {
      provider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session-2' },
      model: 'test-model',
      workspaceRoot: '/ws',
      toolRiskPolicy: createTestToolRiskPolicyPort({
        buildEffectivePolicy: () => hostPolicy,
        memoStore: makeMemoStore(),
      }),
    };

    const rt = createRuntime(config);
    await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'probe twice' }));

    expect(captures.length).toBeGreaterThanOrEqual(2);
    // 第一轮看到原 allowedPaths
    expect(captures[0]).toEqual(['/ws/proj-A']);
    // 第二轮看到 mutate 后的新值——这是 host IPC 实时 mutate 立即生效的核心契约
    expect(captures[1]).toEqual(['/ws/proj-A', '/ws/proj-B']);
  });
});

describe('Wave 1 · P2 forkQuery：父子共享 toolRiskPolicy → 子 ToolContext.workspaceSnapshot 同源', () => {
  it('forkQuery 透传 toolRiskPolicy 到子 EngineConfig', async () => {
    // 这条用 mock 模式：捕获 forkQuery 创建子 runtime 时传给 createRuntime 的 EngineConfig。
    let capturedChildConfig: EngineConfig | undefined;
    vi.resetModules();
    vi.doMock('../src/runtime-assembly.js', () => ({
  createDefaultQueryDeps: vi.fn(),
      createRuntime: (config: EngineConfig) => {
        capturedChildConfig = config;
        return {
          async *query() {
            yield { type: 'agent.stream.done', payload: { content: 'done' } };
          },
        };
      },
    }));
    vi.doMock('../src/session/storage.js', () => ({
      SessionStorage: vi.fn().mockImplementation(() => ({
        recordAssistantMessage: vi.fn(),
        dispose: vi.fn(),
      })),
    }));

    const { forkQuery: forkQueryMocked } = await import('../src/subagent/fork-query.js');

    const parentSnapshot = makeWorkspaceSnapshot(['/ws/proj-A']);
    const parentPolicy = makeEffectivePolicy(parentSnapshot);
    // 让父子用同一个 port —— 父 mutate 后子读到的是同一引用。
    const parentToolRiskPolicy = createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => parentPolicy,
      memoStore: makeMemoStore(),
    });

    const gen = forkQueryMocked({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: { async *createStream() { /* not used in mock */ } } as LLMProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedChildConfig).toBeDefined();
    // 默认 fork（非 readonly）直接继承父 port 引用
    expect(capturedChildConfig!.toolRiskPolicy).toBe(parentToolRiskPolicy);
    // 子 runtime 调一次确认能拿到父同源的 workspace（allowedPaths 同引用）
    const childWorkspace = capturedChildConfig!.toolRiskPolicy?.resolveSnapshot()?.workspace;
    expect(childWorkspace?.allowedPaths).toBe(parentSnapshot.allowedPaths);
    expect(childWorkspace?.allowedPaths).toEqual(['/ws/proj-A']);

    vi.doUnmock('../src/runtime-assembly.js');
    vi.doUnmock('../src/session/storage.js');
  });
});

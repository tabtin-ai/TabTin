/**
 * 路径权限治理 Wave 4 (L5)：tool-orchestration 默认 extractPath 多路径覆盖。
 *
 * 钉死契约（与 `judge-multi-path.test.ts` 对偶）：
 *   - 工具未声明 extractPolicyParams 时，默认 extractPath 也能从
 *     `target_directory` / `target_directories[]` / `paths[]` 拿出路径
 *   - 多路径全部 in workspace → judge 放行 → 工具执行
 *   - 多路径任一在 workspace 外 + 无审批 channel → judge ask → fail-closed deny
 *   - 单路径优先级仍最高（file_path / path / cwd 命中后不读 search 字段）
 */
import { describe, expect, it } from 'vitest';
import type { EffectivePolicy, MemoStore, WorkspaceSnapshot } from '@tabtin/security-policy';
import { ToolRegistry } from '../src/engine/tooling/tool-system.js';
import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
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

function makeWs(allowed: string[]): WorkspaceSnapshot {
  return {
    sources: { sandbox: '/ws', tabcodeProjects: [], tabfolderDirs: [], attachedFiles: [] },
    allowedPaths: allowed,
    allowedFiles: [],
    spaceSessionId: 'sess',
  };
}

function makePolicy(allowed: string[]): EffectivePolicy {
  return {
    approvalMode: 'always_ask',
    workspace: makeWs(allowed),
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
    threadId: 'tid',
    runtimeId: 'sid',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: '/ws',
    agentRunId: 'run-w4-extractpath',
    ...overrides,
  };
}

function makeBlock(name: string, id: string, input: unknown = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<{ results: ToolExecutionResult[] }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { results: next.value };
}

// 一个 readonly file 工具，**故意不声明** extractPolicyParams，让 judge
// 走默认 extractPath（这正是 L5 要修的路径）。
function makeSearchToolNoExtractPolicyParams(name: string): Tool {
  return {
    name,
    description: 'search-like tool without extractPolicyParams',
    isReadOnly: true,
    policyActionKind: 'file',
    inputSchema: { type: 'object', additionalProperties: true },
    async execute(_input: unknown, _ctx: ToolContext) {
      return { content: '{}' };
    },
  };
}

describe('Wave 4 (L5) · 默认 extractPath 多路径覆盖', () => {
  it('多路径只读工具的 target_directories 全部 in workspace → 工具执行', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('multi_path_search'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/proj/a']);
    const memoStore = makeMemoStore();
    const { results } = await drain(
      runTools({
        toolUseBlocks: [
          makeBlock('multi_path_search', '1', {
            target_directories: ['/proj/a/auth', '/proj/a/perm'],
          }),
        ],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(true);
    expect(results[0].result.isError).toBeUndefined();
  });

  it('target_directories 任一在 workspace 外 + 无审批 channel → fail-closed deny', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('multi_path_search'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/proj/a']);
    const memoStore = makeMemoStore();
    const { results } = await drain(
      runTools({
        toolUseBlocks: [
          makeBlock('multi_path_search', '1', {
            target_directories: ['/proj/a/auth', '/proj/b/perm'],
          }),
        ],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(false);
    expect(results[0].result.isError).toBe(true);
  });

  it('read_lints.paths[] 全部 in workspace → 工具执行', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('read_lints'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/proj/a']);
    const memoStore = makeMemoStore();
    await drain(
      runTools({
        toolUseBlocks: [
          makeBlock('read_lints', '1', { paths: ['/proj/a/x.ts', '/proj/a/y.ts'] }),
        ],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(true);
  });

  it('glob_search.target_directory 单值仍可识别（fallback 单路径行为）', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('glob_search'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/proj/a']);
    const memoStore = makeMemoStore();
    await drain(
      runTools({
        toolUseBlocks: [
          makeBlock('glob_search', '1', { target_directory: '/proj/a/src' }),
        ],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(true);
  });

  it('file_path / path / cwd 单值字段优先级最高（即使同时传 target_directories）', async () => {
    // 传 path=ws_in 单值 + target_directories 含 ws_out
    // 默认 extractPath 应取 path 单值，整体 ws_in，工具执行
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('weird_tool'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/proj/a']);
    const memoStore = makeMemoStore();
    await drain(
      runTools({
        toolUseBlocks: [
          makeBlock('weird_tool', '1', {
            path: '/proj/a/file.ts',
            target_directories: ['/proj/a', '/proj/b'], // 含 ws_out 但不应被读
          }),
        ],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(true);
  });

  it('glob_search 仅 glob_pattern 时按 workspaceRoot 判区内并执行', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('glob_search'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/ws']);
    const memoStore = makeMemoStore();
    await drain(
      runTools({
        toolUseBlocks: [makeBlock('glob_search', '1', { glob_pattern: '*' })],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(true);
  });

  it('相对 path 按 workspaceRoot 判区内', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('read_file'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/ws']);
    const memoStore = makeMemoStore();
    await drain(
      runTools({
        toolUseBlocks: [makeBlock('read_file', '1', { path: 'src/foo.ts' })],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(true);
  });

  it('显式区外绝对路径仍 fail-closed deny', async () => {
    let executed = false;
    const tool = {
      ...makeSearchToolNoExtractPolicyParams('read_file'),
      async execute() {
        executed = true;
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });
    const policy = makePolicy(['/ws']);
    const memoStore = makeMemoStore();
    const { results } = await drain(
      runTools({
        toolUseBlocks: [makeBlock('read_file', '1', { path: '/tmp/outside.txt' })],
        registry,
        context: makeContext({ workspaceSnapshot: policy.workspace }),
        permissionHandler: createMockPermissionHandler(),
        options: {
          toolRiskPolicy: createTestToolRiskPolicyPort({
            buildEffectivePolicy: () => policy,
            memoStore: memoStore,
          }),
        },
      }),
    );
    expect(executed).toBe(false);
    expect(results[0].result.isError).toBe(true);
  });
});

/**
 * YOLO 两步授权 PRD v3 §5.5.3 / DR-9 (2026-05-26 重修订)：
 *
 * **新策略**：默认子 Agent 继承父 toolRiskPolicy（包括 auto/yolo）。父 Agent 在 fork
 * 时可显式传 `readonly: true`（→ `forkQuery({ readonlySubagent: true })`）
 * 接 ask 模式（runtime 硬拦 + prompt），但不降级父级文件目录授权。
 *
 * 重修订理由：旧策略「统一强制 effectiveMode='agent'」导致父 yolo + 子调同一
 * 工具撞 workspace_out deny 的「权限断崖」（dogfood session 314d7f23 实证），
 * 子 Agent LLM 拿到裸 "permission denied" 后还会脑补错误原因（"fork 任务环
 * 境没有配置用户交互通道"）误导父。
 *
 * 防越权安全意图（DR-9）由 hardline 兜底——judge step 1 的 hardline_command /
 * hardline path / sensitive_out_deny 对子 Agent 仍是 fail-closed deny，跟父
 * mode 无关。
 *
 * 本测覆盖：
 *   - 父 auto + 默认 fork → 子继承同一 toolRiskPolicy
 *   - 父 auto + `readonlySubagent: true` → 子 forReadonlyChild + agentMode ask，
 *     但 approvalMode 仍继承父级授权
 *   - 父 always_ask → 子也 always_ask（无影响）
 *   - 透传 workspace（resolveSnapshot）
 *   - 父 toolRiskPolicy undefined 兼容性
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import type { ToolRiskPolicyPort } from '../src/engine/contracts/tool-risk-policy.js';
import type { EffectivePolicy, MemoStore, WorkspaceSnapshot } from '@tabtin/security-policy';
import { createMockProvider, createMockPermissionHandler, createMockToolProvider } from './test-utils.js';

let capturedConfig: EngineConfig | undefined;

vi.mock('../src/runtime-assembly.js', () => ({
  createDefaultQueryDeps: vi.fn(),
  createRuntime: (config: EngineConfig) => {
    capturedConfig = config;
    return {
      async *query() {
        yield { type: 'agent.stream.done', payload: { content: 'done' } };
      },
    };
  },
}));

vi.mock('../src/session/storage.js', () => ({
  SessionStorage: vi.fn().mockImplementation(() => ({
    recordAssistantMessage: vi.fn(),
    ensureBlockBackfillFromTranscript: vi.fn(async () => {}),
    restoreMessages: vi.fn(async () => []),
    dispose: vi.fn(),
  })),
}));

// 阶段 8 可观测性接入后 fork-query 会构造 Snapshot/Event/SubagentIndex 三件套；
// 本测专注 YOLO inherit/opt-in 策略，与可观测性无关——全部 mock 成 no-op，
// 避免真实落盘。
vi.mock('../src/session/snapshot-storage.js', () => ({
  SnapshotStorage: vi.fn().mockImplementation(() => ({
    filePath: '/tmp/mocked-snapshots.jsonl',
    append: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../src/session/event-storage.js', () => ({
  EventStorage: vi.fn().mockImplementation(() => ({
    filePath: '/tmp/mocked-events.jsonl',
    append: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../src/session/subagent-index.js', () => ({
  SubagentIndexWriter: vi.fn().mockImplementation(() => ({
    recordStart: vi.fn().mockResolvedValue(undefined),
    recordEnd: vi.fn().mockResolvedValue(undefined),
    getFilePath: vi.fn().mockReturnValue('/tmp/mocked-subagents.jsonl'),
  })),
}));

const { forkQuery } = await import('../src/subagent/fork-query.js');

function makeWorkspace(): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/tmp/sandbox',
      workingDir: '',
      sessionApprovedPaths: [],
      attachedFiles: [],
    },
    allowedPaths: ['/tmp/sandbox'],
    allowedFiles: [],
    spaceSessionId: 'sess-test',
  };
}

function makeMemoStore(): MemoStore {
  return {
    lookup: () => null,
    putAlways: async () => undefined,
    putThread: () => undefined,
  };
}

function makeParentPolicy(approvalMode: 'always_ask' | 'auto' | 'full_access'): EffectivePolicy {
  return {
    approvalMode,
    workspace: makeWorkspace(),
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

function makeParentPort(approvalMode: 'always_ask' | 'auto' | 'full_access'): ToolRiskPolicyPort {
  return createTestToolRiskPolicyPort({
    buildEffectivePolicy: () => makeParentPolicy(approvalMode),
    memoStore: makeMemoStore(),
  });
}

/** object_write 在 always_ask → ask；auto/full_access → 对应档直接放行。 */
function expectApprovalMode(port: ToolRiskPolicyPort, mode: 'auto' | 'always_ask' | 'full_access'): void {
  const decision = port.judge({
    tool: {
      name: 'tabdoc_write',
      policyActionKind: 'object_write',
      planTargetWriteGuarded: false,
    },
    input: {},
  });
  if (mode === 'auto') {
    expect(decision.behavior).toBe('allow');
    expect(decision.reason.type).toBe('auto_allow');
  } else if (mode === 'full_access') {
    expect(decision.behavior).toBe('allow');
    expect(decision.reason.type).toBe('full_access_allow');
  } else {
    expect(decision.behavior).toBe('ask');
    expect(decision.reason.type).toBe('object_write_ask');
  }
}

describe('forkQuery toolRiskPolicy wrapping (YOLO PRD v3 §5.5.3 重修订)', () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  it('默认行为：父 auto → 子继承同一 toolRiskPolicy（继承父策略）', async () => {
    const parentToolRiskPolicy = makeParentPort('auto');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      // readonlySubagent 缺省 → 继承
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.toolRiskPolicy).toBe(parentToolRiskPolicy);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'auto');
  });

  it('#9313 父 full_access → 普通子代理继承全部允许', async () => {
    const parentToolRiskPolicy = makeParentPort('full_access');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.toolRiskPolicy).toBe(parentToolRiskPolicy);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'full_access');
  });

  it('opt-in 收紧：父 auto + readonlySubagent=true → 子 forReadonlyChild + agentMode ask，目录授权不降档', async () => {
    const parentToolRiskPolicy = makeParentPort('auto');
    const forReadonlyChildSpy = vi.spyOn(parentToolRiskPolicy, 'forReadonlyChild');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      readonlySubagent: true,
    });

    for await (const _ of gen) { /* drain */ }

    expect(forReadonlyChildSpy).toHaveBeenCalledTimes(1);
    expect(capturedConfig!.toolRiskPolicy).toBe(forReadonlyChildSpy.mock.results[0].value);
    expect(capturedConfig!.toolRiskPolicy).not.toBe(parentToolRiskPolicy);
    // 关键：readonly 只切 agentMode，不剥离父级文件目录授权档。
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'auto');
    expect(capturedConfig!.agentMode).toBe('ask');
  });

  it('#11107 父 full_access + readonlySubagent=true → 子保留全部允许的目录授权 + agentMode ask', async () => {
    const parentToolRiskPolicy = makeParentPort('full_access');
    const forReadonlyChildSpy = vi.spyOn(parentToolRiskPolicy, 'forReadonlyChild');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      readonlySubagent: true,
    });

    for await (const _ of gen) { /* drain */ }

    expect(forReadonlyChildSpy).toHaveBeenCalledTimes(1);
    expect(capturedConfig!.toolRiskPolicy).toBe(forReadonlyChildSpy.mock.results[0].value);
    expect(capturedConfig!.toolRiskPolicy).not.toBe(parentToolRiskPolicy);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'full_access');
    expect(capturedConfig!.agentMode).toBe('ask');
  });

  it('父 always_ask + 默认 → 子也 always_ask（无 approvalMode 变化）', async () => {
    const parentToolRiskPolicy = makeParentPort('always_ask');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.toolRiskPolicy).toBe(parentToolRiskPolicy);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'always_ask');
  });

  it('父 always_ask + readonlySubagent=true → 子仍 always_ask + agentMode ask', async () => {
    const parentToolRiskPolicy = makeParentPort('always_ask');
    const forReadonlyChildSpy = vi.spyOn(parentToolRiskPolicy, 'forReadonlyChild');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      readonlySubagent: true,
    });

    for await (const _ of gen) { /* drain */ }

    expect(forReadonlyChildSpy).toHaveBeenCalledTimes(1);
    expect(capturedConfig!.toolRiskPolicy).toBe(forReadonlyChildSpy.mock.results[0].value);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'always_ask');
    expect(capturedConfig!.agentMode).toBe('ask');
  });

  it('透传 workspace（不论 readonly opt-in 与否）', async () => {
    const parentWorkspace = makeWorkspace();
    parentWorkspace.allowedPaths = ['/tmp/sandbox', '/tmp/extra-allowed'];
    const parentPolicy: EffectivePolicy = {
      approvalMode: 'auto',
      workspace: parentWorkspace,
      memo: { generation: 42, entries: {} },
      executionLimits: { max_iterations_per_run: 100 },
      planModeGuardActive: false,
    };
    const parentToolRiskPolicy = createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => parentPolicy,
      memoStore: makeMemoStore(),
    });
    const forReadonlyChildSpy = vi.spyOn(parentToolRiskPolicy, 'forReadonlyChild');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      // readonly opt-in 收紧 mode，但 workspace 仍透传
      readonlySubagent: true,
    });

    for await (const _ of gen) { /* drain */ }

    expect(forReadonlyChildSpy).toHaveBeenCalledTimes(1);
    const childPort = capturedConfig!.toolRiskPolicy!;
    expect(childPort).toBe(forReadonlyChildSpy.mock.results[0].value);
    // readonly opt-in → 保留父级授权档；只读约束由 agentMode ask 与工具集承担。
    expectApprovalMode(childPort, 'auto');
    expect(capturedConfig!.agentMode).toBe('ask');
    // workspace 经 resolveSnapshot 透传（allowedPaths 同引用）
    const childWorkspace = childPort.resolveSnapshot()?.workspace;
    expect(childWorkspace?.allowedPaths).toBe(parentWorkspace.allowedPaths);
    expect(childWorkspace?.allowedPaths).toEqual(['/tmp/sandbox', '/tmp/extra-allowed']);
  });

  it('父 toolRiskPolicy=undefined → 子也 undefined（与 hasJudge=false 测试场景兼容）', async () => {
    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: undefined,
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.toolRiskPolicy).toBeUndefined();
  });

  it('父 port resolveSnapshot=undefined → 子 port 仍接线但 snapshot 为空（防御性兜底）', async () => {
    const parentToolRiskPolicy = createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: makeMemoStore(),
    });

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'test',
      systemPrompt: '',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      readonlySubagent: true, // 父 snapshot undefined → 子 forReadonlyChild 后仍 undefined
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.toolRiskPolicy).toBeDefined();
    expect(capturedConfig!.toolRiskPolicy).not.toBe(parentToolRiskPolicy);
    expect(capturedConfig!.toolRiskPolicy!.resolveSnapshot()).toBeUndefined();
  });
});

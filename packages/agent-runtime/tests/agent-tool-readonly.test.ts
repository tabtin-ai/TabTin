/**
 * readonly sub-agent → true Ask mode (agentMode + prompt fallback + tools).
 *
 * 含 buildSystemPrompt 的重烘焙用例已迁宿主 prompt 测试
 * （packages/.../tests/subagent-system-prompt.test.ts， Stage 2b）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import type { ToolRiskPolicyPort } from '../src/engine/contracts/tool-risk-policy.js';
import type { EffectivePolicy, MemoStore } from '@tabtin/security-policy';
import { evaluateAgentModeToolAccess } from '@tabtin/agent-modes';
import {
  resolveSubagentSystemPromptStringFallback,
  wrapToolProviderForAskMode,
} from '../src/subagent/subagent-readonly.js';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';

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
    //  起 prepareForkRuntime 会调用（mock 缺失曾导致本套件 3 用例误红）
    ensureBlockBackfillFromTranscript: vi.fn(async () => {}),
    restoreMessages: vi.fn(async () => []),
    dispose: vi.fn(),
  })),
}));

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

function makeMemoStore(): MemoStore {
  return {
    lookup: () => null,
    putAlways: async () => undefined,
    putThread: () => undefined,
  };
}

function makeParentPolicy(approvalMode: EffectivePolicy['approvalMode']): EffectivePolicy {
  return {
    approvalMode,
    workspace: {
      sources: {
        sandbox: '/tmp/sandbox',
        workingDir: '',
        sessionApprovedPaths: [],
        attachedFiles: [],
      },
      allowedPaths: ['/tmp/sandbox'],
      allowedFiles: [],
      spaceSessionId: 'sess-test',
    },
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

function makeParentPort(approvalMode: EffectivePolicy['approvalMode']): ToolRiskPolicyPort {
  return createTestToolRiskPolicyPort({
    buildEffectivePolicy: () => makeParentPolicy(approvalMode),
    memoStore: makeMemoStore(),
  });
}

/** object_write 在 always_ask → ask；auto → auto_allow。 */
function expectApprovalMode(port: ToolRiskPolicyPort, mode: 'auto' | 'always_ask'): void {
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
  } else {
    expect(decision.behavior).toBe('ask');
    expect(decision.reason.type).toBe('object_write_ask');
  }
}

describe('forkQuery readonlySubagent → ask mode', () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  it('readonlySubagent=true → child forReadonlyChild（保留父级授权）+ agentMode ask', async () => {
    const parentToolRiskPolicy = makeParentPort('auto');
    const forReadonlyChildSpy = vi.spyOn(parentToolRiskPolicy, 'forReadonlyChild');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: 'research only',
      systemPrompt: 'parent prompt',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      readonlySubagent: true,
      agentMode: 'agent',
    });

    for await (const _ of gen) { /* drain */ }

    expect(forReadonlyChildSpy).toHaveBeenCalledTimes(1);
    expect(capturedConfig!.toolRiskPolicy).toBe(forReadonlyChildSpy.mock.results[0].value);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'auto');
    expect(capturedConfig!.agentMode).toBe('ask');
  });

  it('readonlySubagent 缺省 → 继承父 toolRiskPolicy（auto）', async () => {
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
      agentMode: 'agent',
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.toolRiskPolicy).toBe(parentToolRiskPolicy);
    expectApprovalMode(capturedConfig!.toolRiskPolicy!, 'auto');
    expect(capturedConfig!.agentMode).toBe('agent');
  });

  it('父为 group 模式：普通子 Agent 不继承 group，强制 agent（不把自己当主代理）', async () => {
    const parentToolRiskPolicy = makeParentPort('always_ask');

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: '报数：1',
      systemPrompt: 'parent group prompt',
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'test',
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      toolRiskPolicy: parentToolRiskPolicy,
      agentMode: 'group',
    });

    for await (const _ of gen) { /* drain */ }

    expect(capturedConfig!.agentMode).toBe('agent');
  });
});

describe('resolveSubagentSystemPromptStringFallback', () => {
  it('剥掉 catalog / orchestration；不改写 agent_mode（产品文案由宿主 provider 负责）', () => {
    const parent = [
      'prefix',
      '<agent_mode>group stuff</agent_mode>',
      '<subagent_catalog>报数员</subagent_catalog>',
      '<subagent_orchestration>orch</subagent_orchestration>',
    ].join('\n');
    const child = resolveSubagentSystemPromptStringFallback(parent, 'ask');
    expect(child).toContain('prefix');
    expect(child).toContain('<agent_mode>group stuff</agent_mode>');
    expect(child).not.toContain('<subagent_catalog>');
    expect(child).not.toContain('<subagent_orchestration>');
  });
});

describe('wrapToolProviderForAskMode', () => {
  it('无 annotate 时原样返回', () => {
    const base = createMockToolProvider([
      { name: 'write_file', description: 'Write', isReadOnly: false },
    ]);
    expect(wrapToolProviderForAskMode(base)).toBe(base);
  });

  it('经 annotate 回调标注写工具', () => {
    const base = createMockToolProvider([
      { name: 'read_file', description: 'Read', isReadOnly: true },
      { name: 'write_file', description: 'Write', isReadOnly: false },
    ]);
    const wrapped = wrapToolProviderForAskMode(base, (tools) =>
      tools.map((t) =>
        t.isReadOnly === false
          ? { ...t, description: `${t.description} [Ask mode]` }
          : t,
      ),
    );
    const tools = wrapped.getTools();
    expect(tools.find((t) => t.name === 'write_file')!.description).toContain('[Ask mode]');
  });
});

describe('Ask mode agent tool (D12.1)', () => {
  const agentTool = { name: 'agent', isReadOnly: false };

  it('ask mode + agent(readonly: true) → allow', () => {
    const r = evaluateAgentModeToolAccess({
      tool: agentTool,
      toolInput: { readonly: true, prompt: 'research' },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(true);
  });

  it('ask mode + agent(readonly: false) → deny mode_disallowed_tool', () => {
    const r = evaluateAgentModeToolAccess({
      tool: agentTool,
      toolInput: { readonly: false, prompt: 'test' },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.deny_code).toBe('mode_disallowed_tool');
      expect(r.error.details?.requires_readonly_subagent).toBe(true);
    }
  });

  it('ask mode + agent() 缺省 → deny', () => {
    const r = evaluateAgentModeToolAccess({
      tool: agentTool,
      toolInput: { prompt: 'test' },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.deny_code).toBe('mode_disallowed_tool');
    }
  });

  it('agent mode + agent(readonly: false) → allow（不受 D12.1 约束）', () => {
    const r = evaluateAgentModeToolAccess({
      tool: agentTool,
      toolInput: { readonly: false, prompt: 'test' },
      agentMode: 'agent',
    });
    expect(r.allowed).toBe(true);
  });
});

describe('agent tool schema', () => {
  it('documents tool_domains tri-state and does not expose report_budget', () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp', threadId: 's' },
      model: 'test',
    });
    const schemaText = JSON.stringify(tool.inputSchema);

    expect(schemaText).toContain('缺省（未传）时子 Agent 继承父 Agent 所有工具');
    expect(schemaText).toContain('传空数组表示不给子 Agent 任何工具');
    expect(schemaText).toContain('不要用收窄工具面代替 readonly');
    expect(schemaText).not.toContain('report_budget');
  });
});

describe('ask mode guard (readonly sub-agent runtime defense)', () => {
  it('write_file denied with mode_disallowed_tool', () => {
    const r = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: { path: 'a.ts' },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.error_kind).toBe('mode_restricted');
      expect(r.error.deny_code).toBe('mode_disallowed_tool');
    }
  });

  it('delete_file denied in ask mode', () => {
    const r = evaluateAgentModeToolAccess({
      tool: { name: 'delete_file', isReadOnly: false },
      toolInput: { path: 'a.ts' },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(false);
  });
});

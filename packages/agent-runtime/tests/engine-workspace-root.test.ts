/**
 * FR-13: workspaceRoot 双通路桥接
 *
 * 验证 `EngineConfig.workspaceRoot` 正确流到每个 `ToolContext.workspaceRoot`，
 * 以及通过 `createAgentTool` 启动的子 Agent 继承同一 workspaceRoot。
 *
 * 覆盖三条路径：
 * 1. query.ts:454  — read-only 工具的 pre-start `preStartToolContext`
 * 2. query.ts:758  — 主 tool execution 的 `toolContext`
 * 3. agent-tool → fork-query — 子 Agent 继承/覆盖链
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntime } from '../src/runtime-assembly.js';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import {
  normalizeWorkspaceRoot,
} from '../src/engine/contracts/context-capability.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';

const execAsync = promisify(exec);

// ─── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

async function consume(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/**
 * Sentinel distinguishable from `undefined` so tests can assert the tool
 * actually executed (and thus its captured value was overwritten) rather
 * than silently skipping execution.
 */
const UNSET: unique symbol = Symbol('UNSET');
type Captured = string | undefined | typeof UNSET;

function makeCaptureTool(
  name: string,
  isReadOnly: boolean,
  onExecute: (context: ToolContext) => void,
): Tool {
  return {
    name,
    description: `capture workspaceRoot for ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly,
    async execute(_input, context) {
      onExecute(context);
      return { content: 'ok' };
    },
  };
}

// ─── Runtime-level: EngineConfig.workspaceRoot → ToolContext ────────

describe('EngineConfig.workspaceRoot → ToolContext.workspaceRoot (FR-13)', () => {
  it('forwards workspaceRoot to the pre-start context of read-only tools (query.ts:454)', async () => {
    let captured: Captured = UNSET;

    const tool = makeCaptureTool('capture_ro', true, (ctx) => {
      captured = ctx.workspaceRoot;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'capture_ro', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([tool]),
        workspaceRoot: '/tmp/fr13-ro',
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'go' }));
    expect(captured).toBe('/tmp/fr13-ro');
  });

  it('forwards workspaceRoot to the main tool execution context (query.ts:758)', async () => {
    let captured: Captured = UNSET;

    const tool = makeCaptureTool('capture_write', false, (ctx) => {
      captured = ctx.workspaceRoot;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'capture_write', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([tool]),
        workspaceRoot: '/tmp/fr13-write',
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'go' }));
    expect(captured).toBe('/tmp/fr13-write');
  });

  it('keeps ToolContext.workspaceRoot undefined when EngineConfig.workspaceRoot is not set (backward compat)', async () => {
    let capturedRo: Captured = UNSET;
    let capturedWrite: Captured = UNSET;

    const roTool = makeCaptureTool('ro', true, (ctx) => {
      capturedRo = ctx.workspaceRoot;
    });
    const writeTool = makeCaptureTool('write_tool', false, (ctx) => {
      capturedWrite = ctx.workspaceRoot;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'ro', input: {} } },
        { type: 'tool_use', toolUse: { id: 'c2', name: 'write_tool', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([roTool, writeTool]),
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'go' }));
    expect(capturedRo).toBeUndefined();
    expect(capturedWrite).toBeUndefined();
  });

  it('preserves the exact workspaceRoot string end-to-end (no sanitization)', async () => {
    let captured: Captured = UNSET;
    const exotic = '/Users/jane/My Organization (主)/项目';

    const tool = makeCaptureTool('capture', false, (ctx) => {
      captured = ctx.workspaceRoot;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'capture', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([tool]),
        workspaceRoot: exotic,
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'go' }));
    expect(captured).toBe(exotic);
  });
});

// ─── Sub-agent propagation: parent ToolContext → child query ────────

describe('agent tool propagates workspaceRoot to child queries (FR-13)', () => {
  function makeChildCaptureTool(onExecute: (context: ToolContext) => void): Tool {
    return {
      name: 'capture_child',
      description: 'captures child ToolContext.workspaceRoot',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_input, context) {
        onExecute(context);
        return { content: 'child done' };
      },
    };
  }

  function makeChildProvider() {
    return createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-child', name: 'capture_child', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'sub done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
  }

  function makeParentContext(workspaceRoot?: string): ToolContext {
    return {
      threadId: 'parent-thread',
      runtimeId: 'parent-session',
      toolUseId: 'mock-tool-use',
      abortSignal: new AbortController().signal,
      messages: [],
      workspaceRoot,
    };
  }

  it('uses parent ToolContext.workspaceRoot when AgentToolConfig.workspaceRoot is missing (fallback)', async () => {
    let captured: Captured = UNSET;
    const childTool = makeChildCaptureTool((c) => {
      captured = c.workspaceRoot;
    });

    const tool = createAgentTool({
      provider: makeChildProvider(),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute({ prompt: 'do child task' }, makeParentContext('/tmp/parent-root'));
    expect(captured).toBe('/tmp/parent-root');
  });

  it('prefers explicit AgentToolConfig.workspaceRoot over parent context fallback', async () => {
    let captured: Captured = UNSET;
    const childTool = makeChildCaptureTool((c) => {
      captured = c.workspaceRoot;
    });

    const tool = createAgentTool({
      provider: makeChildProvider(),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
      workspaceRoot: '/tmp/explicit-root',
    });

    await tool.execute({ prompt: 'do child task' }, makeParentContext('/tmp/parent-root'));
    expect(captured).toBe('/tmp/explicit-root');
  });

  it('leaves child ToolContext.workspaceRoot undefined when neither side is configured', async () => {
    let captured: Captured = UNSET;
    const childTool = makeChildCaptureTool((c) => {
      captured = c.workspaceRoot;
    });

    const tool = createAgentTool({
      provider: makeChildProvider(),
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute({ prompt: 'do child task' }, makeParentContext(undefined));
    expect(captured).toBeUndefined();
  });
});

// ─── End-to-end: bash-like tool runs in configured workspaceRoot ────
//
// Goal: prove the wiring is not just typed but actually produces the
// correct `cwd` for a tool that mimics bash's behavior (core-tools' bash
// passes `cwd: context.workspaceRoot` directly to `child_process.exec`).

describe('end-to-end: cwd of a bash-like tool matches EngineConfig.workspaceRoot', () => {
  async function runPwdInWorkspace(workspaceRoot?: string): Promise<string> {
    let stdout = '';

    const bashLike: Tool = {
      name: 'pwd_probe',
      description: 'runs `pwd` using context.workspaceRoot as cwd',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      async execute(_input, context): Promise<ToolResult> {
        const { stdout: out } = await execAsync('pwd', {
          cwd: context.workspaceRoot,
          signal: context.abortSignal,
        });
        stdout = out.trim();
        return { content: stdout };
      },
    };

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'pwd_probe', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([bashLike]),
        workspaceRoot,
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'go' }));
    return stdout;
  }

  it('executes the tool in the configured workspaceRoot, not the process cwd', async () => {
    // macOS `/tmp` is a symlink to `/private/tmp`; resolve to avoid a
    // spurious mismatch between the configured input and `pwd` output.
    const wsRoot = await realpath(await mkdtemp(join(tmpdir(), 'fr13-ws-')));
    try {
      const observedPwd = await runPwdInWorkspace(wsRoot);
      expect(observedPwd).toBe(wsRoot);
      expect(observedPwd).not.toBe(process.cwd());
    } finally {
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('falls back to process cwd when workspaceRoot is undefined (backward compat)', async () => {
    const observedPwd = await runPwdInWorkspace(undefined);
    const expectedCwd = await realpath(process.cwd());
    expect(observedPwd).toBe(expectedCwd);
  });
});

// ─── normalizeWorkspaceRoot helper (two-host shared normalization) ─
// 两端宿主（Electron `getCLIOrganizationRoot()` / Daemon
// `DaemonConfig.workspace_root`）都经过这个函数，确保"尾空格 / 空串 /
// null" 等奇异输入在到达 EngineConfig 前被统一归一化到 `string | undefined`。

describe('normalizeWorkspaceRoot (FR-13 SSoT)', () => {
  it('returns undefined for null / undefined / non-string inputs', () => {
    expect(normalizeWorkspaceRoot(null)).toBeUndefined();
    expect(normalizeWorkspaceRoot(undefined)).toBeUndefined();
    // Non-string runtime inputs must not throw; explicitly cast to unknown.
    expect(normalizeWorkspaceRoot(123 as unknown as string)).toBeUndefined();
    expect(normalizeWorkspaceRoot({} as unknown as string)).toBeUndefined();
  });

  it('returns undefined for empty / whitespace-only strings', () => {
    expect(normalizeWorkspaceRoot('')).toBeUndefined();
    expect(normalizeWorkspaceRoot(' ')).toBeUndefined();
    expect(normalizeWorkspaceRoot('\t\n  ')).toBeUndefined();
  });

  it('trims surrounding whitespace from valid paths', () => {
    expect(normalizeWorkspaceRoot('  /home/user/project  ')).toBe('/home/user/project');
    expect(normalizeWorkspaceRoot('\t/srv/data\n')).toBe('/srv/data');
  });

  it('preserves exotic but non-whitespace paths verbatim', () => {
    const exotic = '/Users/jane/My Organization (主)/项目';
    expect(normalizeWorkspaceRoot(exotic)).toBe(exotic);
  });

  it('returns undefined for relative paths (caller must absolutize first)', () => {
    // Design intent: only absolute paths are accepted. Relative paths return
    // `undefined` so the caller must resolve them explicitly — we deliberately
    // do NOT apply `path.resolve` here, to avoid implicit `process.cwd()`
    // behaviour leaking into EngineConfig (host cwd ≠ organization root).
    expect(normalizeWorkspaceRoot('relative/path')).toBeUndefined();
  });
});

// ─── Consistency: preStart + main ToolContext share the same workspaceRoot ─
//
// Defends against a subtle regression: if someone edits `query.ts` and only
// fixes one of the two ToolContext construction sites (line 454 vs 758),
// the bug wouldn't surface in tests that only cover one path. This test
// mixes a read-only tool (goes through preStart) and a write tool (goes
// through main path) in the same query and asserts both saw the same value.

describe('preStart and main ToolContext share the same workspaceRoot (FR-13)', () => {
  it('both constructions observe the identical config.workspaceRoot', async () => {
    let capturedRo: Captured = UNSET;
    let capturedWrite: Captured = UNSET;

    const roTool = makeCaptureTool('ro_mix', true, (ctx) => {
      capturedRo = ctx.workspaceRoot;
    });
    const writeTool = makeCaptureTool('write_mix', false, (ctx) => {
      capturedWrite = ctx.workspaceRoot;
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'ro1', name: 'ro_mix', input: {} } },
        { type: 'tool_use', toolUse: { id: 'wr1', name: 'write_mix', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([roTool, writeTool]),
        workspaceRoot: '/tmp/fr13-mixed',
      }),
    );

    await consume(rt.query({ hostRunId: 'test-run', prompt: 'go' }));
    expect(capturedRo).toBe('/tmp/fr13-mixed');
    expect(capturedWrite).toBe('/tmp/fr13-mixed');
    expect(capturedRo).toBe(capturedWrite);
  });
});


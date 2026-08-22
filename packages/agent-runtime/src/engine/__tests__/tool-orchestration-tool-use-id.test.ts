/**
 * L-15 contract test —— tool-orchestration 把 block.id 透传到
 * ToolContext.toolUseId（WP1 2026-05-13 新增）
 *
 * **业务背景**：ShellCap PTY 化（WP1）后，`run_terminal_command` 在
 * `PtyManagerBridge.AgentCommandRequest.agentMeta.toolUseId` 上强制要求
 * `context.toolUseId` 非空（agent-bridge.ts JSDoc 第 148-153 行硬契约）。
 * tool-orchestration 必须在两个 executeTool 调点按 block 浅拷贝覆盖
 * `toolUseId`：
 *   - `executeBatchParallel`（并行 batch）
 *   - `executeSingleTool`（单工具 fallback）
 * 否则下游 ShellCap 见到 `context.toolUseId === undefined` 同步 throw,
 * 整轮 Agent 链路断裂。
 *
 * **本测试锁住**：注册一个 spy tool，验证它的 `execute(input, context)`
 * 收到的 `context.toolUseId === block.id`（不是父 context 上的 undefined,
 * 也不是 sessionId / threadId 等其它兜底）。
 *
 * **覆盖路径**：
 *   1. read-only tool（走 executeBatchParallel）→ batch 中每个 block 自带 toolUseId
 *   2. write tool（走 executeSingleTool）→ 单 tool 也透传
 *   3. 同一 ToolContext 跑两个 block → 两次执行各自拿到自己的 toolUseId
 *      （不共享、不串流）
 *
 * **不覆盖**：query.ts pre-start 路径（属于 query.ts 内部行为，已在
 * `tests/skill-credential-e2e.test.ts` 等 e2e 中间接覆盖；本 contract 只
 * 锁 tool-orchestration 自身的透传义务）。
 */

import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tooling/tool-system.js';
import { runTools, type ToolExecutionResult } from '../tooling/tool-orchestration.js';
import { createMockPermissionHandler } from '../../../tests/test-utils.js';
import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';
import type {
  ToolUseBlock,
} from '../contracts/conversation.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../contracts/tools.js';

// ─── helpers ─────────────────────────────────────────────────────────

function makeFakeContext(
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    threadId: 'th',
    agentRunId: 'run-tool-orchestration-contract',
    // §17.6 D4：ToolContext.sessionId → runtimeId（runtime UUID）。
    runtimeId: 'rt',
    // NB：父 ToolContext 故意**不**带 toolUseId（生产路径就是这样——
    // query.ts 构造的主循环 ToolContext 不带 toolUseId，
    // tool-orchestration 按 block 覆盖）。
    abortSignal: new AbortController().signal,
    messages: [],
    ...overrides,
  };
}

function makeBlock(name: string, id: string, input: unknown = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<ToolExecutionResult[]> {
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}

async function collectEvents(
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

interface SpyToolResult {
  capturedToolUseIds: string[];
  capturedThreadIds: string[];
  capturedInputs: unknown[];
  capturedIntents: Array<string | undefined>;
  tool: Tool;
}

function makeSpyTool(name: string, isReadOnly: boolean): SpyToolResult {
  const capturedToolUseIds: string[] = [];
  const capturedThreadIds: string[] = [];
  const capturedInputs: unknown[] = [];
  const capturedIntents: Array<string | undefined> = [];
  const tool: Tool = {
    name,
    description: `spy tool ${name}`,
    inputSchema: { type: 'object' as const, properties: {} },
    isReadOnly,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      capturedInputs.push(input);
      capturedIntents.push(context.toolCallMetadata?.intent);
      capturedToolUseIds.push(context.toolUseId ?? '__MISSING__');
      capturedThreadIds.push(context.threadId);
      return { content: JSON.stringify({ ok: true }) };
    },
  };
  return { capturedToolUseIds, capturedThreadIds, capturedInputs, capturedIntents, tool };
}

// ─── 1. read-only tool（executeBatchParallel 路径）─────────────────────

describe('L-15 · tool-orchestration 透传 block.id → ToolContext.toolUseId（contract）', () => {
  it('tool_started 透传执行侧派生的 presentation，而不是让客户端猜 command', async () => {
    const spy = makeSpyTool('spy_presented', true);
    spy.tool.resolvePresentation = () => ({
      kind: 'media_image_generation',
      data: { prompt: 'apple' },
    });
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const { events } = await collectEvents(
      runTools({
        options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [makeBlock('spy_presented', 'tool-use-presented')],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    const started = events.find((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.notice_type === 'tool_started';
    });
    expect(started?.payload).toMatchObject({
      tool_name: 'spy_presented',
      tool_call_id: 'tool-use-presented',
      presentation: {
        kind: 'media_image_generation',
        data: { prompt: 'apple' },
      },
    });
  });

  it('剥离 runtime tool-call metadata 后再校验、展示和执行', async () => {
    const spy = makeSpyTool('spy_metadata', true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const { events } = await collectEvents(
      runTools({
        options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [
          makeBlock('spy_metadata', 'tool-use-metadata', {
            intent: '读取项目状态',
            explanation: '旧字段说明',
            project_id: 'project-1',
          }),
        ],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    const started = events.find((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.notice_type === 'tool_started';
    });
    expect(started?.payload).toMatchObject({
      input: { project_id: 'project-1' },
      tool_call_metadata: { intent: '读取项目状态' },
    });
    expect(spy.capturedInputs).toEqual([{ project_id: 'project-1' }]);
    expect(spy.capturedIntents).toEqual(['读取项目状态']);
  });

  it('迁移期接受 legacy explanation 但不把它传给工具业务 input', async () => {
    const spy = makeSpyTool('spy_legacy_metadata', true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    await drain(
      runTools({
        options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [
          makeBlock('spy_legacy_metadata', 'tool-use-legacy-metadata', {
            explanation: '查成员列表',
            project_id: 'project-1',
          }),
        ],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    expect(spy.capturedInputs).toEqual([{ project_id: 'project-1' }]);
    expect(spy.capturedIntents).toEqual(['查成员列表']);
  });

  it('工具 schema 明确声明的 intent 作为业务参数保留', async () => {
    const spy = makeSpyTool('spy_business_intent', true);
    spy.tool.inputSchema = {
      type: 'object',
      properties: { intent: { type: 'string' } },
      required: ['intent'],
      additionalProperties: false,
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    await drain(
      runTools({
        options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [
          makeBlock('spy_business_intent', 'tool-use-business-intent', {
            intent: 'replace_existing',
          }),
        ],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    expect(spy.capturedInputs).toEqual([{ intent: 'replace_existing' }]);
    expect(spy.capturedIntents).toEqual([undefined]);
  });

  it('tool_completed 优先使用执行结果的动态 presentation，覆盖启动态 presentation', async () => {
    const spy = makeSpyTool('spy_dynamic_presentation', true);
    spy.tool.resolvePresentation = () => ({
      kind: 'subagent_status_check',
      data: { childId: 'child-a', status: 'checking' },
    });
    spy.tool.execute = async () => ({
      content: '查询时运行中',
      presentation: {
        kind: 'subagent_status_check',
        data: { childId: 'child-a', status: 'running' },
      },
    });
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const { events, results } = await collectEvents(
      runTools({
        options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [makeBlock('spy_dynamic_presentation', 'tool-use-dynamic')],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    const started = events.find((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.notice_type === 'tool_started';
    });
    const completed = events.find((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.notice_type === 'tool_completed';
    });
    expect(started?.payload).toMatchObject({
      presentation: {
        kind: 'subagent_status_check',
        data: { childId: 'child-a', status: 'checking' },
      },
    });
    expect(completed?.payload).toMatchObject({
      presentation: {
        kind: 'subagent_status_check',
        data: { childId: 'child-a', status: 'running' },
      },
    });
    expect(results[0]?.result.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId: 'child-a', status: 'running' },
    });
  });

  it('read-only tool（executeBatchParallel）收到 context.toolUseId === block.id', async () => {
    const spy = makeSpyTool('spy_read', /* isReadOnly */ true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const block = makeBlock('spy_read', 'tool-use-abc');

    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [block],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].toolUseId).toBe('tool-use-abc');
    expect(spy.capturedToolUseIds).toEqual(['tool-use-abc']);
    // 父 ToolContext.threadId 仍透传（浅拷贝不破坏其它字段）
    expect(spy.capturedThreadIds).toEqual(['th']);
  });

  it('多个 read-only block 并行：各自拿到自己的 toolUseId（不串流）', async () => {
    const spy = makeSpyTool('spy_read', /* isReadOnly */ true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const blocks = [
      makeBlock('spy_read', 'tool-use-1'),
      makeBlock('spy_read', 'tool-use-2'),
      makeBlock('spy_read', 'tool-use-3'),
    ];

    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: blocks,
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    expect(results).toHaveLength(3);
    // 顺序由 executeBatchParallel 内部决定，但每个 block.id 都应该被捕到
    expect(spy.capturedToolUseIds.sort()).toEqual(['tool-use-1', 'tool-use-2', 'tool-use-3']);
  });

  it('write tool（executeSingleTool）收到 context.toolUseId === block.id', async () => {
    const spy = makeSpyTool('spy_write', /* isReadOnly */ false);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const block = makeBlock('spy_write', 'tool-use-write-xyz');

    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [block],
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    expect(results).toHaveLength(1);
    expect(spy.capturedToolUseIds).toEqual(['tool-use-write-xyz']);
  });

  it('混合 read-only + write tools：各自拿到对应 toolUseId', async () => {
    const readSpy = makeSpyTool('spy_read', true);
    const writeSpy = makeSpyTool('spy_write', false);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [readSpy.tool, writeSpy.tool] });

    const blocks = [
      makeBlock('spy_read', 'read-1'),
      makeBlock('spy_write', 'write-1'),
      makeBlock('spy_read', 'read-2'),
    ];

    await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: blocks,
        registry,
        context: makeFakeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    // read 路径走 executeBatchParallel（并发顺序不确定）
    expect(readSpy.capturedToolUseIds.sort()).toEqual(['read-1', 'read-2']);
    // write 路径走 executeSingleTool（顺序执行）
    expect(writeSpy.capturedToolUseIds).toEqual(['write-1']);
  });

  it('父 ToolContext 本身不带 toolUseId（不污染主循环 / 跨 tool 共享 context）', async () => {
    const spy = makeSpyTool('spy_check_parent', true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [spy.tool] });

    const parentContext = makeFakeContext();
    expect(parentContext.toolUseId).toBeUndefined();

    await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [makeBlock('spy_check_parent', 'tool-use-parent-check')],
        registry,
        context: parentContext,
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    // 子 context 拿到了 block.id
    expect(spy.capturedToolUseIds).toEqual(['tool-use-parent-check']);
    // **关键不变量**：父 context 被浅拷贝（perBlockContext = { ...context, toolUseId: block.id }），
    // 不被原地 mutation 污染——后续主循环再用同一份 parentContext 时仍是 undefined
    expect(parentContext.toolUseId).toBeUndefined();
  });
});

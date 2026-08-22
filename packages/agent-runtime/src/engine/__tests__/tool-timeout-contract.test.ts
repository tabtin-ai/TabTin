import { describe, expect, it } from 'vitest';
import { executeTool, ToolRegistry } from '../tooling/tool-system.js';
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

function makeContext(): ToolContext {
  return {
    threadId: 'thread-timeout',
    runtimeId: 'session-timeout',
    abortSignal: new AbortController().signal,
    messages: [],
  };
}

function makeBlock(name: string, input: unknown = {}): ToolUseBlock {
  return { type: 'tool_use', id: `tool-use-${name}`, name, input };
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

describe('tool execution timeout contract', () => {
  it('uses per-tool executionTimeoutMs instead of the generic fallback timeout', async () => {
    const tool: Tool = {
      name: 'slow_but_allowed',
      description: 'slow test tool',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      executionTimeoutMs: 50,
      execute: async (): Promise<ToolResult> => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { content: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [makeBlock('slow_but_allowed')],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        timeoutMs: 1,
      }),
    );

    expect(results[0].result.isError).toBeFalsy();
    expect(results[0].result.content).toBe('ok');
  });

  it('executionTimeoutMs=0 关闭工具层超时：跑得比通用兜底久也不会被 TOOL_TIMEOUT（digest 契约）', async () => {
    const tool: Tool = {
      name: 'no_timeout_tool',
      description: 'model-calling tool without wall clock',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      executionTimeoutMs: 0,
      execute: async (): Promise<ToolResult> => {
        // 比传入的通用兜底 timeoutMs(5ms) 久：若 0 未生效会被超时打断
        await new Promise(resolve => setTimeout(resolve, 40));
        return { content: 'done' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [makeBlock('no_timeout_tool')],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        timeoutMs: 5,
      }),
    );

    expect(results[0].result.isError).toBeFalsy();
    expect(results[0].result.content).toBe('done');
  });

  it('aborts the child tool context when the wrapper timeout fires', async () => {
    let observedAbort = false;
    const tool: Tool = {
      name: 'never_finishes',
      description: 'timeout test tool',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      executionTimeoutMs: 5,
      execute: async (_input, context): Promise<ToolResult> => {
        context.abortSignal.addEventListener('abort', () => {
          observedAbort = true;
        }, { once: true });
        await new Promise(resolve => setTimeout(resolve, 50));
        return { content: 'late' };
      },
    };
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const results = await drain(
      runTools({
      options: { allowLegacyPermissionFallback: true },
        toolUseBlocks: [makeBlock('never_finishes')],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
      }),
    );

    expect(observedAbort).toBe(true);
    expect(results[0].result.isError).toBe(true);
    expect(String(results[0].result.content)).toContain('tool_timeout');
  });

  it('forwards the parent abort reason to the child tool context', async () => {
    const parentController = new AbortController();
    const reason = new Error('tool_call_cancelled');
    let observedReason: unknown;
    const tool: Tool = {
      name: 'abort_reason_probe',
      description: 'abort reason test tool',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      execute: async (_input, context): Promise<ToolResult> => {
        context.abortSignal.addEventListener('abort', () => {
          observedReason = context.abortSignal.reason;
        }, { once: true });
        parentController.abort(reason);
        await new Promise(resolve => setTimeout(resolve, 0));
        return { content: 'ok' };
      },
    };

    await expect(executeTool(tool, {}, {
      ...makeContext(),
      abortSignal: parentController.signal,
    }, 100)).rejects.toThrow('aborted');
    expect(observedReason).toBe(reason);
  });
});

import { describe, expect, it } from 'vitest';
import type { EngineConfig, ToolGate } from '../../contracts/kernel.js';
import type { LLMResponseChunk } from '../../contracts/model-llm.js';
import type { Tool, ToolContext, ToolResult } from '../../contracts/tools.js';
import {
  handleToolUseChunk,
  type LLMStreamAccumulator,
} from '../model-stream.js';

function createAccumulator(): LLMStreamAccumulator {
  return {
    fullText: '',
    fullReasoning: '',
    toolUseBlocks: [],
    toolCallMetadataById: new Map(),
    currentAssistantContent: [],
    currentBlock: null,
    preStartedTools: new Map(),
    currentLLMMessageId: 'message-1',
  };
}

describe('tool intent streaming', () => {
  it('完整 tool_use 到达后立即发布 intent，不等待只读工具结果', () => {
    let resolveTool!: (result: ToolResult) => void;
    const pendingResult = new Promise<ToolResult>((resolve) => {
      resolveTool = resolve;
    });
    const tool: Tool = {
      name: 'slow_read',
      description: 'slow read fixture',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: () => pendingResult,
    };
    const chunk: LLMResponseChunk = {
      type: 'tool_use',
      toolUse: {
        id: 'tool-use-1',
        name: tool.name,
        input: { intent: '读取远端页面', url: 'https://example.com' },
      },
    };
    const toolGate: ToolGate = {
      isRestrictedMode: () => false,
      evaluate: () => ({ allowed: true }),
      isPlanTargetGuarded: () => false,
    };

    const event = handleToolUseChunk({
      chunk,
      acc: createAccumulator(),
      toolMap: new Map([[tool.name, tool]]),
      config: { sessionConfig: { threadId: 'thread-1' } } as EngineConfig,
      toolSchemaValidation: 'off',
      preStartToolContext: {
        threadId: 'thread-1',
        runtimeId: 'runtime-1',
        agentRunId: 'run-1',
        abortSignal: new AbortController().signal,
        messages: [],
      } as ToolContext,
      observe: () => {},
      toolGate,
    });

    expect(event).toMatchObject({
      type: 'agent.stream.system_notice',
      payload: {
        notice_type: 'tool_intent_available',
        tool_name: 'slow_read',
        tool_call_id: 'tool-use-1',
        tool_call_metadata: { intent: '读取远端页面' },
      },
    });
    resolveTool({ content: 'done' });
  });

  it('未提供 intent 时不发布空展示事件', () => {
    const acc = createAccumulator();
    const event = handleToolUseChunk({
      chunk: {
        type: 'tool_use',
        toolUse: { id: 'tool-use-2', name: 'plain_read', input: { path: '/tmp/a' } },
      },
      acc,
      toolMap: new Map(),
      config: { sessionConfig: { threadId: 'thread-1' } } as EngineConfig,
      toolSchemaValidation: 'off',
      preStartToolContext: {} as ToolContext,
      observe: () => {},
      toolGate: {
        isRestrictedMode: () => false,
        evaluate: () => ({ allowed: true }),
        isPlanTargetGuarded: () => false,
      },
    });

    expect(event).toBeUndefined();
    expect(acc.toolUseBlocks[0]?.input).toEqual({ path: '/tmp/a' });
  });
});

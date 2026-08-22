import { describe, expect, it } from 'vitest';

import { isTabtinToolUseId } from '../../engine/context/tool-id-mapper.js';
import {
  FORK_TOOL_REF_KEYS,
  FORK_TOOL_USE_TYPES,
  createForkToolIdMapper,
  remapToolIdsInValue,
} from '../fork-tool-id-remap.js';

/** 与 Django `TOOL_USE_TYPES` / `TOOL_REF_KEYS` 对齐；改一端必须改另一端测试 */
const DJANGO_TOOL_USE_TYPES = [
  'tool_use',
  'tool_call',
  'function_call',
  'function',
  'server_tool_use',
  'mcp_tool_use',
] as const;
const DJANGO_TOOL_REF_KEYS = ['tool_use_id', 'tool_call_id', 'toolCallId'] as const;

describe('fork tool-id cross-language contract ', () => {
  it('FORK_TOOL_USE_TYPES matches Django TOOL_USE_TYPES', () => {
    expect([...FORK_TOOL_USE_TYPES].sort()).toEqual([...DJANGO_TOOL_USE_TYPES].sort());
  });

  it('FORK_TOOL_REF_KEYS matches Django TOOL_REF_KEYS', () => {
    expect([...FORK_TOOL_REF_KEYS].sort()).toEqual([...DJANGO_TOOL_REF_KEYS].sort());
  });
});

describe('remapToolIdsInValue ', () => {
  it('remaps tool_use id and matching tool_result tool_use_id together', () => {
    const mapper = createForkToolIdMapper();
    const input = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'run_terminal_command_41', name: 'run_terminal_command', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'run_terminal_command_41', content: 'ok' },
        ],
      },
    ];
    const out = remapToolIdsInValue(input, mapper);
    const useId = (out[0].content as Array<{ id: string }>)[0].id;
    const resultId = (out[1].content as Array<{ tool_use_id: string }>)[0].tool_use_id;
    expect(isTabtinToolUseId(useId)).toBe(true);
    expect(resultId).toBe(useId);
    expect(useId).not.toBe('run_terminal_command_41');
  });

  it('keeps colliding historical model ids mapped to the same new id (pairing preserved)', () => {
    const mapper = createForkToolIdMapper();
    const blocks = [
      { type: 'tool_use', id: 'run_terminal_command_41', name: 'a', input: {} },
      { type: 'tool_use', id: 'run_terminal_command_41', name: 'b', input: {} },
    ];
    const out = remapToolIdsInValue(blocks, mapper);
    expect(out[0].id).toBe(out[1].id);
    expect(isTabtinToolUseId(out[0].id)).toBe(true);
  });

  it('does not rewrite non-tool block ids', () => {
    const mapper = createForkToolIdMapper();
    const block = { type: 'text', id: 'msg-block-1', text: 'hi' };
    const out = remapToolIdsInValue(block, mapper);
    expect(out.id).toBe('msg-block-1');
    expect(mapper.size).toBe(0);
  });

  it('remaps OpenAI ConversationState tool_calls[].id with type=function', () => {
    const mapper = createForkToolIdMapper();
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'run_terminal_command_41',
            type: 'function',
            function: { name: 'run_terminal_command', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'run_terminal_command_41',
        content: 'ok',
      },
    ];
    const out = remapToolIdsInValue(messages, mapper);
    const callId = (out[0].tool_calls as Array<{ id: string }>)[0].id;
    const resultId = out[1].tool_call_id as string;
    expect(isTabtinToolUseId(callId)).toBe(true);
    expect(resultId).toBe(callId);
    expect(callId).not.toBe('run_terminal_command_41');
  });

  it('does not treat arbitrary {id, function} objects without name as tool calls', () => {
    const mapper = createForkToolIdMapper();
    const block = { id: 'widget-1', function: { kind: 'not-a-tool' } };
    const out = remapToolIdsInValue(block, mapper);
    expect(out.id).toBe('widget-1');
    expect(mapper.size).toBe(0);
  });

  it('createForkToolIdMapper seeds cloud remap snapshot', () => {
    const seeded = 'tu_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const mapper = createForkToolIdMapper({ run_terminal_command_41: seeded });
    expect(mapper.allocate('run_terminal_command_41')).toBe(seeded);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeAgentToolIntentInput } from '../src/subagent/agent-tool-intent.js';

describe('normalizeAgentToolIntentInput', () => {
  it.each([
    [{ prompt: '执行任务' }, 'spawn'],
    [{ prompt: '继续', resume_agent_id: ' child-1 ' }, 'resume'],
    [{ prompt: '忽略', check_agent_id: ' child-2 ' }, 'check'],
    [{ prompt: '忽略', wait_agent_ids: [' child-3 ', '', 'child-3'] }, 'wait'],
    [{ prompt: '执行任务', wait_agent_ids: [] }, 'spawn'],
    [{ prompt: '执行任务', wait_agent_ids: ['  '] }, 'spawn'],
    [{ prompt: '执行任务', check_agent_id: '', resume_agent_id: '  ' }, 'spawn'],
    [{ wait_agent_ids: [], check_agent_id: '', resume_agent_id: '', prompt: '' }, 'unknown'],
  ] as const)('将 %j 归一化为 %s', (input, intent) => {
    expect(normalizeAgentToolIntentInput(input).intent).toBe(intent);
  });

  it('wait ID 去空、去重并排序，供 runtime 与 UI 共享', () => {
    expect(normalizeAgentToolIntentInput({
      wait_agent_ids: [' child-b ', 'child-a', '', 'child-b'],
    })).toEqual({
      intent: 'wait',
      waitAgentIds: ['child-a', 'child-b'],
    });
  });

  it('message_agent_id 不影响意图归一化（仍按 control 字段优先级判断）', () => {
    expect(normalizeAgentToolIntentInput({
      message_agent_id: 'child-1',
      prompt: '插话内容',
      wait_agent_ids: [],
    })).toEqual({ intent: 'spawn', prompt: '插话内容' });

    expect(normalizeAgentToolIntentInput({
      message_agent_id: 'child-1',
      wait_agent_ids: ['child-2'],
    })).toEqual({ intent: 'wait', waitAgentIds: ['child-2'] });
  });
});

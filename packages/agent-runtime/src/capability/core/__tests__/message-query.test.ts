/**
 * message-query 单测 —— extractLatestUserQuery + buildRecallQuery。
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../engine/contracts/conversation.js';
import { setInternalMarker, INTERNAL_MESSAGE_MARKERS } from '../../../engine/contracts/conversation.js';
import { buildRecallQuery, extractLatestUserQuery } from '../message-query.js';

function todoWrite(
  todos: Array<{ id: string; content: string; status: string }>,
  merge = false,
): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: `tu-${todos[0]?.id ?? 'x'}`, name: 'todo', input: { action: 'open', items: todos } },
    ],
  };
}

describe('extractLatestUserQuery', () => {
  it('取最近真实 user，跳过注入块', () => {
    const messages: Message[] = [
      { role: 'user', content: '原始请求' },
      setInternalMarker({ role: 'user', content: '<context>env</context>' }, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION),
    ];
    expect(extractLatestUserQuery(messages)).toBe('原始请求');
  });

  it('无消息 → 空串', () => {
    expect(extractLatestUserQuery([])).toBe('');
  });
});

describe('buildRecallQuery', () => {
  it('无 todo → 退化为纯用户 query（向后兼容）', () => {
    const messages: Message[] = [{ role: 'user', content: '打开浏览器' }];
    expect(buildRecallQuery(messages)).toBe('打开浏览器');
  });

  it('有 in_progress todo → 用户原话 + todo content', () => {
    const messages: Message[] = [
      { role: 'user', content: '完成整个任务' },
      todoWrite([
        { id: '1', content: '查资料', status: 'completed' },
        { id: '2', content: '给同事发通知邮件', status: 'in_progress' },
      ]),
    ];
    expect(buildRecallQuery(messages)).toBe('完成整个任务\n给同事发通知邮件');
  });

  it('批已收尾 → 只剩用户 query', () => {
    const messages: Message[] = [
      { role: 'user', content: '完成任务' },
      todoWrite([{ id: '1', content: 'A', status: 'completed' }]),
    ];
    expect(buildRecallQuery(messages)).toBe('完成任务');
  });

  it('无用户 query 但有 in_progress → 只剩 todo content', () => {
    const messages: Message[] = [
      todoWrite([{ id: '1', content: '发通知', status: 'in_progress' }]),
    ];
    expect(buildRecallQuery(messages)).toBe('发通知');
  });

  it('in_progress 推进 → query 随之变化（召回重算依据）', () => {
    const before: Message[] = [
      { role: 'user', content: '任务' },
      todoWrite([
        { id: '1', content: '写代码', status: 'in_progress' },
        { id: '2', content: '发通知', status: 'pending' },
      ]),
    ];
    const after: Message[] = [
      ...before,
      todoWrite([
        { id: '1', content: '写代码', status: 'completed' },
        { id: '2', content: '发通知', status: 'in_progress' },
      ], true),
    ];
    expect(buildRecallQuery(before)).toBe('任务\n写代码');
    expect(buildRecallQuery(after)).toBe('任务\n发通知');
    expect(buildRecallQuery(before)).not.toBe(buildRecallQuery(after));
  });
});

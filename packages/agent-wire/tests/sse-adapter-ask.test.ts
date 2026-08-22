import { describe, expect, it } from 'vitest';

import { mapWsEventToSse } from '../src/sse-adapter.js';

/**
 * SSE adapter ask_user 单测（W4 / 2026-05-11 单形态合一）。
 *
 * 历史：W7 时期为三件套（ask_choice / ask_form / request_approval）各自有 SSE
 *   case；W4 重新合一为单 ask_user_required。
 */
describe('mapWsEventToSse · ask_user_required (W4)', () => {
  it('preserves ask_user_required structured payload', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_user_required',
      thread_id: 'chat-session-1',
      payload: {
        thread_id: 'chat-session-1',
        interrupt_id: 'ask-1',
        interaction_type: 'ask_user',
        blocking_policy: 'hard',
        tool_name: 'ask_user',
        tool_call_id: 'tool-1',
        title: '请选择同步方式',
        questions: [
          {
            id: 'q1',
            prompt: '怎么同步？',
            options: [
              { id: 'fast', label: '快速', description: '只同步最近修改的文件。' },
              { id: 'full', label: '完整', description: '重新扫描整个目录。' },
            ],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      type: 'ask_user_required',
      ask_id: 'ask-1',
      thread_id: 'chat-session-1',
      interrupt_id: 'ask-1',
      interaction_type: 'ask_user',
      blocking_policy: 'hard',
      tool_name: 'ask_user',
      tool_call_id: 'tool-1',
      title: '请选择同步方式',
    });
    expect(result?.questions).toHaveLength(1);
  });

  it('uses payload.title as fallback message when no explicit message', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_user_required',
      thread_id: 'chat-session-1',
      payload: {
        title: '选择数据库',
        questions: [],
      },
    });
    expect(result?.message).toBe('选择数据库');
  });

  it('falls back to default message when neither title nor message provided', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_user_required',
      thread_id: 'chat-session-1',
      payload: { questions: [] },
    });
    expect(result?.message).toBe('Agent 正在等待您的回答');
  });
});

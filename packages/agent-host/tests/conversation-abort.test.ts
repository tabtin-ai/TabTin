/**
 * abort-session-resolve —  停止链路收口纯函数单测。
 *
 * 锁定的行为契约：
 *   1. IPC 路径（key = 业务 sessionId）：按 sessionId / `chat-session-` 前缀
 *      形态都能命中；
 *   2. forward 路径（key = task_id，businessThreadId = 业务会话）：按 task_id
 *      直达，也能按业务 sessionId / thread_id 命中——这是本次修复的核心
 *      （旧实现按 sessionId 对 forward run 必 miss）；
 *   3. miss 必须返回空列表（调用方如实返回失败，不假成功）；
 *   4. envelope 候选提取顺序：payload.task_id → envelope.thread_id →
 *      payload.thread_id → payload.session_id（去重、滤空）。
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeConversationId,
  resolveConversationAbortKeys,
  resolveConversationStateKeys,
  extractAbortIdentityCandidates,
} from '../src/conversation/conversation-abort.js';

const SESSION_UUID = '16ab3a0e-0575-48b4-8e41-e44a7e1beb13';
const TASK_ID = 'prompt_abc123def456';

describe('normalizeConversationId', () => {
  it('剥 chat-session- 前缀', () => {
    expect(normalizeConversationId(`chat-session-${SESSION_UUID}`)).toBe(SESSION_UUID);
  });

  it('无前缀原样返回', () => {
    expect(normalizeConversationId(SESSION_UUID)).toBe(SESSION_UUID);
    expect(normalizeConversationId(TASK_ID)).toBe(TASK_ID);
  });

  it('纯前缀字符串不产生空 id', () => {
    expect(normalizeConversationId('chat-session-')).toBe('chat-session-');
  });
});

describe('resolveConversationAbortKeys', () => {
  const ipcEntry = { key: SESSION_UUID, businessThreadId: SESSION_UUID };
  const forwardEntry = { key: TASK_ID, businessThreadId: SESSION_UUID };

  it('IPC 路径：按业务 sessionId 直接命中 key', () => {
    expect(resolveConversationAbortKeys(SESSION_UUID, [ipcEntry])).toEqual([SESSION_UUID]);
  });

  it('IPC 路径：按 chat-session- 前缀形态命中', () => {
    expect(resolveConversationAbortKeys(`chat-session-${SESSION_UUID}`, [ipcEntry]))
      .toEqual([SESSION_UUID]);
  });

  it('forward 路径：按 task_id 直达', () => {
    expect(resolveConversationAbortKeys(TASK_ID, [forwardEntry])).toEqual([TASK_ID]);
  });

  it('forward 路径：按业务 sessionId 命中（ 修复核心）', () => {
    expect(resolveConversationAbortKeys(SESSION_UUID, [forwardEntry])).toEqual([TASK_ID]);
  });

  it('forward 路径：按 chat-session-<uuid> thread_id 命中', () => {
    expect(resolveConversationAbortKeys(`chat-session-${SESSION_UUID}`, [forwardEntry]))
      .toEqual([TASK_ID]);
  });

  it('businessThreadId 带前缀形态也能归一命中', () => {
    const entry = { key: TASK_ID, businessThreadId: `chat-session-${SESSION_UUID}` };
    expect(resolveConversationAbortKeys(SESSION_UUID, [entry])).toEqual([TASK_ID]);
  });

  it('miss 返回空列表（不假命中）', () => {
    expect(resolveConversationAbortKeys('other-session', [ipcEntry, forwardEntry])).toEqual([]);
  });

  it('空 / 空白 / null 请求 id 返回空列表', () => {
    expect(resolveConversationAbortKeys('', [ipcEntry])).toEqual([]);
    expect(resolveConversationAbortKeys('   ', [ipcEntry])).toEqual([]);
    expect(resolveConversationAbortKeys(undefined, [ipcEntry])).toEqual([]);
    expect(resolveConversationAbortKeys(null, [ipcEntry])).toEqual([]);
  });

  it('同会话多条 entry 全部命中且去重', () => {
    const dup = [
      { key: TASK_ID, businessThreadId: SESSION_UUID },
      { key: TASK_ID, businessThreadId: SESSION_UUID },
      { key: 'prompt_second', businessThreadId: SESSION_UUID },
    ];
    expect(resolveConversationAbortKeys(SESSION_UUID, dup)).toEqual([TASK_ID, 'prompt_second']);
  });

  it('不同业务会话互不误伤', () => {
    const other = { key: 'prompt_other', businessThreadId: 'another-uuid' };
    expect(resolveConversationAbortKeys(SESSION_UUID, [other, forwardEntry])).toEqual([TASK_ID]);
  });
});

describe('resolveConversationStateKeys', () => {
  const forwardEntry = {
    key: TASK_ID,
    businessThreadId: `chat-session-${SESSION_UUID}`,
  };

  it('按 task_id 查询时同时返回 runtime key 与 FIFO conversation key', () => {
    expect(resolveConversationStateKeys(TASK_ID, [forwardEntry])).toEqual([
      TASK_ID,
      `chat-session-${SESSION_UUID}`,
    ]);
  });

  it('按业务 UUID 查询时覆盖带前缀 FIFO key', () => {
    expect(resolveConversationStateKeys(SESSION_UUID, [forwardEntry])).toEqual([
      SESSION_UUID,
      `chat-session-${SESSION_UUID}`,
      TASK_ID,
    ]);
  });

  it('session 尚未注册时仍返回业务 id 的前缀变体', () => {
    expect(resolveConversationStateKeys(SESSION_UUID, [])).toEqual([
      SESSION_UUID,
      `chat-session-${SESSION_UUID}`,
    ]);
  });
});

describe('extractAbortIdentityCandidates', () => {
  it('Django forward_cancel 形态：payload.task_id + envelope.thread_id', () => {
    expect(extractAbortIdentityCandidates({
      thread_id: `chat-session-${SESSION_UUID}`,
      payload: { task_id: TASK_ID },
    })).toEqual([TASK_ID, `chat-session-${SESSION_UUID}`]);
  });

  it('无 task_id 时（按 thread 取消）：envelope.thread_id 仍可用', () => {
    expect(extractAbortIdentityCandidates({
      thread_id: `chat-session-${SESSION_UUID}`,
      payload: {},
    })).toEqual([`chat-session-${SESSION_UUID}`]);
  });

  it('历史调用方：payload.thread_id / payload.session_id 兼容', () => {
    expect(extractAbortIdentityCandidates({
      payload: { thread_id: 'thread-a', session_id: 'session-b' },
    })).toEqual(['thread-a', 'session-b']);
  });

  it('去重 + 滤空 + 非字符串忽略', () => {
    expect(extractAbortIdentityCandidates({
      thread_id: 'same-id',
      payload: { task_id: 'same-id', thread_id: '', session_id: 42 },
    })).toEqual(['same-id']);
  });

  it('完全无 id 返回空列表', () => {
    expect(extractAbortIdentityCandidates({ payload: {} })).toEqual([]);
    expect(extractAbortIdentityCandidates({})).toEqual([]);
  });
});

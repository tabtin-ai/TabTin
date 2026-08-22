/**
 * W0 — `agent.user.*` 命名空间协议骨架契约测试。
 *
 * 锁定三件事：
 *   1. UserEvents 三个常量的字符串值与设计一致（`agent.user.<name>`）。
 *   2. helper isUserEvent / stripUserPrefix 与既有 stream / session 系列对称，
 *      不会把 stream/session 事件错认为 user 事件。
 *   3. 旧 `StreamEvents.TITLE_UPDATED` 已彻底拿掉——这是 W0 的核心反退化保险，
 *      任何后续 Wave 想把它"加回来兼容"都会被这条断言挡住。
 */

import { describe, it, expect } from 'vitest';
import {
  ChatSessionEvents,
  UserEvents,
  StreamEvents,
  SessionEvents,
  isUserEvent,
  isStreamEvent,
  isSessionEvent,
  stripUserPrefix,
  type UserEventType,
} from '../src/index.js';

describe('ChatSessionEvents constants', () => {
  it('run_state 增量使用冻结逻辑名', () => {
    expect(ChatSessionEvents.RUN_STATE_UPDATED).toBe('chat.session.run_state.updated');
  });

  it('activity 增量使用冻结逻辑名', () => {
    expect(ChatSessionEvents.ACTIVITY_UPDATED).toBe('chat.session.activity.updated');
  });
});

describe('UserEvents constants', () => {
  it('常量分别对应 agent.user.<name>', () => {
    expect(UserEvents.TITLE_UPDATED).toBe('agent.user.title_updated');
    expect(UserEvents.NOTIFICATION_NEW).toBe('agent.user.notification.new');
    expect(UserEvents.PERMISSION_CHANGED).toBe('agent.user.permission.changed');
    expect(UserEvents.INTERACTION_REQUESTED).toBe('agent.user.interaction_requested');
    expect(UserEvents.INTERACTION_RESOLVED).toBe('agent.user.interaction_resolved');
    expect(UserEvents.INTERACTION_EXPIRED).toBe('agent.user.interaction_expired');
    expect(UserEvents.SESSION_CREATED).toBe('agent.user.session_created');
    expect(UserEvents.PROJECT_TASK_INVALIDATED).toBe('agent.user.project_task_invalidated');
  });

  it('UserEventType 联合涵盖所有常量值', () => {
    const all: UserEventType[] = [
      UserEvents.TITLE_UPDATED,
      UserEvents.NOTIFICATION_NEW,
      UserEvents.PERMISSION_CHANGED,
      UserEvents.INTERACTION_REQUESTED,
      UserEvents.INTERACTION_RESOLVED,
      UserEvents.INTERACTION_EXPIRED,
      UserEvents.SESSION_CREATED,
      UserEvents.PROJECT_TASK_INVALIDATED,
    ];
    expect(all).toHaveLength(Object.keys(UserEvents).length);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('isUserEvent / stripUserPrefix', () => {
  it('isUserEvent 识别 agent.user.* 前缀', () => {
    expect(isUserEvent('agent.user.title_updated')).toBe(true);
    expect(isUserEvent('agent.user.notification.new')).toBe(true);
    expect(isUserEvent('agent.user.anything')).toBe(true);
  });

  it('isUserEvent 不会把 stream/session 误判为 user', () => {
    expect(isUserEvent('agent.stream.assistant')).toBe(false);
    expect(isUserEvent('agent.session.decision_summary_ready')).toBe(false);
    expect(isUserEvent('user.something')).toBe(false);
    expect(isUserEvent('')).toBe(false);
  });

  it('与 isStreamEvent / isSessionEvent 三个 namespace 互斥', () => {
    const sample = 'agent.user.title_updated';
    expect(isUserEvent(sample)).toBe(true);
    expect(isStreamEvent(sample)).toBe(false);
    expect(isSessionEvent(sample)).toBe(false);
  });

  it('stripUserPrefix 去掉 agent.user. 前缀，非匹配原样返回', () => {
    expect(stripUserPrefix('agent.user.title_updated')).toBe('title_updated');
    expect(stripUserPrefix('agent.user.notification.new')).toBe('notification.new');
    expect(stripUserPrefix('agent.stream.assistant')).toBe('agent.stream.assistant');
    expect(stripUserPrefix('plain')).toBe('plain');
  });
});

describe('StreamEvents.TITLE_UPDATED 已退场（反退化保险）', () => {
  it('运行期：StreamEvents 不再带 TITLE_UPDATED 字段', () => {
    expect(Object.prototype.hasOwnProperty.call(StreamEvents, 'TITLE_UPDATED')).toBe(false);
    // 兜底：哪怕有 prototype 链兜底也别能拿到值
    expect((StreamEvents as Record<string, string>).TITLE_UPDATED).toBeUndefined();
  });

  it('编译期：StreamEvents 字面量值集中不含 agent.stream.title_updated', () => {
    const values = Object.values(StreamEvents) as string[];
    expect(values).not.toContain('agent.stream.title_updated');
  });

  it('SessionEvents 也不持有 TITLE_UPDATED（W0 决策：用户级事件归 UserEvents）', () => {
    expect(Object.prototype.hasOwnProperty.call(SessionEvents, 'TITLE_UPDATED')).toBe(false);
  });
});

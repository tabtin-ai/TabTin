/**
 * createSubagentStreamRouter 单测（W4a S2，2026-05-30）。
 *
 * sink 是子 Agent 实时流的 session 级统一出口（跨 query 存活）。本测试钉死它的
 * 路由决策（两端 host 共用同一纯路由器，故只需测一处）：
 *
 *   1. **前台 query 内行为不变**：getInQueryRelay 返回 interceptor 时——
 *      sendToActiveClient（IPC）+ inQueryRelay 都被调用、relayOutOfQuery 不调用
 *      （= 现有 `sender.send + eventInterceptor`，无额外 relay）。
 *   2. **query 外 SUBAGENT_PROGRESS 仍到 relay/sink**：getInQueryRelay 返回
 *      undefined（无活跃 query）时——relayOutOfQuery 被调用（事件不丢），
 *      inQueryRelay 不调用。
 *   3. Daemon 形态（无 sendToActiveClient）：in-query 仅 interceptor、
 *      out-of-query 仅 relayOutOfQuery。
 *   4. 单次投递：同一事件不会既走 interceptor 又走 relayOutOfQuery（不双发）。
 *   5. 异常隔离：任一回调抛错不影响其他路由 / 不外抛。
 */

import { describe, it, expect, vi } from 'vitest';
import { createSubagentStreamRouter } from '../src/delivery/subagent-stream-router.js';
import { StreamEvents } from '@tabtin/agent-wire';
import type { StreamEvent } from '@tabtin/agent-runtime'

function progressEvent(runId = 'child-1'): StreamEvent {
  return {
    type: StreamEvents.SUBAGENT_PROGRESS,
    payload: { subagent_run_id: runId, step_count: 1 },
  } as StreamEvent;
}

function streamWrapperEvent(runId = 'child-1'): StreamEvent {
  return {
    type: StreamEvents.SUBAGENT_STREAM_EVENT,
    payload: {
      subagent_run_id: runId,
      child_event: {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: { notice_type: 'tool_progress' },
      },
    },
  } as StreamEvent;
}

// ─── 1. 前台 query 内：等同 sender + interceptor ─────────────────────

describe('createSubagentStreamRouter: 前台 query 内（Electron 形态）', () => {
  it('in-query → sendToActiveClient + inQueryRelay；不走 relayOutOfQuery', () => {
    const sendToActiveClient = vi.fn();
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();

    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery,
    });

    const evt = progressEvent();
    sink(evt);

    expect(sendToActiveClient).toHaveBeenCalledTimes(1);
    expect(sendToActiveClient).toHaveBeenCalledWith(evt);
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
    expect(inQueryRelay).toHaveBeenCalledWith(evt);
    expect(relayOutOfQuery).not.toHaveBeenCalled();
  });

  it('getInQueryRelay 每次都重新读（sink 跨 query：先 in-query 后 out-of-query）', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    let interceptor: ((e: StreamEvent) => void) | undefined = inQueryRelay;

    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => interceptor,
      relayOutOfQuery,
    });

    // query 内
    sink(progressEvent('a'));
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
    expect(relayOutOfQuery).not.toHaveBeenCalled();

    // query 结束 → interceptor 清空
    interceptor = undefined;
    sink(progressEvent('b'));
    expect(inQueryRelay).toHaveBeenCalledTimes(1); // 仍 1
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1); // 现在走 out-of-query
  });
});

// ─── 2. query 外：事件不丢，走 relayOutOfQuery ───────────────────────

describe('createSubagentStreamRouter: query 外（后台子）', () => {
  it('out-of-query → relayOutOfQuery；不走 inQueryRelay', () => {
    const sendToActiveClient = vi.fn();
    const relayOutOfQuery = vi.fn();

    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => undefined, // 无活跃 query
      relayOutOfQuery,
    });

    const evt = progressEvent();
    sink(evt);

    // SUBAGENT_PROGRESS 仍到 relay（不丢）
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
    expect(relayOutOfQuery).toHaveBeenCalledWith(evt);
    // sendToActiveClient 仍尝试推（活跃客户端可能在，可能 destroyed → 内部守门）
    expect(sendToActiveClient).toHaveBeenCalledTimes(1);
  });

  it('out-of-query transient subagent stream wrappers stay client-only', () => {
    const sendToActiveClient = vi.fn();
    const relayOutOfQuery = vi.fn();

    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => undefined,
      relayOutOfQuery,
    });

    const evt = streamWrapperEvent();
    sink(evt);

    expect(sendToActiveClient).toHaveBeenCalledWith(evt);
    expect(relayOutOfQuery).not.toHaveBeenCalled();
  });
});

// ─── 3. Daemon 形态（无 sendToActiveClient）─────────────────────────

describe('createSubagentStreamRouter: Daemon 形态（无 IPC sender）', () => {
  it('in-query 仅 interceptor；out-of-query 仅 relayOutOfQuery', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    let interceptor: ((e: StreamEvent) => void) | undefined = inQueryRelay;

    const sink = createSubagentStreamRouter({
      // 无 sendToActiveClient（Daemon 所有流走 gateway relay）
      getInQueryRelay: () => interceptor,
      relayOutOfQuery,
    });

    sink(progressEvent('a'));
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
    expect(relayOutOfQuery).not.toHaveBeenCalled();

    interceptor = undefined;
    sink(progressEvent('b'));
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. 单次投递（不双发）────────────────────────────────────────────

describe('createSubagentStreamRouter: 单次投递', () => {
  it('同事件不会既走 inQueryRelay 又走 relayOutOfQuery', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery,
    });
    sink(progressEvent());
    // 二选一，绝不双发（否则 query 内 Django 会收到两份）
    expect(inQueryRelay.mock.calls.length + relayOutOfQuery.mock.calls.length).toBe(1);
  });
});

// ─── 5. 异常隔离 ──────────────────────────────────────────────────────

describe('createSubagentStreamRouter: 异常隔离', () => {
  it('sendToActiveClient 抛错 → 仍走 relay，不外抛', () => {
    const inQueryRelay = vi.fn();
    const sink = createSubagentStreamRouter({
      sendToActiveClient: () => { throw new Error('IPC dead'); },
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery: vi.fn(),
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
  });

  it('getInQueryRelay 抛错 → 退化为 out-of-query relay，不外抛', () => {
    const relayOutOfQuery = vi.fn();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => { throw new Error('lookup failed'); },
      relayOutOfQuery,
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
  });

  it('inQueryRelay 抛错被吞，不外抛', () => {
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => () => { throw new Error('relay boom'); },
      relayOutOfQuery: vi.fn(),
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
  });

  it('relayOutOfQuery 抛错被吞，不外抛', () => {
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => undefined,
      relayOutOfQuery: () => { throw new Error('gateway boom'); },
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
  });
});

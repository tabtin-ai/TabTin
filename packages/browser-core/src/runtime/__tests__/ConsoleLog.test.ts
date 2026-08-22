import { describe, it, expect } from 'vitest';
import { ConsoleLog } from '../ConsoleLog';
import {
  getSharedConsoleLog,
  getSharedNetworkLog,
  resetSharedRuntimeLogs,
} from '../index';
import type { CDPLogEvent } from '../types';

/**
 * BR-8 WS-B：ConsoleLog 历史缓冲单测。
 * 覆盖 Runtime.consoleAPICalled / Log.entryAdded 两类来源的归一、level 过滤、
 * RemoteObject 渲染、容量淘汰、多 tab 隔离，以及共享单例语义。
 */

function consoleApi(type: string, args: unknown[], opts?: { url?: string; timestamp?: number }): CDPLogEvent {
  return {
    method: 'Runtime.consoleAPICalled',
    params: {
      type,
      args,
      timestamp: opts?.timestamp,
      ...(opts?.url ? { stackTrace: { callFrames: [{ url: opts.url }] } } : {}),
    },
  };
}

function logEntry(level: string, text: string, url?: string): CDPLogEvent {
  return { method: 'Log.entryAdded', params: { entry: { level, text, url } } };
}

describe('ConsoleLog —— consoleAPICalled', () => {
  it('归一 console.* 调用：level/text/source', () => {
    const log = new ConsoleLog();
    log.record('t1', consoleApi('error', [{ type: 'string', value: 'boom' }], { url: 'https://x.com/app.js' }));
    const entries = log.query('t1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', text: 'boom', source: 'https://x.com/app.js' });
    expect(typeof entries[0].timestamp).toBe('number');
  });

  it('多参数拼接；对象类参数走 description/value', () => {
    const log = new ConsoleLog();
    log.record('t1', consoleApi('log', [
      { type: 'string', value: 'count' },
      { type: 'number', value: 42 },
      { type: 'object', description: 'Array(3)' },
    ]));
    expect(log.query('t1')[0].text).toBe('count 42 Array(3)');
  });

  it('CDP epoch 毫秒时间戳被沿用；缺失时退回 now', () => {
    const log = new ConsoleLog();
    const ts = 1_700_000_000_000;
    log.record('t1', consoleApi('log', [{ value: 'a' }], { timestamp: ts }));
    log.record('t1', consoleApi('log', [{ value: 'b' }]));
    const [first, second] = log.query('t1');
    expect(first.timestamp).toBe(ts);
    expect(second.timestamp).toBeGreaterThan(0);
  });
});

describe('ConsoleLog —— Log.entryAdded', () => {
  it('归一浏览器日志（网络错误/CSP 等）', () => {
    const log = new ConsoleLog();
    log.record('t1', logEntry('warning', 'Failed to load resource', 'https://x.com/missing.png'));
    expect(log.query('t1')[0]).toMatchObject({
      level: 'warning',
      text: 'Failed to load resource',
      source: 'https://x.com/missing.png',
    });
  });

  it('两类来源汇入同一 tab 的历史', () => {
    const log = new ConsoleLog();
    log.record('t1', consoleApi('log', [{ value: 'from-page' }]));
    log.record('t1', logEntry('error', 'from-browser'));
    expect(log.query('t1').map((e) => e.text)).toEqual(['from-page', 'from-browser']);
  });
});

describe('ConsoleLog —— 过滤 / 容量 / 隔离', () => {
  it('level 过滤精确匹配', () => {
    const log = new ConsoleLog();
    log.record('t1', consoleApi('log', [{ value: 'l' }]));
    log.record('t1', consoleApi('error', [{ value: 'e' }]));
    log.record('t1', consoleApi('warning', [{ value: 'w' }]));
    expect(log.query('t1', { level: 'error' }).map((e) => e.text)).toEqual(['e']);
  });

  it('limit 取最近 N', () => {
    const log = new ConsoleLog();
    for (let i = 1; i <= 4; i++) log.record('t1', consoleApi('log', [{ value: String(i) }]));
    expect(log.query('t1', { limit: 2 }).map((e) => e.text)).toEqual(['3', '4']);
  });

  it('超容量环形淘汰', () => {
    const log = new ConsoleLog(2);
    for (let i = 1; i <= 4; i++) log.record('t1', consoleApi('log', [{ value: String(i) }]));
    expect(log.size('t1')).toBe(2);
    expect(log.query('t1').map((e) => e.text)).toEqual(['3', '4']);
  });

  it('多 tab 隔离 + clear', () => {
    const log = new ConsoleLog();
    log.record('t1', consoleApi('log', [{ value: 'a' }]));
    log.record('t2', consoleApi('log', [{ value: 'b' }]));
    log.clear('t1');
    expect(log.query('t1')).toHaveLength(0);
    expect(log.query('t2')).toHaveLength(1);
  });

  it('query 返回拷贝，不可经返回值改动缓冲', () => {
    const log = new ConsoleLog();
    log.record('t1', consoleApi('log', [{ value: 'x' }]));
    const out = log.query('t1');
    out[0].text = 'mutated';
    expect(log.query('t1')[0].text).toBe('x');
  });
});

describe('runtime 共享单例', () => {
  it('getShared* 返回稳定实例；reset 后重建', () => {
    resetSharedRuntimeLogs();
    const a = getSharedConsoleLog();
    const b = getSharedConsoleLog();
    expect(a).toBe(b);
    expect(getSharedNetworkLog()).toBe(getSharedNetworkLog());
    resetSharedRuntimeLogs();
    expect(getSharedConsoleLog()).not.toBe(a);
  });
});

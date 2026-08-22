import { describe, it, expect } from 'vitest';
import { NetworkLog } from '../NetworkLog';
import type { CDPLogEvent } from '../types';

/**
 * BR-8 WS-B：NetworkLog 历史缓冲单测。
 * 钉住「CDP 事件 → 按 requestId 关联 → 历史 entry」的核心行为：关联、过滤、
 * 容量环形淘汰、include-* 头投影 + 脱敏、重定向归一、多 tab 隔离。
 */

function req(requestId: string, url: string, opts?: { method?: string; type?: string; headers?: Record<string, string> }): CDPLogEvent {
  return {
    method: 'Network.requestWillBeSent',
    params: {
      requestId,
      type: opts?.type,
      request: { url, method: opts?.method ?? 'GET', headers: opts?.headers },
    },
  };
}

function resp(requestId: string, opts?: { status?: number; mimeType?: string; type?: string; headers?: Record<string, string> }): CDPLogEvent {
  return {
    method: 'Network.responseReceived',
    params: {
      requestId,
      type: opts?.type,
      response: { status: opts?.status, mimeType: opts?.mimeType, headers: opts?.headers },
    },
  };
}

function finished(requestId: string, encodedDataLength: number): CDPLogEvent {
  return { method: 'Network.loadingFinished', params: { requestId, encodedDataLength } };
}

describe('NetworkLog —— 关联与历史', () => {
  it('把 request/response/finished 关联进同一条 entry', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/a', { method: 'POST', type: 'XHR' }));
    log.record('t1', resp('1', { status: 200, mimeType: 'application/json' }));
    log.record('t1', finished('1', 1234));

    const entries = log.query('t1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: '1',
      url: 'https://x.com/a',
      method: 'POST',
      status: 200,
      resourceType: 'XHR',
      mimeType: 'application/json',
      size: 1234,
    });
    expect(typeof entries[0].timestamp).toBe('number');
  });

  it('多条请求按时间序返回，response 缺失也保留为历史（无 status）', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/a'));
    log.record('t1', req('2', 'https://x.com/b'));
    log.record('t1', resp('2', { status: 404 }));

    const entries = log.query('t1');
    expect(entries.map((e) => e.requestId)).toEqual(['1', '2']);
    expect(entries[0].status).toBeUndefined();
    expect(entries[1].status).toBe(404);
  });

  it('历史 ≠ 窗口快照：record 后任意时刻 query 都能拿到既往条目', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/early'));
    log.record('t1', resp('1', { status: 200 }));
    // 没有挂临时监听窗口，过后查仍在
    expect(log.query('t1')).toHaveLength(1);
  });
});

describe('NetworkLog —— 过滤 / limit', () => {
  it('filter 正则匹配 url/method/type/mime/status', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/api/users', { type: 'XHR' }));
    log.record('t1', req('2', 'https://x.com/img/logo.png', { type: 'Image' }));
    log.record('t1', resp('1', { status: 200, mimeType: 'application/json' }));
    log.record('t1', resp('2', { status: 200, mimeType: 'image/png' }));

    expect(log.query('t1', { filter: 'users' }).map((e) => e.requestId)).toEqual(['1']);
    expect(log.query('t1', { filter: 'image/png' }).map((e) => e.requestId)).toEqual(['2']);
    expect(log.query('t1', { filter: 'XHR' }).map((e) => e.requestId)).toEqual(['1']);
  });

  it('limit 只取最近 N 条（保持时间序）', () => {
    const log = new NetworkLog();
    for (let i = 1; i <= 5; i++) log.record('t1', req(String(i), `https://x.com/${i}`));
    expect(log.query('t1', { limit: 2 }).map((e) => e.requestId)).toEqual(['4', '5']);
  });

  it('runId 过滤', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/a'), { runId: 'run-A' });
    log.record('t1', req('2', 'https://x.com/b'), { runId: 'run-B' });
    expect(log.query('t1', { runId: 'run-A' }).map((e) => e.requestId)).toEqual(['1']);
  });
});

describe('NetworkLog —— 容量环形淘汰', () => {
  it('超容量从头淘汰，且同步清掉 requestId 索引', () => {
    const log = new NetworkLog(3);
    for (let i = 1; i <= 5; i++) log.record('t1', req(String(i), `https://x.com/${i}`));
    expect(log.size('t1')).toBe(3);
    expect(log.query('t1').map((e) => e.requestId)).toEqual(['3', '4', '5']);
    // 被淘汰的 '1' 即使后到 response 也不复活
    log.record('t1', resp('1', { status: 200 }));
    expect(log.query('t1').map((e) => e.requestId)).toEqual(['3', '4', '5']);
  });
});

describe('NetworkLog —— include-* 投影与脱敏', () => {
  it('默认不带 headers；include 时返回且对敏感头打码', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/a', {
      headers: { Cookie: 'secret=1', 'X-Trace': 'abc' },
    }));
    log.record('t1', resp('1', {
      status: 200,
      headers: { 'set-cookie': 'sid=2', 'content-type': 'text/html' },
    }));

    const noHeaders = log.query('t1')[0];
    expect(noHeaders.requestHeaders).toBeUndefined();
    expect(noHeaders.responseHeaders).toBeUndefined();

    const withHeaders = log.query('t1', {
      includeRequestHeaders: true,
      includeResponseHeaders: true,
    })[0];
    expect(withHeaders.requestHeaders).toEqual({ Cookie: '[redacted]', 'X-Trace': 'abc' });
    expect(withHeaders.responseHeaders).toEqual({ 'set-cookie': '[redacted]', 'content-type': 'text/html' });
  });

  it('url 查询串里的敏感参数被打码', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/a?access_token=zzz&page=1'));
    const out = log.query('t1')[0];
    expect(out.url).toContain('access_token=%5Bredacted%5D');
    expect(out.url).toContain('page=1');
  });
});

describe('NetworkLog —— body 捕获与脱敏（P3b）', () => {
  it('请求体默认不返回；include 时按敏感 key 打码', () => {
    const log = new NetworkLog();
    log.record('t1', {
      method: 'Network.requestWillBeSent',
      params: {
        requestId: '1',
        type: 'XHR',
        request: {
          url: 'https://x.com/api',
          method: 'POST',
          postData: '{"page":1,"token":"secret"}',
        },
      },
    });

    expect(log.query('t1')[0].requestBody).toBeUndefined();
    const detailed = log.query('t1', { includeRequestBody: true })[0];
    expect(detailed.requestBody).toBe('{"page":1,"token":"[redacted]"}');
  });

  it('响应体经 recordBody 回填，include 时按敏感 key 打码', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/api', { type: 'XHR' }));
    log.record('t1', resp('1', { status: 200, mimeType: 'application/json' }));
    log.recordBody('t1', '1', {
      responseBody: '{"items":[1],"refresh_token":"secret-refresh"}',
      responseBodyBase64Encoded: false,
    });

    expect(log.query('t1')[0].responseBody).toBeUndefined();
    const detailed = log.query('t1', { includeResponseBody: true })[0];
    expect(detailed.responseBody).toBe('{"items":[1],"refresh_token":"[redacted]"}');
    expect(detailed.responseBodyBase64Encoded).toBe(false);
  });

  it('recordBody 对已淘汰的 requestId 不复活', () => {
    const log = new NetworkLog(2);
    for (let i = 1; i <= 3; i++) log.record('t1', req(String(i), `https://x.com/${i}`));
    // '1' 已被淘汰
    log.recordBody('t1', '1', { responseBody: 'late' });
    expect(log.query('t1').map((e) => e.requestId)).toEqual(['2', '3']);
  });

  it('loadingFailed 落 responseBodyError（始终透传，不受 include 门控）', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/api'));
    log.record('t1', {
      method: 'Network.loadingFailed',
      params: { requestId: '1', errorText: 'net::ERR_TIMED_OUT' },
    });
    expect(log.query('t1')[0].responseBodyError).toBe('net::ERR_TIMED_OUT');
  });
});

describe('NetworkLog —— 重定向与多 tab', () => {
  it('同 requestId 再次 requestWillBeSent 视为重定向、归一到最终请求', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/old'));
    log.record('t1', req('1', 'https://x.com/new'));
    const entries = log.query('t1');
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://x.com/new');
  });

  it('不同 tab 的历史互相隔离；clear 只清指定 tab', () => {
    const log = new NetworkLog();
    log.record('t1', req('1', 'https://x.com/a'));
    log.record('t2', req('2', 'https://y.com/b'));
    expect(log.query('t1')).toHaveLength(1);
    expect(log.query('t2')).toHaveLength(1);
    log.clear('t1');
    expect(log.query('t1')).toHaveLength(0);
    expect(log.query('t2')).toHaveLength(1);
  });
});

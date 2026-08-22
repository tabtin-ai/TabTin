import { describe, it, expect } from 'vitest';
import {
  BrowserJobManager,
  getSharedBrowserJobManager,
  resetSharedBrowserJobManager,
  shutdownSharedBrowserJobManager,
} from '../BrowserJobManager';

/**
 * BR-10 P0：BrowserJobManager 单测。
 * 钉住长任务句柄的生命周期：create→running、reportProgress 更新、complete/fail 终态、
 * cancel→signal.aborted + status=cancelled、终态守卫（cancelled 不被晚到的 fail 覆盖）、
 * list/get、共享单例。
 */

describe('BrowserJobManager —— create', () => {
  it('create 起一个 running job，返回 id + 未中止的 signal', () => {
    const mgr = new BrowserJobManager();
    const { id, signal } = mgr.create('stream.download', { url: 'https://x/y.m3u8' });
    expect(id).toBeTruthy();
    expect(signal.aborted).toBe(false);

    const rec = mgr.get(id)!;
    expect(rec.status).toBe('running');
    expect(rec.actionId).toBe('stream.download');
    expect(rec.progress).toEqual({ phase: 'initializing', percent: 0 });
    expect(rec.createdAt).toBeTypeOf('number');
    expect(rec.updatedAt).toBe(rec.createdAt);
  });

  it('每次 create 的 id 唯一', () => {
    const mgr = new BrowserJobManager();
    const ids = new Set(Array.from({ length: 50 }, () => mgr.create('a').id));
    expect(ids.size).toBe(50);
  });
});

describe('BrowserJobManager —— reportProgress', () => {
  it('running 态下更新 progress 与 updatedAt', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    const before = mgr.get(id)!.updatedAt;
    const progress = { phase: 'downloading', percent: 42, completed: 21, total: 50, detail: '21/50' };
    mgr.reportProgress(id, progress);

    const rec = mgr.get(id)!;
    expect(rec.progress).toEqual(progress);
    expect(rec.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('终态后 reportProgress 被忽略', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    mgr.complete(id, { path: '/tmp/out.ts' });
    mgr.reportProgress(id, { phase: 'downloading', percent: 50 });
    expect(mgr.get(id)!.progress).toEqual({ phase: 'done', percent: 100 });
  });

  it('未知 jobId 静默忽略', () => {
    const mgr = new BrowserJobManager();
    expect(() => mgr.reportProgress('nope', { phase: 'x', percent: 1 })).not.toThrow();
  });
});

describe('BrowserJobManager —— complete / fail', () => {
  it('complete 置 completed + result + 进度 100', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    mgr.complete(id, { path: '/tmp/out.ts', segments: 50 });
    const rec = mgr.get(id)!;
    expect(rec.status).toBe('completed');
    expect(rec.result).toEqual({ path: '/tmp/out.ts', segments: 50 });
    expect(rec.progress).toEqual({ phase: 'done', percent: 100 });
  });

  it('fail 置 failed + 结构化 error（普通 Error → job_failed）', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    mgr.fail(id, new Error('网络炸了'));
    const rec = mgr.get(id)!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toEqual({ code: 'job_failed', message: '网络炸了' });
  });

  it('fail 识别携 info 的结构化错误（如 BrowserActionError）', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    const structured = { info: { code: 'url_blocked', message: '域名不可达', retryable: false } };
    mgr.fail(id, structured);
    expect(mgr.get(id)!.error).toEqual({ code: 'url_blocked', message: '域名不可达', retryable: false });
  });

  it('AbortError → error.code = aborted', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    const err = new Error('aborted');
    err.name = 'AbortError';
    mgr.fail(id, err);
    expect(mgr.get(id)!.error?.code).toBe('aborted');
  });

  it('终态守卫：completed 后再 fail 不改写', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    mgr.complete(id, { ok: true });
    mgr.fail(id, new Error('迟到的失败'));
    expect(mgr.get(id)!.status).toBe('completed');
  });
});

describe('BrowserJobManager —— cancel', () => {
  it('cancel 触发 signal.aborted 并置 cancelled，返回 true', () => {
    const mgr = new BrowserJobManager();
    const { id, signal } = mgr.create('stream.download');
    expect(mgr.cancel(id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(mgr.get(id)!.status).toBe('cancelled');
  });

  it('cancelled 后晚到的 fail（AbortError）不覆盖 cancelled', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    mgr.cancel(id);
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    mgr.fail(id, err);
    expect(mgr.get(id)!.status).toBe('cancelled');
  });

  it('cancelled 后晚到的 complete 也不覆盖', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    mgr.cancel(id);
    mgr.complete(id, { path: '/tmp/late.ts' });
    expect(mgr.get(id)!.status).toBe('cancelled');
  });

  it('重复 cancel / 终态 cancel 返回 false', () => {
    const mgr = new BrowserJobManager();
    const { id } = mgr.create('stream.download');
    expect(mgr.cancel(id)).toBe(true);
    expect(mgr.cancel(id)).toBe(false);

    const { id: id2 } = mgr.create('stream.download');
    mgr.complete(id2);
    expect(mgr.cancel(id2)).toBe(false);
  });

  it('未知 jobId cancel 返回 false', () => {
    const mgr = new BrowserJobManager();
    expect(mgr.cancel('nope')).toBe(false);
  });
});

describe('BrowserJobManager —— get / list', () => {
  it('get 未知 jobId 返回 undefined', () => {
    const mgr = new BrowserJobManager();
    expect(mgr.get('nope')).toBeUndefined();
  });

  it('list 返回全部 job', () => {
    const mgr = new BrowserJobManager();
    const a = mgr.create('stream.download').id;
    const b = mgr.create('resource.smart-download').id;
    const ids = mgr.list().map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(mgr.list()).toHaveLength(2);
  });
});

describe('BrowserJobManager —— TTL / shutdown', () => {
  it('cleanupExpired 会移除超过终态 TTL 的 completed job', () => {
    let now = 1_000;
    const mgr = new BrowserJobManager({
      terminalJobTtlMs: 100,
      runningJobTtlMs: 10_000,
      cleanupIntervalMs: 0,
      now: () => now,
    });
    const { id } = mgr.create('stream.download');
    mgr.complete(id, { ok: true });

    now += 99;
    expect(mgr.cleanupExpired()).toBe(0);
    expect(mgr.get(id)).toBeDefined();

    now += 1;
    expect(mgr.cleanupExpired()).toBe(1);
    expect(mgr.get(id)).toBeUndefined();
  });

  it('cleanupExpired 会取消超过 running TTL 的孤儿 job，但先保留 cancelled 终态供查询', () => {
    let now = 5_000;
    const mgr = new BrowserJobManager({
      terminalJobTtlMs: 100,
      runningJobTtlMs: 50,
      cleanupIntervalMs: 0,
      now: () => now,
    });
    const { id, signal } = mgr.create('replay.run');

    now += 50;
    expect(mgr.cleanupExpired()).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(mgr.get(id)!.status).toBe('cancelled');

    now += 100;
    expect(mgr.cleanupExpired()).toBe(1);
    expect(mgr.get(id)).toBeUndefined();
  });

  it('shutdown 停止 manager：abort running job、清空记录，并拒绝后续 create', () => {
    const mgr = new BrowserJobManager({ cleanupIntervalMs: 0 });
    const { signal } = mgr.create('stream.download');
    mgr.complete(mgr.create('resource.smart-download').id);

    expect(mgr.shutdown()).toBe(2);
    expect(signal.aborted).toBe(true);
    expect(mgr.list()).toHaveLength(0);
    expect(() => mgr.create('stream.download')).toThrow(/shut down/);
  });
});

describe('BrowserJobManager —— 共享单例', () => {
  it('getSharedBrowserJobManager 返回同一实例；reset 后换新实例', () => {
    resetSharedBrowserJobManager();
    const a = getSharedBrowserJobManager();
    const { id } = a.create('stream.download');
    expect(getSharedBrowserJobManager()).toBe(a);
    expect(getSharedBrowserJobManager().get(id)).toBeDefined();

    resetSharedBrowserJobManager();
    const b = getSharedBrowserJobManager();
    expect(b).not.toBe(a);
    expect(b.get(id)).toBeUndefined();
  });

  it('shutdownSharedBrowserJobManager 清空共享单例并允许下次重新创建', () => {
    resetSharedBrowserJobManager();
    const a = getSharedBrowserJobManager();
    const { id, signal } = a.create('stream.download');
    shutdownSharedBrowserJobManager();
    expect(signal.aborted).toBe(true);

    const b = getSharedBrowserJobManager();
    expect(b).not.toBe(a);
    expect(b.get(id)).toBeUndefined();
    resetSharedBrowserJobManager();
  });
});

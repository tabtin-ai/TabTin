/**
 * RP-030 回归测试 — EventPersistence 初始化安全
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-run-events',
  },
}));

describe('RP-030: EventPersistence 初始化安全', () => {
  it('初始化前 flushTimer 应为 null', async () => {
    const { EventPersistence } = await import('../EventPersistence');
    const ep = new EventPersistence('/tmp/test-ep-rp030-' + Date.now());

    expect((ep as any).flushTimer).toBeNull();
    expect((ep as any).initialized).toBe(false);

    await ep.destroy();
  });

  it('初始化成功后 flushTimer 应存在', async () => {
    const { EventPersistence } = await import('../EventPersistence');
    const ep = new EventPersistence('/tmp/test-ep-rp030-success-' + Date.now());

    await ep.init();

    expect((ep as any).flushTimer).not.toBeNull();
    expect((ep as any).initialized).toBe(true);

    await ep.destroy();

    expect((ep as any).flushTimer).toBeNull();
  });

  it('多次调用 init 不应创建多个定时器', async () => {
    const { EventPersistence } = await import('../EventPersistence');
    const ep = new EventPersistence('/tmp/test-ep-rp030-multi-' + Date.now());

    await ep.init();
    const firstTimer = (ep as any).flushTimer;

    await ep.init();
    const secondTimer = (ep as any).flushTimer;

    expect(firstTimer).toBe(secondTimer);

    await ep.destroy();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { animateCursorTo, pulseCursor, glideCursorTo, hideCursor, buildHideCursorScript } from '../AgentCursor';
import type { BrowserContext } from '../../context/BrowserContext';

function fakeCtx(executeScript: (code: string) => Promise<unknown>): BrowserContext {
  return {
    isAlive: () => true,
    sendCDP: vi.fn(),
    onCDPEvent: vi.fn(),
    executeScript: executeScript as BrowserContext['executeScript'],
    loadURL: vi.fn(),
    getCurrentURL: () => 'https://example.com',
    getTitle: vi.fn(),
    captureScreenshot: vi.fn(),
    detach: vi.fn(),
  } as unknown as BrowserContext;
}

afterEach(() => vi.useRealTimers());

describe('animateCursorTo', () => {
  it('注入脚本包含 moveTo 调用与坐标', async () => {
    let injected = '';
    const ctx = fakeCtx(async (code) => { injected = code; });
    await animateCursorTo(ctx, 123, 456);
    expect(injected).toContain('__tabtinAgentCursorMoveTo(123, 456)');
    expect(injected).toContain('__tabtinAgentCursorEnsure()');
  });

  it('executeScript 抛错时静默不外抛', async () => {
    const ctx = fakeCtx(async () => { throw new Error('boom'); });
    await expect(animateCursorTo(ctx, 1, 2)).resolves.toBeUndefined();
  });

  it('动画卡死时 1.5s 兜底放行', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx(() => new Promise(() => {})); // 永不 resolve
    const p = animateCursorTo(ctx, 1, 2);
    await vi.advanceTimersByTimeAsync(1600);
    await expect(p).resolves.toBeUndefined();
  });

  it('超时胜出后延迟 reject 被吞掉', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error('late')), 2000);
    }));
    const p = animateCursorTo(ctx, 1, 2);
    await vi.advanceTimersByTimeAsync(1600);
    await expect(p).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000); // late reject fires; must not throw
  });
});

describe('pulseCursor / glideCursorTo', () => {
  it('fire-and-forget，异常静默', () => {
    const ctx = fakeCtx(async () => { throw new Error('boom'); });
    expect(() => pulseCursor(ctx, 'click')).not.toThrow();
    expect(() => glideCursorTo(ctx, 10, 20, 100)).not.toThrow();
  });
});

describe('hideCursor', () => {
  it('注入 hide 且不 ensure', () => {
    let injected = '';
    const ctx = fakeCtx(async (code) => { injected = code; });
    hideCursor(ctx);
    expect(buildHideCursorScript()).toContain('__tabtinAgentCursorHide()');
    expect(buildHideCursorScript()).not.toMatch(/__tabtinAgentCursorEnsure\(\);\s*__tabtinAgentCursorHide/);
    return Promise.resolve().then(() => {
      expect(injected).toContain('__tabtinAgentCursorHide()');
      expect(injected).not.toMatch(/__tabtinAgentCursorEnsure\(\);\s*__tabtinAgentCursorHide/);
    });
  });

  it('executeScript 抛错时静默', () => {
    const ctx = fakeCtx(async () => { throw new Error('boom'); });
    expect(() => hideCursor(ctx)).not.toThrow();
  });
});

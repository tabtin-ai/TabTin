import { describe, it, expect, vi } from 'vitest';
import { waitForDomSettle } from '../dom-settle';
import type { BrowserContext } from '../../context/BrowserContext';

function makeCtx(overrides: Partial<BrowserContext>): BrowserContext {
  return {
    isAlive: () => true,
    sendCDP: vi.fn(),
    onCDPEvent: vi.fn(() => () => {}),
    executeScript: vi.fn(),
    loadURL: vi.fn(),
    getCurrentURL: () => '',
    getTitle: vi.fn(async () => ''),
    captureScreenshot: vi.fn(async () => Buffer.from('')),
    detach: vi.fn(async () => {}),
    ...overrides,
  } as BrowserContext;
}

describe('waitForDomSettle', () => {
  it('ctx 已失效时直接返回 false，不执行脚本', async () => {
    const executeScript = vi.fn();
    const ctx = makeCtx({ isAlive: () => false, executeScript });
    await expect(waitForDomSettle(ctx)).resolves.toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('脚本判定 settled 时返回 true', async () => {
    const ctx = makeCtx({ executeScript: vi.fn(async () => true) });
    await expect(waitForDomSettle(ctx)).resolves.toBe(true);
  });

  it('脚本判定 unsettled 时返回 false', async () => {
    const ctx = makeCtx({ executeScript: vi.fn(async () => false) });
    await expect(waitForDomSettle(ctx)).resolves.toBe(false);
  });

  it('脚本抛错时吞掉并返回 false（best-effort，不抛错）', async () => {
    const ctx = makeCtx({
      executeScript: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(waitForDomSettle(ctx)).resolves.toBe(false);
  });

  it('maxWaitMs 透传进注入脚本', async () => {
    const executeScript = vi.fn(async () => true);
    const ctx = makeCtx({ executeScript });
    await waitForDomSettle(ctx, 3000);
    const script = executeScript.mock.calls[0][0] as string;
    expect(script).toContain('3000');
  });

  it('页面执行上下文销毁导致脚本永不返回时，由宿主硬超时降级为 false', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeCtx({
        executeScript: vi.fn(() => new Promise(() => {})),
      });
      const pending = waitForDomSettle(ctx, 100);

      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

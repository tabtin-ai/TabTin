/**
 * ：元素类错误（确定性 DOM 状态）不进 withRetry 整体重试——
 * 单次尝试内已含元素轮询 + 语义重定位 + 重试，整体重跑只会把真实错误
 * 拖过 CLI transport 25s cap、被掩成 CONNECTION_TIMEOUT。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BrowserToolImpl } from '../BrowserToolImpl';
import { ToolErrorCode, ToolErrorFactory } from '../types/errors';

function failingFn(code: ToolErrorCode) {
  return vi.fn(async () => ({
    success: false,
    error: ToolErrorFactory.retriable(code, `err:${code}`),
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry 元素类错误不整体重试', () => {
  it.each([
    ToolErrorCode.ELEMENT_NOT_FOUND,
    ToolErrorCode.ELEMENT_NOT_VISIBLE,
    ToolErrorCode.ELEMENT_NOT_INTERACTABLE,
    ToolErrorCode.REF_SEMANTIC_RELOCATE_FAILED,
  ])('%s：只执行一次，立即返回真实错误', async (code) => {
    const impl = new BrowserToolImpl();
    const fn = failingFn(code);

    const result = await (impl as any).withRetry('act', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(code);
  });

  it('网络类错误（NETWORK_ERROR）仍走整体重试到上限', async () => {
    vi.useFakeTimers();
    const impl = new BrowserToolImpl();
    const fn = failingFn(ToolErrorCode.NETWORK_ERROR);

    const promise = (impl as any).withRetry('act', fn);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
  });

  it('成功结果不受影响，直接返回', async () => {
    const impl = new BrowserToolImpl();
    const fn = vi.fn(async () => ({ success: true }));

    const result = await (impl as any).withRetry('act', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

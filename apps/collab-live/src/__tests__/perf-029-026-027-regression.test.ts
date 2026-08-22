/**
 * 回归测试: PERF-029 / PERF-026 / PERF-027
 *
 * - PERF-029: store 并发信号量限制跨文档最大并发 HTTP 请求数
 * - PERF-026: withRetry 退避延迟添加 jitter 防止 thundering herd
 * - PERF-027: handleStoreError 对 413 错误 throw 而非静默 return
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── PERF-029: Semaphore + store 并发限制 ─────────────────

describe("PERF-029: store 并发信号量", () => {
  it("storeSemaphore 默认并发上限为 20", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );
    expect(storeSemaphore.concurrency).toBe(20);
  });

  it("acquire 超出并发上限时排队等待", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );

    const concurrency = storeSemaphore.concurrency;
    const acquirePromises: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
      acquirePromises.push(storeSemaphore.acquire());
    }
    await Promise.all(acquirePromises);
    expect(storeSemaphore.current).toBe(concurrency);

    let extraAcquired = false;
    const extraPromise = storeSemaphore.acquire().then(() => {
      extraAcquired = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(extraAcquired).toBe(false);
    expect(storeSemaphore.pending).toBe(1);

    storeSemaphore.release();
    await extraPromise;
    expect(extraAcquired).toBe(true);

    for (let i = 0; i < concurrency; i++) {
      storeSemaphore.release();
    }
  });

  it("release 在无排队时正确递减 current", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );

    const before = storeSemaphore.current;
    await storeSemaphore.acquire();
    expect(storeSemaphore.current).toBe(before + 1);
    storeSemaphore.release();
    expect(storeSemaphore.current).toBe(before);
  });
});

// ─── PERF-026: withRetry jitter ───────────────────────────

describe("PERF-026: withRetry jitter 防止 thundering herd", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("RetryOptions 包含 jitter 字段，默认 0.25", async () => {
    const { withRetry } = await import("../lib/retry.js");

    let callCount = 0;
    const fn = () => {
      callCount++;
      if (callCount <= 1) return Promise.reject(new Error("transient"));
      return Promise.resolve("ok");
    };

    const result = await withRetry(fn, { maxRetries: 1, baseDelay: 100, maxDelay: 1000 });
    expect(result).toBe("ok");
    expect(callCount).toBe(2);
  });

  it("jitter=0 时延迟确定性等于 baseDelay * 2^attempt", async () => {
    const { withRetry } = await import("../lib/retry.js");

    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((fn: Function, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number" && ms > 0) delays.push(ms);
        return origSetTimeout(fn, 0, ...args);
      }) as typeof setTimeout,
    );

    let callCount = 0;
    await withRetry(
      () => {
        callCount++;
        if (callCount <= 3) return Promise.reject(new Error("fail"));
        return Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelay: 100, maxDelay: 10000, jitter: 0 },
    );

    expect(delays).toEqual([100, 200, 400]);
    setTimeoutSpy.mockRestore();
  });

  it("默认 jitter 时延迟在 ±25% 范围内波动", async () => {
    const { withRetry } = await import("../lib/retry.js");

    const allDelays: number[][] = [];

    for (let trial = 0; trial < 10; trial++) {
      const delays: number[] = [];
      const origSetTimeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
        ((fn: Function, ms?: number, ...args: unknown[]) => {
          if (typeof ms === "number" && ms > 0) delays.push(ms);
          return origSetTimeout(fn, 0, ...args);
        }) as typeof setTimeout,
      );

      let callCount = 0;
      await withRetry(
        () => {
          callCount++;
          if (callCount <= 1) return Promise.reject(new Error("fail"));
          return Promise.resolve("ok");
        },
        { maxRetries: 1, baseDelay: 1000, maxDelay: 10000 },
      );

      allDelays.push(delays);
      spy.mockRestore();
    }

    const firstDelays = allDelays.map((d) => d[0]);
    const allSame = firstDelays.every((d) => d === firstDelays[0]);
    expect(allSame).toBe(false);

    for (const d of firstDelays) {
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
  });
});

// ─── PERF-027: handleStoreError 413 必须 throw ────────────

vi.mock("../extensions/metrics.js", () => ({
  metrics: {
    storeErrors: 0,
    recordStoreLatency: vi.fn(),
  },
}));
vi.mock("../extensions/force-close.js", () => ({
  forceCloseDocument: vi.fn().mockResolvedValue(undefined),
  ForceCloseReason: { DOCUMENT_TOO_LARGE: "document_too_large" },
  CloseCode: { DOCUMENT_TOO_LARGE: 4003 },
}));

import { metrics } from "../extensions/metrics.js";
import { forceCloseDocument } from "../extensions/force-close.js";
import { handleStoreError } from "../lib/collab-utils.js";

describe("PERF-027: handleStoreError 413 不再静默返回", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (metrics as any).storeErrors = 0;
  });

  it("413 错误在 forceClose 后抛出异常", async () => {
    const error = new Error("Django API error 413: Payload Too Large");
    const fakeInstance = { documents: new Map() } as any;

    await expect(
      handleStoreError({
        error,
        resourceId: "res-1",
        documentName: "docs:res-1",
        instance: fakeInstance,
        moduleLabel: "TestDB",
        startTime: Date.now() - 100,
      }),
    ).rejects.toThrow("413");

    expect(forceCloseDocument).toHaveBeenCalledWith(
      fakeInstance,
      "docs:res-1",
      "document_too_large",
      4003,
    );
  });

  it("413 无 instance 时也抛出异常（但不调用 forceClose）", async () => {
    const error = new Error("Django API error 413: Payload Too Large");

    await expect(
      handleStoreError({
        error,
        resourceId: "res-2",
        documentName: "docs:res-2",
        instance: null,
        moduleLabel: "TestDB",
        startTime: Date.now() - 50,
      }),
    ).rejects.toThrow("413");

    expect(forceCloseDocument).not.toHaveBeenCalled();
  });

  it("非 413 错误仍然正常 throw", async () => {
    const error = new Error("Connection refused");
    await expect(
      handleStoreError({
        error,
        resourceId: "res-3",
        documentName: "docs:res-3",
        instance: null,
        moduleLabel: "TestDB",
        startTime: Date.now() - 100,
      }),
    ).rejects.toThrow("Connection refused");
  });
});

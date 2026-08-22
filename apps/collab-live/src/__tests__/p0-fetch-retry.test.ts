/**
 * P0-1 回归测试 — onFetch 重试机制
 *
 * 验证 base-collab-database 和 database (TabDoc) 的 fetch 路径
 * 在遇到瞬时错误时会重试，在遇到 404 时立即失败。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../env.js", () => ({
  env: {
    DJANGO_API_URL: "http://localhost:6060",
    LIVE_SECRET: "test-secret",
    SERVER_NAME: "test-server",
  },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("BaseCollabDatabase._fetchDocument retry (P0-1)", () => {
  it("retries fetchCollabSnapshot on 500 and recovers", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        };
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            status: "ok",
            data: { id: "tbl-1", rows: [] },
          }),
      };
    }) as any;

    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");

    const result = await withRetry(
      () => fetchCollabSnapshot("table", "tbl-1"),
      { label: "Test-Fetch", maxRetries: 2, baseDelay: 1, maxDelay: 2 },
    );

    expect(result).toEqual({ id: "tbl-1", rows: [] });
    expect(callCount).toBe(2);
  });

  it("does NOT retry fetchCollabSnapshot on 404", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      };
    }) as any;

    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");

    await expect(
      withRetry(
        () => fetchCollabSnapshot("table", "tbl-1"),
        { label: "Test-Fetch", maxRetries: 2, baseDelay: 1, maxDelay: 2 },
      ),
    ).rejects.toThrow("404");

    expect(callCount).toBe(1);
  });

  it("retries fetchCollabSnapshot on network error and recovers", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("fetch failed: ECONNREFUSED");
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            status: "ok",
            data: { id: "tbl-1" },
          }),
      };
    }) as any;

    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");

    const result = await withRetry(
      () => fetchCollabSnapshot("table", "tbl-1"),
      { label: "Test-Fetch", maxRetries: 2, baseDelay: 1, maxDelay: 2 },
    );

    expect(result).toEqual({ id: "tbl-1" });
    expect(callCount).toBe(2);
  });
});

describe("TabDoc fetchDocumentBinary retry (P0-1)", () => {
  it("retries fetchDocumentBinary on 500 and recovers", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        };
      }
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            status: "ok",
            data: {
              binary_b64: Buffer.from("hello").toString("base64"),
              has_binary: true,
            },
          }),
      };
    }) as any;

    const { fetchDocumentBinary } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");

    const result = await withRetry(
      () => fetchDocumentBinary("doc-1"),
      { label: "Test-Fetch", maxRetries: 2, baseDelay: 1, maxDelay: 2 },
    );

    expect(result.has_binary).toBe(true);
    expect(callCount).toBe(2);
  });

  it("does NOT retry fetchDocumentBinary on 404", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      };
    }) as any;

    const { fetchDocumentBinary } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");

    await expect(
      withRetry(
        () => fetchDocumentBinary("doc-1"),
        { label: "Test-Fetch", maxRetries: 2, baseDelay: 1, maxDelay: 2 },
      ),
    ).rejects.toThrow("404");

    expect(callCount).toBe(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../env.js", () => ({
  env: {
    DJANGO_API_URL: "http://localhost:6060",
    LIVE_SECRET: "test-secret",
    SERVER_NAME: "test-server",
  },
}));

import {
  fetchCollabSnapshot,
  persistCollabChanges,
  fetchDocumentBinary,
  verifyCollabAccess,
} from "./django-api.js";

const originalFetch = globalThis.fetch;

function mockHangingFetch() {
  globalThis.fetch = vi.fn((_url: string, opts?: RequestInit) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    }),
  ) as any;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("fetchJSON timeout (P0-2)", () => {
  it("throws timeout error when Django does not respond within 15s", async () => {
    mockHangingFetch();

    const promise = fetchCollabSnapshot("table", "tbl-1");

    await Promise.all([
      expect(promise).rejects.toThrow(/timeout after 15000ms/),
      vi.advanceTimersByTimeAsync(15_001),
    ]);
  });

  it("succeeds when Django responds before timeout", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok", data: { id: "tbl-1" } }),
    }) as any;

    const result = await fetchCollabSnapshot("table", "tbl-1");
    expect(result).toEqual({ id: "tbl-1" });
  });

  it("includes AbortSignal in fetch options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok", data: { key: "val" } }),
    }) as any;

    await fetchCollabSnapshot("table", "tbl-1");

    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("passes timeout to persistCollabChanges as well", async () => {
    mockHangingFetch();

    const promise = persistCollabChanges("table", "tbl-1", {
      changes: { foo: "bar" },
    });

    await Promise.all([
      expect(promise).rejects.toThrow(/timeout/),
      vi.advanceTimersByTimeAsync(15_001),
    ]);
  });

  it("forwards parent-document context when persisting an embedded table", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok", data: { persisted: true } }),
    }) as any;

    await persistCollabChanges(
      "table",
      "tbl-1",
      { changes: { foo: "bar" } },
      "doc-parent",
    );

    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].headers).toMatchObject({
      "X-TabTin-Parent-Document-Id": "doc-parent",
    });
  });

  it("rejects a 200 response whose envelope reports an error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: "error",
        data: { error: "persist failed" },
      }),
    }) as any;

    await expect(
      persistCollabChanges("table", "tbl-1", { changes: { foo: "bar" } }),
    ).rejects.toThrow(/invalid persist success response/);
  });

  it("rejects a 200 response without a result object", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    }) as any;

    await expect(
      persistCollabChanges("table", "tbl-1", { changes: { foo: "bar" } }),
    ).rejects.toThrow(/invalid persist success response/);
  });

  it("passes timeout to fetchDocumentBinary", async () => {
    mockHangingFetch();

    const promise = fetchDocumentBinary("doc-1");

    await Promise.all([
      expect(promise).rejects.toThrow(/timeout/),
      vi.advanceTimersByTimeAsync(15_001),
    ]);
  });

  it("propagates non-timeout errors unchanged", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error("fetch failed: ECONNREFUSED"),
    ) as any;

    await expect(fetchCollabSnapshot("table", "tbl-1")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});

describe("verifyCollabAccess timeout (P0-2)", () => {
  it("returns unauthorized with timeout reason when Django does not respond within 10s", async () => {
    mockHangingFetch();

    const promise = verifyCollabAccess("table", "tbl-1", "jwt-token");

    await Promise.all([
      promise.then((result) => {
        expect(result.authorized).toBe(false);
        expect(result.reason).toMatch(/timeout after 10000ms/);
      }),
      vi.advanceTimersByTimeAsync(10_001),
    ]);
  });

  it("includes AbortSignal in auth fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ok",
          data: { authorized: true, user_id: "u-1" },
        }),
    }) as any;

    await verifyCollabAccess("table", "tbl-1", "jwt-token");

    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards the optional parent-document context to Django auth", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: "ok",
        data: { authorized: true, user_id: "u-1" },
      }),
    }) as any;

    await verifyCollabAccess("table", "tbl-1", "jwt-token", "doc-parent");

    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1].headers).toMatchObject({
      Authorization: "Bearer jwt-token",
      "X-TabTin-Parent-Document-Id": "doc-parent",
    });
  });

  it("preserves Django 403 permission reason instead of rewriting it as editor-only", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve(JSON.stringify({
        status: "error",
        code: "PERMISSION_DENIED",
        message: "您没有权限执行此操作",
      })),
    }) as any;

    const result = await verifyCollabAccess("docs", "doc-1", "jwt-token");

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("您没有权限执行此操作");
    expect(result.reason).not.toContain("need editor");
  });

  it("keeps an unavailable embedded-access check distinct from permission denial", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ "X-TabTin-Embedded-Access-Unavailable": "1" }),
      text: () => Promise.resolve(JSON.stringify({
        status: "error",
        code: "PERMISSION_DENIED",
        message: "permission denied",
      })),
    }) as any;

    const result = await verifyCollabAccess("table", "tbl-1", "jwt-token", "doc-parent");

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("access_verification_unavailable");
  });

  it("keeps 401 as a JWT/session failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({
        status: "error",
        code: "UNAUTHORIZED",
        message: "token expired",
      })),
    }) as any;

    const result = await verifyCollabAccess("docs", "doc-1", "expired-token");

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("JWT token invalid or expired");
  });

  it("keeps 404 as an endpoint/resource not found failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(JSON.stringify({
        status: "error",
        code: "NOT_FOUND",
        message: "not found",
      })),
    }) as any;

    const result = await verifyCollabAccess("docs", "missing-doc", "jwt-token");

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("endpoint not found:");
  });
});

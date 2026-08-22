/**
 * CC-002 + E2E-038 回归测试（collab-live 侧）
 *
 * E2E-038: persistCollabChanges 在响应包含 version_history_error 时
 * 不再抛出错误（persist 已成功），改为 console.warn 记录日志。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../env.js", () => ({
  env: {
    DJANGO_API_URL: "http://localhost:6060",
    LIVE_SECRET: "test-secret",
    SERVER_NAME: "test-server",
  },
}));

import { persistCollabChanges } from "../django-api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("E2E-038: persistCollabChanges handles version_history_error", () => {
  it("does NOT throw when response contains version_history_error (persist succeeded)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ok",
          data: { version: 1, version_history_error: true },
        }),
    }) as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await persistCollabChanges("table", "tbl-1", {
      changes: { foo: "bar" },
    });

    expect(result).toEqual({ version: 1, version_history_error: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("version history write failed"),
    );
  });

  it("logs warning with resource type and id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ok",
          data: { version: 1, version_history_error: true },
        }),
    }) as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await persistCollabChanges("design", "dsg-42", {
      changes: {},
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/design.*dsg-42/),
    );
  });

  it("does not warn on normal successful response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ok",
          data: { version: 2 },
        }),
    }) as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await persistCollabChanges("table", "tbl-1", {
      changes: { foo: "bar" },
    });
    expect(result).toEqual({ version: 2 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn on deduplicated response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ok",
          data: { deduplicated: true },
        }),
    }) as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await persistCollabChanges("table", "tbl-1", {
      changes: {},
    });
    expect(result).toEqual({ deduplicated: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn on conflict response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "ok",
          data: { conflict: true, current_revn: 5 },
        }),
    }) as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await persistCollabChanges("table", "tbl-1", {
      changes: { foo: "bar" },
    });
    expect(result).toEqual({ conflict: true, current_revn: 5 });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

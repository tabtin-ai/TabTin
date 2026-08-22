/**
 * 回归测试 — useVersionHistory 统一版本历史 Hook
 *
 * 覆盖:
 *   CC-004: 分页追加
 *   CC-017: hasMore 计算
 *   CC-020: 统一 Hook（取代 useCollabVersionHistory）
 *   CC-021: 统一错误处理（OperationResult）
 *   CC-022: unnameVersion 替代 deleteNamedVersion
 *   CC-023: restoreVersion 延迟刷新
 *   E-12:  双重 Hook 合并
 *   E-13:  deleteNamedVersion 语义修复
 *   E-14:  autoFetch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useVersionHistory } from "./useVersionHistory";

const BASE_OPTIONS = {
  resourceType: "tabdoc",
  resourceId: "doc-123",
  apiBase: "http://localhost:6060/api/collab/v1",
  token: "test-token",
  autoFetch: false,
};

function makeVersionItem(id: string, overrides?: Record<string, unknown>) {
  return {
    id,
    module: "tabdoc",
    is_snapshot: false,
    is_named: false,
    name: "",
    pinned: false,
    editor_type: "user",
    editor_id: "u1",
    blob_size: 100,
    created_at: new Date().toISOString(),
    expired_at: null,
    ...overrides,
  };
}

function mockJsonResponse(data: Record<string, unknown>) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
}

function mockErrorResponse(status: number, body = "") {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(body),
  } as unknown as Response);
}

describe("CC-004: fetchVersions pagination append", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should replace versions when offset is 0", async () => {
    const items = [makeVersionItem("v0"), makeVersionItem("v1")];
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: items, total: 10 }),
    );

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    await act(async () => {
      await result.current.fetchVersions({ offset: 0 });
    });

    expect(result.current.versions).toHaveLength(2);
    expect(result.current.versions[0].id).toBe("v0");
  });

  it("should append versions when offset > 0", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const items = callCount === 1
        ? [makeVersionItem("v0"), makeVersionItem("v1")]
        : [makeVersionItem("v2"), makeVersionItem("v3")];
      return mockJsonResponse({ status: "ok", data: items, total: 4 });
    });

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    await act(async () => {
      await result.current.fetchVersions({ offset: 0 });
    });
    expect(result.current.versions).toHaveLength(2);

    await act(async () => {
      await result.current.fetchVersions({ offset: 2 });
    });
    expect(result.current.versions).toHaveLength(4);
    expect(result.current.versions.map((v) => v.id)).toEqual(["v0", "v1", "v2", "v3"]);
  });
});

describe("CC-017: hasMore derived state", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should return hasMore=true when versions < total", async () => {
    const items = [makeVersionItem("v0"), makeVersionItem("v1")];
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: items, total: 10 }),
    );

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    await act(async () => {
      await result.current.fetchVersions();
    });

    expect(result.current.hasMore).toBe(true);
  });

  it("should return hasMore=false when all loaded", async () => {
    const items = [makeVersionItem("v0"), makeVersionItem("v1")];
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: items, total: 2 }),
    );

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    await act(async () => {
      await result.current.fetchVersions();
    });

    expect(result.current.hasMore).toBe(false);
  });
});

describe("CC-020/E-12: unified Hook interface", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should expose all required operations", () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: [], total: 0 }),
    );

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    expect(result.current).toHaveProperty("versions");
    expect(result.current).toHaveProperty("total");
    expect(result.current).toHaveProperty("loading");
    expect(result.current).toHaveProperty("error");
    expect(result.current).toHaveProperty("hasMore");
    expect(result.current).toHaveProperty("restoringVersion");
    expect(result.current).toHaveProperty("fetchVersions");
    expect(result.current).toHaveProperty("createNamedVersion");
    expect(result.current).toHaveProperty("restoreVersion");
    expect(result.current).toHaveProperty("renameVersion");
    expect(result.current).toHaveProperty("unnameVersion");
    expect(result.current).toHaveProperty("togglePin");
  });

  it("should not fetch when enabled=false", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: [], total: 0 }),
    );

    renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, autoFetch: true, enabled: false }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("should not fetch when resourceId is null", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: [], total: 0 }),
    );

    renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, resourceId: null, autoFetch: true }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("CC-021: unified error handling (OperationResult)", () => {
  const originalFetch = globalThis.fetch;
  const onError = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    onError.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("createNamedVersion returns error on HTTP failure", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockErrorResponse(500, "Internal Server Error"));

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, onError }),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.createNamedVersion("v1");
    });

    expect(opResult.success).toBe(false);
    expect(opResult.error).toBeTruthy();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "createNamedVersion");
  });

  it("renameVersion returns error on API error status", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "error", message: "Version not found" }),
    );

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, onError }),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.renameVersion("v1", "new name");
    });

    expect(opResult.success).toBe(false);
    expect(opResult.error).toContain("Version not found");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "renameVersion");
  });

  it("returns a concise permission hint instead of raw JSON on 403", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockErrorResponse(
        403,
        JSON.stringify({
          status: "error",
          message: "您没有权限执行此操作",
          trace_id: "trace-1",
        }),
      ),
    );

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, onError }),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.renameVersion("v1", "new name");
    });

    expect(opResult.error).toBe("当前为只读权限，需要可编辑权限才能操作版本历史");
    expect(opResult.error).not.toContain("trace_id");
  });

  it("togglePin returns error on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, onError }),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.togglePin("v1", true);
    });

    expect(opResult.success).toBe(false);
    expect(opResult.error).toBe("Network error");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "togglePin");
  });

  it("createNamedVersion returns success and refreshes on ok", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return mockJsonResponse({ status: "ok", data: [], total: 0 });
    });

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.createNamedVersion("my version");
    });

    expect(opResult.success).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

describe("CC-022/E-13: unnameVersion semantic fix", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("unnameVersion sends PATCH with empty name", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: { id: "v1", name: "" } }),
    );

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    await act(async () => {
      await result.current.unnameVersion("v1");
    });

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toContain("/versions/v1/name");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.name).toBe("");
    expect(fetchCall[1].method).toBe("PATCH");
  });

  it("unnameVersion returns OperationResult on success", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: { id: "v1", name: "" } }),
    );

    const { result } = renderHook(() =>
      useVersionHistory(BASE_OPTIONS),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.unnameVersion("v1");
    });

    expect(opResult.success).toBe(true);
  });
});

describe("CC-023: restoreVersion delayed refresh", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("should delay refresh after successful restore", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return mockJsonResponse({ status: "ok", data: [], total: 0 });
    });

    const { result } = renderHook(() =>
      useVersionHistory({
        ...BASE_OPTIONS,
        refreshDelayAfterRestore: 800,
      }),
    );

    let opResult: any;
    await act(async () => {
      opResult = await result.current.restoreVersion("v1");
    });

    expect(opResult.success).toBe(true);
    const fetchCountAfterRestore = fetchCount;

    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(fetchCount).toBeGreaterThan(fetchCountAfterRestore);
  });

  it("should invoke onRestoreSuccess callback after successful restore", async () => {
    const onRestoreSuccess = vi.fn();
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: [], total: 0 }),
    );

    const { result } = renderHook(() =>
      useVersionHistory({
        ...BASE_OPTIONS,
        refreshDelayAfterRestore: 800,
        onRestoreSuccess,
      }),
    );

    await act(async () => {
      await result.current.restoreVersion("v1");
    });

    expect(onRestoreSuccess).toHaveBeenCalledTimes(1);
  });

  it("should not invoke onRestoreSuccess on failed restore", async () => {
    const onRestoreSuccess = vi.fn();
    globalThis.fetch = vi.fn().mockReturnValue(mockErrorResponse(500, "Server Error"));

    const { result } = renderHook(() =>
      useVersionHistory({
        ...BASE_OPTIONS,
        refreshDelayAfterRestore: 800,
        onRestoreSuccess,
      }),
    );

    await act(async () => {
      await result.current.restoreVersion("v1");
    });

    expect(onRestoreSuccess).not.toHaveBeenCalled();
  });

  it("should immediately refresh when delay=0", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return mockJsonResponse({ status: "ok", data: [], total: 0 });
    });

    const { result } = renderHook(() =>
      useVersionHistory({
        ...BASE_OPTIONS,
        refreshDelayAfterRestore: 0,
      }),
    );

    await act(async () => {
      await result.current.restoreVersion("v1");
    });

    expect(fetchCount).toBeGreaterThanOrEqual(2);
  });

  it("should set and clear restoringVersion during restore", async () => {
    let resolveRestore: (() => void) | null = null;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/restore")) {
        return new Promise<Response>((resolve) => {
          resolveRestore = () =>
            resolve({
              ok: true,
              json: () => Promise.resolve({ status: "ok" }),
              text: () => Promise.resolve(""),
            } as Response);
        });
      }
      return mockJsonResponse({ status: "ok", data: [], total: 0 });
    });

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, refreshDelayAfterRestore: 0 }),
    );

    expect(result.current.restoringVersion).toBeNull();

    let restorePromise: Promise<any>;
    act(() => {
      restorePromise = result.current.restoreVersion("v-42");
    });

    expect(result.current.restoringVersion).toBe("v-42");

    await act(async () => {
      resolveRestore!();
      await restorePromise!;
    });

    expect(result.current.restoringVersion).toBeNull();
  });
});

describe("E-14: autoFetch on mount", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should auto-fetch when autoFetch=true, enabled=true, and resourceId is set", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockJsonResponse({ status: "ok", data: [makeVersionItem("v0")], total: 1 }),
    );

    const { result } = renderHook(() =>
      useVersionHistory({
        ...BASE_OPTIONS,
        autoFetch: true,
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.versions).toHaveLength(1);
    });

    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

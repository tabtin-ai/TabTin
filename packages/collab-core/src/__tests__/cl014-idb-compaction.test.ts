/**
 * CL-014 回归测试
 *
 * 验证 CollabProvider 在 IndexedDB synced 后检测累积 update 条目数，
 * 超过阈值时主动执行 compaction（合并为单个完整 state）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

let capturedHPOpts: Record<string, any> = {};
let mockHPInstance: Record<string, any> = {};

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    constructor(opts: any) {
      capturedHPOpts = opts;
      Object.assign(this, {
        disconnect: vi.fn(),
        destroy: vi.fn(),
        connect: vi.fn(),
        setAwarenessField: vi.fn(),
        sendStateless: vi.fn(),
        _opts: opts,
      });
      mockHPInstance = this;
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

let mockIDBInstance: Record<string, any> = {};
let idbSyncedCb: (() => void) | null = null;

vi.mock("y-indexeddb", () => {
  class MockIndexeddbPersistence {
    whenSynced = Promise.resolve();
    destroy = vi.fn();
    _dbsize = 0;
    db = null as any;
    on = vi.fn((event: string, cb: () => void) => {
      if (event === "synced") idbSyncedCb = cb;
    });
    constructor() {
      idbSyncedCb = null;
      mockIDBInstance = this;
    }
  }
  return { IndexeddbPersistence: MockIndexeddbPersistence };
});

/* ------------------------------------------------------------------ */
/* 被测模块                                                            */
/* ------------------------------------------------------------------ */

import { CollabProvider } from "../provider.js";
import { CollabStatus } from "../types.js";

function makeProvider(overrides?: Record<string, any>): CollabProvider {
  return new CollabProvider({
    serverUrl: "ws://localhost:1234",
    documentName: "docs:test-doc",
    token: "test-token",
    user: { id: "u1", name: "Test", color: "#000" },
    enableIndexedDB: true,
    ...overrides,
  });
}

describe("CL-014: IndexedDB proactive compaction", () => {
  let provider: CollabProvider;

  beforeEach(() => {
    idbSyncedCb = null;
  });

  afterEach(() => {
    try {
      provider?.disconnect();
    } catch {
      // ignore
    }
  });

  it("IDB _dbsize < 阈值时不触发 compaction", () => {
    provider = makeProvider();
    provider.connect();

    // 模拟 _dbsize 低于阈值
    mockIDBInstance._dbsize = 50;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // 触发 synced 回调
    if (idbSyncedCb) idbSyncedCb();

    const compactionLogs = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("compacted"),
    );
    expect(compactionLogs).toHaveLength(0);

    logSpy.mockRestore();
  });

  it("IDB _dbsize >= 阈值时触发 compaction（需要 db 实例）", () => {
    provider = makeProvider();
    provider.connect();

    // 模拟 _dbsize 超过阈值但没有 db 实例
    mockIDBInstance._dbsize = 500;
    mockIDBInstance.db = null;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    if (idbSyncedCb) idbSyncedCb();

    // 无 db 实例时 compaction 应安全退出
    const compactionLogs = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("compacted"),
    );
    expect(compactionLogs).toHaveLength(0);

    logSpy.mockRestore();
  });

  it("IDB _dbsize >= 阈值且有 db 实例时尝试 compaction", () => {
    provider = makeProvider();
    provider.connect();

    mockIDBInstance._dbsize = 500;

    // 模拟 IDBDatabase
    let txCompleted = false;
    const mockStore = {
      clear: vi.fn(),
      put: vi.fn(),
    };
    const mockTx = {
      objectStore: vi.fn(() => mockStore),
      oncomplete: null as any,
      onerror: null as any,
    };
    mockIDBInstance.db = {
      objectStoreNames: { contains: vi.fn(() => true) },
      transaction: vi.fn(() => mockTx),
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    if (idbSyncedCb) idbSyncedCb();

    // 验证 transaction 被创建
    expect(mockIDBInstance.db.transaction).toHaveBeenCalledWith("updates", "readwrite");
    expect(mockStore.clear).toHaveBeenCalled();
    expect(mockStore.put).toHaveBeenCalled();

    // 模拟 transaction 完成
    if (mockTx.oncomplete) {
      mockTx.oncomplete();
      txCompleted = true;
    }

    expect(txCompleted).toBe(true);
    expect(mockIDBInstance._dbsize).toBe(1);

    logSpy.mockRestore();
  });

  it("compaction 失败时不影响正常功能", () => {
    provider = makeProvider();
    provider.connect();

    mockIDBInstance._dbsize = 500;
    mockIDBInstance.db = {
      objectStoreNames: { contains: vi.fn(() => true) },
      transaction: vi.fn(() => {
        throw new Error("IDB error");
      }),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // synced 回调应正常完成（不抛异常）
    expect(() => {
      if (idbSyncedCb) idbSyncedCb();
    }).not.toThrow();

    // 应记录警告
    const compactionWarns = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("compaction failed"),
    );
    expect(compactionWarns.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it("enableIndexedDB=false 时不创建 IDB", () => {
    provider = makeProvider({ enableIndexedDB: false });
    provider.connect();

    expect(idbSyncedCb).toBeNull();
  });
});

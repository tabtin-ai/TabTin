/**
 * 回归测试 — CI-007 / CI-008 / CI-011
 *
 * CI-007: storeSemaphore 等待队列增加上限（maxQueueSize），防止无界增长
 * CI-008: Semaphore.acquire 增加超时，防止永久阻塞
 * CI-011: afterUnloadDocument 增加超时保护，防止最坏 ~110s 阻塞
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as Y from "yjs";

// ── mocks ──────────────────────────────────────────

vi.mock("../env.js", () => ({
  env: {
    DJANGO_API_URL: "http://localhost:6060",
    LIVE_SECRET: "test-secret",
    SERVER_NAME: "test-server",
  },
}));

vi.mock("../extensions/metrics.js", () => ({
  metrics: {
    increment: vi.fn(),
    recordStoreLatency: vi.fn(),
    storeErrors: 0,
    fetchErrors: 0,
    recordPush: vi.fn(),
    snapshotCacheSizes: {},
  },
}));

vi.mock("../services/django-api.js", () => ({
  fetchCollabSnapshot: vi.fn(),
  persistCollabChanges: vi.fn(),
}));

vi.mock("../lib/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../lib/collab-utils.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    handleStoreError: vi.fn(async ({ error }: { error: unknown }) => {
      throw error;
    }),
  };
});

// ══════════════════════════════════════════════════
// CI-007: Semaphore 队列上限
// ══════════════════════════════════════════════════

describe("CI-007: Semaphore maxQueueSize 防止等待队列无界增长", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("storeSemaphore 应配置有限的 maxQueueSize", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );
    expect(storeSemaphore.maxQueueSize).toBe(100);
    expect(Number.isFinite(storeSemaphore.maxQueueSize)).toBe(true);
  });

  it("队列满时 acquire 立即抛出错误", async () => {
    const { BaseCollabDatabase } = await import(
      "../extensions/base-collab-database.js"
    );

    // 直接测试 Semaphore 类的行为：创建一个小容量信号量
    // 通过导入获取 Semaphore（它不是 export 的，所以用 storeSemaphore 侧面验证）
    // 这里用一个独立的小信号量模拟
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );

    const concurrency = storeSemaphore.concurrency;
    const maxQueue = storeSemaphore.maxQueueSize;
    const acquiredSlots: Promise<void>[] = [];

    // 填满并发槽
    for (let i = 0; i < concurrency; i++) {
      acquiredSlots.push(storeSemaphore.acquire());
    }
    await Promise.all(acquiredSlots);

    // 填满等待队列
    const queuedPromises: Promise<void>[] = [];
    for (let i = 0; i < maxQueue; i++) {
      queuedPromises.push(storeSemaphore.acquire());
    }
    expect(storeSemaphore.pending).toBe(maxQueue);

    // 下一个 acquire 应该抛出 queue full 错误
    await expect(storeSemaphore.acquire()).rejects.toThrow("queue full");

    // 清理：释放所有槽位
    for (let i = 0; i < concurrency + maxQueue; i++) {
      storeSemaphore.release();
    }
    await Promise.all(queuedPromises);
  });
});

// ══════════════════════════════════════════════════
// CI-008: Semaphore acquire 超时
// ══════════════════════════════════════════════════

describe("CI-008: Semaphore acquire 超时防止永久阻塞", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("acquire 在超时后 reject 并从队列中移除", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );

    const concurrency = storeSemaphore.concurrency;

    // 填满并发槽
    for (let i = 0; i < concurrency; i++) {
      await storeSemaphore.acquire();
    }

    const timeoutMs = 500;
    const acquirePromise = storeSemaphore.acquire(timeoutMs);
    expect(storeSemaphore.pending).toBe(1);

    // 推进时间触发超时
    vi.advanceTimersByTime(timeoutMs + 10);

    await expect(acquirePromise).rejects.toThrow("timed out");
    expect(storeSemaphore.pending).toBe(0);

    // 清理
    for (let i = 0; i < concurrency; i++) {
      storeSemaphore.release();
    }
  });

  it("release 在超时前到达时正确清除 timer", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );

    const concurrency = storeSemaphore.concurrency;

    // 填满并发槽
    for (let i = 0; i < concurrency; i++) {
      await storeSemaphore.acquire();
    }

    let resolved = false;
    const acquirePromise = storeSemaphore.acquire(5000).then(() => {
      resolved = true;
    });

    expect(storeSemaphore.pending).toBe(1);

    // 在超时前 release 一个槽
    storeSemaphore.release();
    await acquirePromise;
    expect(resolved).toBe(true);
    expect(storeSemaphore.pending).toBe(0);

    // 推进时间确认 timer 已被清除（不会触发 reject）
    vi.advanceTimersByTime(6000);

    // 清理剩余槽
    for (let i = 0; i < concurrency; i++) {
      storeSemaphore.release();
    }
  });

  it("无超时参数时保持原有行为（不会自动 reject）", async () => {
    const { storeSemaphore } = await import(
      "../extensions/base-collab-database.js"
    );

    const concurrency = storeSemaphore.concurrency;

    // 填满并发槽
    for (let i = 0; i < concurrency; i++) {
      await storeSemaphore.acquire();
    }

    let resolved = false;
    const acquirePromise = storeSemaphore.acquire().then(() => {
      resolved = true;
    });

    // 推进大量时间
    vi.advanceTimersByTime(120000);
    expect(resolved).toBe(false);

    // 手动 release 后才 resolve
    storeSemaphore.release();
    await acquirePromise;
    expect(resolved).toBe(true);

    // 清理
    for (let i = 0; i < concurrency; i++) {
      storeSemaphore.release();
    }
  });
});

// ══════════════════════════════════════════════════
// CI-011: afterUnloadDocument 超时保护
// ══════════════════════════════════════════════════

describe("CI-011: afterUnloadDocument 超时保护防止长时间阻塞", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pending store 在超时前完成时正常等待", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import(
      "../extensions/base-collab-database.js"
    );

    let storeFinished = false;
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(() => {
            storeFinished = true;
            resolve({ success: true });
          }, 50);
        }),
    );

    class TestDB extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        return { changes: { v: 1 }, editor_type: "user", editor_id: "u1" };
      }
      protected retainSnapshotOnUnloadTimeout() { return true; }
    }

    const db = new TestDB();
    const ydoc = new Y.Doc();
    const params = {
      documentName: "test:ci011-fast",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    const storePromise = (db as any)._storeDocument(params);
    await db.afterUnloadDocument({ documentName: "test:ci011-fast" });
    expect(storeFinished).toBe(true);

    await storePromise;
    ydoc.destroy();
  });

  it("pending store 超时后 afterUnloadDocument 不再无限等待", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import(
      "../extensions/base-collab-database.js"
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let storeResolve!: (v: Record<string, unknown>) => void;
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          storeResolve = resolve;
        }),
    );

    class TestDB extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        return { changes: { v: 1 }, editor_type: "user", editor_id: "u1" };
      }
    }

    const db = new TestDB();
    const ydoc = new Y.Doc();
    const params = {
      documentName: "test:ci011-slow",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    (db as any)._storeDocument(params);

    // afterUnloadDocument 应在超时后返回，不会永远等待
    const unloadPromise = db.afterUnloadDocument({ documentName: "test:ci011-slow" });

    // 推进时间超过 UNLOAD_TIMEOUT_MS（默认 15000ms）
    vi.advanceTimersByTime(16000);

    await unloadPromise;

    // 应输出超时警告
    const timeoutWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("timed out"),
    );
    expect(timeoutWarns.length).toBeGreaterThanOrEqual(1);
    expect(timeoutWarns[0][0]).toContain("afterUnloadDocument timed out");

    // 清理：让 store 完成
    storeResolve({ success: true });
    ydoc.destroy();
    warnSpy.mockRestore();
  });

  it("超时后保留 snapshotCache，避免在途 store 退化成无基线写入", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import(
      "../extensions/base-collab-database.js"
    );

    vi.spyOn(console, "warn").mockImplementation(() => {});

    let storeResolve!: (v: Record<string, unknown>) => void;
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          storeResolve = resolve;
        }),
    );

    class TestDB extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        return { changes: { v: 1 }, editor_type: "user", editor_id: "u1" };
      }
      protected retainSnapshotOnUnloadTimeout() { return true; }
    }

    const db = new TestDB();
    const ydoc = new Y.Doc();
    const docName = "test:ci011-cleanup";

    db.snapshotCache.set(docName, { some: "snapshot" });

    const params = {
      documentName: docName,
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    (db as any)._storeDocument(params);

    // 先启动 afterUnloadDocument（它会创建内部超时 timer），再推进时间
    const unloadPromise = db.afterUnloadDocument({ documentName: docName });
    vi.advanceTimersByTime(16000);
    await unloadPromise;

    expect(db.snapshotCache.has(docName)).toBe(true);

    storeResolve({ success: true });
    ydoc.destroy();
    vi.restoreAllMocks();
  });
});

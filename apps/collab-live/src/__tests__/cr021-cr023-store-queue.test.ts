/**
 * 回归测试 — CR-021 / CR-023
 *
 * CR-021: BaseCollabDatabase.afterUnloadDocument 必须 await 进行中的
 *         store 队列完成后再删除，防止孤儿 Promise 导致串行保证失效。
 *
 * CR-023: TabDoc Database 必须具备 per-doc 串行队列，防止并发 store
 *         HTTP 调用。
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
  fetchDocumentBinary: vi.fn(),
  storeDocumentUpdate: vi.fn(),
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

vi.mock("@tabtin/doc-editor", () => ({
  DOC_SCHEMA_VERSION: 1,
}));

vi.mock("../lib/converters.js", () => ({
  binaryToAllFormats: vi.fn().mockResolvedValue({
    html: "",
    json: {},
    plaintext: "",
    markdown: "",
  }),
  markdownToUpdateBinary: vi.fn(),
  pmJsonToUpdateBinary: vi.fn(),
}));

// ══════════════════════════════════════════════════
// CR-021: BaseCollabDatabase afterUnloadDocument
// ══════════════════════════════════════════════════

describe("CR-021: afterUnloadDocument awaits pending store queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for in-flight store to finish before deleting queue entry", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    let resolveStore!: () => void;
    const storeStarted = new Promise<void>((r) => { resolveStore = r; });
    let storeFinished = false;

    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveStore();
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
    }

    const db = new TestDB();
    const ydoc = new Y.Doc();
    const params = {
      documentName: "test:doc-1",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    // 触发 store（不 await，让它在后台运行）
    const storePromise = (db as any)._storeDocument(params);

    // 等 store HTTP 调用已发出
    await storeStarted;
    expect(storeFinished).toBe(false);

    // 调用 afterUnloadDocument —— 修复前会立即返回，修复后应 await store 完成
    await db.afterUnloadDocument({ documentName: "test:doc-1" });

    // 此时 store 必须已经完成
    expect(storeFinished).toBe(true);

    await storePromise;
    ydoc.destroy();
  });

  it("handles store error gracefully during unload drain", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { handleStoreError } = await import("../lib/collab-utils.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    (persistCollabChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network timeout"),
    );
    (handleStoreError as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("network timeout");
    });

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
      documentName: "test:doc-err",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    const storePromise = (db as any)._storeDocument(params);
    storePromise.catch(() => {});

    // afterUnloadDocument 不应因 store 失败而抛出
    await expect(
      db.afterUnloadDocument({ documentName: "test:doc-err" }),
    ).resolves.toBeUndefined();

    ydoc.destroy();
  });

  it("subsequent store after unload re-creates queue entry", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    const callOrder: string[] = [];
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("persist");
      return { success: true };
    });

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
      documentName: "test:doc-reopen",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    await (db as any)._storeDocument(params);
    await db.afterUnloadDocument({ documentName: "test:doc-reopen" });

    // 重新打开后 store 应正常工作
    await (db as any)._storeDocument(params);
    expect(callOrder).toEqual(["persist", "persist"]);

    ydoc.destroy();
  });

  it("drains an old store before re-fetch and keeps the new baseline during old unload cleanup", async () => {
    const { fetchCollabSnapshot, persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    const callOrder: string[] = [];
    let resolveStore!: (value: Record<string, unknown>) => void;
    let markStoreStarted!: () => void;
    const storeStarted = new Promise<void>((resolve) => { markStoreStarted = resolve; });
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Record<string, unknown>>((resolve) => {
        callOrder.push("store-start");
        markStoreStarted();
        resolveStore = resolve;
      }),
    );
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("fetch");
      return { source: "new-fetch" };
    });

    class TestDB extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        return { changes: { v: 1 }, editor_type: "user", editor_id: "u1" };
      }
      protected onStoreSuccess(_ydoc: Y.Doc, documentName: string) {
        callOrder.push("old-store-ack");
        this.snapshotCache.set(documentName, { source: "old-store-ack" });
      }
      protected onSnapshotLoaded(documentName: string) {
        callOrder.push("new-baseline");
        this.snapshotCache.set(documentName, { source: "new-fetch" });
      }
    }

    const db = new TestDB();
    const documentName = "test:reload-race";
    const oldYDoc = new Y.Doc();
    const newYDoc = new Y.Doc();
    const instance = { documents: new Map<string, unknown>() };
    db.snapshotCache.set(documentName, { source: "old-baseline" });

    const oldStore = (db as any)._storeDocument({
      documentName,
      state: Y.encodeStateAsUpdate(oldYDoc),
      document: oldYDoc,
      context: {},
      instance: null,
    });
    await storeStarted;

    const oldUnload = db.afterUnloadDocument({ documentName, instance } as any);
    instance.documents.set(documentName, newYDoc);
    const newFetch = (db as any)._fetchDocument({
      documentName,
      document: newYDoc,
      context: {},
    });

    await Promise.resolve();
    expect(fetchCollabSnapshot).not.toHaveBeenCalled();

    resolveStore({ success: true });
    await Promise.all([oldStore, oldUnload, newFetch]);

    expect(callOrder).toEqual([
      "store-start",
      "old-store-ack",
      "fetch",
      "new-baseline",
    ]);
    expect(db.snapshotCache.get(documentName)).toEqual({ source: "new-fetch" });

    oldYDoc.destroy();
    newYDoc.destroy();
  });
});

// ══════════════════════════════════════════════════
// CR-023: TabDoc Database per-doc serialized store
// ══════════════════════════════════════════════════

describe("CR-023: TabDoc Database serializes concurrent stores per document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes concurrent store calls for the same document", async () => {
    const { storeDocumentUpdate } = await import("../services/django-api.js");
    const { Database } = await import("../extensions/database.js");

    const callTimestamps: Array<{ start: number; end: number }> = [];
    let callIdx = 0;

    (storeDocumentUpdate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const idx = callIdx++;
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 30));
      callTimestamps.push({ start, end: Date.now() });
      return {};
    });

    const db = new Database();
    const ydoc = new Y.Doc();
    ydoc.getMap("meta").set("schema_version", 1);
    const state = Y.encodeStateAsUpdate(ydoc);

    const params = {
      documentName: "docs:doc-1",
      state,
      document: ydoc,
      context: {},
      instance: null,
    };

    // 同时触发 3 个 store 调用
    const p1 = (db as any)._serializedStore(params);
    const p2 = (db as any)._serializedStore(params);
    const p3 = (db as any)._serializedStore(params);

    await Promise.all([p1, p2, p3]);

    // 验证串行：每个 store 的开始时间 >= 前一个的结束时间
    expect(callTimestamps.length).toBe(3);
    for (let i = 1; i < callTimestamps.length; i++) {
      expect(callTimestamps[i].start).toBeGreaterThanOrEqual(
        callTimestamps[i - 1].end - 5, // 5ms tolerance for timer precision
      );
    }

    ydoc.destroy();
  });

  it("allows parallel stores for different documents", async () => {
    const { storeDocumentUpdate } = await import("../services/django-api.js");
    const { Database } = await import("../extensions/database.js");

    const activeConcurrency = { current: 0, max: 0 };

    (storeDocumentUpdate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      activeConcurrency.current++;
      activeConcurrency.max = Math.max(activeConcurrency.max, activeConcurrency.current);
      await new Promise((r) => setTimeout(r, 30));
      activeConcurrency.current--;
      return {};
    });

    const db = new Database();

    const makeParams = (docName: string) => {
      const ydoc = new Y.Doc();
      ydoc.getMap("meta").set("schema_version", 1);
      return {
        documentName: docName,
        state: Y.encodeStateAsUpdate(ydoc),
        document: ydoc,
        context: {},
        instance: null,
      };
    };

    const p1 = (db as any)._serializedStore(makeParams("docs:a"));
    const p2 = (db as any)._serializedStore(makeParams("docs:b"));

    await Promise.all([p1, p2]);

    // 不同文档应并行执行
    expect(activeConcurrency.max).toBe(2);
  });

  it("afterUnloadDocument awaits pending store", async () => {
    const { storeDocumentUpdate } = await import("../services/django-api.js");
    const { Database } = await import("../extensions/database.js");

    let storeFinished = false;

    (storeDocumentUpdate as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            storeFinished = true;
            resolve({});
          }, 50);
        }),
    );

    const db = new Database();
    const ydoc = new Y.Doc();
    ydoc.getMap("meta").set("schema_version", 1);

    const params = {
      documentName: "docs:unload-test",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    const storePromise = (db as any)._serializedStore(params);
    await new Promise((r) => setTimeout(r, 10));
    expect(storeFinished).toBe(false);

    await db.afterUnloadDocument({ documentName: "docs:unload-test" });
    expect(storeFinished).toBe(true);

    await storePromise;
    ydoc.destroy();
  });
});

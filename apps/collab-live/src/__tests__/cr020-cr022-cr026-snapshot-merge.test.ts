/**
 * 回归测试 — CR-020 / CR-022 / CR-026
 *
 * CR-020: conflict 后 snapshotCache 被清空，防止多实例间缓存不同步。
 * CR-022: prepareYDocForMerge 在临时 mergeDoc 上执行，不直接操作活跃 ydoc。
 * CR-026: Slide prepareYDocForMerge 清空所有页面（包括 snapshot 未记录的新页面）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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
    snapshotCacheSizes: {} as Record<string, number>,
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
// CR-020: conflict 后 snapshotCache 清空
// ══════════════════════════════════════════════════

describe("CR-020: snapshotCache cleared after store conflict", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snapshotCache is deleted after first conflict + retry success", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    let callCount = 0;
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { conflict: true, current_version: 5 };
      }
      return { success: true, version: 5 };
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
        this.snapshotCache.set(documentName, { rebuilt: true });
      }
    }

    const db = new TestDB();
    const docName = "test:cr020-1";
    db.snapshotCache.set(docName, { stale: true });

    const ydoc = new Y.Doc();
    await (db as any)._storeDocument({
      documentName: docName,
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    });

    // retry 成功后 onStoreSuccess 重建了缓存
    expect(db.snapshotCache.get(docName)).toEqual({ rebuilt: true });
    ydoc.destroy();
  });

  it("snapshotCache is cleared when conflict retry also fails", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { handleStoreError } = await import("../lib/collab-utils.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    (persistCollabChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      conflict: true, current_version: 5,
    });
    (handleStoreError as ReturnType<typeof vi.fn>).mockImplementation(async () => {});

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
    const docName = "test:cr020-2";
    db.snapshotCache.set(docName, { stale: true });

    const ydoc = new Y.Doc();
    await (db as any)._storeDocument({
      documentName: docName,
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    });

    expect(db.snapshotCache.has(docName)).toBe(false);
    ydoc.destroy();
  });

  it("Slide onStoreConflict no longer saves snapshot, enabling non-null retry payload", async () => {
    const { SlideDatabase, clearSlideSnapshot } = await import(
      "../extensions/slide-database.js"
    );

    const db = new SlideDatabase();
    const docName = "slide:cr020-slide";

    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");
    const pageOrderArr = ydoc.getArray<string>("pageOrder");
    const metaMap = ydoc.getMap("meta");

    ydoc.transact(() => {
      const page1 = new Y.Map<unknown>();
      const elMap = new Y.Map<Y.Map<unknown>>();
      const elOrder = new Y.Array<string>();
      const el = new Y.Map<unknown>();
      el.set("id", "e1");
      el.set("type", "text");
      el.set("content", "original");
      elMap.set("e1", el);
      elOrder.push(["e1"]);
      page1.set("elementsMap", elMap);
      page1.set("elementOrder", elOrder);
      pagesMap.set("p1", page1);
      pageOrderArr.push(["p1"]);
      metaMap.set("version", 1);
      metaMap.set("project_name", "Test");
    });

    db.saveSnapshot(docName, ydoc);

    ydoc.transact(() => {
      const page1 = pagesMap.get("p1") as Y.Map<unknown>;
      const elMap = page1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      const el = elMap.get("e1") as Y.Map<unknown>;
      el.set("content", "modified");
    });

    // 先 buildPersistPayload 验证有变更
    const payloadBefore = (db as any).buildPersistPayload(ydoc, docName, {});
    expect(payloadBefore).not.toBeNull();

    // 模拟 conflict
    (db as any).onStoreConflict(ydoc, docName, { current_version: 5 });

    // 修复后: onStoreConflict 不再 saveSnapshot，所以 diff 仍有变更
    const payloadAfterConflict = (db as any).buildPersistPayload(ydoc, docName, {});
    expect(payloadAfterConflict).not.toBeNull();
    expect(payloadAfterConflict.changes.changed_pages).toHaveProperty("p1");

    clearSlideSnapshot(docName);
    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════════
// CR-022: prepareYDocForMerge 在临时 Doc 上执行
// ══════════════════════════════════════════════════

describe("CR-022: prepareYDocForMerge operates on mergeDoc, not live ydoc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetch does not directly clear live ydoc arrays (table)", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "server_val" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
      is_truncated: false,
      total_records: 1,
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    // 预填充 ydoc（模拟有残留状态的重载场景）
    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["existing_r1", "existing_r2"]);
      const records = ydoc.getMap("records");
      const r = new Y.Map<unknown>();
      r.set("f1", "existing");
      records.set("existing_r1", r);
      ydoc.getMap("meta").set("is_truncated", true);
      ydoc.getMap("meta").set("total_records", 5_001);
    });

    const rowOrderBefore = ydoc.getArray<string>("rowOrder");
    expect(rowOrderBefore.length).toBe(2);

    // 记录 ydoc 在 fetch 期间是否被直接清空
    let clearedDuringFetch = false;
    const observer = () => {
      if (rowOrderBefore.length === 0) clearedDuringFetch = true;
    };
    rowOrderBefore.observe(observer);

    const result = await (db as any)._fetchDocument({
      documentName: "table:cr022-test",
      document: ydoc,
      context: {},
    });

    rowOrderBefore.unobserve(observer);

    // CR-022 修复后：ydoc 不应在 fetch 过程中被直接清空
    // (prepareYDocForMerge 在 mergeDoc 上操作)
    expect(clearedDuringFetch).toBe(false);

    // 返回的 state 应用后，ydoc 包含服务端数据
    expect(result).toBeInstanceOf(Uint8Array);
    Y.applyUpdate(ydoc, result);

    // step4: rowOrderMap（Y.Map）是主数据源，包含 Django 数据
    const { getOrderedIds } = await import("../lib/y-utils.js");
    const rowOrderMap = ydoc.getMap<number>("rowOrderMap");
    expect(getOrderedIds(rowOrderMap)).toContain("r1");
    expect(ydoc.getMap("meta").get("is_truncated")).toBe(false);
    expect(ydoc.getMap("meta").get("total_records")).toBe(1);

    ydoc.destroy();
  });

  it("fetch does not directly clear live ydoc arrays (slide)", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { SlideDatabase, clearSlideSnapshot } = await import(
      "../extensions/slide-database.js"
    );

    const serverSnapshot = {
      pages: [
        { id: "p1", elements: [{ id: "e1", type: "text", content: "hello" }] },
      ],
      page_order: ["p1"],
      version: 1,
      project_name: "Test",
      project_id: "pid",
      canvas_width: 1920,
      canvas_height: 1080,
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new SlideDatabase();
    const ydoc = new Y.Doc();

    // 预填充 ydoc
    ydoc.transact(() => {
      const pageOrder = ydoc.getArray<string>("pageOrder");
      pageOrder.push(["existing_p1"]);
      const pages = ydoc.getMap("pages");
      const p = new Y.Map<unknown>();
      const elOrder = new Y.Array<string>();
      elOrder.push(["existing_el"]);
      p.set("elementOrder", elOrder);
      p.set("elementsMap", new Y.Map());
      pages.set("existing_p1", p);
    });

    const pageOrderBefore = ydoc.getArray<string>("pageOrder");
    expect(pageOrderBefore.length).toBe(1);

    let clearedDuringFetch = false;
    const observer = () => {
      if (pageOrderBefore.length === 0) clearedDuringFetch = true;
    };
    pageOrderBefore.observe(observer);

    const result = await (db as any)._fetchDocument({
      documentName: "slide:cr022-test",
      document: ydoc,
      context: {},
    });

    pageOrderBefore.unobserve(observer);

    expect(clearedDuringFetch).toBe(false);
    expect(result).toBeInstanceOf(Uint8Array);

    Y.applyUpdate(ydoc, result);

    // step4: pageOrderMap（Y.Map）是主数据源，包含 Django 数据
    const { getOrderedIds: getOIds } = await import("../lib/y-utils.js");
    const pageOrderMap = ydoc.getMap<number>("pageOrderMap");
    expect(getOIds(pageOrderMap)).toContain("p1");

    clearSlideSnapshot("slide:cr022-test");
    ydoc.destroy();
  });

  it("concurrent edits during fetch are preserved", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "server" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
    };

    // 模拟 fetch 期间有延迟，期间用户会添加数据
    let resolveFetch!: (v: unknown) => void;
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    // 预填充 ydoc
    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r_existing"]);
    });

    // 开始 fetch（不 await，模拟异步）
    const fetchPromise = (db as any)._fetchDocument({
      documentName: "table:cr022-concurrent",
      document: ydoc,
      context: {},
    });

    // fetch 期间，用户添加了新记录
    ydoc.transact(() => {
      const records = ydoc.getMap("records");
      const newR = new Y.Map<unknown>();
      newR.set("f1", "user_concurrent");
      records.set("r_concurrent", newR);
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r_concurrent"]);
    });

    // 完成 fetch
    resolveFetch(serverSnapshot);
    const result = await fetchPromise;

    // 应用结果
    Y.applyUpdate(ydoc, result);

    // 服务端数据应存在
    const records = ydoc.getMap("records");
    const r1 = records.get("r1");
    expect(r1).toBeDefined();

    // 用户并发添加的数据也应保留
    const rConcurrent = records.get("r_concurrent") as Y.Map<unknown>;
    expect(rConcurrent).toBeDefined();
    expect(rConcurrent.get("f1")).toBe("user_concurrent");

    ydoc.destroy();
  });

  it("preserves a same-record PositionId move that arrives while the snapshot is fetching", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    let resolveFetch!: (value: unknown) => void;
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );

    const db = new TableDatabase();
    const ydoc = new Y.Doc();
    const record = new Y.Map<unknown>();
    record.set("__order", 1);
    record.set("__position_id", "p1:a0");
    ydoc.getMap<Y.Map<unknown>>("records").set("r1", record);
    ydoc.getMap<string>("rowOrderMap").set("r1", "a0");
    ydoc.getArray<string>("rowOrder").push(["r1"]);

    const fetchPromise = (db as any)._fetchDocument({
      documentName: "table:cr022-concurrent-position",
      document: ydoc,
      context: {},
    });

    record.set("__position_id", "p1:a2");
    resolveFetch({
      records: { r1: { __order: 1, __position_id: "p1:a1" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
      is_truncated: false,
      total_records: 1,
    });

    const update = await fetchPromise;
    Y.applyUpdate(ydoc, update);

    const mergedRecord = ydoc.getMap<Y.Map<unknown>>("records").get("r1")!;
    expect(mergedRecord.get("__position_id")).toBe("p1:a2");
    ydoc.destroy();
  });

  it("preserves ABA record and order-map edits that occur while the snapshot is fetching", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    let resolveFetch!: (value: unknown) => void;
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );

    const db = new TableDatabase();
    const ydoc = new Y.Doc();
    const record = new Y.Map<unknown>();
    record.set("f1", "A");
    record.set("__order", 1);
    record.set("__position_id", "p1:a1");
    ydoc.getMap<Y.Map<unknown>>("records").set("r1", record);
    ydoc.getMap<string>("rowOrderMap").set("r1", "a1");
    ydoc.getArray<string>("rowOrder").push(["r1"]);

    const fetchPromise = (db as any)._fetchDocument({
      documentName: "table:cr022-concurrent-aba",
      document: ydoc,
      context: {},
    });

    record.set("f1", "C");
    record.set("f1", "A");
    record.set("__position_id", "p1:a3");
    record.set("__position_id", "p1:a1");
    ydoc.getMap<string>("rowOrderMap").set("r1", "a3");
    ydoc.getMap<string>("rowOrderMap").set("r1", "a1");
    resolveFetch({
      records: { r1: { f1: "B", __order: 1, __position_id: "p1:a2" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
      is_truncated: false,
      total_records: 1,
    });

    const update = await fetchPromise;
    Y.applyUpdate(ydoc, update);

    const mergedRecord = ydoc.getMap<Y.Map<unknown>>("records").get("r1")!;
    expect(mergedRecord.get("f1")).toBe("A");
    expect(mergedRecord.get("__position_id")).toBe("p1:a1");
    expect(ydoc.getMap("rowOrderMap").get("r1")).toBe("a1");
    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════════
// CR-026: Slide prepareYDocForMerge 清空所有页面
// ══════════════════════════════════════════════════

describe("CR-026: Slide prepareYDocForMerge clears ALL pages", () => {
  it("clears pages not in snapshot.page_order", async () => {
    const { SlideDatabase, clearSlideSnapshot } = await import(
      "../extensions/slide-database.js"
    );

    const db = new SlideDatabase();
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      // page-1: 在 snapshot 中
      const p1 = new Y.Map<unknown>();
      const elOrder1 = new Y.Array<string>();
      elOrder1.push(["el-1"]);
      p1.set("elementOrder", elOrder1);
      const elMap1 = new Y.Map<Y.Map<unknown>>();
      const el1 = new Y.Map<unknown>();
      el1.set("id", "el-1");
      elMap1.set("el-1", el1);
      p1.set("elementsMap", elMap1);
      pagesMap.set("page-1", p1);

      // page-new: 用户新增，不在 snapshot 中
      const pNew = new Y.Map<unknown>();
      const elOrderNew = new Y.Array<string>();
      elOrderNew.push(["el-new-1", "el-new-2"]);
      pNew.set("elementOrder", elOrderNew);
      const elMapNew = new Y.Map<Y.Map<unknown>>();
      const elN1 = new Y.Map<unknown>();
      elN1.set("id", "el-new-1");
      elMapNew.set("el-new-1", elN1);
      const elN2 = new Y.Map<unknown>();
      elN2.set("id", "el-new-2");
      elMapNew.set("el-new-2", elN2);
      pNew.set("elementsMap", elMapNew);
      pagesMap.set("page-new", pNew);

      const pageOrder = ydoc.getArray<string>("pageOrder");
      pageOrder.push(["page-1", "page-new"]);
    });

    // snapshot 只包含 page-1
    const snapshot = { page_order: ["page-1"] };
    (db as any).prepareYDocForMerge(ydoc, snapshot);

    // step4: prepareYDocForMerge 清空 elementOrderMap（Y.Map）和 elementsMap
    // page-1 的 elementOrderMap 应被清空
    const p1 = pagesMap.get("page-1") as Y.Map<unknown>;
    const elOrderMap1 = p1.get("elementOrderMap") as Y.Map<number> | undefined;
    const elMap1 = p1.get("elementsMap") as Y.Map<unknown>;
    if (elOrderMap1 instanceof Y.Map) {
      expect(elOrderMap1.size).toBe(0);
    }
    expect(elMap1.size).toBe(0);

    // page-new 的 elementOrderMap 和 elementsMap 也应被清空
    const pNew = pagesMap.get("page-new") as Y.Map<unknown>;
    const elOrderMapNew = pNew.get("elementOrderMap") as Y.Map<number> | undefined;
    const elMapNew = pNew.get("elementsMap") as Y.Map<unknown>;
    if (elOrderMapNew instanceof Y.Map) {
      expect(elOrderMapNew.size).toBe(0);
    }
    expect(elMapNew.size).toBe(0);

    // step4: pageOrder Y.Array 不再被清空（服务端不再双写 Y.Array）
    // pageOrderMap（Y.Map）被清空
    const pageOrderMap = ydoc.getMap<number>("pageOrderMap");
    expect(pageOrderMap.size).toBe(0);

    clearSlideSnapshot("slide:cr026-test");
    ydoc.destroy();
  });

  it("handles pages with legacy elements Y.Array", async () => {
    const { SlideDatabase, clearSlideSnapshot } = await import(
      "../extensions/slide-database.js"
    );

    const db = new SlideDatabase();
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      const p1 = new Y.Map<unknown>();
      const elements = new Y.Array<unknown>();
      elements.push([{ id: "e1" }, { id: "e2" }]);
      p1.set("elements", elements);
      const animations = new Y.Array<unknown>();
      animations.push([{ type: "fade" }]);
      p1.set("animations", animations);
      pagesMap.set("page-legacy", p1);

      ydoc.getArray<string>("pageOrder").push(["page-legacy"]);
    });

    (db as any).prepareYDocForMerge(ydoc, { page_order: [] });

    const p1 = pagesMap.get("page-legacy") as Y.Map<unknown>;
    const elements = p1.get("elements") as Y.Array<unknown>;
    const animations = p1.get("animations") as Y.Array<unknown>;
    expect(elements.length).toBe(0);
    expect(animations.length).toBe(0);

    clearSlideSnapshot("slide:cr026-legacy");
    ydoc.destroy();
  });

  it("no-op on empty ydoc", async () => {
    const { SlideDatabase, clearSlideSnapshot } = await import(
      "../extensions/slide-database.js"
    );

    const db = new SlideDatabase();
    const ydoc = new Y.Doc();

    expect(() => {
      (db as any).prepareYDocForMerge(ydoc, { page_order: ["nonexistent"] });
    }).not.toThrow();

    clearSlideSnapshot("slide:cr026-empty");
    ydoc.destroy();
  });
});

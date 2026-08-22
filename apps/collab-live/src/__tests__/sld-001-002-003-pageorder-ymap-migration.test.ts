/**
 * SLD-001 / SLD-002 / SLD-003: TabSlide pageOrder & elementOrder Y.Array → Y.Map 迁移测试
 *
 * 覆盖四步迁移法的每一步：
 *   Step1: applySnapshotToDoc 同时写 pageOrder Y.Array + pageOrderMap Y.Map（step3 前）
 *          以及每页 elementOrder Y.Array + elementOrderMap Y.Map（step3 前）
 *   Step2: slide-push.ts 写操作同时维护两套（新增页面、更新 page_order、元素增删）
 *   Step3: buildPersistPayload 优先从 pageOrderMap 读取（fallback pageOrder Y.Array）
 *          yPageToJson 优先从 elementOrderMap 读取（fallback elementOrder Y.Array）
 *   Step4: applySnapshotToDoc 只写 Y.Map，不再写 Y.Array；
 *          prepareYDocForMerge 只清 Y.Map（Y.Map LWW 自然幂等）
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { SlideDatabase, clearSlideSnapshot } from "../extensions/slide-database.js";
import { getOrderedIds, setOrderedIds } from "../lib/y-utils.js";

// ── 常量 ──────────────────────────────────────────────────────────
const YDOC_PAGES = "pages";
const YDOC_PAGE_ORDER = "pageOrder";
const YDOC_PAGE_ORDER_MAP = "pageOrderMap";
const PAGE_ELEMENT_ORDER = "elementOrder";
const PAGE_ELEMENT_ORDER_MAP = "elementOrderMap";

// ── 辅助函数 ──────────────────────────────────────────────────────

/**
 * 构建一个同时包含 Y.Array 和 Y.Map 的完整 SlideYDoc
 */
function buildFullSlideYDoc(
  pages: Record<string, { elements: Record<string, unknown>[] }>,
  pageOrder: string[],
  meta?: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const pagesMap = doc.getMap(YDOC_PAGES);
  const pageOrderArr = doc.getArray<string>(YDOC_PAGE_ORDER);
  const pageOrderMap = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
  const metaMap = doc.getMap("meta");

  doc.transact(() => {
    for (const [pageId, pageData] of Object.entries(pages)) {
      const pageYMap = new Y.Map<unknown>();

      const elMap = new Y.Map<Y.Map<unknown>>();
      const elOrder = new Y.Array<string>();
      const elOrderMap = new Y.Map<number>();
      const orderIds: string[] = [];
      for (const el of pageData.elements) {
        const elId = el.id as string;
        if (!elId) continue;
        const yEl = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(el)) yEl.set(k, v);
        elMap.set(elId, yEl);
        orderIds.push(elId);
      }
      elOrder.push(orderIds);
      for (let i = 0; i < orderIds.length; i++) elOrderMap.set(orderIds[i], i);
      pageYMap.set("elementsMap", elMap);
      pageYMap.set(PAGE_ELEMENT_ORDER, elOrder);
      pageYMap.set(PAGE_ELEMENT_ORDER_MAP, elOrderMap);

      pagesMap.set(pageId, pageYMap);
    }

    pageOrderArr.push(pageOrder);
    setOrderedIds(pageOrderMap, pageOrder);

    if (meta) {
      for (const [k, v] of Object.entries(meta)) metaMap.set(k, v);
    }
  });

  return doc;
}

/**
 * 构建只有 Y.Array（旧格式）的 SlideYDoc，模拟旧客户端
 */
function buildLegacySlideYDoc(
  pages: Record<string, { elements: Record<string, unknown>[] }>,
  pageOrder: string[],
): Y.Doc {
  const doc = new Y.Doc();
  const pagesMap = doc.getMap(YDOC_PAGES);
  const pageOrderArr = doc.getArray<string>(YDOC_PAGE_ORDER);

  doc.transact(() => {
    for (const [pageId, pageData] of Object.entries(pages)) {
      const pageYMap = new Y.Map<unknown>();

      const elMap = new Y.Map<Y.Map<unknown>>();
      const elOrder = new Y.Array<string>();
      const orderIds: string[] = [];
      for (const el of pageData.elements) {
        const elId = el.id as string;
        if (!elId) continue;
        const yEl = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(el)) yEl.set(k, v);
        elMap.set(elId, yEl);
        orderIds.push(elId);
      }
      elOrder.push(orderIds);
      pageYMap.set("elementsMap", elMap);
      pageYMap.set(PAGE_ELEMENT_ORDER, elOrder);
      // 注意：不写 elementOrderMap（模拟旧客户端）

      pagesMap.set(pageId, pageYMap);
    }

    pageOrderArr.push(pageOrder);
    // 注意：不写 pageOrderMap（模拟旧客户端）
  });

  return doc;
}

// ================================================================
// Step 4: applySnapshotToDoc 只写 Y.Map（不再写 Y.Array）
// ================================================================

describe("SLD-001 Step4: applySnapshotToDoc 只写 pageOrderMap（不再双写 Y.Array）", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("applySnapshotToDoc 后 pageOrderMap 正确，pageOrder Y.Array 不被写入", () => {
    const doc = new Y.Doc();

    (db as any).applySnapshotToDoc(doc, {
      pages: [
        { id: "p1", elements: [] },
        { id: "p2", elements: [] },
        { id: "p3", elements: [] },
      ],
      page_order: ["p3", "p1", "p2"],
      version: 1,
      project_name: "Test",
      project_id: "proj-1",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    const arr = doc.getArray<string>(YDOC_PAGE_ORDER);
    const map = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);

    // step4: Y.Map 是主数据源，Y.Array 不再被写入
    expect(getOrderedIds(map)).toEqual(["p3", "p1", "p2"]);
    expect(arr.length).toBe(0);

    doc.destroy();
  });

  it("applySnapshotToDoc 后每页 elementOrderMap 正确，elementOrder Y.Array 不被写入", () => {
    const doc = new Y.Doc();

    (db as any).applySnapshotToDoc(doc, {
      pages: [
        {
          id: "p1",
          elements: [
            { id: "e1", type: "text" },
            { id: "e2", type: "shape" },
            { id: "e3", type: "image" },
          ],
        },
      ],
      page_order: ["p1"],
      version: 1,
      project_name: "Test",
      project_id: "proj-1",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    const pagesMap = doc.getMap(YDOC_PAGES);
    const pageYMap = pagesMap.get("p1") as Y.Map<unknown>;
    expect(pageYMap).toBeDefined();

    const elOrderMap = pageYMap.get(PAGE_ELEMENT_ORDER_MAP) as Y.Map<number>;
    // step4: Y.Map 是主数据源，elementOrder Y.Array 不再被写入
    expect(getOrderedIds(elOrderMap)).toEqual(["e1", "e2", "e3"]);
    // elementOrder Y.Array 不存在（未写入）
    expect(pageYMap.has(PAGE_ELEMENT_ORDER)).toBe(false);

    doc.destroy();
  });

  it("空 page_order 时 pageOrderMap 也为空", () => {
    const doc = new Y.Doc();

    (db as any).applySnapshotToDoc(doc, {
      pages: [],
      page_order: [],
      version: 1,
      project_name: "Test",
      project_id: "proj-1",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    const map = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
    expect(map.size).toBe(0);

    doc.destroy();
  });
});

// ================================================================
// Step 2: prepareYDocForMerge 清空 Y.Map（Y.Array 不再双写，无需清空）
// ================================================================

describe("SLD-001 Step2: prepareYDocForMerge 清空 pageOrderMap（Y.Map 为主数据源）", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("prepareYDocForMerge 后 pageOrderMap 被清空", () => {
    const doc = buildFullSlideYDoc(
      { p1: { elements: [] }, p2: { elements: [] } },
      ["p1", "p2"],
    );

    expect(doc.getMap<number>(YDOC_PAGE_ORDER_MAP).size).toBe(2);

    (db as any).prepareYDocForMerge(doc, {});

    expect(doc.getMap<number>(YDOC_PAGE_ORDER_MAP).size).toBe(0);

    doc.destroy();
  });

  it("prepareYDocForMerge 后每页 elementOrderMap 被清空", () => {
    const doc = buildFullSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text" }, { id: "e2", type: "shape" }] } },
      ["p1"],
    );

    const pageYMap = doc.getMap(YDOC_PAGES).get("p1") as Y.Map<unknown>;
    expect((pageYMap.get(PAGE_ELEMENT_ORDER_MAP) as Y.Map<number>).size).toBe(2);

    (db as any).prepareYDocForMerge(doc, {});

    expect((pageYMap.get(PAGE_ELEMENT_ORDER_MAP) as Y.Map<number>).size).toBe(0);

    doc.destroy();
  });

  it("prepareYDocForMerge 后 Y.Map 清空，applySnapshotToDoc 后 Y.Map 正确重建", () => {
    const doc = buildFullSlideYDoc(
      { p1: { elements: [] } },
      ["p1"],
    );

    (db as any).prepareYDocForMerge(doc, {});
    expect(doc.getMap<number>(YDOC_PAGE_ORDER_MAP).size).toBe(0);

    // 模拟 merge 后 applySnapshotToDoc 重建
    (db as any).applySnapshotToDoc(doc, {
      pages: [{ id: "p1", elements: [] }, { id: "p2", elements: [] }],
      page_order: ["p2", "p1"],
      version: 2,
      project_name: "Test",
      project_id: "proj-1",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    const map = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
    expect(getOrderedIds(map)).toEqual(["p2", "p1"]);

    doc.destroy();
  });
});

// ================================================================
// Step 3: buildPersistPayload 优先从 pageOrderMap 读取
// ================================================================

describe("SLD-002 Step3: buildPersistPayload 优先从 pageOrderMap 读取 page_order", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("pageOrderMap 有数据时 page_order 来自 Y.Map", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const pagesMap = doc.getMap(YDOC_PAGES);
      for (const pid of ["p1", "p2", "p3"]) {
        const pageYMap = new Y.Map<unknown>();
        pageYMap.set("elementsMap", new Y.Map());
        pageYMap.set(PAGE_ELEMENT_ORDER, new Y.Array());
        pageYMap.set(PAGE_ELEMENT_ORDER_MAP, new Y.Map());
        pagesMap.set(pid, pageYMap);
      }

      // Y.Array 顺序：p1, p2, p3
      const arr = doc.getArray<string>(YDOC_PAGE_ORDER);
      arr.push(["p1", "p2", "p3"]);

      // Y.Map 顺序：p3, p1, p2（不同于 Y.Array）
      const map = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
      map.set("p3", 0);
      map.set("p1", 1);
      map.set("p2", 2);

      doc.getMap("meta").set("version", 1);
    });

    const payload = (db as any).buildPersistPayload(doc, "slide:test-step3", {});
    expect(payload).not.toBeNull();
    // 应该来自 Y.Map 的顺序
    expect(payload.changes.page_order).toEqual(["p3", "p1", "p2"]);

    clearSlideSnapshot("slide:test-step3");
    doc.destroy();
  });

  it("pageOrderMap 为空时 fallback 到 pageOrder Y.Array", () => {
    const doc = buildLegacySlideYDoc(
      { p1: { elements: [] }, p2: { elements: [] } },
      ["p2", "p1"],
    );
    doc.getMap("meta").set("version", 1);

    const payload = (db as any).buildPersistPayload(doc, "slide:test-step3-fallback", {});
    expect(payload).not.toBeNull();
    // fallback 到 Y.Array 的顺序
    expect(payload.changes.page_order).toEqual(["p2", "p1"]);

    clearSlideSnapshot("slide:test-step3-fallback");
    doc.destroy();
  });

  it("pageOrderMap 优先于 Y.Array：两者不一致时以 Y.Map 为准", () => {
    const doc = buildFullSlideYDoc(
      { p1: { elements: [] }, p2: { elements: [] } },
      ["p1", "p2"],
      { version: 1 },
    );

    // 手动修改 Y.Map 为不同顺序
    doc.transact(() => {
      const map = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
      map.set("p2", 0);
      map.set("p1", 1);
    });

    const payload = (db as any).buildPersistPayload(doc, "slide:test-step3-priority", {});
    expect(payload).not.toBeNull();
    expect(payload.changes.page_order).toEqual(["p2", "p1"]);

    clearSlideSnapshot("slide:test-step3-priority");
    doc.destroy();
  });
});

// ================================================================
// Step 3: yPageToJson 优先从 elementOrderMap 读取
// ================================================================

describe("SLD-002 Step3: yPageToJson 优先从 elementOrderMap 读取元素顺序", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("elementOrderMap 有数据时元素顺序来自 Y.Map", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const pagesMap = doc.getMap(YDOC_PAGES);
      const pageYMap = new Y.Map<unknown>();

      const elMap = new Y.Map<Y.Map<unknown>>();
      for (const id of ["e1", "e2", "e3"]) {
        const yEl = new Y.Map<unknown>();
        yEl.set("id", id);
        yEl.set("type", "text");
        elMap.set(id, yEl);
      }

      // Y.Array 顺序：e1, e2, e3
      const elOrder = new Y.Array<string>();
      elOrder.push(["e1", "e2", "e3"]);

      // Y.Map 顺序：e3, e1, e2（不同于 Y.Array）
      const elOrderMap = new Y.Map<number>();
      elOrderMap.set("e3", 0);
      elOrderMap.set("e1", 1);
      elOrderMap.set("e2", 2);

      pageYMap.set("elementsMap", elMap);
      pageYMap.set(PAGE_ELEMENT_ORDER, elOrder);
      pageYMap.set(PAGE_ELEMENT_ORDER_MAP, elOrderMap);
      pagesMap.set("p1", pageYMap);

      const pageOrderArr = doc.getArray<string>(YDOC_PAGE_ORDER);
      pageOrderArr.push(["p1"]);
      const pageOrderMap = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
      pageOrderMap.set("p1", 0);

      doc.getMap("meta").set("version", 1);
    });

    const payload = (db as any).buildPersistPayload(doc, "slide:test-el-order", {});
    expect(payload).not.toBeNull();

    // 全量 persist（无 snapshot），走 changed_pages
    const pageData = payload.changes.changed_pages["p1"];
    expect(pageData).toBeDefined();
    const elementIds = (pageData.elements as Record<string, unknown>[]).map((e) => e.id);
    // 应该来自 Y.Map 的顺序：e3, e1, e2
    expect(elementIds).toEqual(["e3", "e1", "e2"]);

    clearSlideSnapshot("slide:test-el-order");
    doc.destroy();
  });

  it("elementOrderMap 为空时 fallback 到 elementOrder Y.Array", () => {
    const doc = buildLegacySlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text" }, { id: "e2", type: "shape" }] } },
      ["p1"],
    );
    doc.getMap("meta").set("version", 1);

    const payload = (db as any).buildPersistPayload(doc, "slide:test-el-fallback", {});
    expect(payload).not.toBeNull();

    const pageData = payload.changes.changed_pages["p1"];
    const elementIds = (pageData.elements as Record<string, unknown>[]).map((e) => e.id);
    expect(elementIds).toEqual(["e1", "e2"]);

    clearSlideSnapshot("slide:test-el-fallback");
    doc.destroy();
  });
});

// ================================================================
// Step 4: CRDT 合并不翻倍（Y.Map LWW 语义验证）
// ================================================================

describe("SLD-003 Step4: Y.Map CRDT 合并不翻倍", () => {
  it("两个 doc 并发写 pageOrderMap → 合并后不翻倍", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const map1 = doc1.getMap<number>(YDOC_PAGE_ORDER_MAP);
    const map2 = doc2.getMap<number>(YDOC_PAGE_ORDER_MAP);

    setOrderedIds(map1, ["p1", "p2"]);
    setOrderedIds(map2, ["p1", "p2", "p3"]);

    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const ids1 = getOrderedIds(map1);
    const ids2 = getOrderedIds(map2);

    expect(ids1).toEqual(ids2);
    expect(new Set(ids1).size).toBe(ids1.length);
    expect(ids1.length).toBe(3);

    doc1.destroy();
    doc2.destroy();
  });

  it("prepareYDocForMerge 后合并：Y.Map 不翻倍（无需清空）", () => {
    // 验证 Y.Map 的 LWW 语义：并发 set 同一 key 时，最终收敛到唯一值，不翻倍
    // 场景：doc1 和 doc2 各自独立写 pageOrderMap，合并后不翻倍
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // doc1 写 p1, p2
    setOrderedIds(doc1.getMap<number>(YDOC_PAGE_ORDER_MAP), ["p1", "p2"]);
    // doc2 写 p1, p2（相同数据）
    setOrderedIds(doc2.getMap<number>(YDOC_PAGE_ORDER_MAP), ["p1", "p2"]);

    // 双向合并
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    // 合并后 Y.Map 不翻倍，仍然只有 p1, p2
    const ids1 = getOrderedIds(doc1.getMap<number>(YDOC_PAGE_ORDER_MAP));
    const ids2 = getOrderedIds(doc2.getMap<number>(YDOC_PAGE_ORDER_MAP));

    expect(ids1.length).toBe(2);
    expect(ids2.length).toBe(2);
    expect(new Set(ids1).size).toBe(2);
    expect(ids1).toEqual(ids2);

    doc1.destroy();
    doc2.destroy();
  });

  it("并发删除页面 + 修改顺序：Y.Map 正确收敛", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const map1 = doc1.getMap<number>(YDOC_PAGE_ORDER_MAP);
    setOrderedIds(map1, ["p1", "p2", "p3"]);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    // doc1 删除 p2
    doc1.transact(() => map1.delete("p2"));

    // doc2 重新排序
    const map2 = doc2.getMap<number>(YDOC_PAGE_ORDER_MAP);
    setOrderedIds(map2, ["p3", "p2", "p1"]);

    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const ids1 = getOrderedIds(map1);
    const ids2 = getOrderedIds(map2);
    expect(ids1).toEqual(ids2);

    doc1.destroy();
    doc2.destroy();
  });
});

// ================================================================
// 端到端场景：saveSnapshot 使用 pageOrderMap
// ================================================================

describe("SLD-003 端到端：saveSnapshot 优先读 pageOrderMap", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("saveSnapshot 从 pageOrderMap 读取顺序", () => {
    const doc = buildFullSlideYDoc(
      { p1: { elements: [] }, p2: { elements: [] } },
      ["p2", "p1"],
      { version: 1 },
    );

    db.saveSnapshot("slide:snap-test", doc);
    const snapshot = db.snapshotCache.get("slide:snap-test") as any;
    expect(snapshot).toBeDefined();
    expect(snapshot.pageOrder).toEqual(["p2", "p1"]);

    clearSlideSnapshot("slide:snap-test");
    doc.destroy();
  });

  it("saveSnapshot fallback 到 Y.Array（旧格式 doc）", () => {
    const doc = buildLegacySlideYDoc(
      { p1: { elements: [] }, p2: { elements: [] } },
      ["p2", "p1"],
    );
    doc.getMap("meta").set("version", 1);

    db.saveSnapshot("slide:snap-legacy", doc);
    const snapshot = db.snapshotCache.get("slide:snap-legacy") as any;
    expect(snapshot).toBeDefined();
    expect(snapshot.pageOrder).toEqual(["p2", "p1"]);

    clearSlideSnapshot("slide:snap-legacy");
    doc.destroy();
  });

  it("完整流程：applySnapshotToDoc → saveSnapshot → buildPersistPayload 无变更返回 null", () => {
    const doc = new Y.Doc();

    (db as any).applySnapshotToDoc(doc, {
      pages: [
        { id: "p1", elements: [{ id: "e1", type: "text" }] },
        { id: "p2", elements: [] },
      ],
      page_order: ["p1", "p2"],
      version: 1,
      project_name: "Test",
      project_id: "proj-1",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    db.saveSnapshot("slide:e2e-test", doc);

    // 无变更时 buildPersistPayload 应返回 null
    const payload = (db as any).buildPersistPayload(doc, "slide:e2e-test", {});
    expect(payload).toBeNull();

    clearSlideSnapshot("slide:e2e-test");
    doc.destroy();
  });

  it("完整流程：修改页面顺序后 buildPersistPayload 返回正确 page_order", () => {
    const doc = new Y.Doc();

    (db as any).applySnapshotToDoc(doc, {
      pages: [
        { id: "p1", elements: [] },
        { id: "p2", elements: [] },
      ],
      page_order: ["p1", "p2"],
      version: 1,
      project_name: "Test",
      project_id: "proj-1",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    db.saveSnapshot("slide:e2e-reorder", doc);

    // 修改 pageOrderMap
    doc.transact(() => {
      const map = doc.getMap<number>(YDOC_PAGE_ORDER_MAP);
      setOrderedIds(map, ["p2", "p1"]);
    });

    const payload = (db as any).buildPersistPayload(doc, "slide:e2e-reorder", {});
    expect(payload).not.toBeNull();
    expect(payload.changes.page_order).toEqual(["p2", "p1"]);

    clearSlideSnapshot("slide:e2e-reorder");
    doc.destroy();
  });
});

// ================================================================
// 向后兼容：旧 Y.Doc（只有 Y.Array）正常工作
// ================================================================

describe("SLD-001 向后兼容：旧格式 Y.Doc 正常工作", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("只有 pageOrder Y.Array 的旧 doc：buildPersistPayload 正常产出 payload", () => {
    const doc = buildLegacySlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text" }] } },
      ["p1"],
    );
    doc.getMap("meta").set("version", 1);

    const payload = (db as any).buildPersistPayload(doc, "slide:legacy-compat", {});
    expect(payload).not.toBeNull();
    expect(payload.changes.page_order).toEqual(["p1"]);

    clearSlideSnapshot("slide:legacy-compat");
    doc.destroy();
  });

  it("只有 elementOrder Y.Array 的旧 doc：yPageToJson 正常提取元素", () => {
    const doc = buildLegacySlideYDoc(
      {
        p1: {
          elements: [
            { id: "e1", type: "text" },
            { id: "e2", type: "shape" },
          ],
        },
      },
      ["p1"],
    );
    doc.getMap("meta").set("version", 1);

    const payload = (db as any).buildPersistPayload(doc, "slide:legacy-el-compat", {});
    expect(payload).not.toBeNull();

    const pageData = payload.changes.changed_pages["p1"];
    const elementIds = (pageData.elements as Record<string, unknown>[]).map((e) => e.id);
    expect(elementIds).toEqual(["e1", "e2"]);

    clearSlideSnapshot("slide:legacy-el-compat");
    doc.destroy();
  });
});

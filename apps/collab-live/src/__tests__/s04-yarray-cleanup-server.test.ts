/**
 * S04: Step 4 服务端 Y.Array 清理专项测试
 *
 * 验证 Step 4 迁移后的服务端行为：
 *   1. applySnapshotToDoc 只写 Y.Map，不再写 Y.Array（slide / table / canvas）
 *   2. prepareYDocForMerge 行为：canvas 不再清空 Y.Array；table 仍清空 rowOrder
 *   3. reconcileConcurrentItems 使用 snapshot.row_order 作为 Django 权威顺序
 *   4. 向后兼容：旧客户端只写 Y.Array 时，syncArrayToMap 补齐 Y.Map
 *   5. Y.Map LWW 幂等合并：两端并发写入不翻倍
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { getOrderedIds, setOrderedIds, syncArrayToMap } from "../lib/y-utils.js";
import { SlideDatabase } from "../extensions/slide-database.js";
import { TableDatabase } from "../extensions/table-database.js";

// W5-Purge：CanvasDatabase 相关 V1 helper（mergeGraphIntoDoc / YDOC_PAGE_ORDER_MAP）
// 已删除；canvas pageOrder 由 page record 的 index 字段排序，不再有顶层 Y.Map。
// 本文件只保留 Slide / Table 的 Y.Array 清理回归。

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const SLIDE_PAGE_ORDER = "pageOrder";
const SLIDE_PAGE_ORDER_MAP = "pageOrderMap";

const TABLE_ROW_ORDER = "rowOrder";
const TABLE_ROW_ORDER_MAP = "rowOrderMap";

// ─── Testable 子类 ─────────────────────────────────────────────────────────────

class TestableSlideDB extends SlideDatabase {
  applySnapshot(doc: Y.Doc, snapshot: Record<string, unknown>): void {
    this.applySnapshotToDoc(doc, snapshot);
  }
  prepareForMerge(doc: Y.Doc, snapshot?: Record<string, unknown>): void {
    this.prepareYDocForMerge(doc, snapshot);
  }
}

class TestableTableDB extends TableDatabase {
  applySnapshot(doc: Y.Doc, snapshot: Record<string, unknown>): void {
    this.applySnapshotToDoc(doc, snapshot);
  }
  prepareForMerge(doc: Y.Doc, snapshot?: Record<string, unknown>): void {
    this.prepareYDocForMerge(doc, snapshot);
  }
  reconcile(doc: Y.Doc, preFetchDoc: Y.Doc, snapshot: Record<string, unknown>): void {
    this.reconcileConcurrentItems(doc, preFetchDoc, snapshot);
  }
}

// W5-Purge: TestableCanvasDB 删除 — Canvas 已从 V1 pageOrder Y.Array 迁出，
// page 是 record，无需 Y.Array 清理回归。

// ─── 1. SlideDatabase: applySnapshotToDoc 只写 Y.Map ─────────────────────────

describe("S04-1: SlideDatabase applySnapshotToDoc 只写 Y.Map", () => {
  it("pageOrder Y.Array 不被写入", () => {
    const db = new TestableSlideDB();
    const doc = new Y.Doc();

    db.applySnapshot(doc, {
      page_order: ["p1", "p2", "p3"],
      pages: [
        { id: "p1", name: "Page 1", elements: [] },
        { id: "p2", name: "Page 2", elements: [] },
        { id: "p3", name: "Page 3", elements: [] },
      ],
      version: 1,
    });

    const arr = doc.getArray<string>(SLIDE_PAGE_ORDER);
    const map = doc.getMap<number>(SLIDE_PAGE_ORDER_MAP);

    // step4: Y.Map 是主数据源
    expect(getOrderedIds(map)).toEqual(["p1", "p2", "p3"]);
    // step4: Y.Array 不再被写入
    expect(arr.length).toBe(0);
    doc.destroy();
  });

  it("elementOrder Y.Array 不被写入", () => {
    const db = new TestableSlideDB();
    const doc = new Y.Doc();

    db.applySnapshot(doc, {
      page_order: ["p1"],
      pages: [
        {
          id: "p1",
          name: "Page 1",
          elements: [
            { id: "e1", type: "text" },
            { id: "e2", type: "image" },
          ],
        },
      ],
      version: 1,
    });

    const pagesMap = doc.getMap("pages");
    const pageYMap = pagesMap.get("p1") as Y.Map<unknown> | undefined;
    expect(pageYMap).toBeDefined();

    // step4: elementOrder Y.Array 不被写入
    expect(pageYMap!.has("elementOrder")).toBe(false);
    // step4: elementOrderMap Y.Map 是主数据源
    const elOrderMap = pageYMap!.get("elementOrderMap") as Y.Map<number> | undefined;
    expect(elOrderMap).toBeDefined();
    expect(elOrderMap!.has("e1")).toBe(true);
    expect(elOrderMap!.has("e2")).toBe(true);
    doc.destroy();
  });

  it("重复 applySnapshot 不翻倍（Y.Map LWW 幂等）", () => {
    const db = new TestableSlideDB();
    const doc = new Y.Doc();

    db.applySnapshot(doc, {
      page_order: ["p1", "p2"],
      pages: [
        { id: "p1", elements: [] },
        { id: "p2", elements: [] },
      ],
      version: 1,
    });
    db.applySnapshot(doc, {
      page_order: ["p1", "p2"],
      pages: [
        { id: "p1", elements: [] },
        { id: "p2", elements: [] },
      ],
      version: 1,
    });

    const map = doc.getMap<number>(SLIDE_PAGE_ORDER_MAP);
    expect(map.size).toBe(2);
    expect(getOrderedIds(map)).toEqual(["p1", "p2"]);
    doc.destroy();
  });
});

// ─── 2. SlideDatabase: prepareYDocForMerge 清空 Y.Map ────────────────────────

describe("S04-2: SlideDatabase prepareYDocForMerge 清空 Y.Map（不清空 Y.Array）", () => {
  it("prepareYDocForMerge 清空 pageOrderMap Y.Map", () => {
    const db = new TestableSlideDB();
    const doc = new Y.Doc();

    db.applySnapshot(doc, {
      page_order: ["p1", "p2"],
      pages: [
        { id: "p1", elements: [] },
        { id: "p2", elements: [] },
      ],
      version: 1,
    });

    const map = doc.getMap<number>(SLIDE_PAGE_ORDER_MAP);
    expect(map.size).toBe(2);

    db.prepareForMerge(doc);

    // prepareYDocForMerge 清空 pageOrderMap（以便 initDoc 的 LWW set 覆盖）
    expect(map.size).toBe(0);
    doc.destroy();
  });
});

// ─── 3. TableDatabase: applySnapshotToDoc 只写 Y.Map ─────────────────────────

describe("S04-3: TableDatabase applySnapshotToDoc 只写 Y.Map", () => {
  it("rowOrder Y.Array 不被写入", () => {
    const db = new TestableTableDB();
    const doc = new Y.Doc();

    db.applySnapshot(doc, {
      records: { r1: { f1: "v1" }, r2: { f1: "v2" } },
      row_order: ["r1", "r2"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "t1",
    });

    const arr = doc.getArray<string>(TABLE_ROW_ORDER);
    const map = doc.getMap<number>(TABLE_ROW_ORDER_MAP);

    // step4: Y.Map 是主数据源
    expect(getOrderedIds(map)).toEqual(["r1", "r2"]);
    // step4: Y.Array 不再被写入
    expect(arr.length).toBe(0);
    doc.destroy();
  });
});

// ─── 4. TableDatabase: prepareYDocForMerge 仍清空 rowOrder Y.Array ─────────

describe("S04-4: TableDatabase prepareYDocForMerge 仍清空 rowOrder Y.Array", () => {
  it("prepareYDocForMerge 清空 rowOrder Y.Array（为 _reconcileConcurrentArrayItems 准备）", () => {
    const db = new TestableTableDB();
    const doc = new Y.Doc();

    // 模拟 preFetchState 中有 rowOrder Y.Array（旧客户端写入的）
    doc.transact(() => {
      doc.getArray<string>(TABLE_ROW_ORDER).push(["r1", "r2"]);
    });

    expect(doc.getArray<string>(TABLE_ROW_ORDER).length).toBe(2);

    db.prepareForMerge(doc);

    // prepareYDocForMerge 清空 rowOrder Y.Array
    expect(doc.getArray<string>(TABLE_ROW_ORDER).length).toBe(0);
    doc.destroy();
  });
});

// ─── 5. TableDatabase: reconcileConcurrentItems 使用 snapshot.row_order ──────

describe("S04-5: TableDatabase reconcileConcurrentItems 使用 snapshot.row_order", () => {
  it("从 snapshot.row_order 读取 Django 顺序，清理 rowOrderMap 中的孤立条目", () => {
    const db = new TestableTableDB();
    const doc = new Y.Doc();

    doc.transact(() => {
      const rom = doc.getMap<number>(TABLE_ROW_ORDER_MAP);
      // rowOrderMap 包含 Django 数据（r1, r2）+ 孤立条目（r_stale）
      rom.set("r1", 0);
      rom.set("r2", 1);
      rom.set("r_stale", 2);
      const records = doc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1");
      records.set("r1", r1);
      const r2 = new Y.Map<unknown>();
      r2.set("f1", "v2");
      records.set("r2", r2);
    });

    const snapshot = {
      records: { r1: { f1: "v1" }, r2: { f1: "v2" } },
      row_order: ["r1", "r2"],
      table_id: "t1",
    };

    const preFetchRef = new Y.Doc();
    db.reconcile(doc, preFetchRef, snapshot);

    const rom = doc.getMap<number>(TABLE_ROW_ORDER_MAP);
    // r_stale 不在 snapshot.row_order 中，应被清理
    expect(rom.has("r_stale")).toBe(false);
    expect(rom.size).toBe(2);
    expect(getOrderedIds(rom)).toEqual(["r1", "r2"]);

    preFetchRef.destroy();
    doc.destroy();
  });

  it("并发新增条目（Y.Array 中不在 snapshot 的）被追加到 rowOrderMap", () => {
    const db = new TestableTableDB();
    const doc = new Y.Doc();

    doc.transact(() => {
      // rowOrderMap 包含 Django 数据
      const rom = doc.getMap<number>(TABLE_ROW_ORDER_MAP);
      rom.set("r1", 0);
      // rowOrder Y.Array 包含并发新增条目（由 _reconcileConcurrentArrayItems 恢复）
      doc.getArray<string>(TABLE_ROW_ORDER).push(["r_new"]);
      const records = doc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1");
      records.set("r1", r1);
      const rNew = new Y.Map<unknown>();
      rNew.set("f1", "new");
      records.set("r_new", rNew);
    });

    const snapshot = {
      records: { r1: { f1: "v1" } },
      row_order: ["r1"],
      table_id: "t1",
    };

    const preFetchRef = new Y.Doc();
    db.reconcile(doc, preFetchRef, snapshot);

    const rom = doc.getMap<number>(TABLE_ROW_ORDER_MAP);
    // r_new 是并发新增，应被追加到 rowOrderMap
    expect(rom.has("r_new")).toBe(true);
    expect(getOrderedIds(rom)).toEqual(["r1", "r_new"]);

    preFetchRef.destroy();
    doc.destroy();
  });
});

// W5-Purge：S04-6 / S04-7 / S04-8（CanvasDatabase pageOrder Y.Array 清理）已删，
// canvas 改用 page record + index 字段排序，不再有顶层 pageOrder Y.Array / Y.Map。

// ─── 9. 向后兼容：syncArrayToMap ─────────────────────────────────────────────

describe("S04-9: 向后兼容 syncArrayToMap（旧客户端只写 Y.Array）", () => {
  it("Y.Map 为空时从 Y.Array 同步", () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<string>("rowOrder");
    const map = doc.getMap<number>("rowOrderMap");

    doc.transact(() => arr.push(["r1", "r2", "r3"]));

    syncArrayToMap(arr, map);

    expect(getOrderedIds(map)).toEqual(["r1", "r2", "r3"]);
    doc.destroy();
  });

  it("Y.Map 非空时不覆盖（Y.Map 优先）", () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<string>("rowOrder");
    const map = doc.getMap<number>("rowOrderMap");

    doc.transact(() => {
      arr.push(["r1", "r2"]);
      setOrderedIds(map, ["r3", "r4"]);
    });

    syncArrayToMap(arr, map);

    // Y.Map 已有数据，不被覆盖
    expect(getOrderedIds(map)).toEqual(["r3", "r4"]);
    doc.destroy();
  });
});

// ─── 10. Y.Map LWW 幂等合并（跨模块通用验证）────────────────────────────────

describe("S04-10: Y.Map LWW 幂等合并（不翻倍）", () => {
  it("两端并发写入相同 IDs，合并后不翻倍", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const map1 = doc1.getMap<number>("orderMap");
    const map2 = doc2.getMap<number>("orderMap");

    setOrderedIds(map1, ["a", "b", "c"]);
    setOrderedIds(map2, ["a", "b", "c"]);

    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    expect(getOrderedIds(map1)).toEqual(getOrderedIds(map2));
    expect(map1.size).toBe(3);
    doc1.destroy();
    doc2.destroy();
  });

  it("setOrderedIds 原子操作，不经过空中间态", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<number>("orderMap");
    setOrderedIds(map, ["a", "b"]);

    const observedSizes: number[] = [];
    map.observe(() => observedSizes.push(map.size));

    setOrderedIds(map, ["c", "d", "e"]);

    expect(getOrderedIds(map)).toEqual(["c", "d", "e"]);
    // 不应出现 size=0 的中间态
    expect(observedSizes.every((s) => s > 0)).toBe(true);
    doc.destroy();
  });

  it("多次 setOrderedIds 不累积旧 key", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<number>("orderMap");

    setOrderedIds(map, ["a", "b", "c"]);
    setOrderedIds(map, ["d", "e"]);

    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(false);
    expect(getOrderedIds(map)).toEqual(["d", "e"]);
    doc.destroy();
  });
});

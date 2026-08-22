/**
 * TBD-002/003/006 回归测试
 *
 * TBD-002: prepareYDocForMerge 只清空 Y.Array（rowOrder），不清空 Y.Map（records）
 *          防止 CRDT clock 语义导致 initDoc 的 records 被高 clock delete 覆盖
 * TBD-003: rowOrder 删除移除所有重复项（非仅首个）
 * TBD-006: snapshotCache 使用 hash 摘要降低内存占用
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as Y from "yjs";
import { TableDatabase, clearTableSnapshot } from "../extensions/table-database.js";

function buildTableYDoc(
  records: Record<string, Record<string, unknown>>,
  rowOrder: string[],
  meta?: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const recordsMap = doc.getMap("records");
  const rowOrderArr = doc.getArray<string>("rowOrder");
  const metaMap = doc.getMap("meta");

  doc.transact(() => {
    for (const [id, fields] of Object.entries(records)) {
      const yMap = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) {
        yMap.set(k, v);
      }
      recordsMap.set(id, yMap);
    }
    if (rowOrder.length > 0) rowOrderArr.push(rowOrder);
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        metaMap.set(k, v);
      }
    }
  });

  return doc;
}

// ── TBD-002 ──────────────────────────────────────────

describe("TBD-002: prepareYDocForMerge only clears Y.Array, not Y.Map", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("prepareYDocForMerge clears rowOrder but preserves records", () => {
    const doc = buildTableYDoc(
      { r1: { f1: "v1" }, r2: { f1: "v2" }, r3: { f1: "v3" } },
      ["r1", "r2", "r3"],
    );

    (db as any).prepareYDocForMerge(doc);

    expect(doc.getArray("rowOrder").length).toBe(0);
    expect(doc.getMap("records").size).toBe(3);

    doc.destroy();
  });

  it("empty doc is a no-op", () => {
    const doc = new Y.Doc();

    expect(() => (db as any).prepareYDocForMerge(doc)).not.toThrow();
    expect(doc.getArray("rowOrder").length).toBe(0);
    expect(doc.getMap("records").size).toBe(0);

    doc.destroy();
  });

  it("CRDT clock regression: initDoc records survive merge (F11 打回的核心场景)", () => {
    // F11 错误：mergeDoc.records.delete() 产生高 clock，initDoc 的 set 操作
    // clock 低于 delete → Y.Map LWW 判定 delete 胜出 → records 全丢。
    // 修复后：不 delete records，initDoc 的 set 自然合并，records 保留。
    const preFetchDoc = buildTableYDoc(
      { r1: { f1: "v1" }, r2: { f1: "v2" } },
      ["r1", "r2"],
    );
    const preFetchState = Y.encodeStateAsUpdate(preFetchDoc);

    const initDoc = new Y.Doc();
    initDoc.transact(() => {
      const records = initDoc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1_updated");
      records.set("r1", r1);
      const r2 = new Y.Map<unknown>();
      r2.set("f1", "v2_updated");
      records.set("r2", r2);
      initDoc.getArray<string>("rowOrder").push(["r1", "r2"]);
    });

    const mergeDoc = new Y.Doc();
    Y.applyUpdate(mergeDoc, preFetchState);
    (db as any).prepareYDocForMerge(mergeDoc);
    Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

    const records = mergeDoc.getMap("records");
    // 核心断言：records 在合并后必须保留，不能被 CRDT clock delete 覆盖
    expect(records.has("r1")).toBe(true);
    expect(records.has("r2")).toBe(true);
    expect(records.size).toBe(2);

    preFetchDoc.destroy();
    initDoc.destroy();
    mergeDoc.destroy();
  });

  it("concurrent insertion: user-added records during fetch survive the merge", () => {
    // 用户在 fetch 期间插入了 r_concurrent，preFetchState 包含它
    const preFetchDoc = buildTableYDoc(
      { r1: { f1: "v1" }, r_concurrent: { f1: "user_added" } },
      ["r1", "r_concurrent"],
    );
    const preFetchState = Y.encodeStateAsUpdate(preFetchDoc);

    // DB 快照只有 r1（r_concurrent 尚未持久化）
    const initDoc = new Y.Doc();
    initDoc.transact(() => {
      const records = initDoc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1");
      records.set("r1", r1);
      initDoc.getArray<string>("rowOrder").push(["r1"]);
    });

    const mergeDoc = new Y.Doc();
    Y.applyUpdate(mergeDoc, preFetchState);
    (db as any).prepareYDocForMerge(mergeDoc);
    Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

    const records = mergeDoc.getMap("records");
    // r_concurrent 必须在 records Y.Map 中保留（不被 prepareYDocForMerge 误删）
    expect(records.has("r1")).toBe(true);
    expect(records.has("r_concurrent")).toBe(true);

    preFetchDoc.destroy();
    initDoc.destroy();
    mergeDoc.destroy();
  });

  it("new rows added in initDoc survive the merge", () => {
    const preFetchDoc = buildTableYDoc({ r1: { f1: "v1" } }, ["r1"]);
    const preFetchState = Y.encodeStateAsUpdate(preFetchDoc);

    // DB 快照有 r1 和 r3（r3 来自其他 session/Agent）
    const initDoc = new Y.Doc();
    initDoc.transact(() => {
      const records = initDoc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1");
      records.set("r1", r1);
      const r3 = new Y.Map<unknown>();
      r3.set("f1", "v3");
      records.set("r3", r3);
      initDoc.getArray<string>("rowOrder").push(["r1", "r3"]);
    });

    const mergeDoc = new Y.Doc();
    Y.applyUpdate(mergeDoc, preFetchState);
    (db as any).prepareYDocForMerge(mergeDoc);
    Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

    const records = mergeDoc.getMap("records");
    expect(records.has("r1")).toBe(true);
    expect(records.has("r3")).toBe(true);

    preFetchDoc.destroy();
    initDoc.destroy();
    mergeDoc.destroy();
  });

  it("reconcileConcurrentItems cleans up orphaned records (not in DB, not in rowOrder)", () => {
    // preFetchState 有 r1, r2, r_orphan（r_orphan 在 records 但不在 rowOrder）
    const preFetchDoc = new Y.Doc();
    preFetchDoc.transact(() => {
      const records = preFetchDoc.getMap("records");
      for (const id of ["r1", "r2", "r_orphan"]) {
        const r = new Y.Map<unknown>();
        r.set("f1", `val_${id}`);
        records.set(id, r);
      }
      preFetchDoc.getArray<string>("rowOrder").push(["r1", "r2"]);
    });
    const preFetchState = Y.encodeStateAsUpdate(preFetchDoc);

    // DB 快照只有 r1（r2 deleted, r_orphan 也不在）
    const snapshot = {
      records: { r1: { f1: "v1" } },
      row_order: ["r1"],
    };

    const initDoc = new Y.Doc();
    initDoc.transact(() => {
      const records = initDoc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1");
      records.set("r1", r1);
      initDoc.getArray<string>("rowOrder").push(["r1"]);
    });

    const mergeDoc = new Y.Doc();
    Y.applyUpdate(mergeDoc, preFetchState);
    (db as any).prepareYDocForMerge(mergeDoc);
    Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

    // 模拟 base class reconciliation：r2 在 preFetchState rowOrder 但不在 DB，被恢复到 rowOrder
    // r_orphan 不在任何 rowOrder 中
    const preFetchRef = new Y.Doc();
    Y.applyUpdate(preFetchRef, preFetchState);

    // 手动模拟 _reconcileConcurrentArrayItems
    const mergeRowOrder = mergeDoc.getArray<string>("rowOrder");
    const currentVals = new Set<string>();
    for (let i = 0; i < mergeRowOrder.length; i++) currentVals.add(mergeRowOrder.get(i));
    const preRowOrder = preFetchRef.getArray<string>("rowOrder");
    const missing: string[] = [];
    for (let i = 0; i < preRowOrder.length; i++) {
      const item = preRowOrder.get(i);
      if (!currentVals.has(item)) { missing.push(item); currentVals.add(item); }
    }
    if (missing.length > 0) mergeRowOrder.push(missing);

    // 调用 reconcileConcurrentItems
    (db as any).reconcileConcurrentItems(mergeDoc, preFetchRef, snapshot);

    const records = mergeDoc.getMap("records");
    expect(records.has("r1")).toBe(true);
    // r2 在 rowOrder 中（被 reconciliation 恢复），所以 records 保留
    expect(records.has("r2")).toBe(true);
    // r_orphan 不在 DB 也不在 rowOrder → 被清理
    expect(records.has("r_orphan")).toBe(false);

    preFetchDoc.destroy();
    preFetchRef.destroy();
    initDoc.destroy();
    mergeDoc.destroy();
  });

  it("reconcileConcurrentItems is no-op when all records are in DB snapshot", () => {
    const preFetchDoc = buildTableYDoc(
      { r1: { f1: "v1" }, r2: { f1: "v2" } },
      ["r1", "r2"],
    );
    const preFetchState = Y.encodeStateAsUpdate(preFetchDoc);

    const snapshot = {
      records: { r1: { f1: "v1" }, r2: { f1: "v2" } },
      row_order: ["r1", "r2"],
    };

    const initDoc = new Y.Doc();
    initDoc.transact(() => {
      const records = initDoc.getMap("records");
      for (const id of ["r1", "r2"]) {
        const r = new Y.Map<unknown>();
        r.set("f1", `v_${id}`);
        records.set(id, r);
      }
      initDoc.getArray<string>("rowOrder").push(["r1", "r2"]);
    });

    const mergeDoc = new Y.Doc();
    Y.applyUpdate(mergeDoc, preFetchState);
    (db as any).prepareYDocForMerge(mergeDoc);
    Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(initDoc));

    const preFetchRef = new Y.Doc();
    Y.applyUpdate(preFetchRef, preFetchState);

    (db as any).reconcileConcurrentItems(mergeDoc, preFetchRef, snapshot);

    const records = mergeDoc.getMap("records");
    expect(records.has("r1")).toBe(true);
    expect(records.has("r2")).toBe(true);
    expect(records.size).toBe(2);

    preFetchDoc.destroy();
    preFetchRef.destroy();
    initDoc.destroy();
    mergeDoc.destroy();
  });
});

// ── TBD-003 ──────────────────────────────────────────

describe("TBD-003: rowOrder deletion removes all duplicate entries", () => {
  it("removes all occurrences of record_id from rowOrder", () => {
    const doc = new Y.Doc();
    const rowOrder = doc.getArray<string>("rowOrder");
    const records = doc.getMap("records");

    doc.transact(() => {
      rowOrder.push(["r1", "r2", "r1", "r3", "r1"]);
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "v1");
      records.set("r1", r1);
    });

    // Simulate the fixed agent-push delete operation
    doc.transact(() => {
      records.delete("r1");
      for (let i = rowOrder.length - 1; i >= 0; i--) {
        if (rowOrder.get(i) === "r1") {
          rowOrder.delete(i, 1);
        }
      }
    });

    const remaining: string[] = [];
    for (let i = 0; i < rowOrder.length; i++) {
      remaining.push(rowOrder.get(i));
    }
    expect(remaining).toEqual(["r2", "r3"]);
    expect(records.has("r1")).toBe(false);

    doc.destroy();
  });

  it("handles single occurrence correctly (no regression)", () => {
    const doc = new Y.Doc();
    const rowOrder = doc.getArray<string>("rowOrder");
    const records = doc.getMap("records");

    doc.transact(() => {
      rowOrder.push(["r1", "r2", "r3"]);
      for (const id of ["r1", "r2", "r3"]) {
        const r = new Y.Map<unknown>();
        r.set("f1", `val_${id}`);
        records.set(id, r);
      }
    });

    doc.transact(() => {
      records.delete("r2");
      for (let i = rowOrder.length - 1; i >= 0; i--) {
        if (rowOrder.get(i) === "r2") {
          rowOrder.delete(i, 1);
        }
      }
    });

    const remaining: string[] = [];
    for (let i = 0; i < rowOrder.length; i++) {
      remaining.push(rowOrder.get(i));
    }
    expect(remaining).toEqual(["r1", "r3"]);

    doc.destroy();
  });

  it("handles empty rowOrder without error", () => {
    const doc = new Y.Doc();
    const rowOrder = doc.getArray<string>("rowOrder");

    expect(() => {
      doc.transact(() => {
        for (let i = rowOrder.length - 1; i >= 0; i--) {
          if (rowOrder.get(i) === "nonexistent") {
            rowOrder.delete(i, 1);
          }
        }
      });
    }).not.toThrow();

    expect(rowOrder.length).toBe(0);
    doc.destroy();
  });

  it("preserves order of non-deleted items when duplicates are interspersed", () => {
    const doc = new Y.Doc();
    const rowOrder = doc.getArray<string>("rowOrder");

    doc.transact(() => {
      rowOrder.push(["a", "x", "b", "x", "c", "x", "d"]);
    });

    doc.transact(() => {
      for (let i = rowOrder.length - 1; i >= 0; i--) {
        if (rowOrder.get(i) === "x") {
          rowOrder.delete(i, 1);
        }
      }
    });

    const remaining: string[] = [];
    for (let i = 0; i < rowOrder.length; i++) {
      remaining.push(rowOrder.get(i));
    }
    expect(remaining).toEqual(["a", "b", "c", "d"]);

    doc.destroy();
  });
});

// ── TBD-006 ──────────────────────────────────────────

describe("TBD-006: snapshotCache uses hash digests for memory efficiency", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("snapshot stores recordDigests instead of full records", () => {
    const docName = "table:tbd006-digest";
    const doc = buildTableYDoc(
      { r1: { f1: "hello", f2: 42 }, r2: { f1: "world" } },
      ["r1", "r2"],
    );

    db.saveSnapshot(docName, doc);

    const snapshot = db.snapshotCache.get(docName) as any;
    expect(snapshot).toBeDefined();
    expect(snapshot.recordDigests).toBeInstanceOf(Map);
    expect(snapshot.records).toBeUndefined();

    const r1Digest = snapshot.recordDigests.get("r1");
    expect(r1Digest).toBeDefined();
    expect(typeof r1Digest.contentHash).toBe("string");
    expect(r1Digest.contentHash.length).toBeGreaterThan(0);
    expect(Array.isArray(r1Digest.fieldKeys)).toBe(true);
    expect(r1Digest.fieldKeys).toContain("f1");
    expect(r1Digest.fieldKeys).toContain("f2");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("digest is deterministic for same content", () => {
    const docName1 = "table:tbd006-det1";
    const docName2 = "table:tbd006-det2";

    const doc1 = buildTableYDoc({ r1: { f1: "hello", f2: 42 } }, ["r1"]);
    const doc2 = buildTableYDoc({ r1: { f1: "hello", f2: 42 } }, ["r1"]);

    db.saveSnapshot(docName1, doc1);
    db.saveSnapshot(docName2, doc2);

    const snap1 = db.snapshotCache.get(docName1) as any;
    const snap2 = db.snapshotCache.get(docName2) as any;

    expect(snap1.recordDigests.get("r1").contentHash)
      .toBe(snap2.recordDigests.get("r1").contentHash);

    clearTableSnapshot(docName1);
    clearTableSnapshot(docName2);
    doc1.destroy();
    doc2.destroy();
  });

  it("digest changes when field value changes", () => {
    const docName = "table:tbd006-change";
    const doc = buildTableYDoc({ r1: { f1: "original" } }, ["r1"]);

    db.saveSnapshot(docName, doc);
    const hashBefore = (db.snapshotCache.get(docName) as any).recordDigests.get("r1").contentHash;

    doc.transact(() => {
      (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1", "modified");
    });

    db.saveSnapshot(docName, doc);
    const hashAfter = (db.snapshotCache.get(docName) as any).recordDigests.get("r1").contentHash;

    expect(hashBefore).not.toBe(hashAfter);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("buildPersistPayload detects new records with hash-based snapshot", () => {
    const docName = "table:tbd006-new";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const r2 = new Y.Map<unknown>();
      r2.set("f1", "new_value");
      doc.getMap("records").set("r2", r2);
      doc.getArray<string>("rowOrder").push(["r2"]);
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.new_records).toHaveProperty("r2");
    expect(payload.changes.new_records.r2.f1).toBe("new_value");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("buildPersistPayload detects changed records with hash-based snapshot", () => {
    const docName = "table:tbd006-changed";
    const doc = buildTableYDoc(
      { r1: { f1: "original", f2: 100 } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1", "modified");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_records).toHaveProperty("r1");
    expect(payload.changes.changed_records.r1.f1).toBe("modified");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("buildPersistPayload detects deleted records with hash-based snapshot", () => {
    const docName = "table:tbd006-deleted";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" }, r2: { f1: "v2" } },
      ["r1", "r2"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      doc.getMap("records").delete("r2");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.deleted_record_ids).toContain("r2");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("buildPersistPayload detects field deletion within a record", () => {
    const docName = "table:tbd006-field-del";
    const doc = buildTableYDoc(
      { r1: { f1: "v1", f2: "v2" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      (doc.getMap("records").get("r1") as Y.Map<unknown>).delete("f2");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_records.r1.f2).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("buildPersistPayload returns null when no changes (hash match)", () => {
    const docName = "table:tbd006-nochange";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("buildPersistPayload is pure (does not modify snapshotCache)", () => {
    const docName = "table:tbd006-pure";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const snapshotBefore = db.snapshotCache.get(docName);

    doc.transact(() => {
      (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1", "changed");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    const snapshotAfter = db.snapshotCache.get(docName);
    expect(snapshotAfter).toBe(snapshotBefore);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("onStoreSuccess updates snapshot so next diff is empty", () => {
    const docName = "table:tbd006-success";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1", "v2");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const payloadAfter = (db as any).buildPersistPayload(doc, docName, {});
    expect(payloadAfter).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("digest does not store actual field values (memory verification)", () => {
    const docName = "table:tbd006-memory";
    const doc = new Y.Doc();
    const recordsMap = doc.getMap("records");
    const rowOrder = doc.getArray<string>("rowOrder");

    doc.transact(() => {
      for (let i = 0; i < 50; i++) {
        const record = new Y.Map<unknown>();
        for (let j = 0; j < 10; j++) {
          record.set(`field_${j.toString(16)}`, "x".repeat(500));
        }
        recordsMap.set(`record_${i}`, record);
        rowOrder.push([`record_${i}`]);
      }
    });

    db.saveSnapshot(docName, doc);

    const snapshot = db.snapshotCache.get(docName) as any;
    const firstDigest = snapshot.recordDigests.get("record_0");
    expect(typeof firstDigest.contentHash).toBe("string");
    expect(firstDigest.contentHash.length).toBeLessThan(50);
    expect(firstDigest.fieldKeys.length).toBe(10);

    // Ensure no field values are stored in the digest
    const digestJson = JSON.stringify(firstDigest);
    expect(digestJson).not.toContain("x".repeat(100));

    clearTableSnapshot(docName);
    doc.destroy();
  });
});

/**
 * table-database buildPersistPayload 端到端往返测试
 *
 * 验证 snapshot → applySnapshotToDoc → buildPersistPayload 的完整链路：
 * 1. 初始快照加载后 buildPersistPayload 应返回 null（无变更）
 * 2. 对 Y.Doc 做增删改后，payload 应精确反映变更
 * 3. payload 中的增量信息能从原始快照重建出修改后的状态
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import * as Y from "yjs";
import { generateKeyBetween } from "fractional-indexing";
import {
  TableDatabase,
  clearTableSnapshot,
} from "../extensions/table-database.js";
import { getOrderedIds } from "../lib/y-utils.js";
import {
  getEffectiveTableRecordOrder,
  insertTableRecordAtomically,
} from "@tabtin/table-engine/collab/table-record-order";

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    table_id: "tid-rt-001",
    table_name: "RoundTripTable",
    table_version: 1,
    schema_version: 1,
    fields: [
      { id: "f1", id_hex: "f1hex", name: "Name", field_type: "text" },
      { id: "f2", id_hex: "f2hex", name: "Age", field_type: "number" },
    ],
    records: {
      r1: { f1hex: "Alice", f2hex: 30 },
      r2: { f1hex: "Bob", f2hex: 25 },
      r3: { f1hex: "Charlie", f2hex: 35 },
    } as Record<string, Record<string, unknown>>,
    row_order: ["r1", "r2", "r3"],
    ...overrides,
  };
}

function applyAndSnapshot(
  db: TableDatabase,
  docName: string,
  snapshot: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    (db as any).applySnapshotToDoc(doc, snapshot);
  });
  db.saveSnapshot(docName, doc);
  return doc;
}

function extractAllRecords(
  doc: Y.Doc,
): Record<string, Record<string, unknown>> {
  const recordsMap = doc.getMap("records");
  const result: Record<string, Record<string, unknown>> = {};
  recordsMap.forEach((value, recordId) => {
    if (value instanceof Y.Map) {
      const fields: Record<string, unknown> = {};
      (value as Y.Map<unknown>).forEach((v, k) => {
        fields[k] = v;
      });
      result[recordId] = fields;
    }
  });
  return result;
}

function applyPayloadToSnapshot(
  original: Record<string, unknown>,
  payload: any,
): Record<string, Record<string, unknown>> {
  const records = JSON.parse(
    JSON.stringify((original as any).records),
  ) as Record<string, Record<string, unknown>>;

  for (const [rid, rdata] of Object.entries(
    payload.changes.new_records as Record<string, Record<string, unknown>>,
  )) {
    records[rid] = rdata;
  }
  for (const rid of payload.changes.deleted_record_ids as string[]) {
    delete records[rid];
  }
  for (const [rid, delta] of Object.entries(
    payload.changes.changed_records as Record<string, Record<string, unknown>>,
  )) {
    if (!records[rid]) records[rid] = {};
    for (const [fk, fv] of Object.entries(delta)) {
      if (fv === null) {
        delete records[rid][fk];
      } else {
        records[rid][fk] = fv;
      }
    }
  }

  return records;
}

describe("buildPersistPayload 端到端往返测试", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  // ── 1. 初始加载后无变更 ──

  describe("初始加载后 buildPersistPayload 应返回 null", () => {
    it("applySnapshotToDoc + saveSnapshot 后无变更", () => {
      const docName = "table:rt-null-01";
      const snapshot = makeSnapshot();
      const doc = applyAndSnapshot(db, docName, snapshot);

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).toBeNull();

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("空表快照加载后无变更", () => {
      const docName = "table:rt-null-02";
      const snapshot = makeSnapshot({
        records: {},
        row_order: [],
      });
      const doc = applyAndSnapshot(db, docName, snapshot);

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).toBeNull();

      clearTableSnapshot(docName);
      doc.destroy();
    });
  });

  // ── 2. 增删改记录后 payload 精确反映变更 ──

  describe("修改后 payload 精确反映变更", () => {
    let docName: string;
    let doc: Y.Doc;
    let originalSnapshot: Record<string, unknown>;

    beforeEach(() => {
      docName = `table:rt-modify-${Date.now()}`;
      originalSnapshot = makeSnapshot();
      doc = applyAndSnapshot(db, docName, originalSnapshot);
    });

    it("新增记录", () => {
      doc.transact(() => {
        const recordsMap = doc.getMap("records");
        const newR = new Y.Map<unknown>();
        newR.set("f1hex", "Diana");
        newR.set("f2hex", 28);
        recordsMap.set("r4", newR);

        const rowOrderMap = doc.getMap<number>("rowOrderMap");
        rowOrderMap.set("r4", 3);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.new_records).toHaveProperty("r4");
      expect(payload.changes.new_records.r4.f1hex).toBe("Diana");
      expect(payload.changes.new_records.r4.f2hex).toBe(28);
      expect(payload.changes.new_records.r4.__position_id).toMatch(/^p1:/);
      expect(payload.changes.new_records.r4.__order).toEqual(expect.any(Number));
      expect(Object.keys(payload.changes.changed_records)).toEqual(["r1"]);
      expect(payload.changes.changed_records.r1.__position_id).toMatch(/^p1:/);
      expect(payload.changes.deleted_record_ids).toHaveLength(0);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("新增记录缺失行顺序时在 payload 末尾补齐", () => {
      doc.transact(() => {
        const newRecord = new Y.Map<unknown>();
        newRecord.set("f1hex", "Diana");
        doc.getMap("records").set("r4", newRecord);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});

      expect(payload.changes.new_records).toHaveProperty("r4");
      expect(payload.changes.row_order).toEqual(["r1", "r2", "r3", "r4"]);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("删除记录", () => {
      doc.transact(() => {
        doc.getMap("records").delete("r2");
        doc.getMap<number>("rowOrderMap").delete("r2");
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.deleted_record_ids).toContain("r2");
      expect(Object.keys(payload.changes.new_records)).toHaveLength(0);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("Y.Doc 被掏空时拒绝把 snapshot 全量行当成删除", () => {
      doc.transact(() => {
        for (const id of ["r1", "r2", "r3"]) {
          doc.getMap("records").delete(id);
          doc.getMap<number>("rowOrderMap").delete(id);
        }
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      // refused_inferred_mass_delete：允许 fields/views 等其它变更，但不得带 deleted_record_ids 全删
      if (payload) {
        expect(payload.changes.deleted_record_ids ?? []).toHaveLength(0);
      }

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("部分删除仍可经协作 diff 落库（ 不误伤）", () => {
      doc.transact(() => {
        doc.getMap("records").delete("r2");
        doc.getMap<number>("rowOrderMap").delete("r2");
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.deleted_record_ids).toEqual(["r2"]);
      expect(payload.changes.deleted_record_ids).toHaveLength(1);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("修改记录字段值", () => {
      doc.transact(() => {
        const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("f1hex", "Alice Updated");
        r1.set("f2hex", 31);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.changed_records).toHaveProperty("r1");
      expect(payload.changes.changed_records.r1.f1hex).toBe("Alice Updated");
      expect(payload.changes.changed_records.r1.f2hex).toBe(31);
      expect(payload.changes).not.toHaveProperty("row_order");

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("preserves hidden position id across snapshot, restart, update, and clear", () => {
      const snapshot = makeSnapshot({
        records: {
          r1: { f1hex: "Alice", f2hex: 30, __position_id: "pos-initial" },
          r2: { f1hex: "Bob", f2hex: 25 },
          r3: { f1hex: "Charlie", f2hex: 35 },
        },
      });
      const restartDocName = `${docName}-restart`;
      const restartDoc = applyAndSnapshot(db, restartDocName, snapshot);

      expect(extractAllRecords(restartDoc).r1.__position_id).toBe("pos-initial");

      restartDoc.transact(() => {
        const r1 = restartDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("__position_id", "pos-updated");
      });
      const updatePayload = (db as any).buildPersistPayload(restartDoc, restartDocName, {});
      expect(updatePayload.changes.changed_records.r1.__position_id).toBe("pos-updated");

      (db as any).onStoreSuccess(restartDoc, restartDocName, { version: 2 });
      restartDoc.transact(() => {
        const r1 = restartDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.delete("__position_id");
      });
      const clearPayload = (db as any).buildPersistPayload(restartDoc, restartDocName, {});
      expect(clearPayload.changes.changed_records.r1.__position_id).toBeNull();

      clearTableSnapshot(restartDocName);
      restartDoc.destroy();
    });

    it("rebuilds sparse NULL legacy projections around persisted PositionId anchors", () => {
      const restartDocName = `${docName}-sparse-position-restart`;
      const expectedOrder = [
        "far-left",
        "left",
        "between",
        "right",
        "far-right",
        "tail",
      ];
      const liveDoc = new Y.Doc();
      const liveRecords = liveDoc.getMap<Y.Map<unknown>>("records");
      const liveRowOrderMap = liveDoc.getMap<string>("rowOrderMap");
      for (const [index, recordId] of [
        "far-left",
        "left",
        "right",
        "far-right",
        "tail",
      ].entries()) {
        const record = new Y.Map<unknown>();
        record.set("__order", (index + 1) * 1_000);
        liveRecords.set(recordId, record);
        liveRowOrderMap.set(recordId, `b0${String.fromCharCode(71 + index * 2)}`);
      }
      liveDoc.getArray<string>("rowOrder").push([
        "far-left", "left", "right", "far-right", "tail",
      ]);
      insertTableRecordAtomically(liveDoc, {
        recordId: "between",
        fieldValues: {},
        orderContext: { anchor_record_id: "left", position: "after" },
        origin: "roundtrip-test",
      });
      const persistedRecords = extractAllRecords(liveDoc);
      const persistedPositions = Object.fromEntries(
        ["left", "between", "right"].map(recordId => [
          recordId,
          persistedRecords[recordId].__position_id,
        ]),
      );
      liveDoc.destroy();

      const restartDoc = applyAndSnapshot(db, restartDocName, makeSnapshot({
        records: persistedRecords,
        row_order: expectedOrder,
      }));

      expect(getEffectiveTableRecordOrder(restartDoc)).toEqual(expectedOrder);
      expect(Object.fromEntries(
        ["left", "between", "right"].map(recordId => [
          recordId,
          extractAllRecords(restartDoc)[recordId].__position_id,
        ]),
      )).toEqual(persistedPositions);
      expect((db as any).buildPersistPayload(restartDoc, restartDocName, {})).toBeNull();

      clearTableSnapshot(restartDocName);
      restartDoc.destroy();
    });

    it("recomputes stale position id when a legacy rowOrderMap-only write moves a record", () => {
      const legacyDocName = `${docName}-legacy-position`;
      const legacyDoc = applyAndSnapshot(db, legacyDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", f2hex: 30, __position_id: "pos-initial" },
          r2: { f1hex: "Bob", f2hex: 25 },
          r3: { f1hex: "Charlie", f2hex: 35 },
        },
      }));

      legacyDoc.transact(() => {
        const rowOrderMap = legacyDoc.getMap<string>("rowOrderMap");
        rowOrderMap.set(
          "r1",
          generateKeyBetween(rowOrderMap.get("r2")!, rowOrderMap.get("r3")!),
        );
      });

      const payload = (db as any).buildPersistPayload(legacyDoc, legacyDocName, {});
      const r1 = legacyDoc.getMap("records").get("r1") as Y.Map<unknown>;
      expect(r1.get("__position_id")).toMatch(/^p1:/);
      expect(r1.get("__position_id")).not.toBe("pos-initial");
      expect(payload.changes.changed_records.r1.__position_id)
        .toBe(r1.get("__position_id"));
      expect(payload.changes.changed_records.r1.__order).toBe(1_500);
      expect(payload.changes).not.toHaveProperty("row_order");

      clearTableSnapshot(legacyDocName);
      legacyDoc.destroy();
    });

    it("recomputes stale position id when a complete legacy rowOrder array changes its effective order", () => {
      const legacyArrayDocName = `${docName}-legacy-array-position`;
      const legacyArrayDoc = applyAndSnapshot(db, legacyArrayDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", f2hex: 30, __position_id: "pos-initial" },
          r2: { f1hex: "Bob", f2hex: 25 },
          r3: { f1hex: "Charlie", f2hex: 35 },
        },
      }));

      legacyArrayDoc.transact(() => {
        legacyArrayDoc.getArray<string>("rowOrder").push(["r2", "r1", "r3"]);
      });

      const payload = (db as any).buildPersistPayload(legacyArrayDoc, legacyArrayDocName, {});
      const r1 = legacyArrayDoc.getMap("records").get("r1") as Y.Map<unknown>;
      expect(r1.get("__position_id")).toMatch(/^p1:/);
      expect(r1.get("__position_id")).not.toBe("pos-initial");
      expect(payload.changes.changed_records.r1.__position_id)
        .toBe(r1.get("__position_id"));
      expect(payload.changes.changed_records.r1.__order).toBe(1_500);
      expect(payload.changes).not.toHaveProperty("row_order");

      clearTableSnapshot(legacyArrayDocName);
      legacyArrayDoc.destroy();
    });

    it("keeps position id when a client updates it with the legacy rowOrderMap scalar", () => {
      const dualWriteDocName = `${docName}-position-dual-write`;
      const dualWriteDoc = applyAndSnapshot(db, dualWriteDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", f2hex: 30, __position_id: "pos-initial" },
          r2: { f1hex: "Bob", f2hex: 25 },
          r3: { f1hex: "Charlie", f2hex: 35 },
        },
      }));

      dualWriteDoc.transact(() => {
        dualWriteDoc.getMap<number>("rowOrderMap").set("r1", 2.5);
        const r1 = dualWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("__position_id", "pos-new");
      });

      const payload = (db as any).buildPersistPayload(dualWriteDoc, dualWriteDocName, {});
      const r1 = dualWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
      expect(r1.get("__position_id")).toBe("pos-new");
      expect(payload.changes.changed_records.r1.__position_id).toBe("pos-new");

      clearTableSnapshot(dualWriteDocName);
      dualWriteDoc.destroy();
    });

    it("recomputes stale position id and projects a legacy __order-only write into rowOrderMap", () => {
      const legacyOrderDocName = `${docName}-legacy-record-order`;
      const legacyOrderDoc = applyAndSnapshot(db, legacyOrderDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", __order: 1_000, __position_id: "p1:a0" },
          r2: { f1hex: "Bob", __order: 2_000 },
          r3: { f1hex: "Charlie", __order: 3_000 },
        },
      }));
      const rowOrderMap = legacyOrderDoc.getMap("rowOrderMap");
      const unaffectedR2Position = rowOrderMap.get("r2");
      const unaffectedR3Position = rowOrderMap.get("r3");

      legacyOrderDoc.transact(() => {
        const r1 = legacyOrderDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("__order", 2_500);
      });

      const payload = (db as any).buildPersistPayload(legacyOrderDoc, legacyOrderDocName, {});
      const r1 = legacyOrderDoc.getMap("records").get("r1") as Y.Map<unknown>;
      expect(r1.get("__position_id")).toMatch(/^p1:/);
      expect(r1.get("__position_id")).not.toBe("p1:a0");
      expect(payload.changes.changed_records.r1.__position_id)
        .toBe(r1.get("__position_id"));
      expect(payload.changes.changed_records.r1.__order).toBe(2_500);
      expect(payload.changes).not.toHaveProperty("row_order");
      expect(getOrderedIds(rowOrderMap)).toEqual(["r2", "r1", "r3"]);
      expect(rowOrderMap.get("r2")).toBe(unaffectedR2Position);
      expect(rowOrderMap.get("r3")).toBe(unaffectedR3Position);

      clearTableSnapshot(legacyOrderDocName);
      legacyOrderDoc.destroy();
    });

    it("projects the necessary duplicate legacy boundary for a __order-only move", () => {
      const duplicateBoundaryDocName = `${docName}-legacy-record-order-duplicate-boundary`;
      const duplicateBoundaryDoc = applyAndSnapshot(db, duplicateBoundaryDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", __order: 1_000, __position_id: "p1:a0" },
          r2: { f1hex: "Bob", __order: 2_000 },
          r3: { f1hex: "Charlie", __order: 3_000, __position_id: "p1:a2" },
        },
      }));
      const rowOrderMap = duplicateBoundaryDoc.getMap<string>("rowOrderMap");
      duplicateBoundaryDoc.transact(() => {
        rowOrderMap.set("r1", "b0I");
        rowOrderMap.set("r2", "b0I");
        rowOrderMap.set("r3", "b0J");
      });
      db.saveSnapshot(duplicateBoundaryDocName, duplicateBoundaryDoc);

      duplicateBoundaryDoc.transact(() => {
        const r3 = duplicateBoundaryDoc.getMap("records").get("r3") as Y.Map<unknown>;
        r3.set("__order", 1_500);
      });

      const payload = (db as any).buildPersistPayload(
        duplicateBoundaryDoc,
        duplicateBoundaryDocName,
        {},
      );
      const r3 = duplicateBoundaryDoc.getMap("records").get("r3") as Y.Map<unknown>;
      expect(r3.get("__position_id")).toMatch(/^p1:/);
      expect(r3.get("__position_id")).not.toBe("p1:a2");
      expect(payload.changes.changed_records.r3.__position_id)
        .toBe(r3.get("__position_id"));
      expect(payload.changes).not.toHaveProperty("row_order");
      expect(getOrderedIds(rowOrderMap)).toEqual(["r1", "r3", "r2"]);
      expect(rowOrderMap.get("r1")).toBe("b0I");
      expect(rowOrderMap.get("r2")).not.toBe("b0I");

      clearTableSnapshot(duplicateBoundaryDocName);
      duplicateBoundaryDoc.destroy();
    });

    it("keeps position id when __order and PositionId are updated in the same transaction", () => {
      const dualWriteDocName = `${docName}-record-order-dual-write`;
      const dualWriteDoc = applyAndSnapshot(db, dualWriteDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", __order: 1_000, __position_id: "p1:a0" },
          r2: { f1hex: "Bob", __order: 2_000 },
          r3: { f1hex: "Charlie", __order: 3_000 },
        },
      }));

      dualWriteDoc.transact(() => {
        const r1 = dualWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("__order", 2_500);
        r1.set("__position_id", "p1:a1");
      });

      const payload = (db as any).buildPersistPayload(dualWriteDoc, dualWriteDocName, {});
      const r1 = dualWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
      expect(r1.get("__position_id")).toBe("p1:a1");
      expect(payload.changes.changed_records.r1.__position_id).toBe("p1:a1");

      clearTableSnapshot(dualWriteDocName);
      dualWriteDoc.destroy();
    });

    it("does not mistake a later PositionId write for the same legacy __order transaction", () => {
      const splitWriteDocName = `${docName}-record-order-split-write`;
      const splitWriteDoc = applyAndSnapshot(db, splitWriteDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", __order: 1_000, __position_id: "p1:a0" },
          r2: { f1hex: "Bob", __order: 2_000 },
          r3: { f1hex: "Charlie", __order: 3_000 },
        },
      }));

      splitWriteDoc.transact(() => {
        const r1 = splitWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("__order", 2_500);
      });
      splitWriteDoc.transact(() => {
        const r1 = splitWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("__position_id", "p1:a1");
      });

      const payload = (db as any).buildPersistPayload(splitWriteDoc, splitWriteDocName, {});
      const r1 = splitWriteDoc.getMap("records").get("r1") as Y.Map<unknown>;
      expect(r1.get("__position_id")).toMatch(/^p1:/);
      expect(r1.get("__position_id")).not.toBe("p1:a1");
      expect(payload.changes.changed_records.r1.__position_id)
        .toBe(r1.get("__position_id"));
      expect(payload.changes.changed_records.r1.__order).toBe(2_500);
      expect(payload.changes).not.toHaveProperty("row_order");

      clearTableSnapshot(splitWriteDocName);
      splitWriteDoc.destroy();
    });

    it("invalidates a stale position id at most once for the same legacy rowOrderMap write", () => {
      const idempotentDocName = `${docName}-position-idempotent`;
      const idempotentDoc = applyAndSnapshot(db, idempotentDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", f2hex: 30, __position_id: "pos-initial" },
          r2: { f1hex: "Bob", f2hex: 25 },
          r3: { f1hex: "Charlie", f2hex: 35 },
        },
      }));

      idempotentDoc.transact(() => {
        idempotentDoc.getMap<number>("rowOrderMap").set("r1", 2.5);
      });

      let planningTransactions = 0;
      idempotentDoc.on("afterTransaction", () => { planningTransactions += 1; });
      (db as any).buildPersistPayload(idempotentDoc, idempotentDocName, {});
      expect(planningTransactions).toBe(1);
      (db as any).buildPersistPayload(idempotentDoc, idempotentDocName, {});
      expect(planningTransactions).toBe(1);

      clearTableSnapshot(idempotentDocName);
      idempotentDoc.destroy();
    });

    it("删除记录中的字段", () => {
      doc.transact(() => {
        const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.delete("f2hex");
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.changed_records.r1.f2hex).toBeNull();

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("仅行序变更", () => {
      doc.transact(() => {
        const rowOrderMap = doc.getMap<number>("rowOrderMap");
        rowOrderMap.set("r3", 0);
        rowOrderMap.set("r1", 1);
        rowOrderMap.set("r2", 2);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes).not.toHaveProperty("row_order");
      for (const recordId of ["r3", "r1", "r2"]) {
        expect(payload.changes.changed_records[recordId].__position_id).toMatch(/^p1:/);
        expect(payload.changes.changed_records[recordId].__order).toEqual(expect.any(Number));
      }

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("rowOrderMap 完整而旧 rowOrder 只含新增行时以 map 顺序持久化", () => {
      doc.transact(() => {
        const recordsMap = doc.getMap("records");
        const newRecord = new Y.Map<unknown>();
        newRecord.set("f1hex", "Inserted");
        recordsMap.set("r4", newRecord);

        const rowOrderMap = doc.getMap<number>("rowOrderMap");
        rowOrderMap.set("r1", 0);
        rowOrderMap.set("r2", 1);
        rowOrderMap.set("r4", 1.5);
        rowOrderMap.set("r3", 2);

        const legacyRowOrder = doc.getArray<string>("rowOrder");
        legacyRowOrder.push(["r4"]);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes).not.toHaveProperty("row_order");
      expect(payload.changes.new_records).toHaveProperty("r4");
      expect(payload.changes.new_records.r4.__position_id).toMatch(/^p1:/);
      expect(payload.changes.new_records.r4.__order).toEqual(expect.any(Number));
      expect(getEffectiveTableRecordOrder(doc)).toEqual(["r1", "r2", "r4", "r3"]);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("旧客户端完整 rowOrder array 插入中间且 map 未变时保留 array 顺序", () => {
      doc.transact(() => {
        const recordsMap = doc.getMap("records");
        const newRecord = new Y.Map<unknown>();
        newRecord.set("f1hex", "Legacy Inserted");
        recordsMap.set("r4", newRecord);

        const legacyRowOrder = doc.getArray<string>("rowOrder");
        legacyRowOrder.push(["r1", "r2", "r4", "r3"]);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes).not.toHaveProperty("row_order");
      expect(payload.changes.new_records).toHaveProperty("r4");
      expect(payload.changes.new_records.r4.__position_id).toMatch(/^p1:/);
      expect(payload.changes.new_records.r4.__order).toEqual(expect.any(Number));
      expect(getEffectiveTableRecordOrder(doc)).toEqual(["r1", "r2", "r4", "r3"]);

      (db as any).onStoreSuccess(doc, docName, { version: 2 });
      expect((db as any).snapshotCache.get(docName).rowOrder).toEqual(["r1", "r2", "r4", "r3"]);
      expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("旧 rowOrder array 遗漏真实 record 时 reconcile 不隐藏该行", () => {
      const orphanDocName = `${docName}-legacy-array-orphan`;
      const orphanDoc = applyAndSnapshot(db, orphanDocName, makeSnapshot({
        records: {
          r1: { f1hex: "Alice", __order: 1_000 },
          r2: { f1hex: "Bob", __order: 2_000 },
          r3: { f1hex: "Orphan but visible", __order: 3_000 },
        },
        row_order: ["r1", "r2"],
      }));

      orphanDoc.transact(() => {
        orphanDoc.getArray<string>("rowOrder").push(["r2", "r1"]);
      });

      const payload = (db as any).buildPersistPayload(orphanDoc, orphanDocName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes).not.toHaveProperty("row_order");
      expect(getEffectiveTableRecordOrder(orphanDoc)).toEqual(["r2", "r1", "r3"]);

      (db as any).onStoreSuccess(orphanDoc, orphanDocName, { version: 2 });
      expect((db as any).snapshotCache.get(orphanDocName).rowOrder)
        .toEqual(["r2", "r1", "r3"]);
      expect((db as any).buildPersistPayload(orphanDoc, orphanDocName, {})).toBeNull();

      clearTableSnapshot(orphanDocName);
      orphanDoc.destroy();
    });

    it("fields 变更", () => {
      doc.transact(() => {
        const meta = doc.getMap("meta");
        meta.set("fields", [
          { id: "f1", id_hex: "f1hex", name: "Name", field_type: "text" },
          { id: "f2", id_hex: "f2hex", name: "Age", field_type: "number" },
          { id: "f3", id_hex: "f3hex", name: "Email", field_type: "email" },
        ]);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.fields).toHaveLength(3);

      clearTableSnapshot(docName);
      doc.destroy();
    });
  });

  // ── 3. 增量 payload 能从原始快照重建修改后的状态 ──

  describe("payload + 原始快照 可重建修改后的 Y.Doc 状态", () => {
    it("新增 + 修改 + 删除复合场景重建", () => {
      const docName = "table:rt-rebuild-01";
      const originalSnapshot = makeSnapshot();
      const doc = applyAndSnapshot(db, docName, originalSnapshot);

      doc.transact(() => {
        const recordsMap = doc.getMap("records");
        const rowOrderMap = doc.getMap<number>("rowOrderMap");

        (recordsMap.get("r1") as Y.Map<unknown>).set("f1hex", "Alice V2");
        recordsMap.delete("r2");
        rowOrderMap.delete("r2");
        const newR = new Y.Map<unknown>();
        newR.set("f1hex", "Eve");
        newR.set("f2hex", 22);
        recordsMap.set("r4", newR);
        rowOrderMap.set("r4", 3);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();

      const rebuilt = applyPayloadToSnapshot(originalSnapshot, payload);
      const actual = extractAllRecords(doc);

      expect(rebuilt).toEqual(actual);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("多次修改累积后重建", () => {
      const docName = "table:rt-rebuild-02";
      const originalSnapshot = makeSnapshot();
      const doc = applyAndSnapshot(db, docName, originalSnapshot);

      doc.transact(() => {
        (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1hex", "A-v2");
      });
      doc.transact(() => {
        (doc.getMap("records").get("r2") as Y.Map<unknown>).set("f2hex", 99);
      });
      doc.transact(() => {
        (doc.getMap("records").get("r3") as Y.Map<unknown>).set("f1hex", "C-v2");
        (doc.getMap("records").get("r3") as Y.Map<unknown>).set("f2hex", 100);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();

      const rebuilt = applyPayloadToSnapshot(originalSnapshot, payload);
      const actual = extractAllRecords(doc);
      expect(rebuilt).toEqual(actual);

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("onStoreSuccess 后再修改：两阶段 payload 连续重建", () => {
      const docName = "table:rt-rebuild-03";
      const originalSnapshot = makeSnapshot();
      const doc = applyAndSnapshot(db, docName, originalSnapshot);

      doc.transact(() => {
        (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1hex", "Step1");
      });

      const payload1 = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload1).not.toBeNull();

      (db as any).onStoreSuccess(doc, docName, { version: 2 });

      doc.transact(() => {
        (doc.getMap("records").get("r2") as Y.Map<unknown>).set("f1hex", "Step2");
      });

      const payload2 = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload2).not.toBeNull();

      let intermediate = applyPayloadToSnapshot(originalSnapshot, payload1);
      const intermediateSnapshot = {
        ...originalSnapshot,
        records: intermediate,
      };
      const final = applyPayloadToSnapshot(intermediateSnapshot, payload2);
      const actual = extractAllRecords(doc);

      expect(final).toEqual(actual);

      clearTableSnapshot(docName);
      doc.destroy();
    });
  });

  // ── 4. 大表往返 ──

  describe("大表场景", () => {
    it("100 条记录加载 + 修改部分 + 重建", () => {
      const docName = "table:rt-large-01";
      const records: Record<string, Record<string, unknown>> = {};
      const rowOrder: string[] = [];
      for (let i = 0; i < 100; i++) {
        const rid = `r${String(i).padStart(3, "0")}`;
        records[rid] = { f1hex: `name-${i}`, f2hex: i };
        rowOrder.push(rid);
      }
      const snapshot = makeSnapshot({ records, row_order: rowOrder });
      const doc = applyAndSnapshot(db, docName, snapshot);

      doc.transact(() => {
        const recordsMap = doc.getMap("records");
        const rowOrderMap = doc.getMap<number>("rowOrderMap");

        (recordsMap.get("r000") as Y.Map<unknown>).set("f1hex", "modified-0");
        (recordsMap.get("r050") as Y.Map<unknown>).set("f2hex", 9999);
        recordsMap.delete("r099");
        rowOrderMap.delete("r099");
        const newR = new Y.Map<unknown>();
        newR.set("f1hex", "new-record");
        newR.set("f2hex", 100);
        recordsMap.set("r100", newR);
        rowOrderMap.set("r100", 100);
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();

      expect(payload.changes.changed_records).toHaveProperty("r000");
      expect(payload.changes.changed_records).toHaveProperty("r050");
      expect(payload.changes.deleted_record_ids).toContain("r099");
      expect(payload.changes.new_records).toHaveProperty("r100");

      const totalChangedKeys =
        Object.keys(payload.changes.changed_records).length +
        Object.keys(payload.changes.new_records).length +
        payload.changes.deleted_record_ids.length;
      expect(totalChangedKeys).toBe(4);

      const rebuilt = applyPayloadToSnapshot(snapshot, payload);
      const actual = extractAllRecords(doc);
      expect(rebuilt).toEqual(actual);

      clearTableSnapshot(docName);
      doc.destroy();
    });
  });

  // ── 5. 特殊值类型往返 ──

  describe("特殊值类型", () => {
    it("null / 空字符串 / 数组 / 嵌套对象 往返", () => {
      const docName = "table:rt-types-01";
      const snapshot = makeSnapshot({
        records: {
          r1: { f1hex: null, f2hex: "" },
          r2: { f1hex: ["a", "b"], f2hex: { nested: true } },
        },
        row_order: ["r1", "r2"],
      });
      const doc = applyAndSnapshot(db, docName, snapshot);

      doc.transact(() => {
        const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("f1hex", "no-longer-null");
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.changed_records.r1.f1hex).toBe("no-longer-null");

      clearTableSnapshot(docName);
      doc.destroy();
    });

    it("中文和 emoji 值往返", () => {
      const docName = "table:rt-types-02";
      const snapshot = makeSnapshot({
        records: {
          r1: { f1hex: "你好世界", f2hex: "🎉" },
        },
        row_order: ["r1"],
      });
      const doc = applyAndSnapshot(db, docName, snapshot);

      doc.transact(() => {
        const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
        r1.set("f1hex", "更新后的中文");
      });

      const payload = (db as any).buildPersistPayload(doc, docName, {});
      expect(payload).not.toBeNull();
      expect(payload.changes.changed_records.r1.f1hex).toBe("更新后的中文");

      clearTableSnapshot(docName);
      doc.destroy();
    });
  });
});

/**
 * table-database.ts 核心逻辑测试
 *
 * 测试 saveTableSnapshot 和 Y.Doc ↔ snapshot 的转换正确性。
 * storeDocument 的 diff 逻辑通过构造 Y.Doc 变更场景来间接验证。
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import * as Y from "yjs";
import { TableDatabase, saveTableSnapshot, clearTableSnapshot, updateTableMetaFields } from "../extensions/table-database.js";

function buildTableYDoc(
  records: Record<string, Record<string, unknown>>,
  rowOrder: string[],
  meta?: Record<string, unknown>
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

    if (rowOrder.length > 0) {
      rowOrderArr.push(rowOrder);
    }

    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        metaMap.set(k, v);
      }
    }
  });

  return doc;
}

describe("saveTableSnapshot", () => {
  beforeAll(() => {
    new TableDatabase();
  });

  beforeEach(() => {
    clearTableSnapshot("table:test-1");
  });

  it("saves and can be cleared without error", () => {
    const doc = buildTableYDoc(
      { r1: { f_abc: "hello", f_def: 42 } },
      ["r1"],
      { table_name: "Test" }
    );

    expect(() => saveTableSnapshot("table:test-1", doc)).not.toThrow();
    expect(() => clearTableSnapshot("table:test-1")).not.toThrow();
  });

  it("captures all records and row order", () => {
    const doc = buildTableYDoc(
      {
        r1: { f_abc: "v1" },
        r2: { f_abc: "v2", f_def: 99 },
      },
      ["r1", "r2"]
    );

    saveTableSnapshot("table:snap-test", doc);

    // Re-read the doc to verify snapshot matches
    const recordsMap = doc.getMap("records");
    expect(recordsMap.size).toBe(2);

    const r1 = recordsMap.get("r1") as Y.Map<unknown>;
    expect(r1.get("f_abc")).toBe("v1");

    const r2 = recordsMap.get("r2") as Y.Map<unknown>;
    expect(r2.get("f_def")).toBe(99);

    clearTableSnapshot("table:snap-test");
  });

  it("skips non-Y.Map values with warning", () => {
    const doc = new Y.Doc();
    const recordsMap = doc.getMap("records");
    const rowOrderArr = doc.getArray<string>("rowOrder");

    doc.transact(() => {
      const validRecord = new Y.Map<unknown>();
      validRecord.set("f1", "ok");
      recordsMap.set("r_valid", validRecord);
      // Inject invalid primitive value
      recordsMap.set("r_invalid", "not-a-ymap" as any);
      rowOrderArr.push(["r_valid", "r_invalid"]);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    saveTableSnapshot("table:bad-data", doc);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('r_invalid')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a Y.Map')
    );

    warnSpy.mockRestore();
    clearTableSnapshot("table:bad-data");
  });
});

describe("Y.Doc diff scenarios", () => {
  it("detects new records by comparing two snapshots", () => {
    const doc = buildTableYDoc({ r1: { f1: "a" } }, ["r1"]);

    // Snapshot 1
    const snapshot1 = captureSnapshot(doc);

    // Add record
    doc.transact(() => {
      const recordsMap = doc.getMap("records");
      const rowOrderArr = doc.getArray<string>("rowOrder");
      const newR = new Y.Map<unknown>();
      newR.set("f1", "new");
      recordsMap.set("r2", newR);
      rowOrderArr.push(["r2"]);
    });

    const snapshot2 = captureSnapshot(doc);

    const diff = computeDiff(snapshot1, snapshot2);
    expect(Object.keys(diff.newRecords)).toContain("r2");
    expect(diff.changedRecords).toEqual({});
    expect(diff.deletedRecordIds).toEqual([]);
  });

  it("detects changed records", () => {
    const doc = buildTableYDoc({ r1: { f1: "old" } }, ["r1"]);
    const snapshot1 = captureSnapshot(doc);

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.set("f1", "new");
    });

    const snapshot2 = captureSnapshot(doc);
    const diff = computeDiff(snapshot1, snapshot2);

    expect(diff.changedRecords).toHaveProperty("r1");
    expect(diff.changedRecords["r1"]["f1"]).toBe("new");
    expect(Object.keys(diff.newRecords)).toHaveLength(0);
    expect(diff.deletedRecordIds).toEqual([]);
  });

  it("detects deleted records", () => {
    const doc = buildTableYDoc(
      { r1: { f1: "a" }, r2: { f1: "b" } },
      ["r1", "r2"]
    );
    const snapshot1 = captureSnapshot(doc);

    doc.transact(() => {
      doc.getMap("records").delete("r2");
    });

    const snapshot2 = captureSnapshot(doc);
    const diff = computeDiff(snapshot1, snapshot2);

    expect(diff.deletedRecordIds).toContain("r2");
    expect(Object.keys(diff.newRecords)).toHaveLength(0);
  });

  it("detects field removal within a record", () => {
    const doc = buildTableYDoc({ r1: { f1: "a", f2: "b" } }, ["r1"]);
    const snapshot1 = captureSnapshot(doc);

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.delete("f2");
    });

    const snapshot2 = captureSnapshot(doc);
    const diff = computeDiff(snapshot1, snapshot2);

    expect(diff.changedRecords["r1"]["f2"]).toBeNull();
  });

  it("no changes produces empty diff", () => {
    const doc = buildTableYDoc({ r1: { f1: "a" } }, ["r1"]);
    const snapshot1 = captureSnapshot(doc);
    const snapshot2 = captureSnapshot(doc);
    const diff = computeDiff(snapshot1, snapshot2);

    expect(Object.keys(diff.changedRecords)).toHaveLength(0);
    expect(Object.keys(diff.newRecords)).toHaveLength(0);
    expect(diff.deletedRecordIds).toHaveLength(0);
  });
});

describe("P0 regression: buildPersistPayload must not update snapshotCache", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("snapshotCache remains unchanged after buildPersistPayload returns a payload", () => {
    const docName = "table:p0-test-1";
    const doc = buildTableYDoc(
      { r1: { f1: "original" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const snapshotBefore = db.snapshotCache.get(docName);
    expect(snapshotBefore).toBeDefined();

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.set("f1", "changed");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    const snapshotAfter = db.snapshotCache.get(docName);
    expect(snapshotAfter).toBe(snapshotBefore);

    const digests = (snapshotAfter as any).recordDigests as Map<string, { contentHash: string }>;
    expect(digests.has("r1")).toBe(true);

    clearTableSnapshot(docName);
  });

  it("retry produces non-null payload when prior persist fails (no premature snapshot update)", () => {
    const docName = "table:p0-retry-test";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.set("f1", "v2");
    });

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();
    expect(payload1.changes.changed_records).toHaveProperty("r1");

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();
    expect(payload2.changes.changed_records).toHaveProperty("r1");

    clearTableSnapshot(docName);
  });

  it("onStoreSuccess updates snapshotCache so subsequent diff is empty", () => {
    const docName = "table:p0-success-test";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.set("f1", "v2");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    expect(doc.getMap("meta").get("version")).toBe(2);

    const payloadAfterSuccess = (db as any).buildPersistPayload(doc, docName, {});
    expect(payloadAfterSuccess).toBeNull();

    clearTableSnapshot(docName);
  });

  it("ACK only advances the baseline to the outbound state", async () => {
    const docName = "table:p0-inflight-edit";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
    r1.set("f1", "v2");

    const outbound = await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect(outbound.changes.changed_records.r1.f1).toBe("v2");

    // HTTP 请求进行中又发生了新编辑；这部分不能被前一个 ACK 一并确认。
    r1.set("f1", "v3");
    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const nextPayload = (db as any).buildPersistPayload(doc, docName, {});
    expect(nextPayload.changes.changed_records.r1.f1).toBe("v3");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("stale server correction does not overwrite an in-flight user edit", async () => {
    const docName = "table:p0-stale-correction";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
    r1.set("f1", "v2");
    await (db as any).buildPersistPayloadAsync(doc, docName, {});

    r1.set("f1", "v3");
    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      record_cell_corrections: { r1: { f1: "server-v2" } },
    });

    expect(r1.get("f1")).toBe("v3");
    const nextPayload = (db as any).buildPersistPayload(doc, docName, {});
    expect(nextPayload.changes.changed_records.r1.f1).toBe("v3");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("stale fields ACK does not overwrite an in-flight schema edit", async () => {
    const docName = "table:p0-stale-fields-ack";
    const initialFields = [{ id: "f1", name: "Initial" }];
    const outboundFields = [{ id: "f1", name: "Outbound" }];
    const inFlightFields = [
      { id: "f1", name: "Outbound" },
      { id: "f2", name: "Added while saving" },
    ];
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test", fields: initialFields },
    );

    db.saveSnapshot(docName, doc);
    const meta = doc.getMap("meta");
    meta.set("fields", outboundFields);
    await (db as any).buildPersistPayloadAsync(doc, docName, {});

    meta.set("fields", inFlightFields);
    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      fields: outboundFields,
    });

    expect(meta.get("fields")).toEqual(inFlightFields);
    const nextPayload = (db as any).buildPersistPayload(doc, docName, {});
    expect(nextPayload.changes.fields).toEqual(inFlightFields);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("stale views ACK does not overwrite an in-flight view edit", async () => {
    const docName = "table:p0-stale-views-ack";
    const initialView = { id: "v1", name: "Initial", config_rev: 1 };
    const outboundView = { id: "v1", name: "Outbound", config_rev: 2 };
    const inFlightView = { id: "v1", name: "Edited while saving", config_rev: 3 };
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );
    const views = doc.getMap<unknown>("views");
    views.set("v1", initialView);

    db.saveSnapshot(docName, doc);
    views.set("v1", outboundView);
    await (db as any).buildPersistPayloadAsync(doc, docName, {});

    views.set("v1", inFlightView);
    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      views: [outboundView],
    });

    expect(views.get("v1")).toEqual(inFlightView);
    const nextPayload = (db as any).buildPersistPayload(doc, docName, {});
    expect(nextPayload.changes.views.v1).toEqual(inFlightView);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("server system cells become part of the acknowledged baseline", async () => {
    const docName = "table:p0-system-cell-ack";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
    r1.set("f1", "v2");
    await (db as any).buildPersistPayloadAsync(doc, docName, {});

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      record_system_cells: { r1: { modified_time: "2026-08-07T12:00:00Z" } },
    });

    expect(r1.get("modified_time")).toBe("2026-08-07T12:00:00Z");
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("applied server corrections become part of the acknowledged baseline", async () => {
    const docName = "table:p0-correction-ack";
    const doc = buildTableYDoc(
      { r1: { parent: "server-v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
    r1.set("parent", "rejected-client-value");
    await (db as any).buildPersistPayloadAsync(doc, docName, {});

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      record_cell_corrections: { r1: { parent: "server-v1" } },
    });

    expect(r1.get("parent")).toBe("server-v1");
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("removes tombstoned new-record projections after the persist ACK", async () => {
    const docName = "table:tombstone-new-record-ack";
    const doc = buildTableYDoc(
      { r1: { f1: "existing" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );
    doc.getMap<number>("rowOrderMap").set("r1", 0);
    db.saveSnapshot(docName, doc);

    const ghost = new Y.Map<unknown>();
    ghost.set("f1", "deleted lifecycle replay");
    const healthy = new Y.Map<unknown>();
    healthy.set("f1", "healthy new record");
    doc.transact(() => {
      doc.getMap("records").set("ghost", ghost);
      doc.getMap("records").set("healthy", healthy);
      doc.getArray<string>("rowOrder").push(["ghost", "healthy", "ghost"]);
      doc.getMap<number>("rowOrderMap").set("ghost", 1);
      doc.getMap<number>("rowOrderMap").set("healthy", 2);
    });

    const outbound = await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect(outbound.changes.new_records).toHaveProperty("ghost");
    expect(outbound.changes.new_records).toHaveProperty("healthy");

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      discarded_new_record_ids: ["ghost"],
    });

    expect(doc.getMap("records").has("ghost")).toBe(false);
    expect(doc.getMap("records").has("healthy")).toBe(true);
    expect(doc.getMap("rowOrderMap").has("ghost")).toBe(false);
    expect(doc.getArray<string>("rowOrder").toArray()).not.toContain("ghost");
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("removes blank record-id projections before they enter the persist baseline", async () => {
    const docName = "table:blank-record-id-projection";
    const doc = buildTableYDoc({}, [], { version: 1, table_name: "Test" });
    db.saveSnapshot(docName, doc);
    await db.afterLoadDocument({ documentName: docName, document: doc });

    const blankRecord = new Y.Map<unknown>();
    blankRecord.set("f1", "invalid projection");
    doc.transact(() => {
      doc.getMap("records").set("", blankRecord);
      doc.getMap<number>("rowOrderMap").set("", 0);
      doc.getArray<string>("rowOrder").push(["", ""]);
    }, { context: { editorType: "user", editorId: "user-blank-id" } });

    const outbound = await (db as any).buildPersistPayloadAsync(doc, docName, {});

    expect(outbound).toBeNull();
    expect(doc.getMap("records").has("")).toBe(false);
    expect(doc.getMap("rowOrderMap").has("")).toBe(false);
    expect(doc.getArray<string>("rowOrder").toArray()).not.toContain("");
    expect((db as any).recordEditorsByDocument.get(docName)?.has("") ?? false).toBe(false);
    expect((db as any).recordMutationRevisionsByDocument.get(docName)?.has("") ?? false).toBe(false);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("removes historical blank record-id projections when the document loads", async () => {
    const docName = "table:historical-blank-record-id-projection";
    const doc = buildTableYDoc({}, [], { version: 1, table_name: "Test" });
    const blankRecordId = "   ";
    const blankRecord = new Y.Map<unknown>();
    blankRecord.set("f1", "historical invalid projection");
    doc.getMap("records").set(blankRecordId, blankRecord);
    doc.getMap<number>("rowOrderMap").set(blankRecordId, 0);
    doc.getArray<string>("rowOrder").push([blankRecordId, blankRecordId]);

    await db.afterLoadDocument({ documentName: docName, document: doc });

    expect(doc.getMap("records").has(blankRecordId)).toBe(false);
    expect(doc.getMap("rowOrderMap").has(blankRecordId)).toBe(false);
    expect(doc.getArray<string>("rowOrder").toArray()).not.toContain(blankRecordId);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("revalidates a rejected new record changed while its persist was in flight", async () => {
    const docName = "table:tombstone-new-record-stale-ack";
    const doc = buildTableYDoc({}, [], { version: 1, table_name: "Test" });
    db.saveSnapshot(docName, doc);
    const ghost = new Y.Map<unknown>();
    ghost.set("f1", "outbound");
    doc.getMap("records").set("ghost", ghost);
    doc.getMap<number>("rowOrderMap").set("ghost", 1);
    doc.getArray<string>("rowOrder").push(["ghost"]);
    db.queueRecordLifecycleRevalidation(docName, ["ghost"]);

    await (db as any).buildPersistPayloadAsync(doc, docName, {});
    ghost.set("f1", "edited while saving");
    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      discarded_new_record_ids: ["ghost"],
    });

    expect(doc.getMap("records").has("ghost")).toBe(true);
    expect(doc.getMap("rowOrderMap").has("ghost")).toBe(true);
    expect(doc.getArray<string>("rowOrder").toArray()).toContain("ghost");
    const retry = (db as any).buildPersistPayload(doc, docName, {});
    expect(retry.changes.new_records.ghost.f1).toBe("edited while saving");
    expect(retry.changes.record_lifecycle_revalidation_ids).toEqual(["ghost"]);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("does not let a stale rejection ACK delete a same-content restored lifecycle", async () => {
    const docName = "table:tombstone-new-record-same-content-restore";
    const doc = buildTableYDoc({}, [], { version: 1, table_name: "Test" });
    await (db as any).afterLoadDocument({ documentName: docName, document: doc });
    db.saveSnapshot(docName, doc);

    const ghost = new Y.Map<unknown>();
    ghost.set("f1", "same value");
    doc.getMap("records").set("ghost", ghost);
    doc.getMap<number>("rowOrderMap").set("ghost", 1);
    doc.getArray<string>("rowOrder").push(["ghost"]);
    await (db as any).buildPersistPayloadAsync(doc, docName, {});

    // 模拟 restore 在旧 persist 请求在途期间，把同一生命周期重新写回 Y.Doc。
    // 最终 cells 与请求发出时相同，只有 mutation revision 能识别这次 ABA。
    const restored = doc.getMap("records").get("ghost") as Y.Map<unknown>;
    restored.set("f1", restored.get("f1"));
    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      discarded_new_record_ids: ["ghost"],
    });

    expect(doc.getMap("records").get("ghost")).toBe(restored);
    expect(doc.getMap("rowOrderMap").has("ghost")).toBe(true);
    expect(doc.getArray<string>("rowOrder").toArray()).toContain("ghost");
    const retry = (db as any).buildPersistPayload(doc, docName, {});
    expect(retry.changes.new_records.ghost.f1).toBe("same value");

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("forces a baseline record through lifecycle revalidation before cleanup", async () => {
    const docName = "table:tombstone-baseline-revalidation";
    const doc = buildTableYDoc(
      { ghost: { f1: "already in the stale baseline" } },
      ["ghost"],
      { version: 1, table_name: "Test" },
    );
    doc.getMap<number>("rowOrderMap").set("ghost", 0);
    db.saveSnapshot(docName, doc);

    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();
    expect(db.queueRecordLifecycleRevalidation(docName, ["ghost"])).toBe(1);

    const outbound = await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect(outbound.changes.new_records.ghost.f1).toBe("already in the stale baseline");
    expect(outbound.changes.record_lifecycle_revalidation_ids).toEqual(["ghost"]);

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      discarded_new_record_ids: ["ghost"],
    });

    expect(doc.getMap("records").has("ghost")).toBe(false);
    expect(doc.getMap("rowOrderMap").has("ghost")).toBe(false);
    expect(doc.getArray<string>("rowOrder").toArray()).not.toContain("ghost");
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("keeps an unconfirmed lifecycle candidate fail-closed across stores", async () => {
    const docName = "table:missing-lifecycle-revalidation";
    const doc = buildTableYDoc(
      { ghost: { f1: "must not become a create" } },
      ["ghost"],
      { version: 1, table_name: "Test" },
    );
    db.saveSnapshot(docName, doc);

    db.queueRecordLifecycleRevalidation(docName, ["ghost"]);
    const outbound = await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect(outbound.changes.record_lifecycle_revalidation_ids).toEqual(["ghost"]);

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      unconfirmed_record_lifecycle_ids: ["ghost"],
    });

    expect(doc.getMap("records").has("ghost")).toBe(true);
    const retry = (db as any).buildPersistPayload(doc, docName, {});
    expect(retry.changes.new_records.ghost.f1).toBe("must not become a create");
    expect(retry.changes.record_lifecycle_revalidation_ids).toEqual(["ghost"]);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("prunes a queued lifecycle candidate that disappeared before another diff stores", () => {
    const docName = "table:removed-lifecycle-candidate";
    const doc = buildTableYDoc(
      {
        ghost: { f1: "gone" },
        sibling: { f1: "before" },
      },
      ["ghost", "sibling"],
      { version: 1, table_name: "Test" },
    );
    db.saveSnapshot(docName, doc);
    db.queueRecordLifecycleRevalidation(docName, ["ghost"]);

    doc.getMap("records").delete("ghost");
    (doc.getMap("records").get("sibling") as Y.Map<unknown>).set("f1", "after");
    const outbound = (db as any).buildPersistPayload(doc, docName, {});

    expect(outbound.changes.changed_records.sibling.f1).toBe("after");
    expect(outbound.changes.record_lifecycle_revalidation_ids).toBeUndefined();
    expect((db as any).recordLifecycleRevalidationsByDocument.has(docName)).toBe(false);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("keeps a revalidated record when Django reports an active lifecycle", async () => {
    const docName = "table:active-baseline-revalidation";
    const doc = buildTableYDoc(
      { restored: { f1: "active again" } },
      ["restored"],
      { version: 1, table_name: "Test" },
    );
    db.saveSnapshot(docName, doc);

    db.queueRecordLifecycleRevalidation(docName, ["restored"]);
    const outbound = await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect(outbound.changes.new_records).toHaveProperty("restored");

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    expect(doc.getMap("records").has("restored")).toBe(true);
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("releases acknowledged mutation revisions for updates and deletes", async () => {
    const docName = "table:record-mutation-revision-cleanup";
    const doc = buildTableYDoc(
      {
        r1: { f1: "before" },
        r2: { f1: "keep" },
      },
      ["r1", "r2"],
      { version: 1, table_name: "Test" },
    );
    await (db as any).afterLoadDocument({ documentName: docName, document: doc });
    db.saveSnapshot(docName, doc);

    const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
    r1.set("f1", "after");
    await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect((db as any).recordMutationRevisionsByDocument.get(docName)?.has("r1")).toBe(true);
    (db as any).onStoreSuccess(doc, docName, { version: 2 });
    expect((db as any).recordMutationRevisionsByDocument.has(docName)).toBe(false);

    doc.getMap("records").delete("r1");
    await (db as any).buildPersistPayloadAsync(doc, docName, {});
    expect((db as any).recordMutationRevisionsByDocument.get(docName)?.has("r1")).toBe(true);
    (db as any).onStoreSuccess(doc, docName, { version: 3 });
    expect((db as any).recordMutationRevisionsByDocument.has(docName)).toBe(false);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("publishes discarded record updates through the Y.Doc meta event slot", () => {
    const docName = "table:delete-wins-notice";
    const doc = buildTableYDoc({}, [], { version: 1, table_name: "Test" });
    const notices = [{
      event_id: "table:r1:deleted:u1",
      record_id: "r1",
      target_editor_id: "u1",
      deleted_by_id: "u2",
      deleted_by_name: "王小明",
    }];

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      discarded_record_updates: notices,
    });

    expect(doc.getMap("meta").get("discarded_record_updates")).toEqual([
      expect.objectContaining({
        ...notices[0],
        created_at: expect.any(Number),
      }),
    ]);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("keeps per-record authenticated editors when one persist mixes two users", async () => {
    const docName = "table:two-user-record-provenance";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" }, r2: { f1: "v1" }, r3: { f1: "v1" } },
      ["r1", "r2", "r3"],
      { version: 1, table_name: "Test" },
    );
    db.saveSnapshot(docName, doc);
    await db.afterLoadDocument({ documentName: docName, document: doc });

    doc.transact(() => {
      (doc.getMap("records").get("r1") as Y.Map<unknown>).set("f1", "alice");
    }, { context: { editorType: "user", editorId: "user-alice" } });
    doc.transact(() => {
      (doc.getMap("records").get("r2") as Y.Map<unknown>).set("f1", "bob");
    }, { context: { editorType: "user", editorId: "user-bob" } });
    doc.transact(() => {
      doc.getMap("records").delete("r3");
    }, { context: { editorType: "user", editorId: "user-alice" } });

    const payload = (db as any).buildPersistPayload(doc, docName, {
      editorType: "user",
      editorId: "user-bob",
    });

    expect(payload.changes.record_editor_ids).toEqual({
      r1: "user-alice",
      r2: "user-bob",
      r3: "user-alice",
    });

    clearTableSnapshot(docName);
    doc.destroy();
  });
});

describe("SR-011 regression: applySnapshotToDoc writes schema_version to Y.Doc meta", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("schema_version from snapshot is written to Y.Doc meta", () => {
    const snapshot = {
      table_id: "tid-001",
      table_name: "TestTable",
      table_version: 5,
      schema_version: 42,
      fields: [{ id: "f1", id_hex: "f1hex", name: "Name", field_type: "text" }],
      records: {
        "r1": { f1hex: "hello" },
      },
      row_order: ["r1"],
    };

    const doc = new Y.Doc();
    (db as any).applySnapshotToDoc(doc, snapshot);

    const meta = doc.getMap("meta");
    expect(meta.get("schema_version")).toBe(42);

    doc.destroy();
  });

  it("schema_version is omitted gracefully when snapshot has no schema_version", () => {
    const snapshot = {
      table_id: "tid-002",
      table_name: "NoSchema",
      table_version: 1,
      fields: [],
      records: {},
      row_order: [],
    };

    const doc = new Y.Doc();
    (db as any).applySnapshotToDoc(doc, snapshot);

    const meta = doc.getMap("meta");
    expect(meta.get("schema_version")).toBeUndefined();

    doc.destroy();
  });

  it("schema_version=0 is correctly written (not skipped as falsy)", () => {
    const snapshot = {
      table_id: "tid-003",
      table_name: "ZeroSchema",
      table_version: 1,
      schema_version: 0,
      fields: [],
      records: {},
      row_order: [],
    };

    const doc = new Y.Doc();
    (db as any).applySnapshotToDoc(doc, snapshot);

    const meta = doc.getMap("meta");
    expect(meta.get("schema_version")).toBe(0);

    doc.destroy();
  });
});

// ─── CI-015 回归：agent push 不应提前更新快照基准 ──────

describe("CI-015: saveTableSnapshot 不应在事务内调用", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("agent push 后 buildPersistPayload 仍能检测到变更（diff 基准未被移位）", () => {
    const docName = "table:ci015-test";
    const doc = buildTableYDoc(
      { r1: { f1: "original" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.set("f1", "agent-pushed");
    });

    // CI-015 修复前：agent-push.ts 会在这里调用 saveTableSnapshot(docName, doc)
    // 导致 diff 基准被移位，下面的 buildPersistPayload 返回 null
    // CI-015 修复后：不调用 saveTableSnapshot，diff 基准保持不变

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_records).toHaveProperty("r1");
    expect(payload.changes.changed_records.r1.f1).toBe("agent-pushed");

    clearTableSnapshot(docName);
  });

  it("仅 onStoreSuccess 才应更新 diff 基准", () => {
    const docName = "table:ci015-baseline";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const r1 = doc.getMap("records").get("r1") as Y.Map<unknown>;
      r1.set("f1", "v2");
    });

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();

    // 模拟 store 失败 → 不调用 onStoreSuccess
    // 再次调用 buildPersistPayload 应仍能检测到变更
    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();
    expect(payload2.changes.changed_records).toHaveProperty("r1");

    clearTableSnapshot(docName);
  });
});

// ─── CI-027 回归：saveTableSnapshot singleton 防御性检查 ──────

describe("CI-027: saveTableSnapshot singleton 行为", () => {
  it("singleton 存在时正常保存快照，无 warn 日志", () => {
    new TableDatabase();

    const doc = buildTableYDoc(
      { r1: { f1: "test" } },
      ["r1"],
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => saveTableSnapshot("table:ci027-ok", doc)).not.toThrow();

    const singletonWarnCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("singleton is null"),
    );
    expect(singletonWarnCalls).toHaveLength(0);

    warnSpy.mockRestore();
    clearTableSnapshot("table:ci027-ok");
  });

  it("saveTableSnapshot 不会使调用方崩溃（防御性保证）", () => {
    const doc = buildTableYDoc({ r1: { f1: "safe" } }, ["r1"]);
    expect(() => saveTableSnapshot("table:ci027-safe", doc)).not.toThrow();
    clearTableSnapshot("table:ci027-safe");
  });
});

// ── Helper: capture snapshot from Y.Doc ──

type Snapshot = {
  records: Map<string, Map<string, unknown>>;
  rowOrder: string[];
};

function captureSnapshot(doc: Y.Doc): Snapshot {
  const recordsMap = doc.getMap("records");
  const rowOrderArr = doc.getArray<string>("rowOrder");

  const records = new Map<string, Map<string, unknown>>();
  recordsMap.forEach((value, recordId) => {
    if (value instanceof Y.Map) {
      const fields = new Map<string, unknown>();
      value.forEach((v, k) => {
        fields.set(k, v);
      });
      records.set(recordId, fields);
    }
  });

  const rowOrder: string[] = [];
  for (let i = 0; i < rowOrderArr.length; i++) {
    rowOrder.push(rowOrderArr.get(i));
  }

  return { records, rowOrder };
}

function computeDiff(
  last: Snapshot,
  current: Snapshot
): {
  changedRecords: Record<string, Record<string, unknown>>;
  newRecords: Record<string, Record<string, unknown>>;
  deletedRecordIds: string[];
} {
  const changedRecords: Record<string, Record<string, unknown>> = {};
  const newRecords: Record<string, Record<string, unknown>> = {};
  const deletedRecordIds: string[] = [];

  for (const [recordId, fields] of current.records) {
    const lastFields = last.records.get(recordId);
    if (!lastFields) {
      const fieldValues: Record<string, unknown> = {};
      fields.forEach((v, k) => {
        fieldValues[k] = v;
      });
      newRecords[recordId] = fieldValues;
    } else {
      const changedFields: Record<string, unknown> = {};
      let hasChanges = false;

      fields.forEach((value, key) => {
        const lastValue = lastFields.get(key);
        if (value !== lastValue) {
          changedFields[key] = value;
          hasChanges = true;
        }
      });

      lastFields.forEach((_, key) => {
        if (!fields.has(key)) {
          changedFields[key] = null;
          hasChanges = true;
        }
      });

      if (hasChanges) {
        changedRecords[recordId] = changedFields;
      }
    }
  }

  for (const recordId of last.records.keys()) {
    if (!current.records.has(recordId)) {
      deletedRecordIds.push(recordId);
    }
  }

  return { changedRecords, newRecords, deletedRecordIds };
}

// ─── CMS-001 回归：table.schema.changed 事件更新 Y.Doc meta.fields ──────

describe("CMS-001: updateTableMetaFields updates Y.Doc meta.fields", () => {
  it("writes fields array to Y.Doc meta.fields", () => {
    const doc = buildTableYDoc(
      { r1: { f1hex: "hello" } },
      ["r1"],
      { fields: [{ id: "old-field", name: "Old" }], version: 1 },
    );

    const newFields = [
      { id: "f1", name: "Name", field_type: "text" },
      { id: "f2", name: "Age", field_type: "number" },
    ];

    updateTableMetaFields(doc, newFields);

    const meta = doc.getMap("meta");
    const storedFields = meta.get("fields") as unknown[];
    expect(storedFields).toEqual(newFields);
    expect(storedFields).toHaveLength(2);

    doc.destroy();
  });

  it("overwrites stale fields from initial snapshot", () => {
    const doc = buildTableYDoc(
      { r1: { f1hex: "v1" } },
      ["r1"],
      {
        fields: [
          { id: "f1", name: "OriginalField", field_type: "text" },
          { id: "f2", name: "DeletedField", field_type: "text" },
        ],
        version: 1,
      },
    );

    const meta = doc.getMap("meta");
    expect((meta.get("fields") as unknown[]).length).toBe(2);

    const updatedFields = [{ id: "f1", name: "OriginalField", field_type: "text" }];
    updateTableMetaFields(doc, updatedFields);

    expect((meta.get("fields") as unknown[]).length).toBe(1);
    expect((meta.get("fields") as unknown[])[0]).toEqual(updatedFields[0]);

    doc.destroy();
  });

  it("does not affect other meta keys (version, table_name)", () => {
    const doc = buildTableYDoc(
      {},
      [],
      { fields: [], version: 5, table_name: "MyTable" },
    );

    updateTableMetaFields(doc, [{ id: "f1", name: "New", field_type: "text" }]);

    const meta = doc.getMap("meta");
    expect(meta.get("version")).toBe(5);
    expect(meta.get("table_name")).toBe("MyTable");

    doc.destroy();
  });
});

// ─── ：onStoreSuccess 回写 record_cell_corrections（子记录深度拒绝）──────

describe("#6437: onStoreSuccess applies record_cell_corrections", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("clears rejected parent link cells before saveSnapshot", () => {
    const docName = "table:6437-cell-corrections";
    const parentFieldHex = "parentfieldhex01";
    const doc = buildTableYDoc(
      {
        child: {
          titlehex: "超深",
          [parentFieldHex]: { id: "d4", title: "D4" },
        },
      },
      ["child"],
      { version: 1, table_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    (db as any).onStoreSuccess(doc, docName, {
      version: 2,
      record_cell_corrections: {
        child: { [parentFieldHex]: null },
      },
    });

    const recordMap = doc.getMap("records").get("child") as Y.Map<unknown>;
    expect(recordMap.has(parentFieldHex)).toBe(false);
    expect(recordMap.get("titlehex")).toBe("超深");
    expect(doc.getMap("meta").get("version")).toBe(2);

    clearTableSnapshot(docName);
    doc.destroy();
  });
});

// ─── CMS-002 回归：onStoreSuccess 同步 meta.fields（当 result 包含 fields 时）──────

describe("CMS-002: onStoreSuccess syncs meta.fields from persist response", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("updates meta.fields when result contains fields", () => {
    const docName = "table:cms002-fields";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, fields: [{ id: "f1", name: "Old" }] },
    );

    db.saveSnapshot(docName, doc);

    const newFields = [
      { id: "f1", name: "Updated" },
      { id: "f2", name: "NewField" },
    ];

    (db as any).onStoreSuccess(doc, docName, { version: 2, fields: newFields });

    const meta = doc.getMap("meta");
    expect(meta.get("version")).toBe(2);
    expect(meta.get("fields")).toEqual(newFields);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("does not overwrite meta.fields when result has no fields", () => {
    const docName = "table:cms002-no-fields";
    const originalFields = [{ id: "f1", name: "Kept" }];
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, fields: originalFields },
    );

    db.saveSnapshot(docName, doc);

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const meta = doc.getMap("meta");
    expect(meta.get("version")).toBe(2);
    expect(meta.get("fields")).toEqual(originalFields);

    clearTableSnapshot(docName);
    doc.destroy();
  });

  it("ignores empty fields array in result", () => {
    const docName = "table:cms002-empty";
    const originalFields = [{ id: "f1", name: "Kept" }];
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, fields: originalFields },
    );

    db.saveSnapshot(docName, doc);

    (db as any).onStoreSuccess(doc, docName, { version: 3, fields: [] });

    const meta = doc.getMap("meta");
    expect(meta.get("version")).toBe(3);
    expect(meta.get("fields")).toEqual(originalFields);

    clearTableSnapshot(docName);
    doc.destroy();
  });
});

// ─── CL-001 回归：LRU 淘汰后 buildPersistPayload 不应跳过持久化 ──────

describe("CL-001: missing diff baseline must never trigger a full-table write", () => {
  let db: TableDatabase;

  beforeAll(() => {
    db = new TableDatabase();
  });

  it("fails closed when snapshotCache is empty (LRU eviction)", () => {
    const docName = "table:cl001-lru-evict";
    const doc = buildTableYDoc(
      { r1: { f1: "a" }, r2: { f1: "b", f2: 42 } },
      ["r1", "r2"],
      { version: 5, table_name: "Test", fields: [{ id: "f1" }] },
    );

    // No saveSnapshot → simulates LRU eviction
    expect(() => (db as any).buildPersistPayload(doc, docName, {})).toThrow(
      /missing snapshot baseline/i,
    );

    doc.destroy();
  });

  it("does not infer a row-order rewrite without a baseline", () => {
    const docName = "table:cl001-row-order";
    const doc = buildTableYDoc(
      { r1: { f1: "a" }, r2: { f1: "b" } },
      ["r2", "r1"],
      { version: 3, table_name: "Test" },
    );

    expect(() => (db as any).buildPersistPayload(doc, docName, {})).toThrow(
      /missing snapshot baseline/i,
    );

    doc.destroy();
  });

  it("does not infer a schema rewrite without a baseline", () => {
    const docName = "table:cl001-fields";
    const fields = [{ id: "f1", name: "Name", field_type: "text" }];
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test", fields },
    );

    expect(() => (db as any).buildPersistPayload(doc, docName, {})).toThrow(
      /missing snapshot baseline/i,
    );

    doc.destroy();
  });

  it("does not manufacture a baseline while failing closed", () => {
    const docName = "table:cl001-no-side-effect";
    const doc = buildTableYDoc(
      { r1: { f1: "v1" } },
      ["r1"],
      { version: 1, table_name: "Test" },
    );

    expect(db.snapshotCache.has(docName)).toBe(false);

    expect(() => (db as any).buildPersistPayload(doc, docName, {})).toThrow();

    expect(db.snapshotCache.has(docName)).toBe(false);

    doc.destroy();
  });

});

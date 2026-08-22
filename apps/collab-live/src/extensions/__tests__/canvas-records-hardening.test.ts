/**
 * Canvas records hardening 回归（V2 records-only）
 *
 * W5-Storage 第三段 + W5-Purge：canvas-database 生产路径砍成 records-only，
 * 全部 V1 legacy helper（mergeGraphIntoDoc / docToGraph / docToPages / 等）已删除。
 *
 * 这里只断 records 通道的正确性：merge / replace / delete 语义、persist payload
 * 只含 records_data（+ base_version / schema_version / meta）、onStoreSuccess 复用
 * pending snapshot 保持 digest 准确。V1 legacy maps（nodes / edges / viewport / theme /
 * pages / pageOrder / layoutConfig）的兼容写入分支已随 W5-Purge 一并删除；只剩
 * meta.currentPageId 仍写入 meta map（V2 host 会读）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { CanvasDatabase, mergeRecordsIntoDoc } from "../canvas-database";

class TestCanvasDatabase extends CanvasDatabase {
  public exposeBuildPersistPayload(doc: Y.Doc, documentName = "canvas:test") {
    return this.buildPersistPayload(doc, documentName, {
      editorType: "agent",
      editorId: "agent-test",
      editorName: "Agent Test",
    });
  }

  public exposeOnSnapshotLoaded(documentName: string, doc: Y.Doc, snapshot: Record<string, unknown>) {
    return this.onSnapshotLoaded(documentName, doc, snapshot);
  }

  public exposeOnStoreSuccess(doc: Y.Doc, documentName = "canvas:test", result: Record<string, unknown> = { version: 1 }) {
    return this.onStoreSuccess(doc, documentName, result);
  }
}

describe("canvas records hardening (records-only)", () => {
  it("replace mode removes stale records from a loaded Y.Doc", () => {
    const doc = new Y.Doc();
    mergeRecordsIntoDoc(doc, [
      { id: "shape:old", typeName: "shape:topic", props: { label: "old" } },
      { id: "shape:keep", typeName: "shape:topic", props: { label: "keep" } },
    ]);

    const result = mergeRecordsIntoDoc(doc, [
      { id: "shape:keep", typeName: "shape:topic", props: { label: "new" } },
    ], { mode: "replace" });

    expect(result.recordsApplied).toBe(1);
    expect(doc.getMap("records").has("shape:old")).toBe(false);
    expect(doc.getMap("records").has("shape:keep")).toBe(true);
  });

  it("delete mode removes explicit records from a loaded Y.Doc", () => {
    const doc = new Y.Doc();
    mergeRecordsIntoDoc(doc, [
      { id: "shape:old", typeName: "shape:topic", props: { label: "old" } },
      { id: "shape:keep", typeName: "shape:topic", props: { label: "keep" } },
    ]);

    const result = mergeRecordsIntoDoc(doc, [], { mode: "delete", recordIds: ["shape:old"] });

    expect(result.recordsDeleted).toBe(1);
    expect(doc.getMap("records").has("shape:old")).toBe(false);
    expect(doc.getMap("records").has("shape:keep")).toBe(true);
  });

  it("replace mode with an empty records list clears stale records", () => {
    const doc = new Y.Doc();
    mergeRecordsIntoDoc(doc, [
      { id: "shape:old", typeName: "shape:topic", props: { label: "old" } },
    ]);

    const result = mergeRecordsIntoDoc(doc, [], { mode: "replace" });

    expect(result.recordsDeleted).toBe(1);
    expect(doc.getMap("records").size).toBe(0);
  });

  it("delete mode still applies meta.currentPageId updates", () => {
    const doc = new Y.Doc();
    mergeRecordsIntoDoc(doc, [
      { id: "shape:old", typeName: "shape:topic", props: { label: "old" } },
    ]);

    // W5-Purge：viewport / theme / pages / pageOrder / layoutConfig 的 legacy 顶层
    // Y.Map 已删，不再被 mergeRecordsIntoDoc 写入。只有 meta.currentPageId 会
    // 投影到 meta map（V2 生产路径会读）。
    mergeRecordsIntoDoc(doc, [], {
      mode: "delete",
      recordIds: ["shape:old"],
      meta: { viewport: { x: 42, y: 7, zoom: 2 }, currentPageId: "page:p1" },
    });

    expect(doc.getMap("records").has("shape:old")).toBe(false);
    expect(doc.getMap("viewport").size).toBe(0);
    expect(doc.getMap("meta").get("currentPageId")).toBe("page:p1");
  });

  it("persist payload only carries records_data + base_version + schema_version (+ optional meta)", () => {
    const db = new TestCanvasDatabase();
    const doc = new Y.Doc();
    const documentName = "canvas:records-only-payload";
    mergeRecordsIntoDoc(doc, [
      { id: "shape:a", typeName: "shape:topic", props: { label: "A" } },
    ]);
    db.exposeOnSnapshotLoaded(documentName, doc, {});

    mergeRecordsIntoDoc(doc, [
      { id: "shape:b", typeName: "shape:topic", props: { label: "B" } },
    ]);

    const payload = db.exposeBuildPersistPayload(doc, documentName);
    expect(payload).not.toBeNull();
    const changes = payload!.changes as Record<string, unknown>;

    expect(Array.isArray(changes.records_data)).toBe(true);
    expect((changes.records_data as Array<Record<string, unknown>>).some((r) => r.id === "shape:b")).toBe(true);
    expect(changes.base_version).toBe(0);
    // 历史 canvas Y.Doc 记录仍使用 schema_version=2；升 schema 时同步 canvas-database.ts。
    expect(changes.schema_version).toBe(2);
    expect(changes).not.toHaveProperty("nodes_data");
    expect(changes).not.toHaveProperty("edges_data");
    expect(changes).not.toHaveProperty("viewport");
    expect(changes).not.toHaveProperty("pages_data");
    expect(changes).not.toHaveProperty("page_order");
    expect(changes).not.toHaveProperty("layout_config");
  });

  it("persist returns null when records digest is unchanged and meta is unchanged", () => {
    const db = new TestCanvasDatabase();
    const doc = new Y.Doc();
    const documentName = "canvas:records-only-digest";
    mergeRecordsIntoDoc(doc, [
      { id: "shape:a", typeName: "shape:topic", props: { label: "A" } },
    ]);
    db.exposeOnSnapshotLoaded(documentName, doc, {});

    // 未做任何变更，应返回 null（digest 相同 + 无 meta 变化）
    const payload = db.exposeBuildPersistPayload(doc, documentName);
    expect(payload).toBeNull();
  });

  it("onStoreSuccess uses pending snapshot to keep records digest aligned", () => {
    const db = new TestCanvasDatabase();
    const doc = new Y.Doc();
    const documentName = "canvas:store-success";
    mergeRecordsIntoDoc(doc, [
      { id: "shape:a", typeName: "shape:topic", props: { label: "A" } },
    ]);
    db.exposeOnSnapshotLoaded(documentName, doc, {});

    mergeRecordsIntoDoc(doc, [
      { id: "shape:b", typeName: "shape:topic", props: { label: "B" } },
    ]);
    const payload = db.exposeBuildPersistPayload(doc, documentName);
    expect(payload).not.toBeNull();
    db.exposeOnStoreSuccess(doc, documentName);

    // 再次调用 buildPersistPayload 应返回 null（digest 匹配 onStoreSuccess 后的 snapshot）
    const again = db.exposeBuildPersistPayload(doc, documentName);
    expect(again).toBeNull();
  });

  it("records arriving during persist are captured by the next build", () => {
    const db = new TestCanvasDatabase();
    const doc = new Y.Doc();
    const documentName = "canvas:live-records";
    mergeRecordsIntoDoc(doc, [
      { id: "shape:a", typeName: "shape:topic", props: { label: "A" } },
    ]);
    db.exposeOnSnapshotLoaded(documentName, doc, {});

    mergeRecordsIntoDoc(doc, [
      { id: "shape:b", typeName: "shape:topic", props: { label: "B" } },
    ]);
    const first = db.exposeBuildPersistPayload(doc, documentName);
    expect(first).not.toBeNull();

    // HTTP 往返期间 Agent / 用户新写入一条 record
    mergeRecordsIntoDoc(doc, [
      { id: "shape:live_during_persist", typeName: "shape:topic", props: { label: "live" } },
    ]);
    db.exposeOnStoreSuccess(doc, documentName);

    expect(doc.getMap("records").has("shape:live_during_persist")).toBe(true);

    // 下次 build：应能捕捉到 live record（digest 应该区分）
    const second = db.exposeBuildPersistPayload(doc, documentName);
    expect(second).not.toBeNull();
    const records = second!.changes.records_data as Array<Record<string, unknown>>;
    expect(records.some((r) => r.id === "shape:live_during_persist")).toBe(true);
  });

  it("records-only empty replace persists empty records_data", () => {
    const db = new TestCanvasDatabase();
    const doc = new Y.Doc();
    const documentName = "canvas:records-empty-replace";
    mergeRecordsIntoDoc(doc, [
      { id: "shape:old", typeName: "shape:topic", props: { label: "old" } },
    ]);
    db.exposeOnSnapshotLoaded(documentName, doc, {});

    mergeRecordsIntoDoc(doc, [], { mode: "replace" });

    const payload = db.exposeBuildPersistPayload(doc, documentName);
    expect(payload?.changes.records_data).toEqual([]);
  });

  it("snake_case meta is normalized and currentPageId propagates to meta map", () => {
    const doc = new Y.Doc();

    mergeRecordsIntoDoc(doc, [], {
      mode: "delete",
      recordIds: [],
      meta: {
        pages_data: [{ id: "page:p2", name: "P2" }],
        page_order: ["page:p2"],
        current_page_id: "page:p2",
      } as Record<string, unknown>,
    });

    expect(doc.getMap("meta").get("currentPageId")).toBe("page:p2");
  });
});

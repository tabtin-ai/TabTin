/**
 * page / camera / shape:* 双客户端 records 协作端到端（V2 records-only）。
 *
 * W5-Storage 第三段：V2 host 不再"双写" nodes/edges；所有 shape / binding / page /
 * camera 都通过 records 通道跨端同步，CanvasDatabase.buildPersistPayload 只 emit
 * records_data。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { CanvasDatabase, mergeRecordsIntoDoc } from "../canvas-database";

class TestCanvasDatabase extends CanvasDatabase {
  public exposeBuildPersistPayload(doc: Y.Doc, documentName = "canvas:test") {
    return this.buildPersistPayload(doc, documentName, {
      editorType: "user",
      editorId: "user-test",
      editorName: "User Test",
    });
  }

  public exposeOnSnapshotLoaded(documentName: string, doc: Y.Doc, snapshot: Record<string, unknown>) {
    return this.onSnapshotLoaded(documentName, doc, snapshot);
  }

  public exposeOnStoreSuccess(doc: Y.Doc, documentName = "canvas:test", result: Record<string, unknown> = { version: 1 }) {
    return this.onStoreSuccess(doc, documentName, result);
  }
}

/**
 * 模拟 client A 与 client B 通过 hocuspocus 中转的双向 Y.Doc 桥接。
 */
function createCollabBridge(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const REMOTE = "test-bridge";
  a.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    Y.applyUpdate(b, update, REMOTE);
  });
  b.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    Y.applyUpdate(a, update, REMOTE);
  });
  return { a, b };
}

describe("page/camera/shape 双客户端 records 协作", () => {
  it("client A 写 page/camera → client B 立即在 records map 看到", () => {
    const { a, b } = createCollabBridge();
    mergeRecordsIntoDoc(
      a,
      [
        { id: "page:p1", typeName: "page", props: { name: "页 1", index: "a0" } },
        { id: "camera:page:p1", typeName: "camera", x: 0, y: 0, props: { z: 1, pageId: "page:p1" } },
      ],
      { mode: "merge" },
      "client-a-local",
    );

    expect(b.getMap("records").has("page:p1")).toBe(true);
    expect(b.getMap("records").has("camera:page:p1")).toBe(true);
  });

  it("records-only persist payload 保留 page / camera / shape", () => {
    const db = new TestCanvasDatabase();
    const doc = new Y.Doc();
    const documentName = "canvas:records-only-page";

    db.exposeOnSnapshotLoaded(documentName, doc, {});

    mergeRecordsIntoDoc(
      doc,
      [
        { id: "page:p1", typeName: "page", props: { name: "页 1", index: "a0" } },
        { id: "camera:page:p1", typeName: "camera", x: 0, y: 0, props: { z: 1, pageId: "page:p1" } },
        { id: "shape:topic_root", typeName: "shape:topic", x: 0, y: 0, props: { label: "中心主题" } },
      ],
      { mode: "merge" },
      "client-a-local",
    );

    const payload = db.exposeBuildPersistPayload(doc, documentName);
    expect(payload).not.toBeNull();
    const changes = payload!.changes as Record<string, unknown>;
    const records = changes.records_data as Array<Record<string, unknown>>;

    expect(records.some((record) => record.id === "page:p1")).toBe(true);
    expect(records.some((record) => record.id === "camera:page:p1")).toBe(true);
    expect(records.some((record) => record.id === "shape:topic_root")).toBe(true);

    // records-only：不再 emit nodes_data / edges_data / viewport / pages_data 等
    expect(changes).not.toHaveProperty("nodes_data");
    expect(changes).not.toHaveProperty("edges_data");
    expect(changes).not.toHaveProperty("pages_data");
  });

  it("client A 删除 page record → client B 同步移除 + persist 不再含该 page", () => {
    const db = new TestCanvasDatabase();
    const { a, b } = createCollabBridge();
    const documentName = "canvas:records-delete-page";

    mergeRecordsIntoDoc(
      a,
      [
        { id: "page:p1", typeName: "page", props: { name: "页 1", index: "a0" } },
        { id: "page:p2", typeName: "page", props: { name: "页 2", index: "a1" } },
        { id: "camera:page:p1", typeName: "camera", x: 0, y: 0, props: { z: 1, pageId: "page:p1" } },
      ],
      { mode: "merge" },
      "client-a-local",
    );
    db.exposeOnSnapshotLoaded(documentName, a, {});

    mergeRecordsIntoDoc(a, [], { mode: "delete", recordIds: ["page:p2"] }, "client-a-local");

    expect(b.getMap("records").has("page:p2")).toBe(false);
    expect(a.getMap("records").has("page:p1")).toBe(true);

    const payload = db.exposeBuildPersistPayload(a, documentName);
    expect(payload).not.toBeNull();
    const records = payload!.changes.records_data as Array<Record<string, unknown>>;
    expect(records.some((record) => record.id === "page:p2")).toBe(false);
    expect(records.some((record) => record.id === "page:p1")).toBe(true);
  });

  it("Agent push records 含 page/camera/shape/binding 全部通过 records 通道落盘", () => {
    const doc = new Y.Doc();

    mergeRecordsIntoDoc(
      doc,
      [
        { id: "page:p1", typeName: "page", props: { name: "新页", index: "a0" } },
        { id: "camera:page:p1", typeName: "camera", x: 0, y: 0, props: { z: 1, pageId: "page:p1" } },
        { id: "shape:topic_a", typeName: "shape:topic", x: 0, y: 0, props: { label: "A" } },
        { id: "shape:topic_b", typeName: "shape:topic", x: 200, y: 0, props: { label: "B" } },
        {
          id: "binding:arrow_ab",
          typeName: "binding:arrow",
          fromShapeId: "shape:topic_a",
          toShapeId: "shape:topic_b",
          props: { arrowType: "smoothstep" },
        },
      ],
      { mode: "merge" },
      "agent-push",
    );

    expect(doc.getMap("records").has("page:p1")).toBe(true);
    expect(doc.getMap("records").has("camera:page:p1")).toBe(true);
    expect(doc.getMap("records").has("shape:topic_a")).toBe(true);
    expect(doc.getMap("records").has("shape:topic_b")).toBe(true);
    expect(doc.getMap("records").has("binding:arrow_ab")).toBe(true);
  });

  it("client A 写 shape:image / shape:embed / shape:group / shape:text → client B 收到完整 props（含嵌套对象）", () => {
    const { a, b } = createCollabBridge();

    mergeRecordsIntoDoc(
      a,
      [
        {
          id: "shape:image_1",
          typeName: "shape:image",
          x: 0,
          y: 0,
          props: { src: "asset://abc", width: 200, height: 150, cropBounds: { x: 0, y: 0, w: 1, h: 1 } },
        },
        {
          id: "shape:embed_1",
          typeName: "shape:embed",
          x: 100,
          y: 100,
          props: { url: "https://www.youtube.com/watch?v=abc", providerId: "youtube" },
        },
        {
          id: "shape:group_1",
          typeName: "shape:group",
          x: 0,
          y: 0,
          props: { label: "组合", width: 240, height: 160 },
        },
        {
          id: "shape:text_1",
          typeName: "shape:text",
          x: 50,
          y: 50,
          props: { richText: "纯文本", fontSize: 14 },
        },
      ],
      { mode: "merge" },
      "client-a-local",
    );

    const decode = (id: string): Record<string, unknown> | null => {
      const ymap = b.getMap("records").get(id);
      if (!(ymap instanceof Y.Map)) return null;
      const propsRaw = ymap.get("props");
      if (typeof propsRaw !== "string") return null;
      return JSON.parse(propsRaw) as Record<string, unknown>;
    };

    expect(decode("shape:image_1")).toMatchObject({
      src: "asset://abc",
      width: 200,
      cropBounds: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(decode("shape:embed_1")).toMatchObject({
      url: "https://www.youtube.com/watch?v=abc",
      providerId: "youtube",
    });
    expect(decode("shape:group_1")?.label).toBe("组合");
    expect(decode("shape:text_1")?.richText).toBe("纯文本");
  });
});

/**
 * SlideDatabase op_id 幂等去重测试
 *
 * 验证:
 *   1. buildPersistPayload 生成的 op_id 格式正确
 *   2. 每次调用生成唯一的 op_id
 *   3. op_id 同时出现在 payload 顶层和 changes 内部
 *   4. op_id 前缀为 slide_collab_（与其他模块区分）
 *   5. LRU 淘汰后全量同步也包含 op_id
 *   6. editor_type / editor_id 正确传递
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { SlideDatabase, clearSlideSnapshot } from "../extensions/slide-database.js";

const PAGE_ORDER_MAP = "pageOrderMap";
const PAGE_ELEMENT_ORDER_MAP = "elementOrderMap";

function buildSlideYDoc(
  pages: Record<string, { elements: Record<string, unknown>[] }>,
  pageOrder: string[],
  meta?: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const pagesMap = doc.getMap("pages");
  const pageOrderMap = doc.getMap<number>(PAGE_ORDER_MAP);
  const metaMap = doc.getMap("meta");

  doc.transact(() => {
    for (const [pageId, pageData] of Object.entries(pages)) {
      const pageYMap = new Y.Map<unknown>();
      const elMap = new Y.Map<Y.Map<unknown>>();
      const elOrderMap = new Y.Map<number>();

      for (let i = 0; i < pageData.elements.length; i++) {
        const el = pageData.elements[i];
        const elId = el.id as string;
        if (!elId) continue;
        const yEl = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(el)) yEl.set(k, v);
        elMap.set(elId, yEl);
        elOrderMap.set(elId, i);
      }

      pageYMap.set("elementsMap", elMap);
      pageYMap.set(PAGE_ELEMENT_ORDER_MAP, elOrderMap);
      pagesMap.set(pageId, pageYMap);
    }

    for (let i = 0; i < pageOrder.length; i++) {
      pageOrderMap.set(pageOrder[i], i);
    }

    if (meta) {
      for (const [k, v] of Object.entries(meta)) metaMap.set(k, v);
    }
  });

  return doc;
}

describe("SlideDatabase op_id 幂等去重", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("op_id 格式为 slide_collab_{timestamp}_{random}", () => {
    const docName = "slide:opid-format";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "b");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.op_id).toMatch(/^slide_collab_\d+_[a-z0-9]+$/);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("op_id 同时出现在顶层和 changes.op_id", () => {
    const docName = "slide:opid-dual";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "b");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload.op_id).toBeDefined();
    expect(payload.changes.op_id).toBeDefined();
    expect(payload.op_id).toBe(payload.changes.op_id);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("每次调用生成唯一 op_id", () => {
    const docName = "slide:opid-unique";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "b");
    });

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "c");
    });

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload1).not.toBeNull();
    expect(payload2).not.toBeNull();
    expect(payload1.op_id).not.toBe(payload2.op_id);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("slide_collab_ 前缀与其他模块区分", () => {
    const docName = "slide:opid-prefix";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "changed");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload.op_id.startsWith("slide_collab_")).toBe(true);
    expect(payload.op_id.startsWith("canvas_collab_")).toBe(false);
    expect(payload.op_id.startsWith("table_collab_")).toBe(false);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("LRU 淘汰后全量同步也包含 op_id", () => {
    const docName = "slide:opid-lru";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    // 不调用 saveSnapshot → 模拟 LRU 淘汰
    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.op_id).toBeDefined();
    expect(payload.op_id).toMatch(/^slide_collab_/);

    doc.destroy();
  });

  it("editor_type / editor_id 正确传递到 payload", () => {
    const docName = "slide:opid-editor";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "b");
    });

    const context = {
      editorType: "user",
      editorId: "user-123",
      userId: "user-123",
    };

    const payload = (db as any).buildPersistPayload(doc, docName, context);
    expect(payload).not.toBeNull();
    expect(payload.editor_type).toBe("user");
    expect(payload.editor_id).toBe("user-123");
    expect(payload.changes.editor_type).toBe("user");
    expect(payload.changes.editor_id).toBe("user-123");

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("无变更时不生成 op_id（返回 null）", () => {
    const docName = "slide:opid-no-change";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("op_id 时间戳部分合理（不为 0 或未来时间）", () => {
    const docName = "slide:opid-timestamp";
    const beforeMs = Date.now();

    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "b");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    const afterMs = Date.now();

    const parts = payload.op_id.split("_");
    const timestamp = parseInt(parts[2], 10);
    expect(timestamp).toBeGreaterThanOrEqual(beforeMs);
    expect(timestamp).toBeLessThanOrEqual(afterMs);

    clearSlideSnapshot(docName);
    doc.destroy();
  });
});

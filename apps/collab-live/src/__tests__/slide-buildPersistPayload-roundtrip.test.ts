/**
 * SlideDatabase buildPersistPayload 往返测试
 *
 * 验证 saveSnapshot → Y.Doc 修改 → buildPersistPayload → onStoreSuccess
 * 的完整往返流程：
 *   1. 单页编辑 roundtrip
 *   2. 多页混合操作（新增/修改/删除）roundtrip
 *   3. 页面排序变更 roundtrip
 *   4. meta（theme/project_name）变更 roundtrip
 *   5. 无变更时 buildPersistPayload 返回 null
 *   6. applySnapshotToDoc → saveSnapshot → buildPersistPayload 全链路 roundtrip
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { SlideDatabase, clearSlideSnapshot } from "../extensions/slide-database.js";

const PAGE_ORDER_MAP = "pageOrderMap";
const PAGE_ELEMENT_ORDER_MAP = "elementOrderMap";

function buildSlideYDoc(
  pages: Record<string, { elements: Record<string, unknown>[]; background?: string }>,
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
      if (pageData.background) pageYMap.set("background", pageData.background);

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

describe("SlideDatabase buildPersistPayload roundtrip", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("单页编辑：修改元素内容后 payload 包含 changed_pages", () => {
    const docName = "slide:rt-single-edit";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "original" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const page = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = page.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "modified");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_pages).toHaveProperty("p1");
    expect(payload.changes.changed_pages.p1.elements[0].content).toBe("modified");
    expect(Object.keys(payload.changes.new_pages)).toHaveLength(0);
    expect(payload.changes.deleted_page_ids).toHaveLength(0);

    (db as any).onStoreSuccess(doc, docName, { version: 2 });
    const payloadAfter = (db as any).buildPersistPayload(doc, docName, {});
    expect(payloadAfter).toBeNull();

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("多页混合操作：新增 + 修改 + 删除同时出现", () => {
    const docName = "slide:rt-mixed-ops";
    const doc = buildSlideYDoc(
      {
        p1: { elements: [{ id: "e1", type: "text", content: "keep" }] },
        p2: { elements: [{ id: "e2", type: "shape", content: "delete-me" }] },
      },
      ["p1", "p2"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const pagesMap = doc.getMap("pages");
      const pageOrderMap = doc.getMap<number>(PAGE_ORDER_MAP);

      const p1 = pagesMap.get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "updated");

      pagesMap.delete("p2");
      pageOrderMap.delete("p2");

      const p3 = new Y.Map<unknown>();
      const newElMap = new Y.Map<Y.Map<unknown>>();
      const newElOrderMap = new Y.Map<number>();
      const yEl = new Y.Map<unknown>();
      yEl.set("id", "e3");
      yEl.set("type", "image");
      newElMap.set("e3", yEl);
      newElOrderMap.set("e3", 0);
      p3.set("elementsMap", newElMap);
      p3.set(PAGE_ELEMENT_ORDER_MAP, newElOrderMap);
      pagesMap.set("p3", p3);
      pageOrderMap.set("p3", 1);
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_pages).toHaveProperty("p1");
    expect(payload.changes.new_pages).toHaveProperty("p3");
    expect(payload.changes.deleted_page_ids).toContain("p2");

    (db as any).onStoreSuccess(doc, docName, { version: 2 });
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("页面排序变更：仅改顺序时 payload 包含 page_order", () => {
    const docName = "slide:rt-reorder";
    const doc = buildSlideYDoc(
      {
        p1: { elements: [] },
        p2: { elements: [] },
        p3: { elements: [] },
      },
      ["p1", "p2", "p3"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const pageOrderMap = doc.getMap<number>(PAGE_ORDER_MAP);
      pageOrderMap.set("p3", 0);
      pageOrderMap.set("p1", 1);
      pageOrderMap.set("p2", 2);
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.page_order).toEqual(["p3", "p1", "p2"]);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("meta 变更：theme 变化产生 meta payload", () => {
    const docName = "slide:rt-meta-theme";
    const doc = buildSlideYDoc(
      { p1: { elements: [] } },
      ["p1"],
      { version: 1, project_name: "Test", theme: { primary: "#000" } },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      doc.getMap("meta").set("theme", { primary: "#fff" });
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.meta).toBeDefined();
    expect(payload.changes.meta.theme).toEqual({ primary: "#fff" });

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("meta 变更：project_name 变化产生 meta payload", () => {
    const docName = "slide:rt-meta-name";
    const doc = buildSlideYDoc(
      { p1: { elements: [] } },
      ["p1"],
      { version: 1, project_name: "OldName" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      doc.getMap("meta").set("project_name", "NewName");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.meta).toBeDefined();
    expect(payload.changes.meta.name).toBe("NewName");

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("无变更时返回 null", () => {
    const docName = "slide:rt-no-change";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "stable" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("applySnapshotToDoc → saveSnapshot → 编辑 → buildPersistPayload 全链路 roundtrip", () => {
    const docName = "slide:rt-full-chain";
    const snapshot = {
      project_id: "proj-1",
      project_name: "Full Chain",
      version: 5,
      canvas_width: 1920,
      canvas_height: 1080,
      preset: "16:9",
      theme: { primary: "#abc" },
      pages: [
        { id: "p1", elements: [{ id: "e1", type: "text", content: "hello" }] },
        { id: "p2", elements: [] },
      ],
      page_order: ["p1", "p2"],
    };

    const doc = new Y.Doc();
    doc.transact(() => {
      (db as any).applySnapshotToDoc(doc, snapshot);
    });

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const page = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = page.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "world");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_pages).toHaveProperty("p1");
    expect(payload.changes.changed_pages.p1.elements[0].content).toBe("world");
    expect(payload.changes.base_version).toBe(5);

    (db as any).onStoreSuccess(doc, docName, { version: 6 });
    expect(doc.getMap("meta").get("version")).toBe(6);
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("background 等标量属性的 roundtrip", () => {
    const docName = "slide:rt-scalar-props";
    const doc = buildSlideYDoc(
      { p1: { elements: [], background: "#eee" } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const page = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      page.set("background", "#fff");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.changed_pages.p1.background).toBe("#fff");

    clearSlideSnapshot(docName);
    doc.destroy();
  });
});

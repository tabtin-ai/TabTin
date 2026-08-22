/**
 * SlideDatabase base_version 乐观锁冲突检测测试
 *
 * 验证:
 *   1. buildPersistPayload 输出中包含 base_version（取自 Y.Doc meta.version）
 *   2. onStoreConflict 正确更新 Y.Doc 中的 version
 *   3. conflict 后 buildPersistPayload 使用更新后的 base_version
 *   4. onStoreConflict 不修改 snapshotCache（CI-012 约束）
 *   5. 连续多次 conflict 的 version 递进
 *   6. current_version / current_revn 两种 conflict 响应格式兼容
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { SlideDatabase, clearSlideSnapshot } from "../extensions/slide-database.js";

const PAGE_ORDER_MAP = "pageOrderMap";
const PAGE_ELEMENT_ORDER_MAP = "elementOrderMap";

function buildSlideYDoc(
  pages: Record<string, { elements: Record<string, unknown>[] }>,
  pageOrder: string[],
  meta: Record<string, unknown>,
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

    for (const [k, v] of Object.entries(meta)) metaMap.set(k, v);
  });

  return doc;
}

function modifyDoc(doc: Y.Doc): void {
  doc.transact(() => {
    const pagesMap = doc.getMap("pages");
    const firstPageId = Array.from((pagesMap as any)._map?.keys?.() ?? [])[0];
    if (!firstPageId) return;

    const page = pagesMap.get(firstPageId as string) as Y.Map<unknown>;
    if (!page) return;

    const elMap = page.get("elementsMap") as Y.Map<Y.Map<unknown>>;
    if (!elMap) return;

    const firstElId = Array.from((elMap as any)._map?.keys?.() ?? [])[0];
    if (!firstElId) return;

    const el = elMap.get(firstElId as string) as Y.Map<unknown>;
    if (el) el.set("content", `modified-${Date.now()}`);
  });
}

describe("SlideDatabase base_version 乐观锁冲突检测", () => {
  let db: SlideDatabase;

  beforeEach(() => {
    db = new SlideDatabase();
  });

  it("buildPersistPayload 输出的 base_version 等于 Y.Doc meta.version", () => {
    const docName = "slide:bv-test-1";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 42, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "b");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.base_version).toBe(42);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("onStoreConflict 用 current_version 更新 Y.Doc meta.version", () => {
    const docName = "slide:bv-conflict-cv";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 5, project_name: "Test" },
    );

    (db as any).onStoreConflict(doc, docName, {
      conflict: true,
      current_version: 10,
    });

    expect(doc.getMap("meta").get("version")).toBe(10);
    doc.destroy();
  });

  it("onStoreConflict 用 current_revn 更新 Y.Doc meta.version（兼容格式）", () => {
    const docName = "slide:bv-conflict-revn";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 5, project_name: "Test" },
    );

    (db as any).onStoreConflict(doc, docName, {
      conflict: true,
      current_revn: 8,
    });

    expect(doc.getMap("meta").get("version")).toBe(8);
    doc.destroy();
  });

  it("conflict 后 retry 的 payload 使用更新后的 base_version", () => {
    const docName = "slide:bv-retry";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "v1" }] } },
      ["p1"],
      { version: 3, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const p1 = doc.getMap("pages").get("p1") as Y.Map<unknown>;
      const elMap = p1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      (elMap.get("e1") as Y.Map<unknown>).set("content", "v2");
    });

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1.changes.base_version).toBe(3);

    (db as any).onStoreConflict(doc, docName, {
      conflict: true,
      current_version: 7,
    });

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();
    expect(payload2.changes.base_version).toBe(7);

    clearSlideSnapshot(docName);
    doc.destroy();
  });

  it("onStoreConflict 不修改 snapshotCache（CI-012 约束）", () => {
    const docName = "slide:bv-no-cache-modify";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    const sentinel = { marker: "original" };
    db.snapshotCache.set(docName, sentinel);

    (db as any).onStoreConflict(doc, docName, {
      conflict: true,
      current_version: 5,
    });

    expect(db.snapshotCache.get(docName)).toBe(sentinel);
    doc.destroy();
  });

  it("onStoreConflict 不会在空 snapshotCache 上创建条目", () => {
    const docName = "slide:bv-no-cache-create";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    expect(db.snapshotCache.has(docName)).toBe(false);

    (db as any).onStoreConflict(doc, docName, {
      conflict: true,
      current_version: 5,
    });

    expect(db.snapshotCache.has(docName)).toBe(false);
    doc.destroy();
  });

  it("连续多次 conflict 的 version 递进", () => {
    const docName = "slide:bv-multi-conflict";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    (db as any).onStoreConflict(doc, docName, { conflict: true, current_version: 5 });
    expect(doc.getMap("meta").get("version")).toBe(5);

    (db as any).onStoreConflict(doc, docName, { conflict: true, current_version: 12 });
    expect(doc.getMap("meta").get("version")).toBe(12);

    (db as any).onStoreConflict(doc, docName, { conflict: true, current_version: 20 });
    expect(doc.getMap("meta").get("version")).toBe(20);

    doc.destroy();
  });

  it("conflict 响应无 version 字段时不修改 Y.Doc meta", () => {
    const docName = "slide:bv-no-version";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 7, project_name: "Test" },
    );

    (db as any).onStoreConflict(doc, docName, { conflict: true });

    expect(doc.getMap("meta").get("version")).toBe(7);
    doc.destroy();
  });

  it("onStoreSuccess 后 version 正确更新", () => {
    const docName = "slide:bv-success";
    const doc = buildSlideYDoc(
      { p1: { elements: [{ id: "e1", type: "text", content: "a" }] } },
      ["p1"],
      { version: 1, project_name: "Test" },
    );

    (db as any).onStoreSuccess(doc, docName, { version: 2 });
    expect(doc.getMap("meta").get("version")).toBe(2);

    (db as any).onStoreSuccess(doc, docName, { version: 10 });
    expect(doc.getMap("meta").get("version")).toBe(10);

    doc.destroy();
  });
});

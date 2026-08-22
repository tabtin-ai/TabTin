/**
 * slide-database.ts P0 回归测试
 *
 * 验证 buildPersistPayload 不提前更新 snapshotCache，
 * 确保 HTTP 请求失败后重试仍能产出有效 payload。
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as Y from "yjs";
import { SlideDatabase, clearSlideSnapshot } from "../extensions/slide-database.js";

function buildSlideYDoc(
  pages: Record<string, { elements: Record<string, unknown>[] }>,
  pageOrder: string[],
  meta?: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const pagesMap = doc.getMap("pages");
  const pageOrderArr = doc.getArray<string>("pageOrder");
  const metaMap = doc.getMap("meta");

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
      pageYMap.set("elementOrder", elOrder);

      pagesMap.set(pageId, pageYMap);
    }

    pageOrderArr.push(pageOrder);

    if (meta) {
      for (const [k, v] of Object.entries(meta)) metaMap.set(k, v);
    }
  });

  return doc;
}

describe("snapshot normalization: slide applySnapshotToDoc", () => {
  let db: SlideDatabase;

  beforeAll(() => {
    db = new SlideDatabase();
  });

  it("normalizes backend nested props and snake_case page fields before writing Y.Doc", () => {
    const doc = new Y.Doc();

    (db as any).applySnapshotToDoc(doc, {
      pages: [
        {
          id: "p1",
          section_tag: { id: "sec-1", title: "Section 1" },
          slide_type: "content",
          slide_notes: [{ id: "note-1", content: "speaker note" }],
          elements: [
            {
              id: "t1",
              type: "text",
              x: 10,
              y: 20,
              width: 300,
              height: 80,
              props: {
                content: "<p><strong>Hello</strong></p>",
                defaultColor: "#112233",
                defaultFontName: "Inter",
                defaultTextAlign: "center",
              },
            },
            {
              id: "i1",
              type: "image",
              x: 40,
              y: 60,
              width: 120,
              height: 90,
              props: {
                src: "https://example.com/demo.png",
                fixedRatio: true,
              },
            },
            {
              id: "s1",
              type: "shape",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              props: {
                fill: "#FAFAFA",
                path: "M 0 0 L 200 0 L 200 100 L 0 100 Z",
                viewBox: [200, 100],
                pptxShapeType: "rect",
              },
            },
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

    const pagesMap = doc.getMap("pages");
    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const elementsMap = page.get("elementsMap") as Y.Map<Y.Map<unknown>>;
    const text = elementsMap.get("t1") as Y.Map<unknown>;
    const image = elementsMap.get("i1") as Y.Map<unknown>;
    const shape = elementsMap.get("s1") as Y.Map<unknown>;

    expect(text.get("content")).toBe("<p><strong>Hello</strong></p>");
    expect(text.get("defaultColor")).toBe("#112233");
    expect(text.get("defaultTextAlign")).toBe("center");
    expect(text.get("props")).toBeUndefined();

    expect(image.get("src")).toBe("https://example.com/demo.png");
    expect(image.get("props")).toBeUndefined();

    const viewBox = shape.get("viewBox");
    expect(shape.get("fill")).toBe("#FAFAFA");
    expect(viewBox instanceof Y.Array ? viewBox.toJSON() : viewBox).toEqual([200, 100]);
    expect(shape.get("props")).toBeUndefined();

    const notes = page.get("notes") as Y.Array<unknown>;
    expect(notes.toJSON()).toEqual([{ id: "note-1", content: "speaker note" }]);
    expect(page.get("sectionTag")).toEqual({ id: "sec-1", title: "Section 1" });
    expect(page.get("slideType")).toBe("content");

    doc.destroy();
  });

  it("warns when unsupported snapshot elements are dropped during normalization", () => {
    const doc = new Y.Doc();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    (db as any).applySnapshotToDoc(doc, {
      pages: [
        {
          id: "p-warn",
          elements: [
            {
              id: "bad-1",
              type: "unknown-widget",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              props: {},
            },
          ],
        },
      ],
      page_order: ["p-warn"],
      version: 1,
      project_name: "Warn Test",
      project_id: "proj-warn",
      canvas_width: 1920,
      canvas_height: 1080,
    });

    expect(warnSpy.mock.calls.some(([msg]) =>
      typeof msg === "string" && msg.includes("normalizeSnapshotPage dropped 1 page element(s) for p-warn"),
    )).toBe(true);

    warnSpy.mockRestore();
    doc.destroy();
  });
});

describe("P0 regression: slide buildPersistPayload must not update snapshotCache", () => {
  let db: SlideDatabase;

  beforeAll(() => {
    db = new SlideDatabase();
  });

  it("snapshotCache remains unchanged after buildPersistPayload", () => {
    const docName = "slide:p0-test-1";
    const doc = buildSlideYDoc(
      { page1: { elements: [{ id: "e1", type: "text", content: "hello" }] } },
      ["page1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);
    const snapshotBefore = db.snapshotCache.get(docName);
    expect(snapshotBefore).toBeDefined();

    doc.transact(() => {
      const page1 = doc.getMap("pages").get("page1") as Y.Map<unknown>;
      const elMap = page1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      const e1 = elMap.get("e1") as Y.Map<unknown>;
      e1.set("content", "modified");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    expect(db.snapshotCache.get(docName)).toBe(snapshotBefore);

    clearSlideSnapshot(docName);
  });

  it("retry produces non-null payload when prior persist fails", () => {
    const docName = "slide:p0-retry-test";
    const doc = buildSlideYDoc(
      { page1: { elements: [{ id: "e1", type: "text", content: "v1" }] } },
      ["page1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const page1 = doc.getMap("pages").get("page1") as Y.Map<unknown>;
      const elMap = page1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      const e1 = elMap.get("e1") as Y.Map<unknown>;
      e1.set("content", "v2");
    });

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();
    expect(payload1.changes.changed_pages).toHaveProperty("page1");

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();
    expect(payload2.changes.changed_pages).toHaveProperty("page1");

    clearSlideSnapshot(docName);
  });

  it("onStoreSuccess updates snapshotCache so subsequent diff is empty", () => {
    const docName = "slide:p0-success-test";
    const doc = buildSlideYDoc(
      { page1: { elements: [{ id: "e1", type: "text", content: "v1" }] } },
      ["page1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const page1 = doc.getMap("pages").get("page1") as Y.Map<unknown>;
      const elMap = page1.get("elementsMap") as Y.Map<Y.Map<unknown>>;
      const e1 = elMap.get("e1") as Y.Map<unknown>;
      e1.set("content", "v2");
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    expect(doc.getMap("meta").get("version")).toBe(2);

    const payloadAfterSuccess = (db as any).buildPersistPayload(doc, docName, {});
    expect(payloadAfterSuccess).toBeNull();

    clearSlideSnapshot(docName);
  });

  it("new page addition is detected across retries", () => {
    const docName = "slide:p0-new-page-test";
    const doc = buildSlideYDoc(
      { page1: { elements: [{ id: "e1", type: "text", content: "v1" }] } },
      ["page1"],
      { version: 1, project_name: "Test" },
    );

    db.saveSnapshot(docName, doc);

    doc.transact(() => {
      const pagesMap = doc.getMap("pages");
      const pageYMap = new Y.Map<unknown>();
      const elMap = new Y.Map<Y.Map<unknown>>();
      const elOrder = new Y.Array<string>();
      pageYMap.set("elementsMap", elMap);
      pageYMap.set("elementOrder", elOrder);
      pagesMap.set("page2", pageYMap);

      const pageOrderArr = doc.getArray<string>("pageOrder");
      pageOrderArr.push(["page2"]);
    });

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();
    expect(payload1.changes.new_pages).toHaveProperty("page2");

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();
    expect(payload2.changes.new_pages).toHaveProperty("page2");

    clearSlideSnapshot(docName);
  });
});

// ─── CL-003 回归：LRU 淘汰后 buildPersistPayload 使用 changed_pages 而非 new_pages ──────

describe("CL-003: LRU eviction full-sync uses changed_pages (not new_pages)", () => {
  let db: SlideDatabase;

  beforeAll(() => {
    db = new SlideDatabase();
  });

  it("returns non-null payload when snapshotCache is empty (LRU eviction)", () => {
    const docName = "slide:cl003-lru-evict";
    const doc = buildSlideYDoc(
      {
        page1: { elements: [{ id: "e1", type: "text", content: "hello" }] },
        page2: { elements: [{ id: "e2", type: "shape", content: "rect" }] },
      },
      ["page1", "page2"],
      { version: 3, project_name: "Test" },
    );

    // No saveSnapshot → simulates LRU eviction
    const payload = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload).not.toBeNull();

    doc.destroy();
  });

  it("full-sync uses changed_pages (not new_pages) for all pages", () => {
    const docName = "slide:cl003-changed-not-new";
    const doc = buildSlideYDoc(
      {
        page1: { elements: [{ id: "e1", type: "text", content: "a" }] },
        page2: { elements: [{ id: "e2", type: "text", content: "b" }] },
      },
      ["page1", "page2"],
      { version: 1, project_name: "Test" },
    );

    const payload = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload).not.toBeNull();
    expect(Object.keys(payload.changes.changed_pages)).toHaveLength(2);
    expect(payload.changes.changed_pages).toHaveProperty("page1");
    expect(payload.changes.changed_pages).toHaveProperty("page2");
    expect(Object.keys(payload.changes.new_pages)).toHaveLength(0);
    expect(payload.changes.deleted_page_ids).toHaveLength(0);

    doc.destroy();
  });

  it("does NOT update snapshotCache (pure function constraint)", () => {
    const docName = "slide:cl003-no-side-effect";
    const doc = buildSlideYDoc(
      { page1: { elements: [{ id: "e1", type: "text", content: "test" }] } },
      ["page1"],
      { version: 1, project_name: "Test" },
    );

    expect(db.snapshotCache.has(docName)).toBe(false);

    (db as any).buildPersistPayload(doc, docName, {});

    expect(db.snapshotCache.has(docName)).toBe(false);

    doc.destroy();
  });

  it("includes page_order in full-sync payload", () => {
    const docName = "slide:cl003-page-order";
    const doc = buildSlideYDoc(
      {
        page1: { elements: [] },
        page2: { elements: [] },
      },
      ["page2", "page1"],
      { version: 1, project_name: "Test" },
    );

    const payload = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload).not.toBeNull();
    expect(payload.changes.page_order).toEqual(["page2", "page1"]);

    doc.destroy();
  });

  it("subsequent store after onStoreSuccess uses normal diff path", () => {
    const docName = "slide:cl003-recovery";
    const doc = buildSlideYDoc(
      { page1: { elements: [{ id: "e1", type: "text", content: "v1" }] } },
      ["page1"],
      { version: 1, project_name: "Test" },
    );

    // First store: full-sync (no snapshot)
    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();
    expect(Object.keys(payload1.changes.changed_pages)).toHaveLength(1);

    // Simulate successful persist → onStoreSuccess rebuilds snapshot
    (db as any).onStoreSuccess(doc, docName, { version: 2 });
    expect(db.snapshotCache.has(docName)).toBe(true);

    // No changes → next store should return null (normal diff path)
    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).toBeNull();

    clearSlideSnapshot(docName);
    doc.destroy();
  });
});

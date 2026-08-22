/**
 * P0 回归测试：slide-push / design-push 数据完整性
 *
 * P0-1: applyPageLevelChange 必须写入 elementsMap + elementOrder（非 elements 数组）
 * P0-2: applyElementLevelChange 必须迁移旧 elements 数组到 elementsMap + elementOrder
 * P0-3: design-push 不应在 transact 内调用 saveDesignSnapshot
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";

// ── yPageToJson 的精简复现（与 slide-database.ts 逻辑一致） ──

function yPageToJson(pageYMap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const elementsMap = pageYMap.get("elementsMap");
  const elementOrder = pageYMap.get("elementOrder");

  if (elementsMap instanceof Y.Map && elementOrder instanceof Y.Array) {
    const ordered: unknown[] = [];
    for (let i = 0; i < elementOrder.length; i++) {
      const elId = elementOrder.get(i) as string;
      const elYMap = elementsMap.get(elId);
      if (elYMap instanceof Y.Map) {
        ordered.push(elYMap.toJSON());
      }
    }
    result.elements = ordered;
  } else {
    const elements = pageYMap.get("elements");
    result.elements = elements instanceof Y.Array ? elements.toJSON() : [];
  }

  return result;
}

// ── 复现 applyPageLevelChange（修复后版本） ──

function applyPageLevelChange(
  ydoc: Y.Doc,
  pagesMap: Y.Map<unknown>,
  change: Record<string, unknown>,
): boolean {
  const page_id = (change.page_id || change.id) as string | undefined;
  if (!page_id) return false;

  const { elements } = change;

  let pageYMap = pagesMap.get(page_id) as Y.Map<unknown> | undefined;
  if (!pageYMap) {
    pageYMap = new Y.Map<unknown>();
    pagesMap.set(page_id, pageYMap);
    const pageOrder = ydoc.getArray<string>("pageOrder");
    pageOrder.push([page_id]);
  }

  if (elements !== undefined && Array.isArray(elements)) {
    if (pageYMap.has("elementsMap")) pageYMap.delete("elementsMap");
    if (pageYMap.has("elementOrder")) pageYMap.delete("elementOrder");
    if (pageYMap.has("elements")) pageYMap.delete("elements");

    const elMap = new Y.Map<Y.Map<unknown>>();
    const elOrder = new Y.Array<string>();
    const orderIds: string[] = [];
    for (const el of elements) {
      const id = (el as Record<string, unknown>).id as string | undefined;
      if (id) {
        const yEl = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(el as Record<string, unknown>)) yEl.set(k, v);
        elMap.set(id, yEl);
        orderIds.push(id);
      }
    }
    elOrder.push(orderIds);
    pageYMap.set("elementsMap", elMap);
    pageYMap.set("elementOrder", elOrder);
  }

  return true;
}

// ── 复现 applyElementLevelChange（修复后版本） ──

function applyElementLevelChange(
  ydoc: Y.Doc,
  pagesMap: Y.Map<unknown>,
  change: Record<string, unknown>,
): boolean {
  const { page_id, op, element_id, element, patch } = change as {
    page_id?: string;
    op?: string;
    element_id?: string;
    element?: Record<string, unknown>;
    patch?: Record<string, unknown>;
  };
  if (!page_id || !element_id || !op) return false;
  const operation = op;

  let pageYMap = pagesMap.get(page_id) as Y.Map<unknown> | undefined;
  if (!pageYMap) {
    if (operation === "add") {
      pageYMap = new Y.Map<unknown>();
      pageYMap.set("elementsMap", new Y.Map<Y.Map<unknown>>());
      pageYMap.set("elementOrder", new Y.Array<string>());
      pagesMap.set(page_id, pageYMap);
      const pageOrder = ydoc.getArray<string>("pageOrder");
      pageOrder.push([page_id]);
    } else {
      return false;
    }
  }

  const rawMap = pageYMap.get("elementsMap");
  const rawOrder = pageYMap.get("elementOrder");

  let elementsMap: Y.Map<Y.Map<unknown>>;
  let elementOrder: Y.Array<string>;

  if (rawMap instanceof Y.Map && rawOrder instanceof Y.Array) {
    elementsMap = rawMap as Y.Map<Y.Map<unknown>>;
    elementOrder = rawOrder;
  } else {
    elementsMap = new Y.Map<Y.Map<unknown>>();
    elementOrder = new Y.Array<string>();

    const legacyArr = pageYMap.get("elements") as Y.Array<unknown> | undefined;
    if (legacyArr instanceof Y.Array) {
      const orderIds: string[] = [];
      for (let i = 0; i < legacyArr.length; i++) {
        const el = legacyArr.get(i) as Record<string, unknown> | null;
        if (el && typeof el.id === "string") {
          const yEl = new Y.Map<unknown>();
          for (const [k, v] of Object.entries(el)) yEl.set(k, v);
          elementsMap.set(el.id, yEl);
          orderIds.push(el.id);
        }
      }
      elementOrder.push(orderIds);
      pageYMap.delete("elements");
    }

    pageYMap.set("elementsMap", elementsMap);
    pageYMap.set("elementOrder", elementOrder);
  }

  if (operation === "add" && element) {
    const yEl = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(element)) yEl.set(k, v);
    elementsMap.set(element_id, yEl);
    elementOrder.push([element_id]);
    return true;
  } else if (operation === "update" && patch) {
    const existing = elementsMap.get(element_id);
    if (existing instanceof Y.Map) {
      for (const [k, v] of Object.entries(patch)) existing.set(k, v);
      return true;
    }
  } else if (operation === "delete") {
    elementsMap.delete(element_id);
    for (let i = 0; i < elementOrder.length; i++) {
      if (elementOrder.get(i) === element_id) { elementOrder.delete(i, 1); break; }
    }
    return true;
  }

  return false;
}

// ══════════════════════════════════════════════
// P0-1: 页面级 push 写入 elementsMap + elementOrder
// ══════════════════════════════════════════════

describe("P0-1: applyPageLevelChange writes elementsMap + elementOrder", () => {
  it("creates elementsMap/elementOrder for new page", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      applyPageLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        elements: [
          { id: "e1", type: "text", content: "Hello" },
          { id: "e2", type: "shape", fill: "red" },
        ],
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    expect(page).toBeInstanceOf(Y.Map);

    const elMap = page.get("elementsMap") as Y.Map<unknown>;
    const elOrder = page.get("elementOrder") as Y.Array<string>;
    expect(elMap).toBeInstanceOf(Y.Map);
    expect(elOrder).toBeInstanceOf(Y.Array);
    expect(elMap.size).toBe(2);
    expect(elOrder.length).toBe(2);
    expect(elOrder.get(0)).toBe("e1");
    expect(elOrder.get(1)).toBe("e2");

    expect(page.has("elements")).toBe(false);

    ydoc.destroy();
  });

  it("clears existing elementsMap/elementOrder before writing new ones", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      const pageYMap = new Y.Map<unknown>();
      const oldMap = new Y.Map<Y.Map<unknown>>();
      const oldEl = new Y.Map<unknown>();
      oldEl.set("id", "old1");
      oldEl.set("type", "text");
      oldMap.set("old1", oldEl);
      pageYMap.set("elementsMap", oldMap);

      const oldOrder = new Y.Array<string>();
      oldOrder.push(["old1"]);
      pageYMap.set("elementOrder", oldOrder);

      pagesMap.set("p1", pageYMap);
      ydoc.getArray<string>("pageOrder").push(["p1"]);
    });

    ydoc.transact(() => {
      applyPageLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        elements: [{ id: "new1", type: "image", src: "url" }],
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);
    expect(json.elements).toEqual([{ id: "new1", type: "image", src: "url" }]);

    ydoc.destroy();
  });

  it("yPageToJson reads elements from elementsMap/elementOrder after page-level push", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      applyPageLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        elements: [
          { id: "e1", type: "text", content: "A" },
          { id: "e2", type: "text", content: "B" },
        ],
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);
    expect(json.elements).toEqual([
      { id: "e1", type: "text", content: "A" },
      { id: "e2", type: "text", content: "B" },
    ]);

    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════
// P0-2: 元素级 push 迁移旧 elements 数据
// ══════════════════════════════════════════════

describe("P0-2: applyElementLevelChange migrates legacy elements array", () => {
  it("migrates elements array when elementsMap/elementOrder missing", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    // 模拟旧格式：只有 elements 数组，无 elementsMap/elementOrder
    ydoc.transact(() => {
      const pageYMap = new Y.Map<unknown>();
      const elemArr = new Y.Array<unknown>();
      elemArr.push([{ id: "e1", type: "text", content: "old" }]);
      pageYMap.set("elements", elemArr);
      pagesMap.set("p1", pageYMap);
    });

    ydoc.transact(() => {
      applyElementLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        op: "add",
        element_id: "e2",
        element: { id: "e2", type: "shape", fill: "blue" },
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);

    expect((json.elements as unknown[]).length).toBe(2);
    const els = json.elements as Record<string, unknown>[];
    expect(els.find(e => e.id === "e1")).toBeDefined();
    expect(els.find(e => e.id === "e2")).toBeDefined();

    expect(page.has("elements")).toBe(false);

    ydoc.destroy();
  });

  it("page-level push then element-level push preserves all data", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      applyPageLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        elements: [
          { id: "e1", type: "text", content: "page-level" },
        ],
      });
    });

    ydoc.transact(() => {
      applyElementLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        op: "add",
        element_id: "e2",
        element: { id: "e2", type: "shape", fill: "red" },
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);
    const els = json.elements as Record<string, unknown>[];
    expect(els.length).toBe(2);
    expect(els.find(e => e.id === "e1")?.content).toBe("page-level");
    expect(els.find(e => e.id === "e2")?.fill).toBe("red");

    ydoc.destroy();
  });

  it("element-level push then page-level push replaces all data", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    ydoc.transact(() => {
      applyElementLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        op: "add",
        element_id: "e1",
        element: { id: "e1", type: "text", content: "element-level" },
      });
    });

    ydoc.transact(() => {
      applyPageLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        elements: [
          { id: "e3", type: "image", src: "url" },
        ],
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);
    const els = json.elements as Record<string, unknown>[];
    expect(els.length).toBe(1);
    expect(els[0].id).toBe("e3");

    ydoc.destroy();
  });

  it("update operation works after migration", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    // 旧格式页面
    ydoc.transact(() => {
      const pageYMap = new Y.Map<unknown>();
      const elemArr = new Y.Array<unknown>();
      elemArr.push([{ id: "e1", type: "text", content: "original" }]);
      pageYMap.set("elements", elemArr);
      pagesMap.set("p1", pageYMap);
    });

    // 用 update 修改
    ydoc.transact(() => {
      applyElementLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        op: "update",
        element_id: "e1",
        patch: { content: "updated" },
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);
    const els = json.elements as Record<string, unknown>[];
    expect(els.length).toBe(1);
    expect(els[0].content).toBe("updated");

    ydoc.destroy();
  });

  it("delete operation works after migration", () => {
    const ydoc = new Y.Doc();
    const pagesMap = ydoc.getMap("pages");

    // 旧格式页面有两个元素
    ydoc.transact(() => {
      const pageYMap = new Y.Map<unknown>();
      const elemArr = new Y.Array<unknown>();
      elemArr.push([
        { id: "e1", type: "text", content: "keep" },
        { id: "e2", type: "text", content: "delete" },
      ]);
      pageYMap.set("elements", elemArr);
      pagesMap.set("p1", pageYMap);
    });

    ydoc.transact(() => {
      applyElementLevelChange(ydoc, pagesMap, {
        page_id: "p1",
        op: "delete",
        element_id: "e2",
      });
    });

    const page = pagesMap.get("p1") as Y.Map<unknown>;
    const json = yPageToJson(page);
    const els = json.elements as Record<string, unknown>[];
    expect(els.length).toBe(1);
    expect(els[0].id).toBe("e1");

    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════
// P0-3: Design snapshot 不应在 transact 内提前保存
// ══════════════════════════════════════════════

describe("P0-3: design-push snapshot cache timing", () => {
  it("snapshot cache diff is non-null when changes applied without premature save", () => {
    const ydoc = new Y.Doc();
    const cache = new Map<string, Record<string, unknown>>();

    // 初始化快照
    const pageMap = ydoc.getMap("page:p1");
    ydoc.transact(() => {
      const shape = new Y.Map<unknown>();
      shape.set("id", "s1");
      shape.set("type", "rect");
      shape.set("width", 100);
      pageMap.set("s1", shape);
    });
    cache.set("design:proj1", { s1: { id: "s1", type: "rect", width: 100 } });

    // 模拟 agent push：修改 Y.Doc
    ydoc.transact(() => {
      const shape = pageMap.get("s1") as Y.Map<unknown>;
      shape.set("width", 200);
    });

    // 不在 transact 内更新缓存 → buildPersistPayload 应检测到 diff
    const currentData: Record<string, unknown> = {};
    pageMap.forEach((value, key) => {
      if (value instanceof Y.Map) currentData[key] = value.toJSON();
    });
    const lastSnapshot = cache.get("design:proj1");
    const hasChanges = JSON.stringify(currentData) !== JSON.stringify(lastSnapshot);
    expect(hasChanges).toBe(true);

    ydoc.destroy();
  });

  it("premature snapshot save causes diff to be null (demonstrates the bug)", () => {
    const ydoc = new Y.Doc();
    const cache = new Map<string, Record<string, unknown>>();

    const pageMap = ydoc.getMap("page:p1");
    ydoc.transact(() => {
      const shape = new Y.Map<unknown>();
      shape.set("id", "s1");
      shape.set("type", "rect");
      shape.set("width", 100);
      pageMap.set("s1", shape);
    });
    cache.set("design:proj1", { s1: { id: "s1", type: "rect", width: 100 } });

    // Bug scenario: save snapshot inside transact
    ydoc.transact(() => {
      const shape = pageMap.get("s1") as Y.Map<unknown>;
      shape.set("width", 200);

      // premature snapshot save (the bug)
      const snapshot: Record<string, unknown> = {};
      pageMap.forEach((value, key) => {
        if (value instanceof Y.Map) snapshot[key] = value.toJSON();
      });
      cache.set("design:proj1", snapshot);
    });

    // buildPersistPayload runs after transact → diff is empty
    const currentData: Record<string, unknown> = {};
    pageMap.forEach((value, key) => {
      if (value instanceof Y.Map) currentData[key] = value.toJSON();
    });
    const lastSnapshot = cache.get("design:proj1");
    const hasChanges = JSON.stringify(currentData) !== JSON.stringify(lastSnapshot);
    expect(hasChanges).toBe(false);

    ydoc.destroy();
  });

  it("design-push.ts no longer imports saveDesignSnapshot", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const designPushPath = path.resolve(
      import.meta.dirname ?? ".",
      "../routes/design-push.ts",
    );
    const source = fs.readFileSync(designPushPath, "utf-8");
    expect(source).not.toContain("saveDesignSnapshot");
  });
});

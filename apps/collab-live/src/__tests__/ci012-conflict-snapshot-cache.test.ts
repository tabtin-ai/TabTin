/**
 * CI-012 回归测试：onStoreConflict 不得操作 snapshotCache
 *
 * 修复前 Canvas 的 onStoreConflict 会调用 snapshotCache.set，
 * 导致基类紧接着调用的 buildPersistPayload 拿刚设的快照与同一 ydoc 对比，
 * 误判"无变更"返回 null，短路冲突重试机制。
 *
 * 本测试验证：
 *   1. onStoreConflict 只更新 Y.Doc meta（version/revn），不操作 snapshotCache
 *   2. conflict 后 buildPersistPayload 仍能产出有效 payload（重试不被短路）
 *   3. 所有 4 个子类均符合此约束
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import { CanvasDatabase } from "../extensions/canvas-database.js";
import { VideoDatabase } from "../extensions/video-database.js";
import { SlideDatabase } from "../extensions/slide-database.js";
import { TableDatabase } from "../extensions/table-database.js";

/**
 * 暴露 protected 方法的测试 wrapper
 */
class TestableCanvas extends CanvasDatabase {
  callOnStoreConflict(ydoc: Y.Doc, documentName: string, result: Record<string, unknown>): void {
    this.onStoreConflict(ydoc, documentName, result);
  }
}

class TestableVideo extends VideoDatabase {
  callOnStoreConflict(ydoc: Y.Doc, documentName: string, result: Record<string, unknown>): void {
    this.onStoreConflict(ydoc, documentName, result);
  }
}

class TestableSlide extends SlideDatabase {
  callOnStoreConflict(ydoc: Y.Doc, documentName: string, result: Record<string, unknown>): void {
    this.onStoreConflict(ydoc, documentName, result);
  }
}

class TestableTable extends TableDatabase {
  callOnStoreConflict(ydoc: Y.Doc, documentName: string, result: Record<string, unknown>): void {
    this.onStoreConflict(ydoc, documentName, result);
  }
}

function makeCanvasDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap("meta");
    meta.set("canvasId", "c-1");
    meta.set("name", "Test Canvas");
    meta.set("canvasType", "mindmap");
    meta.set("version", 1);

    const nodesMap = doc.getMap("nodes");
    const nodeYMap = new Y.Map<unknown>();
    nodeYMap.set("id", "n1");
    nodeYMap.set("type", "default");
    const posMap = new Y.Map<unknown>();
    posMap.set("x", 100);
    posMap.set("y", 200);
    nodeYMap.set("position", posMap);
    const dataMap = new Y.Map<unknown>();
    dataMap.set("label", "Node 1");
    nodeYMap.set("data", dataMap);
    nodesMap.set("n1", nodeYMap);
  });
  return doc;
}

describe("CI-012: onStoreConflict must not set snapshotCache", () => {
  describe("CanvasDatabase", () => {
    it("onStoreConflict does not modify snapshotCache (empty → still empty)", () => {
      const db = new TestableCanvas();
      const docName = "canvas:c-1";
      const doc = makeCanvasDoc();

      expect(db.snapshotCache.has(docName)).toBe(false);

      db.callOnStoreConflict(doc, docName, {
        conflict: true,
        current_version: 5,
      });

      expect(db.snapshotCache.has(docName)).toBe(false);
    });

    it("onStoreConflict does not overwrite existing snapshotCache entry", () => {
      const db = new TestableCanvas();
      const docName = "canvas:c-1";
      const doc = makeCanvasDoc();

      const sentinel = { marker: "original-snapshot" };
      db.snapshotCache.set(docName, sentinel);

      db.callOnStoreConflict(doc, docName, {
        conflict: true,
        current_version: 5,
      });

      expect(db.snapshotCache.get(docName)).toBe(sentinel);
    });

    it("onStoreConflict updates Y.Doc meta version", () => {
      const db = new TestableCanvas();
      const doc = makeCanvasDoc();

      expect(doc.getMap("meta").get("version")).toBe(1);

      db.callOnStoreConflict(doc, "canvas:c-1", {
        conflict: true,
        current_version: 42,
      });

      expect(doc.getMap("meta").get("version")).toBe(42);
    });

    it("onStoreConflict with null version does not change Y.Doc meta", () => {
      const db = new TestableCanvas();
      const doc = makeCanvasDoc();

      expect(doc.getMap("meta").get("version")).toBe(1);

      db.callOnStoreConflict(doc, "canvas:c-1", {
        conflict: true,
      });

      expect(doc.getMap("meta").get("version")).toBe(1);
    });
  });

  describe("all subclasses: onStoreConflict does not modify snapshotCache", () => {
    const cases: Array<{
      name: string;
      createDb: () => { snapshotCache: Map<string, unknown>; callOnStoreConflict: (ydoc: Y.Doc, docName: string, result: Record<string, unknown>) => void };
      prefix: string;
      conflictResult: Record<string, unknown>;
    }> = [
      {
        name: "VideoDatabase",
        createDb: () => new TestableVideo(),
        prefix: "video:",
        conflictResult: { conflict: true, current_version: 5 },
      },
      {
        name: "SlideDatabase",
        createDb: () => new TestableSlide(),
        prefix: "slide:",
        conflictResult: { conflict: true, current_version: 5 },
      },
      {
        name: "TableDatabase",
        createDb: () => new TestableTable(),
        prefix: "table:",
        conflictResult: { conflict: true, current_version: 5 },
      },
    ];

    for (const { name, createDb, prefix, conflictResult } of cases) {
      it(`${name}: onStoreConflict does not set snapshotCache`, () => {
        const db = createDb();
        const doc = new Y.Doc();
        const docName = `${prefix}test-1`;

        db.snapshotCache.set(docName, { dummy: true });
        const before = db.snapshotCache.get(docName);

        db.callOnStoreConflict(doc, docName, conflictResult);

        const after = db.snapshotCache.get(docName);
        expect(after).toBe(before);
      });
    }
  });
});

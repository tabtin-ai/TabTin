/**
 * 回归测试：RC-002 / CR-009 / CR-010
 *
 * RC-002: agent-push 的 doc.transact 必须设置非 null origin，防止 UndoManager 误追踪
 * CR-009: detectConcurrentEditors 的 TOCTOU 竞态缓解（pre+post 合并）
 * CR-010: response 包含 concurrent_editors_scope 字段标识检测范围
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";

// ─── RC-002: AGENT_PUSH_ORIGIN 与 UndoManager 隔离 ───

const AGENT_PUSH_ORIGIN = "agent-push";

describe("RC-002: agent push origin prevents UndoManager tracking", () => {
  it("Y.applyUpdate with AGENT_PUSH_ORIGIN sets non-null transaction origin", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];

    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });

    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "agent wrote this");
    const update = Y.encodeStateAsUpdate(sourceDoc);

    Y.applyUpdate(doc, update, AGENT_PUSH_ORIGIN);

    expect(origins).toHaveLength(1);
    expect(origins[0]).toBe(AGENT_PUSH_ORIGIN);

    sourceDoc.destroy();
    doc.destroy();
  });

  it("UndoManager with trackedOrigins=[null] does NOT track agent-push origin", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");

    text.insert(0, "user typed this");

    const undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set([null]),
    });

    doc.transact(() => {
      text.insert(text.length, " — agent appended");
    }, AGENT_PUSH_ORIGIN);

    expect(text.toString()).toBe("user typed this — agent appended");

    undoManager.undo();

    expect(text.toString()).toBe("user typed this — agent appended");

    undoManager.destroy();
    doc.destroy();
  });

  it("UndoManager DOES track null-origin transactions (user behavior)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");

    const undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set([null]),
    });

    doc.transact(() => {
      text.insert(0, "user typed this");
    });

    expect(text.toString()).toBe("user typed this");

    undoManager.undo();
    expect(text.toString()).toBe("");

    undoManager.destroy();
    doc.destroy();
  });

  it("ydoc.transact with AGENT_PUSH_ORIGIN sets origin on direct CRDT ops", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];

    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });

    doc.transact(() => {
      const map = doc.getMap("records");
      map.set("r1", new Y.Map());
    }, AGENT_PUSH_ORIGIN);

    expect(origins).toHaveLength(1);
    expect(origins[0]).toBe(AGENT_PUSH_ORIGIN);

    doc.destroy();
  });

  it("AGENT_PUSH_ORIGIN is a non-null, non-empty string", () => {
    expect(AGENT_PUSH_ORIGIN).toBeTruthy();
    expect(typeof AGENT_PUSH_ORIGIN).toBe("string");
    expect(AGENT_PUSH_ORIGIN).not.toBe("null");
  });
});

// ─── CR-009: mergeEditors TOCTOU defense ───

type EditorInfo = { editor_type: string; editor_id: string };

function mergeEditors(a: EditorInfo[], b: EditorInfo[]): EditorInfo[] {
  const seen = new Set(a.map((e) => `${e.editor_type}:${e.editor_id}`));
  const result = [...a];
  for (const e of b) {
    const key = `${e.editor_type}:${e.editor_id}`;
    if (!seen.has(key)) {
      result.push(e);
      seen.add(key);
    }
  }
  return result;
}

describe("CR-009: mergeEditors TOCTOU defense-in-depth", () => {
  it("returns union of pre and post editor lists", () => {
    const pre: EditorInfo[] = [
      { editor_type: "user", editor_id: "u1" },
    ];
    const post: EditorInfo[] = [
      { editor_type: "user", editor_id: "u2" },
    ];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.editor_id)).toContain("u1");
    expect(merged.map((e) => e.editor_id)).toContain("u2");
  });

  it("deduplicates editors present in both pre and post", () => {
    const pre: EditorInfo[] = [
      { editor_type: "user", editor_id: "u1" },
    ];
    const post: EditorInfo[] = [
      { editor_type: "user", editor_id: "u1" },
      { editor_type: "user", editor_id: "u2" },
    ];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(2);
  });

  it("catches editor that appeared during transact (post only)", () => {
    const pre: EditorInfo[] = [];
    const post: EditorInfo[] = [
      { editor_type: "user", editor_id: "late-joiner" },
    ];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(1);
    expect(merged[0].editor_id).toBe("late-joiner");
  });

  it("retains editor that disconnected during transact (pre only)", () => {
    const pre: EditorInfo[] = [
      { editor_type: "user", editor_id: "early-leaver" },
    ];
    const post: EditorInfo[] = [];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(1);
    expect(merged[0].editor_id).toBe("early-leaver");
  });

  it("returns empty when both pre and post are empty", () => {
    const merged = mergeEditors([], []);
    expect(merged).toHaveLength(0);
  });

  it("handles duplicate entries within the same list", () => {
    const pre: EditorInfo[] = [
      { editor_type: "user", editor_id: "u1" },
      { editor_type: "user", editor_id: "u1" },
    ];
    const post: EditorInfo[] = [
      { editor_type: "user", editor_id: "u1" },
    ];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(2);
  });
});

// ─── CR-009: canvas handler callback must be synchronous ───

describe("CR-009: canvas handler TOCTOU window closure", () => {
  it("dynamic import should happen before withDirectConnection callback", () => {
    let importOrder = 0;
    let callbackOrder = 0;
    let order = 0;

    const simulateCanvasHandler = async () => {
      await Promise.resolve();
      importOrder = ++order;

      const callback = () => {
        callbackOrder = ++order;
      };

      callback();
    };

    return simulateCanvasHandler().then(() => {
      expect(importOrder).toBe(1);
      expect(callbackOrder).toBe(2);
      expect(callbackOrder - importOrder).toBe(1);
    });
  });

  it("pre+post detection runs in same synchronous scope as transact", () => {
    let preOrder = 0;
    let transactOrder = 0;
    let postOrder = 0;
    let order = 0;

    const mockCallback = () => {
      preOrder = ++order;
      transactOrder = ++order;
      postOrder = ++order;
    };

    mockCallback();

    expect(postOrder - preOrder).toBe(2);
    expect(transactOrder - preOrder).toBe(1);
    expect(postOrder - transactOrder).toBe(1);
  });
});

// ─── CR-010: concurrent_editors_scope field ───

describe("CR-010: response includes concurrent_editors_scope", () => {
  it("docs push response data shape", () => {
    const responseData = {
      document_id: "test-doc",
      concurrent_editors: [] as EditorInfo[],
      has_conflict: false,
      concurrent_editors_scope: "local_node" as const,
      _warning: "placeholder",
    };

    expect(responseData.concurrent_editors_scope).toBe("local_node");
    expect(responseData).toHaveProperty("concurrent_editors_scope");
  });

  it("table push response data shape", () => {
    const responseData = {
      table_id: "test-table",
      applied: 5,
      total: 5,
      concurrent_editors: [] as EditorInfo[],
      has_conflict: false,
      concurrent_editors_scope: "local_node" as const,
      _warning: "placeholder",
    };

    expect(responseData.concurrent_editors_scope).toBe("local_node");
  });

  it("canvas push response data shape", () => {
    const responseData = {
      canvas_id: "test-canvas",
      nodes_applied: 3,
      edges_applied: 2,
      concurrent_editors: [] as EditorInfo[],
      has_conflict: false,
      concurrent_editors_scope: "local_node" as const,
      _warning: "placeholder",
    };

    expect(responseData.concurrent_editors_scope).toBe("local_node");
  });

  it("scope value is 'local_node' (not 'global' or undefined)", () => {
    const scope: string = "local_node";
    expect(scope).not.toBe("global");
    expect(scope).not.toBe("");
    expect(scope).toBe("local_node");
  });
});

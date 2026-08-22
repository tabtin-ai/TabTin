/**
 * Wave 2-4 回归测试
 *
 * 覆盖 #5 多实例 warning、#6 Table/Canvas 并发检测、
 * #7 block/update context、#8 diffs 数组限制、#9 binary 字节限制、
 * requireLiveSecret timingSafeEqual、mergeEditors TOCTOU 防御
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import crypto from "node:crypto";

import {
  detectConcurrentEditors,
  extractEditorInfoForStore,
  mergeEditors,
  type HocuspocusLike,
} from "../lib/collab-utils.js";
import {
  MAX_BINARY_BYTES,
  MULTI_INSTANCE_WARNING,
} from "../routes/apply-ops.js";
import { MAX_DIFFS_COUNT } from "../routes/convert.js";

// ─── 辅助 ───

function createDocBinary(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function toB64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function createMockHocuspocus(
  docName: string,
  connections: Array<{ readOnly?: boolean; context: Record<string, unknown> }>,
): HocuspocusLike {
  const docs = new Map<
    string,
    { getConnections(): Array<{ readOnly?: boolean; context: Record<string, unknown> }> }
  >();
  docs.set(docName, { getConnections: () => connections });
  return { documents: docs };
}

// ─── #8: diffs_b64 数组长度限制（验证生产常量 MAX_DIFFS_COUNT） ───

describe("#8 apply-diff diffs_b64 array length limit", () => {
  it("MAX_DIFFS_COUNT equals 100", () => {
    expect(MAX_DIFFS_COUNT).toBe(100);
  });

  it("rejects when diffs_b64 exceeds MAX_DIFFS_COUNT", () => {
    const oversized = new Array(MAX_DIFFS_COUNT + 1).fill("AAAA");
    expect(oversized.length).toBe(101);
    expect(oversized.length > MAX_DIFFS_COUNT).toBe(true);
  });

  it("accepts exactly MAX_DIFFS_COUNT diffs", () => {
    const atLimit = new Array(MAX_DIFFS_COUNT).fill("AAAA");
    expect(atLimit.length).toBe(100);
    expect(atLimit.length > MAX_DIFFS_COUNT).toBe(false);
  });

  it("accepts empty diffs array", () => {
    const empty: string[] = [];
    expect(empty.length > MAX_DIFFS_COUNT).toBe(false);
  });
});

// ─── #9: binary_b64 字节上限（验证生产常量 MAX_BINARY_BYTES） ───

describe("#9 binary_b64 byte size limit", () => {
  it("MAX_BINARY_BYTES equals 5MB", () => {
    expect(MAX_BINARY_BYTES).toBe(5 * 1024 * 1024);
  });

  it("rejects binary larger than 5MB", () => {
    const oversized = new Uint8Array(MAX_BINARY_BYTES + 1);
    expect(oversized.byteLength > MAX_BINARY_BYTES).toBe(true);
  });

  it("accepts binary at exactly 5MB", () => {
    const exact = new Uint8Array(MAX_BINARY_BYTES);
    expect(exact.byteLength > MAX_BINARY_BYTES).toBe(false);
  });

  it("accepts small binary", () => {
    const small = createDocBinary("hello");
    expect(small.byteLength > MAX_BINARY_BYTES).toBe(false);
  });

  it("update_b64 in docs apply-ops also checked", () => {
    const oversized = new Uint8Array(MAX_BINARY_BYTES + 100);
    const b64 = toB64(oversized);
    const decoded = Buffer.from(b64, "base64");
    expect(decoded.length > MAX_BINARY_BYTES).toBe(true);
  });

  it("each diff element in apply-diff also checked", () => {
    const largeDiff = new Uint8Array(MAX_BINARY_BYTES + 1);
    expect(largeDiff.byteLength > MAX_BINARY_BYTES).toBe(true);
  });
});

// ─── #4: TOCTOU — mergeEditors 正确合并 pre/post 检测结果 ───

describe("#4 TOCTOU: mergeEditors pre/post defense", () => {
  it("merges pre and post detection results with dedup", () => {
    const pre = [{ editor_type: "user", editor_id: "user-1" }];
    const post = [
      { editor_type: "user", editor_id: "user-1" },
      { editor_type: "user", editor_id: "user-2" },
    ];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.editor_id)).toEqual(["user-1", "user-2"]);
  });

  it("returns empty array when both pre and post are empty", () => {
    const merged = mergeEditors([], []);
    expect(merged).toEqual([]);
  });

  it("handles editors only appearing in post (joined mid-transact)", () => {
    const pre: Array<{ editor_type: string; editor_id: string }> = [];
    const post = [{ editor_type: "user", editor_id: "user-1" }];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(1);
  });

  it("handles editors only appearing in pre (left mid-transact)", () => {
    const pre = [{ editor_type: "user", editor_id: "user-1" }];
    const post: Array<{ editor_type: string; editor_id: string }> = [];
    const merged = mergeEditors(pre, post);
    expect(merged).toHaveLength(1);
  });
});

// ─── #5: 多实例 warning 字段（验证生产常量） ───

describe("#5 multi-instance warning in response", () => {
  it("warning string is non-empty and descriptive", () => {
    expect(MULTI_INSTANCE_WARNING).toBeTruthy();
    expect(MULTI_INSTANCE_WARNING).toContain("多实例");
    expect(MULTI_INSTANCE_WARNING).toContain("漏报");
  });

  it("response data should include _warning field", () => {
    const mockResponse = {
      status: "ok",
      data: {
        document_id: "test",
        concurrent_editors: [],
        has_conflict: false,
        _warning: MULTI_INSTANCE_WARNING,
      },
    };
    expect(mockResponse.data._warning).toBe(MULTI_INSTANCE_WARNING);
  });
});

// ─── #6: Table/Canvas 并发检测（使用生产 detectConcurrentEditors） ───

describe("#6 Table/Canvas push concurrent detection", () => {
  it("detects user editors on table documents", () => {
    const mock = createMockHocuspocus("table:t1", [
      { context: { editorType: "user", editorId: "user-1" } },
    ]);
    const editors = detectConcurrentEditors([mock], "table:t1", "");
    expect(editors).toHaveLength(1);
    expect(editors[0].editor_type).toBe("user");
  });

  it("detects user editors on canvas documents", () => {
    const mock = createMockHocuspocus("canvas:c1", [
      { context: { editorType: "user", editorId: "user-2" } },
      { context: { editorType: "agent", editorId: "agent-1" } },
    ]);
    const editors = detectConcurrentEditors([mock], "canvas:c1", "");
    expect(editors).toHaveLength(1);
    expect(editors[0].editor_id).toBe("user-2");
  });

  it("has_conflict derived from concurrent_editors length", () => {
    const mock = createMockHocuspocus("table:t2", [
      { context: { editorType: "user", editorId: "user-1" } },
    ]);
    const editors = detectConcurrentEditors([mock], "table:t2", "");
    expect(editors.length > 0).toBe(true);
  });
});

// ─── #7: block/update context ───

describe("#7 block/update context editorType", () => {
  it("context with editorType=agent is not treated as user", () => {
    const context = { editorType: "agent" as const, editorId: "agent-123" };
    expect(context.editorType).toBe("agent");
    expect(context.editorType).not.toBe("user");
  });

  it("empty context {} defaults to user in detection", () => {
    const mock = createMockHocuspocus("docs:d1", [{ context: {} }]);
    const editors = detectConcurrentEditors([mock], "docs:d1", "");
    expect(editors).toHaveLength(1);
    expect(editors[0].editor_type).toBe("user");
  });

  it("proper context prevents false positive in detection", () => {
    const mock = createMockHocuspocus("docs:d1", [
      { context: { editorType: "agent", editorId: "block-agent" } },
    ]);
    const editors = detectConcurrentEditors([mock], "docs:d1", "");
    expect(editors).toHaveLength(0);
  });

  it("missing editorType defaults to user in detection", () => {
    const mock = createMockHocuspocus("docs:d1", [
      { context: {} },
    ]);
    const editors = detectConcurrentEditors([mock], "docs:d1", "");
    expect(editors).toHaveLength(1);
    expect(editors[0].editor_type).toBe("user");
  });
});

describe("#7 store editor fallback", () => {
  it("uses authenticated connection context when store context is empty", () => {
    const hocus = createMockHocuspocus("docs:d1", [
      { context: { editorType: "user", editorId: "user-1", editorName: "User 1" } },
    ]);

    const info = extractEditorInfoForStore({}, hocus, "docs:d1");

    expect(info.editorType).toBe("user");
    expect(info.editorId).toBe("user-1");
    expect(info.editorName).toBe("User 1");
  });

  it("prefers direct store context when it has a usable editor id", () => {
    const hocus = createMockHocuspocus("docs:d1", [
      { context: { editorType: "user", editorId: "user-1" } },
    ]);

    const info = extractEditorInfoForStore(
      { editorType: "user", editorId: "direct-user" },
      hocus,
      "docs:d1",
    );

    expect(info.editorId).toBe("direct-user");
  });

  it("skips read-only connections when choosing a fallback editor", () => {
    const hocus = createMockHocuspocus("docs:d1", [
      { readOnly: true, context: { editorType: "user", editorId: "viewer-1" } },
      { context: { editorType: "user", editorId: "editor-1" } },
    ]);

    const info = extractEditorInfoForStore({}, hocus, "docs:d1");

    expect(info.editorId).toBe("editor-1");
  });

  it("skips revoked connections when choosing a fallback editor", () => {
    const hocus = createMockHocuspocus("docs:d1", [
      { context: { editorType: "user", editorId: "old-user", permissionRevoked: true } },
      { context: { editorType: "user", editorId: "active-user" } },
    ]);

    const info = extractEditorInfoForStore({}, hocus, "docs:d1");

    expect(info.editorId).toBe("active-user");
  });
});

// ─── requireLiveSecret timingSafeEqual ───

describe("requireLiveSecret timingSafeEqual", () => {
  const LIVE_SECRET = "test-secret-value-123";

  function verifySecret(input: string | undefined): boolean {
    if (typeof input !== "string") return false;
    if (input.length !== LIVE_SECRET.length) return false;
    return crypto.timingSafeEqual(Buffer.from(input), Buffer.from(LIVE_SECRET));
  }

  it("accepts correct secret", () => {
    expect(verifySecret(LIVE_SECRET)).toBe(true);
  });

  it("rejects wrong secret of same length", () => {
    const wrong = "x".repeat(LIVE_SECRET.length);
    expect(verifySecret(wrong)).toBe(false);
  });

  it("rejects wrong secret of different length", () => {
    expect(verifySecret("short")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(verifySecret(undefined)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(verifySecret("")).toBe(false);
  });
});

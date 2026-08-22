/**
 * Agent 冲突检测逻辑测试
 *
 * 测试 detectConcurrentEditors 的逻辑：
 * - 无连接时返回空数组
 * - 有 user 连接时返回冲突
 * - agent 连接不计入冲突
 * - excludeEditorId 被排除
 */
import { describe, it, expect } from "vitest";
import {
  detectConcurrentEditors,
  type HocuspocusLike,
} from "../lib/collab-utils.js";

function createHocuspocusMock(
  docName: string,
  connections: Array<{ context: Record<string, unknown> }>,
): HocuspocusLike {
  const docs = new Map<
    string,
    { getConnections(): Array<{ context: Record<string, unknown> }> }
  >();
  docs.set(docName, { getConnections: () => connections });
  return { documents: docs };
}

describe("detectConcurrentEditors", () => {
  it("returns empty when no connections", () => {
    const hocus = createHocuspocusMock("doc-1", []);
    const result = detectConcurrentEditors([hocus], "doc-1", "");
    expect(result).toEqual([]);
  });

  it("returns empty when document not found", () => {
    const hocus = createHocuspocusMock("other-doc", []);
    const result = detectConcurrentEditors([hocus], "doc-1", "");
    expect(result).toEqual([]);
  });

  it("detects user editors", () => {
    const hocus = createHocuspocusMock("doc-1", [
      { context: { editorType: "user", editorId: "user-1" } },
      { context: { editorType: "user", editorId: "user-2" } },
    ]);
    const result = detectConcurrentEditors([hocus], "doc-1", "");
    expect(result).toHaveLength(2);
    expect(result[0].editor_type).toBe("user");
    expect(result[0].editor_id).toBe("user-1");
  });

  it("excludes agent connections", () => {
    const hocus = createHocuspocusMock("doc-1", [
      { context: { editorType: "agent", editorId: "agent-001" } },
      { context: { editorType: "user", editorId: "user-1" } },
    ]);
    const result = detectConcurrentEditors([hocus], "doc-1", "");
    expect(result).toHaveLength(1);
    expect(result[0].editor_id).toBe("user-1");
  });

  it("excludes self by editorId", () => {
    const hocus = createHocuspocusMock("doc-1", [
      { context: { editorType: "user", editorId: "user-self" } },
      { context: { editorType: "user", editorId: "user-other" } },
    ]);
    const result = detectConcurrentEditors([hocus], "doc-1", "user-self");
    expect(result).toHaveLength(1);
    expect(result[0].editor_id).toBe("user-other");
  });

  it("aggregates across multiple hocuspocus instances", () => {
    const h1 = createHocuspocusMock("doc-1", [
      { context: { editorType: "user", editorId: "user-1" } },
    ]);
    const h2 = createHocuspocusMock("doc-1", [
      { context: { editorType: "user", editorId: "user-2" } },
    ]);
    const result = detectConcurrentEditors([h1, h2, null], "doc-1", "");
    expect(result).toHaveLength(2);
  });

  it("treats missing context as user", () => {
    const hocus = createHocuspocusMock("doc-1", [
      { context: {} },
    ]);
    const result = detectConcurrentEditors([hocus], "doc-1", "");
    expect(result).toHaveLength(1);
    expect(result[0].editor_type).toBe("user");
    expect(result[0].editor_id).toBe("");
  });

  it("has_conflict = concurrent_editors.length > 0", () => {
    const hocus = createHocuspocusMock("doc-1", [
      { context: { editorType: "user", editorId: "user-1" } },
    ]);
    const editors = detectConcurrentEditors([hocus], "doc-1", "");
    const hasConflict = editors.length > 0;
    expect(hasConflict).toBe(true);
  });
});

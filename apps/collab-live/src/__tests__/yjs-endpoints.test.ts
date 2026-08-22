/**
 * Y.js Diff/Merge 端点逻辑测试
 *
 * 直接测试 Y.js 操作（compute-diff / apply-diff 的核心逻辑），
 * 不需要启动 Express server。
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";

function createDocWithText(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function computeDiff(
  oldBinary: Uint8Array,
  newBinary: Uint8Array
): { diff: Uint8Array; diffSize: number } {
  const oldDoc = new Y.Doc();
  Y.applyUpdate(oldDoc, oldBinary);
  const stateVector = Y.encodeStateVector(oldDoc);

  const newDoc = new Y.Doc();
  Y.applyUpdate(newDoc, newBinary);
  const diff = Y.encodeStateAsUpdate(newDoc, stateVector);

  oldDoc.destroy();
  newDoc.destroy();

  return { diff, diffSize: diff.byteLength };
}

function applyDiffs(
  baseBinary: Uint8Array,
  diffs: Uint8Array[]
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseBinary);

  for (const diff of diffs) {
    Y.applyUpdate(doc, diff);
  }

  const merged = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return merged;
}

function readText(binary: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, binary);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

describe("Y.js compute-diff logic", () => {
  it("computes diff between two states", () => {
    const old = createDocWithText("Hello");

    const editDoc = new Y.Doc();
    Y.applyUpdate(editDoc, old);
    editDoc.getText("content").insert(5, " World");
    const next = Y.encodeStateAsUpdate(editDoc);
    editDoc.destroy();

    const { diff, diffSize } = computeDiff(old, next);
    expect(diffSize).toBeGreaterThan(0);
    expect(diffSize).toBeLessThan(next.byteLength);
  });

  it("returns minimal diff when no change", () => {
    const state = createDocWithText("Unchanged");
    const { diff, diffSize } = computeDiff(state, state);
    expect(diffSize).toBeLessThanOrEqual(4);
  });

  it("handles empty old document", () => {
    const emptyDoc = new Y.Doc();
    const emptyState = Y.encodeStateAsUpdate(emptyDoc);
    emptyDoc.destroy();

    const next = createDocWithText("Brand new content");
    const { diff, diffSize } = computeDiff(emptyState, next);
    expect(diffSize).toBeGreaterThan(0);
  });
});

describe("Y.js apply-diff logic", () => {
  it("merges single diff correctly", () => {
    const base = createDocWithText("Hello");

    const newDoc = new Y.Doc();
    Y.applyUpdate(newDoc, base);
    newDoc.getText("content").insert(5, " World");
    const newState = Y.encodeStateAsUpdate(newDoc);
    newDoc.destroy();

    const { diff } = computeDiff(base, newState);
    const merged = applyDiffs(base, [diff]);

    expect(readText(merged)).toBe("Hello World");
  });

  it("applies multiple diffs sequentially", () => {
    const v1 = createDocWithText("A");

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, v1);
    doc2.getText("content").insert(1, "B");
    const v2 = Y.encodeStateAsUpdate(doc2);
    doc2.destroy();

    const doc3 = new Y.Doc();
    Y.applyUpdate(doc3, v2);
    doc3.getText("content").insert(2, "C");
    const v3 = Y.encodeStateAsUpdate(doc3);
    doc3.destroy();

    const diff1 = computeDiff(v1, v2).diff;
    const diff2 = computeDiff(v2, v3).diff;

    const merged = applyDiffs(v1, [diff1, diff2]);
    expect(readText(merged)).toBe("ABC");
  });

  it("handles empty diffs array", () => {
    const base = createDocWithText("Untouched");
    const merged = applyDiffs(base, []);
    expect(readText(merged)).toBe("Untouched");
  });
});

describe("B64 round-trip (simulating HTTP endpoints)", () => {
  it("compute-diff + apply-diff round-trip preserves content", () => {
    const base = createDocWithText("Original text");

    const editDoc = new Y.Doc();
    Y.applyUpdate(editDoc, base);
    editDoc.getText("content").delete(0, 8);
    editDoc.getText("content").insert(0, "Modified");
    const edited = Y.encodeStateAsUpdate(editDoc);
    editDoc.destroy();

    const oldB64 = Buffer.from(base).toString("base64");
    const newB64 = Buffer.from(edited).toString("base64");

    const oldBinary = new Uint8Array(Buffer.from(oldB64, "base64"));
    const newBinary = new Uint8Array(Buffer.from(newB64, "base64"));

    const { diff } = computeDiff(oldBinary, newBinary);
    const diffB64 = Buffer.from(diff).toString("base64");

    const baseBinary = new Uint8Array(Buffer.from(oldB64, "base64"));
    const diffFromB64 = new Uint8Array(Buffer.from(diffB64, "base64"));

    const merged = applyDiffs(baseBinary, [diffFromB64]);
    expect(readText(merged)).toBe("Modified text");
  });
});

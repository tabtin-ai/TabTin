import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../extensions/metrics.js", () => ({
  metrics: {
    storeErrors: 0,
    recordStoreLatency: vi.fn(),
  },
}));

vi.mock("../extensions/force-close.js", () => ({
  forceCloseDocument: vi.fn().mockResolvedValue({
    loaded: true,
    connections_closed: 1,
  }),
  ForceCloseReason: {
    DOCUMENT_TOO_LARGE: "document_too_large",
  },
  CloseCode: {
    DOCUMENT_TOO_LARGE: 4003,
  },
}));

import { parseResourceId, extractEditorInfo, handleStoreError } from "./collab-utils.js";
import { deepEqual } from "./deep-equal.js";
import { metrics } from "../extensions/metrics.js";
import { forceCloseDocument } from "../extensions/force-close.js";
import * as Y from "yjs";

// ────────────────────────────────────────────
// parseResourceId
// ────────────────────────────────────────────
describe("parseResourceId", () => {
  it("extracts ID with matching prefix", () => {
    expect(parseResourceId("docs:abc-123", "docs:")).toBe("abc-123");
  });

  it("extracts ID for table prefix", () => {
    expect(parseResourceId("table:tbl-456", "table:")).toBe("tbl-456");
  });

  it("returns null for non-matching prefix", () => {
    expect(parseResourceId("docs:abc-123", "table:")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseResourceId("", "docs:")).toBeNull();
  });

  it("returns empty string when document name equals prefix exactly", () => {
    expect(parseResourceId("docs:", "docs:")).toBe("");
  });
});

// ────────────────────────────────────────────
// extractEditorInfo
// ────────────────────────────────────────────
describe("extractEditorInfo", () => {
  it("extracts editorType and editorId from full context", () => {
    const ctx = { editorType: "agent", editorId: "agent-1", userId: "u-1" };
    expect(extractEditorInfo(ctx)).toEqual({ editorType: "agent", editorId: "agent-1", editorName: "", agentRunId: "", systemPolicy: "" });
  });

  it("falls back to userId when editorId is missing", () => {
    const ctx = { editorType: "user", userId: "u-42" };
    expect(extractEditorInfo(ctx)).toEqual({ editorType: "user", editorId: "u-42", editorName: "", agentRunId: "", systemPolicy: "" });
  });

  it("normalizes legacy 'human' to 'user' for Django CO-4 compatibility", () => {
    const ctx = { editorType: "human", userId: "u-42" };
    expect(extractEditorInfo(ctx)).toEqual({ editorType: "user", editorId: "u-42", editorName: "", agentRunId: "", systemPolicy: "" });
  });

  it("returns defaults for null context", () => {
    expect(extractEditorInfo(null)).toEqual({ editorType: "user", editorId: "", editorName: "", agentRunId: "", systemPolicy: "" });
  });

  it("returns defaults for undefined context", () => {
    expect(extractEditorInfo(undefined)).toEqual({ editorType: "user", editorId: "", editorName: "", agentRunId: "", systemPolicy: "" });
  });

  it("returns defaults for empty object context", () => {
    expect(extractEditorInfo({})).toEqual({ editorType: "user", editorId: "", editorName: "", agentRunId: "", systemPolicy: "" });
  });

  it("extracts agentRunId from context", () => {
    const ctx = { editorType: "agent", editorId: "agent-1", agentRunId: "run-abc-123" };
    expect(extractEditorInfo(ctx)).toEqual({ editorType: "agent", editorId: "agent-1", editorName: "", agentRunId: "run-abc-123", systemPolicy: "" });
  });
});

// ────────────────────────────────────────────
// handleStoreError
// ────────────────────────────────────────────
describe("handleStoreError", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (metrics as any).storeErrors = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseParams = {
    resourceId: "res-1",
    documentName: "docs:res-1",
    moduleLabel: "TestDB",
    startTime: Date.now() - 100,
  };

  it("re-throws non-413 errors and increments metrics", async () => {
    const error = new Error("Connection refused");
    await expect(
      handleStoreError({ ...baseParams, error, instance: null }),
    ).rejects.toThrow("Connection refused");

    expect(metrics.storeErrors).toBe(1);
    expect(metrics.recordStoreLatency).toHaveBeenCalled();
  });

  it("throws 413 errors and schedules forceClose after the current store settles", async () => {
    const error = new Error("Django API error 413: Payload Too Large");
    const fakeInstance = { documents: new Map() } as any;

    await expect(
      handleStoreError({ ...baseParams, error, instance: fakeInstance }),
    ).rejects.toThrow("413");

    expect(forceCloseDocument).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(forceCloseDocument).toHaveBeenCalledWith(
      fakeInstance,
      "docs:res-1",
      "document_too_large",
      4003,
    );
    expect(metrics.storeErrors).toBe(1);
  });

  it("throws 413 errors without calling forceClose when instance is null", async () => {
    const error = new Error("Django API error 413: Payload Too Large");

    await expect(
      handleStoreError({ ...baseParams, error, instance: null }),
    ).rejects.toThrow("413");

    expect(forceCloseDocument).not.toHaveBeenCalled();
    expect(metrics.storeErrors).toBe(1);
  });

  it("records store latency on error", async () => {
    const error = new Error("timeout");
    try {
      await handleStoreError({ ...baseParams, error, instance: null });
    } catch {
      // expected
    }
    expect(metrics.recordStoreLatency).toHaveBeenCalledWith(expect.any(Number));
  });
});

// ────────────────────────────────────────────
// deepEqual  (CI-021 回归测试)
// ────────────────────────────────────────────
describe("deepEqual", () => {
  // --- 基本原始值 ---
  it("returns true for identical primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("abc", "abc")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(0, 0)).toBe(true);
    expect(deepEqual("", "")).toBe(true);
  });

  it("returns false for different primitives of same type", () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
  });

  it("returns false for different types", () => {
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(0, false)).toBe(false);
    expect(deepEqual(0, null)).toBe(false);
    expect(deepEqual("", null)).toBe(false);
  });

  // --- CI-002: NaN 判等 ---
  describe("NaN handling (CI-002)", () => {
    it("treats NaN as equal to NaN", () => {
      expect(deepEqual(NaN, NaN)).toBe(true);
    });

    it("treats NaN as not equal to a number", () => {
      expect(deepEqual(NaN, 0)).toBe(false);
      expect(deepEqual(0, NaN)).toBe(false);
      expect(deepEqual(NaN, Infinity)).toBe(false);
    });

    it("treats nested NaN values as equal", () => {
      expect(deepEqual({ x: NaN }, { x: NaN })).toBe(true);
      expect(deepEqual([NaN, 1], [NaN, 1])).toBe(true);
    });

    it("detects NaN vs number in nested objects", () => {
      expect(deepEqual({ x: NaN }, { x: 0 })).toBe(false);
      expect(deepEqual([NaN], [0])).toBe(false);
    });

    it("handles NaN in deeply nested structures", () => {
      expect(deepEqual({ a: { b: [NaN] } }, { a: { b: [NaN] } })).toBe(true);
      expect(deepEqual({ a: { b: [NaN] } }, { a: { b: [1] } })).toBe(false);
    });
  });

  // --- CI-003: undefined 键不对称 ---
  describe("undefined key asymmetry (CI-003)", () => {
    it("treats { a: undefined } as equal to {}", () => {
      expect(deepEqual({ a: undefined }, {})).toBe(true);
    });

    it("treats {} as equal to { a: undefined }", () => {
      expect(deepEqual({}, { a: undefined })).toBe(true);
    });

    it("treats { a: 1, b: undefined } as equal to { a: 1 }", () => {
      expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    });

    it("treats both sides having undefined keys as equal", () => {
      expect(
        deepEqual({ a: 1, b: undefined }, { a: 1, c: undefined }),
      ).toBe(true);
    });

    it("does not treat { a: undefined } as equal to { a: null }", () => {
      expect(deepEqual({ a: undefined }, { a: null })).toBe(false);
    });

    it("treats nested undefined keys as equivalent", () => {
      expect(deepEqual({ nested: { x: undefined } }, { nested: {} })).toBe(
        true,
      );
    });

    it("distinguishes undefined value from missing key with other defined keys", () => {
      expect(deepEqual({ a: 1, b: undefined }, { a: 1, b: 2 })).toBe(false);
    });
  });

  // --- CI-004: Date 对象比较 ---
  describe("Date comparison (CI-004)", () => {
    it("treats same-time Date objects as equal", () => {
      const t = 1700000000000;
      expect(deepEqual(new Date(t), new Date(t))).toBe(true);
    });

    it("treats different-time Date objects as not equal", () => {
      expect(deepEqual(new Date(1000), new Date(2000))).toBe(false);
    });

    it("treats Date vs plain object as not equal", () => {
      expect(deepEqual(new Date(1000), {})).toBe(false);
      expect(deepEqual({}, new Date(1000))).toBe(false);
    });

    it("treats Date vs number as not equal (cross-type)", () => {
      expect(deepEqual(new Date(1000), 1000)).toBe(false);
    });

    it("compares Date objects nested in objects", () => {
      const t = 1700000000000;
      expect(deepEqual({ d: new Date(t) }, { d: new Date(t) })).toBe(true);
      expect(deepEqual({ d: new Date(1000) }, { d: new Date(2000) })).toBe(
        false,
      );
    });

    it("same Date reference returns true", () => {
      const d = new Date();
      expect(deepEqual(d, d)).toBe(true);
    });
  });

  // --- 数组 ---
  describe("arrays", () => {
    it("compares arrays element-by-element", () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(deepEqual([], [])).toBe(true);
    });

    it("returns false for array vs non-array object", () => {
      expect(deepEqual([1], { 0: 1, length: 1 })).toBe(false);
    });

    it("compares nested arrays", () => {
      expect(deepEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
      expect(deepEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
    });
  });

  // --- 普通对象 ---
  describe("plain objects", () => {
    it("compares plain objects recursively", () => {
      expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
      expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    });

    it("detects extra keys in second object", () => {
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it("detects extra keys in first object", () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });

    it("handles empty objects", () => {
      expect(deepEqual({}, {})).toBe(true);
    });
  });

  // --- Y.js CRDT 类型 ---
  describe("Y.js types", () => {
    it("returns false for different Y.Map instances", () => {
      const m1 = new Y.Map();
      const m2 = new Y.Map();
      expect(deepEqual(m1, m2)).toBe(false);
    });

    it("returns true for same Y.Map reference (identity)", () => {
      const m1 = new Y.Map();
      expect(deepEqual(m1, m1)).toBe(true);
    });

    it("returns false for different Y.Array instances", () => {
      const a1 = new Y.Array();
      const a2 = new Y.Array();
      expect(deepEqual(a1, a2)).toBe(false);
    });

    it("returns true for same Y.Array reference (identity)", () => {
      const a1 = new Y.Array();
      expect(deepEqual(a1, a1)).toBe(true);
    });
  });

  // --- 综合边界场景 ---
  describe("combined edge cases", () => {
    it("handles object with NaN, undefined keys, and Date together", () => {
      const t = 1700000000000;
      const a = { x: NaN, y: undefined, d: new Date(t), arr: [1, 2] };
      const b = { x: NaN, d: new Date(t), arr: [1, 2] };
      expect(deepEqual(a, b)).toBe(true);
    });

    it("null vs object returns false", () => {
      expect(deepEqual(null, {})).toBe(false);
      expect(deepEqual({}, null)).toBe(false);
    });

    it("undefined vs object returns false", () => {
      expect(deepEqual(undefined, {})).toBe(false);
      expect(deepEqual({}, undefined)).toBe(false);
    });
  });
});

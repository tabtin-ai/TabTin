/**
 * CC-002 回归测试 — 离线回放数据安全
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOfflineReplay } from "./useOfflineReplay";
import type { MutableRefObject } from "react";
import * as Y from "yjs";

function createMutableRef<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

describe("CC-002: useOfflineReplay data safety", () => {
  let ydoc: Y.Doc;

  beforeEach(() => {
    ydoc = new Y.Doc();
  });

  it("should preserve pending ops when replay throws an error", () => {
    const ops = [{ op: "insert", data: "hello" }, { op: "insert", data: "world" }];
    const pendingRef = createMutableRef([...ops]);
    const failingReplay = vi.fn(() => {
      throw new Error("Y.Doc apply failed");
    });

    const { rerender } = renderHook(
      ({ isOnline }) =>
        useOfflineReplay({
          isOnline,
          ydoc,
          pendingRef,
          replay: failingReplay,
        }),
      { initialProps: { isOnline: false } },
    );

    rerender({ isOnline: true });

    expect(failingReplay).toHaveBeenCalledTimes(1);
    expect(pendingRef.current).toHaveLength(2);
    expect(pendingRef.current).toEqual(ops);
  });

  it("should clear pending ops after successful replay", () => {
    const ops = [{ op: "insert", data: "hello" }];
    const pendingRef = createMutableRef([...ops]);
    const successReplay = vi.fn();

    const { rerender } = renderHook(
      ({ isOnline }) =>
        useOfflineReplay({
          isOnline,
          ydoc,
          pendingRef,
          replay: successReplay,
        }),
      { initialProps: { isOnline: false } },
    );

    rerender({ isOnline: true });

    expect(successReplay).toHaveBeenCalledTimes(1);
    expect(pendingRef.current).toHaveLength(0);
  });

  it("should pass a snapshot copy to replay, not the original array", () => {
    const pendingRef = createMutableRef([{ op: "a" }, { op: "b" }]);
    let receivedOps: any[] = [];
    const replay = vi.fn((_, ops) => {
      receivedOps = ops;
      ops.push({ op: "injected" });
    });

    const { rerender } = renderHook(
      ({ isOnline }) =>
        useOfflineReplay({
          isOnline,
          ydoc,
          pendingRef,
          replay,
        }),
      { initialProps: { isOnline: false } },
    );

    rerender({ isOnline: true });

    expect(receivedOps).toHaveLength(3);
    expect(pendingRef.current).toHaveLength(0);
  });

  it("should not replay when transitioning online→online", () => {
    const pendingRef = createMutableRef([{ op: "a" }]);
    const replay = vi.fn();

    const { rerender } = renderHook(
      ({ isOnline }) =>
        useOfflineReplay({
          isOnline,
          ydoc,
          pendingRef,
          replay,
        }),
      { initialProps: { isOnline: true } },
    );

    rerender({ isOnline: true });

    expect(replay).not.toHaveBeenCalled();
  });
});

/**
 * CC-006 回归测试：useCollabProvider 第二个 useEffect 依赖项稳定性
 *
 * 验证 inline 传入 options 对象时，visibilitychange/online/focus 监听器
 * 不会因引用变化而被反复移除/注册。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    disconnect = vi.fn();
    destroy = vi.fn();
    connect = vi.fn();
    setAwarenessField = vi.fn();
    sendStateless = vi.fn();
    constructor() {}
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

vi.mock("y-indexeddb", () => {
  class MockIndexeddbPersistence {
    on = vi.fn();
    destroy = vi.fn();
    whenSynced = Promise.resolve();
    constructor() {}
  }
  return { IndexeddbPersistence: MockIndexeddbPersistence };
});

import { useCollabProvider } from "../useCollabProvider.js";
import type { CollabProviderOptions } from "../types.js";

const BASE_OPTIONS: CollabProviderOptions = {
  serverUrl: "ws://localhost:4100",
  documentName: "test-doc",
  token: "test-token",
  user: { id: "u1", name: "Tester", color: "#FF5733" },
  enableIndexedDB: false,
};

describe("CC-006: useEffect 依赖项稳定性", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addSpy = vi.spyOn(document, "addEventListener");
    removeSpy = vi.spyOn(document, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("re-render 时 options 引用变化但值不变，不重新注册监听器", () => {
    const { rerender } = renderHook(
      (props: { opts: CollabProviderOptions }) => useCollabProvider(props.opts),
      { initialProps: { opts: { ...BASE_OPTIONS } } }
    );

    const addCountAfterMount = addSpy.mock.calls.filter(
      ([event]: [string]) => event === "visibilitychange"
    ).length;

    // 用新引用但相同值重新渲染 5 次
    for (let i = 0; i < 5; i++) {
      rerender({ opts: { ...BASE_OPTIONS } });
    }

    const addCountAfterRerenders = addSpy.mock.calls.filter(
      ([event]: [string]) => event === "visibilitychange"
    ).length;

    // visibilitychange 监听器不应因引用变化而增加
    expect(addCountAfterRerenders).toBe(addCountAfterMount);
  });

  it("options 从 null 变为非 null 时注册监听器", () => {
    const { rerender } = renderHook(
      (props: { opts: CollabProviderOptions | null }) => useCollabProvider(props.opts),
      { initialProps: { opts: null as CollabProviderOptions | null } }
    );

    const addCountBeforeEnable = addSpy.mock.calls.filter(
      ([event]: [string]) => event === "visibilitychange"
    ).length;

    rerender({ opts: { ...BASE_OPTIONS } });

    const addCountAfterEnable = addSpy.mock.calls.filter(
      ([event]: [string]) => event === "visibilitychange"
    ).length;

    expect(addCountAfterEnable).toBeGreaterThan(addCountBeforeEnable);
  });
});

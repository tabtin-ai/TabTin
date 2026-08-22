/**
 * CC-011 ~ CC-015 回归测试
 *
 * CC-011: handler ref 防止闭包过期
 * CC-012: sendEvent 离线时拒绝并警告
 * CC-013: onEvent key 变化时重新订阅
 * CC-014: fingerprint 排除 cursor 坐标
 * CC-015: CollabAvatars 使用 clientId 作为 key
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, render } from "@testing-library/react";
import React from "react";

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: vi.fn(),
}));
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: vi.fn(),
}));

import { useStatelessEvents } from "../useStatelessEvents";
import { CollabProvider } from "../provider";
import { CollabAvatars } from "../components/CollabAvatars";
import { CollabStatus } from "../types";
import type { CollabPeerState, StatelessEvent } from "../types";

// ── 辅助：创建 useStatelessEvents 用的 mock provider ──

function createMockProvider(status = CollabStatus.SYNCED) {
  const typedListeners = new Map<string, Set<(e: StatelessEvent) => void>>();
  const anyListeners = new Set<(e: StatelessEvent) => void>();

  const mock = {
    getState: vi.fn(() => ({ status })),
    sendStateless: vi.fn(),
    onStatelessEvent: vi.fn(
      (type: string, cb: (e: StatelessEvent) => void) => {
        if (!typedListeners.has(type)) typedListeners.set(type, new Set());
        typedListeners.get(type)!.add(cb);
        return () => {
          typedListeners.get(type)?.delete(cb);
        };
      }
    ),
    onAnyStatelessEvent: vi.fn((cb: (e: StatelessEvent) => void) => {
      anyListeners.add(cb);
      return () => {
        anyListeners.delete(cb);
      };
    }),
    _emit(event: StatelessEvent) {
      typedListeners.get(event.type)?.forEach((cb) => cb(event));
      anyListeners.forEach((cb) => cb(event));
    },
    _typedListeners: typedListeners,
    _anyListeners: anyListeners,
  };

  return mock as unknown as CollabProvider & typeof mock;
}

// ═══════════════════════════════════════════════════════════════
// CC-011
// ═══════════════════════════════════════════════════════════════

describe("CC-011: handler ref prevents stale closure", () => {
  it("calls the latest handler after re-render, not the stale one", () => {
    const provider = createMockProvider();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const { rerender } = renderHook(
      ({ onEvent }) => useStatelessEvents(provider, { onEvent }),
      { initialProps: { onEvent: { "test.event": handler1 } } }
    );

    rerender({ onEvent: { "test.event": handler2 } });

    const event: StatelessEvent = { type: "test.event", payload: { x: 1 } };
    act(() => {
      (provider as any)._emit(event);
    });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledWith(event);
  });

  it("calls the latest onAnyEvent handler after re-render", () => {
    const provider = createMockProvider();
    const any1 = vi.fn();
    const any2 = vi.fn();

    const { rerender } = renderHook(
      ({ onAnyEvent }) => useStatelessEvents(provider, { onAnyEvent }),
      { initialProps: { onAnyEvent: any1 } }
    );

    rerender({ onAnyEvent: any2 });

    const event: StatelessEvent = { type: "foo", payload: {} };
    act(() => {
      (provider as any)._emit(event);
    });

    expect(any1).not.toHaveBeenCalled();
    expect(any2).toHaveBeenCalledWith(event);
  });
});

// ═══════════════════════════════════════════════════════════════
// CC-012
// ═══════════════════════════════════════════════════════════════

describe("CC-012: sendEvent rejects when offline", () => {
  it("warns and does not send when status is DISCONNECTED", () => {
    const provider = createMockProvider(CollabStatus.DISCONNECTED);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useStatelessEvents(provider));
    act(() => {
      result.current.sendEvent({ type: "test", payload: {} });
    });

    expect(provider.sendStateless).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot send event while offline")
    );
    warnSpy.mockRestore();
  });

  it("warns and does not send when status is INITIAL", () => {
    const provider = createMockProvider(CollabStatus.INITIAL);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useStatelessEvents(provider));
    act(() => {
      result.current.sendEvent({ type: "test", payload: {} });
    });

    expect(provider.sendStateless).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("sends normally when status is SYNCED", () => {
    const provider = createMockProvider(CollabStatus.SYNCED);

    const { result } = renderHook(() => useStatelessEvents(provider));
    act(() => {
      result.current.sendEvent({ type: "test", payload: { v: 1 } });
    });

    expect(provider.sendStateless).toHaveBeenCalledWith(
      expect.objectContaining({ type: "test", payload: { v: 1 } })
    );
  });

  it("sends normally when status is SYNCING", () => {
    const provider = createMockProvider(CollabStatus.SYNCING);

    const { result } = renderHook(() => useStatelessEvents(provider));
    act(() => {
      result.current.sendEvent({ type: "test", payload: {} });
    });

    expect(provider.sendStateless).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// CC-013
// ═══════════════════════════════════════════════════════════════

describe("CC-013: re-subscribes when event type keys change", () => {
  it("subscribes to newly added event types", () => {
    const provider = createMockProvider();

    const { rerender } = renderHook(
      ({ onEvent }) => useStatelessEvents(provider, { onEvent }),
      { initialProps: { onEvent: { "type.a": vi.fn() } } }
    );

    expect(provider.onStatelessEvent).toHaveBeenCalledTimes(1);
    expect(provider.onStatelessEvent).toHaveBeenCalledWith(
      "type.a",
      expect.any(Function)
    );

    rerender({
      onEvent: { "type.a": vi.fn(), "type.b": vi.fn() },
    });

    // 旧订阅被 cleanup，新的 2 个订阅被创建
    expect(provider.onStatelessEvent).toHaveBeenCalledTimes(3);
    expect(provider.onStatelessEvent).toHaveBeenCalledWith(
      "type.b",
      expect.any(Function)
    );
  });

  it("does not re-subscribe when handlers change but types stay same", () => {
    const provider = createMockProvider();

    const { rerender } = renderHook(
      ({ onEvent }) => useStatelessEvents(provider, { onEvent }),
      { initialProps: { onEvent: { "type.a": vi.fn() } } }
    );

    expect(provider.onStatelessEvent).toHaveBeenCalledTimes(1);

    rerender({ onEvent: { "type.a": vi.fn() } });

    // key 列表不变，不应重新订阅
    expect(provider.onStatelessEvent).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// CC-014
// ═══════════════════════════════════════════════════════════════

describe("CC-014: fingerprint excludes cursor coordinates", () => {
  function createRealProvider() {
    return new CollabProvider({
      serverUrl: "ws://test",
      documentName: "test",
      token: "test",
      user: { id: "u1", name: "Test", color: "#000" },
      enableIndexedDB: false,
    });
  }

  it("produces identical fingerprint when only cursor differs", () => {
    const provider = createRealProvider();

    const peers1: CollabPeerState[] = [
      {
        user: { id: "u1", name: "Alice", color: "#f00" },
        clientId: 1,
        cursor: { x: 0, y: 0 },
        playhead: { time: 0 },
        selectedNodes: ["n1"],
      },
    ];
    const peers2: CollabPeerState[] = [
      {
        user: { id: "u1", name: "Alice", color: "#f00" },
        clientId: 1,
        cursor: { x: 999, y: 999 },
        playhead: { time: 42 },
        selectedNodes: ["n1"],
      },
    ];

    const fp1 = (provider as any).computePeersFingerprint(peers1);
    const fp2 = (provider as any).computePeersFingerprint(peers2);
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprint when selection changes", () => {
    const provider = createRealProvider();

    const peers1: CollabPeerState[] = [
      {
        user: { id: "u1", name: "Alice", color: "#f00" },
        selectedNodes: ["n1"],
      },
    ];
    const peers2: CollabPeerState[] = [
      {
        user: { id: "u1", name: "Alice", color: "#f00" },
        selectedNodes: ["n1", "n2"],
      },
    ];

    const fp1 = (provider as any).computePeersFingerprint(peers1);
    const fp2 = (provider as any).computePeersFingerprint(peers2);
    expect(fp1).not.toBe(fp2);
  });

  it("produces different fingerprint when user info changes", () => {
    const provider = createRealProvider();

    const peers1: CollabPeerState[] = [
      { user: { id: "u1", name: "Alice", color: "#f00" } },
    ];
    const peers2: CollabPeerState[] = [
      { user: { id: "u1", name: "Alice (updated)", color: "#f00" } },
    ];

    const fp1 = (provider as any).computePeersFingerprint(peers1);
    const fp2 = (provider as any).computePeersFingerprint(peers2);
    expect(fp1).not.toBe(fp2);
  });
});

// ═══════════════════════════════════════════════════════════════
// CC-015
// ═══════════════════════════════════════════════════════════════

describe("CC-015: CollabAvatars uses clientId as key", () => {
  it("renders multiple peers with same user.id but different clientId", () => {
    const peers: CollabPeerState[] = [
      { user: { id: "u1", name: "Alice", color: "#f00" }, clientId: 100 },
      { user: { id: "u1", name: "Alice", color: "#f00" }, clientId: 200 },
      { user: { id: "u2", name: "Bob", color: "#0f0" }, clientId: 300 },
    ];

    const { container } = render(<CollabAvatars peers={peers} />);
    const avatars = container.querySelectorAll("[title]");
    expect(avatars).toHaveLength(3);
  });

  it("does not emit duplicate key warnings for multi-tab same user", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const peers: CollabPeerState[] = [
      { user: { id: "u1", name: "Alice", color: "#f00" }, clientId: 100 },
      { user: { id: "u1", name: "Alice", color: "#f00" }, clientId: 200 },
    ];

    render(<CollabAvatars peers={peers} />);

    const keyWarnings = errorSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].toLowerCase().includes("key")
    );
    expect(keyWarnings).toHaveLength(0);

    errorSpy.mockRestore();
  });

  it("falls back to user.id+index when clientId is absent", () => {
    const peers: CollabPeerState[] = [
      { user: { id: "u1", name: "Alice", color: "#f00" } },
      { user: { id: "u2", name: "Bob", color: "#0f0" } },
    ];

    const { container } = render(<CollabAvatars peers={peers} />);
    const avatars = container.querySelectorAll("[title]");
    expect(avatars).toHaveLength(2);
  });

  it("falls back to initials when avatar image fails to load", () => {
    const peers: CollabPeerState[] = [
      {
        user: {
          id: "u1",
          name: "Alice",
          color: "#f00",
          avatar: "https://example.com/broken.png",
        },
        clientId: 100,
      },
    ];

    const { container } = render(<CollabAvatars peers={peers} />);
    const image = container.querySelector("img");
    expect(image).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event("error", { bubbles: true }));
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("A");
  });

  it("does not render img for unresolved relative avatar keys", () => {
    const peers: CollabPeerState[] = [
      {
        user: {
          id: "u1",
          name: "Alice",
          color: "#f00",
          avatar: "junk-relative.png",
        },
        clientId: 100,
      },
    ];

    const { container } = render(<CollabAvatars peers={peers} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("A");
  });
});


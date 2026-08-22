/**
 * CC-014 回归测试 — subscribeAwareness 绕过 fingerprint 节流
 *
 * 验证：cursor 坐标变化时，subscribeAwareness 订阅者仍能收到更新，
 * 即使 computePeersFingerprint 排除了 cursor/playhead/lastActive。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@hocuspocus/provider", () => {
  class MockHocuspocusProvider {
    _opts: any;
    setAwarenessField = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    sendStateless = vi.fn();

    constructor(opts: any) {
      this._opts = opts;
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider };
});

vi.mock("y-indexeddb", () => {
  return {
    IndexeddbPersistence: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      whenSynced: Promise.resolve(),
    })),
  };
});

import { CollabProvider } from "../provider";

function createTestProvider() {
  return new CollabProvider({
    serverUrl: "ws://localhost:1234",
    documentName: "test-doc",
    token: "test-token",
    user: { id: "u1", name: "Test", color: "#ff0000" },
    enableIndexedDB: false,
  });
}

function getCallbacksFromProvider(collab: CollabProvider) {
  const hp = collab.getProvider() as any;
  return hp._opts;
}

function makeAwarenessStates(cursorX: number, cursorY: number) {
  return [
    {
      clientId: 999,
      user: { id: "u2", name: "Peer", color: "#00ff00" },
      cursor: { module: "tabwhiteboard", x: cursorX, y: cursorY, selectedNodes: [] },
    },
  ];
}

describe("CC-014: subscribeAwareness bypasses fingerprint throttle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should notify awareness subscribers on every cursor position change", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    const awarenessUpdates: any[] = [];
    collab.subscribeAwareness((peers) => {
      awarenessUpdates.push(peers.map((p) => ({ ...p })));
    });

    // First cursor position
    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(100, 200) });
    // Second cursor position (only x/y changed)
    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(150, 250) });
    // Third cursor position
    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(200, 300) });

    expect(awarenessUpdates).toHaveLength(3);
    expect(awarenessUpdates[0][0].cursor.x).toBe(100);
    expect(awarenessUpdates[1][0].cursor.x).toBe(150);
    expect(awarenessUpdates[2][0].cursor.x).toBe(200);
  });

  it("should NOT trigger state update (peers) when only cursor changes", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    const stateUpdates: any[] = [];
    collab.subscribe((state) => {
      stateUpdates.push(state.peers.map((p) => ({ ...p })));
    });

    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(100, 200) });
    const firstUpdateCount = stateUpdates.length;

    // Cursor-only changes should NOT trigger additional state updates
    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(150, 250) });
    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(200, 300) });

    expect(stateUpdates.length).toBe(firstUpdateCount);
  });

  it("should support unsubscribing from awareness updates", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    const updates: any[] = [];
    const unsub = collab.subscribeAwareness((peers) => {
      updates.push(peers);
    });

    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(100, 200) });
    expect(updates).toHaveLength(1);

    unsub();

    callbacks.onAwarenessUpdate({ states: makeAwarenessStates(200, 300) });
    expect(updates).toHaveLength(1);
  });

  it("should trigger state update when user identity changes (fingerprint-relevant)", () => {
    const collab = createTestProvider();
    collab.connect();
    const callbacks = getCallbacksFromProvider(collab);

    const stateUpdates: any[] = [];
    collab.subscribe((state) => {
      stateUpdates.push(state.peers);
    });

    callbacks.onAwarenessUpdate({
      states: [
        {
          clientId: 999,
          user: { id: "u2", name: "Alice", color: "#00ff00" },
          cursor: { module: "tabwhiteboard", x: 100, y: 200, selectedNodes: [] },
        },
      ],
    });
    const countAfterFirst = stateUpdates.length;

    // Name change → fingerprint changes → state update
    callbacks.onAwarenessUpdate({
      states: [
        {
          clientId: 999,
          user: { id: "u2", name: "Bob", color: "#00ff00" },
          cursor: { module: "tabwhiteboard", x: 100, y: 200, selectedNodes: [] },
        },
      ],
    });

    expect(stateUpdates.length).toBe(countAfterFirst + 1);
    expect(stateUpdates[stateUpdates.length - 1][0].user.name).toBe("Bob");
  });
});

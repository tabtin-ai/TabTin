import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionLimiter } from "./connection-limiter.js";

function connectedPayload({
  documentName,
  socketId,
  active = true,
}: {
  documentName: string;
  socketId: string;
  active?: boolean;
}) {
  const connectionInstance = {
    webSocket: {
      readyState: active ? 1 : 3,
    },
    document: {
      hasConnection: vi.fn(() => active),
    },
    close: vi.fn(),
  };

  return {
    payload: {
      documentName,
      socketId,
      connectionInstance,
    } as never,
    connectionInstance,
  };
}

describe("ConnectionLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a handshake reservation when authentication never establishes a connection", async () => {
    const limiter = new ConnectionLimiter(1);
    const documentName = "docs:failed-auth";

    await limiter.onConnect({ documentName, socketId: "failed-socket" } as never);

    await vi.advanceTimersByTimeAsync(15_001);

    await expect(
      limiter.onConnect({ documentName, socketId: "valid-socket" } as never),
    ).resolves.toBeUndefined();
  });

  it("keeps an established connection counted until it disconnects", async () => {
    const limiter = new ConnectionLimiter(1);
    const documentName = "docs:established-connection";

    await limiter.onConnect({ documentName, socketId: "active-socket" } as never);
    const activeConnection = connectedPayload({
      documentName,
      socketId: "active-socket",
    });
    await limiter.connected(activeConnection.payload);

    await vi.advanceTimersByTimeAsync(15_001);

    await expect(
      limiter.onConnect({ documentName, socketId: "blocked-socket" } as never),
    ).rejects.toThrow();

    await limiter.onDisconnect({ documentName, socketId: "active-socket" } as never);

    await expect(
      limiter.onConnect({ documentName, socketId: "replacement-socket" } as never),
    ).resolves.toBeUndefined();
  });

  it("rejects excess concurrent handshakes with a capacity-specific close reason", async () => {
    const limiter = new ConnectionLimiter(2);
    const documentName = "docs:concurrent-handshakes";

    await limiter.onConnect({ documentName, socketId: "socket-1" } as never);
    await limiter.onConnect({ documentName, socketId: "socket-2" } as never);

    await expect(
      limiter.onConnect({ documentName, socketId: "socket-3" } as never),
    ).rejects.toMatchObject({
      code: 4429,
      reason: "connection-limit-exceeded",
    });
  });

  it("accepts a valid connection after fifty failed handshakes expire", async () => {
    const limiter = new ConnectionLimiter(50);
    const documentName = "docs:preprod-regression";

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        limiter.onConnect({ documentName, socketId: `failed-${index}` } as never),
      ),
    );

    await vi.advanceTimersByTimeAsync(15_001);

    await expect(
      limiter.onConnect({ documentName, socketId: "valid-editor" } as never),
    ).resolves.toBeUndefined();
  });

  it("does not resurrect an expired handshake when connected arrives late", async () => {
    const limiter = new ConnectionLimiter(1);
    const documentName = "docs:late-connected";

    await limiter.onConnect({ documentName, socketId: "expired-socket" } as never);
    await vi.advanceTimersByTimeAsync(15_001);

    await limiter.onConnect({ documentName, socketId: "replacement-socket" } as never);
    const replacementConnection = connectedPayload({
      documentName,
      socketId: "replacement-socket",
    });
    await limiter.connected(replacementConnection.payload);

    const lateConnection = connectedPayload({
      documentName,
      socketId: "expired-socket",
    });
    await limiter.connected(lateConnection.payload);

    expect(lateConnection.connectionInstance.close).toHaveBeenCalledWith({
      code: 4408,
      reason: "connection-timeout",
    });
    await expect(
      limiter.onConnect({ documentName, socketId: "third-socket" } as never),
    ).rejects.toMatchObject({
      code: 4429,
      reason: "connection-limit-exceeded",
    });
  });

  it("does not resurrect a socket that disconnected before connected ran", async () => {
    const limiter = new ConnectionLimiter(1);
    const documentName = "docs:disconnect-before-connected";

    await limiter.onConnect({ documentName, socketId: "closed-socket" } as never);
    await limiter.onDisconnect({ documentName, socketId: "closed-socket" } as never);

    const closedConnection = connectedPayload({
      documentName,
      socketId: "closed-socket",
      active: false,
    });
    await limiter.connected(closedConnection.payload);

    expect(closedConnection.connectionInstance.close).not.toHaveBeenCalled();
    await expect(
      limiter.onConnect({ documentName, socketId: "replacement-socket" } as never),
    ).resolves.toBeUndefined();
  });
});

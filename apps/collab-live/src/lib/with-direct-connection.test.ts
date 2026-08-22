import { describe, it, expect, vi } from "vitest";
import { withDirectConnection } from "./with-direct-connection.js";
import type { Hocuspocus } from "@hocuspocus/server";

type DirectConn = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

function createMockConnection(overrides?: Partial<DirectConn>): DirectConn {
  return {
    document: null,
    instance: {} as Hocuspocus,
    context: {},
    transact: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as DirectConn;
}

function createMockHocuspocus(conn: DirectConn): Hocuspocus {
  return {
    openDirectConnection: vi.fn().mockResolvedValue(conn),
  } as unknown as Hocuspocus;
}

// ────────────────────────────────────────────
// withDirectConnection
// ────────────────────────────────────────────
describe("withDirectConnection", () => {
  it("passes DirectConnection to handler and returns its result", async () => {
    const conn = createMockConnection();
    const hocuspocus = createMockHocuspocus(conn);

    const result = await withDirectConnection(hocuspocus, "docs:123", {}, (doc) => {
      expect(doc).toBe(conn);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it("supports async handlers", async () => {
    const conn = createMockConnection();
    const hocuspocus = createMockHocuspocus(conn);

    const result = await withDirectConnection(hocuspocus, "docs:456", {}, async () => {
      return 42;
    });

    expect(result).toBe(42);
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects even when handler throws", async () => {
    const conn = createMockConnection();
    const hocuspocus = createMockHocuspocus(conn);

    await expect(
      withDirectConnection(hocuspocus, "docs:err", {}, () => {
        throw new Error("handler failure");
      }),
    ).rejects.toThrow("handler failure");

    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not call disconnect when openDirectConnection fails", async () => {
    const disconnectSpy = vi.fn();
    const hocuspocus = {
      openDirectConnection: vi.fn().mockRejectedValue(new Error("connect failed")),
    } as unknown as Hocuspocus;

    await expect(
      withDirectConnection(hocuspocus, "docs:bad", {}, () => "unreachable"),
    ).rejects.toThrow("connect failed");

    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it("does not propagate disconnect errors to caller", async () => {
    const conn = createMockConnection({
      disconnect: vi.fn().mockRejectedValue(new Error("disconnect boom")),
    } as any);
    const hocuspocus = createMockHocuspocus(conn);

    const result = await withDirectConnection(hocuspocus, "docs:dc-err", {}, () => "success");
    expect(result).toBe("success");
  });

  it("propagates disconnect/store errors when the caller requires a store barrier", async () => {
    const conn = createMockConnection({
      disconnect: vi.fn().mockRejectedValue(new Error("store failed")),
    } as any);
    const hocuspocus = createMockHocuspocus(conn);

    await expect(
      withDirectConnection(
        hocuspocus,
        "table:strict-store",
        {},
        () => "applied",
        { propagateDisconnectError: true },
      ),
    ).rejects.toThrow("store failed");
  });

  it("preserves the handler error when both the handler and disconnect fail", async () => {
    const conn = createMockConnection({
      disconnect: vi.fn().mockRejectedValue(new Error("disconnect failed")),
    } as any);
    const hocuspocus = createMockHocuspocus(conn);

    await expect(
      withDirectConnection(
        hocuspocus,
        "table:double-failure",
        {},
        () => { throw new Error("handler failed"); },
        { propagateDisconnectError: true },
      ),
    ).rejects.toThrow("handler failed");
  });
});

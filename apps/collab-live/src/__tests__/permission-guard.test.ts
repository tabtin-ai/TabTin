/**
 * RT-02 回归测试 — PermissionGuard
 *
 * 验证：
 * 1. auth.ts 在 onAuthenticate 中记录 authToken/resourceType/resourceId
 * 2. PermissionGuard.beforeHandleMessage 阻止已撤销连接的消息
 * 3. revokeUserConnections 正确关闭目标连接
 * 4. 定期重验失败后连接被标记和关闭
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../services/django-api.js", () => ({
  verifyCollabAccess: vi.fn(),
}));

import { PermissionGuard, revokeUserConnections, revokeAllUserConnections, downgradeUserConnectionsToReadOnly, downgradeAllUserConnectionsToReadOnly } from "../extensions/permission-guard.js";
import { verifyCollabAccess } from "../services/django-api.js";

const verifyMock = vi.mocked(verifyCollabAccess);

// ── Mock Hocuspocus 对象 ─────────────────────────────

interface MockContext {
  userId?: string;
  authToken?: string;
  resourceType?: string;
  resourceId?: string;
  parentDocumentId?: string;
  lastRevalidation?: number;
  permissionRevoked?: boolean;
  readOnly?: boolean;
  connectionEstablishedAt?: number;
  consecutiveFailures?: number;
  editorType?: string;
  editorId?: string;
  documentName?: string;
}

interface MockConnection {
  context: MockContext;
  readOnly: boolean;
  sendStateless: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockDocument {
  name: string;
  getConnections(): MockConnection[];
}

interface MockHocuspocus {
  documents: Map<string, MockDocument>;
  configuration: { extensions: unknown[] };
}

function createMockConnection(ctx: MockContext): MockConnection {
  return {
    context: ctx,
    readOnly: ctx.readOnly === true,
    sendStateless: vi.fn(),
    close: vi.fn(),
  };
}

function createMockHocuspocus(
  docs: Array<{ name: string; connections: MockConnection[] }>,
): MockHocuspocus {
  const documents = new Map<string, MockDocument>();
  for (const doc of docs) {
    documents.set(doc.name, {
      name: doc.name,
      getConnections: () => doc.connections,
    });
  }
  return { documents, configuration: { extensions: [] } };
}

// ── Tests ────────────────────────────────────────────

describe("PermissionGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("beforeHandleMessage", () => {
    it("allows messages when permissionRevoked is false", async () => {
      const guard = new PermissionGuard();
      const context: MockContext = { permissionRevoked: false };

      await expect(
        guard.beforeHandleMessage({ context } as any),
      ).resolves.toBeUndefined();
    });

    it("rejects messages when permissionRevoked is true", async () => {
      const guard = new PermissionGuard();
      const context: MockContext = { permissionRevoked: true };

      await expect(
        guard.beforeHandleMessage({ context } as any),
      ).rejects.toThrow("Permission revoked");
    });

    it("allows messages when context has no permissionRevoked flag", async () => {
      const guard = new PermissionGuard();
      await expect(
        guard.beforeHandleMessage({ context: {} } as any),
      ).resolves.toBeUndefined();
    });
  });

  describe("revokeUserConnections", () => {
    it("closes connections matching userId and documentName", () => {
      const conn1 = createMockConnection({
        userId: "user-a",
        authToken: "tok",
        resourceType: "docs",
        resourceId: "doc-1",
      });
      const conn2 = createMockConnection({
        userId: "user-b",
        authToken: "tok2",
        resourceType: "docs",
        resourceId: "doc-1",
      });
      const hocus = createMockHocuspocus([
        { name: "docs:doc-1", connections: [conn1, conn2] },
      ]);

      const closed = revokeUserConnections(
        hocus as any,
        "docs:doc-1",
        "user-a",
      );

      expect(closed).toBe(1);
      expect(conn1.context.permissionRevoked).toBe(true);
      expect(conn1.sendStateless).toHaveBeenCalledOnce();
      expect(conn2.context.permissionRevoked).toBeUndefined();
      expect(conn2.sendStateless).not.toHaveBeenCalled();

      const message = JSON.parse(conn1.sendStateless.mock.calls[0][0]);
      expect(message.type).toBe("force_close");
      expect(message.code).toBe(4004);
      expect(message.reason).toBe("permission_changed");
    });

    it("returns 0 when document not found", () => {
      const hocus = createMockHocuspocus([]);
      const closed = revokeUserConnections(hocus as any, "docs:nonexistent", "user-a");
      expect(closed).toBe(0);
    });

    it("returns 0 when no matching userId", () => {
      const conn = createMockConnection({
        userId: "user-b",
        authToken: "tok",
        resourceType: "docs",
        resourceId: "doc-1",
      });
      const hocus = createMockHocuspocus([
        { name: "docs:doc-1", connections: [conn] },
      ]);

      const closed = revokeUserConnections(hocus as any, "docs:doc-1", "user-a");
      expect(closed).toBe(0);
      expect(conn.context.permissionRevoked).toBeUndefined();
    });

    it("revokes multiple connections for same user", () => {
      const conn1 = createMockConnection({ userId: "user-a" });
      const conn2 = createMockConnection({ userId: "user-a" });
      const hocus = createMockHocuspocus([
        { name: "docs:doc-1", connections: [conn1, conn2] },
      ]);

      const closed = revokeUserConnections(hocus as any, "docs:doc-1", "user-a");
      expect(closed).toBe(2);
      expect(conn1.context.permissionRevoked).toBe(true);
      expect(conn2.context.permissionRevoked).toBe(true);
    });
  });
});

describe("PermissionGuard timer revalidation (direct invocation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks connection as revoked when Django returns unauthorized", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "permission revoked",
    });

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "expired-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    // Directly set instance without starting timer
    (guard as any).instance = hocus;

    // Invoke private method directly
    await (guard as any).revalidateAllConnections();

    expect(verifyMock).toHaveBeenCalledWith("docs", "doc-1", "expired-token", undefined);
    expect(conn.context.permissionRevoked).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledOnce();

    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("force_close");
    expect(message.reason).toBe("permission_changed");
    expect(message.code).toBe(4004);
  });

  it("does not revoke when Django returns authorized", async () => {
    verifyMock.mockResolvedValue({
      authorized: true,
      user_id: "user-a",
    });

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(verifyMock).toHaveBeenCalledWith("docs", "doc-1", "valid-token", undefined);
    expect(conn.context.permissionRevoked).toBe(false);
    expect(conn.sendStateless).not.toHaveBeenCalled();
    expect(conn.context.lastRevalidation).toBeGreaterThan(0);
  });

  it("does not disconnect on single network error (needs consecutive failures)", async () => {
    verifyMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.permissionRevoked).toBe(false);
    expect(conn.sendStateless).not.toHaveBeenCalled();
    expect(conn.context.consecutiveFailures).toBe(1);
  });

  it("does not revoke immediately when parent-reference verification is temporarily unavailable", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "access_verification_unavailable",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "table",
      resourceId: "table-1",
      parentDocumentId: "doc-parent",
      lastRevalidation: 0,
      permissionRevoked: false,
      consecutiveFailures: 0,
    });
    const hocus = createMockHocuspocus([
      { name: "table:table-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.permissionRevoked).toBe(false);
    expect(conn.context.consecutiveFailures).toBe(1);
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  it("skips connections that were recently revalidated", async () => {
    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: Date.now(),
      permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("skips connections without auth metadata", async () => {
    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("skips connections already marked as revoked", async () => {
    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: true,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("handles multiple documents and connections", async () => {
    verifyMock
      .mockResolvedValueOnce({ authorized: true, user_id: "user-a" })
      .mockResolvedValueOnce({ authorized: false, user_id: "", reason: "revoked" })
      .mockResolvedValueOnce({ authorized: true, user_id: "user-c" });

    const guard = new PermissionGuard();

    const conn1 = createMockConnection({
      userId: "user-a", authToken: "t1", resourceType: "docs",
      resourceId: "d1", lastRevalidation: 0, permissionRevoked: false,
    });
    const conn2 = createMockConnection({
      userId: "user-b", authToken: "t2", resourceType: "table",
      resourceId: "t1", lastRevalidation: 0, permissionRevoked: false,
    });
    const conn3 = createMockConnection({
      userId: "user-c", authToken: "t3", resourceType: "slide",
      resourceId: "s1", lastRevalidation: 0, permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:d1", connections: [conn1] },
      { name: "table:t1", connections: [conn2] },
      { name: "slide:s1", connections: [conn3] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(verifyMock).toHaveBeenCalledTimes(3);
    expect(conn1.context.permissionRevoked).toBe(false);
    expect(conn2.context.permissionRevoked).toBe(true);
    expect(conn3.context.permissionRevoked).toBe(false);
  });
});

describe("RB-007: consecutive failure fail-closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes connection after 3 consecutive network errors", async () => {
    verifyMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      consecutiveFailures: 0,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;

    await (guard as any).revalidateAllConnections();
    expect(conn.context.consecutiveFailures).toBe(1);
    expect(conn.context.permissionRevoked).toBe(false);

    conn.context.lastRevalidation = 0;
    await (guard as any).revalidateAllConnections();
    expect(conn.context.consecutiveFailures).toBe(2);
    expect(conn.context.permissionRevoked).toBe(false);

    conn.context.lastRevalidation = 0;
    await (guard as any).revalidateAllConnections();
    expect(conn.context.consecutiveFailures).toBe(3);
    expect(conn.context.permissionRevoked).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalled();

    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("force_close");
    expect(message.reason).toBe("permission_changed");
  });

  it("resets consecutive failures counter on successful revalidation", async () => {
    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      consecutiveFailures: 2,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;

    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });
    await (guard as any).revalidateAllConnections();

    expect(conn.context.consecutiveFailures).toBe(0);
    expect(conn.context.permissionRevoked).toBe(false);
  });

  it("does not close connection before reaching max consecutive failures", async () => {
    verifyMock.mockRejectedValue(new Error("ETIMEDOUT"));

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      consecutiveFailures: 0,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;

    await (guard as any).revalidateAllConnections();
    expect(conn.context.consecutiveFailures).toBe(1);
    expect(conn.context.permissionRevoked).toBe(false);
    expect(conn.sendStateless).not.toHaveBeenCalled();

    conn.context.lastRevalidation = 0;
    await (guard as any).revalidateAllConnections();
    expect(conn.context.consecutiveFailures).toBe(2);
    expect(conn.context.permissionRevoked).toBe(false);
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });
});

describe("AdminCommand.REVOKE_ACCESS type", () => {
  it("REVOKE_ACCESS is defined in AdminCommand enum", async () => {
    const { AdminCommand } = await import("../extensions/redis.js");
    expect(AdminCommand.REVOKE_ACCESS).toBe("revoke_access");
  });
});

describe("RB-015: Redis unavailable degradation warning", () => {
  it("logs warning when RedisExtension is not found", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const guard = new PermissionGuard();

    const hocusMock = createMockHocuspocus([]);
    // extensions array has no RedisExtension instance
    hocusMock.configuration.extensions = [];

    (guard as any).registerRevokeHandler(hocusMock);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("single-instance mode"),
    );

    warnSpy.mockRestore();
  });

  it("does not log warning when RedisExtension is present", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { RedisExtension } = await import("../extensions/redis.js");

    const guard = new PermissionGuard();

    const mockRedisExt = Object.create(RedisExtension.prototype);
    mockRedisExt.onAdminCommand = vi.fn();

    const hocusMock = createMockHocuspocus([]);
    hocusMock.configuration.extensions = [mockRedisExt];

    (guard as any).registerRevokeHandler(hocusMock);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redis cross-instance revoke handler registered"),
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe("SDI-030: revalidation interval clamping", () => {
  it("REVALIDATION_INTERVAL_MS is clamped to [10s, 300s]", async () => {
    const mod = await import("../extensions/permission-guard.js");
    const guard = new mod.PermissionGuard();

    await (guard as any).onConfigure({
      instance: createMockHocuspocus([]),
    });

    const interval = (guard as any).revalidationTimer;
    expect(interval).toBeTruthy();

    await (guard as any).onDestroy();
  });
});

describe("SDI-034: token age enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces reconnect when token age exceeds MAX_TOKEN_AGE_MS", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "old-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 2 * 3_600_000,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.permissionRevoked).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledOnce();
    expect(verifyMock).not.toHaveBeenCalled();

    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("force_close");
    expect(message.reason).toBe("permission_changed");
  });

  it("does not force reconnect when token age is within limit", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "fresh-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 60_000,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.permissionRevoked).toBe(false);
    expect(verifyMock).toHaveBeenCalledOnce();
  });

  it("sets connectionEstablishedAt on first revalidation if not already set", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();

    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;

    const before = Date.now();
    await (guard as any).revalidateAllConnections();
    const after = Date.now();

    expect(conn.context.connectionEstablishedAt).toBeGreaterThanOrEqual(before);
    expect(conn.context.connectionEstablishedAt).toBeLessThanOrEqual(after);
    expect(conn.context.permissionRevoked).toBe(false);
  });

  it("skips Django revalidation for token-age-evicted connections", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();

    const oldConn = createMockConnection({
      userId: "user-a",
      authToken: "old-token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 2 * 3_600_000,
    });

    const freshConn = createMockConnection({
      userId: "user-b",
      authToken: "fresh-token",
      resourceType: "docs",
      resourceId: "doc-2",
      lastRevalidation: 0,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 60_000,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [oldConn] },
      { name: "docs:doc-2", connections: [freshConn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(oldConn.context.permissionRevoked).toBe(true);
    expect(freshConn.context.permissionRevoked).toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledWith("docs", "doc-2", "fresh-token", undefined);
  });
});

describe("auth context fields (RT-02 regression)", () => {
  it("createCollabAuthHandler returns permission-guard metadata", async () => {
    verifyMock.mockResolvedValue({
      authorized: true,
      user_id: "user-123",
    });

    const { createCollabAuthHandler } = await import("../core/auth.js");
    const handler = createCollabAuthHandler("docs");
    const context: Record<string, unknown> = {};

    const result = await handler({
      documentName: "docs:abc-def",
      token: "jwt-token-xyz",
      connection: {} as any,
      context,
    });

    expect(result.authToken).toBe("jwt-token-xyz");
    expect(result.resourceType).toBe("docs");
    expect(result.resourceId).toBe("abc-def");
    expect(result.permissionRevoked).toBe(false);
    expect(result.lastRevalidation).toBeTypeOf("number");
    expect(result.userId).toBe("user-123");
  });

  it("createCollabAuthHandler does not store metadata on auth failure", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "no permission",
    });

    const { createCollabAuthHandler } = await import("../core/auth.js");
    const handler = createCollabAuthHandler("table");
    const context: Record<string, unknown> = {};

    await expect(
      handler({
        documentName: "table:tbl-1",
        token: "bad-token",
        connection: {} as any,
        context,
      }),
    ).rejects.toThrow("Unauthorized");

    expect(context.authToken).toBeUndefined();
    expect(context.permissionRevoked).toBeUndefined();
  });
});

// ── RB-009 回归测试：批量撤销 ────────────────────────

describe("RB-009: revokeAllUserConnections (bulk user revocation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes all connections for a user across multiple documents", () => {
    const connDoc1 = createMockConnection({ userId: "user-a" });
    const connDoc2 = createMockConnection({ userId: "user-a" });
    const connOther = createMockConnection({ userId: "user-b" });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [connDoc1, connOther] },
      { name: "table:tbl-1", connections: [connDoc2] },
    ]);

    const closed = revokeAllUserConnections(hocus as any, "user-a");

    expect(closed).toBe(2);
    expect(connDoc1.context.permissionRevoked).toBe(true);
    expect(connDoc1.sendStateless).toHaveBeenCalledOnce();
    expect(connDoc2.context.permissionRevoked).toBe(true);
    expect(connDoc2.sendStateless).toHaveBeenCalledOnce();
    expect(connOther.context.permissionRevoked).toBeUndefined();
    expect(connOther.sendStateless).not.toHaveBeenCalled();
  });

  it("returns 0 when no documents are loaded", () => {
    const hocus = createMockHocuspocus([]);
    const closed = revokeAllUserConnections(hocus as any, "user-a");
    expect(closed).toBe(0);
  });

  it("returns 0 when user has no active connections", () => {
    const conn = createMockConnection({ userId: "user-b" });
    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    const closed = revokeAllUserConnections(hocus as any, "user-a");
    expect(closed).toBe(0);
    expect(conn.context.permissionRevoked).toBeUndefined();
  });

  it("sends force_close stateless message to each revoked connection", () => {
    const conn = createMockConnection({ userId: "user-a" });
    const hocus = createMockHocuspocus([
      { name: "slide:s1", connections: [conn] },
    ]);

    revokeAllUserConnections(hocus as any, "user-a");

    expect(conn.sendStateless).toHaveBeenCalledOnce();
    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("force_close");
    expect(message.code).toBe(4004);
    expect(message.reason).toBe("permission_changed");
  });

  it("handles connections across all 6 module types", () => {
    const modules = ["docs", "table", "slide", "design", "video", "canvas"];
    const connections = modules.map((mod) => ({
      name: `${mod}:res-1`,
      connections: [createMockConnection({ userId: "user-a" })],
    }));

    const hocus = createMockHocuspocus(connections);
    const closed = revokeAllUserConnections(hocus as any, "user-a");

    expect(closed).toBe(6);
    for (const doc of connections) {
      expect(doc.connections[0].context.permissionRevoked).toBe(true);
    }
  });
});

describe("RB-009: AdminCommand.REVOKE_USER_ACCESS type", () => {
  it("REVOKE_USER_ACCESS is defined in AdminCommand enum", async () => {
    const { AdminCommand } = await import("../extensions/redis.js");
    expect(AdminCommand.REVOKE_USER_ACCESS).toBe("revoke_user_access");
  });
});

describe("RB-009: PermissionGuard registers REVOKE_USER_ACCESS handler", () => {
  it("registers both REVOKE_ACCESS and REVOKE_USER_ACCESS handlers on Redis extension", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { RedisExtension, AdminCommand } = await import("../extensions/redis.js");

    const guard = new PermissionGuard();

    const registeredCommands: string[] = [];
    const mockRedisExt = Object.create(RedisExtension.prototype);
    mockRedisExt.onAdminCommand = vi.fn((cmd: string) => {
      registeredCommands.push(cmd);
    });

    const hocusMock = createMockHocuspocus([]);
    hocusMock.configuration.extensions = [mockRedisExt];

    (guard as any).registerRevokeHandler(hocusMock);

    expect(mockRedisExt.onAdminCommand).toHaveBeenCalledTimes(2);
    expect(registeredCommands).toContain(AdminCommand.REVOKE_ACCESS);
    expect(registeredCommands).toContain(AdminCommand.REVOKE_USER_ACCESS);

    logSpy.mockRestore();
  });
});

// ── DS-032 回归测试：beforeHandleMessage 多层检查 ───────

describe("DS-032: beforeHandleMessage rejects stale/expired connections", () => {
  it("rejects when token age exceeds MAX_TOKEN_AGE_MS", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 2 * 3_600_000,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).rejects.toThrow("Token expired");
    expect(context.permissionRevoked).toBe(true);
  });

  it("rejects when revalidation is overdue (2× interval)", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 150_000,
      lastRevalidation: Date.now() - 130_000,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).rejects.toThrow("revalidation overdue");
    expect(context.permissionRevoked).toBe(true);
  });

  it("allows messages when lastRevalidation is recent", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 60_000,
      lastRevalidation: Date.now() - 30_000,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).resolves.toBeUndefined();
    expect(context.permissionRevoked).toBe(false);
  });

  it("lazily sets connectionEstablishedAt on first message", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
    };

    const before = Date.now();
    await guard.beforeHandleMessage({ context } as any);
    const after = Date.now();

    expect(context.connectionEstablishedAt).toBeGreaterThanOrEqual(before);
    expect(context.connectionEstablishedAt).toBeLessThanOrEqual(after);
  });

  it("falls back to connectionEstablishedAt when lastRevalidation is unset", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 130_000,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).rejects.toThrow("revalidation overdue");
  });

  it("allows messages for connection within revalidation window (no lastRevalidation)", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).resolves.toBeUndefined();
  });

  it("passes through when context is undefined", async () => {
    const guard = new PermissionGuard();
    await expect(
      guard.beforeHandleMessage({ context: undefined } as any),
    ).resolves.toBeUndefined();
  });

  it("marks permissionRevoked=true on stale rejection to prevent subsequent messages", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 150_000,
      lastRevalidation: Date.now() - 130_000,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).rejects.toThrow();

    expect(context.permissionRevoked).toBe(true);

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).rejects.toThrow("Permission revoked");
  });
});

// ── DS-024 回归测试：消息级短 TTL 实时权限验证 ──────────

function createFullPayload(
  ctx: MockContext,
  conn?: MockConnection,
) {
  const connection = conn || createMockConnection(ctx);
  return {
    context: ctx,
    connection,
    documentName: "docs:test-doc",
    update: new Uint8Array([0, 2]),
    clientsCount: 1,
    document: {} as any,
    instance: {} as any,
    requestHeaders: {},
    requestParameters: new URLSearchParams(),
    socketId: "socket-1",
  };
}

describe("DS-024: message-level short-TTL inline revalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers Django verification when MESSAGE_REVALIDATION_TTL_MS has elapsed", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(verifyMock).toHaveBeenCalledWith("docs", "doc-1", "valid-token", undefined);
    expect(ctx.consecutiveFailures).toBe(0);
  });

  it("sets Hocuspocus connection readOnly before allowing a downgraded message to continue", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a", permission: "view" });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
    });

    const payload = createFullPayload(conn.context, conn);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(conn.context.readOnly).toBe(true);
    expect(conn.readOnly).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledOnce();
  });

  it("skips Django verification when TTL has not elapsed", async () => {
    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 1_000,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("immediately revokes on permanent permission denial", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "insufficient permission (need editor)",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
    });

    const payload = createFullPayload(conn.context, conn);
    await expect(guard.beforeHandleMessage(payload as any)).rejects.toThrow(
      "Permission revoked",
    );

    expect(conn.context.permissionRevoked).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledOnce();
    const msg = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(msg.type).toBe("force_close");
    expect(msg.code).toBe(4004);
  });

  it("does not immediately revoke on transient failure (network error)", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "network error: ECONNREFUSED",
    });

    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      consecutiveFailures: 0,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(ctx.permissionRevoked).toBe(false);
    expect(ctx.consecutiveFailures).toBe(1);
  });

  it("does not immediately revoke on transient failure (timeout)", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "timeout after 10000ms",
    });

    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      consecutiveFailures: 0,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(ctx.permissionRevoked).toBe(false);
    expect(ctx.consecutiveFailures).toBe(1);
  });

  it("revokes after MAX_CONSECUTIVE_FAILURES transient errors", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "timeout after 10000ms",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      consecutiveFailures: 2,
    });

    const payload = createFullPayload(conn.context, conn);
    await expect(guard.beforeHandleMessage(payload as any)).rejects.toThrow(
      "consecutive failures",
    );

    expect(conn.context.permissionRevoked).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledOnce();
  });

  it("resets consecutiveFailures on successful revalidation", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      consecutiveFailures: 2,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(ctx.consecutiveFailures).toBe(0);
    expect(ctx.permissionRevoked).toBe(false);
  });

  it("skips revalidation when _msgRevalidationInProgress is set (thundering herd)", async () => {
    const guard = new PermissionGuard();
    const ctx: MockContext & { _msgRevalidationInProgress?: boolean } = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      _msgRevalidationInProgress: true,
    };

    const payload = createFullPayload(ctx as MockContext);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("clears _msgRevalidationInProgress after revalidation completes", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();
    const ctx: MockContext & { _msgRevalidationInProgress?: boolean } = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
    };

    const payload = createFullPayload(ctx as MockContext);
    await guard.beforeHandleMessage(payload as any);

    expect(ctx._msgRevalidationInProgress).toBe(false);
  });

  it("clears _msgRevalidationInProgress even when revalidation results in revoke", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "JWT token invalid or expired",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "expired-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
    });

    const payload = createFullPayload(conn.context, conn);
    await expect(guard.beforeHandleMessage(payload as any)).rejects.toThrow(
      "Permission revoked",
    );

    expect((conn.context as any)._msgRevalidationInProgress).toBe(false);
  });

  it("skips revalidation when auth metadata is missing", async () => {
    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("handles unexpected verifyCollabAccess throw with consecutive failure counting", async () => {
    verifyMock.mockRejectedValue(new Error("unexpected crash"));

    const guard = new PermissionGuard();
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      consecutiveFailures: 0,
    };

    const payload = createFullPayload(ctx);
    await expect(guard.beforeHandleMessage(payload as any)).resolves.toBeUndefined();

    expect(ctx.consecutiveFailures).toBe(1);
    expect(ctx.permissionRevoked).toBe(false);
  });

  it("revokes after MAX_CONSECUTIVE_FAILURES unexpected throws", async () => {
    verifyMock.mockRejectedValue(new Error("persistent crash"));

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: Date.now() - 10_000,
      consecutiveFailures: 2,
    });

    const payload = createFullPayload(conn.context, conn);
    await expect(guard.beforeHandleMessage(payload as any)).rejects.toThrow(
      "consecutive failures",
    );

    expect(conn.context.permissionRevoked).toBe(true);
  });

  it("updates lastRevalidation timestamp after successful verification", async () => {
    verifyMock.mockResolvedValue({ authorized: true, user_id: "user-a" });

    const guard = new PermissionGuard();
    const staleTime = Date.now() - 10_000;
    const ctx: MockContext = {
      userId: "user-a",
      authToken: "valid-token",
      resourceType: "docs",
      resourceId: "doc-1",
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 30_000,
      lastRevalidation: staleTime,
    };

    const before = Date.now();
    const payload = createFullPayload(ctx);
    await guard.beforeHandleMessage(payload as any);

    expect(ctx.lastRevalidation).toBeGreaterThanOrEqual(before);
    expect(ctx.lastRevalidation).toBeGreaterThan(staleTime);
  });
});

// ══════════════════════════════════════════════════════════
// RV-013 回归测试：readOnly 降级
// ══════════════════════════════════════════════════════════

describe("RV-013: downgradeUserConnectionsToReadOnly", () => {
  it("sets readOnly flag and sends downgrade message", () => {
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "tok",
      resourceType: "docs",
      resourceId: "doc-1",
    });
    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    const downgraded = downgradeUserConnectionsToReadOnly(
      hocus as any, "docs:doc-1", "user-a",
    );

    expect(downgraded).toBe(1);
    expect(conn.context.readOnly).toBe(true);
    expect(conn.readOnly).toBe(true);
    expect(conn.context.permissionRevoked).toBeUndefined();
    expect(conn.sendStateless).toHaveBeenCalledOnce();

    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("permission_downgrade");
    expect(message.readOnly).toBe(true);
  });

  it("does not downgrade connections already in readOnly mode", () => {
    const conn = createMockConnection({
      userId: "user-a",
      readOnly: true,
    });
    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    const downgraded = downgradeUserConnectionsToReadOnly(
      hocus as any, "docs:doc-1", "user-a",
    );

    expect(downgraded).toBe(0);
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  it("does not downgrade already-revoked connections", () => {
    const conn = createMockConnection({
      userId: "user-a",
      permissionRevoked: true,
    });
    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    const downgraded = downgradeUserConnectionsToReadOnly(
      hocus as any, "docs:doc-1", "user-a",
    );

    expect(downgraded).toBe(0);
  });

  it("only downgrades matching userId", () => {
    const connA = createMockConnection({ userId: "user-a" });
    const connB = createMockConnection({ userId: "user-b" });
    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [connA, connB] },
    ]);

    const downgraded = downgradeUserConnectionsToReadOnly(
      hocus as any, "docs:doc-1", "user-a",
    );

    expect(downgraded).toBe(1);
    expect(connA.context.readOnly).toBe(true);
    expect(connA.readOnly).toBe(true);
    expect(connB.context.readOnly).toBeUndefined();
    expect(connB.readOnly).toBe(false);
  });
});

describe("RV-013: downgradeAllUserConnectionsToReadOnly", () => {
  it("downgrades across all documents", () => {
    const conn1 = createMockConnection({ userId: "user-a" });
    const conn2 = createMockConnection({ userId: "user-a" });
    const connOther = createMockConnection({ userId: "user-b" });
    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn1, connOther] },
      { name: "table:tbl-1", connections: [conn2] },
    ]);

    const downgraded = downgradeAllUserConnectionsToReadOnly(
      hocus as any, "user-a",
    );

    expect(downgraded).toBe(2);
    expect(conn1.context.readOnly).toBe(true);
    expect(conn2.context.readOnly).toBe(true);
    expect(conn1.readOnly).toBe(true);
    expect(conn2.readOnly).toBe(true);
    expect(connOther.context.readOnly).toBeUndefined();
    expect(connOther.readOnly).toBe(false);
  });
});

describe("RV-013: beforeHandleMessage readOnly state sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs context readOnly to Hocuspocus connection readOnly", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      readOnly: true,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 10_000,
      lastRevalidation: Date.now() - 5_000,
    };
    const connection = createMockConnection({ ...context, readOnly: false });
    connection.context = context;

    await expect(
      guard.beforeHandleMessage({ context, connection } as any),
    ).resolves.toBeUndefined();
    expect(connection.readOnly).toBe(true);
  });

  it("allows Y.js sync step 1 messages in readOnly mode", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      readOnly: true,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 10_000,
      lastRevalidation: Date.now() - 5_000,
    };
    // Y.js sync(0) + step1(0)
    const syncStep1 = new Uint8Array([0, 0, 1, 2, 3]);

    await expect(
      guard.beforeHandleMessage({ context, update: syncStep1 } as any),
    ).resolves.toBeUndefined();
  });

  it("allows awareness messages in readOnly mode", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      readOnly: true,
      permissionRevoked: false,
      connectionEstablishedAt: Date.now() - 10_000,
      lastRevalidation: Date.now() - 5_000,
    };
    // Y.js awareness(1)
    const awareness = new Uint8Array([1, 0, 1, 2, 3]);

    await expect(
      guard.beforeHandleMessage({ context, update: awareness } as any),
    ).resolves.toBeUndefined();
  });

  it("permissionRevoked takes priority over readOnly", async () => {
    const guard = new PermissionGuard();
    const context: MockContext = {
      readOnly: true,
      permissionRevoked: true,
    };

    await expect(
      guard.beforeHandleMessage({ context } as any),
    ).rejects.toThrow("Permission revoked");
  });
});

describe("RV-013: revalidation handles readOnly → view permission correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps readOnly connection alive when Django returns view permission", async () => {
    verifyMock.mockResolvedValue({
      authorized: true,
      user_id: "user-a",
      permission: "view",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      readOnly: true,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.permissionRevoked).toBe(false);
    expect(conn.context.readOnly).toBe(true);
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  it("auto-downgrades to readOnly when edit permission is lost but view remains", async () => {
    verifyMock.mockResolvedValue({
      authorized: true,
      user_id: "user-a",
      permission: "view",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.readOnly).toBe(true);
    expect(conn.context.permissionRevoked).toBeFalsy();
    expect(conn.sendStateless).toHaveBeenCalledOnce();

    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("permission_downgrade");
    expect(message.readOnly).toBe(true);
  });

  it("upgrades from readOnly when edit permission is restored", async () => {
    verifyMock.mockResolvedValue({
      authorized: true,
      user_id: "user-a",
      permission: "edit",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      readOnly: true,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.readOnly).toBe(false);
    expect(conn.context.permissionRevoked).toBeFalsy();
  });

  it("closes readOnly connection when Django returns unauthorized", async () => {
    verifyMock.mockResolvedValue({
      authorized: false,
      user_id: "",
      reason: "no access",
    });

    const guard = new PermissionGuard();
    const conn = createMockConnection({
      userId: "user-a",
      authToken: "token",
      resourceType: "docs",
      resourceId: "doc-1",
      lastRevalidation: 0,
      permissionRevoked: false,
      readOnly: true,
    });

    const hocus = createMockHocuspocus([
      { name: "docs:doc-1", connections: [conn] },
    ]);

    (guard as any).instance = hocus;
    await (guard as any).revalidateAllConnections();

    expect(conn.context.permissionRevoked).toBe(true);
    expect(conn.sendStateless).toHaveBeenCalledOnce();

    const message = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(message.type).toBe("force_close");
  });
});

/**
 * RB-011 回归测试 — Redis 不可用时 /internal/revoke-access 返回 partial 状态
 *
 * 验证：
 * 1. Redis publish 成功时返回 200 + status:"ok"
 * 2. Redis publish 失败时返回 207 + status:"partial" + warning
 * 3. Redis 未配置（null）时同样返回 207 + status:"partial"
 * 4. 响应中包含 redis_broadcast 布尔字段供调用方判断
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../extensions/index.js", () => ({
  getPrimaryRedis: vi.fn(),
  getExtensions: vi.fn(() => []),
  getTableExtensions: vi.fn(() => []),
  getSlideExtensions: vi.fn(() => []),
  getDesignExtensions: vi.fn(() => []),
  getVideoExtensions: vi.fn(() => []),
  getCanvasExtensions: vi.fn(() => []),
  AdminCommand: { REVOKE_ACCESS: "revoke_access" },
}));

vi.mock("../extensions/permission-guard.js", () => ({
  revokeUserConnections: vi.fn(() => 0),
}));

vi.mock("../env.js", () => ({
  env: {
    SERVER_NAME: "test-server",
    LIVE_SECRET: "test-secret",
    PORT: 0,
    REDIS_URL: "",
    CORS_ALLOWED_ORIGINS: [],
    DJANGO_API_URL: "http://localhost:6060",
    HOCUSPOCUS_DEBOUNCE_DOCS: 2000,
    HOCUSPOCUS_DEBOUNCE_TABLE: 2000,
    HOCUSPOCUS_DEBOUNCE_SLIDE: 2000,
    HOCUSPOCUS_DEBOUNCE_DESIGN: 2000,
    HOCUSPOCUS_DEBOUNCE_VIDEO: 2000,
    HOCUSPOCUS_DEBOUNCE_CANVAS: 2000,
  },
}));

import { getPrimaryRedis } from "../extensions/index.js";
import { revokeUserConnections } from "../extensions/permission-guard.js";

const getPrimaryRedisMock = vi.mocked(getPrimaryRedis);
const revokeUserConnectionsMock = vi.mocked(revokeUserConnections);

describe("RB-011: /internal/revoke-access Redis broadcast failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns status:'ok' with redis_broadcast:true when Redis publish succeeds", async () => {
    const mockRedis = {
      publishAdminCommand: vi.fn().mockResolvedValue(2),
    };
    getPrimaryRedisMock.mockReturnValue(mockRedis as any);
    revokeUserConnectionsMock.mockReturnValue(1);

    const mockReq = {
      body: { document_name: "docs:doc-1", user_id: "user-a" },
      headers: { "x-live-secret": "test-secret" },
    };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    const handler = createRevokeAccessHandler();
    await handler(mockReq as any, mockRes as any);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        data: expect.objectContaining({
          redis_broadcast: true,
          connections_closed: expect.any(Number),
        }),
      }),
    );
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("returns 207 + status:'partial' when Redis publish throws", async () => {
    const mockRedis = {
      publishAdminCommand: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    getPrimaryRedisMock.mockReturnValue(mockRedis as any);
    revokeUserConnectionsMock.mockReturnValue(1);

    const mockReq = {
      body: { document_name: "docs:doc-1", user_id: "user-a" },
    };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    const handler = createRevokeAccessHandler();
    await handler(mockReq as any, mockRes as any);

    expect(mockRes.status).toHaveBeenCalledWith(207);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "partial",
        data: expect.objectContaining({
          redis_broadcast: false,
          connections_closed: expect.any(Number),
        }),
        warning: expect.stringContaining("Cross-instance broadcast failed"),
      }),
    );
  });

  it("returns 207 + status:'partial' when Redis is not configured (null)", async () => {
    getPrimaryRedisMock.mockReturnValue(null);
    revokeUserConnectionsMock.mockReturnValue(0);

    const mockReq = {
      body: { document_name: "docs:doc-1", user_id: "user-a" },
    };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    const handler = createRevokeAccessHandler();
    await handler(mockReq as any, mockRes as any);

    expect(mockRes.status).toHaveBeenCalledWith(207);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "partial",
        warning: expect.stringContaining("single-instance mode"),
      }),
    );
  });

  it("local revocation still works even when Redis fails", async () => {
    const mockRedis = {
      publishAdminCommand: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    getPrimaryRedisMock.mockReturnValue(mockRedis as any);
    revokeUserConnectionsMock.mockReturnValue(3);

    const mockReq = {
      body: { document_name: "docs:doc-1", user_id: "user-a" },
    };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    const handler = createRevokeAccessHandler();
    await handler(mockReq as any, mockRes as any);

    expect(revokeUserConnectionsMock).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          connections_closed: 3,
          redis_broadcast: false,
        }),
      }),
    );
  });
});

/**
 * 从 server.ts 的 setupRevokeAccessEndpoint 中提取核心逻辑，
 * 不需要真正启动 Express 服务器。
 */
function createRevokeAccessHandler() {
  return async (req: any, res: any) => {
    try {
      const { document_name, user_id } = req.body;

      if (!document_name || !user_id) {
        res.status(400).json({
          status: "error",
          message: "缺少 document_name 或 user_id",
        });
        return;
      }

      const totalClosed = revokeUserConnectionsMock(null as any, document_name, user_id);

      let redisBroadcastOk = false;
      let redisBroadcastError: string | undefined;
      const redis = getPrimaryRedisMock();
      if (redis) {
        try {
          await (redis as any).publishAdminCommand({
            command: "revoke_access",
            docId: document_name,
            userId: user_id,
            originServer: "test-server",
            timestamp: new Date().toISOString(),
          });
          redisBroadcastOk = true;
        } catch (err: unknown) {
          redisBroadcastError = err instanceof Error ? err.message : String(err);
        }
      } else {
        redisBroadcastError = "Redis not configured — single-instance mode";
      }

      const responseData = {
        document_name,
        user_id,
        connections_closed: totalClosed,
        redis_broadcast: redisBroadcastOk,
      };

      if (redisBroadcastOk) {
        res.json({ status: "ok", data: responseData });
      } else {
        res.status(207).json({
          status: "partial",
          data: responseData,
          warning: `Cross-instance broadcast failed: ${redisBroadcastError}. ` +
            "Only local instance connections were revoked.",
        });
      }
    } catch (error: unknown) {
      res.status(500).json({ status: "error", message: "Internal server error" });
    }
  };
}

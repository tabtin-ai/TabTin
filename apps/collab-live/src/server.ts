/**
 * Collab Live Server
 *
 * Express + Hocuspocus WebSocket 服务器。
 * 提供:
 * - WebSocket: Y.js 实时协作
 * - HTTP API: 格式转换端点、Agent push、Block 操作（供 Django 调用）
 */

import crypto from "node:crypto";
import type { Server as HttpServer } from "http";
import express from "express";
import expressWs from "express-ws";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Hocuspocus } from "@hocuspocus/server";
import { getExtensions, getTableExtensions, getSlideExtensions, getVideoExtensions, getCanvasExtensions, getPrimaryRedis, AdminCommand } from "./extensions/index.js";
import type { RevokeAccessCommandData, RevokeUserAccessCommandData } from "./extensions/redis.js";
import { revokeUserConnections, revokeAllUserConnections, downgradeUserConnectionsToReadOnly, downgradeAllUserConnectionsToReadOnly } from "./extensions/permission-guard.js";
import { onAuthenticateDocs, onAuthenticateTable, onAuthenticateSlide, onAuthenticateVideo, onAuthenticateCanvas } from "./core/auth.js";
import { metrics } from "./extensions/metrics.js";
import { env } from "./env.js";
import type { RouteContext, ModuleName } from "./routes/types.js";
import { detectConcurrentEditors as detectConcurrentEditorsImpl } from "./lib/collab-utils.js";
import { setupConvertRoutes } from "./routes/convert.js";
import { setupBlockRoutes } from "./routes/block.js";
import { setupAdminRoutes } from "./routes/admin.js";
import { setupApplyOpsRoutes } from "./routes/apply-ops.js";
import { attachWebSocketErrorGuard } from "./lib/ws-error-guard.js";

function maskRedisUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/:[^@]+@/, "://:*****@");
  }
}

export class Server {
  private app: ReturnType<typeof expressWs>["app"];
  private hocuspocus: Hocuspocus | null = null;
  private tableHocuspocus: Hocuspocus | null = null;
  private slideHocuspocus: Hocuspocus | null = null;
  private videoHocuspocus: Hocuspocus | null = null;
  private canvasHocuspocus: Hocuspocus | null = null;
  private httpServer: HttpServer | null = null;

  /** 所有 Hocuspocus 实例（含模块标签），过滤掉 null */
  private get allInstances(): Array<{ instance: Hocuspocus; module: string }> {
    return ([
      { instance: this.hocuspocus, module: "docs" },
      { instance: this.tableHocuspocus, module: "table" },
      { instance: this.slideHocuspocus, module: "slide" },
      { instance: this.videoHocuspocus, module: "video" },
      { instance: this.canvasHocuspocus, module: "canvas" },
    ] as Array<{ instance: Hocuspocus | null; module: string }>)
      .filter((x): x is { instance: Hocuspocus; module: string } => x.instance !== null);
  }

  constructor() {
    const wsApp = expressWs(express(), undefined, {
      wsOptions: { maxPayload: env.WS_MAX_PAYLOAD },
    });
    this.app = wsApp.app;
  }

  async initialize(): Promise<void> {
    // ── Hocuspocus 初始化 ──
    this.hocuspocus = new Hocuspocus({
      name: env.SERVER_NAME,
      onAuthenticate: onAuthenticateDocs,
      extensions: getExtensions(),
      debounce: env.HOCUSPOCUS_DEBOUNCE_DOCS,
    });

    // ── Express 中间件 ──
    // CORS 仅对 HTTP 端点生效。
    // WebSocket 升级握手虽经过此中间件，但 cors() 不会拦截 WS 连接（浏览器不校验 101 响应的 CORS 头）；
    // WebSocket 安全由各模块 onAuthenticate JWT 认证独立保证，与 CORS 无关。
    const corsOrigins = env.CORS_ALLOWED_ORIGINS;
    this.app.use(
      cors(
        corsOrigins.length > 0
          ? { origin: corsOrigins, credentials: true }
          : { origin: false },
      ),
    );
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true, limit: "10mb" }));

    this.app.use(
      rateLimit({
        windowMs: 60_000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => req.path === "/health",
        message: { status: "error", message: "Too many requests, please try again later" },
      }),
    );

    // ── 健康检查 + Metrics ──
    this.app.get("/health", (_req, res) => {
      res.status(200).json({ status: "ok" });
    });

    this.app.get("/metrics", this.requireLiveSecret, (_req, res) => {
      const snapshot = metrics.getSnapshot();
      const alerts = metrics.checkAlerts();
      res.json({
        status: alerts.length > 0 ? "warning" : "ok",
        data: snapshot,
        alerts: alerts.length > 0 ? alerts : undefined,
      });
    });

    // ── 其他 Hocuspocus 实例初始化 ──
    this.tableHocuspocus = new Hocuspocus({
      name: `${env.SERVER_NAME}-table`,
      onAuthenticate: onAuthenticateTable,
      extensions: getTableExtensions(),
      debounce: env.HOCUSPOCUS_DEBOUNCE_TABLE,
    });

    this.slideHocuspocus = new Hocuspocus({
      name: `${env.SERVER_NAME}-slide`,
      onAuthenticate: onAuthenticateSlide,
      extensions: getSlideExtensions(),
      debounce: env.HOCUSPOCUS_DEBOUNCE_SLIDE,
    });

    this.videoHocuspocus = new Hocuspocus({
      name: `${env.SERVER_NAME}-video`,
      onAuthenticate: onAuthenticateVideo,
      extensions: getVideoExtensions(),
      debounce: env.HOCUSPOCUS_DEBOUNCE_VIDEO,
    });

    this.canvasHocuspocus = new Hocuspocus({
      name: `${env.SERVER_NAME}-canvas`,
      onAuthenticate: onAuthenticateCanvas,
      extensions: getCanvasExtensions(),
      debounce: env.HOCUSPOCUS_DEBOUNCE_CANVAS,
    });

    // ── WebSocket 端点（Y.js 协作） ──
    this.registerCollaborationEndpoint("/collaboration", () => this.hocuspocus!);
    this.registerCollaborationEndpoint("/table-collaboration", () => this.tableHocuspocus!);
    this.registerCollaborationEndpoint("/slide-collaboration", () => this.slideHocuspocus!);
    this.registerCollaborationEndpoint("/video-collaboration", () => this.videoHocuspocus!);
    this.registerCollaborationEndpoint("/canvas-collaboration", () => this.canvasHocuspocus!);

    // ── HTTP 路由注册 ──
    const ctx: RouteContext = {
      app: this.app,
      requireLiveSecret: this.requireLiveSecret,
      getInstance: (mod: ModuleName) => {
        const map: Record<ModuleName, Hocuspocus | null> = {
          docs: this.hocuspocus,
          table: this.tableHocuspocus,
          slide: this.slideHocuspocus,
          video: this.videoHocuspocus,
          canvas: this.canvasHocuspocus,
        };
        const instance = map[mod];
        if (!instance) throw new Error(`Hocuspocus instance for "${mod}" not initialized`);
        return instance;
      },
      allInstances: () => this.allInstances,
      resolveHocuspocusInstance: this.resolveHocuspocusInstance.bind(this),
      detectConcurrentEditors: this.detectConcurrentEditors.bind(this),
    };

    setupConvertRoutes(ctx);
    setupApplyOpsRoutes(ctx);
    setupBlockRoutes(ctx);
    setupAdminRoutes(ctx);

    this.setupRevokeAccessEndpoint(ctx);
  }

  // ================================================================
  // 实例路由辅助
  // ================================================================

  /**
   * 根据 document_id 的前缀解析对应的 Hocuspocus 实例和完整 document name。
   */
  private resolveHocuspocusInstance(documentId: string): { instance: Hocuspocus; documentName: string } {
    const prefixMap: Array<[string, Hocuspocus | null]> = [
      ["docs:", this.hocuspocus],
      ["table:", this.tableHocuspocus],
      ["slide:", this.slideHocuspocus],
      ["video:", this.videoHocuspocus],
      ["canvas:", this.canvasHocuspocus],
    ];

    for (const [prefix, instance] of prefixMap) {
      if (documentId.startsWith(prefix) && instance) {
        return { instance, documentName: documentId };
      }
    }

    return { instance: this.hocuspocus!, documentName: `docs:${documentId}` };
  }

  private detectConcurrentEditors(
    documentName: string,
    excludeEditorId: string,
  ): Array<{ editor_type: string; editor_id: string }> {
    return detectConcurrentEditorsImpl(
      this.allInstances.map(({ instance }) => instance),
      documentName,
      excludeEditorId,
    );
  }

  private registerCollaborationEndpoint(
    path: string,
    getInstance: () => Hocuspocus,
  ): void {
    this.app.ws(path, (ws, req) => {
      attachWebSocketErrorGuard(ws, req);
      getInstance().handleConnection(ws, req);
    });
  }

  // ================================================================
  // 中间件
  // ================================================================

  private requireLiveSecret(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void {
    const secret = req.headers["x-live-secret"];
    if (
      typeof secret !== "string" ||
      secret.length !== env.LIVE_SECRET.length ||
      !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(env.LIVE_SECRET))
    ) {
      res.status(403).json({ status: "error", message: "Forbidden" });
      return;
    }
    next();
  }

  // ================================================================
  // 权限撤销端点
  // ================================================================

  private setupRevokeAccessEndpoint(ctx: RouteContext): void {
    const { app, requireLiveSecret } = ctx;

    app.post("/internal/revoke-access", requireLiveSecret, async (req, res) => {
      try {
        const { document_name, user_id, read_only } = req.body;

        if (!document_name || !user_id) {
          res.status(400).json({
            status: "error",
            message: "缺少 document_name 或 user_id",
          });
          return;
        }

        let totalAffected = 0;
        for (const { instance } of ctx.allInstances()) {
          totalAffected += read_only
            ? downgradeUserConnectionsToReadOnly(instance, document_name, user_id)
            : revokeUserConnections(instance, document_name, user_id);
        }

        let redisBroadcastOk = false;
        let redisBroadcastError: string | undefined;
        const redis = getPrimaryRedis();
        if (redis) {
          try {
            await redis.publishAdminCommand({
              command: AdminCommand.REVOKE_ACCESS,
              docId: document_name,
              userId: user_id,
              readOnly: !!read_only,
              originServer: env.SERVER_NAME,
              timestamp: new Date().toISOString(),
            } satisfies RevokeAccessCommandData);
            redisBroadcastOk = true;
          } catch (err: unknown) {
            redisBroadcastError = err instanceof Error ? err.message : String(err);
            console.error("[RevokeAccess] Redis publish failed:", redisBroadcastError);
          }
        } else {
          redisBroadcastError = "Redis not configured — single-instance mode";
          console.warn("[RevokeAccess] No Redis available, revocation is local-only");
        }

        const responseData = {
          document_name,
          user_id,
          read_only: !!read_only,
          connections_affected: totalAffected,
          redis_broadcast: redisBroadcastOk,
        };

        const label = read_only ? "DowngradeAccess" : "RevokeAccess";
        if (redisBroadcastOk) {
          console.log(
            `[${label}] user=${user_id} doc=${document_name} affected=${totalAffected}`,
          );
          res.json({ status: "ok", data: responseData });
        } else {
          console.warn(
            `[${label}] PARTIAL user=${user_id} doc=${document_name} ` +
            `affected=${totalAffected} redis_error="${redisBroadcastError}"`,
          );
          res.status(207).json({
            status: "partial",
            data: responseData,
            warning: `Cross-instance broadcast failed: ${redisBroadcastError}. ` +
              "Only local instance connections were affected.",
          });
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[RevokeAccess] Error:", msg);
        res.status(500).json({ status: "error", message: "Internal server error" });
      }
    });

    app.post("/internal/revoke-user-access", requireLiveSecret, async (req, res) => {
      try {
        const { user_id, read_only } = req.body;

        if (!user_id) {
          res.status(400).json({
            status: "error",
            message: "缺少 user_id",
          });
          return;
        }

        let totalAffected = 0;
        for (const { instance } of ctx.allInstances()) {
          totalAffected += read_only
            ? downgradeAllUserConnectionsToReadOnly(instance, user_id)
            : revokeAllUserConnections(instance, user_id);
        }

        let redisBroadcastOk = false;
        let redisBroadcastError: string | undefined;
        const redis = getPrimaryRedis();
        if (redis) {
          try {
            await redis.publishAdminCommand({
              command: AdminCommand.REVOKE_USER_ACCESS,
              docId: "*",
              userId: user_id,
              readOnly: !!read_only,
              originServer: env.SERVER_NAME,
              timestamp: new Date().toISOString(),
            } satisfies RevokeUserAccessCommandData);
            redisBroadcastOk = true;
          } catch (err: unknown) {
            redisBroadcastError = err instanceof Error ? err.message : String(err);
            console.error("[RevokeUserAccess] Redis publish failed:", redisBroadcastError);
          }
        } else {
          redisBroadcastError = "Redis not configured — single-instance mode";
          console.warn("[RevokeUserAccess] No Redis available, revocation is local-only");
        }

        const responseData = {
          user_id,
          read_only: !!read_only,
          connections_affected: totalAffected,
          redis_broadcast: redisBroadcastOk,
        };

        const label = read_only ? "DowngradeUserAccess" : "RevokeUserAccess";
        if (redisBroadcastOk) {
          console.log(
            `[${label}] user=${user_id} affected=${totalAffected}`,
          );
          res.json({ status: "ok", data: responseData });
        } else {
          console.warn(
            `[${label}] PARTIAL user=${user_id} ` +
            `affected=${totalAffected} redis_error="${redisBroadcastError}"`,
          );
          res.status(207).json({
            status: "partial",
            data: responseData,
            warning: `Cross-instance broadcast failed: ${redisBroadcastError}. ` +
              "Only local instance connections were affected.",
          });
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[RevokeUserAccess] Error:", msg);
        res.status(500).json({ status: "error", message: "Internal server error" });
      }
    });
  }

  // ================================================================
  // 生命周期
  // ================================================================

  listen(): void {
    this.httpServer = this.app.listen(env.PORT, env.HOST, () => {
      console.log(`[Collab Live] 🚀 Server running on ${env.HOST}:${env.PORT}`);
      console.log(`[Collab Live] WebSocket: ws://${env.HOST}:${env.PORT}/collaboration`);
      console.log(`[Collab Live] Table WS:  ws://${env.HOST}:${env.PORT}/table-collaboration`);
      console.log(`[Collab Live] Slide WS:  ws://${env.HOST}:${env.PORT}/slide-collaboration`);
      console.log(`[Collab Live] Video WS:  ws://${env.HOST}:${env.PORT}/video-collaboration`);
      console.log(`[Collab Live] Canvas WS: ws://${env.HOST}:${env.PORT}/canvas-collaboration`);
      console.log(`[Collab Live] Django API: ${env.DJANGO_API_URL}`);
      console.log(`[Collab Live] Server name: ${env.SERVER_NAME}`);
      console.log(`[Collab Live] Redis: ${maskRedisUrl(env.REDIS_URL) || "disabled"}`);
    });
  }

  async destroy(): Promise<void> {
    // 通知所有客户端即将关闭，让 UI 显示"服务维护中"而非"离线"
    for (const { instance } of this.allInstances) {
      for (const [, doc] of instance.documents) {
        for (const connection of doc.getConnections()) {
          try {
            connection.sendStateless(JSON.stringify({
              type: 'server_shutdown',
              message: 'Server is restarting. Your data is safe.',
              timestamp: Date.now(),
            }));
          } catch { /* best effort */ }
        }
      }
    }

    // 给客户端 500ms 处理通知
    await new Promise(resolve => setTimeout(resolve, 500));

    for (const { instance } of this.allInstances) {
      await instance.destroy();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }
}

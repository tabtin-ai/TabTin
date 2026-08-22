/**
 * Collab Live 入口
 *
 * 启动 Hocuspocus + Express 服务器。
 */

import { Server } from "./server.js";

let server: Server | null = null;
let initialized = false;
let shutdownRequested = false;

async function gracefulShutdown(signal: string, code = 0): Promise<void> {
  console.log(`[Collab Live] Received ${signal}, shutting down...`);
  if (shutdownRequested) return;
  shutdownRequested = true;

  const forceExitTimer = setTimeout(() => {
    console.error('[Collab Live] Shutdown timed out after 30s, forcing exit');
    process.exit(1);
  }, 30_000);
  forceExitTimer.unref();

  try {
    if (initialized && server) {
      await server.destroy();
    }
  } catch (e) {
    console.error("[Collab Live] Error during shutdown:", e);
  }

  clearTimeout(forceExitTimer);
  process.exit(code);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("[Collab Live] Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[Collab Live] Uncaught exception:", err);
  void gracefulShutdown("uncaughtException", 1);
});

async function startServer() {
  server = new Server();
  try {
    await server.initialize();
    initialized = true;

    if (shutdownRequested) {
      console.log("[Collab Live] Shutdown requested during initialization, destroying...");
      await server.destroy();
      process.exit(0);
    }

    server.listen();
  } catch (error: unknown) {
    console.error("[Collab Live] Failed to start server:", error);
    process.exit(1);
  }
}

startServer();

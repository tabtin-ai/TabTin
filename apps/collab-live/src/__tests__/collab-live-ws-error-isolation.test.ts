import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import express from "express";
import expressWs from "express-ws";
import request from "supertest";
import WebSocket from "ws";
import {
  attachWebSocketErrorGuard,
  isWebSocketMessageTooBigError,
} from "../lib/ws-error-guard.js";

const TEST_MAX_PAYLOAD_BYTES = 32;
const OVERSIZED_PAYLOAD_BYTES = TEST_MAX_PAYLOAD_BYTES + 1;
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
const HTTP_OK = 200;

async function listen(
  app: ReturnType<typeof expressWs>["app"],
): Promise<{ server: HttpServer; port: number }> {
  const server = await new Promise<HttpServer>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test HTTP server");
  }
  return { server, port: address.port };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

describe("collab-live WebSocket connection error isolation", () => {
  let server: HttpServer | null = null;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.close();
    }
    clients.length = 0;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      server = null;
    }
    vi.restoreAllMocks();
  });

  it("classifies ws maxPayload errors by code and close status", () => {
    const byCode = Object.assign(new Error("Max payload size exceeded"), {
      code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
    });
    expect(isWebSocketMessageTooBigError(byCode)).toBe(true);

    const byStatus = new Error("Max payload size exceeded");
    Object.defineProperty(byStatus, Symbol("status-code"), {
      value: WS_CLOSE_MESSAGE_TOO_BIG,
    });
    expect(isWebSocketMessageTooBigError(byStatus)).toBe(true);

    expect(isWebSocketMessageTooBigError(new Error("other"))).toBe(false);
  });

  it("closes only the oversized connection and keeps the server healthy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const uncaughtException = vi.fn();
    process.on("uncaughtException", uncaughtException);

    try {
      const wsApp = expressWs(express(), undefined, {
        wsOptions: { maxPayload: TEST_MAX_PAYLOAD_BYTES },
      });
      const app = wsApp.app;

      app.get("/health", (_req, res) => {
        res.status(HTTP_OK).json({ status: "ok" });
      });

      app.ws("/table-collaboration", (ws, req) => {
        attachWebSocketErrorGuard(ws, req);
        ws.on("message", () => {
          ws.send("ok");
        });
      });

      const started = await listen(app);
      server = started.server;

      const stableClient = new WebSocket(
        `ws://127.0.0.1:${started.port}/table-collaboration`,
      );
      const oversizedClient = new WebSocket(
        `ws://127.0.0.1:${started.port}/table-collaboration`,
      );
      clients.push(stableClient, oversizedClient);

      await Promise.all([waitForOpen(stableClient), waitForOpen(oversizedClient)]);

      const oversizedClosed = waitForClose(oversizedClient);
      oversizedClient.send(Buffer.alloc(OVERSIZED_PAYLOAD_BYTES));

      await expect(oversizedClosed).resolves.toMatchObject({
        code: WS_CLOSE_MESSAGE_TOO_BIG,
      });
      expect(uncaughtException).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("WebSocket message too large"),
      );

      await expect(request(server).get("/health")).resolves.toMatchObject({
        status: HTTP_OK,
      });

      const stableMessage = waitForMessage(stableClient);
      stableClient.send("ping");
      await expect(stableMessage).resolves.toBe("ok");
    } finally {
      process.off("uncaughtException", uncaughtException);
    }
  });
});

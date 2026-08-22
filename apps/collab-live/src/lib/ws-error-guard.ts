import type express from "express";
import WebSocket from "ws";
import { env } from "../env.js";

const WS_UNSUPPORTED_MESSAGE_LENGTH_CODE = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
const WS_CLOSE_INTERNAL_ERROR = 1011;
const WS_MESSAGE_TOO_BIG_REASON = "Message too big";
const WS_CONNECTION_ERROR_REASON = "Connection error";
const WS_STATUS_CODE_SYMBOL_DESCRIPTION = "status-code";

type WebSocketError = Error & { code?: unknown };

function getWebSocketErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  for (const symbol of Object.getOwnPropertySymbols(error)) {
    if (symbol.description !== WS_STATUS_CODE_SYMBOL_DESCRIPTION) continue;
    const statusCode = (error as Record<symbol, unknown>)[symbol];
    return typeof statusCode === "number" ? statusCode : undefined;
  }

  return undefined;
}

export function isWebSocketMessageTooBigError(error: unknown): boolean {
  const wsError = error as WebSocketError;
  return (
    wsError?.code === WS_UNSUPPORTED_MESSAGE_LENGTH_CODE ||
    getWebSocketErrorStatusCode(error) === WS_CLOSE_MESSAGE_TOO_BIG
  );
}

function closeWebSocketQuietly(
  ws: WebSocket,
  code: number,
  reason: string,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.close(code, reason);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Collab Live] Failed to close errored WebSocket: ${message}`);
  }
}

export function attachWebSocketErrorGuard(
  ws: WebSocket,
  req: express.Request,
): void {
  ws.on("error", (error: Error) => {
    const statusCode = getWebSocketErrorStatusCode(error);
    const code = (error as WebSocketError).code;
    const path = req.originalUrl || req.url || req.path;

    if (isWebSocketMessageTooBigError(error)) {
      console.warn(
        "[Collab Live] WebSocket message too large; closing only this connection " +
        `path=${path} code=${String(code)} status=${statusCode} ` +
        `maxPayload=${env.WS_MAX_PAYLOAD} message="${error.message}"`,
      );
      closeWebSocketQuietly(
        ws,
        WS_CLOSE_MESSAGE_TOO_BIG,
        WS_MESSAGE_TOO_BIG_REASON,
      );
      return;
    }

    console.error(
      "[Collab Live] WebSocket connection error; closing only this connection " +
      `path=${path} code=${String(code)} status=${statusCode}`,
      error,
    );
    closeWebSocketQuietly(ws, WS_CLOSE_INTERNAL_ERROR, WS_CONNECTION_ERROR_REASON);
  });
}

/**
 * ConnectionLimiter — 单文档 WS 连接数上限
 *
 * 防止攻击者对同一文档发起海量 WS 连接，
 * 每个连接触发 Awareness 广播形成 O(n²) 消息爆炸。
 */

import type {
  connectedPayload,
  Extension,
  onConnectPayload,
  onDisconnectPayload,
} from "@hocuspocus/server";
import { env } from "../env.js";

// Django 鉴权最多等待 10 秒；额外预留 5 秒给 Hocuspocus 建文档连接。
// `connected` 会取消该超时，只有未完成握手的占位会自动释放。
const HANDSHAKE_RESERVATION_TTL_MS = 15_000;
const HANDSHAKE_TIMEOUT_CLOSE_CODE = 4408;
const HANDSHAKE_TIMEOUT_CLOSE_REASON = "connection-timeout";
const CONNECTION_LIMIT_CLOSE_CODE = 4429;
const CONNECTION_LIMIT_CLOSE_REASON = "connection-limit-exceeded";
const WEBSOCKET_OPEN_STATE = 1;

type Reservation = {
  expiresAt?: ReturnType<typeof setTimeout>;
};

class ConnectionLimitExceededError extends Error {
  readonly code = CONNECTION_LIMIT_CLOSE_CODE;
  readonly reason = CONNECTION_LIMIT_CLOSE_REASON;

  constructor() {
    super("Document connection limit exceeded");
    this.name = "ConnectionLimitExceededError";
  }
}

export class ConnectionLimiter implements Extension {
  private readonly maxConnections: number;
  private readonly reservations = new Map<string, Map<string, Reservation>>();

  constructor(maxConnections?: number) {
    this.maxConnections = maxConnections ?? env.MAX_CONNECTIONS_PER_DOCUMENT;
  }

  async onConnect({ documentName, socketId }: onConnectPayload): Promise<void> {
    const documentReservations = this.reservations.get(documentName);
    const current = documentReservations?.size ?? 0;
    if (current >= this.maxConnections) {
      console.warn(
        `[ConnectionLimiter] Rejected connection for document=${documentName} ` +
        `(current=${current}, max=${this.maxConnections})`,
      );
      throw new ConnectionLimitExceededError();
    }

    const reservations = documentReservations ?? new Map<string, Reservation>();
    const expiresAt = setTimeout(() => {
      this.release(documentName, socketId);
    }, HANDSHAKE_RESERVATION_TTL_MS);
    expiresAt.unref?.();

    reservations.set(socketId, { expiresAt });
    this.reservations.set(documentName, reservations);
  }

  async connected({ documentName, socketId, connectionInstance }: connectedPayload): Promise<void> {
    const reservations = this.reservations.get(documentName);
    const reservation = reservations?.get(socketId);
    const isActiveConnection =
      connectionInstance.webSocket.readyState === WEBSOCKET_OPEN_STATE &&
      connectionInstance.document.hasConnection(connectionInstance);

    // `connected` can arrive after the reservation expired, or after a very fast
    // socket close that Hocuspocus observed before registering onDisconnect.
    // Never resurrect either path as an unbounded established connection.
    if (!reservation || !reservations || !isActiveConnection) {
      this.release(documentName, socketId);
      if (isActiveConnection) {
        connectionInstance.close({
          code: HANDSHAKE_TIMEOUT_CLOSE_CODE,
          reason: HANDSHAKE_TIMEOUT_CLOSE_REASON,
        });
      }
      return;
    }

    if (reservation.expiresAt) {
      clearTimeout(reservation.expiresAt);
    }
    reservations.set(socketId, {});
  }

  async onDisconnect({ documentName, socketId }: onDisconnectPayload): Promise<void> {
    this.release(documentName, socketId);
  }

  private release(documentName: string, socketId: string): void {
    const reservations = this.reservations.get(documentName);
    const reservation = reservations?.get(socketId);
    if (!reservations || !reservation) {
      return;
    }

    if (reservation.expiresAt) {
      clearTimeout(reservation.expiresAt);
    }
    reservations.delete(socketId);
    if (reservations.size === 0) {
      this.reservations.delete(documentName);
    }
  }
}

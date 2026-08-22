import { Redis } from "ioredis";
import type { Extension } from "@hocuspocus/server";
import { env } from "../env.js";

const TTL_SECONDS = 180;
const EVENT_MAXLEN = 100_000;

const CONN_PREFIX = "ops:collab:conn:";
const ROOM_PREFIX = "ops:collab:room:";
const EVENT_STREAM = "ops:collab:events";
const CONN_INDEX = "ops:collab:index:connections";
const ROOM_INDEX = "ops:collab:index:rooms";
const ROOM_CONN_PREFIX = "ops:collab:index:room_conn:";
const ROOM_USER_PREFIX = "ops:collab:index:room_user:";

const EVENT_TYPES = new Set([
  "connected",
  "disconnected",
  "store_success",
  "store_failed",
  "store_slow",
  "pubsub_error",
  "stale_connection",
]);

let runtimeRedis: Redis | null = null;

function snapshotEnabled(): boolean {
  return process.env.COLLAB_RUNTIME_SNAPSHOT_ENABLED === "true";
}

function eventSampleEnabled(): boolean {
  return snapshotEnabled() && process.env.COLLAB_EVENT_SAMPLE_ENABLED === "true";
}

function getRedis(): Redis | null {
  if (!snapshotEnabled() || !env.REDIS_URL) return null;
  if (!runtimeRedis) {
    runtimeRedis = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      keepAlive: 30_000,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    runtimeRedis.on("error", (err) => {
      console.warn("[CollabRuntime] Redis error:", err.message);
    });
  }
  return runtimeRedis;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseRoomKey(documentName: string): {
  room_key: string;
  resource_type: string;
  resource_id: string;
} {
  const [prefix, ...rest] = String(documentName || "").split(":");
  const resourceId = rest.join(":");
  const resourceType = resourceId ? prefix : "docs";
  return {
    room_key: resourceId ? `${resourceType}:${resourceId}` : `docs:${documentName}`,
    resource_type: resourceType || "docs",
    resource_id: resourceId || documentName,
  };
}

function connectionId(payload: any): string {
  const raw =
    payload?.connection?.connection?.id ||
    payload?.connection?.id ||
    payload?.socketId ||
    payload?.request?.headers?.["sec-websocket-key"] ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return String(raw).replace(/[^A-Za-z0-9_.:-]/g, ".");
}

function contextOf(payload: any): Record<string, any> {
  return (payload?.context || payload?.connection?.context || {}) as Record<string, any>;
}

function connKey(id: string): string {
  return `${CONN_PREFIX}${id}`;
}

function roomKey(room: string): string {
  return `${ROOM_PREFIX}${room}`;
}

function roomConnKey(room: string): string {
  return `${ROOM_CONN_PREFIX}${room}`;
}

function roomUserKey(room: string): string {
  return `${ROOM_USER_PREFIX}${room}`;
}

function safeJson(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

function sanitizeErrorSignature(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value || "");
  return text
    .replace(/(token|secret|password|authorization|bearer)\s*[:=]\s*[^,\s]+/gi, "$1=[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .slice(0, 120);
}

async function getJson(redis: Redis, key: string): Promise<Record<string, any>> {
  const raw = await redis.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function recordEvent(eventType: string, fields: Record<string, unknown>): Promise<void> {
  if (!eventSampleEnabled() || !EVENT_TYPES.has(eventType)) return;
  const redis = getRedis();
  if (!redis) return;
  const safeFields: Record<string, string> = {
    event_type: eventType,
    created_at: nowIso(),
  };
  const allowed = [
    "connection_id",
    "user_id",
    "resource_type",
    "resource_id",
    "room_key",
    "instance_id",
    "client_type",
    "status",
    "error_type",
    "error_signature",
  ];
  for (const key of allowed) {
    const value = fields[key];
    if (value !== undefined && value !== null) safeFields[key] = String(value);
  }
  await redis.xadd(EVENT_STREAM, "MAXLEN", "~", EVENT_MAXLEN, "*", ...Object.entries(safeFields).flat());
}

async function updateRoomSnapshot(
  redis: Redis,
  room: ReturnType<typeof parseRoomKey>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = Date.now() / 1000;
  await redis.zremrangebyscore(roomConnKey(room.room_key), "-inf", now - TTL_SECONDS);
  await redis.zremrangebyscore(roomUserKey(room.room_key), "-inf", now - TTL_SECONDS);
  const [activeConnections, activeUserMembers, previous] = await Promise.all([
    redis.zcard(roomConnKey(room.room_key)),
    redis.zrange(roomUserKey(room.room_key), 0, -1),
    getJson(redis, roomKey(room.room_key)),
  ]);
  const activeUsers = new Set(
    activeUserMembers.map((member) => String(member).split(":", 1)[0]).filter(Boolean),
  ).size;
  const snapshot = {
    room_key: room.room_key,
    resource_type: room.resource_type,
    resource_id: room.resource_id,
    active_connections: activeConnections,
    active_users: activeUsers,
    instance_id: env.SERVER_NAME,
    last_store_at: previous.last_store_at || "",
    store_failed_count: Number(previous.store_failed_count || 0),
    store_slow_count: Number(previous.store_slow_count || 0),
    redis_pubsub_status: previous.redis_pubsub_status || "unknown",
    status: activeConnections > 0 ? "active" : "idle",
    ...extra,
  };
  await redis
    .multi()
    .set(roomKey(room.room_key), safeJson(snapshot), "EX", TTL_SECONDS)
    .zadd(ROOM_INDEX, now, room.room_key)
    .zremrangebyscore(ROOM_INDEX, "-inf", now - TTL_SECONDS)
    .expire(ROOM_INDEX, TTL_SECONDS)
    .expire(roomConnKey(room.room_key), TTL_SECONDS)
    .expire(roomUserKey(room.room_key), TTL_SECONDS)
    .exec();
}

async function refreshRoomConnectionsFromInstance(redis: Redis, payload: any): Promise<void> {
  const documentName = payload?.documentName || "";
  const room = parseRoomKey(documentName);
  const hocusDoc = payload?.instance?.documents?.get?.(documentName);
  const connections = typeof hocusDoc?.getConnections === "function"
    ? hocusDoc.getConnections()
    : (hocusDoc?.connections || []);
  const now = Date.now() / 1000;
  const multi = redis.multi();
  for (const conn of connections) {
    const ctx = contextOf({ connection: conn });
    const id = connectionId({ connection: conn });
    const userId = String(ctx.userId || ctx.editorId || "");
    if (!id) continue;
    const previous = await getJson(redis, connKey(id));
    const snapshot = {
      ...previous,
      connection_id: id,
      user_id: userId,
      resource_type: room.resource_type,
      resource_id: room.resource_id,
      room_key: room.room_key,
      instance_id: env.SERVER_NAME,
      client_type: String(ctx.editorType || previous.client_type || "user"),
      connected_at: previous.connected_at || nowIso(),
      last_seen_at: nowIso(),
      status: "connected",
    };
    multi.set(connKey(id), safeJson(snapshot), "EX", TTL_SECONDS);
    multi.zadd(CONN_INDEX, now, id);
    multi.zadd(roomConnKey(room.room_key), now, id);
    multi.zadd(roomUserKey(room.room_key), now, `${userId || id}:${id}`);
  }
  await multi.exec();
  await updateRoomSnapshot(redis, room);
}

export async function recordCollabStore(
  documentName: string,
  status: "store_success" | "store_failed" | "store_slow",
  options: { latencyMs?: number; error?: unknown } = {},
): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const room = parseRoomKey(documentName);
    const previous = await getJson(redis, roomKey(room.room_key));
    const extra: Record<string, unknown> = {
      last_store_at: nowIso(),
      status: status === "store_success" ? "active" : "warning",
      store_failed_count:
        Number(previous.store_failed_count || 0) + (status === "store_failed" ? 1 : 0),
      store_slow_count:
        Number(previous.store_slow_count || 0) + (status === "store_slow" ? 1 : 0),
    };
    await updateRoomSnapshot(redis, room, extra);
    await recordEvent(status, {
      ...room,
      instance_id: env.SERVER_NAME,
      status,
      error_type: options.error instanceof Error ? options.error.name : "",
      error_signature: options.error ? sanitizeErrorSignature(options.error) : "",
    });
  } catch (err) {
    console.warn("[CollabRuntime] store sample skipped:", err instanceof Error ? err.message : String(err));
  }
}

export async function recordCollabPubsubError(documentName: string, error: unknown): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const room = parseRoomKey(documentName);
    await updateRoomSnapshot(redis, room, { redis_pubsub_status: "error", status: "warning" });
    await recordEvent("pubsub_error", {
      ...room,
      instance_id: env.SERVER_NAME,
      status: "warning",
      error_type: error instanceof Error ? error.name : "Error",
      error_signature: sanitizeErrorSignature(error),
    });
  } catch (err) {
    console.warn("[CollabRuntime] pubsub sample skipped:", err instanceof Error ? err.message : String(err));
  }
}

export class RuntimeSnapshotExtension implements Extension {
  async onConnect(payload: any): Promise<void> {
    try {
      const redis = getRedis();
      if (!redis) return;
      const room = parseRoomKey(payload?.documentName || "");
      const ctx = contextOf(payload);
      const id = connectionId(payload);
      const now = Date.now() / 1000;
      const snapshot = {
        connection_id: id,
        user_id: String(ctx.userId || ctx.editorId || ""),
        resource_type: room.resource_type,
        resource_id: room.resource_id,
        room_key: room.room_key,
        instance_id: env.SERVER_NAME,
        client_type: String(ctx.editorType || "user"),
        connected_at: nowIso(),
        last_seen_at: nowIso(),
        status: "connected",
      };
      await redis
        .multi()
        .set(connKey(id), safeJson(snapshot), "EX", TTL_SECONDS)
        .zadd(CONN_INDEX, now, id)
        .zremrangebyscore(CONN_INDEX, "-inf", now - TTL_SECONDS)
        .expire(CONN_INDEX, TTL_SECONDS)
        .zadd(roomConnKey(room.room_key), now, id)
        .zadd(roomUserKey(room.room_key), now, `${snapshot.user_id || id}:${id}`)
        .exec();
      await updateRoomSnapshot(redis, room, { redis_pubsub_status: "unknown" });
      await recordEvent("connected", snapshot);
    } catch (err) {
      console.warn("[CollabRuntime] connect sample skipped:", err instanceof Error ? err.message : String(err));
    }
  }

  async onDisconnect(payload: any): Promise<void> {
    try {
      const redis = getRedis();
      if (!redis) return;
      const room = parseRoomKey(payload?.documentName || "");
      const id = connectionId(payload);
      const ctx = contextOf(payload);
      const previous = await getJson(redis, connKey(id));
      previous.status = "disconnected";
      previous.last_seen_at = nowIso();
      await redis
        .multi()
        .set(connKey(id), safeJson(previous), "EX", TTL_SECONDS)
        .zrem(roomConnKey(room.room_key), id)
        .zrem(roomUserKey(room.room_key), `${String(ctx.userId || ctx.editorId || id)}:${id}`)
        .exec();
      await updateRoomSnapshot(redis, room);
      await recordEvent("disconnected", {
        ...room,
        connection_id: id,
        user_id: String(ctx.userId || ctx.editorId || ""),
        instance_id: env.SERVER_NAME,
        client_type: String(ctx.editorType || "user"),
        status: "disconnected",
      });
    } catch (err) {
      console.warn("[CollabRuntime] disconnect sample skipped:", err instanceof Error ? err.message : String(err));
    }
  }

  async onStoreDocument(payload: any): Promise<void> {
    // Store outcome and latency are recorded in database extensions where the
    // actual Django round-trip is measured.
    try {
      const redis = getRedis();
      if (!redis) return;
      await refreshRoomConnectionsFromInstance(redis, payload);
    } catch (err) {
      console.warn("[CollabRuntime] store refresh skipped:", err instanceof Error ? err.message : String(err));
    }
  }
}

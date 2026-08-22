/**
 * Agent route handler for Daemon CLI Server.
 *
 * Proxies Agent operations to Django Conversation API and provides
 * SSE streaming by bridging the Django WS Gateway.
 *
 * Routes:
 *   POST /agent/session/create — Create a new conversation session
 *   GET  /agent/session        — Get session info by session_id
 *   POST /agent/fork           — Fork a session (create branch with full history)
 *   GET  /agent/threads        — List conversation sessions
 *   GET  /agent/models         — List available LLM models
 *   GET  /agent/stream         — SSE stream (bridges WS Gateway events)
 *
 * M5.Y 注记：老 `POST /agent/message` / `POST /agent/chat` 路径走 `/api/chat/sessions/{id}/messages`
 * 的 chat endpoint，已随 Django chat 入口一并 410。Daemon 实时对话请改走 prompt.forward
 * WS 通道（DaemonAgentHost 驱动本地 Runtime）。
 */

import http from 'node:http';
import WebSocket from 'ws';
import { mapWsEventToSse, proxyChatSessionFork, isSuccessfulHttpStatus } from '@tabtin/agent-wire';
import { djangoRequest, errorResponse, okResponse, type SendJSON } from '../shared/error-handler.js';
import type { CliRequestContext } from '../../cli-context.js';

const LOG_TAG = '[CLI Agent]';

const STREAM_EVENT_PREFIX = 'agent.stream.';

function parseQueryParams(url: string): Record<string, string> {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(url.slice(qIdx))) {
    params[key] = value;
  }
  return params;
}

function resolveSpaceId(query: Record<string, string>, body: any, context: CliRequestContext): string | null {
  return query.space_id || body?.space_id || context.getSpaceId();
}

function resolveGatewayWsUrl(wsInfo: { wsUrl: string; serverUrl: string }): string {
  if (wsInfo.wsUrl) {
    const base = wsInfo.wsUrl.replace(/\/+$/, '');
    // CT-020: 若 wsUrl 已携带完整路径，不重复追加 /ws/v1/gateway
    if (base.endsWith('/ws/v1/gateway')) {
      return base;
    }
    return `${base}/ws/v1/gateway`;
  }
  let base = wsInfo.serverUrl.replace(/\/+$/, '');
  // Strip /api suffix (server_url often includes it)
  base = base.replace(/\/api$/, '');
  if (base.startsWith('https://')) {
    base = base.replace(/^https:/, 'wss:');
  } else if (base.startsWith('http://')) {
    base = base.replace(/^http:/, 'ws:');
  }
  return `${base}/ws/v1/gateway`;
}

export async function handleAgentRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const qIdx = url.indexOf('?');
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
  const route = pathname.replace(/^\/agent/, '');
  const query = parseQueryParams(url);
  const exactRouteHandlers: Record<string, () => Promise<void>> = {
    'POST /session/create': () => handleSessionCreate(query, body, res, sendJSON, cliContext),
    'GET /session': () => handleSessionGet(query, res, sendJSON),
    'GET /threads': () => handleThreads(query, body, res, sendJSON, cliContext),
    'GET /models': () => handleModels(query, res, sendJSON, cliContext),
    'GET /stream': () => handleStream(query, res, cliContext),
    'POST /fork': () => handleFork(body, res, sendJSON),
    'GET /sessions': () => handleSessions(query, res, sendJSON, cliContext),
  };
  const exactHandler = exactRouteHandlers[`${method} ${route}`];
  if (exactHandler) {
    await exactHandler();
    return;
  }

  // W0（2026-05-30）：本地取消单个子 Agent。区别于 `DELETE /sessions/:id`
  // （走 Django abort 整个 session），本路由直连本进程 host 的
  // cancelSubagentById——子 Agent registry 是 query 所在进程的模块内状态。
  const subagentCancelMatch = route.match(/^\/subagents\/([^/]+)$/);
  if (subagentCancelMatch && method === 'DELETE') {
    handleSubagentCancel(decodeURIComponent(subagentCancelMatch[1]), res, sendJSON, cliContext);
    return;
  }

  const cancelMatch = route.match(/^\/sessions\/([^/]+)$/);
  if (cancelMatch && method === 'DELETE') {
    await handleCancel(cancelMatch[1], res, sendJSON);
    return;
  }

  console.warn(`${LOG_TAG} Unknown route: ${url}`);
  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown agent route: ${url}`));
}

// ── POST /agent/session/create ────────────────────────────────────

async function handleSessionCreate(
  query: Record<string, string>,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const spaceId = resolveSpaceId(query, body, cliContext);
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'));
    return;
  }

  const modelId: string | undefined = body?.model_id;

  try {
    const result = await djangoRequest('POST', '/api/chat/sessions', {
      space_id: spaceId,
      ...(modelId ? { model_id: modelId } : {}),
    }, { logTag: LOG_TAG });

    if (result.status >= 400) {
      sendJSON(res, result.status, result.data);
      return;
    }

    const sessionId = result.data?.data?.id;
    const threadId = result.data?.data?.thread_id || null;

    if (!sessionId) {
      sendJSON(res, 502, errorResponse('UNAVAILABLE', '创建会话失败：未返回 session_id'));
      return;
    }

    sendJSON(res, 200, okResponse({ session_id: sessionId, thread_id: threadId }));
  } catch (err: any) {
    console.error(`${LOG_TAG} handleSessionCreate error:`, err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'));
  }
}

// ── GET /agent/session ───────────────────────────────────────────

async function handleSessionGet(
  query: Record<string, string>,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const sessionId = query.session_id;
  if (!sessionId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 session_id'));
    return;
  }

  try {
    const result = await djangoRequest(
      'GET',
      `/api/chat/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      { logTag: LOG_TAG },
    );

    if (result.status >= 400) {
      sendJSON(res, result.status, result.data);
      return;
    }

    const data = result.data?.data ?? result.data;
    sendJSON(res, 200, okResponse({
      session_id: data?.id || sessionId,
      thread_id: data?.thread_id || null,
    }));
  } catch (err: any) {
    console.error(`${LOG_TAG} handleSessionGet error:`, err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'));
  }
}

// ── GET /agent/threads ───────────────────────────────────────────

async function handleThreads(
  query: Record<string, string>,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const spaceId = resolveSpaceId(query, body, cliContext);
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'));
    return;
  }

  const limit = parseInt(query.limit || '20', 10);
  const offset = parseInt(query.offset || '0', 10);

  try {
    const result = await djangoRequest(
      'GET',
      `/api/chat/sessions?space_id=${encodeURIComponent(spaceId)}&limit=${limit}&offset=${offset}`,
      undefined,
      { logTag: LOG_TAG },
    );

    if (result.status >= 400) {
      sendJSON(res, result.status, result.data);
      return;
    }

    const sessions = result.data?.data?.sessions || [];
    const total = result.data?.data?.total || 0;

    sendJSON(res, 200, okResponse({
      sessions: sessions.map((s: any) => ({
        id: s.id,
        title: s.title || '',
        thread_id: s.thread_id || null,
        current_model_name: s.current_model_name || null,
        message_count: s.message_count ?? 0,
        last_message_preview: s.last_message_preview || null,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
      total,
    }));
  } catch (err: any) {
    console.error(`${LOG_TAG} handleThreads error:`, err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'));
  }
}

// ── GET /agent/models ────────────────────────────────────────────

async function handleModels(
  query: Record<string, string>,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  try {
    const wsInfo = cliContext.getWsConnectionInfo();
    const qs = buildModelCatalogQuery(wsInfo?.organizationId);

    const result = await djangoRequest(
      'GET',
      `/api/services/llm/catalog${qs}`,
      undefined,
      { logTag: LOG_TAG },
    );

    if (result.status >= 400) {
      sendJSON(res, result.status, result.data);
      return;
    }

    const models = normalizeCatalogModels(result.data?.data?.models);
    const defaultModelId = result.data?.data?.default_model_id || null;
    markDefaultModel(models, defaultModelId);

    sendJSON(res, 200, okResponse({ models }));
  } catch (err: any) {
    console.error(`${LOG_TAG} handleModels error:`, err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'));
  }
}

function buildModelCatalogQuery(organizationId?: string): string {
  return organizationId
    ? `?organization_id=${encodeURIComponent(organizationId)}&use_case=chat`
    : '?use_case=chat';
}

interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  is_default: boolean;
}

function normalizeCatalogModels(rawModels: any): CatalogModel[] {
  return (rawModels || []).map((model: any) => ({
    id: model.id || model.model_id || '',
    name: model.display_name || model.name || '',
    provider: model.provider || '',
    is_default: !!model.is_default,
  }));
}

function markDefaultModel(models: CatalogModel[], defaultModelId: string | null): void {
  if (!defaultModelId || models.some(model => model.is_default)) return;
  const target = models.find(model => model.id === defaultModelId);
  if (target) target.is_default = true;
}

// ── WS→SSE bridge ────────────────────────────────────────────────

const AUTH_TIMEOUT_MS = 10_000;

interface BridgeWsToSseOptions {
  idPrefix?: string;
}

/**
 * Shared WS→SSE bridge: connects to Gateway WS, authenticates, subscribes to
 * the given threadId topic, and forwards agent-stream events as SSE.
 * Writes SSE headers automatically when they haven't been sent yet.
 */
function bridgeWsToSse(
  res: http.ServerResponse,
  wsInfo: { wsUrl: string; serverUrl: string; credential: string; organizationId: string; fingerprint: string },
  threadId: string,
  opts?: BridgeWsToSseOptions,
): void {
  const idPrefix = opts?.idPrefix ?? 'cli';
  const wsUrl = resolveGatewayWsUrl(wsInfo);

  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders();
  }

  let ws: WebSocket | null = null;
  let closed = false;
  let receivedDone = false;
  let authTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let heartbeatId: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null; }
    if (authTimeoutId) { clearTimeout(authTimeoutId); authTimeoutId = null; }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try { ws.close(); } catch { /* ignore */ }
    }
    if (!res.writableEnded) {
      try { res.end(); } catch { /* ignore */ }
    }
  };

  res.on('close', cleanup);

  const writeSseEvent = (type: string, data: any) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* ignore */ }
  };

  heartbeatId = setInterval(() => {
    if (!closed && !res.writableEnded) {
      try { res.write(': heartbeat\n\n'); } catch { /* ignore */ }
    }
  }, 15_000);

  try {
    ws = new WebSocket(wsUrl);

    ws.on('error', (err) => {
      console.error(`${LOG_TAG} [${idPrefix}] WS error:`, err.message);
      writeSseEvent('error', { type: 'error', message: `WS 连接错误: ${err.message}`, code: 'WS_ERROR' });
      cleanup();
    });

    ws.on('close', (code) => {
      if (authTimeoutId) { clearTimeout(authTimeoutId); authTimeoutId = null; }
      if (!closed && !receivedDone) {
        writeSseEvent('error', { type: 'error', message: `连接意外断开 (code: ${code})`, code: 'WS_DISCONNECTED' });
      }
      cleanup();
    });

    ws.on('open', () => {
      ws!.send(JSON.stringify({
        v: 1,
        type: 'auth',
        request_id: `${idPrefix}-auth-${Date.now()}`,
        ts: Math.floor(Date.now() / 1000),
        device_id: wsInfo.fingerprint || `daemon-${idPrefix}-${process.pid}`,
        role: 'daemon',
        payload: {
          access_token: wsInfo.credential,
          organization_id: wsInfo.organizationId,
          capabilities: ['agent.stream'],
        },
      }));

      authTimeoutId = setTimeout(() => {
        if (!closed) {
          console.warn(`${LOG_TAG} [${idPrefix}] WS auth 超时，Gateway 未在 ${AUTH_TIMEOUT_MS}ms 内响应`);
          writeSseEvent('error', { type: 'error', message: 'WS 认证超时，Gateway 未响应', code: 'AUTH_TIMEOUT' });
          cleanup();
        }
      }, AUTH_TIMEOUT_MS);
    });

    ws.on('message', (raw) => {
      if (closed) return;
      try {
        const envelope = JSON.parse(raw.toString());

        if (envelope.type === 'auth.ok') {
          if (authTimeoutId) { clearTimeout(authTimeoutId); authTimeoutId = null; }
          ws!.send(JSON.stringify({
            v: 1,
            type: 'subscribe',
            request_id: `${idPrefix}-sub-${Date.now()}`,
            ts: Math.floor(Date.now() / 1000),
            device_id: wsInfo.fingerprint || `daemon-${idPrefix}-${process.pid}`,
            role: 'daemon',
            payload: { topics: [`agent.stream.${threadId}`] },
          }));
          writeSseEvent('status', { type: 'status', message: 'connected' });
          return;
        }

        if (envelope.type === 'auth.error') {
          writeSseEvent('error', { type: 'error', message: '认证失败', code: 'AUTH_FAILED' });
          cleanup();
          return;
        }

        if (envelope.type === 'subscribe.ok') {
          writeSseEvent('status', { type: 'status', message: 'subscribed' });
          return;
        }

        if (envelope.type === 'subscribe.error') {
          const reason = envelope.payload?.message || envelope.message || '订阅失败';
          writeSseEvent('error', { type: 'error', message: `订阅失败: ${reason}`, code: 'SUBSCRIBE_FAILED' });
          cleanup();
          return;
        }

        processStreamEnvelope(envelope, writeSseEvent, () => {
          receivedDone = true;
          cleanup();
        });
      } catch { /* malformed WS message */ }
    });
  } catch (err: any) {
    console.error(`${LOG_TAG} [${idPrefix}] WS bridge setup error:`, err);
    writeSseEvent('error', { type: 'error', message: err?.message || 'Stream setup failed', code: 'INTERNAL_ERROR' });
    cleanup();
  }
}

function processStreamEnvelope(
  envelope: any,
  writeSseEvent: (event: string, data: unknown) => void,
  onDone: () => void,
): void {
  if (typeof envelope.type !== 'string' || !envelope.type.startsWith(STREAM_EVENT_PREFIX)) return;
  const sseEvent = mapWsEventToSse(envelope);
  if (!sseEvent) return;
  writeSseEvent(sseEvent.type, sseEvent);
  if (sseEvent.type === 'done') onDone();
}

// ── GET /agent/stream (SSE) ──────────────────────────────────────

async function handleStream(
  query: Record<string, string>,
  res: http.ServerResponse,
  cliContext: CliRequestContext,
): Promise<void> {
  const threadId = query.thread_id;

  if (!threadId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse('VALIDATION_ERROR', '缺少 thread_id')));
    return;
  }

  const wsInfo = cliContext.getWsConnectionInfo();
  if (!wsInfo) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse('INTERNAL_ERROR', 'Daemon WS 连接信息未配置')));
    return;
  }

  bridgeWsToSse(res, wsInfo, threadId, { idPrefix: 'cli-stream' });
}

// ── DELETE /agent/sessions/:id ───────────────────────────────────

async function handleCancel(
  sessionId: string,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  try {
    const result = await djangoRequest(
      'POST',
      `/api/chat/sessions/${sessionId}/abort`,
      {},
      { logTag: LOG_TAG },
    );

    if (result.status >= 400) {
      sendJSON(res, result.status, result.data);
      return;
    }

    sendJSON(res, 200, okResponse({ cancelled: true }));
  } catch (err: any) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Cancel failed'));
  }
}

// ── DELETE /agent/subagents/:childId（本地子 Agent 取消，W0）─────────

function handleSubagentCancel(
  childId: string,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): void {
  if (!childId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 child_id'));
    return;
  }

  const resolver = cliContext.getSubagentCancelResolver();
  if (!resolver) {
    // daemon 未起 local agent host（resolver 未注入）。
    sendJSON(res, 503, errorResponse('UNAVAILABLE', '本地 Agent 运行时不可用'));
    return;
  }

  const cancelled = resolver(childId);
  if (cancelled) {
    sendJSON(res, 200, okResponse({ cancelled: true }));
  } else {
    // childId 不在本进程（已完成 / 错进程 / 不存在）。404 让调用方明确"没命中"。
    sendJSON(res, 404, errorResponse('NOT_FOUND', `子 Agent 未找到或已结束: ${childId}`));
  }
}

// ── GET /agent/sessions ──────────────────────────────────────────

async function handleSessions(
  query: Record<string, string>,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  cliContext: CliRequestContext,
): Promise<void> {
  const spaceId = resolveSpaceId(query, undefined, cliContext);
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'));
    return;
  }

  try {
    const result = await djangoRequest(
      'GET',
      `/api/chat/sessions?space_id=${encodeURIComponent(spaceId)}&limit=20`,
      undefined,
      { logTag: LOG_TAG },
    );

    if (result.status >= 400) {
      sendJSON(res, result.status, result.data);
      return;
    }

    sendJSON(res, 200, okResponse(result.data?.data ?? result.data));
  } catch (err: any) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Failed to list sessions'));
  }
}

// ── POST /agent/fork ─────────────────────────────────────────────

async function handleFork(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  try {
    const outcome = await proxyChatSessionFork(djangoRequest, body, LOG_TAG);
    if (outcome.kind === 'bad_request') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', outcome.message));
      return;
    }
    const { response: result } = outcome;
    if (!isSuccessfulHttpStatus(result.status)) {
      sendJSON(res, result.status, result.data);
      return;
    }
    sendJSON(res, 200, result.data);
  } catch (err: any) {
    console.error(`${LOG_TAG} handleFork error:`, err);
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'));
  }
}

// mapWsEventToSse imported from @tabtin/agent-wire (single source of truth)

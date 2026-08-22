/**
 * Agent route handler for Electron CLI Server.
 *
 * Proxies Agent operations to Django Conversation API and provides
 * SSE streaming by bridging the Django WS Gateway.
 *
 * Routes:
 *   POST /agent/session/create — Create a new conversation session
 *   GET  /agent/threads        — List conversation sessions
 *   GET  /agent/models         — List available LLM models
 *   GET  /agent/stream         — SSE stream (bridges WS Gateway events)
 *   POST /agent/fork           — Fork a session (create branch with full history)
 *
 * M5.Y 注记：旧的 `POST /agent/message`（通过 `/api/chat/sessions/{id}/messages`
 * 发送消息）与 `POST /messages/answer/` 已随 Django chat endpoint shell 下线而
 * 一并删除。CLI 实时对话请改走 renderer 本地 Runtime 或 Daemon WS prompt.forward。
 */

import http from 'node:http'
import WebSocket from 'ws'
import { okResponse, mapWsEventToSse, proxyChatSessionFork, isSuccessfulHttpStatus } from '@tabtin/agent-wire'
import { djangoRequest, errorResponse, type SendJSON } from './shared/error-handler'
import { getCLISpaceId, getCLIOrganizationId } from '../cli-context'
import { TokenManager } from '../../auth'
import { WS_BASE_URL } from '../../config/api'
import { createLogger } from '../../logger'

const log = createLogger('CLIAgent')
const LOG_TAG = '[CLI Agent]'

const STREAM_EVENT_PREFIX = 'agent.stream.'


function parseQueryParams(url: string): Record<string, string> {
  const qIdx = url.indexOf('?')
  if (qIdx === -1) return {}
  const params: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(url.slice(qIdx))) {
    params[key] = value
  }
  return params
}

function resolveSpaceId(query: Record<string, string>, body?: any): string | null {
  return query.space_id || body?.space_id || getCLISpaceId() || null
}

export async function handleAgentRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const qIdx = url.indexOf('?')
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx)
  const route = pathname.replace(/^\/agent/, '')
  const query = parseQueryParams(url)

  if (route === '/session/create' && method === 'POST') {
    await handleSessionCreate(body, res, sendJSON)
    return
  }

  if (route === '/threads' && method === 'GET') {
    await handleThreads(query, body, res, sendJSON)
    return
  }

  if (route === '/models' && method === 'GET') {
    await handleModels(query, res, sendJSON)
    return
  }

  if (route === '/stream' && method === 'GET') {
    await handleStream(query, res)
    return
  }

  if (route === '/fork' && method === 'POST') {
    await handleFork(body, res, sendJSON)
    return
  }

  log.warn(`未知路由: ${method} ${url}`)
  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown agent route: ${url}`))
}

// ── POST /agent/session/create ──────────────────────────────────

async function handleSessionCreate(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const spaceId = body?.space_id || getCLISpaceId()
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
    return
  }

  const modelId: string | undefined = body?.model_id

  try {
    const createResult = await djangoRequest('POST', '/api/chat/sessions', {
      space_id: spaceId,
      ...(modelId ? { model_id: modelId } : {}),
    }, { logTag: LOG_TAG })

    if (createResult.status !== 200 && createResult.status !== 201) {
      sendJSON(res, createResult.status, createResult.data)
      return
    }

    const sessionId = createResult.data?.data?.id
    const threadId = createResult.data?.data?.thread_id || null

    if (!sessionId) {
      sendJSON(res, 502, errorResponse('UNAVAILABLE', '创建会话失败：未返回 session_id'))
      return
    }

    sendJSON(res, 200, okResponse({
      session_id: sessionId,
      thread_id: threadId,
    }))
  } catch (err: any) {
    log.error('handleSessionCreate 失败:', err)
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'))
  }
}

// ── GET /agent/threads ───────────────────────────────────────────

async function handleThreads(
  query: Record<string, string>,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const spaceId = resolveSpaceId(query, body)
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
    return
  }

  const limit = parseInt(query.limit || '20', 10)
  const offset = parseInt(query.offset || '0', 10)

  try {
    const result = await djangoRequest(
      'GET',
      `/api/chat/sessions?space_id=${encodeURIComponent(spaceId)}&limit=${limit}&offset=${offset}`,
      undefined,
      { logTag: LOG_TAG },
    )

    if (result.status !== 200) {
      sendJSON(res, result.status, result.data)
      return
    }

    const sessions = result.data?.data?.sessions || []
    const total = result.data?.data?.total || 0

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
    }))
  } catch (err: any) {
    log.error('handleThreads 失败:', err)
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'))
  }
}

// ── GET /agent/models ────────────────────────────────────────────

async function handleModels(
  query: Record<string, string>,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  try {
    const organizationId = getCLIOrganizationId() || ''
    const qs = organizationId
      ? `?organization_id=${encodeURIComponent(organizationId)}&use_case=chat`
      : '?use_case=chat'

    const result = await djangoRequest(
      'GET',
      `/api/services/llm/catalog${qs}`,
      undefined,
      { logTag: LOG_TAG },
    )

    if (result.status !== 200) {
      sendJSON(res, result.status, result.data)
      return
    }

    const models = (result.data?.data?.models || []).map((m: any) => ({
      id: m.id || m.model_id || '',
      name: m.display_name || m.name || '',
      provider: m.provider || '',
      is_default: !!(m.is_default),
    }))
    const defaultModelId = result.data?.data?.default_model_id || null

    if (defaultModelId && !models.some((m: any) => m.is_default)) {
      const target = models.find((m: any) => m.id === defaultModelId)
      if (target) target.is_default = true
    }

    sendJSON(res, 200, okResponse({ models }))
  } catch (err: any) {
    log.error('handleModels 失败:', err)
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'))
  }
}

// ── GET /agent/stream (SSE) ──────────────────────────────────────

const AUTH_TIMEOUT_MS = 10_000

async function handleStream(
  query: Record<string, string>,
  res: http.ServerResponse,
): Promise<void> {
  const threadId = query.thread_id

  if (!threadId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(errorResponse('VALIDATION_ERROR', '缺少 thread_id')))
    return
  }

  const accessToken = await TokenManager.getAccessToken()
  if (!accessToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(errorResponse('UNAUTHORIZED', '未登录')))
    return
  }

  const organizationId = getCLIOrganizationId() || ''

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  })
  res.flushHeaders()

  const wsUrl = new URL('/ws/v1/gateway', WS_BASE_URL).toString()
  let ws: WebSocket | null = null
  let closed = false
  let receivedDone = false
  let authTimeoutId: ReturnType<typeof setTimeout> | null = null
  let heartbeatId: ReturnType<typeof setInterval> | null = null

  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeatId) {
      clearInterval(heartbeatId)
      heartbeatId = null
    }
    if (authTimeoutId) {
      clearTimeout(authTimeoutId)
      authTimeoutId = null
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try { ws.close() } catch { /* ignore */ }
    }
    if (!res.writableEnded) {
      try { res.end() } catch { /* ignore */ }
    }
  }

  res.on('close', cleanup)

  const writeSseEvent = (type: string, data: any) => {
    if (closed || res.writableEnded) return
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch { /* ignore */ }
  }

  heartbeatId = setInterval(() => {
    if (!closed && !res.writableEnded) {
      try { res.write(': heartbeat\n\n') } catch { /* ignore */ }
    }
  }, 15_000)

  try {
    ws = new WebSocket(wsUrl)

    ws.on('error', (err) => {
      log.error(`Stream WS 错误 threadId=${threadId}:`, err.message)
      writeSseEvent('error', { type: 'error', message: `WS 连接错误: ${err.message}` })
      cleanup()
    })

    ws.on('close', (code) => {
      if (authTimeoutId) {
        clearTimeout(authTimeoutId)
        authTimeoutId = null
      }
      if (!closed && !receivedDone) {
        writeSseEvent('error', {
          type: 'error',
          message: `连接意外断开 (code: ${code})`,
          code: 'WS_DISCONNECTED',
        })
      }
      cleanup()
    })

    ws.on('open', () => {
      ws!.send(JSON.stringify({
        v: 1,
        type: 'auth',
        request_id: `cli-auth-${Date.now()}`,
        ts: Math.floor(Date.now() / 1000),
        device_id: `cli-stream-${process.pid}`,
        role: 'electron',
        payload: {
          access_token: accessToken,
          organization_id: organizationId,
          capabilities: ['agent.stream'],
        },
      }))

      authTimeoutId = setTimeout(() => {
        if (!closed) {
          log.warn(`WS auth 超时，Gateway 未在 ${AUTH_TIMEOUT_MS}ms 内响应`)
          writeSseEvent('error', {
            type: 'error',
            message: 'WS 认证超时，Gateway 未响应',
            code: 'AUTH_TIMEOUT',
          })
          cleanup()
        }
      }, AUTH_TIMEOUT_MS)
    })

    ws.on('message', (raw) => {
      if (closed) return
      try {
        const envelope = JSON.parse(raw.toString())

        if (envelope.type === 'auth.ok') {
          if (authTimeoutId) {
            clearTimeout(authTimeoutId)
            authTimeoutId = null
          }
          ws!.send(JSON.stringify({
            v: 1,
            type: 'subscribe',
            request_id: `cli-sub-${Date.now()}`,
            ts: Math.floor(Date.now() / 1000),
            device_id: `cli-stream-${process.pid}`,
            role: 'electron',
            payload: { topics: [`agent.stream.${threadId}`] },
          }))
          writeSseEvent('status', { type: 'status', message: 'connected' })
          return
        }

        if (envelope.type === 'auth.error') {
          writeSseEvent('error', { type: 'error', message: '认证失败', code: 'AUTH_FAILED' })
          cleanup()
          return
        }

        if (envelope.type === 'subscribe.ok') {
          writeSseEvent('status', { type: 'status', message: 'subscribed' })
          return
        }

        if (envelope.type === 'subscribe.error') {
          const reason = envelope.payload?.message || envelope.message || '订阅失败'
          writeSseEvent('error', { type: 'error', message: `订阅失败: ${reason}`, code: 'SUBSCRIBE_FAILED' })
          cleanup()
          return
        }

        if (typeof envelope.type === 'string' && envelope.type.startsWith(STREAM_EVENT_PREFIX)) {
          const sseEvent = mapWsEventToSse(envelope)
          if (sseEvent) {
            writeSseEvent(sseEvent.type, sseEvent)
            if (sseEvent.type === 'done') {
              receivedDone = true
              cleanup()
            }
          }
        }
      } catch {
        // malformed message, ignore
      }
    })
  } catch (err: any) {
    log.error(`Stream setup 失败 threadId=${threadId}:`, err)
    writeSseEvent('error', { type: 'error', message: err?.message || 'Stream setup failed' })
    cleanup()
  }
}

// ── POST /agent/fork ─────────────────────────────────────────────

async function handleFork(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  try {
    const outcome = await proxyChatSessionFork(djangoRequest, body, LOG_TAG)
    if (outcome.kind === 'bad_request') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', outcome.message))
      return
    }
    const { response: result } = outcome
    if (!isSuccessfulHttpStatus(result.status)) {
      sendJSON(res, result.status, result.data)
      return
    }
    sendJSON(res, 200, result.data)
  } catch (err: any) {
    log.error('handleFork 失败:', err)
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || 'Internal error'))
  }
}

// mapWsEventToSse imported from @tabtin/agent-wire (single source of truth)

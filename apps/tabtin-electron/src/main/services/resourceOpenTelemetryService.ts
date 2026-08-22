/**
 * resourceOpenTelemetryService — 主进程 resource_open 埋点上报通路（W7）。
 *
 * 业务目标（专题"Agent 产物在 Space 内的打开" PRD §6 + RFC v1.0 §8 + 总控 §2 W7）：
 *   收集 renderer 通过 IPC `telemetry:resource-open:emit` 发来的事件，批量上报到
 *   Django `/api/services/telemetry/resource-open/batch`，让 PM 在上线 14 天后跑
 *   `python scripts/telemetry/resource_open_sample.py --days 14 --json` 拿到
 *   PRD §6 标准 1（≥ 80% Space 内可见率）+ 标准 2（无静默 deny）真实数字。
 *
 * 设计取向（D8 红线 + RFC §8.3）：
 *   - **fire-and-forget**：renderer 调 IPC 后立刻返回（`{ok:true}` 占位，调用方
 *     可忽略），永不阻塞业务路径
 *   - **批量 + 阈值**：单次 flush 上限 `MAX_BATCH_SIZE`（与服务端对齐，100）；
 *     队列长度达 `FLUSH_THRESHOLD`（100）即立即异步 flush；其余靠 5s 定时器
 *     兜底（由 startup-services.ts 配置）
 *   - **重试策略**：5xx / network 按指数退避重试至 `RETRY_ATTEMPTS`（3）次；
 *     **4xx 立即 fatal**（schema 校验失败 / JWT 失效 / 权限不足都不会因重试好转）
 *   - **死信文件**：失败事件落 `userData/telemetry/resource_open_dlq.jsonl`
 *     （NDJSON，每行一条），>10MB 自动 rotate 到 `.old`——给运维人工对账
 *   - **flushing 锁**：同时多次调 flush 只跑一次，避免 5s timer + 阈值 trigger
 *     重复发同一批
 *   - **app 退出前 best-effort flush**：`will-quit` 把 queue 残余冲掉
 *   - **user_id / organization_id 兜底**：renderer 端 router emit 出来字段可能为空
 *     （chat 主路径调用点很多），main 这里从 TokenManager 抽 userInfo 注入空字段
 *   - **上报失败永不回 renderer**：renderer 不需要知道 telemetry 是否成功
 *
 * 不复用现有 `agent/platform/telemetry-ipc.ts`：那条通路绑 agent_run_id / TraceEvent，是
 * Agent 行为埋点；本 Service 是 user 行为埋点（chat 链接点击 / open_in_space 工具
 * 触发等），分表 `agent_engine_resource_open_event` + 独立上报路径。详见 RFC §8.5
 * 拒绝清单"塞 ChatMessage.metadata"那条。
 *
 * 不复用 `mainErrorReporter.ts`：错误上报匿名 endpoint 不同（`/client-errors/...`），
 * dedup / fingerprint 模型不同；模式参考但不挂同一队列。
 */

import http from 'node:http'
import https from 'node:https'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { joinApiPath } from '@tabtin/config'

import { API_BASE_URL } from '../config/api.js'
import { TokenManager } from '../auth.js'
import { createLogger } from '../logger'

const log = createLogger('ResourceOpenTelemetry')

// ── 常量（test 通过 TELEMETRY_CONSTANTS 反查） ──────────────────────

export const TELEMETRY_CONSTANTS = {
  /** 单次 batch 上限——与服务端 `MAX_BATCH_SIZE` 对齐 */
  MAX_BATCH_SIZE: 100,
  /** queue 长度达此值立即触发 flush（与 MAX_BATCH_SIZE 保持一致便于一次发完） */
  FLUSH_THRESHOLD: 100,
  /** queue 上限——溢出部分丢死信，避免 main 进程被 renderer 刷爆 */
  MAX_QUEUE_SIZE: 1_000,
  /** 5xx / network 错误重试总尝试数（含首发） */
  RETRY_ATTEMPTS: 3,
  /** 单次 HTTP 请求超时 ms */
  REQUEST_TIMEOUT_MS: 10_000,
  /** 死信文件 rotate 阈值（10MB） */
  DLQ_ROTATE_BYTES: 10 * 1024 * 1024,
  /** 5s 定时 flush */
  FLUSH_INTERVAL_MS: 5_000,
} as const

export const TELEMETRY_IPC_CHANNEL = 'telemetry:resource-open:emit' as const

// ── 事件 schema（与 packages/resource-router/src/types.ts:ResourceOpenEvent 对齐）

/**
 * resource_open 事件单条 payload。字段对齐
 * `packages/resource-router/src/types.ts:ResourceOpenEvent`——但 user_id /
 * organization_id / client / client_version 等"客户端上下文"字段允许 renderer 留空，
 * 由 main 进程兜底注入。
 *
 * 故意宽松（部分字段可选）——本服务不替 router 端做 schema 校验（破坏解耦），
 * 只过滤明显非法字段，丢给 Django 端做 strict 校验（4xx → fatal 入死信，
 * 让运维通过死信看到错误细节）。
 */
export interface ResourceOpenEventPayload {
  event_name: string
  trigger_source: string
  pointer_scheme: string
  pointer_type: string | null
  pointer_id_hash: string
  hint_app_id: string | null
  resolved_carrier_app_id: string | null
  resolve_source: string
  outcome: string
  space_id: string
  user_id: string
  organization_id: string
  agent_run_id: string | null
  message_id: string | null
  tool_call_id: string | null
  duration_ms: number
  ts: number
  error_message?: string
  client: string
  client_version: string
}

// ── 模块级状态 ──────────────────────────────────────────────────────

let _installed = false
let _queue: ResourceOpenEventPayload[] = []
let _flushTimer: ReturnType<typeof setInterval> | null = null
let _flushing = false

// ── 入队 ────────────────────────────────────────────────────────────

/**
 * Renderer 端 resource_open 事件入队。**调用方不应该 await**——本函数同步立刻
 * 返回，flush 是 fire-and-forget。
 *
 * 队列溢出时（length > MAX_QUEUE_SIZE）把超出部分写死信（reason='queue-overflow'），
 * 而不是丢最旧的——保证 PM 能看到"丢了 N 条 reason=overflow"做容量评估。
 */
export function enqueueEvent(payload: ResourceOpenEventPayload): void {
  _queue.push(payload)

  // queue overflow → 把溢出部分丢死信。注意 splice 是 in-place，操作后 _queue
  // length 等于 MAX_QUEUE_SIZE。
  if (_queue.length > TELEMETRY_CONSTANTS.MAX_QUEUE_SIZE) {
    const overflow = _queue.splice(0, _queue.length - TELEMETRY_CONSTANTS.MAX_QUEUE_SIZE)
    for (const ev of overflow) {
      writeDeadLetter('queue-overflow', ev)
    }
  }

  if (_queue.length >= TELEMETRY_CONSTANTS.FLUSH_THRESHOLD) {
    // 不 await——fire-and-forget；任何错误进 dead letter
    void flushTelemetry().catch(() => {})
  }
}

// ── HTTP 发送（Promise 包装 node:http/https.request） ──────────────

interface HttpResult {
  status: number
  /** 网络错误（连接拒绝 / 超时 / DNS 失败）时 status=-1 + networkError=true */
  networkError?: boolean
  errorMessage?: string
}

function sendBatchViaNodeHttp(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve) => {
    let urlObj: URL
    try {
      urlObj = new URL(url)
    } catch (err) {
      resolve({ status: -1, networkError: true, errorMessage: String(err) })
      return
    }
    const httpModule = urlObj.protocol === 'https:' ? https : http
    const bodyBuffer = Buffer.from(body, 'utf-8')

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(bodyBuffer.length),
      },
    }

    const req = httpModule.request(requestOptions, (res) => {
      // 必须消费 body 释放 socket（Node http 文档明示）
      res.resume()
      const status = res.statusCode ?? 0
      resolve({ status })
    })

    req.on('error', (err: Error) => {
      resolve({ status: -1, networkError: true, errorMessage: String(err) })
    })

    req.setTimeout(TELEMETRY_CONSTANTS.REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timeout'))
    })

    req.write(bodyBuffer)
    req.end()
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Flush（核心） ──────────────────────────────────────────────────

/**
 * 把 queue 中所有事件批量上报。
 *
 * 设计要点：
 *   - **flushing 锁**：同时多次调 flushTelemetry 只跑一次（避免 5s timer 与
 *     阈值 trigger 同时生效导致重复 POST 同一批）
 *   - **token 缺失**：直接落死信 `no-auth-token`（无 token 重试也是徒劳）
 *   - **4xx fatal**：immediately 落死信，不重试（401/403 重试无用，400 是 schema
 *     失败重试也无用——Django strict 校验拒掉的事件应当让运维看死信调查）
 *   - **5xx / network 重试**：指数退避 2s/4s（attempt 1 → wait 2s → attempt 2
 *     → wait 4s → attempt 3）；最后一次仍失败入死信
 *   - **bulk_create 一定原子**：服务端 transaction.atomic 保证；本端不需做 partial 处理
 */
export async function flushTelemetry(): Promise<void> {
  if (_flushing) return
  if (_queue.length === 0) return

  _flushing = true
  try {
    // 取出最多 MAX_BATCH_SIZE 条；多余的留下次 flush
    const batch = _queue.splice(0, TELEMETRY_CONSTANTS.MAX_BATCH_SIZE)

    // 取 token + user 上下文
    let token: string | null = null
    let userInfo: { id?: string; organization_id?: string } | null = null
    try {
      token = await TokenManager.getAccessToken()
      userInfo = (await TokenManager.getUserInfo()) as { id?: string; organization_id?: string } | null
    } catch {
      // 拿不到 token——视为未登录，不浪费 HTTP
    }

    if (!token) {
      for (const ev of batch) writeDeadLetter('no-auth-token', ev)
      return
    }

    // 兜底注入 user 上下文
    const enriched = batch.map((p) => enrichEventContext(p, userInfo))

    const url = joinApiPath(API_BASE_URL, '/services/telemetry/resource-open/batch')
    const body = JSON.stringify({ events: enriched })
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'X-Telemetry-Source': 'electron-resource-open',
    }

    let lastReason = 'unknown'
    for (let attempt = 1; attempt <= TELEMETRY_CONSTANTS.RETRY_ATTEMPTS; attempt++) {
      const result = await sendBatchViaNodeHttp(url, body, headers)

      if (result.status >= 200 && result.status < 300) {
        log.debug('[telemetry] flushed %d events ok', enriched.length)
        return
      }

      // 4xx → fatal，不重试
      if (result.status >= 400 && result.status < 500) {
        lastReason = `HTTP ${result.status}`
        break
      }

      // 5xx / network → retry
      lastReason = result.networkError
        ? `network: ${result.errorMessage ?? 'unknown'}`
        : `HTTP ${result.status}`

      const isLast = attempt >= TELEMETRY_CONSTANTS.RETRY_ATTEMPTS
      if (!isLast) {
        // 指数退避 2s / 4s（attempt 1 失败后 sleep 2s 再 attempt 2 ...）
        await delay(Math.pow(2, attempt) * 1000)
      }
    }

    // 全失败——入死信
    log.debug(
      '[telemetry] flush gave up after %d attempts (reason=%s); dlq=%d events',
      TELEMETRY_CONSTANTS.RETRY_ATTEMPTS, lastReason, enriched.length,
    )
    for (const ev of enriched) writeDeadLetter(lastReason, ev)
  } finally {
    _flushing = false
  }
}

/**
 * 把客户端上下文兜底注入到事件 payload；不覆盖 renderer 已传的非空字段。
 */
function enrichEventContext(
  payload: ResourceOpenEventPayload,
  userInfo: { id?: string; organization_id?: string } | null,
): ResourceOpenEventPayload {
  const enriched: ResourceOpenEventPayload = { ...payload }

  if (!enriched.user_id || enriched.user_id === '') {
    if (userInfo?.id) enriched.user_id = String(userInfo.id)
  }
  if (!enriched.organization_id || enriched.organization_id === '') {
    if (userInfo?.organization_id) enriched.organization_id = String(userInfo.organization_id)
  }
  if (!enriched.client_version || enriched.client_version === '') {
    try {
      enriched.client_version = app.getVersion()
    } catch {
      // app.getVersion() 极少抛错；fallback 不填
    }
  }
  if (!enriched.client) {
    enriched.client = 'electron'
  }
  return enriched
}

// ── 死信文件 ───────────────────────────────────────────────────────

let _dlqDirEnsured = false

function getDlqPath(): string {
  // userData 在 app ready 后可拿；测试环境 mock electron app.getPath 可能返回
  // 空——失败时 fallback 到当前工作目录。
  let userData = ''
  try {
    userData = app.getPath?.('userData') ?? ''
  } catch {
    userData = ''
  }
  const dir = path.join(userData || process.cwd(), 'telemetry')
  return path.join(dir, 'resource_open_dlq.jsonl')
}

function ensureDlqDir(filePath: string): void {
  if (_dlqDirEnsured) return
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    _dlqDirEnsured = true
  } catch {
    // 创建失败 → 后续 appendFileSync 会抛；那边自己吞
  }
}

function rotateDlqIfBig(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size > TELEMETRY_CONSTANTS.DLQ_ROTATE_BYTES) {
      renameSync(filePath, `${filePath}.old`)
    }
  } catch {
    // rotate 失败不影响主路径——直接继续 append
  }
}

/**
 * 写一条死信到 NDJSON 文件。失败永不抛错。
 *
 * 一行一条 JSON：`{ reason, ts, event }`，便于运维 jq 过滤 / sort -u。
 */
function writeDeadLetter(reason: string, event: ResourceOpenEventPayload): void {
  try {
    const filePath = getDlqPath()
    ensureDlqDir(filePath)
    rotateDlqIfBig(filePath)
    const line = JSON.stringify({ reason, ts: Date.now(), event })
    appendFileSync(filePath, line + '\n', 'utf-8')
  } catch (err) {
    // 写死信失败（磁盘满 / 权限错）→ 只 log，不能让 telemetry 自毁影响业务
    log.debug('[telemetry] writeDeadLetter failed: %s', String(err))
  }
}

// ── IPC + 启动 ─────────────────────────────────────────────────────

/**
 * 安装 IPC handler + 启动 5s 定时 flush。幂等可重入（重复调用 noop）。
 *
 * 调用时机：startup-services.registerCoreProcessHandlers() 早期。
 */
export function initResourceOpenTelemetryService(): void {
  if (_installed) return
  _installed = true

  ipcMain.handle(
    TELEMETRY_IPC_CHANNEL,
    (_event: IpcMainInvokeEvent, payload: unknown): { ok: true } => {
      // 入参极防御：renderer 任意值都吞、不抛
      if (payload && typeof payload === 'object') {
        try {
          enqueueEvent(payload as ResourceOpenEventPayload)
        } catch (err) {
          // enqueueEvent 内部不抛；防御一层
          log.debug('[telemetry] enqueueEvent threw: %s', String(err))
        }
      }
      // 永远返回 ok=true——renderer 调用方靠 fire-and-forget 不关心结果
      return { ok: true }
    },
  )

  _flushTimer = setInterval(() => {
    void flushTelemetry().catch(() => {})
  }, TELEMETRY_CONSTANTS.FLUSH_INTERVAL_MS)
  // 让 main 退出时 timer 不阻 event loop
  _flushTimer.unref?.()

  // 退出前最后一次 flush
  app.on('will-quit', () => {
    if (_flushTimer) {
      clearInterval(_flushTimer)
      _flushTimer = null
    }
    if (_queue.length === 0) return
    log.debug(
      '[telemetry] will-quit flushing %d queued events (best-effort)', _queue.length,
    )
    flushTelemetry().catch((err) => {
      log.debug('[telemetry] will-quit flush failed: %s', String(err))
    })
  })
}

// ── 测试钩子（**生产代码勿用**） ───────────────────────────────────

/**
 * 仅供单元测试反查 queue 状态。
 */
export function __getQueueForTests(): ResourceOpenEventPayload[] {
  return _queue.slice()
}

/**
 * 仅供单元测试重置全局状态。
 *
 * 注意：清掉 _installed = false 让 init 可重跑——业务代码不允许这么干（IPC
 * handle 重复注册会抛）。
 */
export function __resetForTests(): void {
  _queue = []
  _flushing = false
  _installed = false
  _dlqDirEnsured = false
  if (_flushTimer) {
    clearInterval(_flushTimer)
    _flushTimer = null
  }
}

/**
 * DaemonStorageBridgeService — 主进程把 Daemon CLI Storage 路由
 * 包成 `DaemonStorageFetcher`，注入到 `@tabtin/storage-manager` 的 daemon-bridge。
 *
 * 角色：
 *   - W2.3 在 Daemon 端实现了 `POST /storage/*` 路由（HTTP-over-Unix-socket）
 *   - W2.1 在 storage-manager 包定义了 `setDaemonStorageFetcher` 注入点
 *   - 本服务在主进程启动期把"读 ~/.tabtin/daemon-server.json → 通过 Unix socket
 *     发 HTTP 请求 → 解码 daemon 响应"这套封装好，注入到 storage-manager
 *   - W3.1 渲染进程通过 createDaemonBridge() 拿到桥后，listAllBuckets() 自然
 *     聚合到 daemon 注册的 13 个 bucket
 *
 * 设计要点：
 *   1. **lazy & 容错**：daemon 可能完全没在跑——本服务不应该让主进程启动失败
 *   2. **discovery 文件实时读**：daemon 重启时 socket 路径 / token 会变，
 *      每次请求前重新读 daemon-server.json，避免缓存陈旧导致 401
 *   3. **跨平台**：macOS/Linux 用 Unix socket，Windows 用 named pipe，
 *      二者 http.request 都能用 `socketPath` option
 *   4. **不依赖 cli-routes 包**：手写最小 HTTP 客户端避免引入主进程不必要的依赖
 */

import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createDaemonBridge,
  setDaemonStorageFetcher,
  type BucketCategory,
  type BucketClearReport,
  type BucketDescriptor,
  type BucketGroup,
  type BucketItemListReport,
  type BucketSizeReport,
  type ClearOptions,
  type DaemonStorageFetcher,
  type ExportPayload,
} from '@tabtin/storage-manager'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { createLogger } from '../logger'

const log = createLogger('DaemonStorageBridge')

// ── Discovery ──────────────────────────────────────────────────

interface DaemonDiscovery {
  socketPath: string
  token: string
  pid: number
}

/**
 * 读 ~/.tabtin/daemon-server.json，返回当前在跑的 daemon 信息。
 * Daemon 未运行 / 文件损坏时返回 null。
 *
 * 注意：返回的 pid 不做 process.kill(0) 探活——主进程没必要每次都做权限敏感
 * 的 syscall。本桥的策略是：拿到 discovery 就尝试请求，请求失败时降级
 * （error 转成"没接通"），下次请求重新读文件即可。
 */
function readDaemonDiscovery(): DaemonDiscovery | null {
  const filePath = join(getHomeTabtinPath(), 'daemon-server.json')
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const sock = typeof data.sock === 'string' ? data.sock : null
    const token = typeof data.token === 'string' ? data.token : null
    const pid = typeof data.pid === 'number' ? data.pid : null
    if (!sock || !token || !pid) return null
    return { socketPath: sock, token, pid }
  } catch {
    return null
  }
}

// ── HTTP-over-Unix-socket 客户端 ───────────────────────────────

interface DaemonHttpResponse {
  status: number
  body: string
}

class DaemonNotRunningError extends Error {
  constructor() {
    super(
      '[DaemonStorageBridge] daemon-server.json 不存在或不可读 — Daemon 未运行',
    )
    this.name = 'DaemonNotRunningError'
  }
}

class DaemonHttpError extends Error {
  public readonly status: number
  public readonly body: string
  constructor(status: number, body: string) {
    super(
      `[DaemonStorageBridge] Daemon HTTP ${status}: ${body.slice(0, 200)}`,
    )
    this.name = 'DaemonHttpError'
    this.status = status
    this.body = body
  }
}

/**
 * 调 daemon CLI 的 HTTP-over-socket 端点。
 *
 * @param subPath - `/storage/list` / `/storage/size` 等
 * @param body - JSON body（POST）
 * @param timeoutMs - 总超时（含连接 + 收响应）
 */
async function callDaemon(
  subPath: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<DaemonHttpResponse> {
  const discovery = readDaemonDiscovery()
  if (!discovery) {
    throw new DaemonNotRunningError()
  }

  const payload = JSON.stringify(body)
  return new Promise<DaemonHttpResponse>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: discovery.socketPath,
        path: subPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Host': 'localhost',
          'x-tabtin-token': discovery.token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`Daemon CLI request timeout after ${timeoutMs}ms`))
    })
    req.write(payload)
    req.end()
  })
}

/**
 * 解析 daemon 响应为 ok.data，失败抛 DaemonHttpError。
 * Daemon 路由统一返回 `{ ok: true, data: {...} }` 或
 * `{ ok: false, error: { code, message } }`（来自 @tabtin/agent-wire 的 cli-envelope）。
 */
function parseDaemonResponse<T = unknown>(resp: DaemonHttpResponse): T {
  if (resp.status >= 200 && resp.status < 300) {
    try {
      const parsed = JSON.parse(resp.body) as
        | { ok: true; data: T }
        | { ok: false; error?: { code: string; message: string } }
      if ('ok' in parsed && parsed.ok === true) {
        return parsed.data
      }
      // ok: false 的 4xx/5xx 不会进 200——但有可能路由 200 + ok=false
      throw new DaemonHttpError(resp.status, resp.body)
    } catch (err) {
      if (err instanceof DaemonHttpError) throw err
      throw new DaemonHttpError(resp.status, resp.body)
    }
  }
  throw new DaemonHttpError(resp.status, resp.body)
}

// ── Fetcher 实现 ───────────────────────────────────────────────

/**
 * 创建 DaemonStorageFetcher 的真实实现（基于 HTTP-over-Unix-socket）。
 *
 * 各方法都会优雅降级：
 *   - daemon 未运行 → listBuckets 返回 []，其他方法抛 DaemonNotRunningError
 *     （让 daemon-bridge 的 NOT_CONFIGURED fallback 处理一致）
 *   - HTTP 错误 → 透传 DaemonHttpError，UI 端可展示
 */
export function createDaemonStorageFetcher(): DaemonStorageFetcher {
  return {
    async listBuckets(filter) {
      try {
        const data = await callDaemon('/storage/list', { filter: filter ?? {} })
        const parsed = parseDaemonResponse<{
          buckets: BucketDescriptor[]
          count: number
        }>(data)
        return parsed.buckets ?? []
      } catch (err) {
        if (err instanceof DaemonNotRunningError) {
          // Daemon 没在跑——返回空列表，不阻塞 UI 渲染
          log.debug('daemon not running, listBuckets() returns empty')
          return []
        }
        log.warn('listBuckets failed:', err)
        return []
      }
    },

    async getBucketSize(id): Promise<BucketSizeReport> {
      const data = await callDaemon('/storage/size', { bucket: id })
      const parsed = parseDaemonResponse<{
        id: string
        bytes: number
        itemCount?: number
        measuredAt: number
      }>(data)
      return {
        id: parsed.id,
        bytes: parsed.bytes,
        itemCount: parsed.itemCount,
        measuredAt: parsed.measuredAt,
      }
    },

    async listBucketItems(id): Promise<BucketItemListReport> {
      const data = await callDaemon('/storage/list-items', { bucket: id })
      const parsed = parseDaemonResponse<{
        id: string
        items: BucketItemListReport['items']
        measuredAt: number
      }>(data)
      return {
        id: parsed.id,
        items: parsed.items,
        measuredAt: parsed.measuredAt,
      }
    },

    async clearBucket(id, options?: ClearOptions): Promise<BucketClearReport> {
      const data = await callDaemon('/storage/clear', {
        bucket: id,
        options: options ?? {},
      })
      const parsed = parseDaemonResponse<BucketClearReport>(data)
      return {
        id: parsed.id ?? id,
        dryRun: parsed.dryRun ?? options?.dryRun === true,
        clearedItemCount: parsed.clearedItemCount ?? 0,
        freedBytes: parsed.freedBytes ?? 0,
        ...(parsed.errors && parsed.errors.length > 0 ? { errors: parsed.errors } : {}),
      }
    },

    async exportBucket(id): Promise<ExportPayload> {
      const data = await callDaemon('/storage/export', { bucket: id })
      const parsed = parseDaemonResponse<ExportPayload>(data)
      return {
        id: parsed.id,
        filename: parsed.filename,
        data: parsed.data,
        encoding: parsed.encoding,
        mimeType: parsed.mimeType,
      }
    },
  }
}

// ── 启动期接入 ─────────────────────────────────────────────────

let _bridgeHandle: ReturnType<typeof createDaemonBridge> | null = null

/**
 * 主进程启动期调用。把真实 fetcher 注入 storage-manager，并创建 bridge 备用。
 *
 * 时机：startup-services.initializeStartupServices() 内部，
 * 必须在任何会用到 storage-manager bridge 的 IPC handler 注册前执行——
 * createDaemonBridge() 内部 lazy 解析 fetcher（W2.1 F-1 修复），
 * 所以即使本函数比 setDaemonStorageFetcher 早调，bridge 也能正确路由。
 */
export function initDaemonStorageBridge(): void {
  if (_bridgeHandle) {
    log.warn('initDaemonStorageBridge called twice, ignoring')
    return
  }
  const fetcher = createDaemonStorageFetcher()
  setDaemonStorageFetcher(fetcher)
  _bridgeHandle = createDaemonBridge()
  const discovery = readDaemonDiscovery()
  if (discovery) {
    log.info(
      `DaemonStorageFetcher 已注入，daemon 在线（PID ${discovery.pid}, socket ${discovery.socketPath}）`,
    )
  } else {
    log.info(
      'DaemonStorageFetcher 已注入，但 daemon 当前未运行——listBuckets() 将返回空，其他操作会抛错',
    )
  }
}

/**
 * 取出主进程持有的 daemon bridge handle。W3.1 渲染进程接入时会用，
 * 但调用方也可以直接 `import { createDaemonBridge } from '@tabtin/storage-manager'`
 * 自行创建（lazy fetcher 让"先创建后注入"的顺序也安全）。
 */
export function getDaemonBridgeHandle(): ReturnType<typeof createDaemonBridge> | null {
  return _bridgeHandle
}

// ── 测试钩子 ───────────────────────────────────────────────────

/**
 * 单元测试用——清除模块状态 + 把 storage-manager fetcher 还原为未配置态。
 */
export function __resetForTesting(): void {
  _bridgeHandle = null
  setDaemonStorageFetcher(undefined)
}

// ── 导出错误类型供调用方 instanceof 判定 ───────────────────────

export { DaemonHttpError, DaemonNotRunningError }

// ── 导出类型供测试 ─────────────────────────────────────────────

export type { BucketCategory, BucketGroup }

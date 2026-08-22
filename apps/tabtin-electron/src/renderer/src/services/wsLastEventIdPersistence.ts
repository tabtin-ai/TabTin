/**
 * W4c · §3.6 catchup 协议：renderer 端 WS lastEventId 跨进程持久化。
 *
 * 业务目标
 * --------
 * 让用户重启 Electron 后，WS 重连时能续传"关闭期间 backend 推送的事件"——
 * 譬如 Mac 上 Agent 跑了 2 分钟，用户切到 iPhone 看，回到 Mac 再打开应用，
 * 应该能收到这 2 分钟内 backend Redis Stream 缓冲的所有事件。
 *
 * 实现
 * ----
 * 1. **启动时恢复**：`getChatClient()` 创建 `ChatClient` 之前，从 localStorage
 *    读取上次保存的 lastEventId，通过 `gateway.setInitialLastEventId(id)` 注入；
 *    首次握手完成后 `WsGatewayClient` 自动跑 `sendResume(id)` 续传。
 *
 * 2. **运行时持续保存**：`gateway.addListener(envelope => ...)` 每次收到带
 *    `event_id` 的 envelope（含 stream 类事件 + heartbeat tick）时，提取
 *    event_id 节流写回 localStorage——节流避免 60 events/s × setItem 的
 *    主线程开销。
 *
 * 3. **登出 / token 变更时清空**：`clearPersistedLastEventId()` 由调用方在
 *    sessionResetRegistry teardown 路径调用——避免新用户拿到旧 cursor 触发
 *    backend WS_RESUME_OVERFLOW。
 *
 * 与 v2 §3.6 的对应关系
 * --------------------
 * v2 文档伪代码（说明性，实际实现见下方源码）：
 *   class StreamSubscription:
 *     lastEventId = null  // localStorage 持久化
 *     connect() { await ws.subscribe(topics, last_event_id=this.lastEventId) }
 *     onEvent(event) { this.lastEventId = event._event_id; persist() }
 *     onDisconnect() { 不重置 lastEventId 让重连续传 }
 *
 * 落地差异：本仓的 WsGatewayClient 已经在 line 960-968 内部维护了 lastEventId
 * 字段 + 重连时 line 625-628 自动 sendResume——属于"客户端 WS 重连续传 (case C)"
 * 已实现部分。本模块补的是"跨进程重启续传"——把 lastEventId 翻进 localStorage
 * 让进程重启后还能恢复上次 cursor，实现 v2 §3.6 case C 的完整语义。
 *
 * 三段链路对照：
 *   - 短时网络抖动（< idleTimeoutMs）：WsGatewayClient 内置自动重连 + sendResume，
 *     不依赖本模块（lastEventId 内存中存活）
 *   - 进程关闭再打开：localStorage 持久化兜底，本模块负责
 *   - 用户切设备（Mac → iPhone）：iOS / Android client 各自有持久化（参考
 *     apps/tabtin-ios / tabtin-harmony 的对应实现），跟本模块对称
 *
 * Edge cases
 * ----------
 * 1. **token 变更**：调用方应主动 `clearPersistedLastEventId()`（详见 chatApi
 *    teardown 路径）。本模块不做"token 比对自动清空"——避免依赖 token 变化的
 *    监听点（耦合面变大）。
 * 2. **localStorage quota / 不可用**：浏览器隐私模式下 setItem 抛错；本模块
 *    用 try/catch 兜底，写失败 logger.debug 不上报，下次重连退化为"不带
 *    cursor 从订阅时刻开始"——比硬抛错让 ChatClient 初始化失败更安全。
 * 3. **节流粒度**：默认 1s 一次写——既能在 dogfood 期间 60Hz stream 期间不
 *    烧主线程，又能保证用户关闭进程前最后 1s 内的事件 cursor 落盘（足够覆盖
 *    99% 用户体感场景）。
 */

import { logger } from '@/utils/logger'

/** localStorage key —— 单 user / 单 device 一份 cursor 即可，不区分 organization。 */
const STORAGE_KEY = 'tabtin.ws.lastEventId.v1'
/** 写节流：dogfood 期间 60Hz stream，1s 一写 = 主线程开销几乎 0。 */
const PERSIST_THROTTLE_MS = 1000

/**
 * 启动时读取 localStorage 中保存的 lastEventId。
 *
 * 返回 undefined 时调用方应当传 undefined 给 setInitialLastEventId（语义：
 * "无历史 cursor，从订阅时刻开始"）。
 *
 * **W4c 联合 Review P1-1 修复（R5 读出净化）**：写入侧已用 `isStreamEventId`
 * 过滤老 `evt_<uuid>` 形态污染，但**升级前已被污染的存量用户** localStorage
 * 里仍存着老 `evt_*` cursor——冷启动会把它传给 `setInitialLastEventId` →
 * backend `_handle_resume` 走 replay=0 沉默，等于"重启后续传无效"但用户
 * 完全不感知。
 *
 * 净化策略：读出时再次 `isStreamEventId` 校验；非 Stream id 直接返回 undefined
 * + 同步 removeItem 清理污染数据。后续重启就是干净状态。
 */
export function loadPersistedLastEventId(): string | undefined {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return undefined
    }
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw || typeof raw !== 'string' || raw.length === 0) return undefined
    if (!isStreamEventId(raw)) {
      logger.debug('[ws-catchup] loadPersistedLastEventId: 检测到污染 cursor (非 Stream id 形态)，自动清理:', raw)
      try {
        window.localStorage.removeItem(STORAGE_KEY)
      } catch {
        // ignore
      }
      return undefined
    }
    return raw
  } catch (err) {
    logger.debug('[ws-catchup] loadPersistedLastEventId failed:', err)
    return undefined
  }
}

/**
 * 主动清除持久化的 lastEventId。
 *
 * 调用时机：
 *   - 用户登出（token 失效）
 *   - 切换 user（不同 token）
 *   - WS_RESUME_OVERFLOW 后（cursor 已陈旧到 backend Redis Stream 已 GC）
 */
export function clearPersistedLastEventId(): void {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
    window.localStorage.removeItem(STORAGE_KEY)
  } catch (err) {
    logger.debug('[ws-catchup] clearPersistedLastEventId failed:', err)
  }
}

/**
 * 内部 helper：判断 event_id 是 Redis Stream ID 形态（譬如 `1702000000000-0`）
 * 而不是老 `evt_<uuid>` UUID 形态。
 *
 * **W4c · R5-P0-1 修复**：之前持久化逻辑会把 user 路径的 `evt_<uuid>` 也写入
 * localStorage——但 backend `_handle_resume` 对 legacy `evt_*` 走 replay=0 路径
 * （legacy ID **不在** Redis Stream 里，无从续传），且 backend 不返回 error
 * 也不触发 WS_RESUME_OVERFLOW，等于"沉默丢续传"。
 *
 * 必须只持久化真实参与 Redis Stream resume 的 cursor——与 backend
 * `apps/tabtin_django/apps/services/common/ws/protocol.py::is_stream_event_id`
 * 一致：`<digits>-<digits>` 形式。
 */
function isStreamEventId(eventId: string): boolean {
  if (!eventId || typeof eventId !== 'string') return false
  const parts = eventId.split('-')
  return parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])
}

/**
 * 内部 helper：从 envelope 提取**适合持久化**的 stream event_id。
 *
 * **W4c · R5-P0-1**：仅取 `event_id` 字段且形态为 Redis Stream ID（`<digits>-<digits>`）；
 * 老 `evt_<uuid>` UUID 形态（来自 `publish_to_user` 等不写 buffer 的路径）一律
 * 跳过——这些 ID 不在 backend Redis Stream 中，写到 localStorage 等于污染 cursor。
 *
 * 与 ws-gateway-client `handleMessage` line 960 的"内存 lastEventId"维护逻辑
 * 不同——内存维护需要兼容老 `evt_*` 用于会话内去重；本函数只持久化真正能
 * 参与跨进程 resume 的 Stream ID。
 */
function pickEventIdFromEnvelope(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined
  const e = envelope as Record<string, unknown>
  if (typeof e.event_id === 'string' && e.event_id.length > 0 && isStreamEventId(e.event_id)) {
    return e.event_id
  }
  return undefined
}

/**
 * 内部 helper：节流写入 localStorage。
 *
 * 用 trailing-edge 节流保证：
 *   - 高速 stream 期间仅每 1s 写一次（主线程开销 < 0.5ms / s）
 *   - stream 终止后最后一个 event_id 仍能在 1s 内落盘（用户关进程前的 grace）
 */
function makeThrottledPersist(): (id: string) => void {
  let pendingId: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (!pendingId) return
    const idToWrite = pendingId
    pendingId = undefined
    try {
      if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
      window.localStorage.setItem(STORAGE_KEY, idToWrite)
    } catch (err) {
      logger.debug('[ws-catchup] persist setItem failed:', err)
    }
  }

  return (id: string) => {
    pendingId = id
    if (timer != null) return // 已经有 trailing-edge timer 在跑
    timer = setTimeout(flush, PERSIST_THROTTLE_MS)
  }
}

/**
 * 钩接 ChatClient 的 gateway listener，运行时持续把 lastEventId 翻进 localStorage。
 *
 * 调用方：`chatApi.getChatClient()` 创建 client 后立刻调用一次。
 *
 * 实现细节：
 *   - 通过 `gateway.addListener` 监听所有进入 envelope，从中提取 event_id 节流写入
 *   - addListener 是多 listener 模型——本 listener 与 chatApi 的 background
 *     event router / membership change handler 不冲突
 *   - 不需要返回 unregister 句柄：listener 跟 gateway 单例同寿命（chatApi
 *     teardown 时整 gateway 关闭，listener 自然 GC）
 */
export function attachLastEventIdPersistence(
  gateway: { addListener: (cb: (envelope: unknown) => void) => unknown },
): void {
  const persist = makeThrottledPersist()
  gateway.addListener((envelope: unknown) => {
    const eventId = pickEventIdFromEnvelope(envelope)
    if (eventId) {
      persist(eventId)
    }
  })
}

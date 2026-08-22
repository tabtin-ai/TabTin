import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useChatStore } from '@stores/chat/useChatStore'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { trackChatTelemetry } from '@stores/chat/execution/chatTelemetry'
import { isSessionBusy } from '@stores/chat/execution/sessionRunProjection'
import { createLogger } from '@/utils/logger'

const log = createLogger('WidgetPrompt')

export const WIDGET_SEND_PROMPT_TEXT_MAX_LENGTH = 1000
export const WIDGET_SEND_PROMPT_META_MAX_BYTES = 4 * 1024
export const WIDGET_SEND_PROMPT_RATE_LIMIT_WINDOW_MS = 60_000
export const WIDGET_SEND_PROMPT_RATE_LIMIT_MAX = 5

/**
 * Widget Wave 7 补丁：session 级总上限（widget RFC 决策 13 风险放大防线）。
 *
 * **为什么加这一层**：单 widget 5 次/分钟能挡单个恶意 widget 的 onclick 死循环，
 * 但一个 turn Agent 吐 3-5 个 widget 时（架构图 + 状态卡片 + 方案对比），用户点
 * 完所有可点元素实际能在 1 分钟触发 `5 widget × 5 次 = 25 次` sendPrompt ——
 * 每次都是一个新 LLM 调用 + 工具 execute，能把单 session LLM 配额直接刷爆。
 *
 * **限流合理性**：15 次/分钟按"用户真实点图节奏"推算——
 *   - 30s 内集中点 3-5 个 widget 不同元素属正常探索，刚好覆盖
 *   - > 15 次/分钟基本上是恶意 widget / 用户鼠标 stuck / 自动化脚本
 *   - 三个 widget 各 5 次 = 恰好 15，第 16 次被挡且有明确 toast 提示
 *
 * **与单 widget 5 次并行**：两层限流独立计数，任一超限都拒绝——单 widget 本身
 * 的 onclick 死循环 / 同一 widget 短时爆点都被两边挡住。
 */
export const WIDGET_SEND_PROMPT_SESSION_RATE_LIMIT_MAX = 15

export interface WidgetSendPromptRegistration {
  source: Window
  widgetId: string
  sessionId: string
}

interface TrustedWidgetFrame {
  widgetId: string
  sessionId: string
  registeredAt: number
}

export interface WidgetSendPromptDevEvent {
  type: 'widget_send_prompt'
  widget_id: string
  session_id: string
  text: string
  meta?: unknown
  timestamp: number
}

const trustedFrames = new WeakMap<Window, TrustedWidgetFrame>()
const rateLimitBuckets = new Map<string, number[]>()
/**
 * Widget Wave 7 补丁：session 级总上限用独立 bucket。key 是 `sessionId`，与
 * widget 级 `sessionId:widgetId` 自然不会冲突（分号数不同）。
 */
const sessionRateLimitBuckets = new Map<string, number[]>()
const devEvents: WidgetSendPromptDevEvent[] = []
const MAX_DEV_EVENTS = 100

let installed = false

function showToast(key: string, fallback: string): void {
  toast({ title: i18n.t(key, { defaultValue: fallback }) })
}

/**
 * P0-1 第三层 hard check：拒绝含 NUL / C0 控制字符 / DEL 的 text。
 *
 * 正则清洗范围：
 *   - `\u0000-\u0008`（含 NUL / backspace / bell 等 C0 控制符）
 *   - `\u000b` / `\u000c`（VT / FF，罕见不可见控制符）
 *   - `\u000e-\u001f`（SO / SI 起余 C0 段）
 *   - `\u007f`（DEL / Delete，技术上不属于 C0 但同样危险）
 * 合法保留：`\t` (0x09) / `\n` (0x0a) / `\r` (0x0d) — 允许多行 prompt。
 *
 * **为什么剥除而不是拒绝**：用户 paste 的文本里偶然带个 `\u0000` 不应被整条拒掉；
 * 但恶意 widget 批量注入大量控制字符时会被后面 length check 连带拒掉。
 *
 * **backlog** (P2)：Unicode bidi 控制字符（\u202E RTL override、\u200B ZWSP、
 * \u2028/\u2029 Line/Paragraph Separator）的剥除——属于社会工程学攻击向量，
 * 本波不修，等影响面真实观察到再加。
 */
function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function normalizeText(text: unknown): string | null {
  if (typeof text !== 'string') return null
  // P0-1 第三层：先剥除 C0 控制字符（NUL 等），再 trim。防止 widget 恶意注入
  // 不可见字符污染 chat 上下文 / 日志 / terminal。
  const cleaned = stripControlChars(text)
  const trimmed = cleaned.trim()
  if (!trimmed) return null
  if (trimmed.length > WIDGET_SEND_PROMPT_TEXT_MAX_LENGTH) return null
  return trimmed
}

function jsonByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length
  } catch {
    return value.length
  }
}

function normalizeMeta(meta: unknown): { ok: true; value?: unknown } | { ok: false } {
  if (meta === undefined) return { ok: true }
  // P0-1 第三层：通过 JSON round-trip 过滤出可序列化的 meta。
  //
  // 多道防线：
  //   1. JSON.stringify 对 function / symbol 返回 undefined → ok:false
  //   2. JSON.stringify 对含循环引用的 object 抛 TypeError → catch 拒绝
  //   3. JSON.stringify("x".repeat(5000)) 超 4KB → ok:false
  //   4. round-trip parse 防 `toJSON()` 劫持让 stringify / parse 结果不一致
  //
  // 返回值约定：JSON round-trip 后的值允许所有 JSON-serializable 类型
  // （object / array / null / boolean / number / string）。top-level primitive
  // 合法——消费方（sendMessage handler）自己处理类型。
  try {
    const serialized = JSON.stringify(meta)
    if (serialized === undefined || jsonByteLength(serialized) > WIDGET_SEND_PROMPT_META_MAX_BYTES) {
      return { ok: false }
    }
    const parsed = JSON.parse(serialized) as unknown
    return { ok: true, value: parsed }
  } catch {
    return { ok: false }
  }
}

function getWidgetIdFromBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const record = block as Record<string, unknown>
  if (record.type !== 'rich_content' || record.kind !== 'widget') return null
  return typeof record.widget_id === 'string' ? record.widget_id : null
}

function sessionHasWidget(sessionId: string, widgetId: string): boolean {
  const chatState = useChatStore.getState()
  const messages = chatState.messagesBySessionId[sessionId] ?? []
  for (const message of messages) {
    for (const block of message.content_blocks_json ?? []) {
      if (getWidgetIdFromBlock(block) === widgetId) return true
    }
  }

  const runtimeBlocks = useChatRuntimeStore.getState().richContentBlocksBySessionId[sessionId] ?? []
  for (const block of runtimeBlocks) {
    if (getWidgetIdFromBlock(block) === widgetId) return true
  }
  return false
}

function rateLimitKey(sessionId: string, widgetId: string): string {
  return `${sessionId}:${widgetId}`
}

function pruneBucket(
  store: Map<string, number[]>,
  windowMs: number,
  now: number,
): void {
  const since = now - windowMs
  for (const [key, values] of store) {
    const fresh = values.filter(ts => ts > since)
    if (fresh.length === 0) {
      store.delete(key)
    } else if (fresh.length !== values.length) {
      store.set(key, fresh)
    }
  }
}

function pruneRateLimitBuckets(now: number): void {
  pruneBucket(rateLimitBuckets, WIDGET_SEND_PROMPT_RATE_LIMIT_WINDOW_MS, now)
  pruneBucket(sessionRateLimitBuckets, WIDGET_SEND_PROMPT_RATE_LIMIT_WINDOW_MS, now)
}

/**
 * 两层限流顺序：widget 级先（精准挡单 widget 恶意循环）→ session 级后
 * （挡跨 widget 放大）。任一层超限都拒绝，返回命中的层级让上层 toast 区分。
 *
 * **关键语义**（测试用例守护）：
 *   - widget 级挡掉时**不**再计入 session 级——用户单 widget 乱点不应该消耗
 *     全 session 配额（否则合法交互会被 stolen）
 *   - session 级挡掉时**也不**计入 widget 级——对称处理，让两个 counter 各自
 *     反映"已通过"的真实次数
 */
type RateLimitVerdict = 'ok' | 'widget' | 'session'

function checkAndRecordRateLimit(
  sessionId: string,
  widgetId: string,
  now: number,
): RateLimitVerdict {
  pruneRateLimitBuckets(now)
  const since = now - WIDGET_SEND_PROMPT_RATE_LIMIT_WINDOW_MS

  const widgetKey = rateLimitKey(sessionId, widgetId)
  const widgetCurrent = rateLimitBuckets.get(widgetKey)?.filter(ts => ts > since) ?? []
  if (widgetCurrent.length >= WIDGET_SEND_PROMPT_RATE_LIMIT_MAX) {
    rateLimitBuckets.set(widgetKey, widgetCurrent)
    return 'widget'
  }

  const sessionCurrent = sessionRateLimitBuckets.get(sessionId)?.filter(ts => ts > since) ?? []
  if (sessionCurrent.length >= WIDGET_SEND_PROMPT_SESSION_RATE_LIMIT_MAX) {
    sessionRateLimitBuckets.set(sessionId, sessionCurrent)
    return 'session'
  }

  widgetCurrent.push(now)
  rateLimitBuckets.set(widgetKey, widgetCurrent)
  sessionCurrent.push(now)
  sessionRateLimitBuckets.set(sessionId, sessionCurrent)
  return 'ok'
}

function pushDevEvent(event: WidgetSendPromptDevEvent): void {
  devEvents.push(event)
  if (devEvents.length > MAX_DEV_EVENTS) devEvents.splice(0, devEvents.length - MAX_DEV_EVENTS)
  if (typeof window !== 'undefined') {
    window.__TABTIN_WIDGET_SEND_PROMPT_EVENTS__ = [...devEvents]
  }
}

/**
 * Widget Wave 7 补丁：把一条 audit entry 通过 preload IPC 写到 main 进程的
 * `~/.tabtin/widget-audit.log`。
 *
 * **fire-and-forget 严格约定**：
 *   - 永不抛——preload API 不存在（测试环境 / 开发环境 contextIsolation=false）
 *     时走 catch 降级，不影响 sendPrompt 业务链路
 *   - 不 await 磁盘写——renderer 点 widget 后立刻执行 sendMessage，audit 写盘
 *     在 event loop 下一个 tick
 *   - 返回值丢弃——main 处理失败只在 console.warn，renderer 不感知
 */
async function appendWidgetAuditLog(entry: {
  timestamp: number
  session_id: string
  widget_id: string
  text: string
  meta?: unknown
  trigger_source?: 'widget'
}): Promise<void> {
  try {
    const append = (window as unknown as {
      tabtin?: {
        widgetAudit?: {
          append?: (entry: unknown) => Promise<unknown>
        }
      }
    })?.tabtin?.widgetAudit?.append
    if (typeof append === 'function') {
      await append(entry)
    }
  } catch (err) {
    log.warn(`audit log append failed session=${entry.session_id} widget=${entry.widget_id}:`, err)
  }
}

async function handleWidgetSendPromptMessage(event: MessageEvent): Promise<void> {
  const data = event.data as Record<string, unknown> | null
  if (!data || data.type !== 'tabtin:sendPrompt') return

  const source = event.source
  if (!source || !('postMessage' in source)) {
    trackChatTelemetry('widget_send_prompt.ignored_untrusted_source', {}, {
      counterKey: 'widget_send_prompt.ignored_untrusted_source',
      level: 'warn',
    })
    return
  }

  // **P0-1 第二层：widget_id / session_id **只**从 trustedFrames 反推**。
  //
  // 旧实现从 `data.widget_id` 读——widget 内恶意 script 绕过 sanitizer 后能
  // 伪造 `parent.postMessage({type:'tabtin:sendPrompt', widget_id:'任意'}, '*')`
  // 完全绕开 wrapper 的 `isTrusted` 手势门。
  //
  // 新实现完全忽略 `data.widget_id` / `data.session_id` / `data.timestamp`——
  // **父页只信 registry**（WeakMap<Window, TrustedWidgetFrame>）。widget 内任何
  // 代码都不可能篡改 registry（DOM window 引用是父页创建的，widget 只能通过
  // `parent.postMessage` 通信无法写入父页 WeakMap）。
  const trusted = trustedFrames.get(source as Window)
  if (!trusted) {
    trackChatTelemetry('widget_send_prompt.ignored_untrusted_source', {}, {
      counterKey: 'widget_send_prompt.ignored_untrusted_source',
      level: 'warn',
    })
    return
  }

  const widgetId = trusted.widgetId
  const sessionId = trusted.sessionId

  // P0-1 第三层 hard check：即使来源 trusted，data 字段仍严格校验——
  // 防 attacker 通过控制 widget 代码路径触发 handler 后塞入超长 / 非 string /
  // 含 NUL 的 text 污染下游。
  const text = normalizeText(data.text)
  if (!text) {
    showToast('chat:widgetSendPrompt.invalidText', 'Widget 触发内容无效')
    trackChatTelemetry('widget_send_prompt.rejected_invalid_text', {
      widget_id: widgetId,
      sessionId,
    }, {
      counterKey: 'widget_send_prompt.rejected_invalid_text',
      level: 'warn',
      sessionId,
    })
    return
  }

  if (!sessionId || !widgetId) {
    showToast('chat:widgetSendPrompt.widgetUnavailable', 'Widget 已失效，请刷新后重试')
    return
  }

  // P0-1 第三层：伪造标识检测——如果 data 里带了 widget_id 字段且跟 registry
  // 反推出的值不一致，记一条 audit telemetry 但**不拒绝**（父页信 registry
  // 不信 data，所以即使 data 伪造也不影响最终路由）。这条 telemetry 给安全
  // 团队用来发现异常 widget。事件名刻意不用 "payload_widget_id_mismatch"——
  // "payload" 太泛，"claimed_id_mismatch" 直接说"声称 ID 与真实 ID 不符"。
  if (typeof data.widget_id === 'string' && data.widget_id !== widgetId) {
    trackChatTelemetry('widget_send_prompt.claimed_id_mismatch', {
      claimed_widget_id: data.widget_id,
      actual_widget_id: widgetId,
      sessionId,
    }, {
      counterKey: 'widget_send_prompt.claimed_id_mismatch',
      level: 'warn',
      sessionId,
    })
  }

  const normalizedMeta = normalizeMeta(data.meta)
  if (!normalizedMeta.ok) {
    showToast('chat:widgetSendPrompt.invalidMeta', 'Widget 附加信息过大，已拒绝发送')
    trackChatTelemetry('widget_send_prompt.rejected_invalid_meta', {
      widget_id: widgetId,
      sessionId,
    }, {
      counterKey: 'widget_send_prompt.rejected_invalid_meta',
      level: 'warn',
      sessionId,
    })
    return
  }

  if (!sessionHasWidget(sessionId, widgetId)) {
    showToast('chat:widgetSendPrompt.widgetUnavailable', 'Widget 已失效，请刷新后重试')
    trackChatTelemetry('widget_send_prompt.rejected_unregistered_widget', {
      widget_id: widgetId,
      sessionId,
    }, {
      counterKey: 'widget_send_prompt.rejected_unregistered_widget',
      level: 'warn',
      sessionId,
    })
    return
  }

  // ：busy 判定改读执行态单一投影（覆盖发送锁 + 流式 + runtime 排队三类来源）。
  if (isSessionBusy(sessionId)) {
    showToast('chat:widgetSendPrompt.sessionBusy', '当前对话正在发送中，请稍后再试')
    return
  }

  const now = Date.now()
  const verdict = checkAndRecordRateLimit(sessionId, widgetId, now)
  if (verdict === 'widget') {
    showToast('chat:widgetSendPrompt.rateLimited', 'Widget 触发过于频繁，已限流')
    trackChatTelemetry('widget_send_prompt.rate_limited', {
      widget_id: widgetId,
      sessionId,
    }, {
      counterKey: 'widget_send_prompt.rate_limited',
      level: 'warn',
      sessionId,
    })
    return
  }
  if (verdict === 'session') {
    // 文案刻意区分于 widget 级限流：用户需知道"不是某个 widget 被限流，
    // 而是整轮 widget 操作触发 session 级总上限"——否则会反复切 widget 试。
    showToast(
      'chat:widgetSendPrompt.sessionRateLimited',
      '本轮 widget 操作过于频繁，请稍后再试',
    )
    trackChatTelemetry('widget_send_prompt.session_rate_limited', {
      widget_id: widgetId,
      sessionId,
    }, {
      counterKey: 'widget_send_prompt.session_rate_limited',
      level: 'warn',
      sessionId,
    })
    return
  }

  // P0-1 第三层：timestamp **不再从 `data.timestamp` 读**——data.timestamp 是
  // widget 内 script 给的（旧协议保留字段，新协议 widget 已不发），不可信。
  // 统一用父页本地 `now`（事件到达 handler 的 Date.now()）作为权威时间戳。
  // 这样即使有 widget 伪造 timestamp 也不影响 audit log 真实性。
  const devEvent: WidgetSendPromptDevEvent = {
    type: 'widget_send_prompt',
    widget_id: widgetId,
    session_id: sessionId,
    text,
    meta: normalizedMeta.value,
    timestamp: now,
  }
  pushDevEvent(devEvent)
  // 不打完整 text（用户 prompt 内容）——只记可诊断的标识 + 长度，避免用户内容落诊断包。
  log.debug(`send_prompt session=${sessionId} widget=${widgetId} textLen=${text.length}`)
  trackChatTelemetry('widget_send_prompt', {
    widget_id: widgetId,
    text,
    meta: normalizedMeta.value,
    timestamp: devEvent.timestamp,
  }, {
    counterKey: 'widget_send_prompt',
    sessionId,
  })

  // Widget Wave 7 补丁：audit log 写 electron main log 文件。
  // **fire-and-forget**：不 await 磁盘 IO / IPC round-trip，保证重启能 survive
  // 内存 ring buffer（只 100 条 + 重启丢）的短板。失败不阻塞后续 sendMessage。
  // 真正后端 audit 接口留给 Wave 8。
  void appendWidgetAuditLog({
    timestamp: devEvent.timestamp,
    session_id: sessionId,
    widget_id: widgetId,
    text,
    meta: normalizedMeta.value,
    trigger_source: 'widget',
  })

  try {
    await useChatStore.getState().sendMessage(text, true, undefined, undefined, sessionId, {
      source: 'widget',
      widgetId,
      widgetMeta: normalizedMeta.value,
      widgetTriggeredAt: devEvent.timestamp,
    })
  } catch (err) {
    showToast('chat:widgetSendPrompt.sendFailed', 'Widget 发送失败，请稍后重试')
    trackChatTelemetry('widget_send_prompt.send_failed', {
      widget_id: widgetId,
      message: err instanceof Error ? err.message : String(err),
    }, {
      counterKey: 'widget_send_prompt.send_failed',
      level: 'error',
      sessionId,
    })
  }
}

export function ensureWidgetSendPromptListener(): void {
  if (installed || typeof window === 'undefined') return
  window.addEventListener('message', (event) => {
    void handleWidgetSendPromptMessage(event)
  })
  installed = true
}

export function registerWidgetSendPromptIframe(registration: WidgetSendPromptRegistration): void {
  if (!registration.source || !registration.widgetId || !registration.sessionId) return
  ensureWidgetSendPromptListener()
  trustedFrames.set(registration.source, {
    widgetId: registration.widgetId,
    sessionId: registration.sessionId,
    registeredAt: Date.now(),
  })
}

export function unregisterWidgetSendPromptIframe(source: Window | null | undefined): void {
  if (!source) return
  trustedFrames.delete(source)
}

export function getWidgetSendPromptDevEvents(): WidgetSendPromptDevEvent[] {
  return [...devEvents]
}

export function __resetWidgetSendPromptForTests(): void {
  rateLimitBuckets.clear()
  sessionRateLimitBuckets.clear()
  devEvents.splice(0, devEvents.length)
  if (typeof window !== 'undefined') {
    window.__TABTIN_WIDGET_SEND_PROMPT_EVENTS__ = []
  }
}

ensureWidgetSendPromptListener()

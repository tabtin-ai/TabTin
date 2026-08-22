/**
 * Desktop route handler for CLI Server.
 *
 * Routes CLI `/desktop/*` requests to DesktopExecutorService.
 * All operations execute in the Electron main process.
 *
 * v1.3 → v1.4 · Wave 2 契约化改造（规范 § 3.4 / § 9.2 / D3）：
 * - 消除宽松 any 类型：请求体按路由类型化（见 `Desktop*RequestBody`
 *   接口族），错误响应 `code` 字段走 `DesktopErrorCode` 枚举；
 * - 策略预设从 Space 动态读（规范 § 6.4）：原通过主进程 Space 缓存读 CLI
 *   "current Space auth preset"，PD-11（W6 M3）后该 API 删除，CLI client
 *   不再压低 Space yolo —— 详见下方 "CLI client 不再传 _authPreset" 段；
 * - 审计 `errorCode` 字段（规范 § 6.11.2）：所有 `result: 'error'` 路径都带枚举；
 * - 新增 `/session/extend-allowlist` 路由（规范 § 6.12，Wave 2 第 9 项）。
 *
 * v1.4 → v1.5 · Wave 2.1 扫尾（规范 § 6.5 跨端兑现）：
 * - `desktop_observe === 'block'` 时在路由层入口直接拒绝（通过
 *   `getCurrentSpaceDevicePermissions()` 读），补齐 Python Prompt 侧与
 *   Electron 路由侧的一致性；`/accessibility` 诊断路由豁免。
 */

import type http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
import { getCLIDesktopExecutor, getCLIDesktopGuard } from '../cli-context'
import { getCurrentSpaceDevicePermissions } from '../cli-space-desktop-cache'
import { errorResponse, type ErrorCode } from './shared/error-handler'
import {
  DesktopErrorCode,
  DesktopError,
  isDesktopErrorCode,
} from '../../services/desktop-error-codes'
import type { BatchAction, DesktopExecutorService } from '../../services/DesktopExecutorService'
import {
  bindSessionContext,
  deriveSessionContextFromExecutor,
} from '../../services/desktop-session-context'
import { writeAuditLog } from '../../services/desktop-audit-logger'

// ---------------------------------------------------------------------------
// 请求 / 响应类型（规范 § 3.4 D3 契约化）
// ---------------------------------------------------------------------------

/**
 * 所有 `/desktop/*` 路由可能出现的共享字段。
 *
 * PD-11（W6 M3）：原 `_authPreset` 字段已删除——CLI client 不再能"压低"Space
 * 的 yolo / 预设。统一以 Space agent_config.security.allow_yolo_mode 为权威
 * （v3 PRD §5.1.1 字段改名）；device 动作的拦截改由 device_permissions
 * （device_observe=block 等）+ DesktopUseLock 审批 guard 完成。
 */
interface DesktopRequestCommon {
  sessionId?: string
}

interface DesktopScreenshotBody extends DesktopRequestCommon {
  displayId?: number
  maxDimension?: number
  savePath?: string
  region?: { x: number; y: number; width: number; height: number }
  allowedApps?: string[]
  /**
   * Wave 3 · D2 规范 § 4.5.1：imageResize 开关 + 自定义参数，由客户端（渲染侧 / CLI）
   * 按 app.json 配置传入。不传时默认启用 + 用内置默认参数（见
   * `DEFAULT_IMAGE_RESIZE_PARAMS`）。
   */
  imageResize?: {
    enabled?: boolean
    params?: {
      pxPerToken?: number
      maxTargetPx?: number
      maxTargetTokens?: number
    }
  }
}

interface DesktopClickBody extends DesktopRequestCommon {
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  count?: number
}

interface DesktopScrollBody extends DesktopRequestCommon {
  x?: number
  y?: number
  dx?: number
  dy?: number
}

interface DesktopDragBody extends DesktopRequestCommon {
  fromX?: number
  fromY?: number
  toX?: number
  toY?: number
  duration?: number
}

interface DesktopMoveBody extends DesktopRequestCommon {
  x?: number
  y?: number
}

interface DesktopTypeBody extends DesktopRequestCommon {
  text?: string
  clipboard?: boolean
}

interface DesktopKeyBody extends DesktopRequestCommon {
  key?: string
  modifiers?: string[]
  repeat?: number
}

interface DesktopHotkeyBody extends DesktopRequestCommon {
  keys?: string[]
}

interface DesktopActivateBody extends DesktopRequestCommon {
  target?: string
}

interface DesktopOpenBody extends DesktopRequestCommon {
  name?: string
  /** 显式允许打开系统终端类应用（PowerShell / cmd / Windows Terminal 等） */
  external?: boolean
}

interface DesktopSessionStartBody extends DesktopRequestCommon {
  allowedApps?: string[]
}

interface DesktopAccessibilityBody extends DesktopRequestCommon {
  prompt?: boolean
}

/** `/session/extend-allowlist`（规范 § 6.12） */
interface DesktopExtendAllowlistBody extends DesktopRequestCommon {
  sessionId?: string
  apps?: string[]
  reason?: string
}

/**
 * `/batch` 请求体（Wave 3 · 规范 § 4.5.2）。
 *
 * `actions` 是 unknown 再由 Executor narrow 校验——规范 § 4.5.2 技术方案 3
 * 明确硬性校验（首项 screenshot 禁止）落在 Executor 入口，路由层只做基本
 * 结构性检查（数组、非空）+ 再在调用 Executor 前做一次 Q5 双重防线。
 */
interface DesktopBatchBody extends DesktopRequestCommon {
  actions?: unknown
}

/** `/accessibility-tree` 请求体（模块四 · 规范 § 4.6.3） */
interface DesktopAccessibilityTreeBody extends DesktopRequestCommon {
  window?: string
  bundleId?: string
  maxDepth?: number
  interactiveOnly?: boolean
  maxNodes?: number
}

/** `/click-element` 请求体（模块四 · 规范 § 4.6.3） */
interface DesktopClickElementBody extends DesktopRequestCommon {
  name?: string
  role?: string
  automationId?: string
  nth?: number
  button?: 'left' | 'right' | 'middle'
  count?: number
}

/** `/type-into-element` 请求体（模块四 · 规范 § 4.6.3） */
interface DesktopTypeIntoElementBody extends DesktopRequestCommon {
  name?: string
  role?: string
  automationId?: string
  text?: string
  clipboard?: boolean
}

/**
 * 终端类应用名 / 路径：用户说「打开终端」应走 `tabtin terminal open`，
 * 默认拦截 `desktop open`，除非显式 `--external`。
 */
const EXTERNAL_TERMINAL_APP_RE =
  /(?:^|[\\/])(powershell|pwsh|cmd|wt|windows[\s._-]?terminal|terminal|iterm2?|alacritty|kitty|hyper|conhost|windowsterminal)(?:\.exe)?$/i

function isExternalTerminalAppName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  // 纯应用名（无路径分隔符）或路径末段
  const base = trimmed.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? trimmed
  return EXTERNAL_TERMINAL_APP_RE.test(base) || EXTERNAL_TERMINAL_APP_RE.test(trimmed)
}

/**
 * Discriminated union：按路由区分的请求体类型。
 * 入口 {@link handleDesktopRoute} 接收 `unknown`，按 route 做 narrow 转换。
 */
type DesktopRequestBody =
  | DesktopScreenshotBody
  | DesktopClickBody
  | DesktopScrollBody
  | DesktopDragBody
  | DesktopMoveBody
  | DesktopTypeBody
  | DesktopKeyBody
  | DesktopHotkeyBody
  | DesktopActivateBody
  | DesktopOpenBody
  | DesktopSessionStartBody
  | DesktopAccessibilityBody
  | DesktopExtendAllowlistBody
  | DesktopBatchBody
  | DesktopAccessibilityTreeBody
  | DesktopClickElementBody
  | DesktopTypeIntoElementBody
  | Record<string, never>

/** Route 层发回的错误响应体结构。 */
interface DesktopErrorResponse {
  code: DesktopErrorCode
  message: string
  detail?: unknown
  suggestions?: string[]
}

type SendJSON = (
  res: http.ServerResponse,
  status: number,
  data: unknown,
) => void

// ---------------------------------------------------------------------------
// PD-11（W6 M3）：原 "CLI client 跟 Space 取更严" 整套语义（含 effective
// preset 解析、preset strictness 表、stricter preset 判定 helper）已删除。
//
// 新世界（PD-1 之后）：device 动作的拦截只看两件事 ——
//   1. Space 的 `device_permissions.desktop_observe` 是否 == 'block'
//      （cli-server.getCurrentSpaceDevicePermissions 仍维护这条）；
//   2. DesktopUseLock 审批 guard 是否已批 + 仍在持有
//      （getCLIDesktopGuard().isApproved()）。
//
// CLI client 不再能传 `_authPreset` 来"压低" Space 的 yolo / 预设。任何
// 想限制 desktop 操作的产品需求都走 Space agent_config 入库 + WS 同步。
// ---------------------------------------------------------------------------
// 动作 → 权限键映射（与 § 6.2 / device-rules.ts 对齐）
// ---------------------------------------------------------------------------

const DESKTOP_ACTION_MAP: Record<string, string> = {
  '/screenshot': 'desktop_screenshot',
  '/click': 'desktop_click',
  '/scroll': 'desktop_scroll',
  '/drag': 'desktop_drag',
  '/move': 'desktop_move',
  '/type': 'desktop_type',
  '/key': 'desktop_key',
  '/hotkey': 'desktop_hotkey',
  '/windows': 'desktop_windows',
  '/activate': 'desktop_activate',
  '/open': 'desktop_open',
  // Wave 3 · 规范 § 4.5.2：batch 走 desktop_input（整体一次策略评估，子动作
  // 跑在 Executor 循环里。与单步 /click /type /hotkey 等同一权限键）。
  '/batch': 'desktop_input',
  // 模块四 · 规范 § 4.6.4：AX 路由权限映射。
  '/accessibility-tree': 'desktop_observe',
  '/click-element': 'desktop_input',
  '/type-into-element': 'desktop_input',
}

const KNOWN_ROUTES = new Set([
  '/screenshot',
  '/click',
  '/scroll',
  '/drag',
  '/move',
  '/type',
  '/key',
  '/hotkey',
  '/windows',
  '/activate',
  '/open',
  '/batch',
  '/session/start',
  '/session/end',
  '/session/extend-allowlist',
  '/accessibility',
  '/revoke-approval',
  '/accessibility-tree',
  '/click-element',
  '/type-into-element',
])

// ---------------------------------------------------------------------------
// 错误码推断：兜底把 Executor / 底层 throw 的 Error 转成枚举
// ---------------------------------------------------------------------------

/**
 * 基于错误消息文本推断 DesktopErrorCode（Wave 2 过渡方案）。
 *
 * 当前实现对中文文案做字符串匹配（部分追加了英文别名），覆盖 Executor
 * 内部抛出的几类已知 `DesktopError` / `Error('<中文消息>')`。这是**脆性
 * 兜底**：
 *
 * - 外部库（`@nut-tree-fork/nut-js`、`sharp`、Electron `desktopCapturer` 等）
 *   抛出的原生英文错误消息（例如 `sharp: "Input buffer contains unsupported
 *   image format"`、nut-js `"No matching window"`）**不会**被任一分支命中，
 *   全部落入 `INTERNAL_ERROR` 兜底，丢失 TCC_DENIED / VALIDATION_ERROR / ABORTED
 *   等精确语义，削弱审计聚合能力。
 * - Wave 2 范围内 Executor 已改写主要抛点为 `throw new DesktopError(code, msg)`，
 *   路由层 `err instanceof DesktopError` 先命中就不会走到 `inferErrorCodeFromMessage`，
 *   所以脆性影响面被圈在"Executor/底层仍有漏网英文 throw"的路径。
 *
 * **演进路径（Wave 3+ 渐进替换）**：随 `DesktopErrorCode` 覆盖面在 Wave 3+
 * 扩大，逐步把 Executor 剩余非 DesktopError 抛点迁移到 DesktopError + 精确
 * code，本函数在覆盖面达到阈值后可退化为 `return INTERNAL_ERROR`（纯兜底，
 * 不再推断）。**不要**在本函数里继续堆更多字符串匹配——那只会延长脆性代码
 * 生命周期，也让 Wave 3+ 渐进替换的收益被逐步稀释。
 */
function inferErrorCodeFromMessage(message: string): DesktopErrorCode {
  if (!message) return DesktopErrorCode.UNKNOWN
  if (message.includes('DISPLAY_CONFIG_CHANGED') || message.includes('显示器配置已变化')) {
    return DesktopErrorCode.DISPLAY_CONFIG_CHANGED
  }
  if (message.includes('辅助功能') || message.includes('Accessibility')) {
    return DesktopErrorCode.TCC_DENIED
  }
  if (
    message.includes('屏幕录制权限') ||
    message.includes('Screen Recording') ||
    message.includes('TCC_DENIED')
  ) {
    return DesktopErrorCode.TCC_DENIED
  }
  if (message.includes('已被用户中止') || message.includes('aborted')) {
    return DesktopErrorCode.ABORTED
  }
  if (message.includes('仅在 macOS 和 Windows 可用')) {
    return DesktopErrorCode.UNSUPPORTED_PLATFORM
  }
  if (message.includes('session 未启动') || message.includes('尚未截屏')) {
    return DesktopErrorCode.PERMISSION_DENIED
  }
  return DesktopErrorCode.INTERNAL_ERROR
}

/**
 * 校验"可转换为有限数字"——用于路由层对坐标 / 偏移等数值字段的 runtime guard。
 *
 * Wave 2 · 技术 Review P1-3 修正：原实现只做 `x == null` 空值检查，然后 `Number(x)`
 * 直接透传；客户端若传 `"foo"` / 对象 / NaN，`Number(...)` 产生 NaN 后进入 nut-js 会
 * 抛 cryptic error 并被错误分类成 INTERNAL_ERROR。本函数作为"字段有效性"守卫，
 * 让路由层能在 Executor 之前返回清晰的 VALIDATION_ERROR。
 *
 * 语义：
 * - null / undefined 视作"未提供"（由各路由自己的 null 检查决定是否必填）
 * - 数字字面量 / 可 Number(v) 产出有限值的字符串视作有效
 * - NaN / Infinity / 对象 / 数组视作无效
 */
function isFiniteNumberLike(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') {
    if (value.trim() === '') return false
    const n = Number(value)
    return Number.isFinite(n)
  }
  return false
}

/** 数值字段"存在且能转成有限数字"——兼容字符串与 number 输入。 */
function requireFiniteNumbers(
  body: Record<string, unknown>,
  fields: readonly string[],
): { ok: true } | { ok: false; field: string } {
  for (const f of fields) {
    const v = body[f]
    if (v == null) return { ok: false, field: f }
    if (!isFiniteNumberLike(v)) return { ok: false, field: f }
  }
  return { ok: true }
}

function statusFromErrorCode(code: DesktopErrorCode): number {
  switch (code) {
    case DesktopErrorCode.UNKNOWN_ROUTE:
      return 404
    case DesktopErrorCode.VALIDATION_ERROR:
      return 400
    case DesktopErrorCode.UNSUPPORTED_PLATFORM:
      return 400
    case DesktopErrorCode.POLICY_BLOCKED:
    case DesktopErrorCode.NEEDS_APPROVAL:
    case DesktopErrorCode.PERMISSION_DENIED:
    case DesktopErrorCode.LOCK_CONFLICT:
    case DesktopErrorCode.SESSION_EXPIRED:
    case DesktopErrorCode.DISPLAY_CONFIG_CHANGED:
    case DesktopErrorCode.TCC_DENIED:
    case DesktopErrorCode.ABORTED:
      return 403
    case DesktopErrorCode.ELEMENT_NOT_FOUND:
      return 400
    case DesktopErrorCode.AX_UNAVAILABLE:
      return 403
    case DesktopErrorCode.INTERNAL_ERROR:
    case DesktopErrorCode.UNKNOWN:
    default:
      return 500
  }
}

/** 统一生成错误响应——强制 `code` 字段走枚举，供路由内部的所有错误路径引用。 */
function desktopErrorPayload(
  code: DesktopErrorCode,
  message: string,
  extras?: { detail?: unknown; suggestions?: string[] },
): DesktopErrorResponse {
  const base = errorResponse(code as unknown as ErrorCode, message, extras)
  return { ...base, code } as unknown as DesktopErrorResponse
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function handleDesktopRoute(
  url: string,
  _method: string,
  rawBody: unknown,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/desktop/, '')
  const body = (rawBody ?? {}) as DesktopRequestBody

  if (!KNOWN_ROUTES.has(route)) {
    sendJSON(res, 404, desktopErrorPayload(
      DesktopErrorCode.UNKNOWN_ROUTE,
      `未知的桌面操控路由：${url}。本次请求未执行。请检查 CLI 命令拼写或参考 tabtin desktop --help 列出全部已支持子命令。`,
    ))
    return
  }

  // Linux 顶层拦截（与 § 7.2 / app.json runtimeSupport.linux=unavailable 对齐）。
  // 例外：/accessibility 是诊断工具（规范 § 4.4.3.1），Linux 下也应允许返回
  // { platform: 'linux', trusted: false, screenRecording: false, screenRecordingStatus: 'unavailable' }
  // 这种精细语义，而不是被顶层 guard 吞成泛化"不支持"。
  if (
    process.platform !== 'darwin' &&
    process.platform !== 'win32' &&
    route !== '/accessibility'
  ) {
    sendJSON(res, statusFromErrorCode(DesktopErrorCode.UNSUPPORTED_PLATFORM), desktopErrorPayload(
      DesktopErrorCode.UNSUPPORTED_PLATFORM,
      `不支持此操作：桌面操控仅在 macOS 和 Windows 可用。` +
      `当前系统识别为 ${process.platform}，本次请求未执行；所有桌面操控命令在本机不可用。` +
      `如需桌面操控，请在 macOS 或 Windows 上运行 TabTin 客户端。`,
    ))
    return
  }

  const executor = getCLIDesktopExecutor<DesktopExecutorService>()
  if (!executor) {
    sendJSON(res, 503, desktopErrorPayload(
      DesktopErrorCode.INTERNAL_ERROR,
      `桌面操控暂不可用：执行器尚未初始化。本次请求未执行。请确认 TabTin 桌面客户端已完全启动后重试。`,
      { suggestions: ['等待 TabTin 桌面客户端完全启动后再发起请求'] },
    ))
    return
  }

  // Wave 2.1 · 规范 § 6.5 命令行侧兑现：device_permissions.desktop_observe 为
  // 'block' 时"桌面操控完全不可用"——在任何策略评估 / session 获锁 / Executor
  // 调用之前 fail-fast。Python Prompt 侧 (`device_permissions_policy.py`) 已在
  // v1.4 落地 SECTION_TABDESKTOP → 兜底段切换，命令行侧此前只读 preset 字符串
  // 不读 device_permissions，导致 Python"承诺不可用"但 Electron 路由仍会走到
  // Guard / Executor 的"半落地"。
  //
  // 豁免：`/accessibility` 是诊断工具（§ 4.4.3.1，v1.3 Linux 豁免顶层拦截的
  // 同一设计理由）——即便 Space 关了桌面观察权限，也应允许查"权限是否授予"
  // 的诊断体，供 UI 引导用户去系统设置授权。
  //
  // fallback 口径：device_permissions 字段缺失 / 渲染侧尚未推送（currentSpace
  // DevicePermissions === null） → **不拦截**，让下游走现有策略评估。这是"保守
  // 允许"而非"保守拒绝"：全面拒绝会让冷启动 / Space 切换瞬间所有桌面路由 403，
  // 破坏用户体验；真正 block 的意图由用户显式在 Space 设置里配置，被渲染侧
  // 推送后才生效。
  if (route !== '/accessibility') {
    const perms = getCurrentSpaceDevicePermissions()
    if (perms && perms['desktop_observe'] === 'block') {
      const code = DesktopErrorCode.POLICY_BLOCKED
      sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
        code,
        // Wave 2.2 · 规范 § 8.2：用户可见文案禁止暴露内部字段路径。
        // 技术字段 `device_permissions.desktop_observe` 仅保留在 detail.ruleName
        // 里供工程师排障；message 正文使用自然语言 + UI 路径。
        `桌面操控被授权策略阻止：当前 Space 关闭了桌面观察权限。` +
        `本次请求未执行；所有桌面操控命令（截屏 / 点击 / 输入 / 窗口管理）在本 Space 都不可用。` +
        `请在 Space 设置 → 授权策略 中把「桌面观察权限」改为「允许」或「每次确认」后重新发起，` +
        `或切换到已启用桌面操控的 Space。`,
        { detail: { ruleName: 'device_permissions.desktop_observe', ruleReason: 'block' } },
      ))
      writeAuditLog({
        action: route.slice(1).replace(/\//g, '_') || 'unknown_route',
        sessionId: executor.getSession()?.sessionId ?? null,
        params: body as Record<string, unknown>,
        result: 'error',
        errorCode: code,
        // 审计 errorMessage 仍保留技术字段名——审计是给运维排障看的，不是用户可见。
        errorMessage: 'device_permissions.desktop_observe=block',
      })
      return
    }
  }

  const guard = getCLIDesktopGuard()

  // PD-11（W6 M3）：原"effective preset 解析 + PolicyEvaluator 'device_action'
  // 拦截"语义已删除。device 动作的拦截现在只看：
  //   1. device_permissions.desktop_observe=block（上方 §6.5 入口已拦）；
  //   2. 是否持有 DesktopUseLock + guard.isApproved()（下方"非 session 入口
  //      路由要求当前持有锁"段保留）。
  // CLI client 不再传 _authPreset；任何想压低 yolo 的产品需求请走 Space
  // agent_config 入库。

  // 非 session 入口路由（/screenshot、/session/*、元管理路由除外）要求当前持有锁。
  //
  // Wave 2 · 产品 Review P1-3 修正：`/revoke-approval` 是"元管理"路由（撤销持久化的
  // 「总是允许」记录），本身就是 session 外的操作——Agent / 用户可以在没有活跃
  // session 的情况下主动撤销。若把它纳入锁检查，CLI `tabtin desktop revoke-approval`
  // 会先报 "请先运行 tabtin desktop screenshot 建立 session"，逻辑倒置。
  const sessionRoutes = new Set<string>([
    '/session/start',
    '/session/end',
    '/session/extend-allowlist',
    '/accessibility',
    '/revoke-approval',
  ])
  if (!sessionRoutes.has(route) && route !== '/screenshot') {
    const hasLock = guard
      ? (await import('../../services/DesktopUseLock')).isHeldLocally()
      : executor.getSession() != null
    if (!hasLock) {
      const code = DesktopErrorCode.PERMISSION_DENIED
      sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
        code,
        `桌面操控未启动：当前没有活跃的 session 锁。` +
        `本次请求未执行；其他桌面应用不受影响。` +
        `请先运行 tabtin desktop screenshot 触发审批并建立 session（推荐），` +
        `或显式调用 tabtin desktop session start 启动会话后再执行操作。`,
      ))
      writeAuditLog({
        action: route.slice(1),
        sessionId: null,
        params: body as Record<string, unknown>,
        result: 'error',
        errorCode: code,
        errorMessage: 'no active session lock',
      })
      return
    }
  }

  // Session 空闲 > 10min 强制结束（§ 5.3 规则 5）
  const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000
  const idleMs = executor.getIdleMs()
  if (
    idleMs > SESSION_IDLE_TIMEOUT_MS &&
    !sessionRoutes.has(route) &&
    route !== '/screenshot'
  ) {
    const sid = executor.getSession()?.sessionId ?? null
    executor.endSession()
    if (guard && sid) {
      await guard.release(sid).catch(() => {})
    }
    const code = DesktopErrorCode.SESSION_EXPIRED
    sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
      code,
      // Wave 2.2 · 与 DISPLAY_CONFIG_CHANGED 刻意用独立特征词（"超时 / 空闲"）
      // 区分，让 Agent 一眼看出根因是"停太久"而不是"设备变化"。
      `桌面操控会话已超时：空闲超过 10 分钟（实际 ${Math.round(idleMs / 1000)} 秒），系统已自动结束会话并释放锁。` +
      `本次请求未执行；其他桌面应用不受影响。` +
      `请重新运行 tabtin desktop screenshot 建立新会话后再继续操作。`,
    ))
    writeAuditLog({
      action: route.slice(1),
      sessionId: sid,
      params: body as Record<string, unknown>,
      result: 'error',
      errorCode: code,
      errorMessage: `idle ${idleMs}ms > ${SESSION_IDLE_TIMEOUT_MS}ms`,
    })
    return
  }

  // v2.1 模块零（规范 § 3.5.6 + § 9.1）· 路由层与 Executor 解耦初步：
  // 动作类路由走 bindSessionContext wrapper，元路由（screenshot/session/*/
  // accessibility/revoke-approval）保持直接调 executor（这些是"建立 / 操作
  // session 本身"的入口，包 wrapper 是套娃）。
  //
  // 模块零阶段：wrapper 是 thin proxy + ctx 一致性校验 —— 行为 100% 等价
  // 直接调 executor，但接口形状已经为 M2 多 session 演进路径准备好。
  // 当前无 session（冷启动）时 deriveSessionContextFromExecutor 返回 null，
  // 各动作路由的"必须先持锁"前置检查（已有的 hasLock guard）会先拦住——
  // 不会走到 bound.<method> 抛 PERMISSION_DENIED 的兜底路径。
  const ctx = deriveSessionContextFromExecutor(executor as unknown as Parameters<typeof deriveSessionContextFromExecutor>[0])
  const bound = ctx ? bindSessionContext(executor as unknown as Parameters<typeof bindSessionContext>[0], ctx) : null

  try {
    switch (route) {
      case '/screenshot': {
        const shotBody = body as DesktopScreenshotBody

        // Wave 2 · 技术 Review P2 修正：region 字段校验——避免 `{x:-100, width:-10}`
        // 穿透到 sharp.extract 抛 cryptic libvips 错误后被误分类成 INTERNAL_ERROR。
        if (shotBody.region != null) {
          const r = shotBody.region as unknown
          if (typeof r !== 'object' || r == null || Array.isArray(r)) {
            return respondValidationError(
              res, sendJSON, executor.getSession()?.sessionId ?? null, 'screenshot', body,
              `请求参数非法：screenshot 的 region 必须是 {x, y, width, height} 对象。本次截屏未执行。`,
            )
          }
          const regionCheck = requireFiniteNumbers(
            r as Record<string, unknown>,
            ['x', 'y', 'width', 'height'],
          )
          if (!regionCheck.ok) {
            return respondValidationError(
              res, sendJSON, executor.getSession()?.sessionId ?? null, 'screenshot', body,
              `请求参数非法：screenshot 的 region.${regionCheck.field} 必须是有限数字。本次截屏未执行。` +
              `请改用 tabtin desktop screenshot --region <x>,<y>,<w>,<h> 重新调用。`,
            )
          }
          const reg = r as { x: number; y: number; width: number; height: number }
          if (Number(reg.x) < 0 || Number(reg.y) < 0) {
            return respondValidationError(
              res, sendJSON, executor.getSession()?.sessionId ?? null, 'screenshot', body,
              `请求参数非法：screenshot 的 region.x / region.y 必须 ≥ 0（收到 x=${reg.x}, y=${reg.y}）。本次截屏未执行。`,
            )
          }
          if (Number(reg.width) <= 0 || Number(reg.height) <= 0) {
            return respondValidationError(
              res, sendJSON, executor.getSession()?.sessionId ?? null, 'screenshot', body,
              `请求参数非法：screenshot 的 region.width / region.height 必须 > 0（收到 width=${reg.width}, height=${reg.height}）。本次截屏未执行。`,
            )
          }
        }

        // PD-11（W6 M3）：删除"通过 PolicyEvaluator + getPresetPolicy 检查
        // device_screenshot=block"的重复路径——上方 §6.5 入口
        // `desktop_observe=block` 入口 fail-fast 已经覆盖（用户可见的"关闭桌面
        // 观察权限"是单一权威）。此处不再做重复策略评估。

        let freshAcquire = false
        let acquiredSessionId: string | undefined
        if (guard && !(await import('../../services/DesktopUseLock')).isHeldLocally()) {
          const sessionIdForCli = String(shotBody.sessionId ?? `cli-${Date.now()}`)
          acquiredSessionId = sessionIdForCli
          const acquireResult = await guard.acquire(sessionIdForCli)
          if (!acquireResult.ok) {
            const code = DesktopErrorCode.PERMISSION_DENIED
            sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
              code,
              acquireResult.reason ??
                `桌面操控审批未通过：本次请求未执行。请在弹窗中允许桌面操控，或检查锁文件后重试。`,
            ))
            writeAuditLog({
              action: 'screenshot',
              sessionId: sessionIdForCli,
              params: shotBody as Record<string, unknown>,
              result: 'error',
              errorCode: code,
              errorMessage: acquireResult.reason?.slice(0, 200),
            })
            return
          }
          executor.startSession(sessionIdForCli, {
            grantFlags: { clipboardWrite: true },
            allowedApps: Array.isArray(shotBody.allowedApps) ? shotBody.allowedApps : undefined,
          })
          executor.setAbortSignal(acquireResult.abortSignal)
          freshAcquire = true
        }
        try {
          const result = await executor.screenshot({
            displayId: shotBody.displayId,
            maxDimension: shotBody.maxDimension,
            savePath: shotBody.savePath,
            region: shotBody.region,
            imageResize: shotBody.imageResize
              ? {
                  // Wave 3 · 规范 § 4.5.1：默认 enabled=true（客户端不传时）；
                  // 只有显式传 false 才走 Wave 2 兼容 maxDim 单参数路径。
                  enabled: shotBody.imageResize.enabled !== false,
                  params: shotBody.imageResize.params
                    ? {
                        ...(shotBody.imageResize.params.pxPerToken != null
                          ? { pxPerToken: shotBody.imageResize.params.pxPerToken }
                          : {}),
                        ...(shotBody.imageResize.params.maxTargetPx != null
                          ? { maxTargetPx: shotBody.imageResize.params.maxTargetPx }
                          : {}),
                        ...(shotBody.imageResize.params.maxTargetTokens != null
                          ? { maxTargetTokens: shotBody.imageResize.params.maxTargetTokens }
                          : {}),
                      }
                    : undefined,
                }
              : undefined,
          })
          sendJSON(res, 200, okResponse(result))
        } catch (screenshotErr) {
          if (freshAcquire && acquiredSessionId && guard) {
            executor.endSession()
            await guard.release(acquiredSessionId).catch(() => {})
          }
          throw screenshotErr
        }
        break
      }

      case '/click': {
        const { button, count } = body as DesktopClickBody
        const check = requireFiniteNumbers(body as Record<string, unknown>, ['x', 'y'])
        if (!check.ok) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'click',
            body,
            `请求参数${check.field === 'x' || check.field === 'y' ? '非法' : '缺失'}：click 需要有限数字类型的 x 与 y 坐标（字段「${check.field}」未提供或无法解析为数字）。` +
            `本次点击未执行。请改用 tabtin desktop click <x> <y> 重新调用，确保 x / y 为数字。`,
          )
        }
        const { x, y } = body as DesktopClickBody
        if (button != null && !['left', 'right', 'middle'].includes(String(button))) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'click',
            body,
            `请求参数非法：click 的 button 只接受 left / right / middle（收到「${String(button)}」）。` +
            `本次点击未执行。请改用 tabtin desktop click <x> <y> --button left 重新调用。`,
          )
        }
        // v2.1 模块零：走 bound wrapper（ctx 必存在——前面 hasLock 检查已保证）。
        // bound 为 null 时（理论不应发生）兜底到 executor 直调，行为不变。
        await (bound ?? executor).click(Number(x), Number(y), {
          button: (button as 'left' | 'right' | 'middle' | undefined) ?? 'left',
          count: count != null && isFiniteNumberLike(count) ? Number(count) : 1,
        })
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/scroll': {
        const { dx, dy } = body as DesktopScrollBody
        const check = requireFiniteNumbers(body as Record<string, unknown>, ['x', 'y'])
        if (!check.ok) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'scroll',
            body,
            `请求参数${check.field === 'x' || check.field === 'y' ? '非法' : '缺失'}：scroll 需要有限数字类型的 x 与 y 坐标（字段「${check.field}」未提供或无法解析为数字）。` +
            `本次滚动未执行。请改用 tabtin desktop scroll <x> <y> --dy <n> 重新调用。`,
          )
        }
        if (dx != null && !isFiniteNumberLike(dx)) {
          return respondValidationError(
            res, sendJSON, executor.getSession()?.sessionId ?? null, 'scroll', body,
            `请求参数非法：scroll 的 dx 需要数字（收到「${JSON.stringify(dx)}」）。本次滚动未执行。`,
          )
        }
        if (dy != null && !isFiniteNumberLike(dy)) {
          return respondValidationError(
            res, sendJSON, executor.getSession()?.sessionId ?? null, 'scroll', body,
            `请求参数非法：scroll 的 dy 需要数字（收到「${JSON.stringify(dy)}」）。本次滚动未执行。`,
          )
        }
        const { x, y } = body as DesktopScrollBody
        await (bound ?? executor).scroll(
          Number(x),
          Number(y),
          dx != null ? Number(dx) : 0,
          dy != null ? Number(dy) : 0,
        )
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/drag': {
        const check = requireFiniteNumbers(
          body as Record<string, unknown>,
          ['fromX', 'fromY', 'toX', 'toY'],
        )
        if (!check.ok) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'drag',
            body,
            `请求参数非法：drag 需要有限数字类型的 fromX / fromY / toX / toY 四个坐标（字段「${check.field}」未提供或无法解析为数字）。` +
            `本次拖拽未执行。请改用 tabtin desktop drag <x1>,<y1> <x2>,<y2> 重新调用。`,
          )
        }
        const { fromX, fromY, toX, toY, duration } = body as DesktopDragBody
        if (duration != null && !isFiniteNumberLike(duration)) {
          return respondValidationError(
            res, sendJSON, executor.getSession()?.sessionId ?? null, 'drag', body,
            `请求参数非法：drag 的 duration 需要数字毫秒（收到「${JSON.stringify(duration)}」）。本次拖拽未执行。`,
          )
        }
        await (bound ?? executor).drag(
          { x: Number(fromX), y: Number(fromY) },
          { x: Number(toX), y: Number(toY) },
          duration != null ? Number(duration) : 500,
        )
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/move': {
        const check = requireFiniteNumbers(body as Record<string, unknown>, ['x', 'y'])
        if (!check.ok) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'move',
            body,
            `请求参数非法：move 需要有限数字类型的 x 与 y 坐标（字段「${check.field}」未提供或无法解析为数字）。` +
            `本次鼠标移动未执行。请改用 tabtin desktop move <x> <y> 重新调用。`,
          )
        }
        const { x, y } = body as DesktopMoveBody
        await (bound ?? executor).move(Number(x), Number(y))
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/type': {
        const { text, clipboard: useClipboard } = body as DesktopTypeBody
        if (text == null) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'type',
            body,
            `请求参数缺失：type 需要 text 字段。本次输入未执行。请改用 tabtin desktop type "<内容>" 重新调用；中文 / emoji 等非 ASCII 字符请加 --clipboard。`,
          )
        }
        await (bound ?? executor).type(String(text), !!useClipboard)
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/key': {
        const { key, modifiers, repeat } = body as DesktopKeyBody
        if (!key) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'key',
            body,
            `请求参数缺失：key 需要 key 字段（如 Enter / Tab / a 等）。本次按键未执行。请改用 tabtin desktop key <key> [--modifiers cmd,shift] 重新调用。`,
          )
        }
        await (bound ?? executor).keyPress(
          String(key),
          Array.isArray(modifiers) ? modifiers.map(String) : [],
          repeat != null ? Number(repeat) : 1,
        )
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/hotkey': {
        const { keys } = body as DesktopHotkeyBody
        if (!Array.isArray(keys) || keys.length === 0) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'hotkey',
            body,
            `请求参数缺失：hotkey 需要非空 keys 数组（如 ["cmd","c"]）。本次组合键未执行。请改用 tabtin desktop hotkey <key1> <key2> ... 重新调用。`,
          )
        }
        await (bound ?? executor).hotkey(keys.map(String))
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/windows': {
        const windows = await (bound ?? executor).listWindows()
        sendJSON(res, 200, okResponse(windows))
        break
      }

      case '/activate': {
        const { target } = body as DesktopActivateBody
        if (!target) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'activate',
            body,
            `请求参数缺失：activate 需要 target（应用名或窗口标题）。本次激活窗口未执行。请改用 tabtin desktop activate "<App Name>" 重新调用。`,
          )
        }
        await (bound ?? executor).activateWindow(String(target))
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/open': {
        const openBody = body as DesktopOpenBody
        const { name } = openBody
        if (!name) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'open',
            body,
            `请求参数缺失：open 需要 name（应用名或可执行 / .app 路径）。本次「打开应用」未执行。请改用 tabtin desktop open "Slack" 或 tabtin desktop open "/Applications/X.app" 重新调用。`,
          )
        }
        const appName = String(name)
        const allowExternal =
          openBody.external === true ||
          (openBody as { external?: unknown }).external === 'true'
        if (!allowExternal && isExternalTerminalAppName(appName)) {
          const code = DesktopErrorCode.VALIDATION_ERROR
          sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
            code,
            `「${appName}」是系统终端。用户说「打开终端」应打开 TabTin 应用内终端，请改用：tabtin terminal open。若用户明确要求外部系统终端，请加 --external：tabtin desktop open "${appName}" --external。`,
            {
              suggestions: [
                'tabtin terminal open',
                'tabtin terminal open --cwd <path> --title "终端"',
                `tabtin desktop open "${appName}" --external`,
              ],
            },
          ))
          return
        }
        await (bound ?? executor).openApp(appName)
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/session/start': {
        const startBody = body as DesktopSessionStartBody
        const sessionId = String(startBody.sessionId ?? `cli-${Date.now()}`)
        if (guard) {
          const acquireResult = await guard.acquire(sessionId)
          if (!acquireResult.ok) {
            const code = DesktopErrorCode.PERMISSION_DENIED
            sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
              code,
              acquireResult.reason ??
                `桌面操控审批未通过：本次会话启动未完成。请在弹窗中允许桌面操控后重试。`,
            ))
            writeAuditLog({
              action: 'session_start',
              sessionId,
              params: startBody as Record<string, unknown>,
              result: 'error',
              errorCode: code,
              errorMessage: acquireResult.reason?.slice(0, 200),
            })
            return
          }
          executor.startSession(sessionId, {
            grantFlags: { clipboardWrite: true },
            allowedApps: Array.isArray(startBody.allowedApps) ? startBody.allowedApps : undefined,
          })
          executor.setAbortSignal(acquireResult.abortSignal)
        } else {
          executor.startSession(sessionId, {
            grantFlags: { clipboardWrite: true },
            allowedApps: Array.isArray(startBody.allowedApps) ? startBody.allowedApps : undefined,
          })
        }
        sendJSON(res, 200, okResponse({ sessionId: executor.getSession()?.sessionId }))
        break
      }

      case '/session/end': {
        const sid = executor.getSession()?.sessionId ?? null
        executor.endSession()
        if (guard && sid) {
          await guard.release(sid)
        }
        sendJSON(res, 200, okResponse({ done: true }))
        break
      }

      case '/session/extend-allowlist': {
        const extendBody = body as DesktopExtendAllowlistBody
        const session = executor.getSession()
        const reqSessionId = typeof extendBody.sessionId === 'string' ? extendBody.sessionId.trim() : ''
        const reqApps = Array.isArray(extendBody.apps)
          ? extendBody.apps
              .filter((a): a is string => typeof a === 'string')
              .map(a => a.trim())
              .filter(a => a.length > 0)
          : []
        const reason = typeof extendBody.reason === 'string' ? extendBody.reason.slice(0, 200) : undefined

        if (!reqSessionId) {
          return respondValidationError(
            res,
            sendJSON,
            session?.sessionId ?? null,
            'session_extend_allowlist',
            extendBody,
            `请求参数缺失：session/extend-allowlist 需要 sessionId 字段。` +
            `本次扩权未执行。请在请求体中填入当前 session 的 sessionId 重试。`,
          )
        }
        if (reqApps.length === 0) {
          return respondValidationError(
            res,
            sendJSON,
            session?.sessionId ?? null,
            'session_extend_allowlist',
            extendBody,
            `请求参数缺失：session/extend-allowlist 需要非空 apps 数组。` +
            `本次扩权未执行。请改用 tabtin desktop session extend-allowlist <app_name> 重新调用。`,
          )
        }
        if (!session || session.sessionId !== reqSessionId) {
          const code = DesktopErrorCode.PERMISSION_DENIED
          sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
            code,
            `扩权失败：当前无活跃 session 或 sessionId 不匹配。` +
            `本次扩权未执行；其他已有授权不受影响。` +
            `请先运行 tabtin desktop screenshot 建立 session，再用同一 sessionId 发起扩权请求。`,
          ))
          writeAuditLog({
            action: 'session_extend_allowlist',
            sessionId: session?.sessionId ?? null,
            params: extendBody as Record<string, unknown>,
            result: 'error',
            errorCode: code,
            errorMessage: 'session mismatch',
          })
          return
        }

        try {
          const merged = await executor.extendAllowedApps(reqSessionId, reqApps, { reason })
          sendJSON(res, 200, okResponse({ sessionId: reqSessionId, allowedApps: merged }))
        } catch (err) {
          const code =
            err instanceof DesktopError
              ? err.code
              : inferErrorCodeFromMessage(err instanceof Error ? err.message : String(err))
          const message = err instanceof Error ? err.message : String(err)
          sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(code, message))
          writeAuditLog({
            action: 'session_extend_allowlist',
            sessionId: reqSessionId,
            params: extendBody as Record<string, unknown>,
            result: 'error',
            errorCode: code,
            errorMessage: message.slice(0, 200),
          })
          return
        }
        break
      }

      case '/accessibility': {
        const { prompt } = body as DesktopAccessibilityBody
        const trusted = executor.checkAccessibility(!!prompt)
        const screenRecording = executor.checkScreenRecording()
        sendJSON(res, 200, okResponse({
          trusted,
          screenRecording: screenRecording.granted,
          screenRecordingStatus: screenRecording.status,
          platform: process.platform,
        }))
        break
      }

      case '/revoke-approval': {
        guard?.revokeDesktopApproval()
        sendJSON(res, 200, okResponse({
          done: true,
          message: '桌面操控授权已撤销：持久化的「总是允许」记录已删除，下次桌面操控会重新弹出审批弹窗。',
        }))
        break
      }

      case '/batch': {
        const batchBody = body as DesktopBatchBody
        const actionsRaw = batchBody.actions
        if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'batch',
            batchBody,
            `请求参数非法：batch 需要非空 actions 数组。` +
            `本次 batch 未执行。` +
            `请改用 tabtin desktop batch --file <path> 或 echo '<json>' | tabtin desktop batch - 重新调用，` +
            `每个子动作需包含 action 字段（click / scroll / drag / move / type / key / hotkey / screenshot / wait）。`,
          )
        }

        // 规范 § 4.5.2 Q5 · 路由层 Q5 双重防线：
        // Executor 入口也会再校验一次（defense in depth），这里在进 Executor 前
        // 就拦住明显非法，避免 audit 'ok' 先写入再 catch 回滚的误导性记录。
        const firstAction = (actionsRaw[0] as { action?: unknown })?.action
        if (firstAction === 'screenshot') {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'batch',
            batchBody,
            `batch 首项不能是 screenshot，请先单独调 tabtin desktop screenshot 建立 session 后再发起 batch。` +
            `本次 batch 未执行，其他桌面操控不受影响。` +
            `原因：batch 入口走一次 desktop_input 策略评估，若首项又是 screenshot 会产生"入口已审批但子动作触发新审批"的复杂耦合（规范 § 4.5.2 · Q5）。` +
            `非首项 screenshot 是正常子动作（用于中途刷新坐标系），不受此限制。`,
          )
        }

        // Executor narrow 校验 + 实际执行。失败的子动作会由 Executor 返回结构化
        // 结果 { stepFailed, error } 而不是抛——这样路由层能记完整审计（包括
        // 部分成功步数），Agent 也能基于 stepsCompleted 决定从哪一步续跑。
        const result = await (bound ?? executor).batch(actionsRaw as BatchAction[])
        sendJSON(res, 200, okResponse(result))
        break
      }

      case '/accessibility-tree': {
        const axBody = body as DesktopAccessibilityTreeBody
        const snapshot = await executor.captureAccessibilityTree({
          window: axBody.window,
          bundleId: axBody.bundleId,
          maxDepth: axBody.maxDepth != null && isFiniteNumberLike(axBody.maxDepth)
            ? Number(axBody.maxDepth) : undefined,
          interactiveOnly: axBody.interactiveOnly,
          maxNodes: axBody.maxNodes != null && isFiniteNumberLike(axBody.maxNodes)
            ? Number(axBody.maxNodes) : undefined,
        })
        sendJSON(res, 200, okResponse(snapshot))
        break
      }

      case '/click-element': {
        const ceBody = body as DesktopClickElementBody
        if (!ceBody.name) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'click_element',
            body,
            `请求参数缺失：click-element 需要 name 字段（要点击的元素名）。` +
            `本次点击未执行。请改用 tabtin desktop click-element --name "<名称>" 重新调用。`,
          )
        }
        if (ceBody.button != null && !['left', 'right', 'middle'].includes(String(ceBody.button))) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'click_element',
            body,
            `请求参数非法：click-element 的 button 只接受 left / right / middle（收到「${String(ceBody.button)}」）。` +
            `本次点击未执行。`,
          )
        }
        const ceResult = await executor.clickElement({
          name: String(ceBody.name),
          role: ceBody.role ? String(ceBody.role) : undefined,
          automationId: ceBody.automationId ? String(ceBody.automationId) : undefined,
          nth: ceBody.nth != null && isFiniteNumberLike(ceBody.nth) ? Number(ceBody.nth) : undefined,
          button: (ceBody.button as 'left' | 'right' | 'middle' | undefined) ?? undefined,
          count: ceBody.count != null && isFiniteNumberLike(ceBody.count) ? Number(ceBody.count) : undefined,
        })
        sendJSON(res, 200, okResponse(ceResult))
        break
      }

      case '/type-into-element': {
        const teBody = body as DesktopTypeIntoElementBody
        if (!teBody.name) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'type_into_element',
            body,
            `请求参数缺失：type-into-element 需要 name 字段（目标元素名）。` +
            `本次输入未执行。请改用 tabtin desktop type-into-element --name "<名称>" "<文本>" 重新调用。`,
          )
        }
        if (teBody.text == null) {
          return respondValidationError(
            res,
            sendJSON,
            executor.getSession()?.sessionId ?? null,
            'type_into_element',
            body,
            `请求参数缺失：type-into-element 需要 text 字段（要输入的文本）。` +
            `本次输入未执行。请改用 tabtin desktop type-into-element --name "<名称>" "<文本>" 重新调用。`,
          )
        }
        const teResult = await executor.typeIntoElement({
          name: String(teBody.name),
          role: teBody.role ? String(teBody.role) : undefined,
          automationId: teBody.automationId ? String(teBody.automationId) : undefined,
          text: String(teBody.text),
          clipboard: !!teBody.clipboard,
        })
        sendJSON(res, 200, okResponse(teResult))
        break
      }

      default: {
        const code = DesktopErrorCode.UNKNOWN_ROUTE
        sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(
          code,
          `未知的桌面操控路由：${url}。本次请求未执行。请检查 CLI 命令拼写或参考 tabtin desktop --help 列出全部已支持子命令。`,
        ))
        return
      }
    }

    // 成功路径：只对"路由层独有"的成功事件补 jsonl 记录——
    //   - device_action 类（click/screenshot/...）：Executor.audit 已记入口 ok，
    //     此处不重复写（规范 § 6.11.3 "统一走 writeAuditLog"但不要双写）
    //   - session_extend_allowlist：Executor.audit 已记 ok
    //   - session_start / session_end / revoke-approval：Executor 未记，此处补登
    const successAuditRoutes: Record<string, string> = {
      '/session/start': 'session_start',
      '/session/end': 'session_end',
      '/revoke-approval': 'session_revoke_approval',
    }
    const successAuditAction = successAuditRoutes[route]
    if (successAuditAction) {
      writeAuditLog({
        action: successAuditAction,
        sessionId: executor.getSession()?.sessionId ?? null,
        params: body as Record<string, unknown>,
        result: 'ok',
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    let code: DesktopErrorCode
    if (err instanceof DesktopError) {
      code = err.code
    } else if (isDesktopErrorCode((err as { code?: unknown })?.code)) {
      code = (err as { code: DesktopErrorCode }).code
    } else {
      code = inferErrorCodeFromMessage(message)
    }

    // 错误路径：所有 route 都记 jsonl（路由层是唯一能拦住"进不到 Executor"
    // 类错误——策略拒绝 / 锁冲突 / session 超时 / Executor 抛错——的地方）。
    // Executor 自己抛错时已在入口记过一条 entry 'ok'，此处补 'error + errorCode'。
    writeAuditLog({
      action: route.slice(1).replace(/\//g, '_') || 'unknown_route',
      sessionId: executor.getSession()?.sessionId ?? null,
      params: body as Record<string, unknown>,
      result: 'error',
      errorCode: code,
      errorMessage: message.slice(0, 200),
    })

    sendJSON(
      res,
      statusFromErrorCode(code),
      desktopErrorPayload(
        code,
        message,
        code === DesktopErrorCode.TCC_DENIED
          ? { suggestions: ['在 macOS 系统设置 → 隐私与安全 → 辅助功能 中启用 TabTin'] }
          : undefined,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// 内部助手
// ---------------------------------------------------------------------------

function respondValidationError(
  res: http.ServerResponse,
  sendJSON: SendJSON,
  sessionId: string | null,
  action: string,
  body: DesktopRequestBody,
  message: string,
): void {
  const code = DesktopErrorCode.VALIDATION_ERROR
  sendJSON(res, statusFromErrorCode(code), desktopErrorPayload(code, message))
  writeAuditLog({
    action,
    sessionId,
    params: body as Record<string, unknown>,
    result: 'error',
    errorCode: code,
    errorMessage: message.slice(0, 200),
  })
}

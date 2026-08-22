/**
 * DesktopExecutorService — 桌面操控核心执行器
 *
 * 运行在 Electron 主进程中，提供截屏、鼠标、键盘、窗口管理等能力。
 * CLI 通过 IPC 路由调用本服务的方法。
 *
 * 坐标铁律：所有坐标使用逻辑坐标（points），不使用物理像素。
 * nut-js 在 macOS 上用 CoreGraphics CGEvent，接受逻辑坐标。
 */

import {
  app,
  screen as electronScreen,
  desktopCapturer,
  clipboard,
  systemPreferences,
  type BrowserWindow,
} from 'electron'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { createLogger } from '../logger'
import { writeAuditLog } from './desktop-audit-logger'
import { DesktopError, DesktopErrorCode } from './desktop-error-codes'
import {
  DEFAULT_IMAGE_RESIZE_PARAMS,
  targetImageSize,
  type ImageResizeParams,
} from './desktop-image-resize'
import { resolveKey, getDangerousKeyCombos, normalizeModifierKey } from './desktop-key-safety'
import { requestApproval } from './ApprovalManager'
import {
  type WindowInfo,
  listWindowsMac,
  listWindowsWin,
  getAppAtPoint,
  escapeAppleScript,
} from './desktop-window-helpers'

const log = createLogger('DesktopExecutor')
const DESKTOP_SCREENSHOT_DIR = getHomeTabtinPath('screenshots')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesktopScreenshotDims {
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  scaleFactor: number
  regionOffset?: { x: number; y: number }
}

export interface DesktopSession {
  sessionId: string
  frozenDisplayConfig?: {
    width: number; height: number; scaleFactor: number
    boundsX: number; boundsY: number
  }
  lastScreenshotDims?: DesktopScreenshotDims
  /**
   * 上一次截图落盘的文件路径（Wave 3 · pixelCompare 新增）。
   * 点击 / 拖拽前做 9×9 像素比对时按需 decode 该文件的对应区域。
   * 规范 § 4.5.3 第 6 点：v1 按文件读取路径实现（节省内存）。
   */
  lastScreenshotPath?: string
  grantFlags: { clipboardRead: boolean; clipboardWrite: boolean; systemKeyCombos: boolean }
  selectedDisplayId?: number
  mainWindowHidden?: boolean
  allowedApps?: string[]
  startedAt: number
  lastActivityAt?: number
  screenRecordingChecked?: boolean
}

export interface DesktopScreenshotResult extends DesktopScreenshotDims {
  path: string
  sessionId?: string
}

export type { WindowInfo }

// ---------------------------------------------------------------------------
// Batch 子动作类型（Wave 3 · 规范 § 4.5.2）
// ---------------------------------------------------------------------------
//
// Discriminated union —— action 字段充当 tag。类型定义与桌面动作协议
// `tools.ts:894-914` computer_batch schema 在语义上一致（我们按 TabDesktop
// 单步 API 的现有签名组装字段，而非照抄 MCP tool schema）。
//
// 规范约束：批入口校验 `actions[0].action !== 'screenshot'`；各子动作的
// 业务语义与 `DesktopExecutorService` 单步方法一对一（click/scroll/drag/...）。

export type BatchAction =
  | { action: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { action: 'scroll'; x: number; y: number; dx?: number; dy?: number }
  | { action: 'drag'; fromX: number; fromY: number; toX: number; toY: number; duration?: number }
  | { action: 'move'; x: number; y: number }
  | { action: 'type'; text: string; useClipboard?: boolean }
  | { action: 'key'; key: string; modifiers?: string[]; repeat?: number }
  | { action: 'hotkey'; keys: string[] }
  | {
      action: 'screenshot'
      displayId?: number
      maxDimension?: number
      region?: { x: number; y: number; width: number; height: number }
    }
  | { action: 'wait'; ms: number }

export interface BatchResult {
  /** 成功执行的步数（0-indexed 的起点，失败或全成功时的分界点） */
  stepsCompleted: number
  /**
   * 失败的步索引（0-based）；`null` 表示全部成功。使用 null 而非缺省字段
   * 让 Agent 在 JSON 里显式看到"这次 batch 全绿"。
   */
  stepFailed: number | null
  /** 失败步的 action 类型（便于审计聚合） */
  failedAction?: string
  /** 失败详情：code + 中文三段式 message */
  error?: { code: string; message: string }
  /**
   * 最后一次 screenshot 子动作的结果（便于 Agent 在 batch 末尾拿到最新
   * 坐标系做 fallback 分析；没有 screenshot 子动作时为 undefined）。
   */
  lastScreenshot?: DesktopScreenshotResult
}

// ---------------------------------------------------------------------------
// nut-js lazy loader & utilities
// ---------------------------------------------------------------------------

let _nutJs: typeof import('@nut-tree-fork/nut-js') | null = null

async function loadNutJs() {
  if (!_nutJs) {
    _nutJs = await import('@nut-tree-fork/nut-js')
    _nutJs.mouse.config.mouseSpeed = 2000
    _nutJs.keyboard.config.autoDelayMs = 25
    _nutJs.mouse.config.autoDelayMs = 0
  }
  return _nutJs
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

// Linux 不支持桌面操控时统一抛出的中文三段式错误（原因 · 影响 · 行动）。
// 主干一致："桌面操控仅在 macOS 和 Windows 可用"——便于全局 grep 验收。
// Wave 2 · v1.4：改抛 DesktopError(UNSUPPORTED_PLATFORM)，供路由/审计直接取 code，
// 避免路由层 inferErrorCodeFromMessage 字符串匹配反模式（规范 § 6.11.1）。
function linuxNotSupported(actionLabel: string): DesktopError {
  return new DesktopError(
    DesktopErrorCode.UNSUPPORTED_PLATFORM,
    `不支持此操作：桌面操控仅在 macOS 和 Windows 可用。` +
    `当前系统识别为 ${process.platform}，本次${actionLabel}未执行，操作已被阻止。` +
    `如需桌面操控，请在 macOS 或 Windows 上运行 TabTin 客户端。`,
  )
}

export class DesktopExecutorService {
  // 接受应用名（"Microsoft Excel"）或可执行/.app 路径
  // （"/Applications/Visual Studio Code.app"、"C:\\Program Files\\App\\app.exe"）。
  // 允许的字符：Unicode 字母数字 + 常见标点 + 路径分隔符（/ \ :）。
  // shell 元字符（; | & $ ` < > ! 等）继续被拒，提供 defense-in-depth；
  // 实际 execFileSync 走参数数组、不走 shell，但保留校验避免脏数据。
  private static readonly APP_NAME_PATTERN = /^[\p{L}\p{N} \t.\-_()+'#:/\\]+$/u

  private currentSession: DesktopSession | null = null
  private mainWindowGetter: () => BrowserWindow | null
  private abortSignal?: AbortSignal
  private opChain: Promise<void> = Promise.resolve()
  private idleTimer?: ReturnType<typeof setInterval>
  private onSessionTimeout?: (sessionId: string) => void
  private sessionEnding = false

  /**
   * Wave 3 · 规范 § 4.5.3：pixelCompare 开关。默认启用——由构造函数或
   * `setPixelCompareEnabled` 切换。关闭时 `verifyClickTarget` 变成 no-op
   * 直接放行，行为与 Wave 2 等价。
   *
   * v2.1 模块零接通 app.json plumbing 后：实例化点（deferred-init-action-bridge.ts）
   * 通过 `loadAppConfig('tabdesktop', ...)` 读到 app.json 的 `tabdesktop.pixelCompare.enabled`
   * 传入；改 app.json 重启即生效（v1.8 § 10 Q11 债偿）。
   */
  private pixelCompareEnabled = true

  /**
   * 模块三-3a：Windows bound window 模式下的 HWND。
   * 非 null 时 click/type/keyPress 走 bridge.py SendMessage，不动真实鼠标。
   */
  private boundWindowHwnd: number | null = null

  /**
   * v2.1 模块零接通 app.json plumbing 新增字段：实例级 imageResize 开关
   * 与默认参数（规范 § 4.5.1 + § 3.5.5）。
   *
   * - `imageResizeEnabledDefault`：当 `screenshot` 调用方未显式传 `opts.imageResize.enabled`
   *   时使用此值；规范 § 4.5.1 默认 true（可被 app.json `tabdesktop.imageResize.enabled` 改）。
   * - `imageResizeParamsDefault`：当调用方未显式传 `opts.imageResize.params` 时使用此值；
   *   规范 § 4.5.1 默认 DEFAULT_IMAGE_RESIZE_PARAMS（可被 app.json `tabdesktop.imageResize.{pxPerToken,maxTargetPx,maxTargetTokens}` 改）。
   *
   * 这两个字段都是"客户端 / 路由层显式传 > 实例 default > 代码 hard-default"
   * 三级覆盖语义——客户端只能收紧、不能放宽（与 imageResize 算法本身的"两条
   * 路径都必生效"相符）。
   */
  private imageResizeEnabledDefault = true
  private imageResizeParamsDefault: ImageResizeParams = { ...DEFAULT_IMAGE_RESIZE_PARAMS }

  constructor(
    mainWindowGetter: () => BrowserWindow | null,
    opts?: {
      onSessionTimeout?: (sessionId: string) => void
      /** Wave 3 · 规范 § 4.5.3：pixelCompare 开关（app.json 默认 true）。 */
      pixelCompareEnabled?: boolean
      /**
       * v2.1 模块零 · 规范 § 4.5.1：imageResize 实例级 default。
       * `enabled` 与 `params` 任一缺省时按 hard-default 处理（规范 § 4.5.1 默认值）。
       */
      imageResize?: {
        enabled?: boolean
        params?: Partial<ImageResizeParams>
      }
    },
  ) {
    this.mainWindowGetter = mainWindowGetter
    this.onSessionTimeout = opts?.onSessionTimeout
    if (opts?.pixelCompareEnabled === false) {
      this.pixelCompareEnabled = false
    }
    if (opts?.imageResize?.enabled === false) {
      this.imageResizeEnabledDefault = false
    }
    if (opts?.imageResize?.params) {
      this.imageResizeParamsDefault = {
        ...this.imageResizeParamsDefault,
        ...opts.imageResize.params,
      }
    }
  }

  /**
   * 动态切换 pixelCompare 开关（app.json 配置热更新路径；非测试场景也有用，
   * 例如 Space 切换后重新评估设备策略）。
   */
  setPixelCompareEnabled(enabled: boolean): void {
    this.pixelCompareEnabled = enabled
  }

  // -- Session management --------------------------------------------------

  startSession(
    sessionId: string,
    opts?: {
      grantFlags?: Partial<DesktopSession['grantFlags']>
      allowedApps?: string[]
    },
  ): void {
    // 幂等保护（不是 bug，是刻意设计 · 规范 § 5.1 · v1.4 Wave 2 明示）：
    // 当 sessionId 与当前 session 相同时直接返回、**不重置任何字段**。
    // 理由：
    //   1. 防止重复调用 /session/start 意外重置 frozenDisplayConfig /
    //      allowedApps / grantFlags 等"session 内冻结"字段（§ 5.3 规则 7）。
    //   2. 扩展 allowedApps 的唯一正规路径是 extendAllowedApps()（§ 6.12），
    //      该方法强制走新审批；Agent 通过重复 start 传新 allowedApps 不生效
    //      是故意的——避免"隐式扩权绕过审批"的反模式。
    //   3. 不要把本分支改为"每次都重置 session 状态"——这样会破坏 fail-fast
    //      语义并让 Wave 2 的 DISPLAY_CONFIG_CHANGED 契约失效。
    // 如需真正重建 session：先调 endSession() 再 startSession(newId)。
    if (this.currentSession?.sessionId === sessionId) return
    this.sessionEnding = false
    this.currentSession = {
      sessionId,
      startedAt: Date.now(),
      grantFlags: {
        clipboardRead: opts?.grantFlags?.clipboardRead ?? false,
        clipboardWrite: opts?.grantFlags?.clipboardWrite ?? false,
        systemKeyCombos: opts?.grantFlags?.systemKeyCombos ?? false,
      },
      allowedApps: opts?.allowedApps,
    }

    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined }
    this.idleTimer = setInterval(() => {
      if (this.getIdleMs() > 10 * 60 * 1000) {
        log.info(`Session ${sessionId} idle timeout (10min)`)
        this.endSession()
        this.onSessionTimeout?.(sessionId)
      }
    }, 60_000)
    this.idleTimer.unref()

    log.info(`Session started: ${sessionId}`)
  }

  endSession(): void {
    if (!this.currentSession) return
    this.sessionEnding = true
    this.opChain = this.opChain.then(() => {}).catch(() => {})
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined }
    const id = this.currentSession.sessionId
    const wasHidden = this.currentSession.mainWindowHidden
    this.currentSession = null
    this.abortSignal = undefined
    this.boundWindowHwnd = null
    log.info(`Session ended: ${id}`)
    this.scheduleScreenshotCleanup()

    // Restore TabTin main window (hidden during session for clean screenshots).
    // Use timeout fallback: if restore fails or hangs, retry after 5s.
    if (wasHidden) {
      this.restoreMainWindow()
      setTimeout(() => this.restoreMainWindow(), 5000)
    }
  }

  private restoreMainWindow(): void {
    try {
      const mainWindow = this.mainWindowGetter()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
        mainWindow.restore()
      }
    } catch {
      // best-effort
    }
  }

  getSession(): DesktopSession | null {
    return this.currentSession
  }

  private requireSession(): DesktopSession {
    if (!this.currentSession) {
      throw new DesktopError(
        DesktopErrorCode.PERMISSION_DENIED,
        `桌面操控 session 未启动：当前没有活跃会话。` +
        `本次请求未执行，其他桌面应用不受影响。` +
        `请先调用 tabtin desktop screenshot（推荐，会触发审批并建立 session），或显式运行 tabtin desktop session start。`,
      )
    }
    return this.currentSession
  }

  // -- AbortSignal & Activity tracking -------------------------------------

  setAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal
  }

  private checkAborted(): void {
    if (this.sessionEnding) {
      throw new DesktopError(
        DesktopErrorCode.ABORTED,
        `桌面操控 session 已结束。` +
        `本次操作未执行。` +
        `请重新运行 tabtin desktop screenshot 启动新会话。`,
      )
    }
    if (this.abortSignal?.aborted) {
      throw new DesktopError(
        DesktopErrorCode.ABORTED,
        `桌面操控已被用户中止（通过快捷键或撤销授权）。` +
        `本次操作未执行，当前会话已结束。` +
        `若要继续，请重新运行 tabtin desktop screenshot 启动新会话。`,
      )
    }
  }

  private touchActivity(): void {
    if (this.currentSession) {
      this.currentSession.lastActivityAt = Date.now()
    }
  }

  getIdleMs(): number {
    if (!this.currentSession) return 0
    const lastActive = this.currentSession.lastActivityAt ?? this.currentSession.startedAt
    return Date.now() - lastActive
  }

  // -- Audit logging --------------------------------------------------------
  //
  // Wave 2 · v1.4（规范 § 6.11.3）：Executor 审计统一走 writeAuditLog 而非
  // auditLogger.info(JSON.stringify(...))；jsonl 是唯一事实源，不再经 electron-log
  // 文件 transport（已 disabled）。新 API 自带 sanitizeAuditParams + 脱敏 + errorCode
  // 字段（失败路径必填，供审计聚合）。

  private audit(
    action: string,
    params: Record<string, unknown>,
    result: 'ok' | 'error' = 'ok',
    errorCode?: DesktopErrorCode,
    errorMessage?: string,
  ): void {
    writeAuditLog({
      action,
      sessionId: this.currentSession?.sessionId ?? null,
      params: this.sanitizeSensitiveParams(action, params),
      result,
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    })
  }

  /**
   * 针对 Executor 层语义做的二次脱敏（在 writeAuditLog 通用脱敏之上）：
   * - `type` 的 `text` 字段在 `useClipboard=true` 时替换为
   *   `[clipboard_paste, len=N]`；`useClipboard=false` 时替换为
   *   `[typed_text, len=N]`。**两条路径都完全脱敏原文**（规范 § 6.11.2 · Wave 2.2 加固）。
   *
   * **Wave 2.2 修正的根因**：Wave 2 将非 clipboard 路径仅截前 10 字符 + 长度尾标，
   * 实际等于把 `MyPassw0rd!123` → `MyPassw0rd…[14]`，密码 / token / apiKey
   * 场景下前缀直接明文入审计日志（`~/.tabtin/desktop-audit.jsonl` mode 0o600
   * 只挡非 owner，管理员 / 备份 / 日志聚合 agent 仍能读）——企业合规审计一次
   * 就会把它抓出来作为阻断项。新默认行为对齐 clipboard 路径：**只记长度**，
   * 让审计聚合仍能做"敲了多少字"的量级分析，但消除"明文 / 前缀"泄露面。
   *
   * 通用字段（_authPreset / savePath basename 化）由 writeAuditLog 内的
   * sanitizeAuditParams 继续处理。
   */
  private sanitizeSensitiveParams(
    action: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const s = { ...params }
    // Wave 3 · 规范 § 4.5.2：batch 子步审计 action 会变成 `batch_step.<N>.type`，
    // 脱敏判定必须 tolerant 这两种形式，否则 batch 内的 type 子动作会把密码
    // / token 明文落盘（与 P0-1 漏洞同类，但 batch 路径未覆盖就是新泄露面）。
    const isType = action === 'type' || action.endsWith('.type')
    if (isType && typeof s.text === 'string') {
      const len = (s.text as string).length
      s.text = s.useClipboard
        ? `[clipboard_paste, len=${len}]`
        : `[typed_text, len=${len}]`
    }
    return s
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.opChain = this.opChain.then(async () => {
        try {
          resolve(await fn())
        } catch (e) {
          reject(e)
        }
      }).catch(() => {})
    })
  }

  // -- Timeout protection ---------------------------------------------------

  private async withTimeout<T>(op: Promise<T>, label: string, ms = 15000): Promise<T> {
    let timer: NodeJS.Timeout
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DesktopError(
          DesktopErrorCode.INTERNAL_ERROR,
          `桌面操作超时 (${label}, ${ms}ms)。` +
          `本次操作未完成，当前 session 可能处于不确定状态。` +
          `请稍后重试；若持续超时，请检查系统负载或按中止快捷键释放锁后重新开始。`,
        )),
        ms,
      )
      timer.unref()
    })
    try {
      return await Promise.race([op, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  // -- Coordinate conversion -----------------------------------------------
  // 铁律：将截图坐标 → 逻辑屏幕坐标（nut-js 接受逻辑坐标）
  // scaleFactor = screenshot_width / display_logical_width
  // screen_coord = screenshot_coord / scaleFactor

  private toScreenCoords(x: number, y: number): { x: number; y: number } {
    const dims = this.currentSession?.lastScreenshotDims
    if (!dims) {
      throw new DesktopError(
        DesktopErrorCode.PERMISSION_DENIED,
        `坐标换算失败：尚未截屏，无法将截图坐标映射到屏幕坐标。` +
        `本次操作未执行。` +
        `请先调用 tabtin desktop screenshot 建立 session 与坐标系，再发起点击 / 拖拽 / 移动等基于坐标的操作。`,
      )
    }
    const offset = dims.regionOffset ?? { x: 0, y: 0 }
    const config = this.currentSession?.frozenDisplayConfig
    const boundsX = config?.boundsX ?? 0
    const boundsY = config?.boundsY ?? 0
    return {
      x: Math.round(x / dims.scaleFactor + offset.x + boundsX),
      y: Math.round(y / dims.scaleFactor + offset.y + boundsY),
    }
  }

  // -- Display config freeze -----------------------------------------------
  // 首次截屏时冻结，session 结束解冻

  private freezeDisplayConfig(display: Electron.Display): {
    width: number; height: number; scaleFactor: number; boundsX: number; boundsY: number
  } {
    const session = this.requireSession()
    if (session.frozenDisplayConfig) return session.frozenDisplayConfig

    session.frozenDisplayConfig = {
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor,
      boundsX: display.bounds.x,
      boundsY: display.bounds.y,
    }
    return session.frozenDisplayConfig
  }

  // -- Accessibility check -------------------------------------------------

  checkAccessibility(prompt = false): boolean {
    if (process.platform === 'darwin') {
      return systemPreferences.isTrustedAccessibilityClient(prompt)
    }
    // Windows 无 TCC 概念，视为 trusted=true（规范 § 4.4.3.1）
    if (process.platform === 'win32') return true
    // Linux 诊断语义：不支持（/accessibility 是诊断工具，规范 § 4.4.3.1 期望返回 trusted=false）
    return false
  }

  checkScreenRecording(): { granted: boolean; status: string } {
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen')
      return { granted: status === 'granted', status }
    }
    // Windows 无屏幕录制权限概念，视为 granted（规范 § 4.4.3.1）
    if (process.platform === 'win32') return { granted: true, status: 'granted' }
    // Linux 诊断语义：不支持（规范 § 4.4.3.1）
    return { granted: false, status: 'unavailable' }
  }

  // 把 Electron getMediaAccessStatus 的英文枚举映射为中文，避免直出英文给用户
  private screenRecordingStatusLabel(status: string): string {
    const map: Record<string, string> = {
      'not-determined': '未询问',
      'denied': '已拒绝',
      'granted': '已授予',
      'restricted': '系统限制',
      'unknown': '未知',
    }
    return map[status] ?? status
  }

  // -- Screenshot ----------------------------------------------------------

  async screenshot(opts: {
    displayId?: number
    maxDimension?: number
    savePath?: string
    region?: { x: number; y: number; width: number; height: number }
    /**
     * Wave 3 · D2 规范 § 4.5.1 开关——由路由层 / 调用方传入 app.json 配置。
     * - `enabled=true`（默认）：采用 `targetImageSize` 双约束二分搜索
     *   对齐云端 vision tokenizer 网格。
     * - `enabled=false`：回退 Wave 2 的 `maxDim` 单参数路径。
     * 若用户显式传 `maxDimension` 且 `imageResize.enabled=true`，两者都会
     * 参与最终尺寸计算（先由 tokenizer 双约束算候选，再用 maxDimension
     * 收紧长边）——保留"客户端只能收紧、不能放宽"的一致语义。
     */
    imageResize?: {
      enabled: boolean
      params?: Partial<ImageResizeParams>
    }
  } = {}): Promise<DesktopScreenshotResult> {
    this.checkAborted()
    this.touchActivity()

    // Linux 顶层拦截（仅在 macOS 和 Windows 可用，与 § 7.2 一致；CLI 路由层未必有 platform guard，这里 fail-closed）
    // 必须在 audit 之前：Linux 直接抛错，不应留下"尝试记录 + 错误"误导性审计（Wave 2 jsonl 唯一事实源的基线要求）
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw linuxNotSupported('截屏')
    }

    this.audit('screenshot', {
      displayId: opts.displayId,
      maxDimension: opts.maxDimension,
      region: opts.region,
      imageResizeEnabled: opts.imageResize?.enabled !== false,
    })

    const maxDim = opts.maxDimension ?? 1280
    // v2.1 模块零 · 规范 § 4.5.1 + § 3.5.5（app.json plumbing）：
    //   - 调用方显式传 false → 关闭（与 Wave 3 行为一致）
    //   - 调用方未传或传 true → 以实例级 default 为准（实例级由 app.json
    //     plumbing 在 deferred-init-action-bridge 构造时注入）
    //   语义：客户端"不能放宽"——若 admin 在 app.json 里关了，调用方传
    //   true 也无法绕过；与 § 6.4 "client 只能 stricter，不能 looser"同源。
    const callerEnabled = opts.imageResize?.enabled
    const imageResizeEnabled =
      callerEnabled === false ? false : this.imageResizeEnabledDefault
    const imageResizeParams: ImageResizeParams = {
      ...this.imageResizeParamsDefault,
      ...(opts.imageResize?.params ?? {}),
    }

    const display = opts.displayId
      ? electronScreen.getAllDisplays().find(d => d.id === opts.displayId)
      : electronScreen.getPrimaryDisplay()
    if (!display) {
      const available = electronScreen.getAllDisplays().map(d => d.id).join(', ') || '无'
      throw new DesktopError(
        DesktopErrorCode.VALIDATION_ERROR,
        `找不到指定的显示器 ${opts.displayId}（当前系统识别到的可用 ID：[${available}]）。` +
        `本次截屏未执行。` +
        `请先运行 tabtin desktop screenshot 不带 --display 查看主屏，或从可用 ID 列表中选择再指定。`,
      )
    }

    if (!this.currentSession) {
      this.startSession(`auto-${Date.now()}`)
    }
    const session = this.currentSession!
    // 只在已有 frozenDisplayConfig 时做 fail-fast 检查（首次截屏时 freeze 之前跳过）。
    // 对齐 § 5.3 规则 8（Q2）：检测 bounds / scaleFactor 变化即 endSession + 抛
    // DISPLAY_CONFIG_CHANGED，而不是 log.warn 静默继续。
    const existingFrozen = session.frozenDisplayConfig
    if (existingFrozen) {
      const boundsChanged =
        existingFrozen.boundsX !== display.bounds.x ||
        existingFrozen.boundsY !== display.bounds.y ||
        existingFrozen.width !== display.size.width ||
        existingFrozen.height !== display.size.height ||
        existingFrozen.scaleFactor !== display.scaleFactor
      if (boundsChanged) {
        const sessionIdSnapshot = session.sessionId
        // 先释放锁、再抛错：确保 DISPLAY_CONFIG_CHANGED 响应回到 Agent 时，
        // 本 session 已经彻底清理，Agent 下一次 screenshot 能干净建立新 session。
        this.endSession()
        this.onSessionTimeout?.(sessionIdSnapshot)
        throw new DesktopError(
          DesktopErrorCode.DISPLAY_CONFIG_CHANGED,
          // Wave 2.2 · 与 SESSION_EXPIRED 刻意用独立特征词（"显示器配置已变化
          // / 新插拔 / 改分辨率 / 改缩放"）区分——Agent 读文案就能分辨根因：
          // SESSION_EXPIRED = 停太久；DISPLAY_CONFIG_CHANGED = 硬件 / 显示设置变了。
          `显示器配置已变化（新插拔显示器 / 改变分辨率 / 改变缩放；首次截屏 bounds: ${existingFrozen.boundsX},${existingFrozen.boundsY}，当前 bounds: ${display.bounds.x},${display.bounds.y}），原坐标系失效。` +
          `本次截屏未执行，当前 session 已结束。` +
          `请重新运行 tabtin desktop screenshot 建立新 session 与新坐标系后再继续。`,
          {
            frozen: {
              x: existingFrozen.boundsX,
              y: existingFrozen.boundsY,
              width: existingFrozen.width,
              height: existingFrozen.height,
              scaleFactor: existingFrozen.scaleFactor,
            },
            current: {
              x: display.bounds.x,
              y: display.bounds.y,
              width: display.size.width,
              height: display.size.height,
              scaleFactor: display.scaleFactor,
            },
          },
        )
      }
    }
    const frozenConfig = this.freezeDisplayConfig(display)

    // Hide TabTin during the entire session to avoid capturing our own UI.
    // Only minimize once per session; stays hidden until endSession() restores.
    if (!session.mainWindowHidden) {
      const mainWindow = this.mainWindowGetter()
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
        mainWindow.minimize()
        session.mainWindowHidden = true
        await sleep(300)
      }
    }

    // Capture at full physical resolution for max quality
    const physicalSize = {
      width: Math.round(frozenConfig.width * frozenConfig.scaleFactor),
      height: Math.round(frozenConfig.height * frozenConfig.scaleFactor),
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: physicalSize,
    })
    const source = sources.find(s => s.display_id === String(display.id))
    if (!source) {
      const available = sources.map(s => s.display_id).join(', ') || '无'
      throw new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        `截屏源未找到：找不到 display ${display.id} 对应的截屏来源（系统返回可用 display_id：[${available}]）。` +
        `本次截屏未执行。` +
        `请检查显示器连接是否稳定；如果需要截取默认显示器，请不要指定 --display。`,
      )
    }

    const image = source.thumbnail
    if (image.isEmpty()) {
      if (process.platform === 'darwin' && !session.screenRecordingChecked) {
        const { granted, status } = this.checkScreenRecording()
        session.screenRecordingChecked = true
        if (!granted) {
          throw new DesktopError(
            DesktopErrorCode.TCC_DENIED,
            `桌面操控无法继续：macOS 屏幕录制权限未授予（当前状态：${this.screenRecordingStatusLabel(status)}）。` +
            `本次截屏未执行，当前会话也未建立；后续桌面操控在未授权前都将失败。` +
            `请前往「系统设置 → 隐私与安全性 → 屏幕录制」允许 TabTin，` +
            `或运行 tabtin desktop accessibility --prompt 打开系统引导对话框，` +
            `授权后重启 TabTin 或重新运行 tabtin desktop screenshot。`,
          )
        }
      }
      throw new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        `截屏结果为空：` +
        (process.platform === 'darwin'
          ? `显示器可能不可用，或 macOS 屏幕录制权限尚未授予。`
          : `目标显示器可能不可用或已断开。`) +
        `本次截屏未执行。` +
        `请确认显示器在线；macOS 上还需在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 TabTin。`,
      )
    }

    const pngBuffer = image.toPNG()

    // macOS 屏幕录制权限未授予时可能返回非空但全黑图像
    if (process.platform === 'darwin' && pngBuffer.length > 0 && !session.screenRecordingChecked) {
      const { granted, status } = this.checkScreenRecording()
      session.screenRecordingChecked = true
      if (!granted) {
        throw new DesktopError(
          DesktopErrorCode.TCC_DENIED,
          `桌面操控无法继续：macOS 屏幕录制权限未授予（当前状态：${this.screenRecordingStatusLabel(status)}），截屏图像可能为全黑。` +
          `本次截屏未执行，当前会话也未建立；后续桌面操控在未授权前都将失败。` +
          `请前往「系统设置 → 隐私与安全性 → 屏幕录制」允许 TabTin，` +
          `或运行 tabtin desktop accessibility --prompt 打开系统引导对话框，` +
          `授权后重启 TabTin 或重新运行 tabtin desktop screenshot。`,
        )
      }
    }

    // Use sharp to resize: physical → output based on logical dims + resize strategy。
    //
    // Wave 3 · 规范 § 4.5.1：`imageResize.enabled=true`（默认）时走 targetImageSize
    // 双约束二分搜索对齐云端 vision tokenizer 网格；`enabled=false` 回退 Wave 2
    // 的单参数 maxDim 路径（保底）。用户显式传的 `maxDimension` 在两条路径下都
    // 生效——tokenizer 路径里作为长边"再收紧一档"的上界。
    const sharp = (await import('sharp')).default
    const logicalW = frozenConfig.width
    const logicalH = frozenConfig.height

    let outputW: number
    let outputH: number
    // 规范 § 4.5.1 第 5 点：算法异常时回退 maxDim 路径 + log.warn，绝不让
    // imageResize 本身成为 screenshot 失败的新原因（这是 Wave 3 Review 1 #4
    // 找出的规范与代码不一致点 —— 原实现未加 try/catch，非法参数会直接冒泡
    // 到路由层变成 INTERNAL_ERROR，把"更准"降级成"更易挂"）。
    const computeFallbackSize = () => {
      const logicalMax = Math.max(logicalW, logicalH)
      const resizeRatio = logicalMax > maxDim ? maxDim / logicalMax : 1.0
      return {
        w: Math.round(logicalW * resizeRatio),
        h: Math.round(logicalH * resizeRatio),
      }
    }
    if (imageResizeEnabled) {
      try {
        const [tokenW, tokenH] = targetImageSize(logicalW, logicalH, imageResizeParams)
        // 若用户显式传 maxDimension 比 tokenizer 的结果更严，再按比例收紧长边；
        // tokenizer 给的 [tokenW, tokenH] 已满足长边 ≤ maxTargetPx，这里二次收紧
        // 不会违反 tokenizer 约束（长边变小 → token 只会更少）。
        const tokenMax = Math.max(tokenW, tokenH)
        if (opts.maxDimension != null && opts.maxDimension < tokenMax) {
          const ratio = opts.maxDimension / tokenMax
          outputW = Math.max(Math.round(tokenW * ratio), 1)
          outputH = Math.max(Math.round(tokenH * ratio), 1)
        } else {
          outputW = tokenW
          outputH = tokenH
        }
      } catch (err) {
        log.warn(
          `[imageResize] 算法异常，回退 maxDim=${maxDim} 路径: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        const fb = computeFallbackSize()
        outputW = fb.w
        outputH = fb.h
      }
    } else {
      const fb = computeFallbackSize()
      outputW = fb.w
      outputH = fb.h
    }
    const resizeRatio = outputW / logicalW

    let sharpPipeline = sharp(pngBuffer).resize(outputW, outputH, { fit: 'fill' })

    if (opts.region) {
      const r = opts.region
      const rx = Math.round(r.x * resizeRatio)
      const ry = Math.round(r.y * resizeRatio)
      const rw = Math.min(Math.round(r.width * resizeRatio), outputW - rx)
      const rh = Math.min(Math.round(r.height * resizeRatio), outputH - ry)
      if (rw > 0 && rh > 0) {
        sharpPipeline = sharpPipeline.extract({ left: rx, top: ry, width: rw, height: rh })
      }
    }

    const outputBuffer = await sharpPipeline.jpeg({ quality: 80 }).toBuffer()

    // Save file
    const isFilePath = opts.savePath != null && /\.(png|jpe?g)$/i.test(opts.savePath)
    let fullPath: string
    if (isFilePath) {
      mkdirSync(dirname(opts.savePath!), { recursive: true })
      fullPath = opts.savePath!
    } else {
      const dir = opts.savePath || DESKTOP_SCREENSHOT_DIR
      mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
      fullPath = join(dir, `desktop-${ts}.jpg`)
    }
    await writeFile(fullPath, outputBuffer)

    // scaleFactor = screenshot_width / logical_display_width
    const screenshotScaleFactor = outputW / logicalW
    const dims: DesktopScreenshotDims = {
      width: outputW,
      height: outputH,
      displayWidth: logicalW,
      displayHeight: logicalH,
      scaleFactor: screenshotScaleFactor,
    }

    // When region is used, record the actual cropped image dimensions and
    // the logical-coordinate offset so toScreenCoords can map back correctly.
    if (opts.region) {
      const r = opts.region
      const rw = Math.min(Math.round(r.width * resizeRatio), outputW - Math.round(r.x * resizeRatio))
      const rh = Math.min(Math.round(r.height * resizeRatio), outputH - Math.round(r.y * resizeRatio))
      if (rw > 0 && rh > 0) {
        dims.width = rw
        dims.height = rh
        dims.scaleFactor = rw / r.width
        dims.regionOffset = { x: r.x, y: r.y }
      }
    }

    session.lastScreenshotDims = dims
    // Wave 3 · 规范 § 4.5.3：保存最近一次截图路径，点击 / 拖拽前的 pixelCompare
    // 会 按需读取该文件并 decode 对应 9×9 区域（v1 选"路径 + 按需读"而非
    // "常驻内存 buffer"，内存友好；实测 IO > 50ms 再考虑改常驻）。
    session.lastScreenshotPath = fullPath
    if (!session.selectedDisplayId) {
      session.selectedDisplayId = display.id
    }

    const screenshotResult: DesktopScreenshotResult & { accessibilityText?: string } = {
      path: fullPath, sessionId: session.sessionId, ...dims,
    }

    // 模块三-3a：Windows 截图附 accessibilityText（异步、不阻塞截图返回路径的 fallback）
    if (process.platform === 'win32') {
      try {
        const { captureAccessibilityTreeWin, serializeAccessibilityText } =
          await import('./win32-bridge/desktop-accessibility-win')
        const snapshot = await captureAccessibilityTreeWin({ maxDepth: 3, interactiveOnly: true })
        if (snapshot.rootNodes.length > 0) {
          screenshotResult.accessibilityText = serializeAccessibilityText(snapshot.rootNodes)
        }
      } catch (err) {
        // FIXME(Win真机验): accessibilityText 采集失败时的降级日志级别需要在真机上调整，
        // 避免高频截图场景下的日志洪泛
        log.warn('Windows accessibilityText 采集失败（降级到无 AX 文本）:', err)
      }
    }

    return screenshotResult
  }

  // -- pixelCompare 点击前校验（Wave 3 · 规范 § 4.5.3）--------------------

  /**
   * 在点击 / 拖拽目标坐标前做 9×9 像素陈旧度校验。
   *
   * 规范 § 4.5.3 决策表：
   *   - 开关关闭 → 直接放行
   *   - 冷启动（无 lastScreenshotPath / lastScreenshotDims）→ 放行
   *   - 9×9 相等 → 放行
   *   - 9×9 不等 → 抛 POLICY_BLOCKED（中文三段式，引导 Agent 重新 screenshot）
   *   - **任何异常**（fresh 截屏失败 / decode 失败 / cropFn throw 等）→
   *     **跳过校验 + 放行**（规范 § 4.5.3 第 2 点红线，单测必须覆盖）
   *
   * 百分比坐标换算（§ 10 Q6 耦合约束）：
   *   (x, y) 是以 `lastScreenshotDims.width / height` 为基准的像素坐标。
   *   换成百分比再让 pixelCompare 裁 9×9——与 imageResize 改变 last / fresh
   *   像素尺寸时"同一相对位置"仍可比较。session 内 imageResize 参数冻结
   *   保证 last 与 fresh 像素尺寸一致（v1 路径下总是满足，百分比是 defense
   *   in depth）。
   */
  private async verifyClickTarget(x: number, y: number): Promise<void> {
    if (!this.pixelCompareEnabled) return
    const session = this.currentSession
    if (!session) return
    const dims = session.lastScreenshotDims
    const lastPath = session.lastScreenshotPath
    // 冷启动 / session 外部直接触发 click 等异常路径：无 lastScreenshot →
    // 规范红线"skip 校验 + 放行"。
    if (!dims || !lastPath) return

    // Wave 3.1 · 规范 § 4.5.3 "区域截图模式下的行为契约"（regionOffset 旁路 pixelCompare）：
    //   last 截图是 region 裁出的子图（dims.width/height 是 region 物理尺寸，
    //   regionOffset 记录 region 在逻辑坐标系里的左上角偏移）；但
    //   captureFreshForPixelCompare 始终按 frozenDisplayConfig 抓**整屏**
    //   PNG。两者像素尺寸/覆盖范围完全不同，sharp().resize(dims.width, dims.height)
    //   会把整屏压缩到 region 尺寸再 extract 同一 rect——对应的是**两块毫无
    //   关系的屏幕区域**，9×9 对比必然不等，全部 click 被误判为"屏幕变化"
    //   拒绝（Wave 3 独立验证 F1 真 bug）。
    //
    //   选择：按 pixelCompare 红线"异常不阻塞点击"的同一精神 skip 校验。
    //   这是 v1 下最安全的策略——损失了 region 截图场景的 pixelCompare
    //   保护（占比极低），换来的是"区域截图后点击不被误杀"这个正确性底线。
    //   未来若要在 region 场景恢复保护，需让 captureFreshForPixelCompare
    //   按 regionOffset 从整屏里 extract 出同一区域再进 pipeline（规范 § 10 Q6 v1.8 注记）。
    if (dims.regionOffset) {
      log.debug(
        `[pixelCompare] region 截图模式下跳过校验（regionOffset=${JSON.stringify(dims.regionOffset)}，` +
        `fresh 为整屏 vs last 为区域，维度不对齐——按红线放行）`,
      )
      return
    }

    try {
      // 1. 拿 fresh 截图 buffer（内存中，不写文件）。失败 → 红线跳过。
      const fresh = await this.captureFreshForPixelCompare(dims)
      if (!fresh) return

      // 2. 读 last 截图 buffer
      const { readFile } = await import('node:fs/promises')
      let lastBuffer: Buffer
      try {
        lastBuffer = await readFile(lastPath)
      } catch {
        return // last 文件已被清理 / 读不出 → 红线跳过
      }

      // 3. 坐标像素 → 百分比
      const xPercent = (x / dims.width) * 100
      const yPercent = (y / dims.height) * 100

      // 4. 用 sharp 裁两张图同一"相对位置"的 raw bytes。
      //
      // **关键：two-step pipeline —— resize fresh 到 last 尺寸 + 统一 channels。**
      // 原因：last 是 output-sized JPEG（imageResize 后 e.g. 1456×819），
      // fresh 是 desktopCapturer 的 physical-sized PNG（e.g. 3840×2160）。
      // 如果直接按 last.dims 算的 rect 去 fresh 上 extract，落到的是 fresh
      // 左上角极小区域（物理尺寸下 rect.x=46, rect.y=46 对应肉眼 1.2% 位置），
      // 跟 last 上"同一相对位置"完全错位——9×9 对比出的都是两个毫不相干的区域，
      // pixelCompare 形同虚设（规范 § 10 Q6 耦合约束 + Wave 3 Review 1 #3 发现）。
      //
      // 修复：先把 fresh resize 到 last 的 output 尺寸（fit: 'fill' 保留 aspect），
      // 再用同一 rect 对两张图做 extract。`removeAlpha()` 消除 PNG / JPEG 通道
      // 数差异（last JPEG = RGB 3 通道，fresh PNG = RGBA 4 通道，raw bytes 长度
      // 不等会让 buffersEqual 恒 false，是红线放行的另一个隐形路径）。
      //
      // 性能：每次 click 前多一次全图 resize（9ms-20ms on modern hw），规范
      // § 4.5.3 第 5 点"~100ms + <1ms"已把这段算在内（截屏 desktopCapturer ~100ms
      // 是主项）。
      //
      // sharp 的 extract/raw/toBuffer 是异步 Promise，无法直接塞进
      // desktop-pixel-compare 里 `comparePixels(syncCropFn)` 的同步签名——
      // 这里手动跑两次 pipeline 再用模块内的 `buffersEqual` 比对，
      // 语义与 comparePixels 等价。
      const { computeCropRect, buffersEqual } = await import('./desktop-pixel-compare')
      const rect = computeCropRect(dims.width, dims.height, xPercent, yPercent)
      if (!rect) return // rect 算不出 → 红线跳过

      const sharp = (await import('sharp')).default
      const extractRaw = async (buf: Buffer): Promise<Buffer | null> => {
        try {
          return await sharp(buf)
            .resize(dims.width, dims.height, { fit: 'fill' })
            .removeAlpha()
            .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
            .raw()
            .toBuffer()
        } catch {
          return null
        }
      }

      const [lastPatch, freshPatch] = await Promise.all([
        extractRaw(lastBuffer),
        extractRaw(fresh),
      ])
      if (!lastPatch || !freshPatch) return // decode 失败 → 红线跳过

      if (buffersEqual(lastPatch, freshPatch)) return

      // 9×9 不等 → 屏幕已变化，中止点击
      throw new DesktopError(
        DesktopErrorCode.POLICY_BLOCKED,
        `点击位置的屏幕内容与上次截图不一致（9×9 像素块已变化）。` +
        `本次点击未执行，避免点在 Agent 未看到过的内容上。` +
        `请先运行 tabtin desktop screenshot 重新截图，再基于新坐标点击。`,
      )
    } catch (err) {
      if (err instanceof DesktopError && err.code === DesktopErrorCode.POLICY_BLOCKED) {
        // 屏幕变化是**业务决策**，必须上抛阻止点击——不是红线豁免的"异常"
        throw err
      }
      // 规范 § 4.5.3 红线：所有其他异常（网络 / 文件系统 / sharp 解码等）
      // → 跳过校验 + 继续点击。这是最关键的单测守约点。
      log.debug(`[pixelCompare] 校验异常，跳过（保持点击执行）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async captureFreshForPixelCompare(_dims: DesktopScreenshotDims): Promise<Buffer | null> {
    try {
      const session = this.currentSession
      if (!session?.frozenDisplayConfig) return null
      const physicalSize = {
        width: Math.round(session.frozenDisplayConfig.width * session.frozenDisplayConfig.scaleFactor),
        height: Math.round(session.frozenDisplayConfig.height * session.frozenDisplayConfig.scaleFactor),
      }
      const displayId = session.selectedDisplayId
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: physicalSize,
      })
      const source = displayId
        ? sources.find(s => s.display_id === String(displayId))
        : sources[0]
      if (!source) return null
      const image = source.thumbnail
      if (image.isEmpty()) return null
      return image.toPNG()
    } catch {
      // 规范红线：截屏失败 → 跳过（返回 null 让 verifyClickTarget 的外层放行）
      return null
    }
  }

  // -- Mouse: Click --------------------------------------------------------

  async click(
    x: number, y: number,
    opts: { button?: 'left' | 'right' | 'middle'; count?: number } = {},
  ): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('click', { x, y, ...opts })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()
      await this.verifyClickTarget(x, y)

      const screen = this.toScreenCoords(x, y)
      await this.requireAllowedApp(screen.x, screen.y)

      // 模块三-3a：Windows bound window 模式下走 bridge.py SendMessage，不动真实鼠标
      // FIXME(Win真机验): bound window 模式下的坐标需要从屏幕逻辑坐标转换为
      // 窗口客户区坐标（ScreenToClient），当前直接透传，真机验证时修正
      if (process.platform === 'win32' && this.boundWindowHwnd !== null) {
        const { getWin32BridgeManager } = await import('./win32-bridge/bridge-manager')
        const bridge = getWin32BridgeManager()
        await bridge.call('click', {
          x: screen.x, y: screen.y,
          button: opts.button ?? 'left',
          count: opts.count ?? 1,
        })
        return
      }

      const nut = await loadNutJs()
      const { Point, Button } = nut

      await this.withTimeout((async () => {
        await nut.mouse.setPosition(new Point(screen.x, screen.y))

        const button = opts.button === 'right' ? Button.RIGHT
          : opts.button === 'middle' ? Button.MIDDLE
          : Button.LEFT
        const count = opts.count ?? 1

        if (count === 2) {
          await nut.mouse.doubleClick(button)
        } else {
          for (let i = 0; i < count; i++) {
            await nut.mouse.click(button)
            if (i < count - 1) await sleep(50)
          }
        }
      })(), 'click')
    })
  }

  // -- Mouse: Scroll -------------------------------------------------------

  async scroll(
    x: number, y: number,
    dx: number, dy: number,
  ): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('scroll', { x, y, dx, dy })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()
      const nut = await loadNutJs()
      const { Point } = nut

      const screen = this.toScreenCoords(x, y)
      await this.requireAllowedApp(screen.x, screen.y)

      await this.withTimeout((async () => {
        await nut.mouse.setPosition(new Point(screen.x, screen.y))

        const PIXELS_PER_TICK = 120
        if (dy > 0) await nut.mouse.scrollDown(Math.abs(dy) * PIXELS_PER_TICK)
        if (dy < 0) await nut.mouse.scrollUp(Math.abs(dy) * PIXELS_PER_TICK)
        if (dx > 0) await nut.mouse.scrollRight(Math.abs(dx) * PIXELS_PER_TICK)
        if (dx < 0) await nut.mouse.scrollLeft(Math.abs(dx) * PIXELS_PER_TICK)
      })(), 'scroll')
    })
  }

  // -- Mouse: Drag (ease-out-cubic) ----------------------------------------

  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration = 500,
  ): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('drag', { from, to, duration })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()
      // Wave 3 · 规范 § 4.5.3：拖拽起点也做 9×9 陈旧度校验（起点决定从哪
      // 里拖；终点的 UI 真动态变化时用户本来就是想看"落到哪"，不做强校验
      // 以免限制拖拽的合法用法）。异常不阻塞（红线）。
      await this.verifyClickTarget(from.x, from.y)
      const nut = await loadNutJs()
      const { Point, Button } = nut

      const screenFrom = this.toScreenCoords(from.x, from.y)
      const screenTo = this.toScreenCoords(to.x, to.y)

      await this.requireAllowedApp(screenFrom.x, screenFrom.y)
      await this.requireAllowedApp(screenTo.x, screenTo.y)

      const dragOp = async () => {
        await nut.mouse.setPosition(new Point(screenFrom.x, screenFrom.y))
        await nut.mouse.pressButton(Button.LEFT)
        try {
          const FRAME_MS = 1000 / 60
          const steps = Math.max(Math.ceil(duration / FRAME_MS), 2)
          for (let i = 1; i <= steps; i++) {
            this.checkAborted()
            const t = i / steps
            const eased = 1 - Math.pow(1 - t, 3)
            const cx = Math.round(screenFrom.x + (screenTo.x - screenFrom.x) * eased)
            const cy = Math.round(screenFrom.y + (screenTo.y - screenFrom.y) * eased)
            await nut.mouse.setPosition(new Point(cx, cy))
            await sleep(FRAME_MS)
          }
          await sleep(50)
        } finally {
          await nut.mouse.releaseButton(Button.LEFT)
        }
      }

      try {
        await this.withTimeout(dragOp(), 'drag', duration + 5000)
      } catch (err) {
        try { await this.withTimeout(nut.mouse.releaseButton(Button.LEFT), 'drag-cleanup', 2000) } catch {}
        throw err
      }
    })
  }

  // -- Mouse: Move ---------------------------------------------------------

  async move(x: number, y: number): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('move', { x, y })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()
      const nut = await loadNutJs()
      const { Point } = nut

      const screen = this.toScreenCoords(x, y)
      await this.requireAllowedApp(screen.x, screen.y)
      await this.withTimeout(
        nut.mouse.setPosition(new Point(screen.x, screen.y)),
        'move',
      )
    })
  }

  // -- Keyboard: Type ------------------------------------------------------
  // useClipboard=true → 6-step safe clipboard paste flow

  async type(text: string, useClipboard = false): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('type', { text, useClipboard })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()

      // 模块三-3a：Windows bound window 模式下走 bridge.py WM_CHAR，不抢焦点
      if (process.platform === 'win32' && this.boundWindowHwnd !== null && !useClipboard) {
        const { getWin32BridgeManager } = await import('./win32-bridge/bridge-manager')
        const bridge = getWin32BridgeManager()
        await bridge.call('type_text', { text })
        return
      }

      const nut = await loadNutJs()

      await this.withTimeout((async () => {
        if (!useClipboard) {
          await nut.keyboard.type(text)
          return
        }

        if (!this.currentSession?.grantFlags.clipboardWrite) {
          throw new DesktopError(
            DesktopErrorCode.PERMISSION_DENIED,
            `剪贴板粘贴未授权：当前 session 未开启 clipboardWrite。` +
            `本次粘贴未执行，剪贴板与目标输入框保持原状。` +
            `请通过 tabtin desktop screenshot 触发的审批弹窗允许桌面操控（一次审批将覆盖整个 session 的剪贴板写入）。`,
          )
        }

        let originalClipboard: string | undefined
        try {
          originalClipboard = clipboard.readText()
          clipboard.writeText(text)

          const written = clipboard.readText()
          if (written !== text) {
            throw new DesktopError(
              DesktopErrorCode.INTERNAL_ERROR,
              `剪贴板写入校验失败：写入的内容与读回的不一致。` +
              `本次粘贴已中止，原剪贴板内容将被恢复，目标应用未粘贴任何内容。` +
              `请检查是否有其他程序正在抢占剪贴板（输入法、剪贴板管理器等），关闭后重新尝试。`,
            )
          }

          const pasteModifier = process.platform === 'darwin' ? nut.Key.LeftCmd : nut.Key.LeftControl
          await nut.keyboard.pressKey(pasteModifier, nut.Key.V)
          await nut.keyboard.releaseKey(pasteModifier, nut.Key.V)
          await sleep(100)
        } finally {
          if (originalClipboard !== undefined) {
            try {
              const current = clipboard.readText()
              if (current === text) {
                clipboard.writeText(originalClipboard)
              }
            } catch { /* swallow */ }
          }
        }
      })(), 'type')
    })
  }

  // -- Keyboard: Key press -------------------------------------------------

  async keyPress(
    key: string,
    modifiers: string[] = [],
    repeat = 1,
  ): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('keyPress', { key, modifiers, repeat })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()
      const nut = await loadNutJs()
      const KeyMap = nut.Key as unknown as Record<string, number>

      const keyCode = resolveKey(key, KeyMap)
      const modCodes = modifiers.map(m => resolveKey(m, KeyMap))
      this.checkKeyComboSafety([...modCodes, keyCode], KeyMap)

      await this.withTimeout((async () => {
        for (let i = 0; i < repeat; i++) {
          if (modCodes.length > 0) {
            await nut.keyboard.pressKey(...modCodes, keyCode)
            await nut.keyboard.releaseKey(...modCodes, keyCode)
          } else {
            await nut.keyboard.pressKey(keyCode)
            await nut.keyboard.releaseKey(keyCode)
          }
          if (i < repeat - 1) await sleep(30)
        }
      })(), 'keyPress')
    })
  }

  // -- Keyboard: Hotkey (combo) --------------------------------------------

  async hotkey(keys: string[]): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('hotkey', { keys })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()
      const nut = await loadNutJs()
      const KeyMap = nut.Key as unknown as Record<string, number>

      const keyCodes = keys.map(k => resolveKey(k, KeyMap))
      this.checkKeyComboSafety(keyCodes, KeyMap)
      await this.withTimeout((async () => {
        await nut.keyboard.pressKey(...keyCodes)
        await nut.keyboard.releaseKey(...keyCodes)
      })(), 'hotkey')
    })
  }

  // -- Window: List --------------------------------------------------------

  async listWindows(): Promise<WindowInfo[]> {
    this.checkAborted()
    this.touchActivity()
    // 列窗口仅在 macOS 和 Windows 可用，Linux 抛中文三段式。
    // guard 必须在 audit 之前：Linux 直接抛错，不应写入"尝试列窗口"审计行再紧跟"错误"。
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw linuxNotSupported('列出窗口')
    }
    this.audit('listWindows', {})
    if (process.platform === 'darwin') {
      return listWindowsMac()
    }
    return listWindowsWin()
  }

  // -- Window: Activate ----------------------------------------------------

  async activateWindow(target: string): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    // Linux 抛错必须在 audit 和 enqueue 之前：避免写入误导性审计行，并省掉无意义的入队。
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw linuxNotSupported('激活窗口')
    }
    this.audit('activateWindow', { target })
    return this.enqueue(async () => {
      this.checkAborted()
      await this.withTimeout((async () => {
        if (process.platform === 'darwin') {
          execFileSync('osascript', [
            '-e', `tell application "${escapeAppleScript(target)}" to activate`,
          ], { timeout: 5000 })
        } else {
          const ps = `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$env:TABTIN_TARGET*" } | Select-Object -First 1; if ($p) { Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; [Native.Win]::SetForegroundWindow($p.MainWindowHandle) }`
          // windowsHide: 避免弹出控制台窗口抢前台，干扰 SetForegroundWindow
          execFileSync('powershell', ['-NoProfile', '-Command', ps], {
            timeout: 5000,
            env: { ...process.env, TABTIN_TARGET: target },
            windowsHide: true,
          })
        }
      })(), 'activateWindow')
    })
  }

  // -- Window: Open app ----------------------------------------------------

  async openApp(name: string): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    // Linux 抛错必须在 audit 和 enqueue 之前：保持 jsonl 审计不记录未执行的 Linux 尝试。
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw linuxNotSupported('打开应用')
    }
    this.audit('openApp', { name })
    return this.enqueue(async () => {
      this.checkAborted()
      const trimmed = name.trim()
      if (!trimmed || trimmed.length > 200) {
        throw new DesktopError(
          DesktopErrorCode.VALIDATION_ERROR,
          `应用参数无效：内容为空或长度超过 200 字符。` +
          `本次「打开应用」未执行。` +
          `请提供有效的应用名（如 "Microsoft Excel"）或可执行 / .app 路径（如 "/Applications/Visual Studio Code.app"）。`,
        )
      }
      if (!DesktopExecutorService.APP_NAME_PATTERN.test(trimmed)) {
        throw new DesktopError(
          DesktopErrorCode.VALIDATION_ERROR,
          `应用参数包含不允许的字符：仅允许字母 / 数字 / 空格 / 常见标点 / 路径分隔符（/ \\ :）。` +
          `本次「打开应用」未执行。` +
          `请检查并去掉特殊符号（如 ; | & $ \` < > 等），改用规范的应用名或路径再试。`,
        )
      }
      // 拒绝 ".." 防止意图不清的相对路径越权（绝对路径与单层 . 仍允许）
      if (trimmed.includes('..')) {
        throw new DesktopError(
          DesktopErrorCode.VALIDATION_ERROR,
          `应用参数不允许包含 ".."：禁止使用相对路径上跳，避免误打开非预期程序。` +
          `本次「打开应用」未执行。` +
          `请使用绝对路径（如 "/Applications/X.app"）或纯应用名（如 "Slack"）。`,
        )
      }

      // 路径 A 方案（v1 Wave 1 规范 § 4.2.4 / § 9.1 第 7 条）：
      // - 含 "/" 或 "\\" 或以 ".app" 结尾 → 视为路径，走 open <path>（macOS）
      //   / Start-Process -FilePath <path>（Windows，本身两种都接受）
      // - 否则视为应用名，macOS 走 open -a <name>，Windows 走 Start-Process -FilePath <name>
      const looksLikePath = /[/\\]/.test(trimmed) || /\.app$/i.test(trimmed)

      await this.withTimeout((async () => {
        if (process.platform === 'darwin') {
          if (looksLikePath) {
            execFileSync('open', [trimmed], { timeout: 10000 })
          } else {
            execFileSync('open', ['-a', trimmed], { timeout: 10000 })
          }
        } else if (process.platform === 'win32') {
          // Windows 的 Start-Process -FilePath 同时接受可执行名（"notepad"）与完整路径
          // （"C:\\Program Files\\App\\app.exe"）；无需按 looksLikePath 区分。
          execFileSync('powershell', [
            '-NoProfile', '-Command',
            'Start-Process -FilePath $env:TABTIN_APP -WindowStyle Normal',
          ], { timeout: 10000, env: { ...process.env, TABTIN_APP: trimmed }, windowsHide: true })
        } else {
          // 打开应用仅在 macOS 和 Windows 可用，Linux 抛中文三段式
          throw linuxNotSupported('打开应用')
        }
      })(), 'openApp')
    })
  }

  // -- Screenshot cleanup --------------------------------------------------

  private scheduleScreenshotCleanup(): void {
    const screenshotDir = DESKTOP_SCREENSHOT_DIR
    const MAX_KEPT = 20

    setTimeout(async () => {
      try {
        const { readdir, stat, unlink } = await import('node:fs/promises')
        const files = await readdir(screenshotDir)
        const jpgFiles = files.filter(f => f.startsWith('desktop-') && f.endsWith('.jpg'))

        if (jpgFiles.length <= MAX_KEPT) return

        const withStats = await Promise.all(
          jpgFiles.map(async f => {
            const fullPath = join(screenshotDir, f)
            const s = await stat(fullPath)
            return { path: fullPath, mtime: s.mtimeMs }
          }),
        )
        withStats.sort((a, b) => b.mtime - a.mtime)

        const toDelete = withStats.slice(MAX_KEPT)
        for (const f of toDelete) {
          await unlink(f.path).catch(() => {})
        }
        if (toDelete.length > 0) {
          log.info(`Cleaned up ${toDelete.length} old screenshots`)
        }
      } catch {
        // best-effort, ignore errors
      }
    }, 0)
  }

  // -- Helpers -------------------------------------------------------------

  private checkKeyComboSafety(keyCodes: number[], Key: Record<string, number>): void {
    if (this.currentSession?.grantFlags.systemKeyCombos) return
    const normalized = keyCodes.map(k => normalizeModifierKey(k, Key))
    const combo = [...normalized].sort((a, b) => a - b).join(',')
    if (getDangerousKeyCombos(Key).has(combo)) {
      throw new DesktopError(
        DesktopErrorCode.POLICY_BLOCKED,
        `系统级快捷键被安全策略阻止：可能导致关闭应用或触发系统操作。` +
        `本次快捷键未执行，当前会话其他操作不受影响。` +
        `如需关闭窗口 / 标签页请通过点击关闭按钮完成；如确需该组合键，请联系管理员为本次会话开启「系统级组合键授权」（grantFlags.systemKeyCombos）。`,
      )
    }
  }

  /**
   * If allowedApps is configured, verify that the target screen coordinate
   * belongs to a permitted application. Throws if the app is not allowed.
   *
   * v1 Wave 1：Linux 从"静默跳过"改为抛中文三段式错误（与 § 7.2 / § 6.6 一致）。
   * Linux 桌面操控本身不支持，到这里已经是兜底防御。
   */
  private async requireAllowedApp(screenX: number, screenY: number): Promise<void> {
    const allowed = this.currentSession?.allowedApps
    if (!allowed || allowed.length === 0) return

    // 白名单坐标命中检测仅在 macOS 和 Windows 可用，Linux 抛中文三段式
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw linuxNotSupported('坐标白名单检查')
    }

    const app = getAppAtPoint(screenX, screenY)
    if (!app) {
      throw new DesktopError(
        DesktopErrorCode.PERMISSION_DENIED,
        `操作被阻止：无法检测坐标 (${screenX}, ${screenY}) 指向的应用窗口。` +
        `本次操作未执行，当前会话其他操作不受影响。` +
        (process.platform === 'darwin'
          ? `请在「系统设置 → 隐私与安全性 → 辅助功能」中允许 TabTin；如系统未安装 python3 也会触发此错误，可通过 brew install python 或系统包管理器补装；`
          : `请确认 Windows 辅助功能权限已授予；`) +
        `或在桌面操控设置中关闭应用范围限制。`,
      )
    }

    // 精确匹配（大小写不敏感 + trim），规范 § 6.6 · Wave 2.2 加固。
    //
    // Wave 2.2 修正根因（详细背景见规范 § 6.6 "匹配语义" / § 10 Q1 v1.6 加固注记）：
    //   Wave 2 版本用子串包含判定——管理员 / Agent 设 allowedApps=["Code"] 想
    //   只允许 VS Code，实际会误放行名字含 "code" 的任意进程（Xcode / iCode /
    //   Encoder）；设 ["Terminal"] 会放行 HyperTerminal / Photon Terminal。
    //   这让 allowedApps 从管理员直觉的"精细白名单"退化为"粗放包含"，审批
    //   弹窗展示给用户的字符串与实际授权范围不一致，企业合规审计必抓。
    //
    // 新语义：app.toLowerCase().trim() === allowed[i].toLowerCase().trim()。
    // SKILL / 规范 § 6.6 同步要求 Agent 必须给完整应用名（'Google Chrome'
    // 而不是 'Chrome'），否则白名单放行失败，错误文案引导扩权命令。
    const normalizedApp = app.toLowerCase().trim()
    const isAllowed = allowed.some(a => a.toLowerCase().trim() === normalizedApp)
    if (!isAllowed) {
      // 规范 § 6.12.5 / SKILL § 扩展操作范围：不在白名单时的正路是走扩权命令，
      // 不是结束会话重开。错误文案"行动"段明确指引到 session extend-allowlist。
      const sessionId = this.currentSession?.sessionId ?? '<当前 sessionId>'
      throw new DesktopError(
        DesktopErrorCode.POLICY_BLOCKED,
        `操作被阻止：坐标 (${screenX}, ${screenY}) 指向应用「${app}」，不在允许列表 [${allowed.join(', ')}] 中（精确匹配，大小写不敏感）。` +
        `本次操作未执行，当前会话其他操作不受影响。` +
        `如需在本会话中操控「${app}」，请调用 tabtin desktop session extend-allowlist "${app}" --session-id ${sessionId}，` +
        `等用户在审批弹窗中允许后再继续（不要直接结束会话重开，也不要反复重试原操作）。`,
      )
    }
  }

  private requireAccessibility(): void {
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      throw new DesktopError(
        DesktopErrorCode.TCC_DENIED,
        `桌面操控无法继续：macOS 辅助功能权限未授予。` +
        `本次操作未执行，当前会话保留；后续鼠标 / 键盘操作都将失败。` +
        `请前往「系统设置 → 隐私与安全性 → 辅助功能」允许 TabTin，` +
        `或运行 tabtin desktop accessibility --prompt 打开系统引导对话框，授权后重新尝试本次动作。`,
      )
    }
  }

  // -- Batch 单调用多步（Wave 3 · 规范 § 4.5.2） ---------------------------

  /**
   * 批量串行执行多个子动作——Agent 用 1 次 CLI 调用完成"点击 → 输入 → 回车"
   * 这种可预测序列，省掉每步 200-1500ms 的 LLM RTT。
   *
   * 规范 § 4.5.2 约束：
   * - **入口硬性校验（Q5）**：`actions[0].action` 不能是 `'screenshot'`——
   *   冷启动无 session 时先单独调 `tabtin desktop screenshot` 建立 session 再
   *   发 batch；违反 → `VALIDATION_ERROR + 中文三段式`（路由层与 Executor 层
   *   双重拦截，任意一条失效都能兜住）。
   * - **stop-on-first-error**：第 N 步失败 → 第 N+1 步不执行；不回滚（鼠标
   *   键盘本质不可逆，回滚决策归 Agent）。与桌面工具语义
   *   语义一致。
   * - **每步独立审计**（`action = batch_step.<N>.<sub_action>`，规范 § 6.11）
   *   + batch 入口审计一条汇总。
   * - **策略与锁**：batch 整体在路由层走一次 `desktop_input` 策略评估 + 锁
   *   检查；每步在 Executor 内部复用 `checkAborted` / `requireAccessibility`
   *   / `requireAllowedApp`（frontmost 可能被某步切换，每步都要查）。
   *
   * 返回：`{ stepsCompleted, stepFailed?, error?, lastScreenshot? }`。
   * stepFailed === null 表示全部成功。
   */
  async batch(actions: BatchAction[]): Promise<BatchResult> {
    this.checkAborted()
    this.touchActivity()

    // 规范 § 4.5.2 · Q5 硬性规则（Executor 入口）：actions[0] 不能是 screenshot。
    // 必须在 audit 之前——违法请求不该留"尝试记录 + 错误"的误导性 jsonl 行
    // （与 Linux guard 的入口语义一致）。
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new DesktopError(
        DesktopErrorCode.VALIDATION_ERROR,
        `batch 请求参数非法：actions 必须是非空数组。` +
        `本次 batch 未执行，其他桌面操控不受影响。` +
        `请提供至少一个子动作，例如 '[{"action":"click","x":640,"y":400}]'。`,
      )
    }
    if (actions[0].action === 'screenshot') {
      throw new DesktopError(
        DesktopErrorCode.VALIDATION_ERROR,
        `batch 首项不能是 screenshot，请先单独调 tabtin desktop screenshot 建立 session 后再发起 batch。` +
        `本次 batch 未执行，其他桌面操控不受影响。` +
        `原因：batch 入口走一次 desktop_input 策略评估，若首项又是 screenshot 会产生"入口已审批但子动作触发新审批"的复杂耦合（规范 § 4.5.2 Q5）。` +
        `非首项 screenshot 是正常子动作（用于中途刷新坐标系），不受此限制。`,
      )
    }

    this.audit('batch', { count: actions.length, firstAction: actions[0].action })

    let lastScreenshot: DesktopScreenshotResult | undefined
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i]
      try {
        this.checkAborted()
        const stepResult = await this.executeBatchStep(i, step)
        if (stepResult && 'path' in stepResult) {
          lastScreenshot = stepResult
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code =
          err instanceof DesktopError ? err.code : DesktopErrorCode.INTERNAL_ERROR
        // stop-on-first-error：记一条 error 审计行（规范 § 6.11.2：失败路径必带 errorCode）
        this.audit(
          `batch_step.${i}.${step.action}`,
          this.batchStepAuditParams(step),
          'error',
          code,
          message,
        )
        return {
          stepsCompleted: i,
          stepFailed: i,
          failedAction: step.action,
          error: { code, message },
          lastScreenshot,
        }
      }
    }

    return {
      stepsCompleted: actions.length,
      stepFailed: null,
      lastScreenshot,
    }
  }

  /**
   * 从 BatchAction 提取用于审计的参数视图，剥掉敏感字段（type.text 由
   * writeAuditLog + sanitizeSensitiveParams 进一步脱敏）。
   */
  private batchStepAuditParams(step: BatchAction): Record<string, unknown> {
    // 借用普通 audit 的脱敏路径——action 键（'type'）会被 sanitizeSensitiveParams
    // 识别并把 text 换成 [typed_text, len=N] / [clipboard_paste, len=N]。
    return { ...step } as Record<string, unknown>
  }

  /**
   * 执行 batch 内一个子动作。封装成独立方法便于将来扩展子动作类型、
   * 也方便单测只 mock 这一层。返回值仅当子动作是 screenshot 时有 payload。
   */
  private async executeBatchStep(
    index: number,
    step: BatchAction,
  ): Promise<DesktopScreenshotResult | void> {
    // 每步独立 audit——与规范 § 4.5.2 技术方案 6 / § 6.11 一致。
    // 用 writeAuditLog（通过 this.audit）统一脱敏路径，而不是自己拼 jsonl。
    this.audit(
      `batch_step.${index}.${step.action}`,
      this.batchStepAuditParams(step),
    )

    switch (step.action) {
      case 'click':
        await this.click(step.x, step.y, {
          button: step.button,
          count: step.count,
        })
        return
      case 'scroll':
        await this.scroll(step.x, step.y, step.dx ?? 0, step.dy ?? 0)
        return
      case 'drag':
        await this.drag(
          { x: step.fromX, y: step.fromY },
          { x: step.toX, y: step.toY },
          step.duration,
        )
        return
      case 'move':
        await this.move(step.x, step.y)
        return
      case 'type':
        await this.type(step.text, step.useClipboard)
        return
      case 'key':
        await this.keyPress(step.key, step.modifiers, step.repeat)
        return
      case 'hotkey':
        await this.hotkey(step.keys)
        return
      case 'screenshot':
        return await this.screenshot({
          displayId: step.displayId,
          maxDimension: step.maxDimension,
          region: step.region,
          // batch 内的 screenshot 沿用 session 冻结的 imageResize 开关——调用方
          // （路由层）不会在 batch 子步里传 imageResize 参数，Executor 保持默认
          // （enabled=true）。规范 § 10 Q6：同 session 同设置保证 pixelCompare
          // 的 last / fresh 两张截图像素尺寸一致。
        })
      case 'wait': {
        // Wave 3.1 · 规范 § 4.5.2 wait 子动作参数校验：
        //   - ms 必须是有限正整数（Agent 可能传 undefined / '500'(字符串) /
        //     null / -1 / NaN 等），不可静默降级为 0ms（会导致"本意等 500ms
        //     → 实际不等 → UI 未加载完就 click"的隐形 bug，Wave 3 独立验证 F4）
        //   - ms 上限 30000（30 秒）——batch 整体不应被单步 wait 卡死，超上限
        //     的等待应改为多步 screenshot 轮询；与现有 Math.min 上限保持一致
        if (
          typeof step.ms !== 'number' ||
          !Number.isFinite(step.ms) ||
          !Number.isInteger(step.ms) ||
          step.ms <= 0
        ) {
          throw new DesktopError(
            DesktopErrorCode.VALIDATION_ERROR,
            `batch wait 子动作参数非法：ms 必须是正整数（当前值 ${JSON.stringify(step.ms)}，类型 ${typeof step.ms}）。` +
            `本次 batch 在第 ${index} 步中止，其他桌面操控不受影响。` +
            `请传入 1-30000 之间的整数毫秒数，例如 {"action":"wait","ms":500}。`,
          )
        }
        if (step.ms > 30_000) {
          throw new DesktopError(
            DesktopErrorCode.VALIDATION_ERROR,
            `batch wait 子动作超上限：ms=${step.ms}，上限 30000（30 秒）。` +
            `本次 batch 在第 ${index} 步中止，其他桌面操控不受影响。` +
            `batch 不应被单步 wait 长时间卡住，超过 30 秒的等待请改为"screenshot + 条件分析"轮询。`,
          )
        }
        await sleep(step.ms)
        return
      }
      default: {
        // TS 会把 default 推成 never；运行时兜底保证 BatchAction 加新类型时
        // 至少能以 VALIDATION_ERROR 报出来，而不是 Boolean 陷入 undefined。
        const exhaustive: never = step
        throw new DesktopError(
          DesktopErrorCode.VALIDATION_ERROR,
          `batch 子动作 action 值非法：${JSON.stringify((exhaustive as { action?: unknown }).action)}。` +
          `本次 batch 在第 ${index} 步中止。` +
          `合法的 action 枚举：click / scroll / drag / move / type / key / hotkey / screenshot / wait。`,
        )
      }
    }
  }

  // -- Session extend allowed apps（Wave 2 · 规范 § 6.12） -----------------

  /**
   * 扩展当前 session 的 allowedApps 白名单，必须经过新审批。
   *
   * 规范 § 6.12.3 Executor 方法：
   * 1. sessionId 与当前 currentSession.sessionId 不匹配 → 抛 PERMISSION_DENIED；
   * 2. apps 为空数组或非字符串 → 抛 VALIDATION_ERROR；
   * 3. 调用 ApprovalManager.requestApproval（scene='desktop.extend_allowlist'）；
   *    拒绝 / 超时 → 抛 NEEDS_APPROVAL；
   * 4. 通过则 append 去重合并到 session.allowedApps，其他 session 字段不变；
   * 5. 独立审计 `session_extend_allowlist` action。
   *
   * 与 startSession 的边界（§ 6.12.3）：本方法**独立**存在、不复用
   * startSession 的幂等 return 分支——即使 Agent 滥用 /session/start 传新
   * allowedApps 也不生效，扩权只能走本方法。
   */
  async extendAllowedApps(
    sessionId: string,
    apps: string[],
    opts?: { reason?: string },
  ): Promise<string[]> {
    this.checkAborted()

    const session = this.currentSession
    if (!session || session.sessionId !== sessionId) {
      throw new DesktopError(
        DesktopErrorCode.PERMISSION_DENIED,
        `扩权失败：当前无活跃 session 或 sessionId 不匹配。` +
        `本次扩权未执行；其他已有授权不受影响。` +
        `请先运行 tabtin desktop screenshot 建立 session，再用同一 sessionId 发起扩权请求。`,
      )
    }

    const sanitized = Array.isArray(apps)
      ? apps
          .filter((a): a is string => typeof a === 'string')
          .map(a => a.trim())
          .filter(a => a.length > 0)
      : []
    if (sanitized.length === 0) {
      throw new DesktopError(
        DesktopErrorCode.VALIDATION_ERROR,
        `请求参数非法：扩权的 apps 列表为空。` +
        `本次扩权未执行；当前 session 白名单保持不变。` +
        `请改用 tabtin desktop session extend-allowlist <app_name> [<app_name>...] 重新调用。`,
      )
    }

    // 全局互斥锁应由 route 层确认；Executor 再兜底一次。
    // 若锁丢失，直接报 LOCK_CONFLICT 避免误扩。
    const DesktopUseLock = await import('./DesktopUseLock')
    if (!DesktopUseLock.isHeldLocally()) {
      throw new DesktopError(
        DesktopErrorCode.LOCK_CONFLICT,
        `扩权失败：当前未持有桌面操控锁，无法继续。` +
        `本次扩权未执行；其他桌面操控不受影响。` +
        `请先运行 tabtin desktop screenshot 触发审批 + 建立锁，再发起扩权请求。`,
      )
    }

    const currentList = Array.isArray(session.allowedApps) ? [...session.allowedApps] : []
    const reasonText = opts?.reason?.trim() ? opts.reason.trim() : ''
    const detailParts: string[] = [
      `Agent 想把桌面操控范围从 [${currentList.join(', ') || '（当前白名单为空）'}] 扩到 [${
        Array.from(new Set([...currentList, ...sanitized])).join(', ')
      }]。`,
    ]
    if (reasonText) {
      detailParts.push(`Agent 说明：${reasonText}`)
    }
    detailParts.push(
      '接受后 Agent 能在本 session 内操控新增的应用；' +
      '拒绝后仅能继续操控原列表，当前 session 不会终止。',
    )

    // 规范 § 6.12.4："扩权的用户价值就在'这一次审慎'，持久化会架空审批语义"。
    // 用 isStrict: true 绕过 approvalScopeCache，确保每次扩权都重新弹窗——
    // 即便用户之前对 desktop_control 选过"总是允许"也不能默认通过。
    const approval = await requestApproval({
      actionType: 'desktop_extend_allowlist',
      detail: detailParts.join('\n'),
      mode: 'computer_use',
      isStrict: true,
    })

    if (!approval.approved) {
      this.audit(
        'session_extend_allowlist',
        { added: sanitized, current: currentList, reason: reasonText || undefined },
        'error',
        DesktopErrorCode.NEEDS_APPROVAL,
        '用户拒绝扩权或审批超时',
      )
      throw new DesktopError(
        DesktopErrorCode.NEEDS_APPROVAL,
        `桌面操控扩权被拒绝：用户在审批弹窗中选择了拒绝或审批超时。` +
        `本次扩权未执行，当前 session 的允许应用仍为 [${currentList.join(', ') || '（空）'}]；原 session 可以继续使用。` +
        `如需扩权请重新运行 tabtin desktop session extend-allowlist 并在弹窗中选择「允许」。`,
      )
    }

    // 合并去重：严格按"原列表 + 新增"顺序，保留用户第一次授权的应用顺序
    const merged = Array.from(new Set([...currentList, ...sanitized]))
    session.allowedApps = merged
    this.touchActivity()

    this.audit(
      'session_extend_allowlist',
      { added: sanitized, merged, reason: reasonText || undefined },
      'ok',
    )
    log.info(
      `Session ${sessionId} allowedApps extended: ` +
      `${JSON.stringify(currentList)} → ${JSON.stringify(merged)}`,
    )
    return merged
  }

  // -- AX 内部：逻辑坐标直接点击（跳过 toScreenCoords） ------------------

  /**
   * 用屏幕逻辑坐标直接点击——AX 专用路径。
   *
   * 与 `click()` 的区别：**跳过 `toScreenCoords`**。AX 返回的 bounds 已经是
   * 屏幕逻辑坐标（points，与 display bounds 对齐），不需要从截图像素坐标反算。
   * `click()` 内部假设入参是截图像素坐标会做 `x / scaleFactor`，导致 AX 坐标
   * 在 imageResize 启用时偏移 10-18%（独立验收 P0-1）。
   *
   * 安全链路复用：enqueue 串行化 / checkAborted / requireAccessibility /
   * requireAllowedApp（逻辑坐标就是屏幕坐标，requireAllowedApp 接收屏幕坐标）。
   *
   * pixelCompare 跳过：AX 逻辑坐标无法与"上次截图像素"做 9×9 比对——
   * 按规范 § 4.5.3 红线"维度不对齐→跳过校验放行"的同一精神处理。
   */
  private async clickAtLogicalCoords(
    logicalX: number,
    logicalY: number,
    opts: { button?: 'left' | 'right' | 'middle'; count?: number } = {},
  ): Promise<void> {
    this.checkAborted()
    this.touchActivity()
    this.audit('click_at_logical', { x: logicalX, y: logicalY, ...opts })
    return this.enqueue(async () => {
      this.checkAborted()
      this.requireAccessibility()

      // requireAllowedApp 接收屏幕逻辑坐标——AX bounds 就是逻辑坐标，直接传
      await this.requireAllowedApp(logicalX, logicalY)

      const nut = await loadNutJs()
      const { Point, Button } = nut

      await this.withTimeout((async () => {
        await nut.mouse.setPosition(new Point(logicalX, logicalY))

        const button = opts.button === 'right' ? Button.RIGHT
          : opts.button === 'middle' ? Button.MIDDLE
          : Button.LEFT
        const count = opts.count ?? 1

        if (count === 2) {
          await nut.mouse.doubleClick(button)
        } else {
          for (let i = 0; i < count; i++) {
            await nut.mouse.click(button)
            if (i < count - 1) await sleep(50)
          }
        }
      })(), 'click_at_logical')
    })
  }

  // -- Accessibility Tree（模块四 · 规范 § 4.6） --------------------------

  /**
   * 获取当前前台窗口（或指定窗口）的 AX 快照。
   *
   * macOS 走 osascript + System Events（路径 a）。
   * AX 不可用时抛 `AX_UNAVAILABLE`；找不到窗口抛 `ELEMENT_NOT_FOUND`。
   * Linux 不支持桌面操控，直接抛 `UNSUPPORTED_PLATFORM`。
   */
  async captureAccessibilityTree(
    opts: import('@tabtin/desktop-contracts').AccessibilityTreeOpts = {},
  ): Promise<import('@tabtin/desktop-contracts').AccessibilitySnapshot> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      throw linuxNotSupported('AX 查询')
    }
    this.checkAborted()
    this.touchActivity()
    this.audit('accessibility_tree', opts as Record<string, unknown>)

    if (process.platform === 'darwin') {
      const { captureAccessibilityTreeMac } = await import('./desktop-accessibility')
      return captureAccessibilityTreeMac(opts)
    }

    // Windows · 模块三-3a：通过 bridge.py UIAutomation 采集
    // FIXME(Win真机验): Windows AX 采集的端到端延迟需要真机实测，
    // 复杂窗口（maxDepth=4+）可能 3-5 秒
    if (process.platform === 'win32') {
      const { captureAccessibilityTreeWin } = await import('./win32-bridge/desktop-accessibility-win')
      return captureAccessibilityTreeWin(opts)
    }

    throw new DesktopError(
      DesktopErrorCode.AX_UNAVAILABLE,
      `Accessibility Tree 暂不可用：当前平台不支持。` +
      `本次 AX 查询未执行。` +
      `请使用 tabtin desktop screenshot + 坐标点击作为替代。`,
    )
  }

  /**
   * 按名字 + 角色定位并点击元素。
   *
   * 内部流程：查 AX 拿 bounds → 取 bounds 中心坐标 → 走 clickAtLogicalCoords
   * （跳过 toScreenCoords，AX 返回的已经是屏幕逻辑坐标）。
   *
   * 安全链路：enqueue 串行化 / requireAllowedApp / 中止信号全复用。
   * pixelCompare 跳过（AX 逻辑坐标无法与截图像素做 9×9 比对）。
   */
  async clickElement(
    opts: import('@tabtin/desktop-contracts').ClickElementOpts,
  ): Promise<import('@tabtin/desktop-contracts').ClickElementResult> {
    this.checkAborted()
    this.touchActivity()
    this.audit('click_element', opts as unknown as Record<string, unknown>)

    const snapshot = await this.captureAccessibilityTree()
    const { findElementInSnapshot, collectCandidateNames } = await import('./desktop-accessibility')

    const node = findElementInSnapshot(snapshot, opts.name, opts.role, opts.nth ?? 0)
    if (!node) {
      const candidates = collectCandidateNames(snapshot, opts.role)
      throw new DesktopError(
        DesktopErrorCode.ELEMENT_NOT_FOUND,
        `未找到名为「${opts.name}」${opts.role ? `角色「${opts.role}」` : ''}的元素。` +
        `本次点击未执行。` +
        `当前 AX 快照里${candidates.length > 0 ? `候选元素有：${candidates.join(' / ')}` : '没有找到匹配的交互元素'}；` +
        `请检查元素名拼写或改用 tabtin desktop screenshot + 坐标点击。`,
        { candidates },
      )
    }

    if (!node.enabled) {
      throw new DesktopError(
        DesktopErrorCode.VALIDATION_ERROR,
        `元素处于禁用状态：「${node.name ?? opts.name}」(${node.role}) 的 enabled=false，无法点击。` +
        `本次点击未执行。` +
        `请等待元素变为可用状态后重试。`,
      )
    }

    if (!node.bounds) {
      throw new DesktopError(
        DesktopErrorCode.ELEMENT_NOT_FOUND,
        `元素缺少坐标信息：「${node.name ?? opts.name}」(${node.role}) 没有 bounds 属性。` +
        `本次点击未执行。` +
        `请改用 tabtin desktop screenshot + 坐标点击。`,
      )
    }

    const centerX = node.bounds.x + node.bounds.width / 2
    const centerY = node.bounds.y + node.bounds.height / 2

    // 走 clickAtLogicalCoords 而非 this.click()：AX bounds 已经是逻辑坐标，
    // 不需要 toScreenCoords 的截图像素→屏幕逻辑反算（独立验收 P0-1 修复）。
    await this.clickAtLogicalCoords(centerX, centerY, {
      button: opts.button ?? 'left',
      count: opts.count ?? 1,
    })

    return {
      done: true,
      matched: {
        id: node.id,
        role: node.role,
        name: node.name,
        bounds: node.bounds,
      },
    }
  }

  /**
   * 按名字 + 角色定位输入框并输入文本。
   *
   * 内部流程：查 AX 拿 bounds → click 中心激活 → type 输入文本。
   * macOS AX 的 AXValue 写入不如 click+type 可靠，所以走 click → type 路径。
   */
  async typeIntoElement(
    opts: import('@tabtin/desktop-contracts').TypeIntoElementOpts,
  ): Promise<import('@tabtin/desktop-contracts').TypeIntoElementResult> {
    this.checkAborted()
    this.touchActivity()
    this.audit('type_into_element', opts as unknown as Record<string, unknown>)

    const snapshot = await this.captureAccessibilityTree()
    const { findElementInSnapshot, collectCandidateNames } = await import('./desktop-accessibility')

    const node = findElementInSnapshot(snapshot, opts.name, opts.role)
    if (!node) {
      const candidates = collectCandidateNames(snapshot, opts.role)
      throw new DesktopError(
        DesktopErrorCode.ELEMENT_NOT_FOUND,
        `未找到名为「${opts.name}」${opts.role ? `角色「${opts.role}」` : ''}的元素。` +
        `本次输入未执行。` +
        `当前 AX 快照里${candidates.length > 0 ? `候选元素有：${candidates.join(' / ')}` : '没有找到匹配的交互元素'}；` +
        `请检查元素名拼写或改用 tabtin desktop screenshot + 坐标点击后 type。`,
        { candidates },
      )
    }

    if (!node.enabled) {
      throw new DesktopError(
        DesktopErrorCode.VALIDATION_ERROR,
        `元素处于禁用状态：「${node.name ?? opts.name}」(${node.role}) 的 enabled=false，无法输入。` +
        `本次输入未执行。` +
        `请等待元素变为可用状态后重试。`,
      )
    }

    if (!node.bounds) {
      throw new DesktopError(
        DesktopErrorCode.ELEMENT_NOT_FOUND,
        `元素缺少坐标信息：「${node.name ?? opts.name}」(${node.role}) 没有 bounds 属性。` +
        `本次输入未执行。` +
        `请改用 tabtin desktop screenshot + 坐标点击后 type。`,
      )
    }

    const centerX = node.bounds.x + node.bounds.width / 2
    const centerY = node.bounds.y + node.bounds.height / 2

    // 走 clickAtLogicalCoords 激活元素（AX bounds 是逻辑坐标，P0-1 修复）
    await this.clickAtLogicalCoords(centerX, centerY, { button: 'left', count: 1 })
    await this.type(opts.text, !!opts.clipboard)

    return {
      done: true,
      matched: {
        id: node.id,
        role: node.role,
        name: node.name,
        bounds: node.bounds,
      },
    }
  }

  // -- Bound window 模式（模块三-3a · Windows 核心） -----------------------

  /**
   * 绑定到指定窗口。Windows 上走 bridge.py 的 bind_window 方法。
   * macOS / Linux 抛 PERMISSION_DENIED（macOS 不需要 bound window）。
   */
  async bindWindow(
    target: { handle?: number | string; bundleId?: string },
  ): Promise<{ ok: true }> {
    if (process.platform !== 'win32') {
      throw new DesktopError(
        DesktopErrorCode.PERMISSION_DENIED,
        `bound window 模式仅在 Windows 平台可用（当前平台：${process.platform}）。` +
        `macOS 通过 CGEvent 直接操控，不需要窗口绑定。` +
        `请直接使用 tabtin desktop click / type 等命令。`,
      )
    }

    this.checkAborted()
    this.touchActivity()

    // FIXME(Win真机验): bridge.py bind_window 的 HWND 解析和窗口有效性检查
    const { getWin32BridgeManager } = await import('./win32-bridge/bridge-manager')
    const bridge = getWin32BridgeManager()

    const params: Record<string, unknown> = {}
    if (target.handle !== undefined) {
      params.hwnd = Number(target.handle)
    }
    if (target.bundleId) {
      params.title = target.bundleId
    }

    let result: Record<string, unknown>
    try {
      result = await bridge.call('bind_window', params)
    } catch (err) {
      if (err instanceof DesktopError) throw err
      throw new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        `窗口绑定失败：${err instanceof Error ? err.message : String(err)}。` +
        `本次绑定未执行。` +
        `请确认目标窗口存在且可见，然后重试。`,
      )
    }

    this.boundWindowHwnd = (result?.hwnd as number) ?? null
    this.audit('bind_window', { target, hwnd: this.boundWindowHwnd })
    return { ok: true }
  }

  /**
   * 解除窗口绑定。
   */
  async unbindWindow(): Promise<{ ok: true }> {
    if (process.platform !== 'win32') {
      throw new DesktopError(
        DesktopErrorCode.PERMISSION_DENIED,
        `bound window 模式仅在 Windows 平台可用（当前平台：${process.platform}）。` +
        `本次操作未执行。`,
      )
    }

    this.checkAborted()

    const { getWin32BridgeManager } = await import('./win32-bridge/bridge-manager')
    const bridge = getWin32BridgeManager()

    try {
      await bridge.call('unbind_window')
    } catch (err) {
      if (err instanceof DesktopError) throw err
      throw new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        `解除窗口绑定失败：${err instanceof Error ? err.message : String(err)}。`,
      )
    }

    this.boundWindowHwnd = null
    this.audit('unbind_window', {})
    return { ok: true }
  }
}

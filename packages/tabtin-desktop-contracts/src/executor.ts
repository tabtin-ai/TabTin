/**
 * `DesktopExecutor` —— 桌面执行器能力总集（规范 § 3.5.2 · 模块零定型）。
 *
 * 任何宿主（Electron 主进程、未来 Daemon、未来 MCP server）实现该接口即可
 * 对外提供 TabDesktop 能力。**字段集合与 `DesktopExecutorService` 现有 18 个
 * public 方法逐项对齐**——不重新设计，让现有实现"自然成为"接口的一种实现。
 *
 * 模块零的"地基"价值：未来模块在接口上**加方法**（不是改 / 删），所有
 * Executor 实现需要保持向后兼容。
 *
 * 注意：本接口刻意保持"轻类型"——返回值用结构化对象而非 typed enum，
 * `screenshot` / `batch` 等返回字段宽松（`Record<string, unknown>`），让
 * Electron 实现细节（sharp 元数据、nut-js 内部状态）不渗入跨包契约。
 */

/** 截屏返回值 —— 规范 § 4.1.4 / `DesktopScreenshotResult` 兼容形态。 */
export interface DesktopExecutorScreenshotResult {
  path: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  scaleFactor: number
  regionOffset?: { x: number; y: number }
  sessionId?: string
  /**
   * 可访问性文本（v2.2 模块零扫尾 · 独立验收 P0-2 占位 · 模块三-3a 实填）。
   *
   * 规范 § 9.4.1 第 4 项 / `B5_ComputerUse桌面栈.md:67`：截图响应同时返回类
   * DOM 文本（按 UIA 树展开），Agent 同时拿到画面 + 文本结构。
   *
   * **v1 / v2.1 阶段**：所有平台都为 undefined（无 UIA 实现）。
   *
   * **模块三-3a 落地后**：
   * - Windows · 走 `UIAutomation.TreeWalker` 把 boundWindow / 整屏的可见控件按
   *   `<role name="..." [bounds=...] [enabled=...]>...</role>` 风格序列化为字符串
   * - macOS · 暂不填（仍 undefined）；模块四 AX Tree 落地时再决定是否对齐
   * - Linux · 永远 undefined（v1 不支持桌面操控）
   */
  accessibilityText?: string
}

/** 截屏入参（与 `DesktopExecutorService.screenshot` opts 对齐）。 */
export interface DesktopExecutorScreenshotOpts {
  displayId?: number
  maxDimension?: number
  savePath?: string
  region?: { x: number; y: number; width: number; height: number }
  imageResize?: {
    enabled?: boolean
    params?: {
      pxPerToken?: number
      maxTargetPx?: number
      maxTargetTokens?: number
    }
  }
}

/** 单步动作 audit 友好的 batch 子动作枚举 —— 与现有 `BatchAction` 对齐。 */
export type DesktopExecutorBatchAction =
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

/** batch 返回值 —— 与 `BatchResult` 对齐。 */
export interface DesktopExecutorBatchResult {
  stepsCompleted: number
  stepFailed: number | null
  failedAction?: string
  error?: { code: string; message: string }
  lastScreenshot?: DesktopExecutorScreenshotResult
}

/** 窗口元数据 —— 与 `WindowInfo` 对齐。 */
export interface DesktopExecutorWindowInfo {
  id: string
  title: string
  appName: string
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * `DesktopExecutor` —— 桌面执行器能力契约。
 *
 * 模块零兑现：现有 `DesktopExecutorService` 类自然实现该接口（structural
 * typing 直接成立）。后续模块在该接口上**加方法**——例如：
 * - 模块二 · `prepareForAction(ctx)` / `cleanupAfterAction(ctx)` / `notifyExpectedEscape()`
 * - 模块三-3a · `bindWindow(target)` / `unbindWindow()` / `accessibilityText(opts)`
 * - 模块四 · `captureAccessibilityTree(opts)` / `clickElement(name)` / `typeIntoElement(name, text)`
 *
 * **不要**在已有方法签名上做 breaking 改动——加 optional 参数 / 加新方法可以，
 * 改入参 / 删方法 / 改返回类型不可。规范 § 9.0.4 "跨宿主 dispatcher 渐进迁移"
 * 标准要求接口稳定。
 */
export interface DesktopExecutor {
  // -- Session lifecycle ---------------------------------------------------

  startSession(
    sessionId: string,
    opts?: {
      grantFlags?: Partial<{
        clipboardRead: boolean
        clipboardWrite: boolean
        systemKeyCombos: boolean
      }>
      allowedApps?: string[]
    },
  ): void

  endSession(): void

  /** 返回当前 session 的浅拷贝快照（结构化对象，不是 mutable 引用）。 */
  getSession(): { sessionId: string; [k: string]: unknown } | null

  setAbortSignal(signal: AbortSignal): void

  /** 当前 session 的空闲毫秒数（无 session 时返回 0）。 */
  getIdleMs(): number

  // -- Capability checks ----------------------------------------------------

  checkAccessibility(prompt?: boolean): boolean

  checkScreenRecording(): { granted: boolean; status: string }

  // -- Observation ---------------------------------------------------------

  screenshot(opts: DesktopExecutorScreenshotOpts): Promise<DesktopExecutorScreenshotResult>

  // -- Mouse ---------------------------------------------------------------

  click(
    x: number,
    y: number,
    opts?: { button?: 'left' | 'right' | 'middle'; count?: number },
  ): Promise<void>

  scroll(x: number, y: number, dx: number, dy: number): Promise<void>

  drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration?: number,
  ): Promise<void>

  move(x: number, y: number): Promise<void>

  // -- Keyboard ------------------------------------------------------------

  type(text: string, useClipboard?: boolean): Promise<void>

  keyPress(key: string, modifiers?: string[], repeat?: number): Promise<void>

  hotkey(keys: string[]): Promise<void>

  // -- Window --------------------------------------------------------------

  listWindows(): Promise<DesktopExecutorWindowInfo[]>

  activateWindow(target: string): Promise<void>

  openApp(name: string): Promise<void>

  // -- Batch / Authorization extension -------------------------------------

  batch(actions: DesktopExecutorBatchAction[]): Promise<DesktopExecutorBatchResult>

  extendAllowedApps(
    sessionId: string,
    apps: string[],
    opts?: { reason?: string },
  ): Promise<string[]>

  // -- Runtime configuration -----------------------------------------------

  /**
   * 动态切换 pixelCompare 开关。规范 § 4.5.3 / § 10 Q11——v2.0 模块零起,
   * app.json `tabdesktop.pixelCompare.enabled` 通过 `loadAppConfig` 读出后
   * 由实例化点传入；实例化后仍可调用本方法热切换（Space 切换 / 测试场景）。
   */
  setPixelCompareEnabled(enabled: boolean): void

  // -- Accessibility Tree（模块四 · 规范 § 4.6） ---------------------------

  /**
   * 获取当前前台窗口（或指定窗口）的 AX 快照。
   *
   * macOS 走 osascript + System Events；Windows 走 PowerShell + UIAutomation。
   * AX 不可用时抛 `AX_UNAVAILABLE`。
   */
  captureAccessibilityTree?(opts?: import('./accessibility.js').AccessibilityTreeOpts): Promise<import('./accessibility.js').AccessibilitySnapshot>

  /**
   * 按名字 + 角色（可选）定位并点击元素。
   * 内部先查 AX 拿 bounds，再走现有 click 路径（含 pixelCompare）。
   * 找不到元素时抛 `ELEMENT_NOT_FOUND`。
   */
  clickElement?(opts: import('./accessibility.js').ClickElementOpts): Promise<import('./accessibility.js').ClickElementResult>

  /**
   * 按名字 + 角色定位输入框并输入文本。
   * 内部先查 AX 拿 bounds，激活元素后输入，失败回落到 click 中心 → type。
   * 找不到元素时抛 `ELEMENT_NOT_FOUND`。
   */
  typeIntoElement?(opts: import('./accessibility.js').TypeIntoElementOpts): Promise<import('./accessibility.js').TypeIntoElementResult>

  // -- Bound window 模式（v2.2 模块零扫尾 · 独立验收 P0-3 占位） ----------
  //
  // 规范 § 9.4.1 第 1 项 / `B5_ComputerUse桌面栈.md:740-754`：bound window
  // 让操作走 SendMessage(hwnd, WM_*) 而非全局事件，不抢焦点 / 不动真鼠标 /
  // 截屏走 PrintWindow。
  //
  // **TypeScript 模式选 optional method 而非 capability sub-interface**：
  // - 调用方调用路径浅（`executor.bindWindow?.(target)` vs
  //   `executor.boundWindow?.bindWindow(target)`），可读性更好；
  // - v1 / v2.1 的 `DesktopExecutorService` 不实现这两个方法不违反契约
  //   （optional method 默认就是 undefined）—— 不需要为 M3a 还没到来的能力
  //   先加 stub `throw 'not implemented'`，与"M0 不破坏现有实现"承诺一致；
  // - M3a 落 Win32 SendMessage / PrintWindow 时直接在 `DesktopExecutorService`
  //   类上加方法实现即可，不动 contracts 包；
  // - `bindSessionContext` wrapper 已加透传 + executor 未实现时抛 DesktopError
  //   的 stub（详见 `desktop-session-context.ts`），让路由层调 `bound.bindWindow`
  //   时收到清晰的"v1 不支持"中文三段式而非 `executor.bindWindow is not a function`。

  /**
   * 把后续操作绑定到指定窗口（M3a Windows · bound window 模式）。
   *
   * 绑定后 click / type / screenshot 走目标窗口的消息队列 / PrintWindow，
   * 不影响用户当前焦点的应用。session 内同时只能 bind 一个窗口。
   *
   * @param target 目标窗口标识（handle 或 bundleId / 进程名等可定位信息）
   * @returns 绑定成功返回 `{ ok: true }`；失败抛 `DesktopError`
   *   （`PERMISSION_DENIED` v1 未实现 / `VALIDATION_ERROR` target 非法
   *   / `INTERNAL_ERROR` HWND 不存在等）
   */
  bindWindow?(target: { handle?: number | string; bundleId?: string }): Promise<{ ok: true }>

  /**
   * 解除当前 session 的窗口绑定，回到 global 模式。
   *
   * @returns 解除成功返回 `{ ok: true }`；失败抛 `DesktopError`
   */
  unbindWindow?(): Promise<{ ok: true }>
}

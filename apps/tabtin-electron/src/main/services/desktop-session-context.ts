/**
 * `bindSessionContext` —— 桌面操控会话上下文绑定 wrapper。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.2 + § 9.1（v2.0 → v2.1
 * 模块零落地）。
 *
 * **它解决的问题**：v2.0 之前路由层 `cli/routes/desktop.ts` 直接持有
 * `getCLIDesktopExecutor()` 返回的单例，调方法时依赖 executor 内部
 * `currentSession` 全局状态。模块零引入 `bindSessionContext`：路由层先把
 * 当前会话信息派生成显式 `DesktopSessionContext` 对象，再调
 * `bindSessionContext(executor, ctx)` 拿到 wrapper，所有动作走 wrapper 调用。
 *
 * **模块零阶段（v2.1）**：
 * - wrapper 是一层 thin proxy + ctx 校验；
 * - 主从关系：`executor.getSession()` 仍是事实状态源，ctx 从中派生（不修改 executor
 *   内部 currentSession）；
 * - 校验语义：wrapper 调动作前先校验 ctx.sessionId 与 executor.getSession().sessionId
 *   一致——不一致即抛 `PERMISSION_DENIED + 中文三段式`，避免"路由层 ctx 与 executor
 *   currentSession 不同步"的隐形 bug；
 * - 不破坏现有任何行为：所有动作方法的入参 / 返回 / 异常路径 100% 透传给 executor。
 *
 * **未来模块翻转主从**（M2 多 session / 跨宿主 dispatcher）：
 * - 模块二支持"审批弹窗期间其他 session 不被阻塞"时，wrapper 会按 ctx.sessionId
 *   路由到对应的 session 容器，不再依赖单例 executor.currentSession；
 * - 此时 ctx 是输入、currentSession 是派生（与现状颠倒）。
 *
 * **不在这一层做的事**（保持薄）：
 * - 策略评估 / device_permissions 拦截 / 锁检查 / idle 超时——这些是路由层职责；
 * - 审计写入 / errorCode 映射 / HTTP 响应——这些是路由层 catch 块职责；
 * - 多 session 容器管理——M2 模块的事，模块零只把 wrapper 形状先定下来。
 */

import type {
  DesktopExecutor,
  DesktopExecutorBatchAction,
  DesktopExecutorBatchResult,
  DesktopExecutorScreenshotOpts,
  DesktopExecutorScreenshotResult,
  DesktopExecutorWindowInfo,
  DesktopSessionContext,
} from '@tabtin/desktop-contracts'
import { DesktopError, DesktopErrorCode } from './desktop-error-codes'

/**
 * 绑定到指定 ctx 的 Executor wrapper。所有动作调用前会做 ctx-session 一致性校验。
 *
 * 接口形状与 `DesktopExecutor` 完全一致——这是为了"路由层换不换 wrapper
 * 都不影响调用代码"的渐进迁移：M0 时路由层有的地方走 wrapper、有的地方
 * 直接调 executor 都不会编译错；M2 起 dispatcher 替换 wrapper 时同样无感。
 */
export type BoundDesktopExecutor = DesktopExecutor

/**
 * 校验 ctx.sessionId 与 executor 当前 session 是否一致。
 *
 * - executor 当前无 session（getSession() 返回 null）→ 抛 PERMISSION_DENIED
 *   （正确 ctx 必须有对应 session 才能动作）；
 * - sessionId 不匹配 → 抛 PERMISSION_DENIED（防 ctx 抓的是上一个 session 的状态）。
 *
 * 校验中文文案与 `DesktopExecutorService.requireSession` 风格一致（原因 · 影响
 * · 行动三段式），便于路由层 catch 后直接透传。
 */
function ensureCtxMatchesExecutor(
  executor: DesktopExecutor,
  ctx: DesktopSessionContext,
): void {
  const session = executor.getSession()
  if (!session) {
    throw new DesktopError(
      DesktopErrorCode.PERMISSION_DENIED,
      `桌面操控 session 未启动：bindSessionContext 收到 ctx.sessionId=${ctx.sessionId}，` +
      `但当前 executor 没有活跃 session。` +
      `本次操作未执行，其他桌面应用不受影响。` +
      `请先运行 tabtin desktop screenshot 建立 session（推荐），或显式调用 tabtin desktop session start。`,
    )
  }
  if (session.sessionId !== ctx.sessionId) {
    throw new DesktopError(
      DesktopErrorCode.PERMISSION_DENIED,
      `桌面操控 session 不一致：ctx.sessionId=${ctx.sessionId} 与当前 executor session=${session.sessionId} 不匹配。` +
      `本次操作未执行，原 session 不受影响。` +
      `这通常意味着 ctx 派生时机过早或 session 已被切换；请重新读取 executor.getSession() 派生 ctx。`,
    )
  }
}

/**
 * 把 `executor` 与 `ctx` 绑定，返回带 ctx 一致性校验的 wrapper。
 *
 * 模块零阶段：wrapper 的所有"动作类"方法（screenshot / click / scroll / drag /
 * move / type / keyPress / hotkey / batch / listWindows / activateWindow /
 * openApp）在调 executor 前先 `ensureCtxMatchesExecutor(executor, ctx)`，
 * 失败抛 `DesktopError`。"会话管理类"方法（startSession / endSession /
 * setAbortSignal / getSession / getIdleMs / extendAllowedApps）+ "权限检查类"方法
 * （checkAccessibility / checkScreenRecording / setPixelCompareEnabled）**不**做
 * 一致性校验——它们要么是 ctx 的源、要么不依赖 ctx，加校验会破坏自洽。
 *
 * @param executor TabDesktop 执行器实例（实现 DesktopExecutor 接口）。
 * @param ctx     当前要绑定的 session 上下文（路由层从 executor.getSession() 派生）。
 * @returns       带 ctx 校验的 wrapper；接口与 DesktopExecutor 一致。
 */
export function bindSessionContext(
  executor: DesktopExecutor,
  ctx: DesktopSessionContext,
): BoundDesktopExecutor {
  // 三视角 Review · 技术优雅度 §9.2 修：用 `satisfies BoundDesktopExecutor`
  // 显式校验 wrapper 字面量满足完整接口——`DesktopExecutor` 后续加方法
  // 时若 wrapper 漏写对应 case，TS 编译期会立刻报错（不会等到调用时失败）。
  // 这是给 M1/M2/M3a/M4 加方法的"约束保险"。
  const wrapper = {
    // -- 会话管理：直接透传，不校验 -----------------------------------------
    startSession(sessionId, opts) {
      return executor.startSession(sessionId, opts)
    },
    endSession() {
      return executor.endSession()
    },
    getSession() {
      return executor.getSession()
    },
    setAbortSignal(signal) {
      return executor.setAbortSignal(signal)
    },
    getIdleMs() {
      return executor.getIdleMs()
    },
    extendAllowedApps(sessionId, apps, opts) {
      return executor.extendAllowedApps(sessionId, apps, opts)
    },

    // -- 权限 / 配置：直接透传 ----------------------------------------------
    checkAccessibility(prompt) {
      return executor.checkAccessibility(prompt)
    },
    checkScreenRecording() {
      return executor.checkScreenRecording()
    },
    setPixelCompareEnabled(enabled) {
      return executor.setPixelCompareEnabled(enabled)
    },

    // -- 动作：先校验 ctx，再透传 -------------------------------------------
    async screenshot(opts: DesktopExecutorScreenshotOpts): Promise<DesktopExecutorScreenshotResult> {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.screenshot(opts)
    },
    async click(x, y, opts) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.click(x, y, opts)
    },
    async scroll(x, y, dx, dy) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.scroll(x, y, dx, dy)
    },
    async drag(from, to, duration) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.drag(from, to, duration)
    },
    async move(x, y) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.move(x, y)
    },
    async type(text, useClipboard) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.type(text, useClipboard)
    },
    async keyPress(key, modifiers, repeat) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.keyPress(key, modifiers, repeat)
    },
    async hotkey(keys) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.hotkey(keys)
    },
    async listWindows(): Promise<DesktopExecutorWindowInfo[]> {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.listWindows()
    },
    async activateWindow(target) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.activateWindow(target)
    },
    async openApp(name) {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.openApp(name)
    },
    async batch(actions: DesktopExecutorBatchAction[]): Promise<DesktopExecutorBatchResult> {
      ensureCtxMatchesExecutor(executor, ctx)
      return executor.batch(actions)
    },

    // -- 模块四 · Accessibility Tree 方法透传 ----------------------------
    async captureAccessibilityTree(opts) {
      ensureCtxMatchesExecutor(executor, ctx)
      if (typeof executor.captureAccessibilityTree !== 'function') {
        throw new DesktopError(
          DesktopErrorCode.AX_UNAVAILABLE,
          `Accessibility Tree 未实现：当前 TabDesktop 版本尚未启用 AX Tree 能力。` +
          `本次 AX 查询未执行。` +
          `请使用 tabtin desktop screenshot + 坐标点击作为替代。`,
        )
      }
      return executor.captureAccessibilityTree(opts)
    },
    async clickElement(opts) {
      ensureCtxMatchesExecutor(executor, ctx)
      if (typeof executor.clickElement !== 'function') {
        throw new DesktopError(
          DesktopErrorCode.AX_UNAVAILABLE,
          `按元素名点击未实现：当前 TabDesktop 版本尚未启用 AX Tree 能力。` +
          `本次点击未执行。` +
          `请使用 tabtin desktop screenshot + 坐标点击作为替代。`,
        )
      }
      return executor.clickElement(opts)
    },
    async typeIntoElement(opts) {
      ensureCtxMatchesExecutor(executor, ctx)
      if (typeof executor.typeIntoElement !== 'function') {
        throw new DesktopError(
          DesktopErrorCode.AX_UNAVAILABLE,
          `按元素名输入未实现：当前 TabDesktop 版本尚未启用 AX Tree 能力。` +
          `本次输入未执行。` +
          `请使用 tabtin desktop screenshot + 坐标点击后 type 作为替代。`,
        )
      }
      return executor.typeIntoElement(opts)
    },

    // -- 模块三-3a · bindWindow / unbindWindow 透传
    //
    // M3a 已在 DesktopExecutorService 上实现了 bindWindow / unbindWindow（Windows 平台），
    // wrapper 直接透传。非 Windows 平台或 executor 未实现时抛清晰的中文三段式。
    async bindWindow(target) {
      ensureCtxMatchesExecutor(executor, ctx)
      if (typeof executor.bindWindow !== 'function') {
        throw new DesktopError(
          DesktopErrorCode.PERMISSION_DENIED,
          `bound window 模式不可用：当前平台或 TabDesktop 版本不支持窗口绑定。` +
          `本次绑定未执行；后续操作仍走默认的全局事件 / 全屏截屏路径。` +
          `bound window 仅在 Windows 平台可用（macOS 用户不需要窗口绑定）。`,
        )
      }
      return executor.bindWindow(target)
    },
    async unbindWindow() {
      ensureCtxMatchesExecutor(executor, ctx)
      if (typeof executor.unbindWindow !== 'function') {
        throw new DesktopError(
          DesktopErrorCode.PERMISSION_DENIED,
          `bound window 模式不可用：当前平台或 TabDesktop 版本不支持窗口绑定。` +
          `本次解绑未执行；后续操作继续走默认路径。`,
        )
      }
      return executor.unbindWindow()
    },
  } satisfies BoundDesktopExecutor
  return wrapper
}

/**
 * 从 executor 当前 session 派生 ctx 的辅助函数。
 *
 * 路由层在每次请求入口处调用：先取 executor.getSession() → 若有 session 则
 * 派生 ctx → bindSessionContext。如果当前无 session（例如 /screenshot 的冷启动
 * 路径），路由层不调本函数 / 不走 wrapper，直接调 executor.screenshot 让 executor
 * 内部走"建立 session"的子路径。
 *
 * 模块零阶段：派生字段限于"现有 DesktopSession 已有的字段"——authorizationProfile /
 * subGates / coordinateMode / hostBundleId / clipboardGuardActive 等模块一/二/四
 * 占位字段保持 undefined，下游模块落地时再填值。
 *
 * @returns ctx，或 null 当 executor 当前无 session。
 */
export function deriveSessionContextFromExecutor(
  executor: DesktopExecutor,
): DesktopSessionContext | null {
  const session = executor.getSession()
  if (!session) return null

  // 现有 DesktopSession 字段集合 → DesktopSessionContext 字段集合的映射。
  // 注：这里的类型 cast 是因为接口契约是结构化的（DesktopExecutor.getSession()
  // 返回 `{ sessionId: string; [k: string]: unknown }` 宽松形态），但实际返回
  // 的是 DesktopExecutorService.DesktopSession 完整结构 —— cast 后字段一一对应。
  const s = session as unknown as {
    sessionId: string
    grantFlags: { clipboardRead: boolean; clipboardWrite: boolean; systemKeyCombos: boolean }
    startedAt: number
    lastActivityAt?: number
    frozenDisplayConfig?: {
      width: number
      height: number
      scaleFactor: number
      boundsX: number
      boundsY: number
    }
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      scaleFactor: number
      regionOffset?: { x: number; y: number }
    }
    lastScreenshotPath?: string
    selectedDisplayId?: number
    mainWindowHidden?: boolean
    allowedApps?: string[]
    screenRecordingChecked?: boolean
  }

  return {
    sessionId: s.sessionId,
    grantFlags: { ...s.grantFlags },
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    frozenDisplayConfig: s.frozenDisplayConfig ? { ...s.frozenDisplayConfig } : undefined,
    lastScreenshotDims: s.lastScreenshotDims
      ? {
          ...s.lastScreenshotDims,
          regionOffset: s.lastScreenshotDims.regionOffset
            ? { ...s.lastScreenshotDims.regionOffset }
            : undefined,
        }
      : undefined,
    lastScreenshotPath: s.lastScreenshotPath,
    selectedDisplayId: s.selectedDisplayId,
    mainWindowHidden: s.mainWindowHidden,
    allowedApps: s.allowedApps ? [...s.allowedApps] : undefined,
    screenRecordingChecked: s.screenRecordingChecked,
    // 模块一/二/四占位字段：模块零阶段保持 undefined，下游模块落地时填值
    authorizationProfile: undefined,
    subGates: undefined,
    coordinateMode: undefined,
    hostBundleId: undefined,
  }
}

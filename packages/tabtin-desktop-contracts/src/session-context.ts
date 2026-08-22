/**
 * 桌面操控会话上下文（规范 § 3.5.2 占位 · 模块零落地）。
 *
 * v2.0 之前 `DesktopExecutorService` 隐式持有 `currentSession` 全局状态；v2.0
 * 引入 `DesktopSessionContext` 是为了：
 *
 * 1. **接口归一**：把"什么是一个 session"从代码隐式约定升级为类型契约，
 *    让模块二的 6 子开关 / 模块四的坐标模式 / 模块一的 tier 都有明确字段位；
 * 2. **多 session 演进路径**：模块二明确允许"审批弹窗期间其他 session 不被
 *    阻塞"——执行器需要按 ctx 路由，不再依赖单例 currentSession；
 * 3. **跨宿主复用**：未来 Daemon / Cloud 模式落地时，dispatcher 把 ctx 显式
 *    构造后传入，宿主无关。
 *
 * **模块零阶段**：这是接口形状定型；实际状态仍由 `DesktopExecutorService`
 * 内部 `currentSession` 字段持有，wrapper（`bindSessionContext`）从执行器
 * 派生 ctx。模块二支持多 session 后再翻转主从。
 */

import type { DesktopAuthorizationProfile } from './authorization-profile.js'
import type { DesktopSubGates } from './sub-gates.js'
import type { DesktopCoordinateMode } from './coordinate-mode.js'

/**
 * `grantFlags` —— 规范 § 4.3.7 / § 6.3 已有概念。审批通过后 session 期间冻结。
 */
export interface DesktopGrantFlags {
  /** 剪贴板读权限（v1 暂未独立使用，预留）。 */
  clipboardRead: boolean
  /** 剪贴板写权限（type --clipboard 路径需要）。 */
  clipboardWrite: boolean
  /** 危险系统组合键（Cmd+Q / Ctrl+Alt+Del 类）的允许标志。 */
  systemKeyCombos: boolean
}

/**
 * 显示器配置冻结 —— 规范 § 5.3 规则 7-8 / Q2。session 首次截屏时冻结，
 * 后续截屏检测到变化即 fail-fast（DISPLAY_CONFIG_CHANGED）。
 */
export interface DesktopFrozenDisplayConfig {
  width: number
  height: number
  scaleFactor: number
  boundsX: number
  boundsY: number
}

/**
 * 上次截屏的尺寸 / 区域信息 —— 规范 § 4.5.3 pixelCompare 与 § 4.1 region 模式
 * 共用。`regionOffset` 存在表示上次是 region 截屏（pixelCompare 会按"异常红线"
 * 跳过校验，规范 § 4.5.3.1）。
 */
export interface DesktopScreenshotDimsContext {
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  scaleFactor: number
  regionOffset?: { x: number; y: number }
}

/**
 * 桌面操控会话上下文。
 *
 * **字段集合与现有 `DesktopSession` 类型对齐 + 模块二/三/四的占位字段**——
 * 模块零阶段下游模块字段为 undefined / 默认值，模块逐个落地时填充语义。
 *
 * 与规范 § 3.5.2 占位的偏差：本接口在占位字段之外多了 `hostBundleId` /
 * `lastScreenshotPath` / `mainWindowHidden` / `screenRecordingChecked`——
 * 这些是现有 `DesktopSession` 已有字段，接口归一时不能丢；下游模块按需
 * 消费（不消费就传 undefined）。
 */
export interface DesktopSessionContext {
  /** session 唯一标识（与 `DesktopUseLock` 文件锁的 sessionId 一致）。 */
  sessionId: string

  /** 审批通过的权限标志，session 内冻结。 */
  grantFlags: DesktopGrantFlags

  /** 启动时间戳（毫秒）。 */
  startedAt: number

  /** 最近活动时间（用于 10min idle timeout 判定，规范 § 5.3 规则 5）。 */
  lastActivityAt?: number

  /** 显示器配置冻结值（首次截屏时填入）。 */
  frozenDisplayConfig?: DesktopFrozenDisplayConfig

  /** 上次截屏尺寸（坐标换算 + pixelCompare 用）。 */
  lastScreenshotDims?: DesktopScreenshotDimsContext

  /**
   * 上次截屏的文件路径。pixelCompare 按需读 9×9 patch 时引用（规范 § 4.5.3
   * 第 6 点 · v1 走"按需读文件"避免常驻内存）。
   */
  lastScreenshotPath?: string

  /** 当前选中的显示器 id（多显示器场景）。 */
  selectedDisplayId?: number

  /**
   * TabTin 主窗口是否在本 session 期间被最小化（截图时为避免自截需要隐藏，
   * endSession 时恢复）。
   */
  mainWindowHidden?: boolean

  /**
   * 允许操作的应用名单（精确匹配，规范 § 6.6 v1.6 加固语义）。
   *
   * 模块零阶段：仍由 session 启动时一次性传入（与现状一致）。模块一引入
   * `DesktopAuthorizationProfile` 后，本字段会迁移到 `authorizationProfile.allowedApps`，
   * 当前位置保留作为兼容入口。
   */
  allowedApps?: string[]

  /** macOS 屏幕录制权限是否本 session 已校验过（避免每次截图都问）。 */
  screenRecordingChecked?: boolean

  /**
   * 触发本次操控的 host bundleId（macOS） / 进程标识（Windows）。模块二
   * `prepareForAction` hide / unhide 流程要排除自己；模块二落地前为 undefined。
   */
  hostBundleId?: string

  /**
   * 模块一 · 授权画像（占位）。模块零阶段 = `DEFAULT_DESKTOP_AUTHORIZATION_PROFILE`
   * 等价行为；模块一落地后由 Space 配置 / Agent 协议填值。
   */
  authorizationProfile?: DesktopAuthorizationProfile

  /**
   * 模块二 · 6 子开关（占位）。模块零阶段 = `DEFAULT_DESKTOP_SUB_GATES`
   * 全 enabled；模块二落地后由 GrowthBook gate / Space 设置驱动。
   */
  subGates?: DesktopSubGates

  /**
   * 模块四 · 坐标模式（占位）。模块零阶段 = `'absolute_pixel'`；模块四落地
   * 后由 Space 配置切换 `'normalized_0_100'`。
   */
  coordinateMode?: DesktopCoordinateMode

  /**
   * 模块三-3a · bound window 模式状态（v2.2 模块零扫尾 · 独立验收 P0-3 占位）。
   *
   * 规范 § 9.4.1 第 1 项 / `B5_ComputerUse桌面栈.md:740-754`：bound window
   * 模式让所有窗口操作不抢焦点 / 不动用户真实鼠标 —— 通过 Win32 SendMessage
   * 把事件路由到目标 HWND 的窗口消息队列；截屏走 PrintWindow 而非 desktopCapturer。
   *
   * 与 `hostBundleId` 的概念边界：
   * - `hostBundleId` = 触发 TabDesktop 操控的 host 进程标识（TabTin 自身的 bundleId）
   * - `boundWindow` = Agent 想操控的目标窗口（Notepad / Excel 的 HWND）
   *
   * **v1 / v2.1 阶段**：所有平台为 undefined（"global 模式" = v1.8 之前的全屏 +
   * 抢焦点 + 真鼠标行为）。
   *
   * **模块三-3a 落地后**：
   * - `mode='bound'` + `handle` 填 HWND 数值 → click / type 走 SendMessage
   * - `mode='global'`（默认） → 走现有 nut-js 全局事件路径
   *
   * `handle` 用 `number | string` 通用类型 —— Win32 HWND 是 number、macOS
   * `windowID` 是 number、未来 Linux Wayland surface id 可能是字符串，避免类型
   * 冲突。
   */
  boundWindow?: {
    /** Win32 HWND / macOS windowID / 等价窗口句柄 */
    handle?: number | string
    /** 操作系统进程 ID（可选，用于 race detection） */
    processId?: number
    /** 显示器 ID（多显示器场景 bound 到特定屏） */
    displayId?: number
    /** 应用 bundleId（macOS）/ 进程可执行名（Win），便于审批 / 审计展示 */
    bundleId?: string
    /** 模式：bound = 走 SendMessage / PrintWindow；global = v1 默认全局事件 */
    mode?: 'bound' | 'global'
  }
}

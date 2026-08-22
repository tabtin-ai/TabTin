/**
 * 授权画像 —— 模块一 · 应用权限体系（v1 占位 · 模块零先定型）。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.2 + § 9.2。
 *
 * v1 模块零阶段 **字段结构定型，业务语义模块一落实**：
 * - tier 在模块零阶段始终是 `'full'`（与 v1.8 之前的"无 tier 概念"行为等价）；
 * - allowedApps 在模块零仍由 session 启动时一次性传入（与 `DesktopSession.allowedApps`
 *   现状一致）；
 * - deniedApps / sentinelApps / clipboardGuard 在模块一落实前为 undefined。
 */
export type DesktopAuthorizationTier = 'read' | 'click' | 'full'

/** 模块二 · clipboardGuard 子状态（占位）。 */
export interface DesktopClipboardGuardState {
  /** 是否处于"切前台时清空剪贴板"激活态。 */
  active: boolean
  /** 触发清空的应用 bundleId / 进程标识（诊断用，可选）。 */
  scope?: string
}

/**
 * 授权画像。模块一落地后承载 tier 三档 + 名单 + clipboardGuard 完整语义。
 *
 * 模块零阶段：所有可选字段均默认 undefined，tier 默认 `'full'`。
 */
export interface DesktopAuthorizationProfile {
  /** 三档授权：read 仅截屏 / click 截屏+点击 / full 全功能（v1.8 之前的默认）。 */
  tier: DesktopAuthorizationTier
  /** 允许操作的应用名单（精确匹配，规范 § 6.6 v1.6 加固语义）。 */
  allowedApps?: string[]
  /** 永久禁名单（规范 § 9.2 模块一）。 */
  deniedApps?: string[]
  /** 高风险打警告标的应用（规范 § 9.2 模块一）。 */
  sentinelApps?: string[]
  /** clipboardGuard 状态（规范 § 9.2 模块一 + § 9.3 模块二联动）。 */
  clipboardGuard?: DesktopClipboardGuardState
}

/**
 * 模块零默认画像 —— v1.8 之前 TabDesktop 的"无 tier"行为等价物。
 * 模块一落地后由路由层 / Executor 按 Space 配置覆盖。
 */
export const DEFAULT_DESKTOP_AUTHORIZATION_PROFILE: DesktopAuthorizationProfile = {
  tier: 'full',
}

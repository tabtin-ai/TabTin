/**
 * 6 个子开关 —— 模块二 · 安全操控闭环（v1 占位 · 模块零先定型）。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.2 + § 9.3。
 *
 * v1 模块零阶段：所有 6 个子开关默认 enabled=true（行为等价于"无子开关
 * 概念"），模块二落地后接入 GrowthBook gate / Space 设置 / 客户端动态切换。
 */

/** 单个子开关状态。`blockReason` 在 `enabled=false` 时填，便于路由层告知 Agent。 */
export interface DesktopGateState {
  enabled: boolean
  blockReason?: string
}

/** 6 个子开关——与规范 § 9.3 6 subGates 一对一。 */
export interface DesktopSubGates {
  /** 截屏（screenshot 路由）。 */
  screenshot: DesktopGateState
  /** 点击（click / drag / move 路由）。 */
  click: DesktopGateState
  /** 输入（type / key / hotkey 路由）。 */
  type: DesktopGateState
  /** 剪贴板（type --clipboard 路径）。 */
  clipboard: DesktopGateState
  /** 应用切换（activate / open 路由）。 */
  activate: DesktopGateState
  /** 窗口管理（windows / activate 的子集）。 */
  windowMgmt: DesktopGateState
}

const ENABLED: DesktopGateState = { enabled: true }

/** 模块零默认 subGates —— 全部 enabled=true（v1.8 之前的等价行为）。 */
export const DEFAULT_DESKTOP_SUB_GATES: DesktopSubGates = {
  screenshot: ENABLED,
  click: ENABLED,
  type: ENABLED,
  clipboard: ENABLED,
  activate: ENABLED,
  windowMgmt: ENABLED,
}

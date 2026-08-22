/**
 * TabDesktop · 主进程侧"当前 Space"桌面相关缓存。
 *
 * 本模块**只含纯状态 + 读写函数**，不 import electron / 不做 IO——
 * 目的是让 cli-server.ts 里的 `device_permissions` 缓存可以在非 Electron 的
 * vitest 宿主里直接单测，不被 cli-server.ts 顶层 `import { app } from 'electron'`
 * + 下游 route 模块的 side-effect 拖累。
 *
 * cli-server.ts 从本模块 re-export 同名 API，**对外接口保持不变**。
 *
 * 规范出处：
 * - `device_permissions` 缓存（Wave 2.1）：`docs/planning/tabdesktop-spec-v1.md` § 6.5
 *
 * PD-11（W6 M3）：原 `authorization_preset` 主进程缓存（getter / setter 两个
 * API）已删除——CLI client 不再能"压低"Space 的 yolo 预设，统一以
 * `Agent.agent_config.security.allow_yolo_mode` 为唯一权威（v3 PRD §5.1.1
 * 字段改名）。`device_permissions` 缓存保留：它是 Space 级桌面观察 / 输入权限
 * 的 Source of Truth，与 yolo 正交。
 */

// ---------------------------------------------------------------------------
// device_permissions（规范 § 6.5 · Wave 2.1）
// ---------------------------------------------------------------------------

// 当前 Space 的 device_permissions。由渲染侧在
// selectedAgent.agent_config.device_permissions 变化时通过 IPC
// `desktop:setDevicePermissions` 推送进来；`/desktop/*` 路由在入口读这里，
// desktop_observe === 'block' 时直接拒绝（规范 § 6.5 第 2 条"桌面操控完全
// 不可用"的命令行侧兑现）。Wave 2 只有 Python Prompt 侧读了该字段，命令
// 行侧是"半落地"——Wave 2.1 补齐跨端一致性。
//
// 合法值见 packages/security-policy/src/types.ts `DevicePermissions`
// （Partial<Record<DevicePermissionKey, 'allow' | 'confirm' | 'block'>>）。
// null / 未推送表示"渲染侧尚未同步"，路由层回退到现有策略评估（保守允许）。
let currentSpaceDevicePermissions: Record<string, string> | null = null

/**
 * 设置当前 Space 的 device_permissions（规范 § 6.5）。
 *
 * 期望格式：`Record<DevicePermissionKey, 'allow' | 'confirm' | 'block'>`
 * 的子集；非对象 / null 等价于"未推送"，清空缓存。本函数做一次浅拷贝 +
 * 过滤非字符串 value，避免调用方 mutate 原对象或传入对象注入。
 */
export function setCurrentSpaceDevicePermissions(
  perms: Record<string, unknown> | null | undefined,
): void {
  if (perms == null || typeof perms !== 'object' || Array.isArray(perms)) {
    currentSpaceDevicePermissions = null
    return
  }
  const copy: Record<string, string> = {}
  for (const [k, v] of Object.entries(perms)) {
    if (typeof v === 'string') copy[k] = v
  }
  currentSpaceDevicePermissions = copy
}

/**
 * 读取当前 Space 缓存的 device_permissions。
 * 返回 `null` 表示渲染侧尚未推送——调用方应当**不拦截**（回退到现有策略
 * 评估），而不是保守 fallback 成某个全 block，避免冷启动打不开。
 */
export function getCurrentSpaceDevicePermissions(): Record<string, string> | null {
  return currentSpaceDevicePermissions
}

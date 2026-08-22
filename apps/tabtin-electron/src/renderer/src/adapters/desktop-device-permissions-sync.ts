/**
 * TabDesktop Wave 2.1 · 规范 § 6.5 — 渲染侧把当前 Space 的 device_permissions
 * 推送到 Electron 主进程，供 /desktop/* 路由在入口做 block 判定。
 *
 * 背景：
 *   Wave 2 首轮落地时 Python Prompt 侧（`device_permissions_policy.py`）已经
 *   按 `desktop_observe === 'block'` 跳过 `SECTION_TABDESKTOP`，但 Electron
 *   命令行路由层（`cli/routes/desktop.ts`）只读 preset 字符串、不读
 *   device_permissions 字典——"半落地"。规范 § 6.5 第 2 条"桌面操控完全
 *   不可用"的承诺在 CLI 侧失效。
 *
 *   Wave 2.1 扫尾：渲染侧订阅 `selectedAgent?.agent_config?.device_permissions`
 *   变化，通过 `window.tabtin.desktop.setDevicePermissions(perms)` 把字典推到
 *   主进程缓存；路由层在任何策略评估 / session 获锁前读 `desktop_observe`，
 *   block 即拒绝。
 *
 * 时序：
 *   - App 启动后 `initDesktopDevicePermissionsSync()` 被 `app-shell-init` 调用一次；
 *   - 首帧立即推送一次当前值（避免冷启动主进程缓存为 null）；
 *   - Zustand 订阅 `selectedAgent` 变化，浅比对 device_permissions 字段；
 *   - 变化即调 IPC；失败静默 warn（路由层会 fallback 到"不拦截"，保守允许）。
 *
 * 本模块的 SSoT 边界（PD-1 + PD-11 之后）：负责把 Space 的
 * `device_permissions` 字典同步到主进程缓存，供 `/desktop/*` 路由层
 * `desktop_observe=block` 入口拦截（规范 § 6.5）。yolo / "授权预设"
 * 这一类语义已不存在 —— 唯一的安全开关是
 * `Agent.agent_config.security.allow_yolo_mode`（v3 PRD §5.1.1），由主进程
 * ElectronAgentHost 直接从 selectedAgent 读取，与本模块完全正交。
 */

import { useSpaceStore } from '@/stores/useSpaceStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('DevicePermSync')

// 只允许合法 SwitchAction 值进到主进程（见
// packages/security-policy/src/types.ts `SwitchAction`）。其他字符串在主进程
// setCurrentSpaceDevicePermissions 已经会做过滤，但前置清理可减少 IPC payload。
const VALID_ACTIONS = new Set(['allow', 'confirm', 'block'])

let lastPushedPerms: Record<string, string> | null | undefined = undefined
let unsubscribe: (() => void) | null = null
let lastWarnMs = 0

function pushPerms(perms: Record<string, string> | null): void {
  const desktopApi =
    typeof window !== 'undefined'
      ? (window as unknown as {
          tabtin?: {
            desktop?: {
              setDevicePermissions?: (p: Record<string, string> | null) => Promise<unknown>
            }
          }
        }).tabtin?.desktop
      : undefined
  const fn = desktopApi?.setDevicePermissions
  if (typeof fn !== 'function') {
    // 非 Electron 环境（SSR / 纯 Web） —— 静默跳过。
    return
  }
  try {
    const result = fn(perms)
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      ;(result as Promise<unknown>).catch((err: unknown) => {
        const now = Date.now()
        if (now - lastWarnMs > 10_000) {
          lastWarnMs = now
          log.warn('IPC 推送失败，路由层将 fallback 到不拦截:', err)
        }
      })
    }
  } catch (err) {
    log.warn('IPC 调用抛错:', err)
  }
}

function resolvePermsFromAgent(agent: unknown): Record<string, string> | null {
  if (!agent || typeof agent !== 'object') return null
  const config = (agent as { agent_config?: unknown }).agent_config
  if (!config || typeof config !== 'object') return null

  // v2 嵌套：capabilities.overrides.device.device_permissions（W2.1.0 §1.3）
  // fallback 到 v1 顶层 device_permissions 兼容老数据。
  let raw: unknown = undefined
  const capabilities = (config as { capabilities?: unknown }).capabilities
  if (capabilities && typeof capabilities === 'object') {
    const overrides = (capabilities as { overrides?: unknown }).overrides
    if (overrides && typeof overrides === 'object') {
      const device = (overrides as { device?: unknown }).device
      if (device && typeof device === 'object') {
        raw = (device as { device_permissions?: unknown }).device_permissions
      }
    }
  }
  if (raw === undefined) {
    raw = (config as { device_permissions?: unknown }).device_permissions
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    if (!VALID_ACTIONS.has(v)) continue
    out[k] = v
  }
  // 空对象 vs null：Space 显式配置过全部键后又清空，视作"已同步 = 没有任何
  // block"——走空对象；未配置 device_permissions 走 null。
  return out
}

function permsEqual(
  a: Record<string, string> | null | undefined,
  b: Record<string, string> | null | undefined,
): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * 初始化渲染侧 device_permissions 同步。
 *
 * 被 `initAppShellForElectron` 在 App 启动后调用一次；重复调用会先解绑旧订阅。
 * 本函数是 desktop 侧唯一的 Space-level 权限同步入口（PD-1 + PD-11 之后
 * yolo 由主进程直接从 selectedAgent.agent_config.security 读，不走 IPC 推送；
 * device_permissions 因为命令行 `/desktop/*` 路由层在主进程持有缓存才需要 IPC 推）。
 */
export function initDesktopDevicePermissionsSync(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }

  // 首帧：立即推一次当前值，避免冷启动主进程缓存为 null 时
  // 用户已经在 block 态 Space 里操作的"首条请求穿透"窗口。
  const initialState = useSpaceStore.getState()
  const initialPerms = resolvePermsFromAgent(initialState.selectedAgent)
  if (!permsEqual(initialPerms, lastPushedPerms)) {
    lastPushedPerms = initialPerms
    pushPerms(initialPerms)
  }

  unsubscribe = useSpaceStore.subscribe((state) => {
    const next = resolvePermsFromAgent(state.selectedAgent)
    if (permsEqual(next, lastPushedPerms)) return
    lastPushedPerms = next
    pushPerms(next)
  })
}

/** 测试 / 调试用：获取上次推送的 perms（undefined 表示尚未推过）。 */
export function __getLastPushedPermsForTest(): Record<string, string> | null | undefined {
  return lastPushedPerms
}

/** 测试 / 调试用：重置内部状态。 */
export function __resetDesktopDevicePermissionsSyncForTest(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  lastPushedPerms = undefined
  lastWarnMs = 0
}

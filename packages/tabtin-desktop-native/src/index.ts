/**
 * @tabtin/desktop-native —— TabDesktop macOS 原生能力承载包入口（v2.1 模块零）。
 *
 * 模块零阶段：包能 import / 占位 Swift hello world / cmake-js 工程模板就绪 /
 * JS fallback 实现。**不真做 ESC PI / SCContentFilter / AX**——这些是模块二
 * 与模块四的事。
 *
 * 详见 README.md 的"升级路径"段。
 */

export {
  type DesktopNativeCapabilityState,
  type DesktopNativeCapabilities,
  FALLBACK_DESKTOP_NATIVE_CAPABILITIES,
  getDesktopNativeCapabilities,
} from './capabilities.js'

/**
 * native binding 实例的轻类型。模块二 / 四 给真实绑定填具体方法时，
 * 这个接口会被扩充——届时把对应方法签名加在这里（保持 v1 的 null fallback
 * 兼容：调用方先 `if (binding) ...` 再调）。
 */
export interface DesktopNativeBinding {
  /** 占位方法——返回 README 提示字符串，证明 binding 加载成功。 */
  greet?(): string
}

/**
 * 是否已启用真 native binding。
 *
 * 模块零阶段恒 false——native 编译流程未启用（package.json scripts.build:native
 * 是 echo 占位）。模块二 / 四启用 cmake-js 后，本函数会根据 require 是否成功返回真值。
 */
export function hasNativeBinding(): boolean {
  return false
}

/**
 * 加载 native binding 实例。
 *
 * 模块零阶段恒返回 null（fallback 不抛错——调用方按 `hasNativeBinding()` /
 * `getDesktopNativeCapabilities()` 决定是否走 fallback 路径）。
 *
 * 设计意图：调用方代码可以这么写——
 * ```ts
 * const binding = loadNativeBinding()
 * if (binding && binding.greet) {
 *   console.log(binding.greet())
 * } else {
 *   // 走 osascript / JS fallback
 * }
 * ```
 * 这样 模块二 / 四 启用 native 后调用方代码完全不变，binding 自动从 null
 * 变成真实例。
 *
 * **未来 native 加载实现注意（模块二 / 四接棒人）**：
 * 本包是 ESM (`"type": "module"`)，**不能**直接 `require('.node')`。模块二
 * 启用 native 时按下面任一路径接入（取决于运行时环境）：
 *
 * ```ts
 * // 方案 A · Electron 主进程 / Node ≥ 14（推荐，因为 .node 加载是同步语义）
 * import { createRequire } from 'node:module'
 * const require = createRequire(import.meta.url)
 * try {
 *   return require('../build/Release/desktop_native.node')
 * } catch {
 *   return null
 * }
 *
 * // 方案 B · 纯 ESM 环境 / 未来 worker（如可异步加载）
 * try {
 *   const mod = await import('../build/Release/desktop_native.node')
 *   return (mod as { default?: DesktopNativeBinding }).default ?? mod as unknown as DesktopNativeBinding
 * } catch {
 *   return null
 * }
 * ```
 *
 * 三视角技术 Review §4 修：避免直接复制 `require('.node')` 这种与 ESM 包结构
 * 不兼容的写法（v2.1 之前的注释有误导）。
 */
export function loadNativeBinding(): DesktopNativeBinding | null {
  // 模块零（v2.1）：始终返回 null。
  // 模块二 / 四启用 native 时，**不要**直接 require ——本包是 ESM（"type": "module"）。
  // 走 createRequire(import.meta.url) 或动态 import('.node')；详见上面 JSDoc。
  return null
}

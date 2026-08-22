/**
 * @tabtin/desktop-native · 能力声明（v2.1 模块零占位）。
 *
 * 模块零阶段所有能力都是 'unavailable' + source='fallback'——下游消费方
 * （DesktopExecutorService / 路由层）按 capability 决定降级路径。
 *
 * 模块二 / 模块四启用 native 后，对应字段会变为：
 * - 'native'  · native binding 加载成功且当前平台 + arch 支持
 * - 'fallback' · native 加载失败但有 JS / osascript 降级路径
 * - 'unavailable' · 当前平台不支持本能力（例如 SCContentFilter 在 Windows）
 */

/** 单个能力的实现来源。 */
export type DesktopNativeCapabilityState = 'native' | 'fallback' | 'unavailable'

/** 整体能力清单。 */
export interface DesktopNativeCapabilities {
  /** 模块二 · ESC CGEventTap PI 防御能力。 */
  escCGEventTapPI: DesktopNativeCapabilityState
  /** 模块二 · macOS 合成器级截图过滤（SCContentFilter）。 */
  scContentFilter: DesktopNativeCapabilityState
  /** 模块四 · macOS AXUIElement Accessibility Tree。 */
  axUIElementTree: DesktopNativeCapabilityState
  /**
   * 整体来源。模块零阶段恒 'fallback'；模块二/四加载真 native 成功后
   * 变 'native'，加载失败但 JS / osascript fallback 可用时为 'fallback'。
   */
  source: 'native' | 'fallback'
}

/** 模块零阶段的默认能力清单——全部 unavailable + fallback。 */
export const FALLBACK_DESKTOP_NATIVE_CAPABILITIES: DesktopNativeCapabilities = {
  escCGEventTapPI: 'unavailable',
  scContentFilter: 'unavailable',
  axUIElementTree: 'unavailable',
  source: 'fallback',
}

/**
 * 返回当前 desktop-native 包提供的能力清单。
 *
 * 模块零（v2.1）阶段：恒返回 `FALLBACK_DESKTOP_NATIVE_CAPABILITIES`——
 * 表示 native binding 未启用，所有能力走 fallback 路径（osascript / JS）。
 *
 * 模块二 / 四启用 native 后：本函数会根据 `loadNativeBinding()` 的结果
 * 与 process.platform / arch 动态返回真实能力。
 */
export function getDesktopNativeCapabilities(): DesktopNativeCapabilities {
  return { ...FALLBACK_DESKTOP_NATIVE_CAPABILITIES }
}

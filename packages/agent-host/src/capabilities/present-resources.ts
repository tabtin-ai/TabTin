/**
 * `present_to_user` 的 TabTin 资源类型与自动打开策略。
 *
 * 「支持哪些资源类型」「哪种资源禁止自动打开」是 TabTin 产品口径，从中性
 * agent-runtime `presentation-tools` 迁出，经 `PresentationToolsDeps` 注入。
 */

/** present_to_user 支持的资源引用类型（与迁移前 runtime 硬编码一致）。 */
export const PRESENT_SUPPORTED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'table',
  'doc',
  'slide',
  'video',
  'site',
  'tracker',
])

/**
 * 资源自动打开策略。#3417：TabSlide App UI 已隐藏——slide 资源卡仍可出，但不再
 * 自动打开。其余资源类型保持自动打开。
 */
export function presentAutoOpenPolicy(resourceType: string): boolean {
  return resourceType !== 'slide'
}

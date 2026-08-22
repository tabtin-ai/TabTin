import { useUIStore } from '@/stores/useUIStore'

export const NATIVE_VIEW_OVERLAY_ATTRIBUTE = 'data-native-view-overlay'
export const NATIVE_VIEW_OVERLAY_SELECTOR = `[${NATIVE_VIEW_OVERLAY_ATTRIBUTE}="true"]`

/**
 * 原生 view 遮挡计数。
 *
 * toast 在透明 overlay WebContentsView（窄 bounds）。
 * 全局搜索 / notify.confirm 在主 renderer（半透明 mask 需与 UI 同层合成）。
 *
 * 注意：这里不收录 tooltip。
 * 1) hover tooltip 是轻量瞬时提示，为它隐藏整个浏览器原生 view 会让网页每次 hover
 *    都闪烁消失，体验远差于让 tooltip 自身避让；
 * 2) 历史上这里曾有 `[role="tooltip"][data-state="open"]`，但它永远命中不了 Radix
 *    tooltip——Radix 的 `role="tooltip"` 在隐藏的无障碍元素上（不带 data-state），
 *    可见内容的 data-state 只会是 delayed-open/instant-open/closed，从不是 open。
 *    tooltip 越界遮挡改由 smartsheet-ui Tooltip 的 collisionBoundary 约束在容器内解决
 *    （见 packages/smartsheet-ui/src/components/tooltip.tsx，）。
 */
export const NATIVE_VIEW_BLOCKING_OVERLAY_SELECTORS = [
  '[data-radix-portal]',
  '[data-floating-ui-portal]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="combobox"][data-state="open"]',
  NATIVE_VIEW_OVERLAY_SELECTOR,
] as const

export function countNativeViewBlockingOverlays(root: ParentNode = document): number {
  return NATIVE_VIEW_BLOCKING_OVERLAY_SELECTORS.reduce((acc, selector) => {
    return acc + root.querySelectorAll(selector).length
  }, 0)
}

export function syncNativeViewOverlayCountFromDom(root: ParentNode = document): number {
  const count = countNativeViewBlockingOverlays(root)
  const uiStore = useUIStore.getState()
  if (uiStore.overlayCount !== count) {
    uiStore.setOverlayCount(count)
  }
  return count
}

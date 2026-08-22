/** 工具栏右侧次要操作收进 `...` 的最大容器宽度（不含）。 */
export const TOOLBAR_ACTIONS_OVERFLOW_MAX_WIDTH_PX = 560

export function shouldOverflowToolbarActions(widthPx: number): boolean {
  return widthPx < TOOLBAR_ACTIONS_OVERFLOW_MAX_WIDTH_PX
}

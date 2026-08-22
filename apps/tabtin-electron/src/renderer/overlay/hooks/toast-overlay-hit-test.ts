/**
 * toast 子窗口默认整窗穿透；指针是否落在可交互命中区（关闭钮等）。
 * 命中区用 `data-overlay-track="true"` 标记（见 OverlayToaster）。
 */
export function isToastOverlayHitTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-overlay-track="true"]'))
}

export function shouldIgnoreToastOverlayMouse(
  clientX: number,
  clientY: number,
  elementFromPoint: (x: number, y: number) => Element | null = document.elementFromPoint.bind(document),
): boolean {
  return !isToastOverlayHitTarget(elementFromPoint(clientX, clientY))
}

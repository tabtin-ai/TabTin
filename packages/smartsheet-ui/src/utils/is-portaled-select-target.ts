/**
 * Radix Select Content 默认 portal 到 body。嵌在 Popover / Dialog 里时，
 * 点选项会被外层当成 interact-outside 而关掉整层。
 */
const PORTALED_SELECT_SELECTOR = [
  '[data-radix-select-content]',
  '[data-radix-popper-content-wrapper]',
].join(', ')

export const isPortaledSelectTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest(PORTALED_SELECT_SELECTOR))

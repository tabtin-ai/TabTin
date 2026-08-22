/**
 * Prevent Radix popover from closing when interacting with
 * nested overlays (e.g. Command menu inside a Popover).
 */
export const handlePopoverInteractOutside = (event: Event): void => {
  const target = event.target
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (!el) return
  if (el.closest('[data-radix-popper-content-wrapper], [cmdk-root]')) {
    event.preventDefault()
  }
}

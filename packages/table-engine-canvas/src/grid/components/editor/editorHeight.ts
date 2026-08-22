/** Min height for long_text cell editor (px). */
export const LONG_TEXT_EDITOR_MIN_HEIGHT = 96

/**
 * Max editor height — capped at 40% of viewport or 320px whichever is larger.
 * Shared by TextEditor (isWrap) and GridLongTextEditor so pasted long markdown
 * cannot grow the overlay without bound.
 */
export function getMaxEditorHeight(viewportHeight?: number): number {
  const vh =
    typeof viewportHeight === 'number'
      ? viewportHeight
      : typeof window !== 'undefined'
        ? window.innerHeight
        : 0
  if (!vh) return 320
  return Math.max(320, Math.floor(vh * 0.4))
}

/** Clamp auto-grown editor height into [minHeight, maxHeight]. */
export function clampEditorHeight(
  scrollHeight: number,
  minHeight: number,
  maxHeight: number,
): number {
  return Math.min(Math.max(scrollHeight, minHeight), maxHeight)
}

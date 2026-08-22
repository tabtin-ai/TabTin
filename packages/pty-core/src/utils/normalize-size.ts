const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MIN_COLS = 2
const MIN_ROWS = 1
const MAX_COLS = 500
const MAX_ROWS = 500

export interface TerminalSize {
  cols: number
  rows: number
}

/**
 * Normalizes terminal dimensions, clamping to safe bounds.
 */
export function normalizeSize(cols?: number, rows?: number): TerminalSize {
  const c = Number.isFinite(cols) ? cols! : DEFAULT_COLS
  const r = Number.isFinite(rows) ? rows! : DEFAULT_ROWS
  return {
    cols: Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(c))),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(r))),
  }
}

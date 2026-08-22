export const MARKER_PREFIX = '__TABTIN_CMD_'
/**
 * PC-24 fix: removed the `g` flag to prevent lastIndex state bugs when
 * using exec/test across multiple calls. The `m` flag is retained for
 * multiline matching. Use createMarkerLineRE() when global matching is needed.
 */
export const MARKER_LINE_RE = /^.*__TABTIN_CMD_(?:START|END)_[a-f0-9]+.*$/m

/**
 * PC-24 fix: factory function that returns a fresh global regex for use in
 * replace/replaceAll. Each call returns a new instance, avoiding shared
 * lastIndex state.
 */
export function createMarkerLineRE(): RegExp {
  return /^.*__TABTIN_CMD_(?:START|END)_[a-f0-9]+.*$/gm
}
export const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
export const DEFAULT_BLOCK_UNTIL_MS = 30_000
export const SHELL_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024
export const BG_WATCHER_MAX_AGE_MS = 10 * 60 * 1000

/** Maximum allowed length for an auto-respond response string (PC-4/PC-5 mitigation) */
export const AUTO_RESPOND_MAX_RESPONSE_LENGTH = 1024

/**
 * Extended ANSI regex that also covers OSC sequences (PC-10 fix).
 * OSC format: ESC ] ... (ST | BEL), where ST = ESC \\ or 0x9C
 */
export const ANSI_EXTENDED_RE = /\x1B(?:\](?:[^\x07\x1B]|\x1B[^\\])*(?:\x07|\x1B\\|\x9C)?|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

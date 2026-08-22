// PTY host abstractions
export { PtyOutputBuffer } from './PtyOutputBuffer'
export { PtyWriteChannel } from './PtyWriteChannel'
export type { PtyWritable, PtyWriteChannelOptions, WriteChannelCloseReason } from './PtyWriteChannel'
export type {
  PtyHostClient,
  PtyHostDisposable,
  PtyHostExitEvent,
  PtyHostSession,
  PtyHostSpawnedEvent,
  PtyHostSpawnRequest,
} from './PtyHost'
export type { PtyHostCommand, PtyHostEvent } from './PtyHostProtocol'
export { SyntheticPtyHostSession } from './SyntheticPtyHostSession'

// Session store
export { PtySessionStore } from './PtySessionStore'
export type {
  ExecuteCommandResult,
  PtySession,
  PtySessionCloseReason,
  AgentSessionClosedInfo,
  ActiveAutoRespond,
  PendingCommand,
  BackgroundedWatcher,
} from './PtySessionStore'

// In-process PTY host (requires node-pty peer dependency)
export { InProcessPtyHostClient } from './InProcessPtyHost'

// Process terminator
export { PtyProcessTerminator } from './PtyProcessTerminator'
export type {
  PtyProcessTerminationOptions,
  PtyProcessTerminatorDeps,
  TerminateTreeHandle,
} from './PtyProcessTerminator'

// Process tree utilities
export { collectProcessSubtreeUsage } from './process-tree'
export type { ProcessUsageEntry } from './process-tree'

// Marker protocol
export {
  MARKER_PREFIX,
  MARKER_LINE_RE,
  createMarkerLineRE,
  ANSI_RE,
  DEFAULT_BLOCK_UNTIL_MS,
  SHELL_ENV_KEY_RE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_OUTPUT_BUFFER_BYTES,
  BG_WATCHER_MAX_AGE_MS,
  AUTO_RESPOND_MAX_RESPONSE_LENGTH,
  ANSI_EXTENDED_RE,
} from './marker/constants'
export { generateMarkerPair } from './marker/generator'
export type { MarkerPair } from './marker/generator'
export { parseEndMarker, extractMarkerTail, END_MARKER_SEPARATOR } from './marker/parser'
export type { ParsedEndMarker } from './marker/parser'
export { wrapCommand, shellQuote, detectShellType } from './marker/command-wrapper'
export type { CommandWrapOptions, ShellType } from './marker/command-wrapper'
export { cleanOutput } from './marker/output-cleaner'

// Auto-respond
export { checkAutoRespond, validateAutoRespondRule } from './auto-respond/checker'
export type { AutoRespondRule, AutoRespondMatch } from './auto-respond/types'

// Command runner (shared execute pipeline)
export { PtyCommandRunner } from './PtyCommandRunner'
export type {
  PtyCommandRunnerLogger,
  PtyCommandRunnerDeps,
  RunCommandOptions,
  FinalizeSessionOptions,
} from './PtyCommandRunner'

// Utilities
export { resolveCwd } from './utils/resolve-cwd'
export { resolveShell } from './utils/resolve-shell'
export { sanitizeEnv, SENSITIVE_ENV_VARS } from './utils/sanitize-env'
export { normalizeSize } from './utils/normalize-size'
export type { TerminalSize } from './utils/normalize-size'

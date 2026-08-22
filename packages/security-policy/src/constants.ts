/**
 * Checkpoint 变更性操作集合 — 需要 git_destructive 安全策略检查。
 *
 * SSOT: Daemon action-bridge + Electron FrontendActionBridge 统一引用此常量。
 *
 * 故意不包含 checkpoint_init / checkpoint_diff / checkpoint_gc / checkpoint_initial —
 * 这些是只读或初始化操作，不涉及数据破坏性，不需要 git_destructive 策略检查。
 */
export const CHECKPOINT_MUTATING_ACTIONS = new Set([
  'checkpoint_commit',
  'checkpoint_restore',
  'checkpoint_destroy',
]);

/**
 * ：识别平台受管的 tabtin CLI（browser / desktop）。
 * judge 仅在将要发出 workspace_out ask 时让位给 host ApprovalGate；
 * deny / sensitive_in_ask 不让位（浏览器闸覆盖不了这些语义）。
 *
 * 只做轻量识别（不复刻 browser-core 风险表）；认不出则不让位（fail-safe）。
 */

/** 平台受管 surface：这些子命令在 Electron CLI 边界有完整风险判定 + ApprovalGate。 */
const PLATFORM_MANAGED_SURFACES = new Set(['browser', 'desktop'])

export interface PlatformCliDeferral {
  surface: string
}

/**
 * 识别「将由平台 ApprovalGate 接管」的 tabtin CLI。
 * 允许前置 KEY=value env；拒绝带 shell 元字符的复杂拼接（留给 judge 常规路径）。
 */
export function detectPlatformManagedTabtinCli(
  command: string | undefined | null,
): PlatformCliDeferral | null {
  if (typeof command !== 'string') return null
  const trimmed = command.trim()
  if (!trimmed) return null
  // 复杂管道/重定向不让位——避免误放行「tabtin browser … | rm -rf」一类拼接
  if (/[|;&`$()<>]/.test(trimmed)) return null

  const tokens = trimmed.split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/.test(tokens[i])) {
    i++
  }
  if (tokens[i] !== 'tabtin') return null
  const surface = tokens[i + 1]
  if (!surface || !PLATFORM_MANAGED_SURFACES.has(surface)) return null
  return { surface }
}

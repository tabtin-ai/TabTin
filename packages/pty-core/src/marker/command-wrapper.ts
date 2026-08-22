import { SHELL_ENV_KEY_RE } from './constants'
// PC-21: The end marker now uses \x1F (Unit Separator) between exitCode and cwd.
// The separator is emitted via shell-specific escape sequences in the echo commands below.
// See END_MARKER_SEPARATOR in parser.ts for the parsing counterpart.
import type { MarkerPair } from './generator'

export type ShellType = 'posix' | 'fish' | 'powershell'

export interface CommandWrapOptions {
  env?: Record<string, string>
  workingDirectory?: string
  /**
   * The shell type used to generate appropriate syntax.
   * Defaults to 'posix' (bash/zsh/sh).
   * PC-17 fix: explicit shell type prevents generating invalid syntax
   * for non-POSIX shells like fish and PowerShell.
   */
  shellType?: ShellType
}

/**
 * Detects the shell type from a shell path string.
 * Returns 'fish', 'powershell', or 'posix' (default).
 */
export function detectShellType(shellPath: string): ShellType {
  const basename = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  if (basename === 'fish') return 'fish'
  if (/^(pwsh|powershell)(\.exe)?$/.test(basename)) return 'powershell'
  return 'posix'
}

/**
 * Shell-safe quoting: wraps a value in single quotes, escaping any embedded
 * single quotes via the '\'' idiom (end quote, escaped quote, start quote).
 * Single-quoted strings in bash undergo zero expansion.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** Single-quote for fish shell (fish uses \' inside single quotes) */
function fishQuote(value: string): string {
  return "'" + value.replace(/'/g, "\\'") + "'"
}

/** Single-quote for PowerShell (uses '' to escape inside single quotes) */
function pwshQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/**
 * Wraps a command with start/end markers and optional env/cwd setup.
 * Returns the shell string to write to the PTY.
 *
 * PC-17 fix: supports fish and PowerShell syntax in addition to POSIX.
 */
export function wrapCommand(
  command: string,
  markers: MarkerPair,
  options?: CommandWrapOptions,
): string {
  const shellType = options?.shellType ?? 'posix'

  switch (shellType) {
    case 'fish':
      return wrapCommandFish(command, markers, options)
    case 'powershell':
      return wrapCommandPowerShell(command, markers, options)
    default:
      return wrapCommandPosix(command, markers, options)
  }
}

function wrapCommandPosix(
  command: string,
  markers: MarkerPair,
  options?: CommandWrapOptions,
): string {
  const setupParts: string[] = []

  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (SHELL_ENV_KEY_RE.test(key)) {
        setupParts.push(`export ${key}=${shellQuote(value)}`)
      }
    }
  }
  if (options?.workingDirectory) {
    setupParts.push(`cd ${shellQuote(options.workingDirectory)}`)
  }

  const cmdLine =
    setupParts.length > 0 ? `${setupParts.join(' && ')} && ${command}` : command

  return (
    `echo "${markers.startMarker}"\n` +
    `${cmdLine}\n` +
    `echo "${markers.endMarkerPrefix}$?"$'\\x1F'"$(pwd)__"\n`
  )
}

function wrapCommandFish(
  command: string,
  markers: MarkerPair,
  options?: CommandWrapOptions,
): string {
  const setupParts: string[] = []

  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (SHELL_ENV_KEY_RE.test(key)) {
        setupParts.push(`set -x ${key} ${fishQuote(value)}`)
      }
    }
  }
  if (options?.workingDirectory) {
    setupParts.push(`cd ${fishQuote(options.workingDirectory)}`)
  }

  const cmdLine =
    setupParts.length > 0 ? `${setupParts.join('; and ')}; and ${command}` : command

  return (
    `echo "${markers.startMarker}"\n` +
    `${cmdLine}\n` +
    `echo "${markers.endMarkerPrefix}"$status"\\x1f"(pwd)"__"\n`
  )
}

function wrapCommandPowerShell(
  command: string,
  markers: MarkerPair,
  options?: CommandWrapOptions,
): string {
  const setupParts: string[] = []

  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (SHELL_ENV_KEY_RE.test(key)) {
        setupParts.push(`$env:${key} = ${pwshQuote(value)}`)
      }
    }
  }
  if (options?.workingDirectory) {
    setupParts.push(`Set-Location ${pwshQuote(options.workingDirectory)}`)
  }

  const setupPrefix = setupParts.length > 0 ? setupParts.join('; ') + '; ' : ''

  return (
    `Write-Host "${markers.startMarker}"\n` +
    `${setupPrefix}${command}\n` +
    `Write-Host "${markers.endMarkerPrefix}$LASTEXITCODE$([char]0x1F)$(Get-Location)__"\n`
  )
}

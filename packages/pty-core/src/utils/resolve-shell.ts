import { existsSync, accessSync, constants as fsConstants } from 'fs'
import { resolve as pathResolve } from 'path'

/**
 * Known safe shell paths on Unix-like systems.
 * Only shells in these directories are trusted when resolving $SHELL.
 */
const SAFE_SHELL_DIRS: readonly string[] = [
  '/bin',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/run/current-system/sw/bin', // NixOS
]

/**
 * Known safe shell basenames.
 */
const SAFE_SHELL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'zsh',
  'sh',
  'dash',
  'fish',
  'ksh',
  'tcsh',
  'csh',
])

/**
 * Known safe Windows shell paths (case-insensitive comparison).
 * Includes cmd.exe, PowerShell (Windows built-in), and pwsh (cross-platform PowerShell).
 */
const SAFE_WINDOWS_SHELL_PATHS: readonly string[] = [
  'C:\\Windows\\System32\\cmd.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
]

/**
 * Known safe Windows shell basenames (case-insensitive).
 */
const SAFE_WINDOWS_SHELL_NAMES: ReadonlySet<string> = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
])

/** Default fallback shell when no valid shell is found. */
const DEFAULT_SHELL = '/bin/sh'

/** Default fallback shell on Windows. */
const DEFAULT_WINDOWS_SHELL = 'powershell.exe'

/**
 * Fallback candidates tried in order when $SHELL is invalid.
 */
const FALLBACK_CANDIDATES = ['/bin/bash', '/bin/zsh', '/bin/sh']

/**
 * Windows fallback candidates tried in order.
 */
const WINDOWS_FALLBACK_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
]

function isPowerShellPath(shellPath: string): boolean {
  const basename = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return /^(pwsh|powershell)(\.exe)?$/.test(basename)
}

/**
 * Checks whether a given path is a valid, executable Windows shell.
 *
 * Validates:
 * 1. File exists
 * 2. File is executable
 * 3. Path matches known safe Windows shell paths or basenames
 */
function isValidWindowsShell(shellPath: string): boolean {
  const resolved = pathResolve(shellPath)

  // Check existence
  if (!existsSync(resolved)) return false

  // Check executable permission
  try {
    accessSync(resolved, fsConstants.X_OK)
  } catch {
    return false
  }

  // Check against known safe paths (case-insensitive)
  const resolvedLower = resolved.toLowerCase()
  if (SAFE_WINDOWS_SHELL_PATHS.some(p => resolvedLower === p.toLowerCase())) return true

  // Check basename against known safe names (case-insensitive)
  const basename = resolved.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (SAFE_WINDOWS_SHELL_NAMES.has(basename)) {
    // Additional safety: must be under a system directory
    if (resolvedLower.startsWith('c:\\windows\\') || resolvedLower.startsWith('c:\\program files')) {
      return true
    }
  }

  return false
}

/**
 * Checks whether a given path is a valid, executable shell in a safe location.
 *
 * Validates:
 * 1. Path is absolute (no relative path tricks)
 * 2. File exists
 * 3. File is executable by the current user
 * 4. File resides in a known safe directory
 * 5. Basename matches a known shell name
 */
function isValidShell(shellPath: string): boolean {
  // Must be absolute path
  if (!shellPath.startsWith('/')) return false

  // Resolve to canonical form (handles .. traversal)
  const resolved = pathResolve(shellPath)

  // Check existence
  if (!existsSync(resolved)) return false

  // Check executable permission
  try {
    accessSync(resolved, fsConstants.X_OK)
  } catch {
    return false
  }

  // Extract directory and basename
  const lastSlash = resolved.lastIndexOf('/')
  const dir = resolved.substring(0, lastSlash)
  const basename = resolved.substring(lastSlash + 1)

  // Must be in a safe directory
  if (!SAFE_SHELL_DIRS.includes(dir)) return false

  // Must be a known shell name
  if (!SAFE_SHELL_NAMES.has(basename)) return false

  return true
}

/**
 * Resolves the shell executable for a PTY session.
 *
 * On Windows, prefers PowerShell and only falls back to ComSpec as a last resort.
 * On Unix, prefers $SHELL if it passes safety validation, then tries
 * fallback candidates (/bin/bash, /bin/zsh, /bin/sh).
 *
 * Safety validations for $SHELL:
 * - Must be an absolute path
 * - Must exist and be executable
 * - Must reside in a known safe directory (/bin, /usr/bin, /usr/local/bin, etc.)
 * - Must have a recognized shell basename (bash, zsh, sh, fish, etc.)
 */
export function resolveShell(): string {
  if (process.platform === 'win32') {
    // Prefer PowerShell on Windows because the marker wrapper has explicit
    // PowerShell syntax; ComSpec is usually cmd.exe and cannot run it.
    for (const candidate of WINDOWS_FALLBACK_CANDIDATES) {
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, fsConstants.X_OK)
          return candidate
        } catch {
          continue
        }
      }
    }

    // Last resort: allow ComSpec only if it points at a PowerShell variant.
    const comSpec = process.env.ComSpec
    if (comSpec && isPowerShellPath(comSpec) && isValidWindowsShell(comSpec)) {
      return comSpec
    }

    return DEFAULT_WINDOWS_SHELL
  }

  // Unix: try $SHELL with full safety validation
  const envShell = process.env.SHELL
  if (envShell && isValidShell(envShell)) {
    return envShell
  }

  // Fallback: try known safe paths
  for (const candidate of FALLBACK_CANDIDATES) {
    if (existsSync(candidate)) {
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }

  return DEFAULT_SHELL
}

/** Exposed for testing. */
export {
  isValidShell,
  isValidWindowsShell,
  SAFE_SHELL_DIRS,
  SAFE_SHELL_NAMES,
  SAFE_WINDOWS_SHELL_PATHS,
  SAFE_WINDOWS_SHELL_NAMES,
  WINDOWS_FALLBACK_CANDIDATES,
  DEFAULT_SHELL,
  DEFAULT_WINDOWS_SHELL,
}

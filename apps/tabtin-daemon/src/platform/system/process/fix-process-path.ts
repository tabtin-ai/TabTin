/**
 * fix-process-path - daemon `start` entry repairs `process.env.PATH` so that
 * later tool calls (grep_search via @vscode/ripgrep / run_terminal_command via
 * ShellCap) can find binaries in the user's brew/nvm/pyenv/cargo bins.
 *
 * Why needed:
 *   - macOS launchd starts daemon with PATH baked into the plist at install
 *     time; if the user later updates shell rc to add nvm/cargo/pyenv, the
 *     daemon does not pick those up until uninstall+reinstall.
 *   - Linux systemd default PATH is minimal
 *     (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin) and lacks
 *     ~/.cargo/bin, ~/.nvm/.../bin, ~/.pyenv/shims, etc.
 *   - In daemon CLI mode (started from user shell), PATH is already complete;
 *     this function is a near no-op there but keeps service vs CLI behavior
 *     consistent so we don't see "CLI works / service breaks".
 *
 * Strategy (descending priority, first match wins):
 *
 *   1. fix-path (preferred): runs the user default shell `zsh -ilc 'echo $PATH'`
 *      to read real PATH. But under systemd/launchd, the SHELL env var may be
 *      unset, in which case shell-path falls back to /bin/sh which does not
 *      read user rc files. We proactively read /etc/passwd to set SHELL before
 *      calling fix-path.
 *
 *   2. Hardcoded fallback: if fix-path fails or the resulting PATH is still
 *      short, prepend /opt/homebrew/bin (macOS arm64) + /usr/local/bin (macOS
 *      x64 + Linux universal) + ~/.cargo/bin + ~/.nvm/versions/node/X/bin +
 *      ~/.pyenv/shims (when present). This is the community-common "daemon
 *      universal PATH fallback" combo.
 *
 * Failure never blocks daemon startup: function try/catches everything and at
 * worst keeps the original PATH and prints a warn. The daemon is a 24/7
 * process, PATH repair failure must never prevent it from starting; better to
 * let LLM tool calls fail and let the user investigate than have the daemon
 * itself fail.
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

interface FixProcessPathOptions {
  /**
   * Logger injected by the caller. daemon uses console (logs go to
   * stdout/stderr files via the service manager). Tests can inject a stub.
   */
  log?: (level: 'info' | 'warn', msg: string) => void
}

const DEFAULT_LOG = (level: 'info' | 'warn', msg: string) => {
  if (level === 'warn') console.warn(`[fix-process-path] ${msg}`)
  else console.info(`[fix-process-path] ${msg}`)
}

/**
 * Detect the current user's default shell.
 *
 * /etc/passwd is the source of truth on macOS/Linux POSIX, but actual user
 * shell may also be managed by directory service (macOS dscl, enterprise
 * Linux SSSD). We try /etc/passwd first, fall back to process.env.SHELL,
 * then default to /bin/sh.
 */
function detectUserShell(): string {
  const envShell = (process.env.SHELL || '').trim()
  if (envShell) return envShell

  if (process.platform !== 'win32') {
    try {
      const passwd = fs.readFileSync('/etc/passwd', 'utf8')
      const username = os.userInfo().username
      for (const line of passwd.split('\n')) {
        const [user, , , , , , shell] = line.split(':')
        if (user === username && shell) return shell.trim()
      }
    } catch {
      // /etc/passwd unreadable or user not found in it
    }
  }

  return '/bin/sh'
}

/**
 * Collect candidate "user tool binary directories". Existing dirs prepend
 * to PATH.
 *
 * Order: hardcoded common dirs, then heuristic scan for ~/.nvm/versions/
 * node/X/bin (latest versions). The latter does a readdir but only on
 * fallback path.
 */
function collectUserBinDirs(): string[] {
  const home = os.homedir()
  const candidates: string[] = []

  // macOS Homebrew (by arch)
  if (process.platform === 'darwin') {
    candidates.push(process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin')
  }

  // Cross-platform commons
  candidates.push(
    '/usr/local/bin',
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.pyenv', 'shims'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'go', 'bin'),
  )

  // nvm: ~/.nvm/versions/node/<latest>/bin (top 3 versions, newest first)
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmRoot)) {
      const versions = fs.readdirSync(nvmRoot).filter(v => v.startsWith('v'))
      versions.sort().reverse()
      for (const v of versions.slice(0, 3)) {
        candidates.push(path.join(nvmRoot, v, 'bin'))
      }
    }
  } catch {
    // silent
  }

  return candidates.filter(p => {
    try { return fs.statSync(p).isDirectory() } catch { return false }
  })
}

/**
 * Prepend candidate dirs to current PATH, dedup while preserving order
 * (earlier wins).
 */
function prependBinDirs(currentPath: string, dirs: string[]): string {
  const existing = new Set((currentPath || '').split(path.delimiter).filter(Boolean))
  const additions: string[] = []
  for (const d of dirs) {
    if (!existing.has(d)) {
      additions.push(d)
      existing.add(d)
    }
  }
  if (additions.length === 0) return currentPath
  return [...additions, currentPath].filter(Boolean).join(path.delimiter)
}

function runFixPath(): unknown {
  try {
    const requireFromHere = createRequire(import.meta.url)
    const mod = requireFromHere('fix-path') as { default?: () => void } | (() => void)
    const fixPath = typeof mod === 'function' ? mod : mod.default
    if (typeof fixPath !== 'function') throw new Error('fix-path module shape unexpected')
    fixPath()
    return undefined
  } catch (error) {
    return error
  }
}

function applyFallbackPath(
  before: string,
  after: string,
  detectedShell: string,
  error: unknown,
  log: (level: 'info' | 'warn', msg: string) => void,
) {
  const userBins = collectUserBinDirs()
  const fallbackPath = prependBinDirs(after, userBins)
  process.env.PATH = fallbackPath
  if (error) {
    const message = (error as Error).message?.slice(0, 120) || 'unknown'
    log('warn', `fix-path failed (${message}); fallback to hardcoded user bin dirs`)
  } else {
    log('info', `fix-path did not change PATH (SHELL=${detectedShell} may not read rc); fallback added ${userBins.length} user bin dirs`)
  }
  return {
    before,
    after: fallbackPath,
    source: 'fallback' as const,
    message: `fallback prepended ${userBins.length} dirs`,
  }
}

/**
 * Public entry. Synchronous (fix-path uses spawnSync). After return,
 * process.env.PATH is updated.
 */
export function fixProcessPath(opts: FixProcessPathOptions = {}): {
  before: string
  after: string
  source: 'fix-path' | 'fallback' | 'unchanged' | 'noop-windows'
  message: string
} {
  const log = opts.log ?? DEFAULT_LOG
  const before = process.env.PATH || ''

  // Windows: fix-path 5.x is a no-op; daemon PATH is managed by SCM/user env
  if (process.platform === 'win32') {
    return {
      before,
      after: before,
      source: 'noop-windows',
      message: 'Windows: noop (relies on SCM PATH injection)',
    }
  }

  // 1) Set SHELL so fix-path runs the right shell to read user rc
  const detectedShell = detectUserShell()
  if (!process.env.SHELL || process.env.SHELL === '/bin/sh') {
    process.env.SHELL = detectedShell
  }

  // 2) Try fix-path
  // Use createRequire so we work in pure ESM (where global `require` is
  // undefined). fix-path is a CJS-style default-export ESM module; its
  // `default` is the function. We use sync require because spawnSync inside
  // shell-path is the real bottleneck; we don't need async here.
  const fixPathErr = runFixPath()

  // 3) If fix-path did not change PATH (or threw), fall back to hardcoded
  let after = process.env.PATH || ''
  if (after === before || fixPathErr) {
    return applyFallbackPath(before, after, detectedShell, fixPathErr, log)
  }

  log(
    'info',
    `fix-path injected user shell PATH (${after.split(path.delimiter).length} segments)`,
  )

  // Also merge user bin (in case shell rc forgot some paths)
  const userBins = collectUserBinDirs()
  const merged = prependBinDirs(after, userBins)
  if (merged !== after) {
    process.env.PATH = merged
  }

  return {
    before,
    after: merged,
    source: 'fix-path',
    message: `fix-path injected + merged ${userBins.length} user bin dirs`,
  }
}

// Test-only exports
export const __test = {
  detectUserShell,
  collectUserBinDirs,
  prependBinDirs,
}

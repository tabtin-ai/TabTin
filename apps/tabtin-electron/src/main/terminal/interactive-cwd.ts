import fs from 'node:fs'
import path from 'node:path'

export type ReachableTerminalCwdFallbackReason = 'missing' | 'not_a_directory'
export type InteractiveTerminalCwdFallbackReason = ReachableTerminalCwdFallbackReason

export interface ReachableTerminalCwdResolution {
  cwd?: string
  fallbackFrom?: string
  fallbackReason?: ReachableTerminalCwdFallbackReason
}
export type InteractiveTerminalCwdResolution = ReachableTerminalCwdResolution

function directoryProblem(cwd: string): ReachableTerminalCwdFallbackReason | null {
  try {
    const stat = fs.statSync(cwd)
    return stat.isDirectory() ? null : 'not_a_directory'
  } catch {
    return 'missing'
  }
}

/**
 * Resolve a cwd before handing it to terminal process creation.
 *
 * A stale Space working_dir should not be handed to PTY spawn: on Windows it
 * creates a terminal pane that immediately exits, which looks like the terminal
 * app is broken. Fall back to the user's home directory instead.
 */
export function resolveReachableTerminalCwd(
  rawCwd: unknown,
  homeDir: string | undefined,
): ReachableTerminalCwdResolution {
  const home = typeof homeDir === 'string' && homeDir.length > 0 ? homeDir : undefined

  if (typeof rawCwd !== 'string' || rawCwd.length === 0) {
    return { cwd: home }
  }

  const resolved = path.resolve(rawCwd)
  if (resolved.includes('\0')) {
    throw new Error('Invalid parameter: cwd contains null bytes')
  }

  const problem = directoryProblem(resolved)
  if (!problem) {
    return { cwd: resolved }
  }

  return {
    cwd: home,
    fallbackFrom: resolved,
    fallbackReason: problem,
  }
}

export const resolveInteractiveTerminalCwd = resolveReachableTerminalCwd

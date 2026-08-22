import { existsSync, statSync } from 'fs'
import os from 'os'

function isValidDirectory(value?: string): value is string {
  if (!value) return false
  try {
    return existsSync(value) && statSync(value).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolves the working directory for a PTY session.
 * Falls back through: preferred → workspaceRoot → TABTIN_WORKSPACE_ROOT → cwd → homedir.
 */
export function resolveCwd(preferred?: string, workspaceRoot?: string): string {
  if (isValidDirectory(preferred)) return preferred
  if (isValidDirectory(workspaceRoot)) return workspaceRoot
  const fromEnv = process.env.TABTIN_WORKSPACE_ROOT
  if (isValidDirectory(fromEnv)) return fromEnv
  const current = process.cwd()
  if (isValidDirectory(current)) return current
  return os.homedir()
}

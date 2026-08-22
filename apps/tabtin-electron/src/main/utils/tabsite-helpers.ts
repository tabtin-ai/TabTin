/**
 * Shared utilities for TabSite module — used by both IPC handlers and CLI route.
 * Delegates to @tabtin/tabsite-core for platform-independent logic,
 * adds Electron-specific template path resolution.
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  copyDirSafe as coreCopyDirSafe,
  hasValidTokenInEnvFile as coreHasValidTokenInEnvFile,
  provisionTokenAndWriteEnv as coreProvisionTokenAndWriteEnv,
  fixWorkspaceDeps as coreFixWorkspaceDeps,
  resolveTemplatePath as coreResolveTemplatePath,
} from '@tabtin/tabsite-core'
import type { ProvisionResult, ProvisionOptions, CopyDirOptions } from '@tabtin/tabsite-core'
import { djangoRequest } from '../cli/routes/shared/error-handler'

export type { ProvisionResult, ProvisionOptions, CopyDirOptions }

export const hasValidTokenInEnvFile = coreHasValidTokenInEnvFile
export const copyDirSafe = coreCopyDirSafe
export const fixWorkspaceDeps = coreFixWorkspaceDeps

export async function provisionTokenAndWriteEnv(
  siteId: string,
  projectPath: string,
  options?: ProvisionOptions,
): Promise<ProvisionResult> {
  return coreProvisionTokenAndWriteEnv(siteId, projectPath, djangoRequest, options)
}

/**
 * Electron-specific template path resolution.
 * Searches: extraResources → cwd/packages → ancestor directories.
 */
const ALLOWED_TEMPLATE_PATTERN = /^[a-zA-Z0-9_-]+$/

export function resolveTemplatePath(templateName: string): string | null {
  if (!templateName || !ALLOWED_TEMPLATE_PATTERN.test(templateName)) {
    return null
  }

  const searchPaths = [
    path.join(process.resourcesPath ?? app.getAppPath(), 'tabsite-templates'),
    path.join(process.cwd(), 'packages', 'tabsite-templates'),
  ]

  let dir = app.getAppPath()
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    const candidate = path.join(dir, 'packages', 'tabsite-templates')
    if (!searchPaths.includes(candidate)) {
      searchPaths.push(candidate)
    }
    if (fs.existsSync(path.join(dir, 'packages'))) break
  }

  return coreResolveTemplatePath(templateName, searchPaths)
}

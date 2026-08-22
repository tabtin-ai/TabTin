#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function inspectTree(root, current, entries) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name)
    const stat = fs.lstatSync(entryPath)
    entries.push({
      path: entryPath,
      relative: path.relative(root, entryPath),
      isDirectory: stat.isDirectory(),
      isLink: stat.isSymbolicLink(),
    })
    if (stat.isDirectory() && !stat.isSymbolicLink()) inspectTree(root, entryPath, entries)
  }
}

function classifyEntry(entry, expectedDeployParts, allowPreviousRuns) {
  const parts = entry.relative.split(path.sep)
  if (entry.isLink || parts[0] !== 'tabtin-electron') return { allowed: false }
  if (parts.length === 1) return { allowed: entry.isDirectory }
  let deployParts = expectedDeployParts
  if (allowPreviousRuns) {
    if (parts[1] !== '.deploy-runs') return { allowed: false }
    if (parts.length === 2) return { allowed: entry.isDirectory }
    deployParts = ['.deploy-runs', parts[2]]
  }
  const deployEnd = 1 + deployParts.length
  const comparedPartCount = Math.min(parts.length - 1, deployParts.length)
  for (let index = 0; index < comparedPartCount; index += 1) {
    if (parts[index + 1] !== deployParts[index]) return { allowed: false }
  }
  if (parts.length <= deployEnd) {
    return { allowed: entry.isDirectory, runName: deployParts.join('/') }
  }
  const runName = deployParts.join('/')
  if (parts[deployEnd] !== 'node_modules') return { allowed: false }
  if (parts.length === deployEnd + 1) return { allowed: entry.isDirectory, runName }
  if (parts[deployEnd + 1] !== '.bin') return { allowed: false }
  if (parts.length === deployEnd + 2) {
    return { allowed: entry.isDirectory, runName, binRoot: entry.path }
  }
  return { allowed: true, runName }
}

function removeAllowedTrees(duplicateRoot, entries, binRoots) {
  for (const binRoot of binRoots) {
    fs.rmSync(binRoot, { recursive: true, force: true })
  }
  const directories = entries
    .filter((entry) => entry.isDirectory)
    .sort((left, right) => right.path.length - left.path.length)
  for (const directory of directories) {
    try {
      fs.rmdirSync(directory.path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(
        `pnpm deploy debris changed while cleaning; preserved ${duplicateRoot}: ${error.message}`,
      )
    }
  }
  fs.rmdirSync(duplicateRoot)
}

/**
 * pnpm legacy deploy can apply its workspace-relative modulesDir to the selected
 * project twice (/#8875 upstream). On Windows this leaves only a mirrored
 * node_modules/.bin tree under apps/tabtin-electron/apps/tabtin-electron.
 *
 * Remove that known-safe tree, but fail closed if pnpm wrote anything else.
 */
export function cleanupPnpmDeployDebris(
  appDir,
  deployDir,
  { allowPreviousRuns = false } = {},
) {
  const duplicateRoot = path.join(appDir, 'apps')
  if (!fs.existsSync(duplicateRoot)) return { removed: false, fileCount: 0 }
  const duplicateRootStat = fs.lstatSync(duplicateRoot)
  if (!duplicateRootStat.isDirectory() || duplicateRootStat.isSymbolicLink()) {
    throw new Error(
      `pnpm deploy debris root must be a real directory, not a link: ${duplicateRoot}`,
    )
  }

  const deployRelative = path.relative(appDir, deployDir)
  if (!deployRelative || deployRelative.startsWith('..') || path.isAbsolute(deployRelative)) {
    throw new Error(`deploy directory must be inside app directory: ${deployDir}`)
  }
  const expectedDeployParts = deployRelative.split(path.sep)
  const entries = []
  inspectTree(duplicateRoot, duplicateRoot, entries)
  const classified = entries.map((entry) => ({
    entry,
    classification: classifyEntry(entry, expectedDeployParts, allowPreviousRuns),
  }))
  const unexpected = classified.filter(({ classification }) => !classification.allowed)
  if (unexpected.length > 0) {
    throw new Error(
      `unexpected pnpm deploy debris; refusing to remove ${duplicateRoot}:\n`
        + unexpected.slice(0, 20).map(({ entry }) => `- ${entry.relative}`).join('\n'),
    )
  }

  const runNames = new Set(
    classified.map(({ classification }) => classification.runName).filter(Boolean),
  )
  const binRootsByRun = new Map()
  for (const { classification } of classified) {
    if (classification.binRoot) {
      binRootsByRun.set(classification.runName, classification.binRoot)
    }
  }
  const missingBinRuns = [...runNames].filter((runName) => !binRootsByRun.has(runName))
  if (runNames.size === 0 || missingBinRuns.length > 0) {
    throw new Error(
      `missing expected pnpm duplicate .bin directory under ${duplicateRoot}`
        + (missingBinRuns.length > 0 ? ` for run(s): ${missingBinRuns.join(', ')}` : ''),
    )
  }

  const fileCount = entries.filter((entry) => !entry.isDirectory).length
  removeAllowedTrees(duplicateRoot, entries, binRootsByRun.values())
  return { removed: true, fileCount }
}

function main() {
  const [appDir, deployDir, mode] = process.argv.slice(2)
  if (!appDir || !deployDir) {
    console.error(
      'Usage: node cleanup-pnpm-deploy-debris.mjs <app-dir> <deploy-dir> [--previous-runs]',
    )
    process.exitCode = 2
    return
  }
  if (mode && mode !== '--previous-runs') {
    console.error(`Unknown option: ${mode}`)
    process.exitCode = 2
    return
  }
  const result = cleanupPnpmDeployDebris(
    path.resolve(appDir),
    path.resolve(deployDir),
    { allowPreviousRuns: mode === '--previous-runs' },
  )
  if (result.removed) {
    console.log(
      `  · removed known pnpm legacy deploy duplicate .bin tree (${result.fileCount} files; upstream /#8875)`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()

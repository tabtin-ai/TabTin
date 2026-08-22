#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function walkLinks(root, current, links) {
  let entries
  try {
    entries = fs.readdirSync(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name)
    let stat
    try {
      stat = fs.lstatSync(entryPath)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      let target = null
      let directTarget = null
      try {
        const rawTarget = fs.readlinkSync(entryPath)
        directTarget = path.resolve(path.dirname(entryPath), rawTarget)
        target = fs.realpathSync(entryPath)
      } catch {
        // Broken links are returned so the caller fails fast.
      }
      if (target === null || !isInside(root, target)) links.push({ path: entryPath, directTarget, target })
      continue
    }
    if (stat.isDirectory()) walkLinks(root, entryPath, links)
  }
}

export function findExternalLinks(deployDir) {
  const root = fs.realpathSync(deployDir)
  const links = []
  walkLinks(root, path.join(root, 'node_modules'), links)
  return links
}

function isStrictAncestor(ancestor, descendant) {
  const root = path.resolve(ancestor)
  const child = path.resolve(descendant)
  return root !== child && isInside(root, child)
}

function copyExternalTarget(source, destination) {
  const sourceRoot = fs.realpathSync(source)
  // Destination lives under source (e.g. deploy under apps/tabtin-electron while a
  // link points back at the app root). Node refuses this with ERR_FS_CP_EINVAL.
  if (isStrictAncestor(sourceRoot, destination)) {
    throw new Error(
      `cannot materialize dependency link into a subdirectory of its target:\n`
        + `  source: ${sourceRoot}\n`
        + `  destination: ${destination}`,
    )
  }
  fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(sourceRoot, destination, {
    recursive: true,
    dereference: false,
    filter(candidate) {
      if (candidate === sourceRoot) return true
      const parts = path.relative(sourceRoot, candidate).split(path.sep)
      return !parts.some((part) => part === 'node_modules' || part === '.git')
    },
  })
}

function existsWithoutFollowing(candidate) {
  try {
    fs.lstatSync(candidate)
    return true
  } catch {
    return false
  }
}

function ensureTabtinHoists(deployDir) {
  const pnpmDir = path.join(deployDir, 'node_modules', '.pnpm')
  const topScope = path.join(deployDir, 'node_modules', '@tabtin')
  const hoisted = []
  let pnpmEntries = []
  try {
    pnpmEntries = fs.readdirSync(pnpmDir)
  } catch {
    return hoisted
  }
  fs.mkdirSync(topScope, { recursive: true })
  for (const pnpmEntry of pnpmEntries.sort()) {
    const innerScope = path.join(pnpmDir, pnpmEntry, 'node_modules', '@tabtin')
    let packages = []
    try {
      packages = fs.readdirSync(innerScope, { withFileTypes: true })
    } catch {
      continue
    }
    for (const pkg of packages) {
      if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue
      const topPackage = path.join(topScope, pkg.name)
      if (existsWithoutFollowing(topPackage)) continue
      const innerPackage = path.join(innerScope, pkg.name)
      fs.symlinkSync(
        process.platform === 'win32'
          ? innerPackage
          : path.relative(path.dirname(topPackage), innerPackage),
        topPackage,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      hoisted.push(topPackage)
    }
  }
  return hoisted
}

/** Files electron-builder historically followed out of deploy . */
export const CRITICAL_PACKAGED_FILES = [
  path.join('node_modules', '@tabtin', 'action-tools', 'dist', 'adapters', 'public.js'),
]

export function assertCriticalFilesInsideDeploy(
  deployDir,
  files = CRITICAL_PACKAGED_FILES,
) {
  const root = fs.realpathSync(deployDir)
  const failures = []
  for (const rel of files) {
    const parts = rel.split(path.sep)
    // node_modules/@scope/name/... → package root is the first three segments.
    const packageDir = path.join(root, ...parts.slice(0, Math.min(3, parts.length)))
    if (!existsWithoutFollowing(packageDir)) continue

    const candidate = path.join(root, rel)
    let real
    try {
      real = fs.realpathSync(candidate)
    } catch {
      failures.push(`${rel} (missing or unreadable)`)
      continue
    }
    if (!isInside(root, real)) {
      failures.push(`${rel} -> ${real}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `deploy critical files escape deploy root (asar will fail with must be under):\n`
        + failures.map((item) => `- ${item}`).join('\n'),
    )
  }
}

export function ensureDeploySelfContained(deployDir) {
  const root = fs.realpathSync(deployDir)
  const materialized = []
  const dropped = []
  const hoisted = ensureTabtinHoists(root)
  for (let pass = 0; pass < 10; pass += 1) {
    const external = findExternalLinks(root)
    if (external.length === 0) {
      assertCriticalFilesInsideDeploy(root)
      return { hoisted, materialized, dropped }
    }
    const directExternal = external.filter(
      (link) => link.directTarget === null || !isInside(root, link.directTarget),
    )
    if (directExternal.length === 0) {
      throw new Error(
        `deploy contains indirect external or broken dependency links:\n${external
          .map((link) => `- ${link.path} -> ${link.target ?? '<broken>'}`)
          .join('\n')}`,
      )
    }
    for (const link of directExternal) {
      if (link.target === null) {
        throw new Error(`deploy contains a broken dependency link: ${link.path}`)
      }
      // pnpm may leave apps/tabtin-electron -> .pnpm/node_modules/tabtin-electron while
      // deploy itself lives under that app root. Copying would recurse into self; drop.
      if (isStrictAncestor(link.target, root) || isStrictAncestor(link.target, link.path)) {
        fs.rmSync(link.path, { recursive: true, force: true })
        dropped.push({ path: link.path, source: link.target })
        continue
      }
      copyExternalTarget(link.target, link.path)
      materialized.push({ path: link.path, source: link.target })
    }
  }
  const remaining = findExternalLinks(root)
  throw new Error(
    `deploy still contains external dependency links after materialization:\n${remaining
      .map((link) => `- ${link.path} -> ${link.target ?? '<broken>'}`)
      .join('\n')}`,
  )
}

function main() {
  const deployDir = process.argv[2]
  if (!deployDir) {
    console.error('Usage: node ensure-deploy-self-contained.mjs <deploy-dir>')
    process.exitCode = 2
    return
  }
  const result = ensureDeploySelfContained(deployDir)
  for (const item of result.hoisted) {
    console.log(`  · restored workspace hoist: ${path.relative(deployDir, item)}`)
  }
  for (const item of result.materialized) {
    console.log(`  · materialized external dependency: ${path.relative(deployDir, item.path)}`)
  }
  for (const item of result.dropped) {
    console.log(
      `  · dropped self-ancestor dependency link: ${path.relative(deployDir, item.path)}`
        + ` -> ${item.source}`,
    )
  }
  console.log(
    `  · deploy dependency links are self-contained (${result.hoisted.length} hoisted, `
      + `${result.materialized.length} materialized, ${result.dropped.length} dropped)`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()

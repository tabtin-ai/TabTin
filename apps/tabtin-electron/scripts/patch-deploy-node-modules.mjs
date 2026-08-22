#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join, relative } from 'node:path'

const deployDir = process.argv[2]

if (!deployDir) {
  console.error('Usage: patch-deploy-node-modules.mjs <deploy-dir>')
  process.exit(1)
}

const nodeModulesDir = join(deployDir, 'node_modules')
const pnpmDir = join(nodeModulesDir, '.pnpm')
const deployReal = realpathSync(deployDir)

function isUnderDeploy(candidate) {
  return candidate === deployReal || candidate.startsWith(`${deployReal}/`)
}

function safeRealpath(filePath) {
  try {
    return realpathSync(filePath)
  } catch {
    return null
  }
}

function safeLstat(filePath) {
  try {
    return lstatSync(filePath)
  } catch {
    return null
  }
}

function patchWorkspaceHoist() {
  const deployAtDir = join(nodeModulesDir, '@tabtin')
  if (!existsSync(pnpmDir)) return
  mkdirSync(deployAtDir, { recursive: true })

  let patched = 0
  for (const pnpmEntry of readdirSync(pnpmDir)) {
    if (!pnpmEntry.startsWith('@tabtin+')) continue

    const tabtinDir = join(pnpmDir, pnpmEntry, 'node_modules', '@tabtin')
    if (!existsSync(tabtinDir)) continue

    for (const pkgName of readdirSync(tabtinDir)) {
      const pnpmInner = join(tabtinDir, pkgName)
      if (!existsSync(pnpmInner)) continue

      const topLink = join(deployAtDir, pkgName)
      const resolved = safeRealpath(topLink)
      if (resolved && isUnderDeploy(resolved)) continue

      const stat = safeLstat(topLink)
      if (stat) {
        rmSync(topLink, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true })
      }

      symlinkSync(relative(deployAtDir, pnpmInner), topLink)
      patched += 1
    }
  }

  if (patched > 0) {
    console.log(`  · @tabtin hoist 修正: ${patched} 个入口`)
  }
}

function semverMajor(version) {
  return Number.parseInt(String(version).match(/\d+/)?.[0] ?? '0', 10)
}

function listJsdomInstances() {
  const out = []

  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'jsdom') {
        const pkg = join(full, 'package.json')
        if (existsSync(pkg)) out.push(full)
      } else if (entry.name === 'node_modules' || entry.name.startsWith('@') || entry.name.startsWith('.pnpm')) {
        walk(full)
      } else if (dir.endsWith('node_modules')) {
        walk(join(full, 'node_modules'))
      }
    }
  }

  walk(nodeModulesDir)
  return out
}

function listWhatwgUrlVersions() {
  if (!existsSync(pnpmDir)) return []
  return readdirSync(pnpmDir)
    .filter(entry => entry.startsWith('whatwg-url@'))
    .map((entry) => {
      const version = entry.slice('whatwg-url@'.length).split('_')[0]
      return { dir: join(pnpmDir, entry, 'node_modules', 'whatwg-url'), version }
    })
    .filter(({ dir }) => existsSync(dir))
}

function pickBestMatch(range, available) {
  const wantedMajor = semverMajor(range)
  const candidates = available
    .filter(({ version }) => semverMajor(version) === wantedMajor)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))

  return candidates.at(-1) ?? null
}

function patchJsdomWhatwgUrl() {
  const jsdomInstances = listJsdomInstances()
  const whatwgVersions = listWhatwgUrlVersions()
  let patched = 0

  for (const jsdomDir of jsdomInstances) {
    const pkg = JSON.parse(readFileSync(join(jsdomDir, 'package.json'), 'utf8'))
    const range = pkg.dependencies?.['whatwg-url']
    if (!range) continue

    const nestedDir = join(jsdomDir, 'node_modules', 'whatwg-url')
    if (existsSync(nestedDir)) {
      try {
        const nestedPkg = JSON.parse(readFileSync(join(nestedDir, 'package.json'), 'utf8'))
        if (semverMajor(nestedPkg.version) === semverMajor(range)) continue
      } catch {
        // Broken nested dependency; replace it below.
      }
    }

    const match = pickBestMatch(range, whatwgVersions)
    if (!match) {
      console.warn(`  ⚠ ${jsdomDir} 期望 whatwg-url ${range}，但 .pnpm 里没找到匹配版本`)
      continue
    }

    mkdirSync(join(jsdomDir, 'node_modules'), { recursive: true })
    rmSync(nestedDir, { recursive: true, force: true })
    cpSync(match.dir, nestedDir, { recursive: true })
    patched += 1
  }

  if (patched > 0) {
    console.log(`  · jsdom nested whatwg-url 修正: ${patched} 个实例`)
  }
}

function main() {
  if (!existsSync(nodeModulesDir)) {
    console.error(`node_modules 不存在: ${nodeModulesDir}`)
    process.exit(1)
  }

  patchWorkspaceHoist()
  patchJsdomWhatwgUrl()

  // Keep a cheap sanity check close to the patching logic: this catches broken
  // symlinks before electron-builder follows them into the source worktree.
  execFileSync('node', ['-e', 'for (const id of ["ajv", "ajv-formats", "jsdom", "ws"]) require.resolve(id)'], {
    cwd: deployDir,
    stdio: 'pipe',
  })
}

main()

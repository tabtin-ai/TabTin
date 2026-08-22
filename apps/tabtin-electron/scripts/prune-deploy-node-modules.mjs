#!/usr/bin/env node
/**
 * Targeted prune of a pnpm-deploy node_modules tree before electron-builder.
 * Replaces dozens of full-tree `find` walks in build-packaged-app.sh that
 * dominate Windows pack time ().
 *
 * Usage:
 *   node prune-deploy-node-modules.mjs <deployDir> --runtime win32 --arch x64 [--deep]
 *
 * Default = correctness prune (wrong-arch natives, node-pty junk, stamps).
 * --deep = also delete docs/types/tests (usually redundant with build.files).
 */

import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

function parseArgs(argv) {
  const positional = []
  const flags = { deep: false, runtime: '', arch: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--deep') {
      flags.deep = true
      continue
    }
    if (arg === '--runtime' || arg === '--arch') {
      const key = arg.slice(2)
      flags[key] = String(argv[++i] || '')
      continue
    }
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`)
    positional.push(arg)
  }
  return { deployDir: positional[0], ...flags }
}

function rm(path) {
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function norm(path) {
  return path.split(sep).join('/')
}

/** Depth-first walk of directories (skips symlink dirs). */
function forEachDir(root, visit) {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const full = join(current, entry.name)
      if (visit(full, entry.name) !== false) stack.push(full)
    }
  }
}

function forEachFile(root, visit) {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.isFile()) visit(full, entry.name)
    }
  }
}

function removeScopedPackage(nm, scope, name) {
  let removed = 0
  if (rm(join(nm, scope, name))) removed += 1

  const pnpmRoot = join(nm, '.pnpm')
  if (existsSync(pnpmRoot)) {
    const encoded = `${scope.slice(1)}+${name}@`
    for (const entry of readdirSync(pnpmRoot)) {
      if (entry.startsWith(encoded) && rm(join(pnpmRoot, entry))) removed += 1
    }
  }

  const suffix = `/node_modules/${scope}/${name}`
  forEachDir(nm, (dir) => {
    if (norm(dir).endsWith(suffix)) {
      if (rm(dir)) removed += 1
      return false
    }
    return true
  })
  return removed
}

function pruneOnnxruntimeBinaries(nm, runtime, arch) {
  const keep = `${runtime}/${arch}`
  let removed = 0
  forEachDir(nm, (dir, base) => {
    if (!['arm64', 'x64', 'ia32'].includes(base)) return true
    const platform = basename(dirname(dir))
    if (!['darwin', 'linux', 'win32'].includes(platform)) return true
    const napi = basename(dirname(dirname(dir)))
    if (!napi.startsWith('napi-')) return true
    if (!norm(dir).includes('/onnxruntime-node/bin/')) return true
    if (`${platform}/${base}` !== keep) {
      if (rm(dir)) removed += 1
      return false
    }
    return true
  })
  return removed
}

function pruneNodePtyPrebuilds(nm, triplet) {
  let removed = 0
  forEachDir(nm, (dir, base) => {
    if (basename(dirname(dir)) !== 'prebuilds') return true
    if (!norm(dir).includes('/node-pty/prebuilds/')) return true
    if (!base.startsWith(triplet)) {
      if (rm(dir)) removed += 1
      return false
    }
    return true
  })
  return removed
}

/**
 * Remove platform package dirs whose basename starts with `barePrefix` but not
 * `keepPrefix`. Only deletes directories that look like package roots (have package.json).
 */
function prunePrefixedPackages(nm, barePrefix, keepPrefix, { skipPrefix } = {}) {
  let removed = 0
  forEachDir(nm, (dir, base) => {
    if (!base.startsWith(barePrefix)) return true
    if (skipPrefix && base.startsWith(skipPrefix)) return true
    if (!existsSync(join(dir, 'package.json'))) return true
    if (!base.startsWith(keepPrefix)) {
      if (rm(dir)) removed += 1
      return false
    }
    return false
  })
  return removed
}

function pruneNodePtyJunk(nm) {
  let removed = 0
  for (const junk of ['third_party', 'deps', 'src']) {
    forEachDir(nm, (dir, base) => {
      if (base !== junk) return true
      if (!norm(dir).includes('/node-pty/')) return true
      if (rm(dir)) removed += 1
      return false
    })
  }
  return removed
}

function chmodDarwinSpawnHelpers(nm) {
  let fixed = 0
  forEachFile(nm, (file, name) => {
    if (name !== 'spawn-helper') return
    if (!norm(file).includes('/node-pty/prebuilds/darwin-')) return
    try {
      chmodSync(file, 0o755)
      fixed += 1
    } catch {
      // ignore
    }
  })
  return fixed
}

function pruneTypesAndStamps(nm) {
  let removed = 0
  const pnpmRoot = join(nm, '.pnpm')
  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (entry.startsWith('@types+') && rm(join(pnpmRoot, entry))) removed += 1
      if (entry.startsWith('onnxruntime-web@') && rm(join(pnpmRoot, entry))) removed += 1
    }
  }
  if (rm(join(nm, '@types'))) removed += 1
  if (rm(join(nm, 'onnxruntime-web'))) removed += 1

  forEachFile(nm, (file, name) => {
    if (name === '.build-stamp' && rm(file)) removed += 1
  })
  return removed
}

const DEEP_DIRS = new Set([
  '__tests__',
  'test',
  'tests',
  'example',
  'examples',
  'benchmark',
  'benchmarks',
  'browser-test',
  'system-test',
  'fixture',
  'fixtures',
  'docs',
  '.pytest_cache',
  '.github',
])

function deepPrune(nm) {
  let removed = 0
  const stack = [nm]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (DEEP_DIRS.has(entry.name)) {
          if (rm(full)) removed += 1
          continue
        }
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (
        lower.endsWith('.map') ||
        lower.endsWith('.d.ts') ||
        lower.endsWith('.d.mts') ||
        lower.endsWith('.d.cts') ||
        lower.endsWith('.ts') ||
        lower.endsWith('.tsx') ||
        lower.endsWith('.tsbuildinfo') ||
        lower === 'readme.md' ||
        lower === 'changelog.md' ||
        lower === 'license' ||
        lower === 'license.md' ||
        lower.startsWith('.eslintrc') ||
        lower.startsWith('tsconfig') ||
        lower.startsWith('playwright.config.')
      ) {
        if (rm(full)) removed += 1
      }
    }
  }
  return removed
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.deployDir || !args.runtime || !args.arch) {
    console.error(
      'Usage: prune-deploy-node-modules.mjs <deployDir> --runtime <darwin|linux|win32> --arch <arm64|x64> [--deep]',
    )
    process.exit(1)
  }

  const nm = join(args.deployDir, 'node_modules')
  if (!existsSync(nm) || !statSync(nm).isDirectory()) {
    console.error(`node_modules not found: ${nm}`)
    process.exit(1)
  }

  const started = Date.now()
  const triplet = `${args.runtime}-${args.arch}`
  let removed = 0

  removed += pruneOnnxruntimeBinaries(nm, args.runtime, args.arch)

  if (args.runtime === 'darwin') {
    removed += removeScopedPackage(nm, '@nut-tree-fork', 'libnut-linux')
    removed += removeScopedPackage(nm, '@nut-tree-fork', 'libnut-win32')
  } else if (args.runtime === 'linux') {
    removed += removeScopedPackage(nm, '@nut-tree-fork', 'libnut-darwin')
    removed += removeScopedPackage(nm, '@nut-tree-fork', 'libnut-win32')
  } else if (args.runtime === 'win32') {
    removed += removeScopedPackage(nm, '@nut-tree-fork', 'libnut-darwin')
    removed += removeScopedPackage(nm, '@nut-tree-fork', 'libnut-linux')
  }

  removed += pruneNodePtyPrebuilds(nm, triplet)
  removed += prunePrefixedPackages(nm, 'canvas-', `canvas-${triplet}`)
  // sharp-libvips-* 必须先于 sharp-*：否则 keep=sharp-win32-x64 会误删已保留的 libvips 包
  removed += prunePrefixedPackages(nm, 'sharp-libvips-', `sharp-libvips-${triplet}`)
  removed += prunePrefixedPackages(nm, 'sharp-', `sharp-${triplet}`, {
    skipPrefix: 'sharp-libvips-',
  })
  if (args.runtime === 'darwin') {
    removed += prunePrefixedPackages(nm, 'tokenizers-', 'tokenizers-darwin-universal')
  } else {
    removed += prunePrefixedPackages(nm, 'tokenizers-', `tokenizers-${triplet}`)
  }

  removed += pruneNodePtyJunk(nm)
  removed += pruneTypesAndStamps(nm)
  const helpers = chmodDarwinSpawnHelpers(nm)

  let deepRemoved = 0
  if (args.deep) {
    deepRemoved = deepPrune(nm)
    removed += deepRemoved
  }

  console.log(
    `  · prune-deploy-node-modules: removed≈${removed}` +
      (args.deep ? ` (deep=${deepRemoved})` : ' (correctness-only)') +
      (helpers ? `, spawn-helper+x=${helpers}` : '') +
      `, ${Date.now() - started}ms`,
  )
}

main()

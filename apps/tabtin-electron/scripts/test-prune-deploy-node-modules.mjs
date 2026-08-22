#!/usr/bin/env node
/**
 * Smoke test for prune-deploy-node-modules.mjs correctness rules.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pruneScript = join(__dirname, 'prune-deploy-node-modules.mjs')
const root = join(tmpdir(), `tabtin-prune-smoke-${process.pid}`)
const nm = join(root, 'node_modules')

function touchPkg(dir, name = 'package.json') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify({ name: 'x', version: '1.0.0' }))
}

try {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(nm, { recursive: true })

  // Keep win32-x64 sharp; drop darwin
  touchPkg(join(nm, '@img', 'sharp-win32-x64'))
  touchPkg(join(nm, '@img', 'sharp-darwin-arm64'))
  touchPkg(join(nm, '@img', 'sharp-libvips-win32-x64'))
  touchPkg(join(nm, '@img', 'sharp-libvips-darwin-arm64'))

  // Wrong libnut
  touchPkg(join(nm, '@nut-tree-fork', 'libnut-darwin'))
  touchPkg(join(nm, '@nut-tree-fork', 'libnut-win32'))

  // node-pty junk + wrong prebuild
  touchPkg(join(nm, 'node-pty', 'prebuilds', 'win32-x64'), 'conpty.node')
  mkdirSync(join(nm, 'node-pty', 'prebuilds', 'darwin-arm64'), { recursive: true })
  writeFileSync(join(nm, 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'), 'x')
  mkdirSync(join(nm, 'node-pty', 'third_party'), { recursive: true })
  writeFileSync(join(nm, 'node-pty', 'third_party', 'x'), 'x')
  writeFileSync(join(nm, 'node-pty', '.build-stamp'), '1')

  // Docs that deep prune would remove; default path should keep
  writeFileSync(join(nm, 'node-pty', 'README.md'), 'keep-unless-deep')
  mkdirSync(join(nm, 'node-pty', 'docs'), { recursive: true })
  writeFileSync(join(nm, 'node-pty', 'docs', 'guide.md'), 'remove-on-deep')
  writeFileSync(join(nm, 'node-pty', 'index.d.ts'), 'remove-on-deep')
  writeFileSync(join(nm, 'node-pty', 'source.ts'), 'remove-on-deep')
  writeFileSync(join(nm, 'node-pty', 'cache.tsbuildinfo'), 'remove-on-deep')
  writeFileSync(join(nm, 'node-pty', 'index.js'), 'keep-runtime')

  execFileSync(process.execPath, [pruneScript, root, '--runtime', 'win32', '--arch', 'x64'], {
    stdio: 'inherit',
  })

  const mustExist = [
    join(nm, '@img', 'sharp-win32-x64', 'package.json'),
    join(nm, '@img', 'sharp-libvips-win32-x64', 'package.json'),
    join(nm, '@nut-tree-fork', 'libnut-win32', 'package.json'),
    join(nm, 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
    join(nm, 'node-pty', 'README.md'),
  ]
  const mustGone = [
    join(nm, '@img', 'sharp-darwin-arm64'),
    join(nm, '@img', 'sharp-libvips-darwin-arm64'),
    join(nm, '@nut-tree-fork', 'libnut-darwin'),
    join(nm, 'node-pty', 'prebuilds', 'darwin-arm64'),
    join(nm, 'node-pty', 'third_party'),
    join(nm, 'node-pty', '.build-stamp'),
  ]

  for (const p of mustExist) {
    if (!existsSync(p)) throw new Error(`expected to keep: ${p}`)
  }
  for (const p of mustGone) {
    if (existsSync(p)) throw new Error(`expected removed: ${p}`)
  }

  execFileSync(
    process.execPath,
    [pruneScript, root, '--runtime', 'win32', '--arch', 'x64', '--deep'],
    { stdio: 'inherit' },
  )

  const deepMustExist = [
    join(nm, 'node-pty', 'index.js'),
    join(nm, 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
  ]
  const deepMustGone = [
    join(nm, 'node-pty', 'README.md'),
    join(nm, 'node-pty', 'docs'),
    join(nm, 'node-pty', 'index.d.ts'),
    join(nm, 'node-pty', 'source.ts'),
    join(nm, 'node-pty', 'cache.tsbuildinfo'),
  ]

  for (const p of deepMustExist) {
    if (!existsSync(p)) throw new Error(`expected deep prune to keep: ${p}`)
  }
  for (const p of deepMustGone) {
    if (existsSync(p)) throw new Error(`expected deep prune to remove: ${p}`)
  }

  console.log('test-prune-deploy-node-modules: ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}

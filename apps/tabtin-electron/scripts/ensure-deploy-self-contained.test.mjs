#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertCriticalFilesInsideDeploy,
  ensureDeploySelfContained,
  findExternalLinks,
} from './ensure-deploy-self-contained.mjs'

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-deploy-links-'))
  const deployDir = path.join(root, 'deploy')
  const sourceDir = path.join(root, 'repo', 'packages', 'action-tools')
  const innerPackage = path.join(
    deployDir,
    'node_modules',
    '.pnpm',
    '@tabtin+action-tools@file+packages+action-tools',
    'node_modules',
    '@tabtin',
    'action-tools',
  )
  const topPackage = path.join(deployDir, 'node_modules', '@tabtin', 'action-tools')
  const missingTopPackage = path.join(deployDir, 'node_modules', '@tabtin', 'storage-manager')
  const missingInnerPackage = path.join(
    deployDir,
    'node_modules',
    '.pnpm',
    '@tabtin+storage-manager@file+packages+storage-manager',
    'node_modules',
    '@tabtin',
    'storage-manager',
  )

  fs.mkdirSync(path.join(sourceDir, 'dist', 'adapters'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'package.json'), '{"name":"@tabtin/action-tools"}\n')
  fs.writeFileSync(path.join(sourceDir, 'dist', 'adapters', 'public.js'), 'export {}\n')
  fs.mkdirSync(path.join(sourceDir, 'node_modules', 'ignored'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'node_modules', 'ignored', 'sentinel'), 'do not copy\n')

  fs.mkdirSync(path.dirname(innerPackage), { recursive: true })
  fs.symlinkSync(sourceDir, innerPackage, process.platform === 'win32' ? 'junction' : 'dir')
  fs.mkdirSync(path.dirname(topPackage), { recursive: true })
  fs.symlinkSync(
    path.relative(path.dirname(topPackage), innerPackage),
    topPackage,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  fs.mkdirSync(missingInnerPackage, { recursive: true })
  fs.writeFileSync(
    path.join(missingInnerPackage, 'package.json'),
    '{"name":"@tabtin/storage-manager"}\n',
  )

  return {
    root,
    deployDir,
    sourceDir,
    innerPackage,
    topPackage,
    missingInnerPackage,
    missingTopPackage,
  }
}

test('materializes workspace packages whose pnpm links escape the deploy directory', () => {
  const fixture = makeFixture()
  try {
    const before = findExternalLinks(fixture.deployDir)
    assert.equal(before.length, 2)
    assert.deepEqual(
      before.map((link) => link.path).sort(),
      [fixture.innerPackage, fixture.topPackage].sort(),
    )

    const result = ensureDeploySelfContained(fixture.deployDir)

    assert.equal(result.materialized.length, 1)
    assert.deepEqual(result.dropped, [])
    assert.equal(result.hoisted.includes(fixture.missingTopPackage), true)
    assert.equal(fs.realpathSync(fixture.missingTopPackage), fixture.missingInnerPackage)
    assert.equal(fs.realpathSync(fixture.topPackage).startsWith(fixture.deployDir), true)
    assert.equal(
      fs.readFileSync(path.join(fixture.topPackage, 'dist', 'adapters', 'public.js'), 'utf8'),
      'export {}\n',
    )
    assert.equal(fs.existsSync(path.join(fixture.innerPackage, 'node_modules')), false)
    assert.deepEqual(findExternalLinks(fixture.deployDir), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('leaves links that already resolve inside deploy untouched', () => {
  const fixture = makeFixture()
  try {
    ensureDeploySelfContained(fixture.deployDir)
    const firstStat = fs.statSync(path.join(fixture.innerPackage, 'package.json'))

    const result = ensureDeploySelfContained(fixture.deployDir)
    const secondStat = fs.statSync(path.join(fixture.innerPackage, 'package.json'))

    assert.deepEqual(result.materialized, [])
    assert.deepEqual(result.dropped, [])
    assert.deepEqual(result.hoisted, [])
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails fast with the broken dependency path', () => {
  const fixture = makeFixture()
  try {
    const brokenLink = path.join(fixture.deployDir, 'node_modules', 'broken-package')
    fs.symlinkSync(
      path.join(fixture.root, 'missing-package'),
      brokenLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    assert.throws(
      () => ensureDeploySelfContained(fixture.deployDir),
      new RegExp(`broken dependency link: .*${path.basename(brokenLink)}`),
    )
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails when a critical packaged file still resolves outside deploy', () => {
  const fixture = makeFixture()
  try {
    // Leave the escaping junction in place (do not run ensure).
    assert.throws(
      () => assertCriticalFilesInsideDeploy(fixture.deployDir),
      /must be under|escape deploy root/,
    )
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('drops links that point at an ancestor of the deploy directory', () => {
  // Mirrors Windows packaging: deploy lives under apps/tabtin-electron, and pnpm may
  // leave .pnpm/node_modules/tabtin-electron -> <app root>. Naive cpSync then throws
  // ERR_FS_CP_EINVAL ("Cannot copy ... to a subdirectory of self").
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-deploy-self-link-'))
  const deployDir = path.join(appRoot, '.deploy-runs', 'preprod-win-x64')
  const selfLink = path.join(
    deployDir,
    'node_modules',
    '.pnpm',
    'node_modules',
    'tabtin-electron',
  )
  try {
    fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(appRoot, 'package.json'), '{"name":"tabtin-electron"}\n')
    fs.mkdirSync(path.dirname(selfLink), { recursive: true })
    fs.symlinkSync(appRoot, selfLink, process.platform === 'win32' ? 'junction' : 'dir')

    const before = findExternalLinks(deployDir)
    assert.equal(before.length, 1)
    assert.equal(before[0].path, selfLink)

    const result = ensureDeploySelfContained(deployDir)

    assert.equal(result.dropped.length, 1)
    assert.equal(result.dropped[0].path, selfLink)
    assert.equal(result.materialized.length, 0)
    assert.equal(fs.existsSync(selfLink), false)
    assert.deepEqual(findExternalLinks(deployDir), [])
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true })
  }
})

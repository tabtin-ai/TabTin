#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cleanupPnpmDeployDebris } from './cleanup-pnpm-deploy-debris.mjs'

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-pnpm-deploy-debris-'))
  const appDir = path.join(root, 'apps', 'tabtin-electron')
  const deployDir = path.join(appDir, '.deploy-runs', 'preprod-win-x64-fixture')
  const duplicateBinDir = path.join(
    appDir,
    'apps',
    'tabtin-electron',
    '.deploy-runs',
    path.basename(deployDir),
    'node_modules',
    '.bin',
  )
  fs.mkdirSync(deployDir, { recursive: true })
  fs.mkdirSync(duplicateBinDir, { recursive: true })
  return { root, appDir, deployDir, duplicateBinDir }
}

test('removes only the duplicate pnpm deploy bin tree for the current run', () => {
  const fixture = makeFixture()
  try {
    fs.writeFileSync(path.join(fixture.duplicateBinDir, 'marked.cmd'), 'fixture\n')

    const result = cleanupPnpmDeployDebris(fixture.appDir, fixture.deployDir)

    assert.equal(result.removed, true)
    assert.equal(result.fileCount, 1)
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'apps')), false)
    assert.equal(fs.existsSync(fixture.deployDir), true)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('removes the duplicate bin tree for a fixed quick cache directory', () => {
  const fixture = makeFixture()
  try {
    fs.rmSync(path.join(fixture.appDir, 'apps'), { recursive: true, force: true })
    const deployDir = path.join(fixture.appDir, '.deploy-quick-win-local-x64')
    const duplicateBinDir = path.join(
      fixture.appDir,
      'apps',
      'tabtin-electron',
      path.basename(deployDir),
      'node_modules',
      '.bin',
    )
    fs.mkdirSync(deployDir, { recursive: true })
    fs.mkdirSync(duplicateBinDir, { recursive: true })
    fs.writeFileSync(path.join(duplicateBinDir, 'marked.cmd'), 'fixture\n')

    const result = cleanupPnpmDeployDebris(fixture.appDir, deployDir)

    assert.equal(result.removed, true)
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'apps')), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed when the duplicate tree contains an unexpected file', () => {
  const fixture = makeFixture()
  try {
    const unexpected = path.join(fixture.appDir, 'apps', 'unexpected.txt')
    fs.writeFileSync(unexpected, 'do not remove\n')

    assert.throws(
      () => cleanupPnpmDeployDebris(fixture.appDir, fixture.deployDir),
      /unexpected pnpm deploy debris/,
    )
    assert.equal(fs.existsSync(unexpected), true)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('cleans a previous run only when explicitly allowed', () => {
  const fixture = makeFixture()
  try {
    const currentDeployDir = path.join(fixture.appDir, '.deploy-runs', 'current-run')

    assert.throws(
      () => cleanupPnpmDeployDebris(fixture.appDir, currentDeployDir),
      /unexpected pnpm deploy debris/,
    )
    assert.equal(fs.existsSync(fixture.duplicateBinDir), true)

    const result = cleanupPnpmDeployDebris(fixture.appDir, currentDeployDir, {
      allowPreviousRuns: true,
    })

    assert.equal(result.removed, true)
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'apps')), false)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed when .bin is a file instead of a directory', () => {
  const fixture = makeFixture()
  try {
    fs.rmSync(fixture.duplicateBinDir, { recursive: true, force: true })
    fs.writeFileSync(fixture.duplicateBinDir, 'not a directory\n')

    assert.throws(
      () => cleanupPnpmDeployDebris(fixture.appDir, fixture.deployDir),
      /unexpected pnpm deploy debris/,
    )
    assert.equal(fs.readFileSync(fixture.duplicateBinDir, 'utf8'), 'not a directory\n')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed on an empty ancestor tree without a .bin directory', () => {
  const fixture = makeFixture()
  try {
    fs.rmSync(fixture.duplicateBinDir, { recursive: true, force: true })

    assert.throws(
      () => cleanupPnpmDeployDebris(fixture.appDir, fixture.deployDir),
      /missing expected pnpm duplicate \.bin directory/,
    )
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'apps')), true)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed when the APP_DIR/apps root is a junction or symlink', () => {
  const fixture = makeFixture()
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-pnpm-deploy-external-'))
  try {
    const appsRoot = path.join(fixture.appDir, 'apps')
    const externalBinDir = path.join(
      externalRoot,
      'tabtin-electron',
      '.deploy-runs',
      path.basename(fixture.deployDir),
      'node_modules',
      '.bin',
    )
    fs.rmSync(appsRoot, { recursive: true, force: true })
    fs.mkdirSync(externalBinDir, { recursive: true })
    const externalFile = path.join(externalBinDir, 'external.cmd')
    fs.writeFileSync(externalFile, 'must survive\n')
    fs.symlinkSync(externalRoot, appsRoot, process.platform === 'win32' ? 'junction' : 'dir')

    assert.throws(
      () => cleanupPnpmDeployDebris(fixture.appDir, fixture.deployDir),
      /root must be a real directory/,
    )
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'must survive\n')
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
    fs.rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('does nothing when pnpm did not create a duplicate tree', () => {
  const fixture = makeFixture()
  try {
    fs.rmSync(path.join(fixture.appDir, 'apps'), { recursive: true, force: true })

    assert.deepEqual(cleanupPnpmDeployDebris(fixture.appDir, fixture.deployDir), {
      removed: false,
      fileCount: 0,
    })
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

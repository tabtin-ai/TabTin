#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkQuickDeployCache,
  refreshQuickDeployWorkspacePackages,
  resolveQuickDeployGenerationDir,
  writeQuickDeployCacheMarker,
} from './quick-deploy-cache.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-quick-deploy-cache-'))
const repo = path.join(root, 'repo')
const deploy = path.join(root, 'deploy')

try {
  fs.mkdirSync(path.join(repo, 'packages', 'example', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'apps', 'tabtin-electron', 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(deploy, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  fs.writeFileSync(
    path.join(repo, 'apps', 'tabtin-electron', 'package.json'),
    JSON.stringify({ name: 'tabtin-electron', dependencies: { '@tabtin/example': 'workspace:*' } }),
  )
  fs.writeFileSync(
    path.join(repo, 'packages', 'example', 'package.json'),
    JSON.stringify({
      name: '@tabtin/example',
      files: ['dist', 'src/styles'],
      dependencies: { alpha: '1.0.0' },
    }),
  )
  fs.writeFileSync(path.join(repo, 'packages', 'example', 'dist', 'index.js'), 'export {}\n')
  fs.mkdirSync(path.join(repo, 'packages', 'example', 'src', 'styles'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'packages', 'example', 'src', 'styles', 'index.css'),
    ':root {}\n',
  )
  fs.writeFileSync(path.join(repo, 'packages', 'example', 'private-note.txt'), 'do not deploy\n')
  fs.writeFileSync(
    path.join(repo, 'apps', 'tabtin-electron', 'scripts', 'build-packaged-app.sh'),
    'echo fixture\n',
  )
  fs.writeFileSync(
    path.join(repo, 'apps', 'tabtin-electron', 'scripts', 'prune-deploy-node-modules.mjs'),
    'export {}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'apps', 'tabtin-electron', 'scripts', 'quick-deploy-cache.mjs'),
    'export {}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'apps', 'tabtin-electron', 'scripts', 'ensure-deploy-self-contained.mjs'),
    'export {}\n',
  )

  const deployedWorkspacePackage = path.join(deploy, 'node_modules', '@tabtin', 'example')
  fs.mkdirSync(path.join(deployedWorkspacePackage, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(deployedWorkspacePackage, 'dist', 'index.js'), 'stale\n')
  refreshQuickDeployWorkspacePackages(repo, deploy)
  assert.equal(
    fs.readFileSync(path.join(deployedWorkspacePackage, 'dist', 'index.js'), 'utf8'),
    'export {}\n',
    'cache hits must refresh deployed workspace output from the current checkout',
  )
  assert.equal(
    fs.readFileSync(path.join(deployedWorkspacePackage, 'src', 'styles', 'index.css'), 'utf8'),
    ':root {}\n',
    'workspace refresh must copy nested package files entries',
  )
  assert.equal(
    fs.existsSync(path.join(deployedWorkspacePackage, 'private-note.txt')),
    false,
    'workspace refresh must keep unpublished package files out of the deploy',
  )

  const cacheRoot = path.join(root, 'cache')
  const initialGeneration = resolveQuickDeployGenerationDir(repo, cacheRoot)
  const cliResult = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./quick-deploy-cache.mjs', import.meta.url)), 'path', repo, cacheRoot, 'cli-run'],
    { encoding: 'utf8' },
  )
  assert.equal(cliResult.status, 0, cliResult.stderr)
  assert.doesNotMatch(
    cliResult.stdout.trim(),
    /\\/,
    'the path command must emit a Git Bash compatible path on Windows',
  )
  assert.equal(
    resolveQuickDeployGenerationDir(repo, cacheRoot),
    initialGeneration,
    'unchanged dependency inputs must reuse the same quick deploy generation',
  )
  fs.mkdirSync(path.join(initialGeneration, 'dist-app', 'win-unpacked', 'resources'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(initialGeneration, 'dist-app', 'win-unpacked', 'resources', 'app.asar'),
    'stale artifact still held by another process',
  )
  const rebuiltGeneration = resolveQuickDeployGenerationDir(repo, cacheRoot, {
    runId: 'locked-rebuild',
  })
  assert.notEqual(
    rebuiltGeneration,
    initialGeneration,
    'an invalid existing generation must be abandoned without deleting its stale artifacts',
  )
  fs.mkdirSync(path.join(rebuiltGeneration, 'node_modules'), { recursive: true })
  writeQuickDeployCacheMarker(repo, rebuiltGeneration)
  assert.equal(
    resolveQuickDeployGenerationDir(repo, cacheRoot, { runId: 'later-run' }),
    rebuiltGeneration,
    'a validated rebuild generation must become the reusable quick dependency cache',
  )

  assert.equal(checkQuickDeployCache(repo, deploy).hit, false)
  writeQuickDeployCacheMarker(repo, deploy)
  assert.equal(checkQuickDeployCache(repo, deploy).hit, true)

  fs.writeFileSync(
    path.join(repo, 'packages', 'example', 'package.json'),
    JSON.stringify({ name: '@tabtin/example', dependencies: { alpha: '2.0.0' } }),
  )
  assert.equal(checkQuickDeployCache(repo, deploy).hit, false)

  fs.writeFileSync(
    path.join(repo, 'packages', 'example', 'package.json'),
    JSON.stringify({ name: '@tabtin/example', dependencies: { alpha: '1.0.0' } }),
  )
  writeQuickDeployCacheMarker(repo, deploy)
  const marker = path.join(deploy, '.tabtin-quick-deploy-cache.json')
  const newer = new Date(fs.statSync(marker).mtimeMs + 2_000)
  fs.utimesSync(path.join(repo, 'packages', 'example', 'dist', 'index.js'), newer, newer)
  assert.equal(
    checkQuickDeployCache(repo, deploy).hit,
    true,
    'workspace output changes must not invalidate the reusable dependency layer',
  )
  assert.equal(
    resolveQuickDeployGenerationDir(repo, cacheRoot),
    rebuiltGeneration,
    'workspace output changes must keep using the validated dependency generation',
  )

  console.log('quick deploy cache contract: ok')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

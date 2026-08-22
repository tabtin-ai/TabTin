#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MARKER_NAME = '.tabtin-quick-deploy-cache.json'
const CACHE_SCHEMA = 2
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist-app',
  'coverage',
  '.test-dist',
])
const SIGNED_SCRIPT_NAMES = [
  'build-packaged-app.sh',
  'quick-deploy-cache.mjs',
  'prune-deploy-node-modules.mjs',
  'ensure-deploy-self-contained.mjs',
]
const WORKSPACE_REFRESH_SKIPPED_DIRS = new Set(['.git', 'coverage', 'node_modules', 'test', 'tests'])

function walkFiles(root, visit) {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(full, visit)
    else if (entry.isFile()) visit(full)
  }
}

function collectWorkspacePackages(repoRoot) {
  const packages = new Map()
  for (const workspaceRootName of ['apps', 'packages']) {
    const workspaceRoot = path.join(repoRoot, workspaceRootName)
    walkFiles(workspaceRoot, (file) => {
      if (path.basename(file) !== 'package.json') return
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (manifest.name) packages.set(manifest.name, { dir: path.dirname(file), manifest })
    })
  }
  return packages
}

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })
}

function collectElectronWorkspaceGraph(repoRoot, packages) {
  const electronDir = path.join(repoRoot, 'apps', 'tabtin-electron')
  const electronManifest = JSON.parse(
    fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'),
  )
  const queue = dependencyNames(electronManifest)
  const graph = []
  const seen = new Set()
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const workspacePackage = packages.get(name)
    if (!workspacePackage) continue
    graph.push({ name, ...workspacePackage })
    queue.push(...dependencyNames(workspacePackage.manifest))
  }
  graph.sort((left, right) => left.name.localeCompare(right.name))
  return { electronManifest, graph }
}

function stableDependencyContract(manifest) {
  return {
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
  }
}

function buildFingerprint(repoRoot, electronManifest, graph) {
  const hash = crypto.createHash('sha256')
  const addFile = (file) => {
    hash.update(path.relative(repoRoot, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  addFile(path.join(repoRoot, 'pnpm-lock.yaml'))
  const scriptDir = path.join(repoRoot, 'apps', 'tabtin-electron', 'scripts')
  for (const scriptName of SIGNED_SCRIPT_NAMES) addFile(path.join(scriptDir, scriptName))
  hash.update(JSON.stringify(stableDependencyContract(electronManifest)))
  for (const { name, manifest } of graph) {
    hash.update(name)
    hash.update(JSON.stringify(stableDependencyContract(manifest)))
  }
  return hash.digest('hex')
}

function cacheState(repoRoot) {
  const packages = collectWorkspacePackages(repoRoot)
  const { electronManifest, graph } = collectElectronWorkspaceGraph(repoRoot, packages)
  return {
    fingerprint: buildFingerprint(repoRoot, electronManifest, graph),
    workspacePackageCount: graph.length,
  }
}

export function refreshQuickDeployWorkspacePackages(repoRoot, deployDir) {
  const packages = collectWorkspacePackages(repoRoot)
  const { graph } = collectElectronWorkspaceGraph(repoRoot, packages)
  for (const { name, dir, manifest } of graph) {
    const target = path.join(deployDir, 'node_modules', ...name.split('/'))
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(target, { recursive: true })
    const publishedFiles = Array.isArray(manifest.files) ? manifest.files : null
    if (publishedFiles) {
      for (const relative of ['package.json', ...publishedFiles]) {
        const source = path.join(dir, relative)
        if (!fs.existsSync(source)) continue
        fs.cpSync(source, path.join(target, relative), { recursive: true })
      }
      continue
    }
    fs.cpSync(dir, target, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(dir, source)
        return !relative || !WORKSPACE_REFRESH_SKIPPED_DIRS.has(relative.split(path.sep)[0])
      },
    })
  }
  return graph.length
}

export function resolveQuickDeployGenerationDir(repoRoot, cacheRoot, { runId } = {}) {
  const state = cacheState(repoRoot)
  const generationKey = `v${CACHE_SCHEMA}-${state.fingerprint.slice(0, 20)}`
  const resolvedCacheRoot = path.resolve(cacheRoot)
  const preferredGeneration = path.join(resolvedCacheRoot, 'generations', generationKey)
  if (
    !fs.existsSync(preferredGeneration) ||
    checkQuickDeployCache(repoRoot, preferredGeneration).hit
  ) {
    return preferredGeneration
  }

  const rebuildRoot = path.join(resolvedCacheRoot, 'rebuilds')
  if (fs.existsSync(rebuildRoot)) {
    const reusableRebuild = fs
      .readdirSync(rebuildRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${generationKey}-`))
      .map((entry) => path.join(rebuildRoot, entry.name))
      .find((candidate) => checkQuickDeployCache(repoRoot, candidate).hit)
    if (reusableRebuild) return reusableRebuild
  }

  const fallbackId = String(runId ?? `${Date.now()}-${process.pid}`).replaceAll(
    /[^A-Za-z0-9._-]/g,
    '-',
  )
  return path.join(rebuildRoot, `${generationKey}-${fallbackId}`)
}

export function checkQuickDeployCache(repoRoot, deployDir) {
  const markerPath = path.join(deployDir, MARKER_NAME)
  if (!fs.existsSync(path.join(deployDir, 'node_modules')) || !fs.existsSync(markerPath)) {
    return { hit: false, reason: 'missing cache marker or node_modules' }
  }
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const current = cacheState(repoRoot)
    if (marker.schema !== CACHE_SCHEMA || marker.fingerprint !== current.fingerprint) {
      return { hit: false, reason: 'dependency fingerprint changed' }
    }
    return { hit: true, reason: 'validated', workspacePackageCount: current.workspacePackageCount }
  } catch (error) {
    return { hit: false, reason: `invalid cache: ${error.message}` }
  }
}

export function writeQuickDeployCacheMarker(repoRoot, deployDir) {
  const state = cacheState(repoRoot)
  const markerPath = path.join(deployDir, MARKER_NAME)
  const marker = {
    schema: CACHE_SCHEMA,
    fingerprint: state.fingerprint,
    createdAtMs: Date.now(),
    workspacePackageCount: state.workspacePackageCount,
  }
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  return marker
}

function main() {
  const [command, repoRootArg, deployDirArg, runIdArg] = process.argv.slice(2)
  if (!['check', 'path', 'refresh', 'write'].includes(command) || !repoRootArg || !deployDirArg) {
    console.error(
      'Usage: quick-deploy-cache.mjs <check|path|refresh|write> <repo-root> <deploy-dir-or-cache-root>',
    )
    process.exitCode = 2
    return
  }
  const repoRoot = path.resolve(repoRootArg)
  const deployDir = path.resolve(deployDirArg)
  if (command === 'path') {
    const generationDir = resolveQuickDeployGenerationDir(repoRoot, deployDir, {
      runId: runIdArg,
    })
    console.log(generationDir.replaceAll(path.sep, '/'))
    return
  }
  if (command === 'refresh') {
    const refreshedCount = refreshQuickDeployWorkspacePackages(repoRoot, deployDir)
    console.log(`quick deploy workspace refresh: ${refreshedCount} packages`)
    return
  }
  if (command === 'write') {
    const marker = writeQuickDeployCacheMarker(repoRoot, deployDir)
    console.log(`quick deploy cache stored (${marker.workspacePackageCount} workspace packages)`)
    return
  }
  const result = checkQuickDeployCache(repoRoot, deployDir)
  console.log(`quick deploy cache ${result.hit ? 'hit' : 'miss'}: ${result.reason}`)
  if (!result.hit) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()

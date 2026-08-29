#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function loadPeAndAsarTools() {
  const localRequire = createRequire(import.meta.url)
  const electronBuilderPackageJson = localRequire.resolve('electron-builder/package.json')
  const electronBuilderRequire = createRequire(electronBuilderPackageJson)
  return {
    ...electronBuilderRequire('resedit'),
    ...electronBuilderRequire('app-builder-lib/out/asar/integrity'),
  }
}

export function readEmbeddedAsarIntegrity(exePath, resedit) {
  const executable = resedit.NtExecutable.from(readFileSync(exePath))
  const resource = resedit.NtExecutableResource.from(executable)
  const entries = resource.entries.filter(
    (entry) => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR',
  )
  if (entries.length !== 1) {
    throw new Error(`expected one INTEGRITY/ELECTRONASAR resource, found ${entries.length}`)
  }
  const parsed = JSON.parse(Buffer.from(entries[0].bin).toString('utf8'))
  if (!Array.isArray(parsed)) {
    throw new Error('INTEGRITY/ELECTRONASAR is not a list')
  }
  return parsed
}

export async function assertWindowsAsarIntegrity(appDir, executableName) {
  const resolvedAppDir = resolve(appDir)
  const exePath = join(resolvedAppDir, executableName)
  const resourcesPath = join(resolvedAppDir, 'resources')
  const appAsarPath = join(resourcesPath, 'app.asar')
  for (const requiredPath of [exePath, appAsarPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`required packaged file not found: ${requiredPath}`)
    }
  }

  const tools = loadPeAndAsarTools()
  const embedded = readEmbeddedAsarIntegrity(exePath, tools)
  const appAsar = embedded.find((entry) => entry.file === 'resources\\app.asar')
  if (!appAsar) {
    const recorded = embedded.map((entry) => entry.file).join(', ') || '(empty)'
    throw new Error(
      `Windows Electron requires resources\\app.asar, embedded resource records: ${recorded}`,
    )
  }

  const computed = await tools.computeData({
    resourcesPath,
    resourcesRelativePath: 'resources',
  })
  const actual = Object.entries(computed).find(
    ([file]) => file.replaceAll('/', '\\') === 'resources\\app.asar',
  )?.[1]
  if (!actual || appAsar.alg !== actual.algorithm || appAsar.value !== actual.hash) {
    throw new Error('embedded app.asar header hash does not match packaged resources/app.asar')
  }

  return { exePath, appAsarPath, integrity: appAsar }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    parsed[current.slice(2)] = argv[index + 1]
    index += 1
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const appDir = args['app-dir']
  const executableName = args['exe-name']
  if (!appDir || !executableName) {
    throw new Error('usage: --app-dir <win-unpacked> --exe-name <main.exe>')
  }
  const result = await assertWindowsAsarIntegrity(appDir, executableName)
  console.log(`✓ Windows ASAR integrity aligned: ${basename(result.exePath)}`)
  console.log(`  ${result.integrity.file} ${result.integrity.alg} ${result.integrity.value}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

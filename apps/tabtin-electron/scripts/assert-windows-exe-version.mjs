#!/usr/bin/env node
/**
 * 断言 Windows 安装包 / 主程序 PE 版本与期望版本对齐。
 *
 * 用法:
 *   node assert-windows-exe-version.mjs --dist <dist-app> --expect 0.7.56 [--exe-name tabtin-desktop.exe]
 *   node assert-windows-exe-version.mjs --exe <file.exe> --expect 0.7.56
 *
 * 退出码: 0 对齐；1 不齐或找不到产物。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function normalizeDesktopVersion(version) {
  const raw = String(version || '').trim().replace(/^v/i, '')
  if (!raw) return ''
  // 保留 semver pre-release（0.0.1-alpha.158）；仅剥 FileVersion 常见的尾部 .0
  const [core, ...suffixParts] = raw.split('-')
  const parts = core.split('.').filter((part) => part.length > 0)
  while (parts.length > 3 && parts[parts.length - 1] === '0') {
    parts.pop()
  }
  const normalizedCore = parts.join('.').toLowerCase()
  if (suffixParts.length === 0) return normalizedCore
  return `${normalizedCore}-${suffixParts.join('-').toLowerCase()}`
}

export function desktopVersionsAligned(expected, actual) {
  const e = normalizeDesktopVersion(expected)
  const a = normalizeDesktopVersion(actual)
  if (!e || !a) return false
  if (e === a) return true
  // Windows PE ProductVersion is numeric and electron-builder serializes a
  // prerelease such as 0.0.1-alpha.158 as 0.0.1.0. The electron-builder
  // Setup filename is selected using the full prerelease version; both Setup
  // and desktop PE ProductVersion values use this numeric-core comparison.
  const expectedCore = e.split('-', 1)[0]
  if (e.includes('-') && a === expectedCore) {
    return true
  }
  // 0.7.56 vs 0.7.56.0 / 0.7.56.1234
  if (a.startsWith(`${e}.`) || e.startsWith(`${a}.`)) return true
  return false
}

/** electron-builder NSIS：`TabTin Setup 0.7.56.exe` / `TabTin Preprod Setup 0.7.56.exe` */
export function isElectronBuilderNsisSetupName(name) {
  return / Setup .+\.exe$/i.test(String(name || ''))
}

export function setupNameMatchesVersion(name, version) {
  const normalizedName = String(name || '').toLowerCase()
  const normalizedVersion = String(version || '').trim().toLowerCase()
  if (!normalizedVersion) return false
  return normalizedName.includes(normalizedVersion)
}

export function selectElectronBuilderNsisSetup(distDir, version) {
  if (!distDir || !existsSync(distDir)) return null
  const entries = readdirSync(distDir)
    .filter((name) => {
      if (!isElectronBuilderNsisSetupName(name)) return false
      if (!setupNameMatchesVersion(name, version)) return false
      // 排除 pack-win 时间戳副本
      if (/-\d{8}-\d{6}\.exe$/i.test(name)) return false
      const fullPath = join(distDir, name)
      try {
        return statSync(fullPath).isFile()
      } catch {
        return false
      }
    })
    .map((name) => {
      const fullPath = join(distDir, name)
      return { name, path: fullPath, mtimeMs: statSync(fullPath).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return entries[0] || null
}

export function readWindowsPeProductVersion(exePath) {
  if (!exePath || !existsSync(exePath)) {
    throw new Error(`exe not found: ${exePath}`)
  }
  const psPath = String(exePath).replace(/'/g, "''")
  const script = [
    `$v = (Get-Item -LiteralPath '${psPath}').VersionInfo.ProductVersion`,
    `if ($null -eq $v) { $v = '' }`,
    `[Console]::Out.Write(($v | Out-String).Trim())`,
  ].join('; ')

  const candidates = [
    ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]],
    ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]],
    ['pwsh', ['-NoProfile', '-Command', script]],
  ]

  let lastError = 'powershell unavailable'
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.error) {
      lastError = result.error.message
      continue
    }
    if (result.status !== 0) {
      lastError = (result.stderr || result.stdout || `exit ${result.status}`).trim()
      continue
    }
    return String(result.stdout || '').trim()
  }

  // Cross-packaging Windows on macOS/Linux has no PowerShell. electron-builder
  // already ships resedit, so read the same PE version resource in-process.
  try {
    const localRequire = createRequire(import.meta.url)
    const electronBuilderPackageJson = localRequire.resolve('electron-builder/package.json')
    const electronBuilderRequire = createRequire(electronBuilderPackageJson)
    const { NtExecutable, NtExecutableResource, Resource } = electronBuilderRequire('resedit')
    const executable = NtExecutable.from(readFileSync(exePath))
    const resource = NtExecutableResource.from(executable)
    const versionInfo = Resource.VersionInfo.fromEntries(resource.entries)
    if (versionInfo.length !== 1) {
      throw new Error(`expected one version resource, found ${versionInfo.length}`)
    }
    const languages = versionInfo[0].getAllLanguagesForStringValues()
    if (languages.length === 0) {
      throw new Error('version resource has no language')
    }
    return String(versionInfo[0].getStringValues(languages[0]).ProductVersion || '').trim()
  } catch (error) {
    const fallbackError = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to read ProductVersion: ${lastError}; resedit: ${fallbackError}`)
  }
}

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) {
      parsed._.push(current)
      continue
    }
    const key = current.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = value
    index += 1
  }
  return parsed
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function assertExeVersion(exePath, expected, label) {
  const productVersion = readWindowsPeProductVersion(exePath)
  const shown = productVersion || '(empty)'
  console.log(`  · ${label}: ${basename(exePath)}`)
  console.log(`    ProductVersion=${shown}  expect=${expected}`)
  if (!desktopVersionsAligned(expected, productVersion)) {
    fail(
      `${label} PE ProductVersion mismatch: actual=${shown} expect=${expected}`,
    )
  }
}

export function assertWindowsDistAppVersion(
  distDir,
  expectedVersion,
  executableName = 'tabtin-desktop.exe',
) {
  const setup = selectElectronBuilderNsisSetup(distDir, expectedVersion)
  if (!setup) {
    throw new Error(
      `dist-app 中未找到含版本 ${expectedVersion} 的 electron-builder Setup（*Setup ${expectedVersion}*.exe）: ${distDir}`,
    )
  }
  assertExeVersion(setup.path, expectedVersion, 'Setup')

  const desktopCandidates = [
    join(distDir, 'win-unpacked', executableName),
    join(distDir, 'win-ia32-unpacked', executableName),
  ]
  const desktop = desktopCandidates.find((candidate) => existsSync(candidate))
  if (desktop) {
    assertExeVersion(desktop, expectedVersion, executableName)
  } else {
    console.log(`  · skip ${executableName} PE check (win-unpacked not present)`)
  }
  return setup
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const expected = String(args.expect || args.version || '').trim()
  if (!expected) fail('--expect <version> is required')

  if (args.exe) {
    assertExeVersion(resolve(args.exe), expected, 'exe')
    console.log('✓ Windows PE version aligned')
    return
  }

  const distDir = resolve(args.dist || args.artifact || 'dist-app')
  const executableName = String(args['exe-name'] || 'tabtin-desktop.exe').trim()
  if (!existsSync(distDir)) fail(`dist dir not found: ${distDir}`)
  try {
    assertWindowsDistAppVersion(distDir, expected, executableName)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  console.log('✓ Windows installer/app PE version aligned')
}

const isDirectRun = Boolean(
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
)
if (isDirectRun) {
  main()
}

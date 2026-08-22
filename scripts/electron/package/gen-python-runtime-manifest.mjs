// gen-python-runtime-manifest.mjs —— 在 Electron 打包阶段生成 python runtime manifest。
//
// 读 committed 配置 runtime.config.json 的 version + archives（每平台本地文件名），
// 只从 packages/python-runtime/runtime/ 下的随包归档计算 sha256/size。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DEFAULT_CONFIG = path.join(REPO_ROOT, 'packages/python-runtime/runtime.config.json')
const DEFAULT_RUNTIME_DIR = path.join(REPO_ROOT, 'packages/python-runtime/runtime')
const DEFAULT_OUT = path.join(REPO_ROOT, 'packages/python-runtime/runtime/manifest.json')

export function archiveNameForPlatform(config, platform) {
  const archives = config.archives || {}
  const name = archives[platform]
  return typeof name === 'string' && name ? name : ''
}

export function sha256OfFile(filePath) {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function entrypointForPlatform(platform) {
  return platform.startsWith('win32-') ? 'python.exe' : 'bin/python3'
}

export function isValidManifestPlatformEntry(entry) {
  return (
    !!entry &&
    typeof entry.archiveName === 'string' &&
    entry.archiveName.length > 0 &&
    !entry.archiveName.includes('..') &&
    !path.isAbsolute(entry.archiveName) &&
    /^[a-f0-9]{64}$/i.test(String(entry.sha256 || '')) &&
    Number.isSafeInteger(entry.size) &&
    entry.size > 0 &&
    typeof entry.entrypoint === 'string' &&
    entry.entrypoint.length > 0 &&
    !entry.entrypoint.includes('..') &&
    !path.isAbsolute(entry.entrypoint)
  )
}

export function isValidManifestPlatform(manifest, platform) {
  return (
    manifest?.schemaVersion === 2 &&
    manifest?.runtimeKind === 'python' &&
    isValidManifestPlatformEntry(manifest.platforms?.[platform])
  )
}

export async function generatePythonRuntimeManifest(config, options = {}) {
  const requiredPlatform = options.requiredPlatform
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR
  const platforms = {}
  const archives = config.archives || {}
  if (requiredPlatform && !Object.hasOwn(archives, requiredPlatform)) {
    throw new Error(`目标平台 ${requiredPlatform} 的 runtime 重档未配置`)
  }
  const entries = requiredPlatform
    ? [[requiredPlatform, archives[requiredPlatform]]]
    : Object.entries(archives)

  for (const [plat, archiveName] of entries) {
    try {
      if (typeof archiveName !== 'string' || !archiveName) {
        throw new Error(`平台 ${plat} 未配置 archives 文件名`)
      }
      const localArchive = path.join(runtimeDir, archiveName)
      if (!fs.existsSync(localArchive) || !fs.statSync(localArchive).isFile()) {
        throw new Error(`缺少本地归档 ${localArchive}`)
      }
      const stat = fs.statSync(localArchive)
      const sha256 = sha256OfFile(localArchive)
      const entrypoint = entrypointForPlatform(plat)
      platforms[plat] = { archiveName, sha256, size: stat.size, entrypoint }
      options.logger?.log?.('→ 本地归档算 sha:', plat, localArchive)
      options.logger?.log?.('  ✓', plat, sha256, stat.size)
    } catch (error) {
      options.logger?.error?.('  ⚠ 跳过', plat, ':', error instanceof Error ? error.message : String(error))
      if (plat === requiredPlatform) {
        throw new Error(`目标平台 ${requiredPlatform} 的 runtime 重档不可用`)
      }
    }
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error('无任何可用平台重档')
  }
  if (requiredPlatform && !platforms[requiredPlatform]) {
    throw new Error(`目标平台 ${requiredPlatform} 的 runtime 重档不可用`)
  }

  return {
    schemaVersion: 2,
    runtimeKind: 'python',
    version: config.version,
    platforms,
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      parsed[current.slice(2)] = 'true'
      continue
    }
    parsed[current.slice(2)] = value
    index += 1
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const requiredPlatform = args['required-platform']
  const configPath = path.resolve(args.config || DEFAULT_CONFIG)
  const runtimeDir = path.resolve(args['runtime-dir'] || DEFAULT_RUNTIME_DIR)
  const outPath = path.resolve(args.out || DEFAULT_OUT)

  if (!fs.existsSync(configPath)) {
    console.error(`缺少配置: ${configPath}`)
    process.exitCode = 2
    return
  }

  // Never let a previous successful build mask a failed or incomplete refresh.
  fs.rmSync(outPath, { force: true })

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const manifest = await generatePythonRuntimeManifest(config, {
      requiredPlatform,
      runtimeDir,
      logger: console,
    })
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
    console.log('✅ 生成 combined manifest:', outPath, '平台:', Object.keys(manifest.platforms).join(', '))
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}，未生成 manifest`)
    process.exitCode = 3
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  await main()
}

import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  assertChecksum,
  defaultTarCommand,
  extractArchiveToRuntimeRoot,
  isFile,
  joinRel,
} from './archive.js'
import { expectedPlatform, parseManifest, selectPlatformEntry } from './manifest.js'
import {
  PythonRuntimeError,
  type PythonRuntimeConfig,
  type PythonRuntimeManifest,
  type PythonRuntimePlatformEntry,
  type ResolvedPythonRuntime,
} from './types.js'

/**
 * 自管 Python 运行时布局：
 *   <cacheDir>/tabtin-runtimes/tabtin-primary-runtime/dependencies/python
 */
export const RUNTIME_NAMESPACE = 'tabtin-runtimes'
export const PRIMARY_RUNTIME_NAME = 'tabtin-primary-runtime'

/** 宿主用来把解析出的解释器暴露给 agent 子进程的环境变量名（infra 契约，非业务）。 */
export const PYTHON_RUNTIME_ENV_VAR = 'TABTIN_PYTHON_RUNTIME'

const MANIFEST_NAME = 'manifest.json'
const MARKER_NAME = 'current.json'

export function pythonRuntimeRoot(cacheDir: string): string {
  return path.join(cacheDir, RUNTIME_NAMESPACE, PRIMARY_RUNTIME_NAME, 'dependencies', 'python')
}

function markerPath(cacheDir: string): string {
  return path.join(cacheDir, RUNTIME_NAMESPACE, PRIMARY_RUNTIME_NAME, MARKER_NAME)
}

/**
 * 镜像 Rust `dirs::cache_dir()` 语义的 OS 缓存根（纯基础设施）：
 *   macOS ~/Library/Caches、Windows %LOCALAPPDATA%、Linux $XDG_CACHE_HOME 或 ~/.cache。
 * 仅读 OS 标准路径变量，不涉任何业务。供 L1 适配层注入 cacheDir 用。
 */
export function osCacheDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches')
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return process.env.XDG_CACHE_HOME || path.join(home, '.cache')
}

/** 平台默认解释器相对入口（用于 explicit/无 manifest 兜底；有 manifest 时用条目里的 entrypoint）。 */
export function entrypointRelPath(): string {
  return process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3')
}

async function runtimeFromRoot(
  root: string,
  origin: ResolvedPythonRuntime['origin'],
  entrypoint: string,
  version?: string,
): Promise<ResolvedPythonRuntime | null> {
  const pythonPath = joinRel(root, entrypoint)
  if (await isFile(pythonPath)) {
    return { root, pythonPath, version, origin }
  }
  return null
}

/** 已解压运行时目录候选（explicit 覆盖用；候选可能是 dependencies/python 或其父）。 */
async function firstRuntimeFromRoots(
  roots: string[] | undefined,
  origin: ResolvedPythonRuntime['origin'],
): Promise<ResolvedPythonRuntime | null> {
  const entry = entrypointRelPath()
  for (const root of roots ?? []) {
    if (!root) continue
    const direct = await runtimeFromRoot(root, origin, entry)
    if (direct) return direct
    const nested = await runtimeFromRoot(path.join(root, 'dependencies', 'python'), origin, entry)
    if (nested) return nested
  }
  return null
}

interface FoundManifest {
  manifest: PythonRuntimeManifest
  dir: string
}

/** 从 packagedRoots 里读 bundled manifest.json（LibreOffice 同款：安装包内置的小指针）。 */
async function manifestFromPackagedRoots(roots: string[] | undefined): Promise<FoundManifest | null> {
  for (const root of roots ?? []) {
    if (!root) continue
    const candidates = [path.join(root, MANIFEST_NAME), path.join(root, 'dependencies', MANIFEST_NAME)]
    for (const manifestPath of candidates) {
      if (!(await isFile(manifestPath))) continue
      const raw = await fsPromises.readFile(manifestPath, 'utf-8')
      return { manifest: parseManifest(raw, manifestPath), dir: path.dirname(manifestPath) }
    }
  }
  return null
}

interface InstalledMarker {
  version: string
  platform: string
  sha256: string
}

async function readMarker(cacheDir: string): Promise<InstalledMarker | null> {
  try {
    const raw = await fsPromises.readFile(markerPath(cacheDir), 'utf-8')
    const parsed = JSON.parse(raw) as InstalledMarker
    if (!parsed.version || !parsed.platform || !parsed.sha256) return null
    return parsed
  } catch {
    return null
  }
}

async function writeMarker(cacheDir: string, version: string, sha256: string): Promise<void> {
  const marker: InstalledMarker = { version, platform: expectedPlatform(), sha256 }
  await fsPromises.writeFile(markerPath(cacheDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8')
}

/** marker 与 (version + 本平台条目 sha) 一致且解释器就位 → 命中缓存（版本/内容变则重装）。 */
async function cachedRuntimeFromEntry(
  cacheDir: string,
  version: string,
  entry: PythonRuntimePlatformEntry,
): Promise<ResolvedPythonRuntime | null> {
  const marker = await readMarker(cacheDir)
  if (marker && marker.version === version && marker.sha256.toLowerCase() === entry.sha256.toLowerCase()) {
    return runtimeFromRoot(pythonRuntimeRoot(cacheDir), 'cache', entry.entrypoint, version)
  }
  return null
}

interface ObtainedArchive {
  archivePath: string
  origin: 'bundled-archive'
}

/** 取归档：只接受 manifest 同目录的随包 sibling。 */
async function obtainArchive(
  dir: string,
  entry: PythonRuntimePlatformEntry,
): Promise<ObtainedArchive> {
  const local = path.join(dir, entry.archiveName)
  if (await isFile(local)) {
    await assertChecksum(local, entry.sha256, entry.size)
    return { archivePath: local, origin: 'bundled-archive' }
  }
  throw new PythonRuntimeError('ARCHIVE_MISSING', `缺少随包 python runtime 归档: ${entry.archiveName}`)
}

/**
 * L0 唯一公开入口：
 *   1. explicitRoots 已解压目录（dev/测试覆盖，TABTIN_PYTHON_RUNTIME_DIR）
 *   2. packagedRoots 里读 bundled manifest.json + 同目录归档
 *      - marker 命中（version+sha 一致）→ 直接用缓存
 *      - 否则解压随包归档 → sha 校验 → 写 marker
 *   3. 无 manifest 但缓存已存在 → 用缓存
 *   4. 都不可得 → RUNTIME_UNAVAILABLE
 */
export async function ensurePythonRuntime(config: PythonRuntimeConfig): Promise<ResolvedPythonRuntime> {
  if (!config.cacheDir) {
    throw new PythonRuntimeError('RUNTIME_UNAVAILABLE', 'cacheDir 未注入')
  }
  const tarCommand = config.tarCommand ?? defaultTarCommand()
  const runtimeRoot = pythonRuntimeRoot(config.cacheDir)

  const explicit = await firstRuntimeFromRoots(config.explicitRoots, 'explicit')
  if (explicit) return explicit

  const found = await manifestFromPackagedRoots(config.packagedRoots)
  // 只有当 manifest 覆盖了本机平台时才走 manifest 分支（否则可能是不含本平台的包）
  const entry = found ? selectPlatformEntry(found.manifest) : null
  if (found && entry) {
    const version = found.manifest.version
    const cached = await cachedRuntimeFromEntry(config.cacheDir, version, entry)
    if (cached) return cached

    await ensureCacheWritable(config.cacheDir)
    const { archivePath, origin } = await obtainArchive(found.dir, entry)
    await extractArchiveToRuntimeRoot(archivePath, runtimeRoot, entry.entrypoint, tarCommand)
    await writeMarker(config.cacheDir, version, entry.sha256)
    const extracted = await runtimeFromRoot(runtimeRoot, origin, entry.entrypoint, version)
    if (extracted) return extracted
  }

  // 无 manifest（或不含本平台）但此前已 provision 过 → 用缓存（离线容错）
  const cached = await runtimeFromRoot(runtimeRoot, 'cache', entrypointRelPath())
  if (cached) return cached

  throw new PythonRuntimeError(
    'RUNTIME_UNAVAILABLE',
    '未能获取 python runtime：无缓存、无内置 manifest/归档。请检查安装包完整性后重试。',
  )
}

/** 缓存目录可写自检 —— 失败给人话化错误（避免静默失败）。 */
async function ensureCacheWritable(cacheDir: string): Promise<void> {
  const probeDir = path.join(cacheDir, RUNTIME_NAMESPACE)
  try {
    await fsPromises.mkdir(probeDir, { recursive: true })
    const probe = path.join(probeDir, '.write-probe')
    await fsPromises.writeFile(probe, 'ok')
    await fsPromises.rm(probe, { force: true })
  } catch (error) {
    throw new PythonRuntimeError(
      'CACHE_UNWRITABLE',
      `python runtime 缓存目录不可写：${probeDir}。请检查磁盘空间与目录权限后重试。原因：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

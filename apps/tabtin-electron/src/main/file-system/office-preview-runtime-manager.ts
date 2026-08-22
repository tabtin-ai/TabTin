import { app } from 'electron'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createLogger } from '../logger'

const log = createLogger('OfficePreviewRuntime')
const execFileAsync = promisify(execFile)

const RUNTIME_EXTRACT_TIMEOUT_MS = 120_000
const RUNTIME_DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const MANIFEST_FILE_NAME = 'manifest.json'
const CURRENT_MARKER_FILE_NAME = 'current.json'

export type OfficePreviewRuntimeErrorCode =
  | 'OFFICE_RUNTIME_MANIFEST_MISSING'
  | 'OFFICE_RUNTIME_MANIFEST_INVALID'
  | 'OFFICE_RUNTIME_ARCHIVE_MISSING'
  | 'OFFICE_RUNTIME_DOWNLOAD_FAILED'
  | 'OFFICE_RUNTIME_CHECKSUM_MISMATCH'
  | 'OFFICE_RUNTIME_EXTRACT_FAILED'
  | 'OFFICE_RUNTIME_TOOL_MISSING'

export class OfficePreviewRuntimeError extends Error {
  readonly code: OfficePreviewRuntimeErrorCode

  constructor(code: OfficePreviewRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'OfficePreviewRuntimeError'
    this.code = code
  }
}

export interface OfficePreviewRuntimeManifest {
  schemaVersion: 1
  version: string
  platform: string
  archiveName: string
  url?: string
  sha256: string
  size?: number
  tools: {
    soffice: string
    pdftoppm: string
  }
}

export interface OfficePreviewRuntime {
  root: string
  sofficePath: string
  pdftoppmPath: string
  version?: string
}

interface InstalledRuntimeMarker {
  version: string
  platform: string
  sha256: string
  installedAt: string
  root: string
}

let bundledRuntimeExtractionPromise: Promise<string | null> | null = null
let manifestRuntimePromise: Promise<OfficePreviewRuntime | null> | null = null

function officeRuntimeCacheRoot(): string {
  return path.join(app.getPath('userData'), 'office-preview-runtime')
}

function currentRuntimeMarkerPath(): string {
  return path.join(officeRuntimeCacheRoot(), CURRENT_MARKER_FILE_NAME)
}

function appPath(name: string): string | null {
  try {
    const value = app.getPath(name as Parameters<typeof app.getPath>[0])
    return value || null
  } catch {
    return null
  }
}

async function isFile(candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false
  try {
    const stat = await fsPromises.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

function pathCandidatesFromEnv(...names: string[]): string[] {
  return names
    .map(name => process.env[name])
    .filter((value): value is string => !!value)
}

function uniqueCandidates(candidates: string[]): string[] {
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    if (!candidate || seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of uniqueCandidates(candidates)) {
    if (await isFile(candidate)) return candidate
  }
  return null
}

function resourcesPath(): string {
  return process.resourcesPath || ''
}

function packagedRuntimeRootCandidates(): string[] {
  const root = resourcesPath()
  if (!root) return []
  return [
    path.join(root, 'native', 'office-preview-runtime'),
    path.join(root, 'office-preview-runtime'),
  ]
}

function configuredRuntimeRootCandidates(): string[] {
  const configuredRoots = pathCandidatesFromEnv(
    'TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE',
    'TABTIN_OFFICE_PREVIEW_RUNTIME_DIR',
    'TABTIN_OFFICE_PREVIEW_DEPENDENCIES_DIR',
    'CODEX_RUNTIME_DEPENDENCIES_DIR',
  )

  return uniqueCandidates([
    ...configuredRoots.flatMap(root => [
      root,
      path.join(root, 'dependencies'),
    ]),
  ])
}

function homeRuntimeRootCandidates(): string[] {
  const homes = uniqueCandidates([
    appPath('home') || '',
    os.homedir(),
  ])

  return homes.flatMap(home => [
    path.join(home, '.cache', 'tabtin-office-runtime', 'dependencies'),
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies'),
  ])
}

function officeRuntimeArchiveCandidates(): string[] {
  const root = resourcesPath()
  if (!root) return []
  return uniqueCandidates([
    path.join(root, 'native', 'office-preview-runtime', 'office-preview-runtime.tar.gz'),
    path.join(root, 'native', 'office-preview-runtime.tar.gz'),
    path.join(root, 'office-preview-runtime.tar.gz'),
  ])
}

function officeRuntimeManifestCandidates(): string[] {
  const root = resourcesPath()
  if (!root) return []
  return uniqueCandidates([
    path.join(root, 'native', 'office-preview-runtime', MANIFEST_FILE_NAME),
    path.join(root, 'office-preview-runtime', MANIFEST_FILE_NAME),
  ])
}

export function officeRuntimeToolCandidatesForRoot(root: string, command: 'soffice' | 'pdftoppm'): string[] {
  if (command === 'soffice') {
    return [
      path.join(root, 'bin', 'soffice'),
      path.join(root, 'bin', 'soffice.exe'),
      path.join(root, 'native', 'libreoffice-headless', 'bin', 'soffice'),
      path.join(root, 'native', 'libreoffice-headless', 'bin', 'soffice.exe'),
      path.join(root, 'native', 'libreoffice-headless', 'program', 'soffice.exe'),
      path.join(root, 'native', 'libreoffice-headless', 'libreoffice', 'LibreOfficeDev.app', 'Contents', 'MacOS', 'soffice'),
    ]
  }
  return [
    path.join(root, 'bin', 'pdftoppm'),
    path.join(root, 'bin', 'pdftoppm.exe'),
    path.join(root, 'native', 'poppler', 'bin', 'pdftoppm'),
    path.join(root, 'native', 'poppler', 'bin', 'pdftoppm.exe'),
  ]
}

export async function officeRuntimeRootHasTools(root: string): Promise<boolean> {
  return Promise.all([
    firstExistingFile(officeRuntimeToolCandidatesForRoot(root, 'soffice')),
    firstExistingFile(officeRuntimeToolCandidatesForRoot(root, 'pdftoppm')),
  ]).then(([sofficePath, pdftoppmPath]) => !!sofficePath && !!pdftoppmPath)
}

async function runtimeFromRoot(root: string, version?: string): Promise<OfficePreviewRuntime | null> {
  const [sofficePath, pdftoppmPath] = await Promise.all([
    firstExistingFile(officeRuntimeToolCandidatesForRoot(root, 'soffice')),
    firstExistingFile(officeRuntimeToolCandidatesForRoot(root, 'pdftoppm')),
  ])
  if (!sofficePath || !pdftoppmPath) return null
  return { root, sofficePath, pdftoppmPath, version }
}

async function firstRuntimeFromRoots(roots: string[]): Promise<OfficePreviewRuntime | null> {
  for (const root of uniqueCandidates(roots)) {
    const runtime = await runtimeFromRoot(root)
    if (runtime) return runtime
  }
  return null
}

function tarCommand(): string {
  if (process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH) return process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH
  if (process.platform === 'darwin') return '/usr/bin/tar'
  return process.platform === 'win32' ? 'tar.exe' : 'tar'
}

function sourceCacheKey(filePath: string, stat: { size: number; mtimeMs: number }): string {
  return crypto
    .createHash('sha256')
    .update(path.resolve(filePath))
    .update('\0')
    .update(String(stat.size))
    .update('\0')
    .update(String(Math.floor(stat.mtimeMs)))
    .digest('hex')
    .slice(0, 24)
}

async function assertArchiveHasSafeEntries(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync(tarCommand(), ['-tzf', archivePath], {
    timeout: RUNTIME_EXTRACT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized) continue
    const segments = normalized.split('/').filter(Boolean)
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      segments.includes('..')
    ) {
      throw new OfficePreviewRuntimeError(
        'OFFICE_RUNTIME_EXTRACT_FAILED',
        `Office preview runtime archive contains unsafe entry: ${entry}`,
      )
    }
  }
}

async function extractArchiveToRuntimeRoot(archivePath: string, runtimeRoot: string): Promise<string> {
  const stagingRoot = `${runtimeRoot}.staging`
  await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  await fsPromises.mkdir(stagingRoot, { recursive: true })

  try {
    await assertArchiveHasSafeEntries(archivePath)
    await execFileAsync(tarCommand(), ['-xzf', archivePath, '-C', stagingRoot], {
      timeout: RUNTIME_EXTRACT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    })

    if (!await officeRuntimeRootHasTools(stagingRoot)) {
      throw new OfficePreviewRuntimeError(
        'OFFICE_RUNTIME_TOOL_MISSING',
        'Office preview runtime archive does not contain soffice and pdftoppm',
      )
    }

    await fsPromises.rm(runtimeRoot, { recursive: true, force: true }).catch(() => {})
    await fsPromises.rename(stagingRoot, runtimeRoot)
    return runtimeRoot
  } catch (error) {
    await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    if (error instanceof OfficePreviewRuntimeError) throw error
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_EXTRACT_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function extractBundledOfficeRuntime(): Promise<string | null> {
  const archivePath = await firstExistingFile(officeRuntimeArchiveCandidates())
  if (!archivePath) return null
  if (bundledRuntimeExtractionPromise) return bundledRuntimeExtractionPromise

  bundledRuntimeExtractionPromise = (async () => {
    const archiveStat = await fsPromises.stat(archivePath)
    const cacheKey = sourceCacheKey(archivePath, archiveStat)
    const runtimeRoot = path.join(officeRuntimeCacheRoot(), cacheKey)
    if (await officeRuntimeRootHasTools(runtimeRoot)) return runtimeRoot

    try {
      return await extractArchiveToRuntimeRoot(archivePath, runtimeRoot)
    } catch (error) {
      log.warn('解压内置 office runtime 失败', error instanceof Error ? error.message : String(error))
      return null
    }
  })()

  return bundledRuntimeExtractionPromise
}

function sanitizeRuntimeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '-')
}

function expectedPlatform(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  return `${process.platform}-${arch}`
}

function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false
  const normalized = value.replace(/\\/g, '/')
  return !normalized.split('/').includes('..')
}

function parseRuntimeManifest(raw: string, manifestPath: string): OfficePreviewRuntimeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_MANIFEST_INVALID',
      `Office preview runtime manifest is not valid JSON: ${manifestPath}`,
    )
  }

  const manifest = parsed as Partial<OfficePreviewRuntimeManifest>
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.version ||
    !manifest.platform ||
    !manifest.archiveName ||
    !manifest.sha256 ||
    !manifest.tools ||
    !manifest.tools.soffice ||
    !manifest.tools.pdftoppm ||
    !isSafeRelativePath(manifest.archiveName) ||
    !isSafeRelativePath(manifest.tools.soffice) ||
    !isSafeRelativePath(manifest.tools.pdftoppm)
  ) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_MANIFEST_INVALID',
      `Office preview runtime manifest is missing required fields: ${manifestPath}`,
    )
  }

  if (manifest.platform !== expectedPlatform()) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_MANIFEST_INVALID',
      `Office preview runtime manifest platform ${manifest.platform} does not match ${expectedPlatform()}`,
    )
  }

  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_MANIFEST_INVALID',
      `Office preview runtime manifest has invalid sha256: ${manifestPath}`,
    )
  }

  if (manifest.size !== undefined && (!Number.isSafeInteger(manifest.size) || manifest.size <= 0)) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_MANIFEST_INVALID',
      `Office preview runtime manifest has invalid size: ${manifestPath}`,
    )
  }

  if (manifest.url !== undefined) {
    try {
      const url = new URL(manifest.url)
      const isLoopbackHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      if (url.protocol !== 'https:' && !isLoopbackHttp) throw new Error('unsupported protocol')
    } catch {
      throw new OfficePreviewRuntimeError(
        'OFFICE_RUNTIME_MANIFEST_INVALID',
        `Office preview runtime manifest has invalid download URL: ${manifestPath}`,
      )
    }
  }

  return manifest as OfficePreviewRuntimeManifest
}

async function readRuntimeManifest(manifestPath: string): Promise<OfficePreviewRuntimeManifest> {
  const raw = await fsPromises.readFile(manifestPath, 'utf-8')
  return parseRuntimeManifest(raw, manifestPath)
}

function toolPathFromManifest(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.replace(/\\/g, '/').split('/'))
}

async function runtimeFromManifestRoot(root: string, manifest: OfficePreviewRuntimeManifest): Promise<OfficePreviewRuntime | null> {
  const sofficePath = toolPathFromManifest(root, manifest.tools.soffice)
  const pdftoppmPath = toolPathFromManifest(root, manifest.tools.pdftoppm)
  if (await isFile(sofficePath) && await isFile(pdftoppmPath)) {
    return { root, sofficePath, pdftoppmPath, version: manifest.version }
  }
  return runtimeFromRoot(root, manifest.version)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function assertArchiveMatchesManifest(archivePath: string, manifest: OfficePreviewRuntimeManifest): Promise<void> {
  const stat = await fsPromises.stat(archivePath)
  if (manifest.size !== undefined && stat.size !== manifest.size) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_CHECKSUM_MISMATCH',
      `Office preview runtime archive size mismatch: expected ${manifest.size}, got ${stat.size}`,
    )
  }

  const actualSha256 = await sha256File(archivePath)
  if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_CHECKSUM_MISMATCH',
      'Office preview runtime archive checksum mismatch',
    )
  }
}

async function readInstalledMarker(): Promise<InstalledRuntimeMarker | null> {
  try {
    const raw = await fsPromises.readFile(currentRuntimeMarkerPath(), 'utf-8')
    const parsed = JSON.parse(raw) as InstalledRuntimeMarker
    if (!parsed.root || !parsed.version || !parsed.sha256 || !parsed.platform) return null
    return parsed
  } catch {
    return null
  }
}

async function writeInstalledMarker(marker: InstalledRuntimeMarker): Promise<void> {
  await fsPromises.mkdir(officeRuntimeCacheRoot(), { recursive: true })
  await fsPromises.writeFile(currentRuntimeMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8')
}

function manifestRuntimeRoot(manifest: OfficePreviewRuntimeManifest): string {
  return path.join(
    officeRuntimeCacheRoot(),
    `${sanitizeRuntimeVersion(manifest.version)}-${manifest.sha256.slice(0, 12)}`,
  )
}

async function cachedRuntimeFromManifest(manifest: OfficePreviewRuntimeManifest): Promise<OfficePreviewRuntime | null> {
  const marker = await readInstalledMarker()
  const runtimeRoot = manifestRuntimeRoot(manifest)
  if (
    marker &&
    marker.version === manifest.version &&
    marker.platform === manifest.platform &&
    marker.sha256.toLowerCase() === manifest.sha256.toLowerCase() &&
    path.resolve(marker.root) === path.resolve(runtimeRoot)
  ) {
    const runtime = await runtimeFromManifestRoot(marker.root, manifest)
    if (runtime) return runtime
  }
  return null
}

function localArchiveCandidatesForManifest(manifestPath: string, manifest: OfficePreviewRuntimeManifest): string[] {
  const manifestDir = path.dirname(manifestPath)
  return uniqueCandidates([
    path.join(manifestDir, manifest.archiveName),
    ...officeRuntimeArchiveCandidates(),
  ])
}

async function downloadFile(url: string, outputPath: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 5) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_DOWNLOAD_FAILED',
      'Office preview runtime download redirected too many times',
    )
  }

  const parsed = new URL(url)
  const client = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null
  if (!client) {
    throw new OfficePreviewRuntimeError(
      'OFFICE_RUNTIME_DOWNLOAD_FAILED',
      `Unsupported Office preview runtime URL protocol: ${parsed.protocol}`,
    )
  }

  await new Promise<void>((resolve, reject) => {
    const request = client.get(parsed, response => {
      const statusCode = response.statusCode || 0
      const location = response.headers.location
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume()
        downloadFile(new URL(location, parsed).toString(), outputPath, redirectCount + 1).then(resolve, reject)
        return
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(new OfficePreviewRuntimeError(
          'OFFICE_RUNTIME_DOWNLOAD_FAILED',
          `Office preview runtime download failed with HTTP ${statusCode}`,
        ))
        return
      }

      const stream = fs.createWriteStream(outputPath, { flags: 'wx' })
      pipeline(response, stream).then(resolve, reject)
    })

    request.setTimeout(RUNTIME_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error('Office preview runtime download timed out'))
    })
    request.on('error', error => {
      reject(new OfficePreviewRuntimeError(
        'OFFICE_RUNTIME_DOWNLOAD_FAILED',
        error instanceof Error ? error.message : String(error),
      ))
    })
  })
}

async function obtainArchiveForManifest(manifestPath: string, manifest: OfficePreviewRuntimeManifest): Promise<string> {
  const localArchive = await firstExistingFile(localArchiveCandidatesForManifest(manifestPath, manifest))
  if (localArchive) {
    await assertArchiveMatchesManifest(localArchive, manifest)
    return localArchive
  }

  if (manifest.url) {
    const downloadsRoot = path.join(officeRuntimeCacheRoot(), 'downloads')
    await fsPromises.mkdir(downloadsRoot, { recursive: true })
    const archivePath = path.join(
      downloadsRoot,
      `${sanitizeRuntimeVersion(manifest.version)}-${manifest.sha256.slice(0, 12)}.tar.gz`,
    )
    if (await isFile(archivePath)) {
      try {
        await assertArchiveMatchesManifest(archivePath, manifest)
        return archivePath
      } catch {
        await fsPromises.rm(archivePath, { force: true })
      }
    }

    const tempPath = `${archivePath}.download`
    await fsPromises.rm(tempPath, { force: true }).catch(() => {})
    try {
      log.info('首次预览下载 Office runtime', { platform: manifest.platform, version: manifest.version })
      await downloadFile(manifest.url, tempPath)
      await assertArchiveMatchesManifest(tempPath, manifest)
      await fsPromises.rename(tempPath, archivePath)
      return archivePath
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => {})
      if (error instanceof OfficePreviewRuntimeError) throw error
      throw new OfficePreviewRuntimeError(
        'OFFICE_RUNTIME_DOWNLOAD_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  throw new OfficePreviewRuntimeError(
    'OFFICE_RUNTIME_ARCHIVE_MISSING',
    `Office preview runtime archive is not bundled: ${manifest.archiveName}`,
  )
}

async function ensureRuntimeFromManifest(): Promise<OfficePreviewRuntime | null> {
  const manifestPath = await firstExistingFile(officeRuntimeManifestCandidates())
  if (!manifestPath) return null
  if (!manifestRuntimePromise) {
    manifestRuntimePromise = (async () => {
      const manifest = await readRuntimeManifest(manifestPath)
      const cachedRuntime = await cachedRuntimeFromManifest(manifest)
      if (cachedRuntime) return cachedRuntime

      const archivePath = await obtainArchiveForManifest(manifestPath, manifest)
      const runtimeRoot = manifestRuntimeRoot(manifest)
      await extractArchiveToRuntimeRoot(archivePath, runtimeRoot)
      const runtime = await runtimeFromManifestRoot(runtimeRoot, manifest)
      if (!runtime) {
        throw new OfficePreviewRuntimeError(
          'OFFICE_RUNTIME_TOOL_MISSING',
          'Office preview runtime extracted successfully but required tools were not found',
        )
      }

      await writeInstalledMarker({
        version: manifest.version,
        platform: manifest.platform,
        sha256: manifest.sha256,
        installedAt: new Date().toISOString(),
        root: runtime.root,
      })
      return runtime
    })()
  }

  try {
    return await manifestRuntimePromise
  } catch (error) {
    manifestRuntimePromise = null
    throw error
  }
}

export async function ensureOfficePreviewRuntime(): Promise<OfficePreviewRuntime | null> {
  const configuredRuntime = await firstRuntimeFromRoots(configuredRuntimeRootCandidates())
  if (configuredRuntime) return configuredRuntime

  const packagedRuntime = await firstRuntimeFromRoots(packagedRuntimeRootCandidates())
  if (packagedRuntime) return packagedRuntime

  const bundledRuntimeRoot = await extractBundledOfficeRuntime()
  if (bundledRuntimeRoot) {
    const bundledRuntime = await runtimeFromRoot(bundledRuntimeRoot)
    if (bundledRuntime) return bundledRuntime
  }

  const manifestRuntime = await ensureRuntimeFromManifest()
  if (manifestRuntime) return manifestRuntime

  return firstRuntimeFromRoots(homeRuntimeRootCandidates())
}

export const __officePreviewRuntimeManagerTestInternals = {
  officeRuntimeRootHasTools,
  officeRuntimeToolCandidatesForRoot,
  parseRuntimeManifest,
  resetOfficePreviewRuntimeState() {
    bundledRuntimeExtractionPromise = null
    manifestRuntimePromise = null
  },
}

import { app } from 'electron'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { createLogger } from '../logger'
import {
  LIBREOFFICE_CJK_PREVIEW_CACHE_VERSION,
  writeLibreOfficeCjkFallbackProfile,
} from './office-preview-cjk-fonts'
import {
  ensureOfficePreviewRuntime,
  officeRuntimeRootHasTools,
  officeRuntimeToolCandidatesForRoot,
} from './office-preview-runtime-manager'

const log = createLogger('OfficePreviewRenderer')

const execFileAsync = promisify(execFile)

const OFFICE_PREVIEW_EXTENSIONS = new Set(['.pptx', '.doc', '.docx', '.xlsx'])
const RENDER_TIMEOUT_MS = 120_000
const PAGE_RENDER_DPI = 144
const WINDOWS_POWERPOINT_CACHE_VERSION = 'windows-powerpoint-v1'

export interface OfficePreviewPage {
  index: number
  path: string
  mime: 'image/png'
}

export interface OfficePreviewData {
  kind: 'rendered-office'
  source: 'libreoffice' | 'powerpoint'
  pdfPath?: string
  pages: OfficePreviewPage[]
  pageCount: number
  cached: boolean
}

interface CacheManifest {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  source?: 'libreoffice' | 'powerpoint'
  pdfPath?: string
  pages: OfficePreviewPage[]
}

type OfficePreviewExec = (
  executable: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<unknown>

const executeOfficePreviewCommand: OfficePreviewExec = async (executable, args, options) => {
  await execFileAsync(executable, args, options)
}

export function supportsRenderedOfficePreview(filePath: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function officePreviewCacheRoot(): string {
  return path.join(app.getPath('userData'), 'office-preview-cache')
}

function sourceCacheKey(filePath: string, stat: { size: number; mtimeMs: number }): string {
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(filePath))
    .update('\0')
    .update(String(stat.size))
    .update('\0')
    .update(String(Math.floor(stat.mtimeMs)))
  const rendererVersion = officePreviewRendererCacheVersion(filePath)
  if (rendererVersion) hash.update('\0').update(rendererVersion)
  return hash.digest('hex')
    .slice(0, 24)
}

function officePreviewRendererCacheVersion(filePath: string, platform = process.platform): string | null {
  const versions = [LIBREOFFICE_CJK_PREVIEW_CACHE_VERSION]
  if (platform === 'win32' && path.extname(filePath).toLowerCase() === '.pptx') {
    versions.push(WINDOWS_POWERPOINT_CACHE_VERSION)
  }
  return versions.join('+')
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

function pathCandidatesFromPath(command: string): string[] {
  const searchPath = process.env.PATH || ''
  return searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .map(dir => path.join(dir, command))
}

function pathCandidatesFromMacStandardBins(command: string): string[] {
  if (process.platform !== 'darwin') return []
  return [
    path.join('/opt/homebrew/bin', command),
    path.join('/usr/local/bin', command),
  ]
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

async function resolveSofficePath(): Promise<string | null> {
  const resourcesPath = process.resourcesPath || ''
  const staticCandidates = [
    ...pathCandidatesFromEnv('TABTIN_OFFICE_PREVIEW_SOFFICE_PATH', 'SOFFICE_PATH', 'LIBREOFFICE_PATH'),
    path.join(resourcesPath, 'native', 'libreoffice-headless', 'bin', 'soffice'),
    path.join(resourcesPath, 'native', 'libreoffice-headless', 'bin', 'soffice.exe'),
    path.join(resourcesPath, 'native', 'libreoffice-headless', 'program', 'soffice.exe'),
    path.join(resourcesPath, 'native', 'libreoffice-headless', 'libreoffice', 'LibreOfficeDev.app', 'Contents', 'MacOS', 'soffice'),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ...pathCandidatesFromMacStandardBins('soffice'),
    ...pathCandidatesFromMacStandardBins('libreoffice'),
    ...pathCandidatesFromPath('soffice'),
    ...pathCandidatesFromPath('soffice.exe'),
    ...pathCandidatesFromPath('libreoffice'),
    ...pathCandidatesFromPath('libreoffice.exe'),
  ]
  const staticMatch = await firstExistingFile(staticCandidates)
  if (staticMatch) return staticMatch

  try {
    const runtime = await ensureOfficePreviewRuntime()
    if (runtime?.sofficePath && await isFile(runtime.sofficePath)) return runtime.sofficePath
  } catch {
    // Missing bundled archive/manifest should not block env or PATH fallbacks above.
  }
  return null
}

async function resolvePdfToPpmPath(): Promise<string | null> {
  const resourcesPath = process.resourcesPath || ''
  const staticCandidates = [
    ...pathCandidatesFromEnv('TABTIN_OFFICE_PREVIEW_PDFTOPPM_PATH', 'PDFTOPPM_PATH'),
    path.join(resourcesPath, 'native', 'poppler', 'bin', 'pdftoppm'),
    path.join(resourcesPath, 'native', 'poppler', 'bin', 'pdftoppm.exe'),
    path.join(resourcesPath, 'bin', 'pdftoppm'),
    path.join(resourcesPath, 'bin', 'pdftoppm.exe'),
    ...pathCandidatesFromMacStandardBins('pdftoppm'),
    ...pathCandidatesFromPath('pdftoppm'),
    ...pathCandidatesFromPath('pdftoppm.exe'),
  ]
  const staticMatch = await firstExistingFile(staticCandidates)
  if (staticMatch) return staticMatch

  try {
    const runtime = await ensureOfficePreviewRuntime()
    if (runtime?.pdftoppmPath && await isFile(runtime.pdftoppmPath)) return runtime.pdftoppmPath
  } catch {
    // Missing bundled archive/manifest should not block env or PATH fallbacks above.
  }
  return null
}

export const __officePreviewRendererTestInternals = {
  officeRuntimeRootHasTools,
  officeRuntimeToolCandidatesForRoot,
  buildPowerPointExportCommand,
  buildOfficeToPdfArgs,
  officePreviewRendererCacheVersion,
  renderPowerPointPages,
  sortRenderedPageFiles,
}

async function readManifest(manifestPath: string): Promise<CacheManifest | null> {
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as CacheManifest
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return null
    if (parsed.pdfPath && !fs.existsSync(parsed.pdfPath)) return null
    if (parsed.pages.some(page => !page.path || !fs.existsSync(page.path))) return null
    return parsed
  } catch {
    return null
  }
}

async function writeManifest(manifestPath: string, manifest: CacheManifest): Promise<void> {
  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

function sortRenderedPageFiles(files: string[]): string[] {
  return files.sort((a, b) => {
    const an = Number(a.match(/(\d+)(?=\.png$)/i)?.[1] || 0)
    const bn = Number(b.match(/(\d+)(?=\.png$)/i)?.[1] || 0)
    return an - bn
  })
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function buildPowerPointExportCommand(sourcePath: string, outputDir: string): { executable: string; args: string[] } {
  const script = `
$ErrorActionPreference = 'Stop'
$sourcePath = ${quotePowerShellLiteral(path.resolve(sourcePath))}
$outputDir = ${quotePowerShellLiteral(path.resolve(outputDir))}
$powerPoint = $null
$presentation = $null
$activePowerPoint = $null
$ownsPowerPoint = $true
try {
  try {
    $activePowerPoint = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
    $ownsPowerPoint = $false
  } catch [Runtime.InteropServices.COMException] {
    $ownsPowerPoint = $true
  }
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($sourcePath, $true, $true, $false)
  $ratio = [double]$presentation.PageSetup.SlideHeight / [double]$presentation.PageSetup.SlideWidth
  $width = 1920
  $height = [Math]::Max(1, [Math]::Round($width * $ratio))
  $presentation.Export($outputDir, 'PNG', $width, $height)
} finally {
  if ($presentation -ne $null) {
    try { $presentation.Close() } catch {}
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) } catch {}
  }
  if ($powerPoint -ne $null) {
    try {
      if ($ownsPowerPoint -and $powerPoint.Presentations.Count -eq 0) { $powerPoint.Quit() }
    } catch {}
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) } catch {}
  }
  if ($activePowerPoint -ne $null) {
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($activePowerPoint) } catch {}
  }
}
`
  return {
    executable: process.env.TABTIN_OFFICE_PREVIEW_POWERSHELL_PATH || 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  }
}

async function renderPowerPointPages(
  sourcePath: string,
  outputDir: string,
  execute: OfficePreviewExec = executeOfficePreviewCommand,
): Promise<OfficePreviewPage[]> {
  await fsPromises.mkdir(outputDir, { recursive: true })
  const command = buildPowerPointExportCommand(sourcePath, outputDir)
  try {
    await execute(command.executable, command.args, {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    const exitCode = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    const suffix = /^-?\d+$/.test(exitCode) ? ` (exit ${exitCode})` : ''
    throw new Error(`PowerPoint preview failed${suffix}`)
  }

  const files = sortRenderedPageFiles(
    (await fsPromises.readdir(outputDir)).filter(name => /\.png$/i.test(name)),
  )
  if (files.length === 0) throw new Error('PowerPoint did not produce slide images')

  return files.map((name, index) => ({
    index,
    path: path.join(outputDir, name),
    mime: 'image/png' as const,
  }))
}

function buildOfficeToPdfArgs({
  sourcePath,
  outputDir,
  profileDir,
  platform = process.platform,
}: {
  sourcePath: string
  outputDir: string
  profileDir: string
  platform?: NodeJS.Platform
}): string[] {
  return [
    '--headless',
    // macOS 仍可能为 LibreOffice.app 显示 Dock 项；--invisible 阻止其参与前台激活。
    ...(platform === 'darwin' ? ['--invisible'] : []),
    '--nologo',
    '--nofirststartwizard',
    '--nodefault',
    '--norestore',
    '--nolockcheck',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to',
    'pdf',
    '--outdir',
    outputDir,
    sourcePath,
  ]
}

async function convertOfficeToPdf(sourcePath: string, outputDir: string, sofficePath: string): Promise<string> {
  const before = new Set((await fsPromises.readdir(outputDir).catch(() => [])).filter(name => name.endsWith('.pdf')))
  const profileDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabtin-office-profile-'))

  try {
    const fallback = await writeLibreOfficeCjkFallbackProfile(profileDir)
    if (fallback) {
      log.info('LibreOffice CJK font fallback ready', {
        substituteFont: fallback.name,
        fontFiles: fallback.files.length,
      })
    } else {
      log.warn('LibreOffice CJK font fallback unavailable; Chinese glyphs may render as boxes')
    }
    await execFileAsync(sofficePath, buildOfficeToPdfArgs({
      sourcePath,
      outputDir,
      profileDir,
    }), { timeout: RENDER_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 })
  } finally {
    await fsPromises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }

  const after = (await fsPromises.readdir(outputDir)).filter(name => name.endsWith('.pdf'))
  const created = after.find(name => !before.has(name)) || after[0]
  if (!created) throw new Error('LibreOffice did not produce a PDF')
  return path.join(outputDir, created)
}

async function renderPdfPages(pdfPath: string, outputDir: string, pdftoppmPath: string | null): Promise<OfficePreviewPage[]> {
  if (!pdftoppmPath) return []

  await fsPromises.mkdir(outputDir, { recursive: true })
  const outputPrefix = path.join(outputDir, 'page')
  await execFileAsync(pdftoppmPath, [
    '-png',
    '-r',
    String(PAGE_RENDER_DPI),
    pdfPath,
    outputPrefix,
  ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 })

  const files = sortRenderedPageFiles(
    (await fsPromises.readdir(outputDir))
      .filter(name => /^page-\d+\.png$/.test(name)),
  )

  return files.map((name, index) => ({
    index,
    path: path.join(outputDir, name),
    mime: 'image/png' as const,
  }))
}

export async function renderOfficePreview(filePath: string, stat: { size: number; mtimeMs: number }): Promise<OfficePreviewData> {
  if (!supportsRenderedOfficePreview(filePath)) {
    throw new Error('Unsupported office preview format')
  }

  const cacheDir = path.join(officePreviewCacheRoot(), sourceCacheKey(filePath, stat))
  const pagesDir = path.join(cacheDir, 'pages')
  const manifestPath = path.join(cacheDir, 'manifest.json')
  await fsPromises.mkdir(cacheDir, { recursive: true })

  const cached = await readManifest(manifestPath)
  if (
    cached &&
    cached.sourcePath === path.resolve(filePath) &&
    cached.sourceSize === stat.size &&
    Math.floor(cached.sourceMtimeMs) === Math.floor(stat.mtimeMs)
  ) {
    return {
      kind: 'rendered-office',
      source: cached.source || 'libreoffice',
      pdfPath: cached.pdfPath,
      pages: cached.pages,
      pageCount: cached.pages.length,
      cached: true,
    }
  }

  await fsPromises.rm(pagesDir, { recursive: true, force: true }).catch(() => {})
  let source: OfficePreviewData['source'] = 'libreoffice'
  let pdfPath: string | undefined
  let pages: OfficePreviewPage[] = []
  let powerPointError: unknown

  if (process.platform === 'win32' && path.extname(filePath).toLowerCase() === '.pptx') {
    try {
      pages = await renderPowerPointPages(filePath, pagesDir)
      source = 'powerpoint'
    } catch (error) {
      powerPointError = error
      await fsPromises.rm(pagesDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (pages.length === 0) {
    const sofficePath = await resolveSofficePath()
    if (!sofficePath) {
      const detail = powerPointError instanceof Error ? `; PowerPoint: ${powerPointError.message}` : ''
      throw new Error(`Office preview renderer unavailable: LibreOffice/soffice not found${detail}`)
    }
    pdfPath = await convertOfficeToPdf(filePath, cacheDir, sofficePath)
    pages = await renderPdfPages(pdfPath, pagesDir, await resolvePdfToPpmPath())
    if (pages.length === 0) throw new Error('Office preview renderer unavailable: pdftoppm not found')
  }

  await writeManifest(manifestPath, {
    sourcePath: path.resolve(filePath),
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    source,
    pdfPath,
    pages,
  })

  return {
    kind: 'rendered-office',
    source,
    pdfPath,
    pages,
    pageCount: pages.length,
    cached: false,
  }
}

/**
 * 云端 Office 文件没有本地路径。按内容哈希落到受控缓存目录后复用同一套
 * LibreOffice 只读渲染链路；原始文件名只用于选择受支持的扩展名。
 */
export async function renderOfficePreviewBuffer(
  fileName: string,
  data: ArrayBuffer | Uint8Array,
): Promise<OfficePreviewData> {
  const extension = path.extname(path.basename(fileName)).toLowerCase()
  if (!OFFICE_PREVIEW_EXTENSIONS.has(extension)) {
    throw new Error('Unsupported office preview format')
  }

  const bytes = Buffer.from(
    data instanceof Uint8Array ? data : new Uint8Array(data),
  )
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex')
  const sourceDir = path.join(officePreviewCacheRoot(), 'remote-sources')
  const sourcePath = path.join(sourceDir, `${contentHash}${extension}`)
  await fsPromises.mkdir(sourceDir, { recursive: true })
  if (!await isFile(sourcePath)) {
    await fsPromises.writeFile(sourcePath, bytes, { flag: 'wx' }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
  }
  const stat = await fsPromises.stat(sourcePath)
  return renderOfficePreview(sourcePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  })
}

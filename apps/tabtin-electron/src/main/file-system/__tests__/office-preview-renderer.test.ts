import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const itWithExecutableScriptFixtures = process.platform === 'win32' ? it.skip : it
const testTarPath = findTestTarPath()
const itWithTarFixtures = testTarPath ? it : it.skip

const electronPaths = vi.hoisted(() => ({
  home: '',
  userData: '',
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return electronPaths.home
      if (name === 'userData') return electronPaths.userData
      return electronPaths.home || os.tmpdir()
    }),
  },
}))

import { __officePreviewRuntimeManagerTestInternals, ensureOfficePreviewRuntime } from '../office-preview-runtime-manager'
import {
  __officePreviewRendererTestInternals,
  renderOfficePreview,
  supportsRenderedOfficePreview,
} from '../office-preview-renderer'

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o755 })
  await fs.chmod(filePath, 0o755)
}

function tarCommand(): string {
  if (process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH) return process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH
  if (process.platform === 'darwin') return '/usr/bin/tar'
  return process.platform === 'win32' ? 'tar.exe' : 'tar'
}

function findTestTarPath(): string | null {
  if (process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH) return process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH
  if (process.platform !== 'win32') return tarCommand()
  for (const candidate of [
    'C:\\Windows\\System32\\tar.exe',
    'C:\\Git\\usr\\bin\\tar.exe',
    'C:\\Program Files\\Git\\usr\\bin\\tar.exe',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

describe('office-preview-renderer runtime discovery', () => {
  let tempRoot: string
  let previousPath: string | undefined
  let previousSoffice: string | undefined
  let previousPdfToPpm: string | undefined
  let previousRuntimeSource: string | undefined
  let previousTarPath: string | undefined
  let previousHome: string | undefined
  let previousResourcesPath: unknown

  it('recognizes legacy .doc as a read-only Office preview format', () => {
    expect(supportsRenderedOfficePreview('legacy.doc')).toBe(true)
  })

  it('sorts localized PowerPoint slide image names by their numeric suffix', () => {
    expect(__officePreviewRendererTestInternals.sortRenderedPageFiles([
      '幻灯片10.PNG',
      '幻灯片2.PNG',
      '幻灯片1.PNG',
    ])).toEqual(['幻灯片1.PNG', '幻灯片2.PNG', '幻灯片10.PNG'])
  })

  it('versions only the Windows PowerPoint cache path', () => {
    expect(__officePreviewRendererTestInternals.officePreviewRendererCacheVersion('deck.pptx', 'win32'))
      .toBe('lo-cjk-subst-v1+windows-powerpoint-v1')
    expect(__officePreviewRendererTestInternals.officePreviewRendererCacheVersion('deck.pptx', 'darwin'))
      .toBe('lo-cjk-subst-v1')
    expect(__officePreviewRendererTestInternals.officePreviewRendererCacheVersion('document.docx', 'win32'))
      .toBe('lo-cjk-subst-v1')
  })

  it('starts the macOS LibreOffice preview helper without a Dock-facing UI', () => {
    const args = __officePreviewRendererTestInternals.buildOfficeToPdfArgs({
      sourcePath: '/tmp/deck.pptx',
      outputDir: '/tmp/preview',
      profileDir: '/tmp/profile',
      platform: 'darwin',
    })

    expect(args).toEqual([
      '--headless',
      '--invisible',
      '--nologo',
      '--nofirststartwizard',
      '--nodefault',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=${pathToFileURL('/tmp/profile').href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      '/tmp/preview',
      '/tmp/deck.pptx',
    ])
  })

  it('keeps the existing non-macOS LibreOffice invocation unchanged', () => {
    const args = __officePreviewRendererTestInternals.buildOfficeToPdfArgs({
      sourcePath: '/tmp/deck.pptx',
      outputDir: '/tmp/preview',
      profileDir: '/tmp/profile',
      platform: 'win32',
    })

    expect(args).toEqual([
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--nodefault',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=${pathToFileURL('/tmp/profile').href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      '/tmp/preview',
      '/tmp/deck.pptx',
    ])
  })

  it('builds an encoded PowerPoint export command that preserves quoted paths', () => {
    const command = __officePreviewRendererTestInternals.buildPowerPointExportCommand(
      path.join(os.tmpdir(), "teacher's deck.pptx"),
      path.join(os.tmpdir(), 'preview pages'),
    )
    const encodedScript = command.args.at(-1) || ''
    const script = Buffer.from(encodedScript, 'base64').toString('utf16le')

    expect(command.executable).toMatch(/powershell/i)
    expect(script).toContain("teacher''s deck.pptx")
    expect(script).toContain("GetActiveObject('PowerPoint.Application')")
    expect(script).toContain('$ownsPowerPoint')
    expect(script).toContain('$powerPoint.Presentations.Count -eq 0')
    expect(script).toContain('Presentations.Open')
    expect(script).toContain('presentation.Export')
    expect(command.args).not.toContain('Bypass')
  })

  it('maps localized PowerPoint export output into ordered preview pages', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-powerpoint-pages-test-'))
    try {
      const pages = await __officePreviewRendererTestInternals.renderPowerPointPages(
        path.join(os.tmpdir(), 'deck.pptx'),
        outputDir,
        async () => {
          await fs.writeFile(path.join(outputDir, '幻灯片2.PNG'), 'page 2')
          await fs.writeFile(path.join(outputDir, '幻灯片1.PNG'), 'page 1')
        },
      )

      expect(pages.map(page => path.basename(page.path))).toEqual(['幻灯片1.PNG', '幻灯片2.PNG'])
      expect(pages.map(page => page.index)).toEqual([0, 1])
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('does not expose the encoded command or local paths when PowerPoint fails', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-powerpoint-error-test-'))
    const privatePath = path.join(os.tmpdir(), 'private folder', 'secret deck.pptx')
    try {
      await expect(__officePreviewRendererTestInternals.renderPowerPointPages(
        privatePath,
        outputDir,
        async () => {
          const error = new Error(`Command failed: powershell.exe -EncodedCommand PRIVATE ${privatePath}`) as Error & { code: number }
          error.code = 7
          throw error
        },
      )).rejects.toThrow('PowerPoint preview failed (exit 7)')

      await __officePreviewRendererTestInternals.renderPowerPointPages(
        privatePath,
        outputDir,
        async () => {
          throw new Error(`-EncodedCommand PRIVATE ${privatePath}`)
        },
      ).catch(error => {
        expect(String(error)).not.toContain('EncodedCommand')
        expect(String(error)).not.toContain(privatePath)
      })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  beforeEach(async () => {
    __officePreviewRuntimeManagerTestInternals.resetOfficePreviewRuntimeState()
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-office-preview-test-'))
    electronPaths.home = path.join(tempRoot, 'home')
    electronPaths.userData = path.join(tempRoot, 'user-data')
    previousPath = process.env.PATH
    previousSoffice = process.env.TABTIN_OFFICE_PREVIEW_SOFFICE_PATH
    previousPdfToPpm = process.env.TABTIN_OFFICE_PREVIEW_PDFTOPPM_PATH
    previousRuntimeSource = process.env.TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE
    previousTarPath = process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH
    previousHome = process.env.HOME
    previousResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    process.env.PATH = '/usr/bin:/bin'
    process.env.HOME = electronPaths.home
    delete process.env.TABTIN_OFFICE_PREVIEW_SOFFICE_PATH
    delete process.env.TABTIN_OFFICE_PREVIEW_PDFTOPPM_PATH
    delete process.env.TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE
    if (testTarPath) process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH = testTarPath

    const runtimeBin = path.join(
      electronPaths.home,
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'bin',
    )
    await fs.mkdir(runtimeBin, { recursive: true })
    await writeExecutable(path.join(runtimeBin, 'soffice'), `#!/usr/bin/env bash
set -euo pipefail
outdir=""
source=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --outdir)
      outdir="$2"
      shift 2
      ;;
    *)
      source="$1"
      shift
      ;;
  esac
done
name="$(basename "$source")"
base="\${name%.*}"
mkdir -p "$outdir"
printf 'pdf' > "$outdir/$base.pdf"
`)
    await writeExecutable(path.join(runtimeBin, 'pdftoppm'), `#!/usr/bin/env bash
set -euo pipefail
prefix="\${@: -1}"
mkdir -p "$(dirname "$prefix")"
printf 'png' > "$prefix-1.png"
`)
  })

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousSoffice === undefined) delete process.env.TABTIN_OFFICE_PREVIEW_SOFFICE_PATH
    else process.env.TABTIN_OFFICE_PREVIEW_SOFFICE_PATH = previousSoffice
    if (previousPdfToPpm === undefined) delete process.env.TABTIN_OFFICE_PREVIEW_PDFTOPPM_PATH
    else process.env.TABTIN_OFFICE_PREVIEW_PDFTOPPM_PATH = previousPdfToPpm
    if (previousRuntimeSource === undefined) delete process.env.TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE
    else process.env.TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE = previousRuntimeSource
    if (previousTarPath === undefined) delete process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH
    else process.env.TABTIN_OFFICE_PREVIEW_TAR_PATH = previousTarPath
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    Object.defineProperty(process, 'resourcesPath', {
      value: previousResourcesPath,
      configurable: true,
    })
    await fs.rm(tempRoot, { recursive: true, force: true })
    __officePreviewRuntimeManagerTestInternals.resetOfficePreviewRuntimeState()
  })

  it('recognizes Windows .exe tool names inside runtime roots', async () => {
    const runtimeRoot = path.join(tempRoot, 'windows-runtime')
    const runtimeBin = path.join(runtimeRoot, 'bin')
    await fs.mkdir(runtimeBin, { recursive: true })
    await fs.writeFile(path.join(runtimeBin, 'soffice.exe'), '')
    await fs.writeFile(path.join(runtimeBin, 'pdftoppm.exe'), '')

    const sofficeCandidates = __officePreviewRendererTestInternals.officeRuntimeToolCandidatesForRoot(runtimeRoot, 'soffice')
    const pdfToPpmCandidates = __officePreviewRendererTestInternals.officeRuntimeToolCandidatesForRoot(runtimeRoot, 'pdftoppm')

    expect(sofficeCandidates).toContain(path.join(runtimeRoot, 'bin', 'soffice.exe'))
    expect(pdfToPpmCandidates).toContain(path.join(runtimeRoot, 'bin', 'pdftoppm.exe'))
    await expect(__officePreviewRendererTestInternals.officeRuntimeRootHasTools(runtimeRoot)).resolves.toBe(true)
  })

  itWithExecutableScriptFixtures('uses the local office runtime when GUI launch PATH does not include office tools', async () => {
    const sourcePath = path.join(tempRoot, 'deck.pptx')
    await fs.writeFile(sourcePath, 'fake pptx')
    const stat = await fs.stat(sourcePath)

    const preview = await renderOfficePreview(sourcePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })

    expect(preview.pageCount).toBe(1)
    expect(preview.pdfPath).toContain('deck.pdf')
    expect(preview.pages[0]?.path).toContain('page-1.png')
  })

  itWithExecutableScriptFixtures('uses the bundled Windows office preview runtime archive from Electron resources', async () => {
    await fs.rm(path.join(electronPaths.home, '.cache'), { recursive: true, force: true })

    const resourcesRoot = path.join(tempRoot, 'resources')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesRoot,
      configurable: true,
    })

    const archiveDir = path.join(resourcesRoot, 'native', 'office-preview-runtime')
    const payloadRoot = path.join(tempRoot, 'office-runtime-payload')
    const bundledBin = path.join(payloadRoot, 'bin')
    await fs.mkdir(archiveDir, { recursive: true })
    await fs.mkdir(bundledBin, { recursive: true })
    await writeExecutable(path.join(bundledBin, 'soffice.exe'), `#!/usr/bin/env bash
set -euo pipefail
outdir=""
source=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --outdir)
      outdir="$2"
      shift 2
      ;;
    *)
      source="$1"
      shift
      ;;
  esac
done
name="$(basename "$source")"
base="\${name%.*}"
mkdir -p "$outdir"
printf 'pdf' > "$outdir/$base.pdf"
`)
    await writeExecutable(path.join(bundledBin, 'pdftoppm.exe'), `#!/usr/bin/env bash
set -euo pipefail
prefix="\${@: -1}"
mkdir -p "$(dirname "$prefix")"
printf 'png' > "$prefix-1.png"
`)
    await execFileAsync(tarCommand(), [
      '-czf',
      path.join(archiveDir, 'office-preview-runtime.tar.gz'),
      '-C',
      payloadRoot,
      '.',
    ])

    const sourcePath = path.join(tempRoot, 'document.docx')
    await fs.writeFile(sourcePath, 'fake docx')
    const stat = await fs.stat(sourcePath)

    const preview = await renderOfficePreview(sourcePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })

    expect(preview.pageCount).toBe(1)
    expect(preview.pdfPath).toContain('document.pdf')
    await expect(fs.readdir(path.join(electronPaths.userData, 'office-preview-runtime'))).resolves.toHaveLength(1)
  })

  itWithTarFixtures('extracts and caches the office preview runtime from a bundled archive without executing tools', async () => {
    await fs.rm(path.join(electronPaths.home, '.cache'), { recursive: true, force: true })

    const resourcesRoot = path.join(tempRoot, 'resources')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesRoot,
      configurable: true,
    })

    const manifestDir = path.join(resourcesRoot, 'native', 'office-preview-runtime')
    const payloadRoot = path.join(tempRoot, 'office-runtime-payload')
    const remoteRoot = path.join(tempRoot, 'remote-runtime')
    const bundledBin = path.join(payloadRoot, 'bin')
    await fs.mkdir(manifestDir, { recursive: true })
    await fs.mkdir(remoteRoot, { recursive: true })
    await fs.mkdir(bundledBin, { recursive: true })
    await fs.writeFile(path.join(bundledBin, 'soffice.exe'), '')
    await fs.writeFile(path.join(bundledBin, 'pdftoppm.exe'), '')

    const archivePath = path.join(manifestDir, 'office-preview-runtime-fixture.tar.gz')
    await execFileAsync(tarCommand(), [
      '-czf',
      archivePath,
      '-C',
      payloadRoot,
      '.',
    ])
    const archive = await fs.readFile(archivePath)
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex')
    await fs.writeFile(path.join(manifestDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: '2026.06.27-test-win-x64',
      platform: `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`,
      archiveName: 'office-preview-runtime-fixture.tar.gz',
      sha256,
      size: archive.length,
      tools: {
        soffice: 'bin/soffice.exe',
        pdftoppm: 'bin/pdftoppm.exe',
      },
    }, null, 2))

    const runtime = await ensureOfficePreviewRuntime()

    expect(runtime?.sofficePath).toContain('soffice.exe')
    expect(runtime?.pdftoppmPath).toContain('pdftoppm.exe')
    await expect(fs.readFile(path.join(electronPaths.userData, 'office-preview-runtime', 'current.json'), 'utf-8'))
      .resolves.toContain('2026.06.27-test-win-x64')
  })

  itWithTarFixtures('allows retry after a missing bundled office preview runtime archive', async () => {
    await fs.rm(path.join(electronPaths.home, '.cache'), { recursive: true, force: true })

    const resourcesRoot = path.join(tempRoot, 'resources')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesRoot,
      configurable: true,
    })

    const manifestDir = path.join(resourcesRoot, 'native', 'office-preview-runtime')
    const payloadRoot = path.join(tempRoot, 'office-runtime-payload')
    const remoteRoot = path.join(tempRoot, 'remote-runtime')
    const bundledBin = path.join(payloadRoot, 'bin')
    await fs.mkdir(manifestDir, { recursive: true })
    await fs.mkdir(remoteRoot, { recursive: true })
    await fs.mkdir(bundledBin, { recursive: true })
    await fs.writeFile(path.join(bundledBin, 'soffice.exe'), '')
    await fs.writeFile(path.join(bundledBin, 'pdftoppm.exe'), '')

    const archivePath = path.join(remoteRoot, 'office-preview-runtime-fixture.tar.gz')
    await execFileAsync(tarCommand(), [
      '-czf',
      archivePath,
      '-C',
      payloadRoot,
      '.',
    ])
    const archive = await fs.readFile(archivePath)
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex')
    const manifest = {
      schemaVersion: 1,
      version: '2026.06.27-retry-win-x64',
      platform: `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`,
      archiveName: 'office-preview-runtime-fixture.tar.gz',
      sha256,
      size: archive.length,
      tools: {
        soffice: 'bin/soffice.exe',
        pdftoppm: 'bin/pdftoppm.exe',
      },
    }
    const manifestPath = path.join(manifestDir, 'manifest.json')
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    await expect(ensureOfficePreviewRuntime()).rejects.toMatchObject({
      code: 'OFFICE_RUNTIME_ARCHIVE_MISSING',
    })

    await fs.copyFile(archivePath, path.join(manifestDir, 'office-preview-runtime-fixture.tar.gz'))

    await expect(ensureOfficePreviewRuntime()).resolves.toMatchObject({
      version: '2026.06.27-retry-win-x64',
    })
  })

  itWithTarFixtures('downloads, verifies, extracts, and caches the office runtime on first preview', async () => {
    await fs.rm(path.join(electronPaths.home, '.cache'), { recursive: true, force: true })

    const resourcesRoot = path.join(tempRoot, 'resources')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesRoot,
      configurable: true,
    })

    const manifestDir = path.join(resourcesRoot, 'native', 'office-preview-runtime')
    const payloadRoot = path.join(tempRoot, 'office-runtime-payload')
    const bundledBin = path.join(payloadRoot, 'bin')
    await fs.mkdir(manifestDir, { recursive: true })
    await fs.mkdir(bundledBin, { recursive: true })
    await fs.writeFile(path.join(bundledBin, 'soffice.exe'), '')
    await fs.writeFile(path.join(bundledBin, 'pdftoppm.exe'), '')

    const archivePath = path.join(tempRoot, 'office-preview-runtime-fixture.tar.gz')
    await execFileAsync(tarCommand(), ['-czf', archivePath, '-C', payloadRoot, '.'])
    const archive = await fs.readFile(archivePath)
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex')
    let requestCount = 0
    const server = http.createServer((_request, response) => {
      requestCount += 1
      response.writeHead(200, {
        'content-length': String(archive.length),
        'content-type': 'application/gzip',
      })
      response.end(archive)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
      await fs.writeFile(path.join(manifestDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        version: '2026.08.22-first-preview',
        platform: `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`,
        archiveName: 'office-preview-runtime-fixture.tar.gz',
        url: `http://127.0.0.1:${address.port}/office-preview-runtime-fixture.tar.gz`,
        sha256,
        size: archive.length,
        tools: {
          soffice: 'bin/soffice.exe',
          pdftoppm: 'bin/pdftoppm.exe',
        },
      }, null, 2))

      await expect(ensureOfficePreviewRuntime()).resolves.toMatchObject({
        version: '2026.08.22-first-preview',
      })
      await expect(ensureOfficePreviewRuntime()).resolves.toMatchObject({
        version: '2026.08.22-first-preview',
      })
      expect(requestCount).toBe(1)
      await expect(fs.readFile(path.join(electronPaths.userData, 'office-preview-runtime', 'current.json'), 'utf-8'))
        .resolves.toContain('2026.08.22-first-preview')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  itWithExecutableScriptFixtures('extracts and caches the office preview runtime from a packaged manifest', async () => {
    await fs.rm(path.join(electronPaths.home, '.cache'), { recursive: true, force: true })

    const resourcesRoot = path.join(tempRoot, 'resources')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesRoot,
      configurable: true,
    })

    const manifestDir = path.join(resourcesRoot, 'native', 'office-preview-runtime')
    const payloadRoot = path.join(tempRoot, 'office-runtime-payload')
    const remoteRoot = path.join(tempRoot, 'remote-runtime')
    const bundledBin = path.join(payloadRoot, 'bin')
    await fs.mkdir(manifestDir, { recursive: true })
    await fs.mkdir(remoteRoot, { recursive: true })
    await fs.mkdir(bundledBin, { recursive: true })
    await writeExecutable(path.join(bundledBin, 'soffice.exe'), `#!/usr/bin/env bash
set -euo pipefail
outdir=""
source=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --outdir)
      outdir="$2"
      shift 2
      ;;
    *)
      source="$1"
      shift
      ;;
  esac
done
name="$(basename "$source")"
base="\${name%.*}"
mkdir -p "$outdir"
printf 'pdf' > "$outdir/$base.pdf"
`)
    await writeExecutable(path.join(bundledBin, 'pdftoppm.exe'), `#!/usr/bin/env bash
set -euo pipefail
prefix="\${@: -1}"
mkdir -p "$(dirname "$prefix")"
printf 'png' > "$prefix-1.png"
`)

    const archivePath = path.join(manifestDir, 'office-preview-runtime-fixture.tar.gz')
    await execFileAsync(tarCommand(), [
      '-czf',
      archivePath,
      '-C',
      payloadRoot,
      '.',
    ])
    const archive = await fs.readFile(archivePath)
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex')
    await fs.writeFile(path.join(manifestDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: '2026.06.27-test-win-x64',
      platform: `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`,
      archiveName: 'office-preview-runtime-fixture.tar.gz',
      sha256,
      size: archive.length,
      tools: {
        soffice: 'bin/soffice.exe',
        pdftoppm: 'bin/pdftoppm.exe',
      },
    }, null, 2))

    const sourcePath = path.join(tempRoot, 'slides.pptx')
    await fs.writeFile(sourcePath, 'fake pptx')
    const stat = await fs.stat(sourcePath)

    const preview = await renderOfficePreview(sourcePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })

    expect(preview.pageCount).toBe(1)
    expect(preview.pdfPath).toContain('slides.pdf')
    await expect(fs.readFile(path.join(electronPaths.userData, 'office-preview-runtime', 'current.json'), 'utf-8'))
      .resolves.toContain('2026.06.27-test-win-x64')
  })
})

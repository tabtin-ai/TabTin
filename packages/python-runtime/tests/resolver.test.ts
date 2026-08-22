import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultTarCommand, sha256File } from '../src/archive.js'
import { expectedPlatform } from '../src/manifest.js'
import { ensurePythonRuntime, entrypointRelPath, pythonRuntimeRoot } from '../src/resolver.js'

const execFileAsync = promisify(execFile)
const tmpDirs: string[] = []

async function mkTmp(prefix = 'pyrt-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

async function writeEntrypoint(root: string): Promise<void> {
  const full = path.join(root, entrypointRelPath())
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, '#!/bin/sh\necho fake-python\n')
}

const ARCHIVE = 'tabtin-python-runtime.tar.gz'

async function makeRuntimeArchive(): Promise<string> {
  const payload = await mkTmp('pyrt-payload-')
  await writeEntrypoint(payload)
  const outDir = await mkTmp('pyrt-archive-')
  const archivePath = path.join(outDir, ARCHIVE)
  await execFileAsync(defaultTarCommand(), ['-czf', archivePath, '-C', payload, '.'])
  return archivePath
}

interface ManifestOpts {
  version?: string
  sha256?: string
  archiveName?: string
  platform?: string
}

async function writeManifest(dir: string, archivePath: string, opts: ManifestOpts = {}): Promise<void> {
  const sha = opts.sha256 ?? (await sha256File(archivePath))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      runtimeKind: 'python',
      version: opts.version ?? '3.12.13',
      platforms: {
        [opts.platform ?? expectedPlatform()]: {
          archiveName: opts.archiveName ?? path.basename(archivePath),
          sha256: sha,
          entrypoint: entrypointRelPath().replace(/\\/g, '/'),
        },
      },
    }),
  )
}

describe('ensurePythonRuntime — v2 combined manifest', () => {
  it('explicitRoots 覆盖优先', async () => {
    const cacheDir = await mkTmp()
    const explicit = await mkTmp('pyrt-explicit-')
    await writeEntrypoint(explicit)
    const rt = await ensurePythonRuntime({ cacheDir, explicitRoots: [explicit] })
    expect(rt.origin).toBe('explicit')
  })

  it('本地 sibling → 解压（dev 离线）', async () => {
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    const archive = await makeRuntimeArchive()
    await fs.copyFile(archive, path.join(pkgDir, ARCHIVE))
    await writeManifest(pkgDir, archive)
    const rt = await ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })
    expect(rt.origin).toBe('bundled-archive')
    expect(rt.pythonPath.startsWith(pythonRuntimeRoot(cacheDir))).toBe(true)
  })

  it('无 sibling → ARCHIVE_MISSING', async () => {
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    const archive = await makeRuntimeArchive()
    await writeManifest(pkgDir, archive)
    await expect(ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).rejects.toMatchObject({
      code: 'ARCHIVE_MISSING',
    })
  })

  it('二次命中 marker 缓存', async () => {
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    const archive = await makeRuntimeArchive()
    await fs.copyFile(archive, path.join(pkgDir, ARCHIVE))
    await writeManifest(pkgDir, archive)
    expect((await ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).origin).toBe('bundled-archive')
    expect((await ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).origin).toBe('cache')
  })

  it('版本变更 → 重装（升级）', async () => {
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    const first = await makeRuntimeArchive()
    await fs.copyFile(first, path.join(pkgDir, ARCHIVE))
    await writeManifest(pkgDir, first, { version: '3.12.13' })
    expect((await ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).version).toBe('3.12.13')
    const next = await makeRuntimeArchive()
    await fs.copyFile(next, path.join(pkgDir, ARCHIVE))
    await writeManifest(pkgDir, next, { version: '3.13.0' })
    const rt2 = await ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })
    expect(rt2.origin).toBe('bundled-archive')
    expect(rt2.version).toBe('3.13.0')
  })

  it('manifest 不含本机平台 → 不用它（回落 RUNTIME_UNAVAILABLE）', async () => {
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    await writeManifest(pkgDir, await makeRuntimeArchive(), { platform: 'solaris-sparc' })
    await expect(ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})

describe('ensurePythonRuntime — 反向与隔离', () => {
  it('存在 codex-runtimes 但无 manifest → 不命中 codex，RUNTIME_UNAVAILABLE', async () => {
    const cacheDir = await mkTmp()
    await writeEntrypoint(path.join(cacheDir, 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python'))
    await expect(ensurePythonRuntime({ cacheDir })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('sha 不符 → CHECKSUM_MISMATCH', async () => {
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    const archive = await makeRuntimeArchive()
    await fs.copyFile(archive, path.join(pkgDir, ARCHIVE))
    await writeManifest(pkgDir, archive, { sha256: 'b'.repeat(64) })
    await expect(ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    })
  })

  it('归档含绝对路径条目 → EXTRACT_FAILED', async () => {
    if (process.platform === 'win32') return
    const cacheDir = await mkTmp()
    const pkgDir = await mkTmp('pyrt-pkg-')
    const outDir = await mkTmp('pyrt-evil-')
    const archivePath = path.join(outDir, ARCHIVE)
    const absMember = path.join(outDir, 'abs-evil.txt')
    await fs.writeFile(absMember, 'evil')
    await execFileAsync(defaultTarCommand(), ['-czPf', archivePath, absMember])
    await fs.copyFile(archivePath, path.join(pkgDir, ARCHIVE))
    await writeManifest(pkgDir, archivePath)
    await expect(ensurePythonRuntime({ cacheDir, packagedRoots: [pkgDir] })).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
    })
  })

  it('无 manifest 无缓存 → RUNTIME_UNAVAILABLE', async () => {
    const cacheDir = await mkTmp()
    await expect(ensurePythonRuntime({ cacheDir })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })
})

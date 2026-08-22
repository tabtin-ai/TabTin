import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { PythonRuntimeError } from './types.js'

const execFileAsync = promisify(execFile)

const EXTRACT_TIMEOUT_MS = 180_000

export function defaultTarCommand(): string {
  if (process.platform === 'darwin') return '/usr/bin/tar'
  return process.platform === 'win32' ? 'tar.exe' : 'tar'
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

export async function assertChecksum(archivePath: string, expectedSha256: string, expectedSize?: number): Promise<void> {
  const stat = await fsPromises.stat(archivePath)
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    throw new PythonRuntimeError(
      'CHECKSUM_MISMATCH',
      `python runtime 归档大小不符：期望 ${expectedSize}，实际 ${stat.size}`,
    )
  }
  const actual = await sha256File(archivePath)
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new PythonRuntimeError('CHECKSUM_MISMATCH', 'python runtime 归档 sha256 校验失败')
  }
}

/** 列出 tar 条目并拒绝任何绝对路径 / 盘符 / `..` 穿越条目。 */
async function assertArchiveSafeEntries(archivePath: string, tarCommand: string): Promise<void> {
  const { stdout } = await execFileAsync(tarCommand, ['-tzf', archivePath], {
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized) continue
    const segments = normalized.split('/').filter(Boolean)
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || segments.includes('..')) {
      throw new PythonRuntimeError('EXTRACT_FAILED', `python runtime 归档含不安全条目: ${entry}`)
    }
  }
}

/**
 * 解压归档到 runtimeRoot：staging 幂等 rm+mkdir → 安全校验 → 解压 → entrypoint 校验 → 原子 rename。
 * 幂等：命中已存在 staging 先清；非 ASCII 路径不会重复堆积（每次固定 `<root>.staging`）。
 */
export async function extractArchiveToRuntimeRoot(
  archivePath: string,
  runtimeRoot: string,
  entrypointRelPath: string,
  tarCommand: string,
): Promise<void> {
  const stagingRoot = `${runtimeRoot}.staging`
  await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  await fsPromises.mkdir(stagingRoot, { recursive: true })

  try {
    await assertArchiveSafeEntries(archivePath, tarCommand)
    await execFileAsync(tarCommand, ['-xzf', archivePath, '-C', stagingRoot], {
      timeout: EXTRACT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })

    const stagedEntrypoint = joinRel(stagingRoot, entrypointRelPath)
    if (!(await isFile(stagedEntrypoint))) {
      throw new PythonRuntimeError('ENTRYPOINT_MISSING', `python runtime 归档缺少解释器入口: ${entrypointRelPath}`)
    }

    await fsPromises.rm(runtimeRoot, { recursive: true, force: true }).catch(() => {})
    await fsPromises.mkdir(path.dirname(runtimeRoot), { recursive: true }).catch(() => {})
    await fsPromises.rename(stagingRoot, runtimeRoot)
  } catch (error) {
    await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    if (error instanceof PythonRuntimeError) throw error
    throw new PythonRuntimeError('EXTRACT_FAILED', error instanceof Error ? error.message : String(error))
  }
}

export async function isFile(candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false
  try {
    return (await fsPromises.stat(candidate)).isFile()
  } catch {
    return false
  }
}

/** 把归档内相对路径（可能含 `/`）安全拼到 root 下。 */
export function joinRel(root: string, relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return path.join(root, ...parts)
}

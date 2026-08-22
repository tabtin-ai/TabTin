/**
 * fs.restore_file_from_url — restore a continuation handoff file into workspace.
 */
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '../logger'
import {
  canonicalizeRelativePath,
  type RemoteFsResult,
} from './remote-fs-guard.js'

const log = createLogger('RestoreFileFromUrl')

function isAllowedDownloadHost(downloadUrl: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return false
  try {
    const host = new URL(downloadUrl).hostname.toLowerCase()
    return Boolean(host) && allowedHosts.includes(host)
  } catch {
    return false
  }
}

async function resolveWritablePath(
  workingDir: string,
  rawPath: string,
): Promise<{ resolved: string; realRoot: string } | RemoteFsResult> {
  if (!workingDir) {
    return { success: false, error: 'missing authoritative working_dir', error_code: 'INVALID_REQUEST' }
  }
  const relativePath = canonicalizeRelativePath(rawPath)
  if (!relativePath || !relativePath.startsWith('artifacts/')) {
    return { success: false, error: 'path is not writable', error_code: 'PATH_DENIED' }
  }
  try {
    const realRoot = await fsPromises.realpath(path.resolve(workingDir))
    const resolved = path.resolve(realRoot, relativePath)
    const rel = path.relative(realRoot, resolved)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { success: false, error: 'path is not writable', error_code: 'PATH_DENIED' }
    }
    return { resolved, realRoot }
  } catch {
    return { success: false, error: 'path is not writable', error_code: 'PATH_DENIED' }
  }
}

function isInsideRoot(realRoot: string, candidate: string): boolean {
  const rel = path.relative(realRoot, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function resolveWriteTarget(
  realRoot: string,
  resolved: string,
): Promise<{ resolved: string } | RemoteFsResult> {
  let realParent: string
  try {
    realParent = await fsPromises.realpath(path.dirname(resolved))
  } catch {
    return { success: false, error: 'path is not writable', error_code: 'PATH_DENIED' }
  }
  if (!isInsideRoot(realRoot, realParent)) {
    return { success: false, error: 'path is not writable', error_code: 'PATH_DENIED' }
  }
  const writeTarget = path.join(realParent, path.basename(resolved))
  try {
    const realExisting = await fsPromises.realpath(writeTarget)
    if (!isInsideRoot(realRoot, realExisting)) {
      return { success: false, error: 'path is not writable', error_code: 'PATH_DENIED' }
    }
    return { resolved: realExisting }
  } catch {
    return { resolved: writeTarget }
  }
}

export async function restoreFileFromUrl(
  params: Record<string, unknown>,
): Promise<RemoteFsResult> {
  const workingDir = typeof params._working_dir === 'string' ? params._working_dir : ''
  const targetRelativePath = typeof params.target_relative_path === 'string'
    ? params.target_relative_path
    : ''
  const downloadUrl = typeof params.download_url === 'string' ? params.download_url : ''
  const rawAllowed = params.allowed_hosts
  const allowedHosts = Array.isArray(rawAllowed)
    ? rawAllowed
        .filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
        .map((host) => host.trim().toLowerCase())
    : []
  if (!downloadUrl || !isAllowedDownloadHost(downloadUrl, allowedHosts)) {
    return { success: false, error: 'download host is not allowed', error_code: 'DOWNLOAD_HOST_DENIED' }
  }
  const guarded = await resolveWritablePath(workingDir, targetRelativePath)
  if ('success' in guarded) return guarded
  const { resolved } = guarded

  try {
    const response = await fetch(downloadUrl)
    if (!response.ok) {
      return {
        success: false,
        error: `download failed with status ${response.status}`,
        error_code: 'DOWNLOAD_FAILED',
      }
    }
    const body = Buffer.from(await response.arrayBuffer())
    const expectedSize = typeof params.expected_size_bytes === 'number'
      ? params.expected_size_bytes
      : null
    if (expectedSize !== null && body.byteLength !== expectedSize) {
      return { success: false, error: 'downloaded file size mismatch', error_code: 'SIZE_MISMATCH' }
    }
    await fsPromises.mkdir(path.dirname(resolved), { recursive: true })
    const writeTarget = await resolveWriteTarget(guarded.realRoot, resolved)
    if ('success' in writeTarget) return writeTarget
    await fsPromises.writeFile(writeTarget.resolved, body, { flag: 'w' })
    log.info('restored continuation file', {
      name: path.basename(resolved),
      size: body.byteLength,
    })
    return {
      success: true,
      data: {
        relative_path: canonicalizeRelativePath(targetRelativePath),
        size_bytes: body.byteLength,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('restore continuation file failed', {
      name: path.basename(targetRelativePath),
      error: message,
    })
    return { success: false, error: message, error_code: 'RESTORE_FAILED' }
  }
}

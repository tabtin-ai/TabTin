/**
 * fs.materialize_file_ref — SessionShare 单文件临时物化。
 *
 * probe：返回 content_version + size；upload：PUT 到服务端 presign URL。
 * 不经 WS 传字节。
 */
import crypto from 'node:crypto'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { MATERIALIZE_MAX_BYTES, guessMaterializePreviewKind } from '@shared/session-share-preview-contract'
import { createLogger } from '../logger'
import {
  canonicalizeRelativePath,
  resolveGuardedPath,
  type RemoteFsResult,
} from './remote-fs-guard.js'

const log = createLogger('MaterializeFileRef')

/** 设备侧 fail-closed：只允许 PUT 到 Django 签出的 host。 */
export function isAllowedUploadHost(uploadUrl: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return false
  try {
    const host = new URL(uploadUrl).hostname.toLowerCase()
    return Boolean(host) && allowedHosts.includes(host)
  } catch {
    return false
  }
}

export async function materializeFileRef(
  params: Record<string, unknown>,
): Promise<RemoteFsResult> {
  const workingDir = typeof params._working_dir === 'string' ? params._working_dir : ''
  const relativePathRaw = typeof params.relative_path === 'string' ? params.relative_path : ''
  const relativePath = canonicalizeRelativePath(relativePathRaw)
  if (!relativePath) {
    return { success: false, error: 'path is not accessible', error_code: 'PATH_DENIED' }
  }
  const guarded = await resolveGuardedPath(workingDir, relativePath)
  if ('success' in guarded) return guarded
  const { resolved } = guarded

  const phase = typeof params.phase === 'string' ? params.phase : 'probe'
  try {
    const stat = await fsPromises.stat(resolved)
    if (stat.isDirectory()) {
      return { success: false, error: 'path is a directory', error_code: 'EISDIR' }
    }
    if (stat.size > MATERIALIZE_MAX_BYTES) {
      return {
        success: false,
        error: `file too large for shared preview (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
        error_code: 'FILE_TOO_LARGE',
      }
    }

    // content_version：size + mtime + 前 64KB hash，避免整文件读入仅做 probe
    const hash = crypto.createHash('sha256')
    hash.update(String(stat.size))
    hash.update(':')
    hash.update(String(Math.trunc(stat.mtimeMs)))
    const probeHandle = await fsPromises.open(resolved, 'r')
    try {
      const probeSize = Math.min(stat.size, 64 * 1024)
      const buf = Buffer.alloc(probeSize)
      await probeHandle.read(buf, 0, probeSize, 0)
      hash.update(buf)
    } finally {
      await probeHandle.close()
    }
    const contentVersion = `sha256:${hash.digest('hex')}`
    const previewKind = guessMaterializePreviewKind(resolved)

    if (phase === 'probe') {
      return {
        success: true,
        data: {
          content_version: contentVersion,
          size_bytes: stat.size,
          preview_kind: previewKind,
          mime_type: undefined,
        },
      }
    }

    if (phase !== 'upload') {
      return { success: false, error: `unsupported phase: ${phase}`, error_code: 'INVALID_REQUEST' }
    }

    const expectedVersion = typeof params.content_version === 'string' ? params.content_version : ''
    if (expectedVersion && expectedVersion !== contentVersion) {
      return {
        success: false,
        error: 'file changed during preview',
        error_code: 'CONTENT_CHANGED',
      }
    }

    const presign = params.presign
    if (!presign || typeof presign !== 'object' || Array.isArray(presign)) {
      return { success: false, error: 'presign is required', error_code: 'INVALID_REQUEST' }
    }
    const uploadUrl = typeof (presign as { upload_url?: unknown }).upload_url === 'string'
      ? (presign as { upload_url: string }).upload_url
      : ''
    const contentType = typeof (presign as { content_type?: unknown }).content_type === 'string'
      ? (presign as { content_type: string }).content_type
      : 'application/octet-stream'
    const maxBytes = typeof (presign as { max_bytes?: unknown }).max_bytes === 'number'
      ? (presign as { max_bytes: number }).max_bytes
      : MATERIALIZE_MAX_BYTES
    const rawAllowed = (presign as { allowed_hosts?: unknown }).allowed_hosts
    const allowedHosts = Array.isArray(rawAllowed)
      ? rawAllowed
          .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
          .map((h) => h.trim().toLowerCase())
      : []
    if (!uploadUrl) {
      return { success: false, error: 'upload_url is required', error_code: 'INVALID_REQUEST' }
    }
    if (!isAllowedUploadHost(uploadUrl, allowedHosts)) {
      return {
        success: false,
        error: 'upload host is not allowed',
        error_code: 'UPLOAD_HOST_DENIED',
      }
    }
    if (stat.size > maxBytes) {
      return { success: false, error: 'file too large for shared preview', error_code: 'FILE_TOO_LARGE' }
    }

    const body = await fsPromises.readFile(resolved)
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
      },
      body,
    })
    if (!response.ok) {
      log.warn('materialize upload failed', {
        name: path.basename(resolved),
        status: response.status,
      })
      return {
        success: false,
        error: `upload failed with status ${response.status}`,
        error_code: 'UPLOAD_FAILED',
      }
    }

    log.info('fs.materialize_file_ref', {
      name: path.basename(resolved),
      size: body.byteLength,
      kind: previewKind,
    })
    return {
      success: true,
      data: {
        content_version: contentVersion,
        size_bytes: body.byteLength,
        preview_kind: previewKind,
        mime_type: contentType,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const notFound = /ENOENT/i.test(message)
    if (!notFound) log.warn('materialize 失败', { name: path.basename(resolved), error: message })
    return {
      success: false,
      error: notFound ? 'path is not accessible' : message,
      error_code: notFound ? 'PATH_DENIED' : 'FS_ERROR',
    }
  }
}

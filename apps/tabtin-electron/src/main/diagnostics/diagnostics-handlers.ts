/**
 * 诊断 IPC 的纯业务处理（无 electron import），便于 vitest 回归 envelope 契约。
 * 注册入口见 `diagnostics-ipc.ts`。
 */

import path from 'node:path'
import type { mkdir, writeFile } from 'node:fs/promises'
import { okResponse, errResponse, type CliOkResponse, type CliErrorResponse } from '@tabtin/agent-wire'
import { sanitizeBundleFilename } from './bundle-filename'
import type { mergeMainLogsIntoBundleBuffer } from './merge-main-logs-into-bundle'
import type { readMainProcessLogSnapshot } from './read-main-logs'
import type {
  DiagnosticsLogSnapshot,
  DiagnosticsBundlePayload,
  DiagnosticsSaveResult,
  DiagnosticsOpenDirResult,
  DiagnosticsSupportUploadResult,
} from '../../shared/diagnostics-types'

/** zip 落盘上限 64MB，防御异常巨包。 */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

type Envelope<T> = CliOkResponse<T> | CliErrorResponse

type MkdirFn = typeof mkdir
type WriteFileFn = typeof writeFile
type MergeFn = typeof mergeMainLogsIntoBundleBuffer
type ReadSnapshotFn = typeof readMainProcessLogSnapshot

export function wrapLogSnapshot(
  snapshot: DiagnosticsLogSnapshot,
): CliOkResponse<DiagnosticsLogSnapshot> {
  return okResponse(snapshot)
}

export async function handleQueueSupportUpload(
  payload: unknown,
  deps: {
    merge: MergeFn
    queue: (input: { buffer: Buffer; organizationId: string; clientInstallId: string }) => Promise<string>
  },
): Promise<Envelope<DiagnosticsSupportUploadResult>> {
  if (!payload || typeof payload !== 'object') return errResponse('VALIDATION_ERROR', 'payload 必须是对象')
  const p = payload as DiagnosticsBundlePayload & { organizationId?: string; clientInstallId?: string }
  if (!p.organizationId?.trim() || !p.clientInstallId?.trim()) {
    return errResponse('VALIDATION_ERROR', '缺少当前组织或客户端标识')
  }
  if (typeof p.base64 !== 'string' || !p.base64) return errResponse('VALIDATION_ERROR', 'base64 内容为空')
  const buffer = Buffer.from(p.base64, 'base64')
  if (!buffer.length || buffer.length > MAX_BUNDLE_BYTES) return errResponse('VALIDATION_ERROR', '诊断包大小无效')
  try {
    const merged = await deps.merge(buffer)
    if (merged.buffer.length > MAX_BUNDLE_BYTES) return errResponse('VALIDATION_ERROR', '诊断包过大')
    const bundleId = await deps.queue({
      buffer: merged.buffer,
      organizationId: p.organizationId,
      clientInstallId: p.clientInstallId,
    })
    return okResponse({ bundleId, queued: true })
  } catch (err) {
    return errResponse('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
  }
}

export async function handleSaveBundle(
  payload: unknown,
  deps: {
    merge: MergeFn
    mkdir: MkdirFn
    writeFile: WriteFileFn
    resolveDir: () => string
    reveal?: (absolutePath: string) => void
    logError?: (msg: string) => void
    logInfo?: (msg: string) => void
  },
): Promise<Envelope<DiagnosticsSaveResult>> {
  if (!payload || typeof payload !== 'object') {
    return errResponse('VALIDATION_ERROR', 'payload 必须是对象')
  }
  const p = payload as DiagnosticsBundlePayload
  const filename = sanitizeBundleFilename(p.filename)
  if (!filename) {
    return errResponse(
      'VALIDATION_ERROR',
      'filename 非法：必须是以 .zip 结尾、不含路径分隔符 / ".." 的纯文件名',
    )
  }
  if (typeof p.base64 !== 'string' || p.base64.length === 0) {
    return errResponse('VALIDATION_ERROR', 'base64 内容为空')
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(p.base64, 'base64')
  } catch (err) {
    return errResponse(
      'VALIDATION_ERROR',
      `base64 解码失败：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (buffer.length === 0) {
    return errResponse('VALIDATION_ERROR', 'base64 解码后为空')
  }
  if (buffer.length > MAX_BUNDLE_BYTES) {
    return errResponse(
      'VALIDATION_ERROR',
      `诊断包过大（${buffer.length} 字节，上限 ${MAX_BUNDLE_BYTES}）`,
    )
  }

  let merged: Awaited<ReturnType<MergeFn>>
  try {
    merged = await deps.merge(buffer)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.logError?.(`诊断包注入 main.log 失败: ${msg}`)
    return errResponse('INTERNAL_ERROR', `注入主进程日志失败：${msg}`)
  }
  buffer = merged.buffer
  if (buffer.length > MAX_BUNDLE_BYTES) {
    return errResponse(
      'VALIDATION_ERROR',
      `诊断包过大（${buffer.length} 字节，上限 ${MAX_BUNDLE_BYTES}）`,
    )
  }

  const dir = deps.resolveDir()
  const absolutePath = path.join(dir, filename)
  const resolved = path.resolve(absolutePath)
  const resolvedDir = path.resolve(dir) + path.sep
  if (!resolved.startsWith(resolvedDir)) {
    return errResponse('VALIDATION_ERROR', '目标路径越界（sanitizer regression?）')
  }

  try {
    await deps.mkdir(dir, { recursive: true })
    await deps.writeFile(absolutePath, buffer)
    deps.logInfo?.(`诊断包已保存 bytes=${buffer.length} path=${absolutePath}`)
    try {
      deps.reveal?.(absolutePath)
    } catch {
      // reveal 失败不影响导出成功
    }
    return okResponse({
      absolutePath,
      bytes: buffer.length,
      mainLogAttached: merged.mainLogAttached,
      oldLogAttached: merged.oldLogAttached,
      mainLogNote: merged.note,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.logError?.(`诊断包保存失败: ${msg} path=${absolutePath}`)
    return errResponse('INTERNAL_ERROR', msg)
  }
}

export async function handleOpenLogDir(deps: {
  readSnapshot: ReadSnapshotFn
  mkdir: MkdirFn
  openPath: (dir: string) => Promise<string>
}): Promise<Envelope<DiagnosticsOpenDirResult>> {
  const snapshot = await deps.readSnapshot()
  const dir = snapshot.logDir
  if (!dir) {
    return errResponse(
      'UNAVAILABLE',
      '日志目录不可用（开发模式下 electron-log 文件通道默认关闭）。',
    )
  }
  try {
    await deps.mkdir(dir, { recursive: true })
    const err = await deps.openPath(dir)
    if (err) return errResponse('INTERNAL_ERROR', err, { detail: { path: dir } })
    return okResponse({ path: dir })
  } catch (err) {
    return errResponse(
      'INTERNAL_ERROR',
      err instanceof Error ? err.message : String(err),
      { detail: { path: dir } },
    )
  }
}

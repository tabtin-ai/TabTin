/**
 * 控制设备发起的 per-file 回退共用执行器。
 *
 * renderer IPC 与移动端下发到 Electron 的 device action 都必须通过同一条
 * 路径执行：按会话账本查找锚点、在写盘前经过路径守卫、并把单文件失败如实返回。
 * 这样移动端不能只截断对话却把工作区文件误报为已恢复。
 */
import type {
  FileHistoryService,
  RewindPathGuard,
  RewindPreview,
  RewindResult,
} from '@tabtin/file-history-core'
import {
  buildLocalFilePreviewRevision,
} from '@shared/file-preview-revision'
import { getDeviceFingerprint } from '../utils/deviceFingerprint.js'

export interface ControlDeviceFileRewindDependencies {
  getFileHistory: (sessionId: string) => Promise<FileHistoryService | undefined>
  pathGuard: RewindPathGuard
  /** 确认面板/移动端预览返回的本机 v2 文件修订。 */
  expectedPreviewRevision?: string
  deviceFingerprint?: string
}

export type ControlDeviceFileFailureReason =
  | 'no_file_history'
  | 'file_snapshot_missing'
  | 'path_guard_denied'
  | 'unrestorable_files'
  | 'preview_stale'
  | 'rewind_failed'

export type ControlDeviceFileRewindOutcome =
  | { success: true; result: RewindResult }
  | {
      success: false
      error: string
      reason: ControlDeviceFileFailureReason
    }

export type ControlDeviceFilePreviewOutcome =
  | {
      success: true
      status: 'available' | 'not_applicable'
      paths: string[]
      reason?: 'no_file_history' | 'no_file_changes'
      revision: string
      unrestorable: []
    }
  | {
      success: false
      status: 'unavailable'
      paths: string[]
      error: string
      reason: 'no_file_history' | 'file_snapshot_missing' | 'path_guard_denied' | 'preview_failed' | 'unrestorable_files'
      revision: string
      unrestorable: Array<{ path: string; reason: string; detail?: string }>
    }

class PreviewUnavailableError extends Error {
  constructor(readonly outcome: Extract<ControlDeviceFilePreviewOutcome, { success: false }>) {
    super(outcome.error)
  }
}

function resolveDeviceFingerprint(dependencies: ControlDeviceFileRewindDependencies): string {
  if (dependencies.deviceFingerprint) return dependencies.deviceFingerprint
  try {
    return getDeviceFingerprint()
  } catch {
    // 纯 Node 引擎单测/非 Electron 宿主没有 app 对象；生产 main 进程始终
    // 返回真实稳定指纹。降级值仍进入 canonical，不会与真实设备修订互通。
    return 'non-electron-device'
  }
}

async function buildPreviewOutcome(
  sessionId: string,
  deviceFingerprint: string,
  anchorId: string,
  preview: RewindPreview,
  pathGuard: RewindPathGuard,
): Promise<ControlDeviceFilePreviewOutcome> {
  const revision = (
    status: 'available' | 'not_applicable' | 'unavailable',
    reason: string | null,
    paths: string[],
    fingerprints: RewindPreview['fingerprints'] = [],
    unrestorable: Array<{ path: string; reason: string; detail?: string }> = [],
  ) => buildLocalFilePreviewRevision({
    sessionId,
    deviceFingerprint,
    rewindAnchorId: anchorId,
    status,
    reason,
    affectedPaths: paths,
    fingerprints,
    unrestorable,
  })

  const paths = preview.affectedPaths
  const blockedPaths = paths.filter(filePath => !pathGuard(filePath).allowed)
  const blockedCount = blockedPaths.length
  if (blockedCount > 0) {
    const unrestorable = blockedPaths.map(path => ({ path, reason: 'path_guard_denied' }))
    return {
      success: false,
      status: 'unavailable',
      paths,
      error: `Rewind preview blocked ${blockedCount} protected or out-of-workspace path(s)`,
      reason: 'path_guard_denied',
      // 即使用户选择“仅重写对话”，也把真实影响指纹绑入修订，
      // 使 Host 能在改写 transcript 前发现确认后的文件变化。
      revision: await revision('unavailable', 'path_guard_denied', paths, preview.fingerprints, unrestorable),
      unrestorable,
    }
  }
  if (preview.unrestorable.length > 0) {
    return {
      success: false,
      status: 'unavailable',
      paths,
      error: `${preview.unrestorable.length} file(s) have no restorable version`,
      reason: 'unrestorable_files',
      revision: await revision(
        'unavailable',
        'unrestorable_files',
        paths,
        preview.fingerprints,
        preview.unrestorable,
      ),
      unrestorable: preview.unrestorable,
    }
  }
  if (paths.length === 0) {
    return {
      success: true,
      status: 'not_applicable',
      paths: [],
      reason: 'no_file_changes',
      revision: await revision('not_applicable', 'no_file_changes', []),
      unrestorable: [],
    }
  }
  return {
    success: true,
    status: 'available',
    paths,
    revision: await revision('available', null, paths, preview.fingerprints),
    unrestorable: [],
  }
}

/**
 * 以 Electron 的会话 ID（而不是 wire thread ID）取 per-file history 并执行回退。
 *
 * Electron runtime 用 sessionId 建 file-history 账本；后端下发的 threadId 仅用于
 * transport 身份认证，调用方必须先验证二者对应关系后再进入这里。
 */
export async function rewindControlDeviceFiles(
  sessionId: string,
  anchorId: string,
  dependencies: ControlDeviceFileRewindDependencies,
): Promise<ControlDeviceFileRewindOutcome> {
  const service = await dependencies.getFileHistory(sessionId)
  if (!service) {
    return {
      success: false,
      // 保持 IPC 既有的对外错误契约：renderer 会用这段文字区分「纯聊天会话
      // 没有文件账本」和真实文件恢复失败。内部寻址仍然严格使用 sessionId。
      error: `No file-history for thread ${sessionId} (no snapshot on disk)`,
      reason: 'no_file_history',
    }
  }

  try {
    const deviceFingerprint = resolveDeviceFingerprint(dependencies)
    const result = await service.rewind(anchorId, {
      pathGuard: dependencies.pathGuard,
      ...(dependencies.expectedPreviewRevision
        ? {
            expectedPreviewRevision: dependencies.expectedPreviewRevision,
            previewRevisionFactory: async (preview) => {
              const outcome = await buildPreviewOutcome(
                sessionId,
                deviceFingerprint,
                anchorId,
                preview,
                dependencies.pathGuard,
              )
              if (outcome.revision !== dependencies.expectedPreviewRevision) {
                throw new Error(`[FileHistory] rewind ${anchorId} preview revision mismatch`)
              }
              // 已知不可恢复场景的“仅重写对话”必须保证文件零写入。
              // 把稳定 reason 作为执行结果返回，由客户端与用户授权精确比对。
              if (!outcome.success) throw new PreviewUnavailableError(outcome)
              return outcome.revision
            },
          }
        : {}),
    })
    return { success: true, result }
  } catch (error) {
    if (error instanceof PreviewUnavailableError) {
      return {
        success: false,
        error: error.outcome.error,
        reason: error.outcome.reason === 'preview_failed'
          ? 'rewind_failed'
          : error.outcome.reason,
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    const normalized = message.toLowerCase()
    const reason: ControlDeviceFileFailureReason = normalized.includes('preview revision mismatch')
      ? 'preview_stale'
      : normalized.includes('snapshot not found')
        ? 'file_snapshot_missing'
        : normalized.includes('path guard')
          ? 'path_guard_denied'
          : 'rewind_failed'
    return {
      success: false,
      error: message,
      reason,
    }
  }
}

/**
 * 读取控制设备上的真实 per-file 账本，供手机在确认时间线重写前展示影响。
 *
 * 没有任何账本只能证明当前设备无可用版本（可能是旧会话、换设备或
 * 快照已清理），不能证明本轮没改文件；只有存在 anchor 且真实查到
 * ``paths=[]`` 才是 ``not_applicable``。
 */
export async function previewControlDeviceFiles(
  sessionId: string,
  anchorId: string,
  dependencies: ControlDeviceFileRewindDependencies,
): Promise<ControlDeviceFilePreviewOutcome> {
  const deviceFingerprint = resolveDeviceFingerprint(dependencies)
  const service = await dependencies.getFileHistory(sessionId)
  if (!service) {
    return {
      success: false,
      status: 'unavailable',
      paths: [],
      error: `No file-history for thread ${sessionId} (no snapshot on disk)`,
      reason: 'no_file_history',
      revision: await buildLocalFilePreviewRevision({
        sessionId,
        deviceFingerprint,
        rewindAnchorId: anchorId,
        status: 'unavailable',
        reason: 'no_file_history',
        affectedPaths: [],
        fingerprints: [],
      }),
      unrestorable: [],
    }
  }

  try {
    const richPreview = await service.getRewindPreview(anchorId)
    return buildPreviewOutcome(sessionId, deviceFingerprint, anchorId, richPreview, dependencies.pathGuard)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.includes('snapshot not found') ? 'file_snapshot_missing' : 'preview_failed'
    return {
      success: false,
      status: 'unavailable',
      paths: [],
      error: message,
      reason,
      revision: await buildLocalFilePreviewRevision({
        sessionId,
        deviceFingerprint,
        rewindAnchorId: anchorId,
        status: 'unavailable',
        reason,
        affectedPaths: [],
        fingerprints: [],
      }),
      unrestorable: [],
    }
  }
}

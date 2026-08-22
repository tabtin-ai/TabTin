/**
 * 移动端请求到达 Electron 控制设备后的回退编排。
 *
 * 对话 runtime 与 per-file history 都由这台 Electron 持有。只有两者已经实际
 * 执行过，才允许后端把回退投影为完成；文件层若有逐文件失败，则返回可审计的
 * partial 结果，绝不把它伪装成成功。
 */
import type { RewindResult } from '@tabtin/file-history-core'
import type { ControlDeviceFileRewindOutcome } from '../file-history/control-device-file-rewind.js'

export interface TranscriptRewindOutcome {
  success: boolean
  applied?: boolean
  keepMessageCount?: number | null
  error?: string
}

export interface DeviceSessionRewindInput {
  fileRewindAnchorId?: string
  confirmedUnrestorableFiles?: Array<{ path: string; reason: string }>
  rewindTranscript: () => Promise<TranscriptRewindOutcome>
  rewindFiles: (anchorId: string) => Promise<ControlDeviceFileRewindOutcome>
}

export interface DeviceSessionRewindData extends Record<string, unknown> {
  applied: boolean
  keep_message_count?: number
  /** 新版 Electron 已实际处理文件层；后端用它拒绝旧客户端的假成功。 */
  file_restore_coordinated: true
  file_restore_success: boolean
  file_restore_status: 'success' | 'not_applicable' | 'partial' | 'failed' | 'unavailable'
  file_restore_reason?: string
  files_restored?: string[]
  files_deleted?: string[]
  failed_files?: string[]
  unrestorable_files?: Array<{ path: string; reason: string }>
}

export type DeviceSessionRewindResult =
  | { success: true; data: DeviceSessionRewindData }
  | { success: false; error: string; errorCode: 'RUNTIME_REWIND_FAILED' }

function toData(
  transcript: TranscriptRewindOutcome,
  fileOutcome?: ControlDeviceFileRewindOutcome,
  confirmedUnrestorableFiles: Array<{ path: string; reason: string }> = [],
): DeviceSessionRewindData {
  const base: DeviceSessionRewindData = {
    applied: transcript.applied === true,
    file_restore_coordinated: true,
    file_restore_success: true,
    file_restore_status: 'not_applicable',
    file_restore_reason: 'no_file_anchor',
  }
  if (typeof transcript.keepMessageCount === 'number') {
    base.keep_message_count = transcript.keepMessageCount
  }
  if (!fileOutcome) return base
  if (!fileOutcome.success) {
    if (
      fileOutcome.reason === 'no_file_history'
      || fileOutcome.reason === 'file_snapshot_missing'
      || fileOutcome.reason === 'path_guard_denied'
      || fileOutcome.reason === 'unrestorable_files'
    ) {
      return {
        ...base,
        file_restore_success: false,
        file_restore_status: 'unavailable',
        file_restore_reason: fileOutcome.reason,
        failed_files: confirmedUnrestorableFiles.map(item => item.path),
        unrestorable_files: confirmedUnrestorableFiles,
      }
    }
    return {
      ...base,
      file_restore_success: false,
      file_restore_status: 'failed',
      file_restore_reason: fileOutcome.reason,
    }
  }

  const result: RewindResult = fileOutcome.result
  const restoredCount = result.filesRestored.length + result.filesDeleted.length
  const failedCount = result.failedFiles.length
  const status = failedCount > 0
    ? restoredCount > 0 ? 'partial' : 'failed'
    : restoredCount > 0 ? 'success' : 'not_applicable'
  return {
    ...base,
    file_restore_success: failedCount === 0,
    file_restore_status: status,
    file_restore_reason: failedCount > 0
      ? 'unrestorable_files'
      : status === 'not_applicable' ? 'no_file_changes' : undefined,
    files_restored: result.filesRestored,
    files_deleted: result.filesDeleted,
    failed_files: result.failedFiles,
  }
}

/**
 * 执行 runtime boundary 后，再执行回退锚点对应的文件恢复。
 *
 * 文件服务找不到账本、锚点或被路径守卫拒绝时，Electron 已明确确认“文件未恢复”；
 * 此时保留对话回退，但让后端标记 partial_success，而不是返回 file_restore_success=true。
 */
export async function executeDeviceSessionRewind(
  input: DeviceSessionRewindInput,
): Promise<DeviceSessionRewindResult> {
  let transcript: TranscriptRewindOutcome
  try {
    transcript = await input.rewindTranscript()
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'RUNTIME_REWIND_FAILED',
    }
  }
  if (!transcript.success) {
    return {
      success: false,
      error: transcript.error || 'runtime transcript rewind failed',
      errorCode: 'RUNTIME_REWIND_FAILED',
    }
  }
  // Transcript 未实际命中边界时不能先动文件；后端会据 applied=false 拒绝投影。
  if (transcript.applied !== true) {
    return { success: true, data: toData(transcript) }
  }

  const anchorId = input.fileRewindAnchorId
  if (!anchorId) {
    // 没有后续 Agent run 时没有任何可回退的文件锚点，属于真实 no-op。
    return { success: true, data: toData(transcript) }
  }

  let fileOutcome: ControlDeviceFileRewindOutcome
  try {
    fileOutcome = await input.rewindFiles(anchorId)
  } catch (error) {
    fileOutcome = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      reason: 'rewind_failed',
    }
  }
  return {
    success: true,
    data: toData(transcript, fileOutcome, input.confirmedUnrestorableFiles),
  }
}

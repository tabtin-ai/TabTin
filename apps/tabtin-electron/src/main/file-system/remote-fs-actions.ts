/**
 * remote-fs-actions — 远程文件浏览 / SessionShare 物化。
 *
 * 远端客户端（另一台 Electron / 移动端）通过 Django `/devices/query` 或
 * SessionShare 窄预览发到本机 device action topic：
 *   - `fs.list_dir` / `fs.read_file_preview`（Space 遥控浏览）
 *   - `fs.materialize_file_ref`（共享会话单文件临时上传，不经 WS 传字节）
 *   - `fs.restore_file_from_url`（续接任务从云端恢复交接文件）
 *
 * 安全模型（与本机 IPC 的差异）：
 *   - 本机 TabFolder 走 `getDefaultPathAccessChecker()`（当前活跃 Space 的
 *     snapshot.allowedPaths + 平台基础路径，含 home）；
 *   - 远程浏览的 boundary **只有一条**：Django 注入的服务端权威
 *     `params._working_dir`（Space/Agent 绑定目录）。不含 home / downloads
 *     等平台路径——远端能看的严格是「这个 Space 的工作目录」，比本机窄。
 *   - 红线 / 敏感路径 / deny 列表与本机同源（createPathAccessChecker 内置）。
 *
 * 体积约束：结果经 WS `agent.action.result` → Django ActionResultSchema →
 * Redis 回传。Daemon 侧同名 handler 有 256KB WS message guard，为了两端
 * 行为一致 + 不碰通道上限，这里统一收紧预览体积（常量见下）。
 * 物化 / 恢复走 OSS PUT/GET，不经该 WS 字节通道。
 */
import path from 'node:path'
import { listDirEntriesSorted, buildFilePreviewPayload } from './ipc.js'
import { materializeFileRef } from './materialize-file-ref.js'
import { restoreFileFromUrl } from './restore-file-from-url.js'
import { resolveGuardedPath, type RemoteFsResult } from './remote-fs-guard.js'
import { createLogger } from '../logger'

const log = createLogger('RemoteFsActions')

export const REMOTE_FS_ACTIONS = new Set([
  'fs.list_dir',
  'fs.read_file_preview',
  'fs.materialize_file_ref',
  'fs.restore_file_from_url',
])

/** 文本预览截断上限。JSON 转义最坏可膨胀 ~2x，需保住 daemon 256KB guard。 */
export const REMOTE_TEXT_PREVIEW_MAX_BYTES = 128 * 1024
/** 图片 base64 内联上限（文件字节数，base64 后 ~1.37x）。 */
export const REMOTE_IMAGE_PREVIEW_MAX_BYTES = 160 * 1024
/** 单目录返回条目上限，超出截断并置 truncated 标记。 */
export const REMOTE_LIST_DIR_MAX_ENTRIES = 2000
export type { RemoteFsResult }

export function isRemoteFsAction(action: string): boolean {
  return REMOTE_FS_ACTIONS.has(action)
}

export async function executeRemoteFsAction(
  action: string,
  params: Record<string, unknown>,
): Promise<RemoteFsResult> {
  if (action === 'fs.materialize_file_ref') {
    return materializeFileRef(params)
  }
  if (action === 'fs.restore_file_from_url') {
    return restoreFileFromUrl(params)
  }

  const workingDir = typeof params._working_dir === 'string' ? params._working_dir : ''
  const rawPath = typeof params.path === 'string' ? params.path : ''
  const guarded = await resolveGuardedPath(workingDir, rawPath)
  if ('success' in guarded) return guarded
  const { resolved } = guarded

  try {
    if (action === 'fs.list_dir') {
      const entries = await listDirEntriesSorted(resolved)
      const truncated = entries.length > REMOTE_LIST_DIR_MAX_ENTRIES
      log.info('fs.list_dir', { name: path.basename(resolved), entries: entries.length })
      return {
        success: true,
        data: {
          entries: truncated ? entries.slice(0, REMOTE_LIST_DIR_MAX_ENTRIES) : entries,
          truncated,
        },
      }
    }

    if (action === 'fs.read_file_preview') {
      const payload = await buildFilePreviewPayload(resolved, {
        maxBytes: REMOTE_TEXT_PREVIEW_MAX_BYTES,
        imageMaxBytes: REMOTE_IMAGE_PREVIEW_MAX_BYTES,
      })
      log.info('fs.read_file_preview', { name: path.basename(resolved), success: payload.success })
      if (!payload.success) {
        return {
          success: false,
          error: payload.error ?? 'preview failed',
          error_code: payload.code === 'EISDIR' ? 'EISDIR' : 'PREVIEW_FAILED',
        }
      }
      // 剥掉 data.path（pdf/office/音视频分支会带执行设备的本机绝对路径）：
      // 远端 UI 不消费该字段，没必要把本机路径细节送出设备。
      const { path: _localPath, ...rest } = (payload.data ?? {}) as Record<string, unknown>
      return { success: true, data: rest }
    }

    return { success: false, error: `unsupported action: ${action}`, error_code: 'INVALID_REQUEST' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const notFound = /ENOENT/i.test(message)
    if (!notFound) log.warn('执行失败', { action, name: path.basename(resolved), error: message })
    return {
      success: false,
      // 与 PATH_DENIED 同一段模糊文案，防以错误差异探测目录结构
      error: notFound ? 'path is not accessible' : message,
      error_code: notFound ? 'PATH_DENIED' : 'FS_ERROR',
    }
  }
}

/**
 * remoteFsClient — 远程文件浏览的取数客户端。
 *
 * 远端（本机不是 control_device）打开 Space 时，TabFolder 的数据源从本机
 * IPC 切到这里：经 Django `POST /context/devices/query` 向执行设备发
 * `fs.list_dir` / `fs.read_file_preview`，Django 做 Space 权限校验并注入
 * 权威 working_dir，执行设备本机闸门判定后回结果。
 *
 * 错误码约定（映射到 UI 文案）：
 *   - DEVICE_RUNTIME_OFFLINE / DEVICE_RUNTIME_UNAVAILABLE → 设备不在线
 *   - TASK_TIMEOUT → 设备响应超时
 *   - PATH_DENIED → 路径不可访问（含不存在，防探测合并口径）
 *   - WORKING_DIR_NOT_SET → Space 未设工作目录
 */
import { apiClient } from '@/services/apiClient'
import { ApiError } from '@/services/api'
import type { FileEntry } from '../types'

const QUERY_URL = '/context/devices/query'
const QUERY_TIMEOUT_SECONDS = 25

export interface RemotePreviewData {
  kind: string
  content?: string
  size: number
  truncated: boolean
  mime?: string
}

export class RemoteFsError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteFsError'
    this.code = code
  }
}

interface DeviceQueryResult {
  success?: boolean
  error?: string
  error_code?: string
  data?: Record<string, unknown>
}

async function queryDeviceFs(
  spaceId: string,
  action: 'fs.list_dir' | 'fs.read_file_preview',
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let result: DeviceQueryResult
  try {
    // apiService 对统一响应格式自动解包（body.data → result dict）
    const response = await apiClient.post<DeviceQueryResult>(QUERY_URL, {
      space_id: spaceId,
      action,
      params,
      timeout_seconds: QUERY_TIMEOUT_SECONDS,
    })
    result = response.data ?? {}
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.data as { code?: string; error_code?: string; message?: string } | undefined
      const code = body?.code || body?.error_code || `HTTP_${err.status}`
      throw new RemoteFsError(String(code), err.message)
    }
    throw new RemoteFsError('NETWORK_ERROR', err instanceof Error ? err.message : String(err))
  }

  if (result.success === false) {
    throw new RemoteFsError(
      String(result.error_code || 'REMOTE_FS_FAILED'),
      result.error || 'remote fs query failed',
    )
  }
  return result.data ?? {}
}

export async function remoteListDir(spaceId: string, dirPath: string): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const data = await queryDeviceFs(spaceId, 'fs.list_dir', { path: dirPath })
  const rawEntries = Array.isArray(data.entries) ? data.entries : []
  const entries: FileEntry[] = rawEntries
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      name: String(e.name ?? ''),
      path: String(e.path ?? ''),
      isDirectory: Boolean(e.isDirectory),
      size: typeof e.size === 'number' ? e.size : 0,
      modifiedAt: typeof e.modifiedAt === 'number' ? e.modifiedAt : null,
    }))
    .filter((e) => e.name && e.path)
  return { entries, truncated: Boolean(data.truncated) }
}

export async function remoteReadFilePreview(spaceId: string, filePath: string): Promise<RemotePreviewData> {
  const data = await queryDeviceFs(spaceId, 'fs.read_file_preview', { path: filePath })
  return {
    kind: typeof data.kind === 'string' ? data.kind : 'binary',
    content: typeof data.content === 'string' ? data.content : undefined,
    size: typeof data.size === 'number' ? data.size : 0,
    truncated: Boolean(data.truncated),
    mime: typeof data.mime === 'string' ? data.mime : undefined,
  }
}

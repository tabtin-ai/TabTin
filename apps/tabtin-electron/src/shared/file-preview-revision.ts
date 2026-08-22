import type { RewindFileFingerprint } from '@tabtin/file-history-core'

export type FilePreviewStatus = 'available' | 'not_applicable' | 'unavailable'

export interface LocalFilePreviewFingerprint {
  /** 文件账本的业务会话身份，防止跨会话复用同形预览。 */
  sessionId: string
  /** 实际执行写盘的稳定设备身份，防止切换控制设备后复用旧修订。 */
  deviceFingerprint: string
  rewindAnchorId: string | null
  status: FilePreviewStatus
  reason?: string | null
  affectedPaths: readonly string[]
  /** 引擎生成的原始字节 sha256/size/mode 指纹；文本 diff 不参与 CAS。 */
  fingerprints: readonly RewindFileFingerprint[]
  unrestorable?: readonly {
    path: string
    reason: string
    detail?: string
  }[]
}

/**
 * 本地文件预览的单一 canonical 形式。
 *
 * v1 后端指纹只绑定锚点/路径；本地 v2 额外绑定当前与目标文件的
 * 原始字节 sha256/size/mode，避免 UTF-8 替换字符碰撞，也不让展示截断影响 CAS。
 */
export function canonicalizeLocalFilePreview(input: LocalFilePreviewFingerprint): string {
  const affectedPaths = [...new Set(input.affectedPaths)].sort()
  const fingerprints = input.fingerprints
    .map(item => ({
      current: item.current,
      path: item.path,
      status: item.status,
      target: item.target,
    }))
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.status.localeCompare(right.status)
      || JSON.stringify(left.current).localeCompare(JSON.stringify(right.current))
      || JSON.stringify(left.target).localeCompare(JSON.stringify(right.target))
    ))
  const unrestorable = (input.unrestorable ?? [])
    .map(item => ({
      detail: item.detail ?? null,
      path: item.path,
      reason: item.reason,
    }))
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.reason.localeCompare(right.reason)
      || String(left.detail).localeCompare(String(right.detail))
    ))
  return JSON.stringify({
    affected_paths: affectedPaths,
    device_fingerprint: input.deviceFingerprint,
    fingerprints,
    reason: input.reason ?? null,
    rewind_anchor_id: input.rewindAnchorId,
    session_id: input.sessionId,
    status: input.status,
    unrestorable,
    version: 2,
  })
}

export async function buildLocalFilePreviewRevision(
  input: LocalFilePreviewFingerprint,
): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalizeLocalFilePreview(input))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `v2:${hex}`
}

/**
 * 文件路径 → 稳定 UUID5（对齐后端 `apps.orchestration.services.daemon_checkpoint_service`）。
 *
 * 后端把 Shadow Git commit 里的 `changed_files` 批量写入
 * `ChangeLog(resource_type='file', resource_id=UUID5(path))`，使 vibe coding
 * 场景的代码变更能被 conversation-anchors API 追溯。
 *
 * 前端在查询某个文件的对话锚点（conversation-anchors）时，必须用**完全相同**的
 * namespace + 同一规范化的 path 字符串做 UUID5，才能匹配到后端写入的记录。
 *
 * ⚠️ namespace UUID 与后端硬编码保持同步：
 *   `33b00000-0000-4000-8000-000000000001`
 */

const FILE_RESOURCE_NAMESPACE = "33b00000-0000-4000-8000-000000000001"

function uuidStringToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID string: ${uuid}`)
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToUuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

/**
 * 将文件路径（已 trim）映射到稳定的 UUID5。对齐 Python 的
 * `uuid.uuid5(_FILE_RESOURCE_NAMESPACE, path)`。
 *
 * 返回值严格为 8-4-4-4-12 的 UUID 字符串，可直接作为
 * `conversation-anchors` API 的 `resource_id` 路径参数。
 */
export async function filePathToResourceId(path: string): Promise<string> {
  const normalized = (path ?? "").trim()
  const nsBytes = uuidStringToBytes(FILE_RESOURCE_NAMESPACE)
  const nameBytes = new TextEncoder().encode(normalized)
  const input = new Uint8Array(nsBytes.length + nameBytes.length)
  input.set(nsBytes, 0)
  input.set(nameBytes, nsBytes.length)

  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-1", input.buffer as ArrayBuffer),
  )
  const uuidBytes = hash.slice(0, 16)
  // RFC 4122: 设置版本位为 5（byte 6 高 4 位）
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50
  // RFC 4122: 设置变体位为 10（byte 8 高 2 位）
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80
  return bytesToUuidString(uuidBytes)
}

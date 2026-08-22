/**
 * blockMergePolicy —— 服务端快照 merge 时内容块 + 消息壳的补缺策略。
 *
 * ## 不变量
 *
 * runtime 实时态 > 服务端落库快照。消息壳（id / content / metadata 等）与
 * `ChatMessage.blocks` 一律以本地 runtime 为底；服务端 GET /messages 只做**补缺**，
 * 禁止整包替换、禁止按整消息 arrival_seq 择边、同 key 不整块替换。
 *
 * ## 判据
 *
 * - 本地无 live 块 → 块内容优先服务端快照（冷加载 / evict 后）；本地
 *   `content_blocks_json` 已有的块级 `arrival_seq` 按稳定键 / 下标回填到采用侧，
 *   **对账后不得丢掉已有 seq**。壳 id 仍留本地，服务端 id 只写入 `metadata.message_id`。
 * - 本地有 live → 壳与块都以 live 为底：
 *   - 有稳定键的工具块：live 已有该 key → **一律保留 live**（即使服务端同 key
 *     的 arrival_seq 更高也不替换——避免滞后 pending 盖掉 live completed）。
 *     本地残留更旧 live 时也不会被服务端「修好」；发起端靠流式写，观察端靠
 *     本端 live 事件，不对账用 server 覆盖同 key。
 *   - 无稳定键（text / thinking 等）：live 已有任一无键块 → 默认不替换；live 全无无键块
 *     时才用服务端无键块补缺。例外：拼接后的服务端无键 text/thinking
 *     Unicode code point 长度**严格大于** live 时，用服务端无键块替换 live 无键块
 *     （保留 live keyed 工具块），避免半截 live text 挡住服务端全文。
 *   - 壳字段：本地已有的不覆盖；仅补本地缺失的标量 / metadata。
 *     助手壳 `content` 仍可走 text_summary（≤200）；气泡全文靠 `blocks` / BlockTimeline。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { isSystemAuthoredMessage } from './messageRolePolicy'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { deserializeContentBlocks } from '@/components/chat/blocks/deserializeContentBlocks'

function readArrivalSeq(block: unknown): number {
  if (!block || typeof block !== 'object') return -1
  const seq = (block as { arrival_seq?: unknown }).arrival_seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : -1
}

const TOOL_USE_TYPES = new Set(['tool_use', 'mcp_tool_use'])
const TOOL_RESULT_TYPES = new Set(['tool_result', 'mcp_tool_result'])

/**
 * 块的**稳定逻辑标识**——只对天然带 id 的工具块给键：
 * - `tool_use` / `mcp_tool_use` → `use:${id}`
 * - `tool_result` / `mcp_tool_result` → `result:${tool_use_id}`
 *
 * text / thinking / rich 等无稳定 id，不给键（返回 null）。
 */
function stableBlockKey(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const type = (block as { type?: unknown }).type
  if (typeof type !== 'string') return null
  if (TOOL_USE_TYPES.has(type)) {
    const id = (block as { id?: unknown }).id
    return typeof id === 'string' && id ? `use:${id}` : null
  }
  if (TOOL_RESULT_TYPES.has(type)) {
    const tuid = (block as { tool_use_id?: unknown }).tool_use_id
    return typeof tuid === 'string' && tuid ? `result:${tuid}` : null
  }
  return null
}

function readArrivalSeqOrNull(block: unknown): number | null {
  const seq = readArrivalSeq(block)
  return seq >= 0 ? seq : null
}

/**
 * 冷合并：内容取 preferred，缺失的块级 arrival_seq 从 donor 按稳定键（工具块）
 * 或同下标（无键块）回填。单一路径，不对「整包留 local / 整包换 server」分叉。
 */
function adoptBlocksPreservingArrival(
  preferred: unknown,
  donor: unknown,
): ChatMessage['content_blocks_json'] {
  const preferredBlocks = Array.isArray(preferred) ? preferred : []
  const donorBlocks = Array.isArray(donor) ? donor : []
  if (preferredBlocks.length === 0) {
    return (donorBlocks.length > 0 ? donorBlocks : preferred) as ChatMessage['content_blocks_json']
  }

  const seqByKey = new Map<string, number>()
  for (const block of donorBlocks) {
    const key = stableBlockKey(block)
    const seq = readArrivalSeqOrNull(block)
    if (key && seq !== null && !seqByKey.has(key)) seqByKey.set(key, seq)
  }

  return preferredBlocks.map((block, index) => {
    if (!block || typeof block !== 'object') return block
    if (readArrivalSeqOrNull(block) !== null) return block
    const key = stableBlockKey(block)
    const fromKey = key ? seqByKey.get(key) : undefined
    if (typeof fromKey === 'number') {
      return { ...(block as Record<string, unknown>), arrival_seq: fromKey }
    }
    const fromIndex = readArrivalSeqOrNull(donorBlocks[index])
    if (fromIndex !== null) {
      return { ...(block as Record<string, unknown>), arrival_seq: fromIndex }
    }
    return block
  }) as ChatMessage['content_blocks_json']
}

function entryBlock(entry: ContentBlockEntry): unknown {
  return (entry as { block?: unknown }).block
}

function asMeta(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? { ...(value as Record<string, unknown>) }
    : {}
}

/**
 * 消息壳以 local 为底：保留 runtime id，服务端 id 只 link 进 metadata；
 * 本地已有的标量不覆盖，仅补缺。
 */
export function mergeMessageShellFillMissing(
  local: ChatMessage,
  server: ChatMessage,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  const metadata = {
    ...asMeta(server.metadata),
    ...asMeta(local.metadata),
  }
  if (server.id && server.id !== local.id) {
    const existing = metadata.message_id
    if (typeof existing !== 'string' || !existing) {
      metadata.message_id = server.id
    }
  }

  return {
    ...local,
    ...(server.role === 'system' && isSystemAuthoredMessage(server) ? { role: 'system' as const } : {}),
    client_event_id: local.client_event_id || server.client_event_id,
    stop_reason: local.stop_reason ?? server.stop_reason,
    error_info_json: local.error_info_json ?? server.error_info_json,
    metadata: Object.keys(metadata).length > 0 ? metadata : local.metadata,
    ...overrides,
  }
}

/** 无键 text/thinking 的 Unicode code point 总长（与 deriveTextSummary / Django len 对齐）。 */
function unkeyedTextCodePoints(entries: readonly ContentBlockEntry[]): number {
  let total = 0
  for (const entry of entries) {
    const block = entryBlock(entry)
    if (stableBlockKey(block)) continue
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type !== 'text' && type !== 'thinking') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text.length > 0) {
      total += Array.from(text).length
    }
  }
  return total
}

/**
 * 有 live 时的块级补缺：以 live 为底，只并入服务端独有键 / 在 live 无无键块时补无键。
 * 返回壳仍是 local（含原 id）。
 *
 * ：live 已有无键块但码点总长严格短于服务端无键 text/thinking 时，用服务端
 * 无键块替换 live 无键块（保留 live keyed），避免半截 live 挡住全文。
 */
function mergeBlocksFillMissing(
  liveBlocks: ContentBlockEntry[],
  local: ChatMessage,
  server: ChatMessage,
  serverJson: unknown,
): ChatMessage {
  const serverEntries = deserializeContentBlocks(
    (Array.isArray(serverJson) ? serverJson : []) as unknown[],
    local.id,
    { stopReason: server.stop_reason, errorInfo: server.error_info_json, metadata: server.metadata },
  )

  const liveKeys = new Set<string>()
  let liveHasUnkeyed = false
  for (const entry of liveBlocks) {
    const key = stableBlockKey(entryBlock(entry))
    if (!key) {
      liveHasUnkeyed = true
      continue
    }
    liveKeys.add(key)
  }

  const serverHasUnkeyed = serverEntries.some((e) => !stableBlockKey(entryBlock(e)))
  // ：服务端无键全文明显更长 → 升级无键块；否则沿用「live 已有无键则不替换」。
  const upgradeUnkeyedFromServer =
    liveHasUnkeyed &&
    serverHasUnkeyed &&
    unkeyedTextCodePoints(serverEntries) > unkeyedTextCodePoints(liveBlocks)

  const merged: ContentBlockEntry[] = upgradeUnkeyedFromServer
    ? liveBlocks.filter((e) => stableBlockKey(entryBlock(e)) !== null)
    : [...liveBlocks]

  for (const serverEntry of serverEntries) {
    const key = stableBlockKey(entryBlock(serverEntry))
    if (key) {
      if (liveKeys.has(key)) continue
      merged.push(serverEntry)
      liveKeys.add(key)
      continue
    }
    // 无键：升级路径一律采服务端；否则仅 live 全无无键时补缺。
    if (upgradeUnkeyedFromServer || !liveHasUnkeyed) {
      merged.push(serverEntry)
    }
  }

  merged.sort(
    (a, b) => readArrivalSeq(entryBlock(a)) - readArrivalSeq(entryBlock(b)),
  )
  const mergedJson = merged.map((entry) => entryBlock(entry)) as ChatMessage['content_blocks_json']
  return mergeMessageShellFillMissing(local, server, {
    blocks: merged,
    content_blocks_json: mergedJson,
    // 有 live 时正文也以 local 为准；仅 local 空时用服务端补缺。
    // 助手壳 content 可仍是 text_summary（≤200）；气泡全文靠 blocks。
    content: local.content || server.content || '',
  })
}

/**
 * 服务端消息进入本地列表时，决定壳 + 块如何取——唯一权威合并入口。
 *
 * @param local  本地现有消息壳（可能带 runtime live `.blocks`）
 * @param server 服务端权威快照（带 `content_blocks_json`，无 `.blocks` 旁挂）
 * @returns 合并后的消息对象。有 live 时永不整包采用裸服务端；壳 id 始终保留 local。
 *
 * 注意：本函数**只**负责块 + 壳补缺，不处理 user 附件 media——那由
 * `mergeUserContentForDisplay` 处理。
 */
export function reconcileServerMessageBlocks(
  local: ChatMessage,
  server: ChatMessage,
): ChatMessage {
  const liveBlocks = local.blocks
  // 本地无 live 块（首次加载 / evict 后 reload）→ 内容优先服务端；本地已有
  // 块级 seq 回填到采用结果，对账后不丢时序键。
  if (!liveBlocks || liveBlocks.length === 0) {
    const localJson = local.content_blocks_json
    const serverJson = server.content_blocks_json
    const hasServerJson = Array.isArray(serverJson) && serverJson.length > 0
    const preferred = hasServerJson ? serverJson : localJson
    const donor = localJson
    // 冷合并只补 json / 壳；runtime blocks 由 store 入口 hydrate 唯一灌入。
    return mergeMessageShellFillMissing(local, server, {
      content: server.content || local.content || '',
      content_blocks_json: adoptBlocksPreservingArrival(preferred, donor),
    })
  }

  // 有 live：壳 + 块都以 local 为底，只做补缺。
  return mergeBlocksFillMissing(liveBlocks, local, server, server.content_blocks_json)
}

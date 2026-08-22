/**
 * ：出站 relay 消息投影——剥掉内联 data:/base64 媒体，避免单帧撞上
 * Django WS `MAX_MESSAGE_BYTES=1_000_000`。
 *
 * 本地 transcript / LLM 仍可持有完整 base64（runtime 真相源）；仅
 * `DeliveryBatchBuffer` 出站副本做投影。优先保留 `file_id` / 非 data: URL。
 */
import type { StreamEvent } from '@tabtin/agent-runtime'

const RELAY_MESSAGE_TYPES = new Set([
  'agent.stream.user',
  'agent.stream.persist_message',
])

const DATA_URL_RE = /^data:/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripDataUrl(value: unknown): { changed: boolean; value: unknown } {
  if (typeof value !== 'string' || !DATA_URL_RE.test(value)) {
    return { changed: false, value }
  }
  return {
    changed: true,
    value: `[stripped_for_relay data_url chars=${value.length}]`,
  }
}

function projectImageOrDocumentSource(
  source: unknown,
): { changed: boolean; source: unknown } {
  if (!isPlainObject(source)) return { changed: false, source }

  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream'
    return {
      changed: true,
      source: {
        type: 'base64',
        media_type: mediaType,
        data: `[stripped_for_relay base64 chars=${source.data.length}]`,
        stripped_for_relay: true,
      },
    }
  }

  if (source.type === 'url' && typeof source.url === 'string') {
    const stripped = stripDataUrl(source.url)
    if (!stripped.changed) return { changed: false, source }
    return {
      changed: true,
      source: {
        ...source,
        url: stripped.value,
        stripped_for_relay: true,
      },
    }
  }

  return { changed: false, source }
}

function projectBlock(block: unknown): { changed: boolean; block: unknown } {
  if (!isPlainObject(block)) return { changed: false, block }

  let changed = false
  const next: Record<string, unknown> = { ...block }

  if ('source' in next) {
    const projected = projectImageOrDocumentSource(next.source)
    if (projected.changed) {
      next.source = projected.source
      changed = true
    }
  }

  for (const key of ['url', 'image_url', 'preview_url'] as const) {
    if (typeof next[key] !== 'string') continue
    const stripped = stripDataUrl(next[key])
    if (!stripped.changed) continue
    next[key] = stripped.value
    next.stripped_for_relay = true
    changed = true
  }

  if (Array.isArray(next.content)) {
    let contentChanged = false
    const content = next.content.map((item) => {
      const projected = projectBlock(item)
      if (projected.changed) contentChanged = true
      return projected.block
    })
    if (contentChanged) {
      next.content = content
      changed = true
    }
  }

  return { changed, block: changed ? next : block }
}

function projectBlocksJson(value: unknown): { changed: boolean; value: unknown } {
  if (!Array.isArray(value)) return { changed: false, value }
  let changed = false
  const next = value.map((block) => {
    const projected = projectBlock(block)
    if (projected.changed) changed = true
    return projected.block
  })
  return { changed, value: changed ? next : value }
}

function projectAttachmentsJson(value: unknown): { changed: boolean; value: unknown } {
  if (!Array.isArray(value)) return { changed: false, value }
  let changed = false
  const next = value.map((item) => {
    if (!isPlainObject(item)) return item
    let itemChanged = false
    const projected: Record<string, unknown> = { ...item }
    for (const key of ['url', 'preview_url', 'access_url', 'cdn_url'] as const) {
      if (typeof projected[key] !== 'string') continue
      const stripped = stripDataUrl(projected[key])
      if (!stripped.changed) continue
      projected[key] = stripped.value
      projected.stripped_for_relay = true
      itemChanged = true
    }
    if (itemChanged) changed = true
    return itemChanged ? projected : item
  })
  return { changed, value: changed ? next : value }
}

/**
 * 构造出站 relay 用的消息事件副本。非 user/persist_message 原样返回。
 */
export function projectRelayMessageEvent(event: StreamEvent): StreamEvent {
  if (!RELAY_MESSAGE_TYPES.has(event.type)) return event
  if (!isPlainObject(event.payload)) return event

  const payload: Record<string, unknown> = { ...event.payload }
  let changed = false

  if ('blocks_json' in payload) {
    const projected = projectBlocksJson(payload.blocks_json)
    if (projected.changed) {
      payload.blocks_json = projected.value
      changed = true
    }
  }

  if ('content_blocks_json' in payload) {
    const projected = projectBlocksJson(payload.content_blocks_json)
    if (projected.changed) {
      payload.content_blocks_json = projected.value
      changed = true
    }
  }

  if ('attachments_json' in payload) {
    const projected = projectAttachmentsJson(payload.attachments_json)
    if (projected.changed) {
      payload.attachments_json = projected.value
      changed = true
    }
  }

  if (!changed) return event
  return {
    ...event,
    payload: {
      ...payload,
      stripped_for_relay: true,
    },
  }
}

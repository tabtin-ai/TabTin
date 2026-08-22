/**
 * userMediaMerge — 用户消息保留块去重合并。
 *
 * 对账（mergeUserContentForDisplay）与本机 transcript enrich 共用同一套规则。
 * 范围：image/file/video + ContextRef / document / plan 等（见 userPreservedBlocks），
 * 不含 text（text 由调用方单独处理 ）。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import {
  isUserAttachmentMediaBlock,
  isUserPreservedBlock,
  userPreservedBlockKey,
} from '../../../components/chat/context/userPreservedBlocks'

export {
  isUserAttachmentMediaBlock,
  isUserMediaBlock,
} from '../../../components/chat/context/userPreservedBlocks'

export function isUserTextBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== 'object') return false
  if ((block as { type?: unknown }).type !== 'text') return false
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' && text.trim().length > 0
}

/** 非 text 的用户保留块（media + ContextRef 等）。 */
export function isUserNonTextPreservedBlock(
  block: unknown,
): block is Record<string, unknown> {
  return isUserPreservedBlock(block) && !isUserTextBlock(block)
}

export function mediaBlockKey(block: Record<string, unknown>): string | null {
  return userPreservedBlockKey(block)
}

/** 从本地 attachments_json 还原可渲染的 media 块（服务端该字段已恒空）。 */
export function attachmentBlocksFromLocalJson(
  attachmentsJson: ChatMessage['attachments_json'],
): Array<Record<string, unknown>> {
  if (!attachmentsJson || attachmentsJson.length === 0) return []
  const blocks: Array<Record<string, unknown>> = []
  for (const att of attachmentsJson) {
    if (!att.file_id && !att.url && !att.preview_url) continue
    blocks.push({
      type: att.type,
      file_id: att.file_id,
      filename: att.filename,
      mime_type: att.mime_type,
      size: att.size,
      url: att.url,
      preview_url: att.preview_url,
    })
  }
  return blocks
}

function mediaBlockUrl(block: Record<string, unknown>): string | undefined {
  if (typeof block.url === 'string' && block.url) return block.url
  const source = block.source as { url?: unknown } | undefined
  if (source && typeof source.url === 'string' && source.url) return source.url
  return undefined
}

/** image/video 原样；file↔document 互通（transcript DocumentBlock vs DB FileBlock）。 */
function mediaMatchKeys(type: string, url: string): string[] {
  if (type === 'file' || type === 'document') {
    return [`file:${url}`, `document:${url}`]
  }
  return [`${type}:${url}`]
}

/**
 * 把 candidates 里同资源的 file_id / size / filename / mime 写回 base（不新增块）。
 * 本机 transcript 常为 `document` + `source.url`（无 size）；DB FileBlock 有 size——
 * file↔document 按 URL/file_id 去重后若不再 append，必须把元数据补进已有块，
 * 否则附件卡会显示「0 B」（ live / ）。
 */
export function upgradeUserMediaBlocksWithFileId(
  baseBlocks: readonly unknown[],
  candidates: readonly unknown[],
): { blocks: unknown[]; upgraded: boolean } {
  const candidateByMatchKey = new Map<string, Record<string, unknown>>()
  const rememberCandidate = (key: string, candidate: Record<string, unknown>): void => {
    const prev = candidateByMatchKey.get(key)
    if (!prev) {
      candidateByMatchKey.set(key, candidate)
      return
    }
    // 同键多候选：保留更完整的（有 size / file_id 优先）
    const prevSize = typeof prev.size === 'number' ? prev.size : 0
    const nextSize = typeof candidate.size === 'number' ? candidate.size : 0
    const prevFid = typeof prev.file_id === 'string' && prev.file_id
    const nextFid = typeof candidate.file_id === 'string' && candidate.file_id
    if ((!prevFid && nextFid) || (nextSize > prevSize)) {
      candidateByMatchKey.set(key, candidate)
    }
  }

  for (const candidate of candidates) {
    if (!isUserNonTextPreservedBlock(candidate)) continue
    const type = typeof candidate.type === 'string' ? candidate.type : ''
    const fileId = typeof candidate.file_id === 'string' ? candidate.file_id : ''
    const url = mediaBlockUrl(candidate)
    if (fileId) rememberCandidate(`fid:${fileId}`, candidate)
    if (!type || !url) continue
    for (const key of mediaMatchKeys(type, url)) {
      rememberCandidate(key, candidate)
    }
  }
  if (candidateByMatchKey.size === 0) {
    return { blocks: [...baseBlocks], upgraded: false }
  }

  let upgraded = false
  const blocks = baseBlocks.map((block) => {
    if (!isUserNonTextPreservedBlock(block)) return block
    const type = typeof block.type === 'string' ? block.type : ''
    const url = mediaBlockUrl(block)
    const existingFid = typeof block.file_id === 'string' ? block.file_id : ''
    let candidate: Record<string, unknown> | undefined
    if (existingFid) candidate = candidateByMatchKey.get(`fid:${existingFid}`)
    if (!candidate && type && url) {
      for (const key of mediaMatchKeys(type, url)) {
        candidate = candidateByMatchKey.get(key)
        if (candidate) break
      }
    }
    if (!candidate) return block

    const next: Record<string, unknown> = { ...block }
    let changed = false
    if (!existingFid && typeof candidate.file_id === 'string' && candidate.file_id) {
      next.file_id = candidate.file_id
      changed = true
    }
    const baseSize = typeof block.size === 'number' ? block.size : 0
    const candSize = typeof candidate.size === 'number' ? candidate.size : 0
    if (baseSize <= 0 && candSize > 0) {
      next.size = candSize
      changed = true
    }
    if (!(typeof block.filename === 'string' && block.filename)
      && typeof candidate.filename === 'string' && candidate.filename) {
      next.filename = candidate.filename
      changed = true
    }
    if (!(typeof block.mime_type === 'string' && block.mime_type)
      && typeof candidate.mime_type === 'string' && candidate.mime_type) {
      next.mime_type = candidate.mime_type
      changed = true
    }
    if (!changed) return block
    upgraded = true
    return next
  })
  return { blocks, upgraded }
}

/**
 * 以 base 为底，把 candidates 里尚未出现的非 text 保留块追加进去。
 * 无稳定键时：若 base 已有同 type 保留块则跳过。
 * 同 URL 缺 file_id 时先升级再追加。
 */
/**
 * 只合并上传附件 media（image/file/video/document）。
 * hydrate / 时间线物化用此入口，避免 composer_preset / ContextRef 与
 * deserialize 跳过集合不一致导致非幂等重灌。
 */
export function appendMissingUserAttachmentMediaBlocks(
  baseBlocks: readonly unknown[],
  candidates: readonly unknown[],
): { blocks: unknown[]; added: boolean } {
  return appendMissingUserMediaBlocks(
    baseBlocks,
    candidates.filter(isUserAttachmentMediaBlock),
  )
}

export function appendMissingUserMediaBlocks(
  baseBlocks: readonly unknown[],
  candidates: readonly unknown[],
): { blocks: unknown[]; added: boolean } {
  const { blocks: upgradedBase, upgraded } = upgradeUserMediaBlocksWithFileId(
    baseBlocks,
    candidates,
  )
  const merged: unknown[] = [...upgradedBase]
  const seen = new Set<string>()
  const rememberUrlKeys = (type: string, url: string): void => {
    // file↔document 互通，避免升级后仍再 append 同 URL 的另一 type。
    for (const matchKey of mediaMatchKeys(type, url)) {
      const matchType = matchKey.slice(0, matchKey.indexOf(':'))
      seen.add(`${matchType}:url:${url}`)
    }
  }
  for (const block of merged) {
    if (!isUserNonTextPreservedBlock(block)) continue
    const key = mediaBlockKey(block)
    if (key) seen.add(key)
    const url = mediaBlockUrl(block)
    const type = typeof block.type === 'string' ? block.type : ''
    if (type && url) rememberUrlKeys(type, url)
  }

  let added = upgraded
  for (const block of candidates) {
    if (!isUserNonTextPreservedBlock(block)) continue
    const key = mediaBlockKey(block)
    const url = mediaBlockUrl(block)
    const type = typeof block.type === 'string' ? block.type : ''
    const urlKeys = type && url
      ? mediaMatchKeys(type, url).map((matchKey) => {
          const matchType = matchKey.slice(0, matchKey.indexOf(':'))
          return `${matchType}:url:${url}`
        })
      : []
    if (key) {
      if (seen.has(key) || urlKeys.some((urlKey) => seen.has(urlKey))) continue
      seen.add(key)
      for (const urlKey of urlKeys) seen.add(urlKey)
    } else if (merged.some((b) => isUserNonTextPreservedBlock(b) && b.type === block.type)) {
      continue
    }
    merged.push(block)
    added = true
  }
  return { blocks: merged, added }
}

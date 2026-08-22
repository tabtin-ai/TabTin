import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorInstance } from 'novel'
import {
  collectTopLevelBlockIdsInRange,
  getBlockId,
  getNodeStringAttr,
  normalizeBlockText,
} from '../doc-selection-blocks'
import { findTextInDoc } from '../doc-find'
import type { CommentAnchorV1, CommentThreadScope } from '../../comment-threads/types'
import type { CommentYjsCodec } from './yjs-codec'
import { createDefaultYjsCodec } from './yjs-codec'

const CONTEXT_SNIPPET_LEN = 24
const WHOLE_BLOCK_TYPES = new Set([
  'image',
  'table',
  'tabdataBlock',
  'tabwhiteboard',
  'htmlBlock',
  'horizontalRule',
  'codeBlock',
  'youtube',
  'twitter',
])

export type CommentAnchorResolveStrategy =
  | 'yjs'
  | 'block_offset'
  | 'context'
  | 'detached'

export interface ResolvedCommentAnchor {
  from: number
  to: number
  strategy: Exclude<CommentAnchorResolveStrategy, 'detached'>
  blockIds: string[]
}

export interface BuildCommentAnchorResult {
  scope: CommentThreadScope
  anchor: CommentAnchorV1
  selected_text: string
}

export interface BuildCommentAnchorOptions {
  yjsCodec?: CommentYjsCodec | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function imageCommentQuote(node: ProseMirrorNode): string {
  const alt = getNodeStringAttr(node, 'alt') ?? getNodeStringAttr(node, 'title')
  return alt ? `图片：${alt}` : '图片'
}

function blockCommentDescription(node: ProseMirrorNode): { blockType: string; selectedText: string } {
  const text = normalizeBlockText(node)
  if (text) return { blockType: node.type.name, selectedText: text }
  if (node.type.name === 'image') {
    return { blockType: 'image', selectedText: imageCommentQuote(node) }
  }

  let image: ProseMirrorNode | null = null
  node.descendants((child) => {
    if (image || child.type.name !== 'image') return true
    image = child
    return false
  })
  if (image) return { blockType: 'image', selectedText: imageCommentQuote(image) }
  return { blockType: node.type.name, selectedText: '' }
}

function contextSnippet(text: string, side: 'prefix' | 'suffix'): string {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return ''
  return side === 'prefix'
    ? normalized.slice(-CONTEXT_SNIPPET_LEN)
    : normalized.slice(0, CONTEXT_SNIPPET_LEN)
}

function findBlockPosById(doc: ProseMirrorNode, blockId: string): { node: ProseMirrorNode; pos: number } | null {
  let match: { node: ProseMirrorNode; pos: number } | null = null
  doc.descendants((node, pos) => {
    if (match) return false
    if (getBlockId(node) === blockId) {
      match = { node, pos }
      return false
    }
    return true
  })
  return match
}

function textOffsetToPmPos(
  doc: ProseMirrorNode,
  blockPos: number,
  blockNode: ProseMirrorNode,
  textOffset: number,
): number {
  // 将 block.textContent 字符偏移映射到 PM 绝对位置
  let remaining = Math.max(0, textOffset)
  let mapped: number | null = null
  blockNode.descendants((node, pos) => {
    if (mapped !== null) return false
    if (!node.isText || !node.text) return true
    if (remaining <= node.text.length) {
      mapped = blockPos + 1 + pos + remaining
      return false
    }
    remaining -= node.text.length
    return true
  })
  if (mapped !== null) return mapped
  return blockPos + blockNode.nodeSize - 1
}

function pmPosToTextOffsetInBlock(
  doc: ProseMirrorNode,
  blockPos: number,
  blockNode: ProseMirrorNode,
  pmPos: number,
): number {
  let offset = 0
  let done = false
  blockNode.descendants((node, pos) => {
    if (done) return false
    if (!node.isText || !node.text) return true
    const abs = blockPos + 1 + pos
    if (pmPos <= abs) {
      done = true
      return false
    }
    if (pmPos >= abs + node.text.length) {
      offset += node.text.length
      return true
    }
    offset += pmPos - abs
    done = true
    return false
  })
  return offset
}

interface WholeBlockSelection {
  blockId: string
  blockType: string
  selectedText: string
  pos: number
  nodeSize: number
  selectedPos: number
  selectedNodeSize: number
  selectedNodeId?: string
}

function selectionTouchesWholeBlock(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): WholeBlockSelection | null {
  const selectedNode = doc.nodeAt(from)
  if (
    selectedNode
    && (WHOLE_BLOCK_TYPES.has(selectedNode.type.name) || selectedNode.isAtom)
    && to >= from + selectedNode.nodeSize
  ) {
    const $from = doc.resolve(from)
    const topLevelNode = $from.depth > 0 ? $from.node(1) : selectedNode
    const topLevelPos = $from.depth > 0 ? $from.before(1) : from
    const blockId = getBlockId(topLevelNode) ?? getBlockId(selectedNode)
    if (blockId) {
      return {
        blockId,
        blockType: selectedNode.type.name,
        selectedText: blockCommentDescription(selectedNode).selectedText,
        pos: topLevelPos,
        nodeSize: topLevelNode.nodeSize,
        selectedPos: from,
        selectedNodeSize: selectedNode.nodeSize,
        selectedNodeId: getBlockId(selectedNode) ?? undefined,
      }
    }
  }

  let found: WholeBlockSelection | null = null
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (found || parent !== doc) return true
    const blockId = getBlockId(node)
    if (!blockId) return false
    // NodeSelection / 块菜单：精确覆盖整块 → 块级评论
    const exactNode = from === pos && to === pos + node.nodeSize
    // 图片/表格等原子块：选区略宽于节点边界也算整块
    const looseAtom = (WHOLE_BLOCK_TYPES.has(node.type.name) || node.isAtom)
      && from <= pos + 1
      && to >= pos + node.nodeSize - 1
    if (exactNode || looseAtom) {
      const description = blockCommentDescription(node)
      found = {
        blockId,
        blockType: description.blockType,
        selectedText: description.selectedText,
        pos,
        nodeSize: node.nodeSize,
        selectedPos: pos,
        selectedNodeSize: node.nodeSize,
        selectedNodeId: getBlockId(node) ?? undefined,
      }
    }
    return false
  })
  return found
}

function buildInlineNodeAnchor(
  selection: NonNullable<ReturnType<typeof selectionTouchesWholeBlock>>,
  yjsCodec: CommentYjsCodec | null | undefined,
  state: EditorState | null,
): BuildCommentAnchorResult {
  const anchor: CommentAnchorV1 = {
    version: 1,
    block_ids: [selection.blockId],
    block_type: selection.blockType,
    selected_text: selection.selectedText,
    node_offset: selection.selectedPos - selection.pos,
    node_size: selection.selectedNodeSize,
    node_id: selection.selectedNodeId,
  }

  if (yjsCodec && state) {
    const yFrom = yjsCodec.encode(selection.selectedPos, state)
    const yTo = yjsCodec.encode(selection.selectedPos + selection.selectedNodeSize, state)
    if (yFrom && yTo) {
      anchor.yjs_from = yFrom
      anchor.yjs_to = yTo
    }
  }

  return {
    scope: 'block',
    anchor,
    selected_text: selection.selectedText,
  }
}

function buildBlockAnchorAtPos(
  doc: ProseMirrorNode,
  pos: number,
  yjsCodec: CommentYjsCodec | null | undefined,
  state: EditorState | null,
  descriptionOverride?: { blockType: string; selectedText: string },
): BuildCommentAnchorResult | null {
  if (pos < 0 || pos >= doc.content.size) return null
  const node = doc.nodeAt(pos)
  if (!node) return null
  // 仅顶层块
  let isTopLevel = false
  doc.forEach((child, childPos) => {
    if (childPos === pos) isTopLevel = true
  })
  if (!isTopLevel) return null
  const blockId = getBlockId(node)
  if (!blockId) return null
  const description = descriptionOverride ?? blockCommentDescription(node)
  const selectedText = description.selectedText
  const anchor: CommentAnchorV1 = {
    version: 1,
    block_ids: [blockId],
    block_type: description.blockType,
    selected_text: selectedText,
  }
  if (yjsCodec && state) {
    const yFrom = yjsCodec.encode(pos, state)
    const yTo = yjsCodec.encode(pos + node.nodeSize, state)
    if (yFrom && yTo) {
      anchor.yjs_from = yFrom
      anchor.yjs_to = yTo
    }
  }
  return {
    scope: 'block',
    anchor,
    selected_text: selectedText,
  }
}

function buildTextRangeAnchor(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  yjsCodec: CommentYjsCodec | null | undefined,
  state: EditorState | null,
): BuildCommentAnchorResult {
  const blockIds = collectTopLevelBlockIdsInRange(doc, from, to)
  const selectedText = doc.textBetween(from, to, '\n')
  const firstId = blockIds[0]
  const lastId = blockIds[blockIds.length - 1]
  let startOffset: number | undefined
  let endOffset: number | undefined

  if (firstId) {
    const first = findBlockPosById(doc, firstId)
    if (first) {
      startOffset = pmPosToTextOffsetInBlock(doc, first.pos, first.node, from)
    }
  }
  if (lastId) {
    const last = findBlockPosById(doc, lastId)
    if (last) {
      endOffset = pmPosToTextOffsetInBlock(doc, last.pos, last.node, to)
    }
  }

  const prefix = contextSnippet(doc.textBetween(Math.max(0, from - 80), from, ' '), 'prefix')
  const suffix = contextSnippet(doc.textBetween(to, Math.min(doc.content.size, to + 80), ' '), 'suffix')

  const anchor: CommentAnchorV1 = {
    version: 1,
    block_ids: blockIds.length > 0 ? blockIds : undefined,
    start_offset: startOffset,
    end_offset: endOffset,
    selected_text: selectedText,
    prefix_text: prefix || undefined,
    suffix_text: suffix || undefined,
  }

  if (yjsCodec && state) {
    const yFrom = yjsCodec.encode(from, state)
    const yTo = yjsCodec.encode(to, state)
    if (yFrom && yTo) {
      anchor.yjs_from = yFrom
      anchor.yjs_to = yTo
    }
  }

  return {
    scope: 'text_range',
    anchor,
    selected_text: selectedText,
  }
}

/**
 * 从当前 Editor selection 构建锚点。
 * 空选区 / document 级评论请直接用 scope=document。
 */
export function buildCommentAnchorFromSelection(
  editor: Pick<EditorInstance, 'state'>,
  options: BuildCommentAnchorOptions = {},
): BuildCommentAnchorResult | null {
  const { from, to, empty } = editor.state.selection
  if (empty || from === to) return null

  const doc = editor.state.doc
  const yjsCodec = options.yjsCodec === undefined
    ? createDefaultYjsCodec()
    : options.yjsCodec

  const whole = selectionTouchesWholeBlock(doc, from, to)
  if (whole && collectTopLevelBlockIdsInRange(doc, from, to).length === 1) {
    if (whole.selectedPos !== whole.pos) {
      return buildInlineNodeAnchor(whole, yjsCodec, editor.state)
    }
    return buildBlockAnchorAtPos(doc, whole.pos, yjsCodec, editor.state, {
      blockType: whole.blockType,
      selectedText: whole.selectedText,
    })
  }

  return buildTextRangeAnchor(doc, from, to, yjsCodec, editor.state)
}

/**
 * 从块菜单节点位置构建块级锚点（不依赖异步选区落定）。
 */
export function buildCommentAnchorFromBlockPos(
  editor: Pick<EditorInstance, 'state'>,
  nodePos: number,
  options: BuildCommentAnchorOptions = {},
): BuildCommentAnchorResult | null {
  const yjsCodec = options.yjsCodec === undefined
    ? createDefaultYjsCodec()
    : options.yjsCodec
  return buildBlockAnchorAtPos(editor.state.doc, nodePos, yjsCodec, editor.state)
}

function resolveViaYjs(
  anchor: CommentAnchorV1,
  state: EditorState,
  codec: CommentYjsCodec,
): ResolvedCommentAnchor | null {
  if (!anchor.yjs_from || !anchor.yjs_to) return null
  const from = codec.decode(anchor.yjs_from, state)
  const to = codec.decode(anchor.yjs_to, state)
  if (from == null || to == null) return null
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  if (lo === hi) return null
  if (lo < 0 || hi > state.doc.content.size) return null
  return {
    from: lo,
    to: hi,
    strategy: 'yjs',
    blockIds: collectTopLevelBlockIdsInRange(state.doc, lo, hi),
  }
}

function rangeMatchesSelectedText(
  doc: ProseMirrorNode,
  range: Pick<ResolvedCommentAnchor, 'from' | 'to'>,
  anchor: CommentAnchorV1,
): boolean {
  const selectedText = normalizeWhitespace(anchor.selected_text ?? '')
  if (!selectedText) return true
  return normalizeWhitespace(doc.textBetween(range.from, range.to, '\n')) === selectedText
}

function resolveViaBlockOffset(
  doc: ProseMirrorNode,
  anchor: CommentAnchorV1,
): ResolvedCommentAnchor | null {
  if (anchor.node_id) {
    const identified = findBlockPosById(doc, anchor.node_id)
    if (identified && (!anchor.block_type || identified.node.type.name === anchor.block_type)) {
      return {
        from: identified.pos,
        to: identified.pos + identified.node.nodeSize,
        strategy: 'block_offset',
        blockIds: collectTopLevelBlockIdsInRange(
          doc,
          identified.pos,
          identified.pos + identified.node.nodeSize,
        ),
      }
    }
  }

  const blockIds = (anchor.block_ids ?? []).filter(Boolean)
  if (blockIds.length === 0) return null

  // 校验全部 block 仍存在
  for (const id of blockIds) {
    if (!findBlockPosById(doc, id)) {
      return anchor.block_type === 'image'
        ? resolveUniqueNodeByDescription(doc, anchor)
        : null
    }
  }

  const first = findBlockPosById(doc, blockIds[0]!)
  if (!first) return null

  if (
    anchor.block_type
    && (typeof anchor.node_offset === 'number' || anchor.block_type === 'image')
  ) {
    const blockType = anchor.block_type
    const selectedText = normalizeWhitespace(anchor.selected_text ?? '')
    const matchesAnchorNode = (node: ProseMirrorNode | null | undefined): node is ProseMirrorNode => {
      if (!node || node.type.name !== blockType) return false
      if (typeof anchor.node_size === 'number' && node.nodeSize !== anchor.node_size) return false
      if (!selectedText) return true
      return normalizeWhitespace(blockCommentDescription(node).selectedText) === selectedText
    }
    if (typeof anchor.node_offset === 'number') {
      const expectedPos = first.pos + anchor.node_offset
      const expectedNode = doc.nodeAt(expectedPos)
      if (matchesAnchorNode(expectedNode)) {
        return {
          from: expectedPos,
          to: expectedPos + expectedNode.nodeSize,
          strategy: 'block_offset',
          blockIds: [blockIds[0]!],
        }
      }
    }

    const candidates: Array<{ pos: number; nodeSize: number }> = []
    first.node.descendants((node, pos) => {
      if (!matchesAnchorNode(node)) return true
      candidates.push({ pos: first.pos + 1 + pos, nodeSize: node.nodeSize })
      return true
    })
    if (candidates.length === 1) {
      return {
        from: candidates[0]!.pos,
        to: candidates[0]!.pos + candidates[0]!.nodeSize,
        strategy: 'block_offset',
        blockIds: [blockIds[0]!],
      }
    }
    return anchor.block_type === 'image'
      ? resolveUniqueNodeByDescription(doc, anchor)
      : null
  }

  const isWholeBlock = Boolean(anchor.block_type)
    || (
      blockIds.length === 1
      && typeof anchor.start_offset !== 'number'
      && typeof anchor.end_offset !== 'number'
    )

  if (isWholeBlock) {
    return {
      from: first.pos,
      to: first.pos + first.node.nodeSize,
      strategy: 'block_offset',
      blockIds: [blockIds[0]!],
    }
  }

  const endBlock = findBlockPosById(doc, blockIds[blockIds.length - 1]!)
  if (!endBlock) return null

  const startOffset = typeof anchor.start_offset === 'number' ? anchor.start_offset : 0
  const endOffset = typeof anchor.end_offset === 'number'
    ? anchor.end_offset
    : endBlock.node.textContent.length

  const from = textOffsetToPmPos(doc, first.pos, first.node, startOffset)
  const to = textOffsetToPmPos(doc, endBlock.pos, endBlock.node, endOffset)
  if (from >= to) return null

  return {
    from,
    to,
    strategy: 'block_offset',
    blockIds,
  }
}

function resolveUniqueNodeByDescription(
  doc: ProseMirrorNode,
  anchor: CommentAnchorV1,
): ResolvedCommentAnchor | null {
  if (!anchor.block_type) return null
  const selectedText = normalizeWhitespace(anchor.selected_text ?? '')
  const candidates: Array<{ pos: number; nodeSize: number }> = []
  doc.descendants((node, pos) => {
    if (node.type.name !== anchor.block_type) return true
    if (
      selectedText
      && normalizeWhitespace(blockCommentDescription(node).selectedText) !== selectedText
    ) return true
    candidates.push({ pos, nodeSize: node.nodeSize })
    return true
  })
  if (candidates.length !== 1) return null
  const candidate = candidates[0]!
  return {
    from: candidate.pos,
    to: candidate.pos + candidate.nodeSize,
    strategy: 'block_offset',
    blockIds: collectTopLevelBlockIdsInRange(
      doc,
      candidate.pos,
      candidate.pos + candidate.nodeSize,
    ),
  }
}

function resolveViaContext(
  doc: ProseMirrorNode,
  anchor: CommentAnchorV1,
): ResolvedCommentAnchor | null {
  const selected = normalizeWhitespace(anchor.selected_text ?? '')
  if (!selected) return null

  const matches = findTextInDoc(doc, selected)
  if (matches.length === 0) return null

  const prefix = normalizeWhitespace(anchor.prefix_text ?? '')
  const suffix = normalizeWhitespace(anchor.suffix_text ?? '')

  const scored = matches.map((match) => {
    const before = normalizeWhitespace(doc.textBetween(Math.max(0, match.from - 80), match.from, ' '))
    const after = normalizeWhitespace(doc.textBetween(match.to, Math.min(doc.content.size, match.to + 80), ' '))
    let score = 0
    if (prefix && before.endsWith(prefix)) score += 2
    else if (prefix && before.includes(prefix)) score += 1
    if (suffix && after.startsWith(suffix)) score += 2
    else if (suffix && after.includes(suffix)) score += 1
    return { match, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]!
  // 有上下文时要求至少命中一侧；无上下文则仅当唯一匹配
  if (prefix || suffix) {
    if (best.score <= 0) return null
  } else if (matches.length !== 1) {
    return null
  }

  return {
    from: best.match.from,
    to: best.match.to,
    strategy: 'context',
    blockIds: collectTopLevelBlockIdsInRange(doc, best.match.from, best.match.to),
  }
}

export interface ResolveCommentAnchorOptions {
  yjsCodec?: CommentYjsCodec | null
  state?: EditorState | null
}

/**
 * 将锚点解析为 PM range。全部策略失败 → detached（返回 null）。
 */
export function resolveCommentAnchor(
  doc: ProseMirrorNode,
  anchor: CommentAnchorV1 | Record<string, unknown> | null | undefined,
  options: ResolveCommentAnchorOptions = {},
): ResolvedCommentAnchor | null {
  if (!anchor || typeof anchor !== 'object') return null
  const normalized = anchor as CommentAnchorV1
  const yjsCodec = options.yjsCodec === undefined
    ? createDefaultYjsCodec()
    : options.yjsCodec
  const state = options.state ?? null

  if (yjsCodec && state) {
    const viaYjs = resolveViaYjs(normalized, state, yjsCodec)
    // Yjs relative positions are the live source of truth. Their range is
    // expected to shrink when part of the quoted text is deleted; requiring
    // an exact match with the creation-time quote would detach the comment on
    // any partial edit. A fully deleted range is already rejected as
    // collapsed by resolveViaYjs.
    if (viaYjs) return viaYjs
  }

  const viaBlock = resolveViaBlockOffset(doc, normalized)
  if (viaBlock && (
    Boolean(normalized.block_type)
    || rangeMatchesSelectedText(doc, viaBlock, normalized)
  )) return viaBlock

  return resolveViaContext(doc, normalized)
}

export function enrichCommentAnchorWithNodeId(
  doc: ProseMirrorNode,
  anchor: CommentAnchorV1,
  options: ResolveCommentAnchorOptions = {},
): CommentAnchorV1 {
  if (anchor.node_id || !anchor.block_type) return anchor
  const resolved = resolveCommentAnchor(doc, anchor, options)
  if (!resolved) return anchor
  const node = doc.nodeAt(resolved.from)
  const nodeId = node ? getBlockId(node) : null
  if (!node?.isInline || !nodeId || node.type.name !== anchor.block_type) return anchor
  return { ...anchor, node_id: nodeId }
}

export function markAnchorDetachedStatus(
  resolved: ResolvedCommentAnchor | null,
): 'attached' | 'detached' {
  return resolved ? 'attached' : 'detached'
}

/** 重新关联：用当前选区生成新锚点（供宿主 PATCH /anchor）。 */
export function buildReanchorPayload(
  editor: Pick<EditorInstance, 'state'>,
  options: BuildCommentAnchorOptions = {},
): { scope: 'text_range' | 'block'; anchor: CommentAnchorV1 } | null {
  const built = buildCommentAnchorFromSelection(editor, options)
  if (!built || built.scope === 'document') return null
  return { scope: built.scope, anchor: built.anchor }
}

export function clampSelectionToDoc(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { from: number; to: number } {
  const max = doc.content.size
  const lo = clamp(Math.min(from, to), 0, max)
  const hi = clamp(Math.max(from, to), 0, max)
  return { from: lo, to: hi }
}

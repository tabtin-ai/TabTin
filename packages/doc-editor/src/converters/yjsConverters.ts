/**
 * Y.js ↔ ProseMirror 格式转换工具
 *
 * 主要供 collab-live 服务端使用（Node.js 环境）。
 * 所有函数在浏览器端也可用。
 *
 * 依赖 yjs 和 y-prosemirror，作为可选 peer dependency。
 *
 * @format **YJS 格式契约**：本模块所有 API 仅支持 YJS **v1** Update 格式。
 * 客户端和 collab-live 服务端必须统一使用 v1 API（`applyUpdate`、`encodeStateAsUpdate`）。
 * v2 格式（`applyUpdateV2`、`encodeStateAsUpdateV2`）不受支持——传入 v2 二进制
 * 将被 `assertYjsV1Update` 拦截并拒绝处理。
 */

import type { JSONContent } from '@tiptap/core'
import { getDocServerSchema } from '../schema/serverSchema.js'
import { normalizeMathPmJson } from './normalizeMathPmJson.js'
import { repairLeakedHtmlBlockInPmJson } from './repairLeakedHtmlBlock.js'

/* ─── PAR-028: YJS v1 Update 格式校验 ─── */

/**
 * 读取 lib0 VarUint 编码的无符号整数（YJS v1 内部使用此编码）。
 * @returns [value, bytesConsumed] 或 null（数据截断/格式异常）
 */
function readVarUint(data: Uint8Array, offset: number): [number, number] | null {
  let num = 0
  let mult = 1
  let len = 0
  while (offset + len < data.length) {
    const byte = data[offset + len]!
    num += (byte & 0x7F) * mult
    len++
    if (byte < 0x80) return [num, len]
    mult *= 128
    if (len > 5) return null
  }
  return null
}

/**
 * 校验 Uint8Array 是否为合法的 YJS v1 Update 二进制。
 *
 * YJS v1 Update 结构：
 * - VarUint: struct client entry 数量
 * - 每个 client entry: VarUint(clientID), VarUint(clock), VarUint(numStructs), ...
 * - VarUint: delete set entry 数量
 * - 每个 delete entry: VarUint(clientID), VarUint(numRanges), ...
 *
 * 最小合法 v1 update：`[0, 0]`（0 struct entries + 0 delete entries）
 *
 * @param binary 待校验的二进制数据
 * @returns true 如果格式通过基本 v1 结构校验
 */
export function isValidYjsV1Update(binary: Uint8Array): boolean {
  if (binary.length < 2) return false

  const result = readVarUint(binary, 0)
  if (!result) return false

  const [clientCount, bytesConsumed] = result

  if (clientCount > 10_000) return false
  if (clientCount === 0 && binary.length < bytesConsumed + 1) return false

  return true
}

/**
 * 断言二进制为合法 YJS v1 Update 格式，否则抛出 Error。
 * 用于所有 `applyUpdate` 调用前的前置校验。
 */
function assertYjsV1Update(binary: Uint8Array, context: string): void {
  if (!isValidYjsV1Update(binary)) {
    throw new Error(
      `[yjsConverters] ${context}: 二进制数据未通过 YJS v1 格式校验。` +
      `长度=${binary.length}, 首字节=0x${binary.length > 0 ? binary[0]!.toString(16).padStart(2, '0') : 'N/A'}. ` +
      '本系统仅支持 YJS v1 Update 格式，请确认客户端未使用 applyUpdateV2/encodeStateAsUpdateV2。'
    )
  }
}

/**
 * 将 Y.js binary (Uint8Array) 转换为 ProseMirror JSON
 *
 * 流程: Y.js binary → Y.Doc → Y.XmlFragment → ProseMirror Node → JSON → 未知节点降级
 *
 * 转换后会校验所有节点类型是否存在于 serverSchema 中。
 * 未知类型的节点会被降级为 paragraph 并附加 `data-unknown-type` 属性，
 * 以保护用户内容不被静默丢弃。
 *
 * @param binary Y.js 文档二进制数据
 * @param fragmentName Y.js fragment 名称，默认 'default'
 * @returns ProseMirror JSON 或 null（如果转换失败）
 */
export async function binaryToPmJson(
  binary: Uint8Array,
  fragmentName: string = 'default'
): Promise<JSONContent | null> {
  if (binary.length === 0) {
    console.warn('[yjsConverters] binaryToPmJson received empty binary — returning null. This may indicate corrupted or missing data.')
    return null
  }

  assertYjsV1Update(binary, 'binaryToPmJson')

  try {
    const Y = await import('yjs')
    const { yXmlFragmentToProsemirrorJSON } = await import('y-prosemirror')

    const ydoc = new Y.Doc()
    try {
      Y.applyUpdate(ydoc, binary)

      const fragment = ydoc.getXmlFragment(fragmentName)
      const pmJson = yXmlFragmentToProsemirrorJSON(fragment)

      const result = pmJson as JSONContent
      if (!result || result.type !== 'doc') {
        console.warn('[yjsConverters] binaryToPmJson: unexpected root type, expected "doc" but got:', result?.type)
        return null
      }
      // 先归一历史 math / mathematics{display:true}，避免被 degradeUnknownNodes 当成未知类型丢掉
      const normalized = normalizeMathPmJson(result)
      const { pmJson: repaired } = repairLeakedHtmlBlockInPmJson(normalized)
      degradeUnknownNodes(repaired)
      return repaired
    } finally {
      ydoc.destroy()
    }
  } catch (error) {
    if (error instanceof RangeError || (error instanceof Error && error.message?.includes('Unexpected'))) {
      console.error('[yjsConverters] binaryToPmJson failed — CORRUPT_BINARY: Y.js binary data is malformed or truncated.', error)
    } else if (error instanceof Error && error.message?.includes('schema')) {
      console.error('[yjsConverters] binaryToPmJson failed — SCHEMA_MISMATCH: document structure does not match the expected schema.', error)
    } else if (error instanceof Error && (error.message?.includes('Cannot find module') || error.message?.includes('MODULE_NOT_FOUND'))) {
      console.error('[yjsConverters] binaryToPmJson failed — DEPENDENCY_MISSING: yjs or y-prosemirror is not installed.', error)
    } else {
      console.error('[yjsConverters] binaryToPmJson failed — UNKNOWN_ERROR:', error)
    }
    return null
  }
}

const INLINE_CONTENT_TYPES = new Set(['text', 'image', 'mathematics', 'hardBreak'])

let _knownNodeTypes: Set<string> | null = null

function getKnownNodeTypes(): Set<string> {
  if (_knownNodeTypes) return _knownNodeTypes
  const schema = getDocServerSchema()
  _knownNodeTypes = new Set(Object.keys(schema.nodes))
  return _knownNodeTypes
}

/**
 * 递归遍历 ProseMirror JSON 树，将 Schema 中不存在的节点类型
 * 降级为 paragraph，保留文本内容，附加 data-unknown-type 属性。
 *
 * PAR-019: 降级时只保留 data-unknown-type，不散布原始 attrs。
 * PAR-020: 降级后检查 content 兼容性，非 inline 子节点递归降级。
 * PAR-021: 保留原节点的 marks。
 */
function degradeUnknownNodes(node: JSONContent): void {
  const knownNodeTypes = getKnownNodeTypes()

  function flattenToParagraphContent(children: JSONContent[]): JSONContent[] {
    const result: JSONContent[] = []
    for (const child of children) {
      if (child.type && INLINE_CONTENT_TYPES.has(child.type)) {
        result.push(child)
      } else if (child.content) {
        result.push(...flattenToParagraphContent(child.content))
      }
    }
    return result
  }

  function walk(n: JSONContent): void {
    if (!n.content) return
    for (let i = 0; i < n.content.length; i++) {
      const child = n.content[i]!
      if (child.type && child.type !== 'text' && !knownNodeTypes.has(child.type)) {
        console.warn(
          `[yjsConverters] 未知节点类型 "${child.type}" 已降级为 paragraph。` +
          '请检查 Schema 是否需要更新，或客户端版本是否过旧。'
        )
        const safeContent = child.content
          ? flattenToParagraphContent(child.content)
          : undefined
        const degraded: JSONContent = {
          type: 'paragraph',
          attrs: { 'data-unknown-type': child.type },
          ...(safeContent && safeContent.length > 0 ? { content: safeContent } : {}),
          ...(child.marks ? { marks: child.marks } : {}),
        }
        n.content[i] = degraded
        walk(degraded)
      } else {
        walk(child)
      }
    }
  }

  walk(node)
}

/**
 * 将 ProseMirror JSON 转换为 Y.js binary (Uint8Array)
 *
 * 流程: ProseMirror JSON → ProseMirror Node → Y.XmlFragment → Y.Doc → binary
 *
 * @param pmJson ProseMirror JSON
 * @param fragmentName Y.js fragment 名称，默认 'default'
 * @returns Y.js 文档二进制数据 或 null
 */
export async function pmJsonToBinary(
  pmJson: JSONContent,
  fragmentName: string = 'default'
): Promise<Uint8Array | null> {
  try {
    const Y = await import('yjs')
    const { prosemirrorJSONToYXmlFragment } = await import('y-prosemirror')

    const ydoc = new Y.Doc()
    try {
      const fragment = ydoc.getXmlFragment(fragmentName)
      const normalized = normalizeMathPmJson(pmJson)
      prosemirrorJSONToYXmlFragment(getDocServerSchema(), normalized, fragment)
      return Y.encodeStateAsUpdate(ydoc)
    } finally {
      ydoc.destroy()
    }
  } catch (error) {
    console.error('[yjsConverters] pmJsonToBinary failed:', error)
    return null
  }
}

/**
 * 将 Y.js binary 一次性转换为所有格式
 *
 * @param binary Y.js 文档二进制数据
 * @returns { pmJson, html, plaintext, markdown } 或 null
 */
export async function binaryToAllFormats(
  binary: Uint8Array,
  fragmentName: string = 'default'
): Promise<{
  pmJson: JSONContent
  html: string
  plaintext: string
  markdown: string
} | null> {
  try {
    const pmJson = await binaryToPmJson(binary, fragmentName)
    if (!pmJson) return null

    const { pmJsonToHtml } = await import('./pmJsonToHtml.js')
    const html = pmJsonToHtml(pmJson)

    const { pmJsonToMarkdown } = await import('./pmJsonToMarkdown.js')
    const markdown = pmJsonToMarkdown(pmJson)

    const plaintext = extractPlaintext(pmJson)

    return { pmJson, html, plaintext, markdown }
  } catch (error) {
    console.error('[yjsConverters] binaryToAllFormats failed:', error)
    return null
  }
}

/**
 * 合并多个 Y.js update binary 到一个文档
 *
 * @param baseBinary 基础文档 binary（可选）
 * @param updates 增量 update binary 列表
 * @returns 合并后的完整 Y.js binary
 */
export async function mergeYjsUpdates(
  baseBinary: Uint8Array | null,
  updates: Uint8Array[]
): Promise<Uint8Array> {
  try {
    const Y = await import('yjs')

    const allUpdates: Uint8Array[] = []
    if (baseBinary && baseBinary.length > 0) {
      assertYjsV1Update(baseBinary, 'mergeYjsUpdates(baseBinary)')
      allUpdates.push(baseBinary)
    }
    for (const u of updates) {
      if (u.length > 0) {
        assertYjsV1Update(u, 'mergeYjsUpdates(update)')
        allUpdates.push(u)
      }
    }

    if (allUpdates.length === 0) {
      const emptyDoc = new Y.Doc()
      try {
        return Y.encodeStateAsUpdate(emptyDoc)
      } finally {
        emptyDoc.destroy()
      }
    }

    return Y.mergeUpdates(allUpdates)
  } catch (error) {
    console.error('[yjsConverters] mergeYjsUpdates failed:', error)
    throw error
  }
}

/**
 * 计算增量 diff（用于 DocHistory 增量存储）
 *
 * @param oldBinary 旧文档 binary
 * @param newBinary 新文档 binary
 * @returns 增量 update binary（从 old 到 new 的差异）
 */
export async function computeYjsDiff(
  oldBinary: Uint8Array,
  newBinary: Uint8Array
): Promise<Uint8Array> {
  assertYjsV1Update(oldBinary, 'computeYjsDiff(oldBinary)')
  assertYjsV1Update(newBinary, 'computeYjsDiff(newBinary)')

  const Y = await import('yjs')

  const oldDoc = new Y.Doc()
  let newDoc: InstanceType<typeof Y.Doc> | null = null
  try {
    Y.applyUpdate(oldDoc, oldBinary)
    const stateVector = Y.encodeStateVector(oldDoc)

    newDoc = new Y.Doc()
    Y.applyUpdate(newDoc, newBinary)
    return Y.encodeStateAsUpdate(newDoc, stateVector)
  } finally {
    oldDoc.destroy()
    newDoc?.destroy()
  }
}

/**
 * 从 ProseMirror JSON 提取纯文本，保留块级语义结构。
 *
 * - 表格行：单元格之间用 tab 分隔
 * - 列表项：添加缩进前缀（无序 `- `，有序 `N. `）
 * - 数学公式块：保留 LaTeX 文本
 * - 其他块级节点：换行分隔
 */
function extractPlaintext(node: JSONContent, depth = 0): string {
  const type = node.type || ''

  // 文本叶子节点
  if (node.text) {
    return node.text
  }

  // 数学公式（inline / block / 历史 Novel math）
  if (type === 'mathematics' || type === 'mathematicsBlock' || type === 'math') {
    return String(node.attrs?.latex || '')
  }

  const children = node.content || []

  // 表格行：单元格 tab 分隔
  if (type === 'tableRow') {
    return children
      .map(cell => extractPlaintext(cell, depth))
      .join('\t')
  }

  // 列表项
  if (type === 'listItem' || type === 'taskItem') {
    const text = children.map(child => extractPlaintext(child, depth)).join('\n')
    return text
  }

  // 有序列表：添加序号
  if (type === 'orderedList') {
    return children
      .map((child, i) => {
        const text = extractPlaintext(child, depth + 1)
        return `${'  '.repeat(depth)}${i + 1}. ${text}`
      })
      .join('\n')
  }

  // 无序列表：添加 dash 前缀
  if (type === 'bulletList') {
    return children
      .map(child => {
        const text = extractPlaintext(child, depth + 1)
        return `${'  '.repeat(depth)}- ${text}`
      })
      .join('\n')
  }

  // 任务列表
  if (type === 'taskList') {
    return children
      .map(child => {
        const checked = child.attrs?.checked ? 'x' : ' '
        const text = extractPlaintext(child, depth + 1)
        return `${'  '.repeat(depth)}[${checked}] ${text}`
      })
      .join('\n')
  }

  // 通用递归
  const parts: string[] = []
  for (const child of children) {
    const text = extractPlaintext(child, depth)
    if (text) parts.push(text)
  }

  return parts.join('\n').trim()
}

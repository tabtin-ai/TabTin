/**
 * ContentBlock → text_summary 派生 + 占位文案识别。
 *
 * 这一组函数从 `stores/useChatRuntimeStore.ts` 拆出来——它们都是纯函数，
 * 没有 store 依赖，但被 UI 组件（`MessageActions`）和事件 handler
 * （`contentBlockHandler`）需要。如果继续放在 store 文件里，UI 组件会反向依赖
 * store（即便只取一个纯函数），违反 layering。
 *
 * 与 Django 服务端 `apps/services/common/ws/handlers/content_block_reassembler.py::
 * derive_text_summary` **1:1 对齐**——同一份算法、同一套占位文案优先级、
 * 同一个长度上限（200 字按 Unicode code point 计）。前后端不一致会让
 * "刷新前 client 流式期间预览" 与 "刷新后 server 落库摘要" 字面不同。
 *
 * 占位文案改造需 W4.5-B 协调前后端联动，本文件不可单端修改。
 */

import type { ContentBlockEntry } from '@/stores/useChatRuntimeStore'

/**
 * W4a-L27：摘要长度上限（与 Django reassembler `_TEXT_SUMMARY_MAX_CHARS` 严格相等）。
 *
 * 200 字够展示一句完整内容，但不会让 SQL 行过大；客户端这里只做内存派生不
 * 落库，但为了让流式期间预览与服务端落库一致——**必须严格相同长度**。
 */
const _TEXT_SUMMARY_MAX_CHARS = 200

/**
 * `deriveTextSummary` 在「全部都是非 text 块」时返回的占位文案集合——SSoT。
 *
 * 这个集合是**全闭**的：纯非 text 消息派生出的 content/text_summary 必然是
 * 这三个值之一（与 Django reassembler 占位优先级 tool_use > rich > thinking 对齐）。
 *
 * 用途：UI 层（譬如 `MessageActions.handleCopy`）需要识别"派生出来是占位文案"
 * 的消息，跳过复制 / 改用 toast 提示——直接复制字面值 `'[工具调用]'` 给用户毫
 * 无意义。
 *
 * 与 `deriveTextSummary` 内部硬编码的占位文案保持一致；改这三个值时两处必须
 * 同时改（产品占位文案改造需 W4.5-B 协调前后端联动）。
 */
export const TEXT_SUMMARY_PLACEHOLDERS = ['[工具调用]', '[富内容]', '[思考中]'] as const

/** 判定一个 content/text_summary 字符串是否完全是占位文案（即没有真实文字内容）。 */
export function isTextSummaryPlaceholder(content: string | null | undefined): boolean {
  if (!content) return false
  return (TEXT_SUMMARY_PLACEHOLDERS as readonly string[]).includes(content)
}

/**
 * W4a-L27：从 ContentBlockEntry[] 派生 text_summary。
 *
 * 与 Django `apps/services/common/ws/handlers/content_block_reassembler.py::
 * derive_text_summary` **1:1 对齐**——任何派生差异都会让 client 流式预览
 * 与服务端落库摘要不一致，造成"列表点开看到的内容跟列表预览对不上"。
 *
 * 规则：
 * - 拼接所有 `text` 块的 `text` 字段（按 entry.index 升序），用 `\n` 连接
 * - 累计长度达 200 字（按 Unicode code point 计，与 Python `len(str)` 对齐）
 *   提前 break（节省遍历）
 * - 截前 200 字、无省略号（保持纯文本可拼接）
 * - 全部都是非 text 块（罕见但合法）→ 按优先级返回占位文案：
 *   tool_use（任意子类型）> rich（tabtin_rich_content/image/document/video）> thinking
 *
 * **W4.5-A1 Review · P1-4 修复**：长度计算用 `Array.from(text).length` 按
 * Unicode code point，**不**用 `string.length`（UTF-16 code units）——
 * Django 端 Python 3 `len(str)` 返回 code points，emoji（surrogate pair）
 * 在 JS string.length=2 但 Python len=1。如果用 string.length，emoji 时
 * client 端 200 限额更早达到 + slice(0, 200) 可能切到 surrogate pair 中间
 * 渲染产生 U+FFFD 替换字符，与 Django 落库不一致。
 *
 * 入参 `entries` 是 store 内 ContentBlockEntry[]，业务上等价 ContentBlock 序列；
 * 仅消费 entry.block 字段。
 */
export function deriveTextSummary(entries: readonly ContentBlockEntry[] | undefined): string {
  if (!entries || entries.length === 0) return ''
  const parts: string[] = []
  let totalCodePoints = 0
  let hasToolUse = false
  let hasThinking = false
  let hasRich = false
  // 按 index 升序——store 写入时已保 sorted，这里防御性兜底
  const sorted = entries.slice().sort((a, b) => a.index - b.index)
  for (const entry of sorted) {
    const block = entry.block as { type?: string; text?: unknown }
    const blockType = block?.type
    if (blockType === 'text') {
      const text = block.text
      if (typeof text === 'string' && text.length > 0) {
        parts.push(text)
        // Array.from 按 code point 迭代——emoji surrogate pair 算 1 个，与
        // Python `len(str)` 一致
        totalCodePoints += Array.from(text).length
        if (totalCodePoints >= _TEXT_SUMMARY_MAX_CHARS) break
      }
    } else if (
      blockType === 'tool_use'
      || blockType === 'server_tool_use'
      || blockType === 'mcp_tool_use'
    ) {
      hasToolUse = true
    } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      hasThinking = true
    } else if (
      blockType === 'tabtin_rich_content'
      || blockType === 'image'
      || blockType === 'document'
      || blockType === 'video'
    ) {
      hasRich = true
    }
  }
  if (parts.length > 0) {
    // 截取按 code point 而非 UTF-16 code unit，避免切到 surrogate pair 中间
    const joined = parts.join('\n')
    const codePoints = Array.from(joined)
    if (codePoints.length <= _TEXT_SUMMARY_MAX_CHARS) return joined
    return codePoints.slice(0, _TEXT_SUMMARY_MAX_CHARS).join('')
  }
  // 占位优先级与 Django reassembler 严格一致：tool_use > rich > thinking
  if (hasToolUse) return TEXT_SUMMARY_PLACEHOLDERS[0] // '[工具调用]'
  if (hasRich) return TEXT_SUMMARY_PLACEHOLDERS[1] // '[富内容]'
  if (hasThinking) return TEXT_SUMMARY_PLACEHOLDERS[2] // '[思考中]'
  return ''
}

/**
 * 从 ContentBlockEntry[] 派生消息复制用全文。
 *
 * 与 `deriveTextSummary` 不同，这里面向用户点击消息底部 Copy 的主路径：
 * - 只取模型真正输出的 `text` block，跳过工具 / thinking / rich content
 * - 按 block index 顺序用 `\n` 连接，保留 markdown 与段落换行
 * - 不做 200 字摘要截断，避免长回答复制不完整
 */
export function deriveTextClipboardContent(entries: readonly ContentBlockEntry[] | undefined): string {
  if (!entries || entries.length === 0) return ''
  const parts: string[] = []
  const sorted = entries.slice().sort((a, b) => a.index - b.index)
  for (const entry of sorted) {
    const block = entry.block as { type?: string; text?: unknown }
    if (block?.type !== 'text') continue
    if (typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

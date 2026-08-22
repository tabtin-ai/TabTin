/**
 * 富内容呈现类工具的卡片描述符（show_widget / present_to_user 等）。
 *
 * 这类工具的"参数"本身就是要给用户看的内容（譬如 show_widget 的参数是 5KB SVG
 * 源码），或者"结果"是大段产物（譬如 parse_document 的 chunks），都不应该
 * 塞进通用工具卡的"参数 / 结果"区段当 JSON 噪音——产物在
 * `RichKindRouter` 里另起一条 mini-message 气泡渲染，工具卡只剩"我调了哪个呈现
 * 工具 + 简介"的语义。所以这类工具都走 compact 单行（见 `../blocks/compactInlineTools.ts`）：
 *   - 流式中：spinner + "{工具名}"
 *   - 完成后：icon + "{工具名} · {summary}"
 * tool_result 的成功 JSON 也由 compact 路径自动隐藏（紧贴下方的产物气泡就是
 * 实际结果，不需要再展示一遍）。失败时仍渲染让用户看到错误。
 *
 * **覆盖关系**：本表在 `toolCardRegistry.ts` 的 `_BUILTIN_SPREAD` 末尾被 spread，
 * 会覆盖 fileToolCards / agentToolCards 等里同名的完整卡描述符。
 *
 * **不在本表的呈现类工具**：
 *   - `run_terminal_command` — 有 TerminalCard 专属渲染（终端窗口语义太强，不能 compact）
 *   - `cli_output_*` — 这是 mini-message kind，不是 tool_use
 */

import type { ToolCardDescriptor } from '@tabtin/chat-client'
import { resolvePresentToUserItemLabel } from '../richContent/resolveResourceRefDisplayName'
import { truncate, getNestedArgs, basename } from './toolCardUtils'

function extractWidgetSummary(input: unknown): string | null {
  const args = getNestedArgs(input)
  if (!args) return null
  // show_widget 的 summary 字段是"必填"的人类可读描述（同时给移动端 fallback 用），
  // 优先用它；title 是可选标题，作为兜底。
  const summary = typeof args.summary === 'string' ? args.summary : ''
  if (summary) return truncate(summary, 60)
  const title = typeof args.title === 'string' ? args.title : ''
  if (title) return truncate(title, 60)
  return null
}

function extractQuery(input: unknown): string | null {
  const args = getNestedArgs(input)
  if (!args) return null
  const q = (args.query ?? args.keyword ?? args.search_term) as unknown
  if (typeof q !== 'string' || q.length === 0) return null
  return truncate(q, 60)
}

function extractFilePathBasename(input: unknown): string | null {
  const args = getNestedArgs(input)
  if (!args) return null
  // `filename` 由 assistant 展示投影按用户附件 `file_id` 注入；工具真实输入仍
  // 保留 `file_id`。历史/缺失映射时再回退 file_path/path/file_id，避免空白。
  const candidate = (args.filename ?? args.file_path ?? args.path ?? args.file_id) as unknown
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  return basename(candidate)
}

function extractPresentTitle(input: unknown): string | null {
  // present_to_user 有 4 种 sub-kind（image / table_preview / resource_ref / file），
  // 4 种产物气泡视觉差异已经在 RichKindRouter 收口，工具卡 compact 单行优先展示
  // 产物文件名 / 资源名，而不是 Agent 附带的 summary 消息。
  const args = getNestedArgs(input)
  if (!args) return null

  const items = args.items
  if (Array.isArray(items)) {
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue
      const label = resolvePresentToUserItemLabel(raw as Record<string, unknown>)
      if (label) return truncate(label, 60)
    }
  }

  const t = (args.title ?? args.summary) as unknown
  if (typeof t !== 'string' || t.length === 0) return null
  return truncate(t, 60)
}

export const PRESENTATION_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  show_widget: {
    id: 'show_widget',
    category: 'tool',
    labelKey: 'toolName.show_widget',
    icon: 'LayoutTemplate',
    riskLevel: 'safe',
    defaultCollapsed: true,
    renderer: 'GenericToolCard',
    compactSummary: extractWidgetSummary,
  },

  /* ── 语义检索（产物：search_results mini-message 气泡）─── */
  semantic_search: {
    id: 'code_search',
    category: 'tool',
    labelKey: 'toolName.semantic_search',
    icon: 'Search',
    riskLevel: 'safe',
    defaultCollapsed: true,
    renderer: 'GenericToolCard',
    compactSummary: extractQuery,
  },
  code_semantic_search: {
    id: 'code_search',
    category: 'tool',
    labelKey: 'toolName.code_semantic_search',
    icon: 'Search',
    riskLevel: 'safe',
    defaultCollapsed: true,
    renderer: 'GenericToolCard',
    compactSummary: extractQuery,
  },

  /* ── 文档解析（产物：document_excerpt mini-message 气泡）─── */
  parse_document: {
    id: 'doc_parse',
    category: 'tool',
    labelKey: 'toolName.parse_document',
    icon: 'FileText',
    riskLevel: 'safe',
    defaultCollapsed: true,
    renderer: 'GenericToolCard',
    compactSummary: extractFilePathBasename,
  },

  /* ── 记忆检索（产物：memory_card mini-message 气泡）─── */
  memory_search: {
    id: 'memory',
    category: 'tool',
    labelKey: 'toolName.memory_search',
    icon: 'Brain',
    riskLevel: 'safe',
    defaultCollapsed: true,
    renderer: 'GenericToolCard',
    compactSummary: extractQuery,
  },

  /* ── 通用呈递（产物：image / table_preview / resource_ref / file 四种 sub-kind 气泡）─── */
  present_to_user: {
    id: 'present_to_user',
    category: 'tool',
    labelKey: 'toolName.present_to_user',
    icon: 'Sparkles',
    riskLevel: 'safe',
    defaultCollapsed: true,
    renderer: 'GenericToolCard',
    compactSummary: extractPresentTitle,
  },
}

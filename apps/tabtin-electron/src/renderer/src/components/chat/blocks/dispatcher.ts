/**
 * BlockRenderer dispatcher — block.type → BlockRenderer component 映射。
 *
 * 设计原则（v2 §3.5.5 fallback 链）：
 *   1. 已知 block.type → 专属 BlockRenderer
 *   2. tabtin_rich_content 单独家族（内部按 kind 二级 dispatch）
 *   3. 未知 type → FallbackBlockView（"此内容暂不支持，请在桌面端查看"）
 *   4. dispatcher 永不 throw——任何异常走 fallback
 *
 * **开闭原则**：新增 block.type 时只在本 map 添加一项；不改 BlockTimeline / 现有
 * BlockRenderer。
 *
 * **8 家族分类**（派发模板）：
 *   1. text → TextBlockView
 *   2. thinking + redacted_thinking → ThinkingBlockView
 *   3. tool_use → ToolUseBlockView（含 name 二级 dispatcher 复用 ToolStepCard）
 *   4. tool_result → ToolResultBlockView
 *   5. image + document → ImageBlockView
 *   6. server_tool_use + 各 *_tool_result → ServerToolBlockView
 *   7. mcp_tool_use + mcp_tool_result → McpToolBlockView
 *   8. tabtin_rich_content + 其他 tabtin_* + container_upload + search_result
 *      → TabTinRichContentBlockView（含 kind/type 二级 dispatcher）
 */

import type React from 'react'
import { ALL_BLOCK_TYPES, type ContentBlockType } from '@tabtin/agent-wire'
import { TextBlockView } from './TextBlockView'
import { ThinkingBlockView } from './ThinkingBlockView'
import { ToolUseBlockView } from './ToolUseBlockView'
import { ToolResultBlockView } from './ToolResultBlockView'
import { ImageBlockView } from './ImageBlockView'
import { ServerToolBlockView } from './ServerToolBlockView'
import { McpToolBlockView } from './McpToolBlockView'
import { TabTinRichContentBlockView } from './TabTinRichContentBlockView'
import { FallbackBlockView } from './FallbackBlockView'
import type { BlockRendererProps } from './types'

/**
 * W4c · W4b-P1-1 子项 d：BLOCK_DISPATCH 派生使用 `@tabtin/agent-wire/ALL_BLOCK_TYPES`
 * 单源，避免三处（renderer / daemon lite-collector / Django reassembler）独立
 * 维护字面量列表导致漏写。
 *
 * 完整契约：每个 ContentBlockType 必须在本 map 有 entry（即便走通用 fallback
 * 也要显式声明）。TypeScript 类型守门——遗漏 case 会编译失败。
 */
const BLOCK_DISPATCH: Record<ContentBlockType, React.FC<BlockRendererProps>> = {
  text: TextBlockView,
  thinking: ThinkingBlockView,
  redacted_thinking: ThinkingBlockView,
  tool_use: ToolUseBlockView,
  tool_result: ToolResultBlockView,
  image: ImageBlockView,
  document: ImageBlockView,
  server_tool_use: ServerToolBlockView,
  web_search_tool_result: ServerToolBlockView,
  code_execution_tool_result: ServerToolBlockView,
  bash_code_execution_tool_result: ServerToolBlockView,
  text_editor_code_execution_tool_result: ServerToolBlockView,
  mcp_tool_use: McpToolBlockView,
  mcp_tool_result: McpToolBlockView,
  tabtin_rich_content: TabTinRichContentBlockView,
  tabtin_composer_preset: TabTinRichContentBlockView,
  tabtin_ask_user_fields: TabTinRichContentBlockView,
  tabtin_skill_invocation: TabTinRichContentBlockView,
  tabtin_source_ref: TabTinRichContentBlockView,
  tabtin_approval_request: TabTinRichContentBlockView,
  container_upload: TabTinRichContentBlockView,
  search_result: TabTinRichContentBlockView,
}

/**
 * 按 block.type 路由到对应的 BlockRenderer。
 *
 * 永不返回 null / 永不 throw：
 *   - 未知 type → 返回 FallbackBlockView（dispatcher 自包含 fallback 链）
 *   - 仅 block.type 字段缺失 / undefined 时返回 FallbackBlockView
 */
export function getBlockRenderer(blockType: string | undefined | null): React.FC<BlockRendererProps> {
  if (!blockType) return FallbackBlockView
  return BLOCK_DISPATCH[blockType as keyof typeof BLOCK_DISPATCH] ?? FallbackBlockView
}

/**
 * 测试用：所有已注册的 block.type 字符串。
 *
 * 来自 wire 层 ALL_BLOCK_TYPES（W4c · W4b-P1-1 子项 d 单源契约），
 * `BLOCK_DISPATCH` 的 keys 必须与之一致（TypeScript 类型守门）。
 */
export const DISPATCH_KEYS: readonly string[] = ALL_BLOCK_TYPES

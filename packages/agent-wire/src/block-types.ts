/**
 * ContentBlock type 字符串单源（W4c · W4b-P1-1 子项 d）。
 *
 * 背景：W4b 实施期间三处 hardcode 同一份 block.type 字面量列表——
 *   1. `apps/tabtin-electron/src/renderer/src/components/chat/blocks/dispatcher.ts`
 *      （BLOCK_DISPATCH map 的 keys）
 *   2. `apps/tabtin-electron/src/renderer/src/components/chat/blocks/legacyBlocksAdapter.ts`
 *      （legacy MessageBlock → ContentBlock 适配的允许 type 校验）
 *   3. `apps/tabtin-electron/src/renderer/src/components/chat/blocks/types.ts`
 *      （isKnownBlockType 集合）
 *
 * 上述三处都已从 `ALL_BLOCK_TYPE_SET` 派生使用——新增 block type 时只需
 * 在本文件追加，三处自动同步。
 *
 * **当前状态（W4c 后）的"非派生消费方"——已登记 Wave 7/8 收口**：
 *   - `packages/agent-runtime/src/engine/lite-blocks-collector.ts` daemon 端
 *     使用内联 type 分支判断（W4c must-not-touch；登记 W7 wire 清理时一并
 *     改为 import 派生）
 *   - `apps/tabtin_django/apps/services/common/ws/handlers/content_block_reassembler.py`
 *     Django 端走 generated Pydantic union 走另一条 codegen 路径（不直接
 *     消费 TS 常量；跨语言 SSOT 在 `packages/agent-wire/src/codegen/` 已
 *     建立——zod schema 是真单源，本文件常量与 zod union 一致由测试守门）
 *   - `apps/tabtin-electron/src/preload/index.ts` `VALID_CONTENT_BLOCK_TYPES`
 *     在 main 进程域，preload runtime 校验仅 5 类（W4c must-not-touch；登记
 *     Wave 7 收口时同步派生）
 *
 * **不变量**：
 *   - 任何新增 block.type 必须同步：(a) `stream-content-block.ts` 的 zod
 *     schema 加 case + 入 ContentBlockSchema union; (b) 本文件追加常量;
 *     (c) Renderer dispatcher / legacyBlocksAdapter / types.ts 自动 SSOT
 *     生效；(d) daemon lite-collector / Django reassembler / preload 三处
 *     当前需手动同步（推 W7/W8 改派生）
 *   - 删除 block.type 时反向：先确保所有消费方迁移走，再清本文件 + zod
 *
 * **与 stream-content-block.ts 关系**：本文件是"轻量字符串列表"，方便消费方
 * 不引入 zod 依赖即可拿到 type set；zod 完整 schema 仍以 stream-content-block.ts
 * 的 ContentBlockSchema 为准（runtime parse + 类型推导）。
 *
 * @see ./stream-content-block.ts ContentBlockSchema § 22 case discriminated union
 */

/**
 * Anthropic 标准 ContentBlock 16 case（v2 §2.2.1）。
 *
 * 来源：Anthropic Messages API SSE protocol；本仓 stream-content-block.ts
 * 的 ContentBlockSchema 第 1-16 case。
 */
export const STANDARD_BLOCK_TYPES = [
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
  'image',
  'document',
  'server_tool_use',
  'web_search_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
  'search_result',
] as const

/**
 * TabTin 受控扩展 ContentBlock 6 case（v2 §2.2.3）。
 *
 * `tabtin_*` 前缀策略：让人类阅读 jsonl / DB 时一眼识别自家方言，也方便
 * PG `content_blocks_json` strip 操作（`block.type.startsWith('tabtin_')`
 * 一行全部剥离）。
 */
export const TABTIN_BLOCK_TYPES = [
  'tabtin_rich_content',
  'tabtin_composer_preset',
  'tabtin_ask_user_fields',
  'tabtin_skill_invocation',
  'tabtin_source_ref',
  'tabtin_approval_request',
] as const

/**
 * 完整 ContentBlock type 列表（22 case = 16 标准 + 6 tabtin_*）。
 *
 * **当前已派生消费方**（W4c 后）：
 *   - `apps/tabtin-electron/src/renderer/src/components/chat/blocks/dispatcher.ts`
 *     —— `DISPATCH_KEYS = ALL_BLOCK_TYPES` + BLOCK_DISPATCH map 全覆盖 TS 守门
 *   - `apps/tabtin-electron/src/renderer/src/components/chat/blocks/legacyBlocksAdapter.ts`
 *     —— `ANTHROPIC_NATIVE_TYPES = ALL_BLOCK_TYPE_SET`
 *   - `apps/tabtin-electron/src/renderer/src/components/chat/blocks/types.ts`
 *     —— `isKnownBlockType` + `KNOWN_BLOCK_TYPES` re-export
 *
 * **未派生消费方**（推 Wave 7/8 收口）：
 *   - daemon `lite-blocks-collector.ts`（W4c must-not-touch）
 *   - Django `content_block_reassembler.py`（走 generated Pydantic 另一条
 *     codegen 路径；跨语言 SSOT 在 zod schema 层）
 *   - preload `VALID_CONTENT_BLOCK_TYPES`（W4c must-not-touch；W7 同步派生）
 *
 * 任何**新增**消费方代码硬编码 type 字符串列表都应改为 import 本常量。
 */
export const ALL_BLOCK_TYPES = [
  ...STANDARD_BLOCK_TYPES,
  ...TABTIN_BLOCK_TYPES,
] as const

/**
 * `ALL_BLOCK_TYPES` 元素类型——可用于函数签名、类型守卫等。
 *
 * 与 stream-content-block.ts 的 ContentBlock 类型互补：
 *   - `ContentBlockType`（本文件）：字符串字面量 union，运行时检查 / set 成员
 *   - `ContentBlock`（stream-content-block.ts）：完整 discriminated union 含
 *     字段，zod parse 后类型推导
 */
export type ContentBlockType = typeof ALL_BLOCK_TYPES[number]

/**
 * O(1) 成员检查 set——dispatcher / reassembler 校验入站 block.type 时用。
 *
 * 用法：
 * ```ts
 * import { ALL_BLOCK_TYPE_SET } from '@tabtin/agent-wire'
 * if (ALL_BLOCK_TYPE_SET.has(block.type)) { ... } else { /* fallback *​/ }
 * ```
 */
export const ALL_BLOCK_TYPE_SET: ReadonlySet<string> = new Set<string>(
  ALL_BLOCK_TYPES,
)

/**
 * 类型守卫——检查任意字符串是否为已知 ContentBlock type。
 */
export function isKnownBlockType(type: unknown): type is ContentBlockType {
  return typeof type === 'string' && ALL_BLOCK_TYPE_SET.has(type)
}

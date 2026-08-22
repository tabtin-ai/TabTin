/**
 * Anthropic Messages API 对齐 · ContentBlock + 三件套 schema (Wave 1)
 *
 * 本文件是 Wave 1 协议层落地的核心：定义 16 标准 ContentBlock + 6 tabtin_*
 * 扩展（共 22 case discriminated union）+ 6 envelope (message_* / content_block_*)。
 *
 * **协议层归零完成（W4.5 第三波 C1，2026-05-13）**：本文件是新协议唯一活路径；
 * 老协议 schema（StreamAssistantSchema / StreamReasoningSchema / StreamToolSchema 等）
 * 已从 `stream.ts` 物理删除，仅保留 StreamStepSchema（C1 范围外，daemon 仍 emit）。
 *
 * **设计参考**：
 *
 * **Codegen 出口**：本文件是 wire-codegen 的 SSoT。`packages/wire-codegen/`
 * 把本文件的 zod schema 转成 JSON Schema 后再生成 4 端类型（Python/Swift/
 * Kotlin/TS）。修改本文件后必须跑 `pnpm wire:codegen` 同步 generated 文件。
 *
 * **强制使用 z.discriminatedUnion**：所有 union 都用 `z.discriminatedUnion`
 * 而非裸 `z.union`，理由（见 W0 PoC §4 实测对比）：
 *   - z.union 错误信息能列 N×M 行 variant 失败（嵌套 union 时无法定位）
 *   - z.discriminatedUnion 错误信息 1 行（"Input tag 'X' does not match"）
 *   - Pydantic Annotated[Union, Discriminator] 才能从 zod-to-json-schema 的
 *     `oneOf + discriminator` 标注识别出来（见 wire-codegen post-processing）
 */

import { z } from 'zod';
import { LocalFileArtifactPayloadSchema } from './local-file-artifact.js';
import { OssFileArtifactPayloadSchema } from './oss-file-artifact.js';

// ════════════════════════════════════════════════════════════════════
// 公共子结构（v2 §2.2.1 共享类型 + 内部 union）
// ════════════════════════════════════════════════════════════════════

/**
 * Anthropic 协议的 envelope 版本号。Wave 1 引入；Wave 7 之前不变。
 *
 * `min_compatible_version` < `protocol_version` 的事件，老客户端可以
 * 拒收 + 日志告警；新客户端可以走 fallback UI（见 v2 §2.6 协议兼容矩阵）。
 */
export const PROTOCOL_VERSION_V2 = 'v2' as const;

/**
 * Citation block (Anthropic 2024 加；为 text block 提供细粒度引用源)。
 */
export const CitationSchema = z.object({
  type: z.literal('char_location'),
  cited_text: z.string(),
  document_index: z.number().int(),
  document_title: z.string().nullable().optional(),
  /**
   * TabTin 引用展示扩展。
   *
   * iOS 的引用卡片已经消费这些字段；此前它们只被手工补在 Swift vendor
   * 产物中，完整 codegen 会把字段静默删掉。协议扩展必须回到 Wire SSoT，
   * 让 Swift / Kotlin / Python / TypeScript consumer 保持同一份契约。
   */
  source_title: z.string().optional(),
  source_url: z.string().optional(),
  source_name: z.string().optional(),
  source_id: z.string().optional(),
  source_type: z.string().optional(),
  page: z.number().int().optional(),
  start_line: z.number().int().optional(),
  end_line: z.number().int().optional(),
  chunk_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  start_char_index: z.number().int(),
  end_char_index: z.number().int(),
});

export type Citation = z.infer<typeof CitationSchema>;

/**
 * Image source 三 union（base64 / url / file_id）。
 * `source.type` 是内部 discriminator——非顶层 ContentBlock.type。
 */
export const ImageSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string(),
  }),
  z.object({
    type: z.literal('url'),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal('file_id'),
    file_id: z.string(),
  }),
]);

export type ImageSource = z.infer<typeof ImageSourceSchema>;

/**
 * Document source 三 union（base64 PDF / url / file_id）。
 * `media_type` 在 base64 分支固定为 `application/pdf`（Anthropic 协议约束）。
 */
export const DocumentSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('base64'),
    media_type: z.literal('application/pdf'),
    data: z.string(),
  }),
  z.object({
    type: z.literal('url'),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal('file_id'),
    file_id: z.string(),
  }),
]);

export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

/**
 * Tool execution metadata（TabTin 扩展，附加到 tool_result.tabtin_metadata）。
 *
 * 注：是"扩展元数据"而不是 v2 §2.2.4 退役那批 `tabtin_*` 块——这只是
 * tool_result 内嵌的元数据字段，不是独立 ContentBlock。
 */
export const ToolExecutionMetadataSchema = z.object({
  duration_ms: z.number().optional(),
  exit_code: z.number().int().optional(),
  truncated: z.boolean().optional(),
  full_output_url: z.string().optional(),
});

export type ToolExecutionMetadata = z.infer<typeof ToolExecutionMetadataSchema>;

/**
 * Code execution result content（Claude 4 Code Interpreter 系列共用）。
 *
 * v2 §2.2.1 写"`code_execution_tool_result.content` 含 stdout/stderr/return_code/
 * content[]"——`content[]` 用于嵌入输出文件等，本期 typed 成 `unknown[]?` 留
 * 给后续按需收紧（避免现在过度建模）。
 */
export const CodeExecutionResultContentSchema = z.object({
  type: z.literal('code_execution_result'),
  stdout: z.string(),
  stderr: z.string(),
  return_code: z.number().int(),
  content: z.array(z.unknown()).optional(),
});

export type CodeExecutionResultContent = z.infer<typeof CodeExecutionResultContentSchema>;

// ════════════════════════════════════════════════════════════════════
// ToolResult 叶子约束（v2 §2.2.2 关键修订）
// ════════════════════════════════════════════════════════════════════
// `tool_result.content` 只能内嵌"叶子型块"——禁止递归嵌套
// tool_use / thinking / tool_result（避免 BlockRenderer 写出无限深递归）。
// 叶子 union: text / image / search_result / document
// ════════════════════════════════════════════════════════════════════

const ToolResultTextLeafSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ToolResultImageLeafSchema = z.object({
  type: z.literal('image'),
  source: ImageSourceSchema,
});

const ToolResultSearchLeafSchema = z.object({
  type: z.literal('search_result'),
  source: z.string(),
  title: z.string(),
  content: z.array(ToolResultTextLeafSchema),
  citations: z.object({ enabled: z.boolean() }).optional(),
});

const ToolResultDocumentLeafSchema = z.object({
  type: z.literal('document'),
  source: DocumentSourceSchema,
  title: z.string().optional(),
  context: z.string().optional(),
  citations: z.object({ enabled: z.boolean() }).optional(),
});

/**
 * v2 §2.2.2 ToolResultInlineBlock = TextBlock | ImageBlock | SearchResultBlock | DocumentBlock。
 * **不允许嵌套 tool_use / thinking / tool_result**（递归限制）。
 */
export const ToolResultInlineBlockSchema = z.discriminatedUnion('type', [
  ToolResultTextLeafSchema,
  ToolResultImageLeafSchema,
  ToolResultSearchLeafSchema,
  ToolResultDocumentLeafSchema,
]);

export type ToolResultInlineBlock = z.infer<typeof ToolResultInlineBlockSchema>;

// ════════════════════════════════════════════════════════════════════
// ContentBlock 22 case 完整 union（v2 §2.2.1 + §2.2.3）
// ════════════════════════════════════════════════════════════════════

/** text block（user/assistant；含可选 citations 数组） */
const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  citations: z.array(CitationSchema).optional(),
});

/**
 * tool_use block（assistant；LLM 发起的工具调用）。
 *
 * **🚨 红线 · `id` 字段（W0 边界自查 + `harness_对话成熟化_tool跨轮语义.md` M7）**：
 * 必须**沿用上游 LLM 给的原生 id**（Anthropic `toolu_*` / OpenAI `call_*`），
 * **禁止重新生成**。Daemon 端持久化 / 跨轮 tool_result 配对 / 上游模型重发都
 * 依赖该 id 跨边界语义保留。重新生成会导致：
 *   - 上游 LLM 拿到 tool_result 后无法找回对应 tool_use
 *   - 跨轮 ensureToolResultPairing 失败（runtime核心执行 W2）
 *   - 客户端 BlockTimeline tool_use ↔ tool_result 配对错位
 *
 * `input_parse_error?` 用于流式 finalize 时 `partial_json` parse 失败的 fallback。
 */
const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
  input_parse_error: z
    .object({
      message: z.string(),
      partial: z.string(),
    })
    .optional(),
});

/**
 * tool_result block（user；工具执行结果）。
 *
 * `tool_use_id` 配对 tool_use.id（同样**必须沿用上游 LLM 原生 id**）。
 * `content` 是 string 简写或 ToolResultInlineBlockSchema 数组（叶子约束）。
 */
const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(ToolResultInlineBlockSchema)]),
  is_error: z.boolean().optional(),
  tabtin_metadata: ToolExecutionMetadataSchema.optional(),
  presentation: z.object({
    kind: z.string(),
    data: z.record(z.unknown()).optional(),
  }).optional(),
});

/** thinking block（assistant；扩展思考 + 签名） */
const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string(),
});

/** redacted_thinking block（assistant；display=omitted 时返回的 base64 加密 data） */
const RedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});

/** image block（user / assistant 罕见；多模态图片） */
const ImageBlockSchema = z.object({
  type: z.literal('image'),
  source: ImageSourceSchema,
});

/** document block（user；PDF / 文档输入） */
const DocumentBlockSchema = z.object({
  type: z.literal('document'),
  source: DocumentSourceSchema,
  title: z.string().optional(),
  context: z.string().optional(),
  citations: z.object({ enabled: z.boolean() }).optional(),
});

/**
 * server_tool_use block（assistant；Anthropic server 端工具，如 web_search）。
 * `id` 同 tool_use 的红线——沿用上游 id。
 */
const ServerToolUseBlockSchema = z.object({
  type: z.literal('server_tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

/** web_search_tool_result block（assistant；server tool 嵌入结果） */
const WebSearchResultItemSchema = z.object({
  type: z.literal('web_search_result'),
  url: z.string().url(),
  title: z.string(),
  encrypted_content: z.string().optional(),
  page_age: z.string().optional(),
});

const WebSearchToolResultBlockSchema = z.object({
  type: z.literal('web_search_tool_result'),
  tool_use_id: z.string(),
  content: z.array(WebSearchResultItemSchema),
});

/** code_execution_tool_result block（Claude 4 Code Interpreter） */
const CodeExecutionToolResultBlockSchema = z.object({
  type: z.literal('code_execution_tool_result'),
  tool_use_id: z.string(),
  content: CodeExecutionResultContentSchema,
});

/** bash_code_execution_tool_result block（Claude 4 Bash 工具） */
const BashCodeExecutionToolResultBlockSchema = z.object({
  type: z.literal('bash_code_execution_tool_result'),
  tool_use_id: z.string(),
  content: CodeExecutionResultContentSchema,
});

/** text_editor_code_execution_tool_result block（Claude 4 文件编辑工具） */
const TextEditorCodeExecutionToolResultBlockSchema = z.object({
  type: z.literal('text_editor_code_execution_tool_result'),
  tool_use_id: z.string(),
  content: CodeExecutionResultContentSchema,
});

/**
 * mcp_tool_use block（assistant；MCP connector 调用）。
 * `id` 沿用 MCP server 给的 id（同 tool_use 红线）。
 */
const McpToolUseBlockSchema = z.object({
  type: z.literal('mcp_tool_use'),
  id: z.string(),
  name: z.string(),
  server_name: z.string(),
  input: z.record(z.unknown()),
});

/** mcp_tool_result block（user；MCP connector 结果） */
const McpToolResultBlockSchema = z.object({
  type: z.literal('mcp_tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(ToolResultInlineBlockSchema)]),
});

/** container_upload block（assistant；容器上传文件返回） */
const ContainerUploadBlockSchema = z.object({
  type: z.literal('container_upload'),
  file_id: z.string(),
  container_id: z.string(),
});

/** search_result block (input 端；retrieval-augmented input) */
const SearchResultBlockSchema = z.object({
  type: z.literal('search_result'),
  source: z.string(),
  title: z.string(),
  content: z.array(ToolResultTextLeafSchema),
  citations: z.object({ enabled: z.boolean() }).optional(),
});

// ─── TabTin 受控扩展（v2 §2.2.3）─────────────────────────────────────
//
// `tabtin_*` 前缀策略（v2 修订理由）：让人类阅读 jsonl / DB 时一眼识别自家
// 方言。也方便 PG `messages_json` strip 操作（一行 `block.type.startsWith
// ('tabtin_')` 全部剥离）。

/**
 * tabtin_rich_content block（kind 二级 dispatcher）。
 *
 * 保留 v2 §2.2.3 全部现有 kind：image / table_preview / resource_ref / file /
 * widget / cli_output_table / cli_output_record / search_results / memory_card /
 * document_excerpt / task_episode（11 种）。新增 kind 时同步本 enum + 客户端 ToolUseBlockView
 * 二级 dispatcher。
 */
const TabTinRichContentBlockSchema = z.object({
  type: z.literal('tabtin_rich_content'),
  kind: z.enum([
    'image',
    'table_preview',
    'resource_ref',
    'file',
    'widget',
    'cli_output_table',
    'cli_output_record',
    'search_results',
    'memory_card',
    'document_excerpt',
    'task_episode',
    // ：plan 提案卡片作为持久化 block（payload 只存 plan_ref + 轻量展示字段，
    // 不存正文 markdown），随消息落 content_blocks_json，重启后可从历史恢复。
    'plan',
  ]),
  summary: z.string(),
  group_id: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

const LocalFileArtifactRichContentBlockSchema = TabTinRichContentBlockSchema.extend({
  kind: z.literal('file'),
  payload: LocalFileArtifactPayloadSchema,
});

const OssFileArtifactRichContentBlockSchema = TabTinRichContentBlockSchema.extend({
  kind: z.literal('file'),
  payload: OssFileArtifactPayloadSchema,
});

const TabTinComposerPresetBlockSchema = z.object({
  type: z.literal('tabtin_composer_preset'),
  preset_id: z.string(),
  params: z.record(z.unknown()),
  source: z.enum(['preset', 'ask_user']).optional(),
});

const TabTinAskUserFieldsBlockSchema = z.object({
  type: z.literal('tabtin_ask_user_fields'),
  field_values: z.record(z.unknown()),
});

/**
 * tabtin_skill_invocation block（v2 新增）。
 * 替代"删除 SkillInjectionInlineCard"——skill 注入仍作为独立块类型存在，
 * UI 渲染成专属卡片，原始注入文本可展开查看，避免用户看到"我没写过这段话"
 * 的困惑。
 */
const TabTinSkillInvocationBlockSchema = z.object({
  type: z.literal('tabtin_skill_invocation'),
  skill_id: z.string(),
  skill_name: z.string(),
  injected_text: z.string(),
  injected_text_summary: z.string(),
});

/**
 * tabtin_approval_request block（v2 §3.5.1.h 提到："BlockTimeline 末尾插一个
 * 虚拟占位 block"承接审批等待 UI）。
 *
 * 注：本块**不替代** `agent.stream.approval_requested` 事件（详见 `approval.ts`），
 * 而是作为 chat timeline 的占位渲染入口；事件层 + 块层双轨制（事件给 IPC /
 * 后端落库 / 协调器，块给客户端 BlockTimeline 渲染）。
 */
const TabTinApprovalRequestBlockSchema = z.object({
  type: z.literal('tabtin_approval_request'),
  approval_id: z.string(),
  prompt: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  expires_at: z.string().optional(),
});

/**
 * TabTin source ref snapshot——5 种 ref_kind 嵌套 union（双 discriminator）。
 *
 * `kind` 是 snapshot 内部的 discriminator（与顶层 `ref_kind` 语义一致）。
 * 双层 discriminator 是 v2 §2.2.3 的设计——确保任何工具/客户端在 `ref_kind`
 * 还没读到时也能从 snapshot 自身字段反查（防御反查避免）。
 */
const TabTinSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('web'),
    url: z.string().url(),
    title: z.string().optional(),
    preview: z.string().optional(),
    selected_text: z.string().optional(),
  }),
  z.object({
    kind: z.literal('doc'),
    doc_id: z.string(),
    page: z.number().int().optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    preview: z.string().optional(),
  }),
  z.object({
    kind: z.literal('table'),
    table_id: z.string(),
    row_ids: z.array(z.string()).optional(),
    field_ids: z.array(z.string()).optional(),
    csv_preview: z.string().optional(),
  }),
  z.object({
    kind: z.literal('code'),
    file_path: z.string(),
    start_line: z.number().int(),
    end_line: z.number().int(),
    code_excerpt: z.string(),
    lang: z.string().optional(),
  }),
  z.object({
    kind: z.literal('memo'),
    memo_id: z.string(),
    preview: z.string().optional(),
  }),
]);

export type TabTinSnapshot = z.infer<typeof TabTinSnapshotSchema>;

/**
 * tabtin_source_ref block（v2 §2.2.3 修订）。
 *
 * 双 discriminator：
 *   - 顶层 `type='tabtin_source_ref'` 是 ContentBlock union 的 discriminator
 *   - 块内 `ref_kind` 是二级 discriminator（值跟 snapshot.kind 语义一致）
 *
 * `snapshot` 是自包含快照（不依赖反查）——客户端拿到块就能完整渲染。
 */
const TabTinSourceRefBlockSchema = z.object({
  type: z.literal('tabtin_source_ref'),
  source_id: z.string(),
  ref_kind: z.enum(['web', 'doc', 'table', 'code', 'memo']),
  snapshot: TabTinSnapshotSchema,
});

// ─── 顶层 ContentBlock 完整 union（22 case = 16 标准 + 6 tabtin_*）─────

/**
 * 完整 ContentBlock discriminated union。
 *
 * **22 case** 完整清单（v2 §2.2.1 + §2.2.3）：
 *
 * | # | type | 类别 | 来源 |
 * |---|---|---|---|
 * | 1 | text | 标准 | Anthropic 基础 |
 * | 2 | tool_use | 标准 | Anthropic 基础 |
 * | 3 | tool_result | 标准 | Anthropic 基础 |
 * | 4 | thinking | 标准 | Anthropic 扩展思考 |
 * | 5 | redacted_thinking | 标准 | display=omitted 时 |
 * | 6 | image | 标准 | 多模态 |
 * | 7 | document | 标准 | PDF 输入 |
 * | 8 | server_tool_use | 标准 | server 端工具 |
 * | 9 | web_search_tool_result | 标准 | server tool 结果 |
 * | 10 | code_execution_tool_result | 标准 | Claude 4 新加 |
 * | 11 | bash_code_execution_tool_result | 标准 | Claude 4 新加 |
 * | 12 | text_editor_code_execution_tool_result | 标准 | Claude 4 新加 |
 * | 13 | mcp_tool_use | 标准 | MCP 协议 |
 * | 14 | mcp_tool_result | 标准 | MCP 协议 |
 * | 15 | container_upload | 标准 | 容器上传 |
 * | 16 | search_result | 标准 | input 端 retrieval |
 * | 17 | tabtin_rich_content | TabTin | 富内容（10 种 kind） |
 * | 18 | tabtin_composer_preset | TabTin | composer 模板 |
 * | 19 | tabtin_ask_user_fields | TabTin | ask_user 回填 |
 * | 20 | tabtin_skill_invocation | TabTin | skill 注入 |
 * | 21 | tabtin_source_ref | TabTin | 引用源 |
 * | 22 | tabtin_approval_request | TabTin | 审批占位 |
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ImageBlockSchema,
  DocumentBlockSchema,
  ServerToolUseBlockSchema,
  WebSearchToolResultBlockSchema,
  CodeExecutionToolResultBlockSchema,
  BashCodeExecutionToolResultBlockSchema,
  TextEditorCodeExecutionToolResultBlockSchema,
  McpToolUseBlockSchema,
  McpToolResultBlockSchema,
  ContainerUploadBlockSchema,
  SearchResultBlockSchema,
  TabTinRichContentBlockSchema,
  TabTinComposerPresetBlockSchema,
  TabTinAskUserFieldsBlockSchema,
  TabTinSkillInvocationBlockSchema,
  TabTinSourceRefBlockSchema,
  TabTinApprovalRequestBlockSchema,
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// 单 case 类型导出（vendor in 的客户端常按单类型 import）
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ServerToolUseBlock = z.infer<typeof ServerToolUseBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;
export type TabTinSourceRefBlock = z.infer<typeof TabTinSourceRefBlockSchema>;
export type TabTinSkillInvocationBlock = z.infer<typeof TabTinSkillInvocationBlockSchema>;
export type TabTinApprovalRequestBlock = z.infer<typeof TabTinApprovalRequestBlockSchema>;
export type TabTinRichContentBlock = z.infer<typeof TabTinRichContentBlockSchema>;
export type LocalFileArtifactRichContentBlock = z.infer<typeof LocalFileArtifactRichContentBlockSchema>;
export type OssFileArtifactRichContentBlock = z.infer<typeof OssFileArtifactRichContentBlockSchema>;

// 单 schema 导出（codegen + 测试需要按 schema 跑 fixture）
export {
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ImageBlockSchema,
  DocumentBlockSchema,
  ServerToolUseBlockSchema,
  WebSearchToolResultBlockSchema,
  CodeExecutionToolResultBlockSchema,
  BashCodeExecutionToolResultBlockSchema,
  TextEditorCodeExecutionToolResultBlockSchema,
  McpToolUseBlockSchema,
  McpToolResultBlockSchema,
  ContainerUploadBlockSchema,
  SearchResultBlockSchema,
  TabTinRichContentBlockSchema,
  LocalFileArtifactRichContentBlockSchema,
  OssFileArtifactRichContentBlockSchema,
  TabTinComposerPresetBlockSchema,
  TabTinAskUserFieldsBlockSchema,
  TabTinSkillInvocationBlockSchema,
  TabTinSourceRefBlockSchema,
  TabTinApprovalRequestBlockSchema,
};

// W4c-L5 · W4.5 第二波 B1：MessageStop.error_info 配套 schema
// (PartialReasonSchema / ErrorInfoSchema) 已在上面 `export const` 直接导出，
// codegen pipeline (01_emit_json_schema.ts) 直接 import 即可命中。

// ════════════════════════════════════════════════════════════════════
// envelope 公共字段（v2 §2.3.4 envelope 必带字段）
// ════════════════════════════════════════════════════════════════════

/**
 * 任何 `agent.stream.*` 事件 envelope 都必须带的字段集合。
 *
 * - `protocol_version`：版本号字面量；消费端不识别 → 拒收 + 日志告警
 * - `min_compatible_version`：消费端 < 这个版本应当走 fallback UI
 * - `trace_id`：从 LLM SSE 一直到客户端渲染串链路（v2 强制非空）
 * - `_seq`：backend Redis INCR 的单调递增；客户端按 `_seq` 排序后 dispatch
 * - `thread_id`：会话级路由键（与 agent.stream.{thread_id} topic 一致）
 *
 * 命名 `_seq` 而非 `seq` 是历史决策——下划线开头传达"内部协调字段，业务
 * 层不要直接使用"。codegen 时 Pydantic 用 `Field(alias='_seq')` 处理（W0
 * PoC 实测踩坑 K2，已在 wire-codegen post-processing 兜底）。
 */
export const StreamEnvelopeBaseSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION_V2),
  min_compatible_version: z.literal(PROTOCOL_VERSION_V2),
  trace_id: z.string().min(1),
  _seq: z.number().int().nonnegative(),
  thread_id: z.string().min(1),
  // 块级时间线「抵达序号」(daemon 唯一分配,)。微秒尺度、thread/全局单调,
  // 是对话顺序的权威排序键;`created_at`(入库时刻)仅作缺失兜底。与 `_seq`(query 内
  // 重组/去重)职责不同。optional:新 daemon 总发,老数据 / 老客户端缺失时消费端
  // 回落 created_at。详见 packages/agent-runtime/src/engine/arrival-seq.ts。
  arrival_seq: z.number().int().nonnegative().optional(),
  // 事件唯一身份：跨源（IPC + WS）去重键。runtime 出口 `ensureEventId` 分配、
  // 一次发射一次、包装/转发/回声只搬运不重造。与 arrival_seq（排序）职责分离。optional：
  // 老 daemon / host 合成事件缺失时消费端回落 arrival_seq。
  event_id: z.string().optional(),
  // 子 Agent 身份：贴在**每个**子 Agent 流式事件上（不只 message_start），让前端任一
  // content_block/message 事件都能自识别归属，把内容路由进对应卡片而非主时间线。
  // optional：主 Agent 事件不带；老 daemon / 老数据缺失时消费端回落 message_start 反查。
  subagent_run_id: z.string().optional(),
});

export type StreamEnvelopeBase = z.infer<typeof StreamEnvelopeBaseSchema>;

// ════════════════════════════════════════════════════════════════════
// 6 件套事件 schema（message_* + content_block_*）
// ════════════════════════════════════════════════════════════════════

// ─── message_start ────────────────────────────────────────────────────

/**
 * `message_kind` —— ChatMessage 在产品语义上的分类。
 *
 * 替换原来用 `model_id === 'tabtin-tool-runtime'` 字面量 + `synthetic === true`
 *
 * **范畴说明**：本枚举**只描述消息级语义**（这条 message 在产品里是什么角色），
 * 不描述块级语义（块的 type / kind 由 `tabtin_rich_content.kind` 进一步细分
 * 10 类），也不描述"reassembler 路由决策"（譬如"是否独立落库"是 reassembler
 * 根据 role + block 内容复合判别，不进协议字段）。
 *
 * **为什么不加 `'tool_result_merge'` 第 4 类**（PRD v1.0 → v1.1 修订共识）：
 * `role='user' + 含 tool_result blocks` 这种"daemon 主循环 push 合成的 tool
 * result 包装"已能由 reassembler 用 `role + has_tool_result_blocks(blocks)`
 * 复合判别走合并路径，**无需独立协议字段**——把"reassembler 路由决策"塞进
 * "消息分类协议"是范畴错误。三档分类保持 closed enum + open 演化空间。
 *
 * 三档语义：
 *
 * - **`llm`** —— 主 LLM 真实输出（最常见）：含 thinking / text / tool_use /
 *   tool_result 等 block。也含 daemon 主循环 push 的 user 端 tool_result
 *   合成消息（reassembler 用 `role='user' + has_tool_result_blocks` 复合判别
 *   "是否走合并路径"，**不在协议字段里区分**）。
 *
 * - **`tool_artifact`** —— 工具产物气泡：daemon `emitDetachedMiniMessage`
 *   路径，承载 `tabtin_rich_content` 块（10 种 kind: widget /
 *   search_results / cli_output_* / present_to_user 子卡 / memory_card /
 *   document_excerpt / task_episode 等）。前端走"产物气泡"紧凑形态。
 *
 * - **`error_envelope`** —— 自合成错误文案气泡：daemon 自合成的错误提示
 *   （上下文超限 / capability gate 等），承载 text block。视觉上算 assistant
 *   气泡但跳过 thinking placeholder + 跳过 MessageCostLabel（无 LLM token usage）。
 *
 * - **`environment_context`**—— 每轮注入的 `<context type="environment">`
 *   环境快照，作为独立 immutable 历史块落库（role=user），让对话历史前缀跨轮
 *   byte-stable、稳定 prompt cache。**对用户 UI 隐藏**（前端 MessageBubble 过滤），
 *   但仍喂给 LLM 作历史。这是消息级语义（"这条 message 是环境快照"），不是路由
 *   决策，故合理进枚举。
 *
 * - **`agent_profile_context`**—— 内容变化时注入的
 *   `<context type="agent-profile">`（含 personal_rules / custom_rules 等），
 *   作为独立 user 消息落库；**UI 隐藏**；发给 LLM 时历史多份只保留最新一份。
 *
 * - **`system_prompt_context`** —— 每轮实际生效的 system prompt 快照，
 *   作为独立 user 消息落库；**UI 隐藏**；#8550 起不进 LLM 历史（仅审计 /
 *   导出回退；本轮规则走 `llmRequest.system`）。
 */
export const MessageKindSchema = z.enum([
  'llm',
  'tool_artifact',
  'error_envelope',
  'environment_context',
  'agent_profile_context',
  'system_prompt_context',
]);

export type MessageKind = z.infer<typeof MessageKindSchema>;

/**
 * role × message_kind 合法组合矩阵（9 组合里 3 个非法）。
 *
 * 非法组合说明：
 *   - `tool_artifact × system`：产物气泡不属于"系统"角色（system 是主 LLM 提示词，
 *     不可能由工具产出）
 *   - `error_envelope × user`：错误文案不能由"用户"角色发出（用户不会自合成错误）
 *   - `error_envelope × system`：错误属 assistant 一侧的展示，不应混入 system role
 *
 * 单源定义，供 `MessageStartSchema.superRefine` 与
 * `AnyContentBlockStreamEventSchema.superRefine` 两条解析路径共享，避免分叉。
 */
const MESSAGE_KIND_ALLOWED_ROLES: Record<
  MessageKind,
  ReadonlyArray<'assistant' | 'user' | 'system'>
> = {
  llm: ['assistant', 'user', 'system'],
  tool_artifact: ['assistant', 'user'],
  error_envelope: ['assistant'],
  // ：环境快照只能由 user 角色承载（它注入在 user turn 之前，role=user）。
  environment_context: ['user'],
  // ：agent-profile 注入同构，role=user。
  agent_profile_context: ['user'],
  // system prompt 快照同构为隐藏 user context，不进入真实用户消息语义。
  system_prompt_context: ['user'],
};

/** `MessageStartSchema` / `AnyContentBlockStreamEventSchema` 共享的 superRefine 实现。 */
function refineMessageKindRole(
  data: {
    message_kind: MessageKind;
    role: 'assistant' | 'user' | 'system';
  },
  ctx: z.RefinementCtx,
): void {
  if (!MESSAGE_KIND_ALLOWED_ROLES[data.message_kind].includes(data.role)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message_kind'],
      message:
        `illegal role=${data.role} for message_kind=${data.message_kind}; `
        + `allowed roles: [${MESSAGE_KIND_ALLOWED_ROLES[data.message_kind].join(', ')}]`,
    });
  }
}

/**
 * `MessageStartSchema` 的纯 `ZodObject` 形态——给 `z.discriminatedUnion`
 * （要求 union 成员必须是 `ZodObject`，不接受 `ZodEffects` 包装）使用。
 *
 * 业务代码不应直接用本 schema——请用下方带 `superRefine` 的
 * {@link MessageStartSchema}，得到 role × message_kind 正交性校验。
 * `AnyContentBlockStreamEventSchema` 在 union 外层补一次 superRefine
 * 兜底，所以走 union 解析路径也不会绕过校验。
 */
const MessageStartObjectSchema = StreamEnvelopeBaseSchema.extend({
  event_type: z.literal('agent.stream.message_start'),
  message_id: z.string().min(1),
  /**
   * 本条消息的实际执行 Agent。它是消息级历史事实，不等同于会话里“下一轮默认
   * Agent”的可变指针；跨端渲染头像/名称必须优先读取这里。
   */
  agent_id: z.string().min(1).optional(),
  role: z.enum(['assistant', 'user', 'system']),
  model_id: z.string(),
  model_name: z.string(),
  started_at: z.string(),
  run_id: z.string().min(1),
  subagent_run_id: z.string().optional(),
  message_kind: MessageKindSchema,
});

/**
 * `agent.stream.message_start` payload。LLM API 调用开始时 emit。
 *
 * `message_id` 是本轮 LLM 输出的稳定 ID（贯穿后续 content_block_* 事件）。
 * `subagent_run_id` 仅在子 Agent 输出时有；主 Agent 时省略（subagent
 * 治理见 PRD 06）。
 *
 * `message_kind` 是消息级语义分类（**必填**）——daemon emit 时必须显式标，
 * 字段缺失立即 zod parse fail。详见 {@link MessageKindSchema}。
 *
 * `superRefine` 校验 role × message_kind 9 个组合里的 3 个非法组合（详见
 * {@link MESSAGE_KIND_ALLOWED_ROLES}），让协议层"消息种类与角色不匹配"立即
 * 可见。同一份校验逻辑由 {@link AnyContentBlockStreamEventSchema} 在 union
 * 外层补一次 superRefine 兜底——保证两条解析路径都不会绕过校验。
 */
export const MessageStartSchema = MessageStartObjectSchema.superRefine(
  refineMessageKindRole,
);

export type MessageStart = z.infer<typeof MessageStartSchema>;

// ─── message_delta ────────────────────────────────────────────────────

/**
 * usage 字段（**cumulative** 而非增量；v2 §2.3.1）。
 *
 * Anthropic SDK 文档：`message_delta.usage` 是 cumulative 至该 delta 时刻
 * 的 input_tokens + output_tokens 总数；**消费方不要做累加**——直接用
 * 最新一次的 usage 即可。
 */
export const MessageUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/**
 * stop_reason 字面量集合（与 Anthropic API 对齐 + TabTin 扩展）。
 *
 * - end_turn / max_tokens / tool_use / stop_sequence — Anthropic 标准
 * - aborted — 上游 abort / 客户端中断 / lifecycle terminated
 * - pause_turn — Anthropic 4.7+ pause（thinking 长时间未结束）
 * - refusal — 安全策略拒绝
 *
 * schema 不强约束 enum——保持开放给上游协议演进；消费方按已知值分支展示
 * 文案，未知值落 default。
 */
export const MessageStopReasonSchema = z.string();

export type MessageStopReason = z.infer<typeof MessageStopReasonSchema>;

export const MessageDeltaSchema = StreamEnvelopeBaseSchema.extend({
  event_type: z.literal('agent.stream.message_delta'),
  message_id: z.string().min(1),
  delta: z.object({
    stop_reason: MessageStopReasonSchema.optional(),
    stop_sequence: z.string().nullable().optional(),
  }),
  usage: MessageUsageSchema.optional(),
});

export type MessageDelta = z.infer<typeof MessageDeltaSchema>;

// ─── ErrorInfo (W4c-L5 · W4.5 第二波 B1) ──────────────────────────────

/**
 * `partial_reason` 三档字面量（W4c-L5 · W4.5 第二波 B1）。
 *
 * **粒度与扩散语义**：本字段是 **message 级**——一条 `MessageStop` 一个值；
 * Renderer 端 `ContentBlockEntry.partialReason`（见
 * `apps/tabtin-electron/src/renderer/src/stores/useChatRuntimeStore.ts` 中
 * `ContentBlockEntry.partialReason` 字段定义）是 **block 级**，客户端
 * `messageStop({ partialReason })` 把这一个 message 级值扩散到该 message
 * 内**所有未 finalize 的 block**。三档字面量严格对齐——daemon 不为不同
 * block 写不同 reason，client 按需自己做"一对多扩散"。
 *
 * 三档语义：
 *
 * - **`'aborted'`** — 用户主动 abort（客户端发 abort signal）或 daemon emit
 *   `message_delta(stop_reason='aborted')` / lifecycle terminated；UI 文案
 *   "已中断"。
 * - **`'stream_interrupted'`** — 流式异常中断：watchdog timeout / network
 *   error / daemon crash / lifecycle error；UI 文案"等待响应超时 / 流被
 *   截断"。
 * - **`'message_stop_fallback'`** — `agent.stream.message_stop` 到达时仍有
 *   未 finalize 的 block，daemon 兜底强制 finalize 标 `partial=true`（v2
 *   §3.5.1.b 边角 case 3）；UI 文案"内容被截断"。
 *
 * **三档的判别原则**：
 *  - aborted 是"主动"路径（有明确意图）
 *  - stream_interrupted 是"被动异常"路径（流挂掉）
 *  - message_stop_fallback 是"协议层兜底"路径（message_stop 信号收到了但
 *    内容没收齐——典型于 daemon 端 stream 提前关闭 + emit messageStop 兜底）
 *
 * **协议层持久化必要性**（W4c-L5 修复理由）：W3 之前 Django 端
 * `error_info_json` 不带 partial_reason，历史回放路径只能从 stop_reason +
 * lifecycle phase 启发式反推——`message_stop_fallback` 与 `stream_interrupted`
 * 容易混淆。Wave 4.5 加入 wire schema 后，daemon emit 时显式标注 →
 * Django 持久化 → Renderer 历史回放 / 直播路径文案统一。
 *
 * **4 端 codegen 形态注意**（W4.5 三视角 review P1）：
 *   - Python: `class PartialReason(Enum)`，强枚举校验
 *   - TypeScript: 字面量 union，编译期强约束
 *   - Swift / Kotlin: `typealias String`（codegen lib 历史选择，同
 *     `Category` / `MediaType` 等其他 named string enum 统一处理）；mobile
 *     消费侧需自行 switch + default 兜底，不依赖编译期穷尽——若 daemon 端
 *     拼写错误，Renderer / Django 会让整条 MessageStop schema parse fail
 *     （已在 `error-info-schema.test.ts` 锁定），mobile 端字面量原样透传
 *     由消费侧 switch default 兜底。
 */
export const PartialReasonSchema = z.enum([
  'aborted',
  'stream_interrupted',
  'message_stop_fallback',
]);

export type PartialReason = z.infer<typeof PartialReasonSchema>;

/**
 * `ErrorInfo` 结构化错误信息（与 Django `ChatMessage.error_info_json` 字段
 * 一对一对齐）。
 *
 * 字段语义：
 * - `error_class?` — 与 `StreamDoneSchema.error_class` 相同的开放字符串
 *   分类（LLM_ERROR / ABORT / CONTEXT_OVERFLOW / ...，详见 stream.ts 顶部
 *   AgentErrorCode 注释）。**不**强约束 enum，给 runtime 增枚举值留前向兼容。
 * - `error_message?` — 用户可见的错误文案（中文优先，回落英文）。
 * - `suggested_action?` — 机器枚举或人类文案的下一步建议（none /
 *   shorten_context / retry / 等）。
 * - `category?` — 高层类别，用于历史回看 / 报表分组：
 *   `aborted` / `timeout` / `protocol_error` / `runtime_failed` / `budget_exceeded`。
 * - `partial_reason?` — W4c-L5 新增；详见 {@link PartialReasonSchema}。
 *
 * **`category` vs `partial_reason` 是两个独立维度**：
 *   - `category` 是落库后端 / 历史回看 / 报表分组用的"高层错误类别"
 *   - `partial_reason` 是 Renderer 文案分支用的"为何 partial 的具体路径"
 *   - 两者**可不一致**——譬如 `{ category: 'protocol_error',
 *     partial_reason: 'message_stop_fallback' }` 是合法组合（协议错误
 *     类别 + 协议兜底路径），schema 不强制对齐；新加 daemon emit 路径时
 *     按各自语义独立填值即可。
 *
 * 所有字段都 optional——本对象本身在 envelope 上可选，且即使存在
 * 也允许字段缺省（向前兼容）。
 */
export const ErrorInfoSchema = z.object({
  error_class: z.string().optional(),
  error_message: z.string().optional(),
  suggested_action: z.string().optional(),
  category: z
    .enum(['aborted', 'timeout', 'protocol_error', 'runtime_failed', 'budget_exceeded'])
    .optional(),
  error_extras: z.record(z.unknown()).optional(),
  partial_reason: PartialReasonSchema.optional(),
});

export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

// ─── message_stop ─────────────────────────────────────────────────────

/**
 * `agent.stream.message_stop` payload（LLM 整轮结束 + 已落库 server id）。
 *
 * - `persisted_id?` — 后端落库后回灌的 ChatMessage.id；客户端可用此对账
 *   本地 stream 期间生成的 message_id ↔ DB 主键
 * - `block_id_overrides?` — 后端落库时如发现 block_id 冲突或需重命名，
 *   通过此字段批量通知客户端 reconcile React key（v2 §2.5）
 * - `error_info?` — W4c-L5 新增（W4.5 第二波 B1）。结构化错误信息，
 *   含 `partial_reason` 三档区分"为何被打成 partial"（message 级，client
 *   端做"一对多扩散"到该 message 内所有未 finalize 的 block）。daemon 在
 *   messageStop 兜底强制 finalize 时携带 `partial_reason='message_stop_fallback'`，
 *   让 Django 端落库可持久化 + Renderer 端历史回放与直播路径文案统一
 *   （详见 {@link ErrorInfoSchema} / {@link PartialReasonSchema}）。
 */
export const MessageStopSchema = StreamEnvelopeBaseSchema.extend({
  event_type: z.literal('agent.stream.message_stop'),
  message_id: z.string().min(1),
  persisted_id: z.string().optional(),
  block_id_overrides: z.record(z.string()).optional(),
  error_info: ErrorInfoSchema.optional(),
});

export type MessageStop = z.infer<typeof MessageStopSchema>;

// ─── content_block_start ──────────────────────────────────────────────

/**
 * `agent.stream.content_block_start` payload（单条 ContentBlock 开始）。
 *
 * `block` 是空壳——只有 type + 必填字段的初始值（如 text 块的 text 字段
 * 是空 string，input_json 块的 input 是空 object）。后续靠 content_block_delta
 * 累加。
 *
 * `block_id` 由 Daemon 生成（v2 §2.5 决策）——理由：客户端流式期间就有
 * 稳定 ID 作为 React key；客户端 abort 持久化时本地有 block_id 可对账。
 */
export const ContentBlockStartSchema = StreamEnvelopeBaseSchema.extend({
  event_type: z.literal('agent.stream.content_block_start'),
  message_id: z.string().min(1),
  index: z.number().int().nonnegative(),
  block_id: z.string().min(1),
  block: ContentBlockSchema,
});

export type ContentBlockStart = z.infer<typeof ContentBlockStartSchema>;

// ─── content_block_delta ──────────────────────────────────────────────

/**
 * delta 6 种 type discriminated union（v2 §2.3.1 完整 delta 表）。
 *
 * - `text_delta` — text 块的文本增量
 * - `input_json_delta` — tool_use 块的 input 增量（partial JSON 字符串）
 * - `thinking_delta` — thinking 块的文本增量
 * - `signature_delta` — thinking 块的 signature 增量
 * - `citations_delta` — 单条 citation 增量（Anthropic 2024 加）
 * - `connector_text_delta` — connector 文本增量路径（v2 新增）
 *
 * **不要混进** "text + input + thinking" 等其他 stream-level 概念——这些
 * 是 ContentBlock 的字段层增量，不是块级事件。
 */
export const ContentBlockDeltaPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text_delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('input_json_delta'),
    partial_json: z.string(),
  }),
  z.object({
    type: z.literal('thinking_delta'),
    thinking: z.string(),
  }),
  z.object({
    type: z.literal('signature_delta'),
    signature: z.string(),
  }),
  z.object({
    type: z.literal('citations_delta'),
    citation: CitationSchema,
  }),
  z.object({
    type: z.literal('connector_text_delta'),
    connector_text: z.string(),
  }),
]);

export type ContentBlockDeltaPayload = z.infer<typeof ContentBlockDeltaPayloadSchema>;

export const ContentBlockDeltaSchema = StreamEnvelopeBaseSchema.extend({
  event_type: z.literal('agent.stream.content_block_delta'),
  message_id: z.string().min(1),
  index: z.number().int().nonnegative(),
  delta: ContentBlockDeltaPayloadSchema,
});

export type ContentBlockDelta = z.infer<typeof ContentBlockDeltaSchema>;

// ─── content_block_stop ───────────────────────────────────────────────

/**
 * `agent.stream.content_block_stop` payload（单条 ContentBlock 结束）。
 *
 * **Anthropic 协议硬约束**：同 message 内的 content_block_* 事件**严格串行**
 * （见 v2 §2.3.3）。`stop(N)` 之后才能 `start(N+1)`。`proxy-provider` 必须
 * 把 OpenAI 等并行 streaming 重排成串行后才能 yield 下游。
 */
export const ContentBlockStopSchema = StreamEnvelopeBaseSchema.extend({
  event_type: z.literal('agent.stream.content_block_stop'),
  message_id: z.string().min(1),
  index: z.number().int().nonnegative(),
});

export type ContentBlockStop = z.infer<typeof ContentBlockStopSchema>;

// ─── 顶层事件 union（消费方分发用）───────────────────────────────────

/**
 * 6 件套事件完整 discriminated union（按 event_type 分发）。
 *
 * 用法（消费方）：
 *
 * ```ts
 * const parsed = AnyContentBlockStreamEventSchema.parse(rawJson);
 * switch (parsed.event_type) {
 *   case 'agent.stream.message_start':       handleMessageStart(parsed); break;
 *   case 'agent.stream.content_block_delta': handleContentBlockDelta(parsed); break;
 *   // ... 其余 4 case ...
 * }
 * ```
 *
 * TS 编译器从 event_type 字面量自动收窄到对应的 schema 类型（不需要手写
 * type narrowing）。
 */
export const AnyContentBlockStreamEventSchema = z
  .discriminatedUnion('event_type', [
    // 用 MessageStart 的纯 ZodObject 形态（z.discriminatedUnion 不接受 ZodEffects
    // 包装的 schema）；下方 superRefine 在 union 外层补上 role × message_kind
    // 正交性校验，确保走 union 解析路径与走 MessageStartSchema 单独 parse 路径
    // 都得到相同的协议契约保证。
    MessageStartObjectSchema,
    MessageDeltaSchema,
    MessageStopSchema,
    ContentBlockStartSchema,
    ContentBlockDeltaSchema,
    ContentBlockStopSchema,
  ])
  .superRefine((data, ctx) => {
    if (data.event_type === 'agent.stream.message_start') {
      refineMessageKindRole(data, ctx);
    }
  });

export type AnyContentBlockStreamEvent = z.infer<typeof AnyContentBlockStreamEventSchema>;

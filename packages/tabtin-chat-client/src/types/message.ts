import type { CheckpointRecordView } from './session'

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

/**
 * 意图类型
 * 注意：实际 API 返回的 intent 值可能包括但不限于：
 * - query_table: 查询表格
 * - analyze_data: 数据分析
 * - chitchat: 闲聊
 * - query_projects: 查询项目
 * - query_tables: 查询表格列表
 * - query_records: 查询记录
 *
 * 为了兼容性，使用 string 类型而不是严格枚举
 */
export type IntentType = string

/**
 * 任务模式
 */

/**
 * v2 消息块类型
 */
export type MessageBlockType =
  | 'text'
  | 'image'
  | 'video'
  | 'file'
  /** ：runtime DocumentBlock（LLM 多模态）；UI 卡片映射为 file */
  | 'document'
  | 'doc_selection'
  | 'table_selection'
  | 'code_file'
  | 'code_selection'
  | 'web_selection'
  | 'web_annotation'
  | 'tool_call'
  | 'tool_result'
  | 'source_ref'
  | 'document_ref'
  | 'thinking'
  | 'metadata'
  | 'composer_preset'
  | 'ask_user_fields'
  | 'rich_content'
  | 'tabtin_rich_content'

/**
 * rich_content block 的内容子类型。
 *
 * 与后端 `present_to_user.py._SUPPORTED_KINDS` 和 `show_widget.py` 输出 kind 同步。
 *
 * 'widget' 来源（Widget Wave 2，widget RFC §三 3.1）：
 *   - `show_widget` 工具 emit RICH_CONTENT block，前端 RichContentRenderer
 *     按 kind 路由到 `<RichWidget>` 子组件渲染 sandbox iframe。
 *   - 与 'image' 卡片视觉区分点：左上角"图示"角标 + 流式渲染（image 是一次性 URL 加载）。
 */
export type RichContentKind =
  | 'image'
  | 'table_preview'
  | 'resource_ref'
  | 'file'
  | 'widget'
  | 'cli_output_table'
  | 'cli_output_record'
  // W7 双层结果推广：高频信息工具的结构化卡片（宪法 §05 §3）
  | 'search_results'
  | 'memory_card'
  | 'document_excerpt'
  | 'task_episode'
  // ：plan 提案作为持久化 block（payload 仅存 plan_ref + 轻量展示字段）
  | 'plan'

/** 历史 Flow View 载荷的节点状态；保留用于旧消息兼容。 */
export type FlowViewNodeStatus = 'pending' | 'active' | 'complete' | 'blocked' | 'skipped'

/** 历史 Flow View 使用稳定 id + parent_id 表达层级。 */
export interface FlowViewNode {
  id: string
  parent_id?: string
  label: string
  detail?: string
  status?: FlowViewNodeStatus
}

/** 版本化的历史 Flow View 载荷；新消息不再由默认 Agent 工具生成。 */
export interface FlowViewPayload {
  version: 1
  title: string
  nodes: FlowViewNode[]
}

export interface LocalFileArtifactSelfCheck {
  status: 'passed' | 'warning'
  summary: string
}

/**
 * 内置文件类型；协议层 file_type 已放宽为 string（可由 agent-runtime
 * ArtifactFormatRegistry 注入新类型），这里保留内置常量作为前端已知类型，
 * 同时允许任意字符串（注入类型）。
 */
export type BuiltinLocalFileArtifactFileType = 'xlsx' | 'docx' | 'pdf' | 'pptx'
export type LocalFileArtifactFileType = BuiltinLocalFileArtifactFileType | (string & {})

export interface LocalFileArtifactPayload {
  artifact_kind: 'local_file'
  file_type: LocalFileArtifactFileType
  relative_path: string
  filename: string
  url: `tabtin://resource/file/${string}`
  mime_type: string
  file_size: number
  auto_open?: boolean
  auto_open_token?: string
  auto_register?: boolean
  auto_register_token?: string
  self_check: LocalFileArtifactSelfCheck
}

/** ：OSS / 云端交付物（FileRecord），与 local_file 对等进入本轮产物。 */
export interface OssFileArtifactPayload {
  artifact_kind: 'oss_file'
  file_id: string
  file_type: string
  filename: string
  url: `tabtin://resource/file/${string}`
  mime_type: string
  file_size?: number
  access_url?: string
  auto_open?: boolean
  auto_open_token?: string
  /** 静默登记到当前任务的打开标签，不切焦点。 */
  auto_register?: boolean
  auto_register_token?: string
  self_check?: LocalFileArtifactSelfCheck
}

/**
 * rich_content block — Agent 通过 present_to_user 工具向用户展示的富内容
 */
export interface RichContentBlock extends MessageBlock {
  type: 'rich_content'
  kind: RichContentKind
  /** 必填。人类可读描述，用于移动端降级、无障碍、转录 */
  summary: string
  /** 来源 tool_call_id，关联同一次 present_to_user 的多项内容 */
  group_id?: string
  /** 展示组标题 */
  group_title?: string

  // -- image --
  /** 图片 URL（https） */
  url?: string
  /** 图片标题 */
  caption?: string
  /** 图片宽度 */
  width?: number
  /** 图片高度 */
  height?: number
  /** 无障碍替代文本 */
  alt_text?: string

  // -- table_preview --
  /** 表格标题 */
  title?: string
  /** 列定义 */
  columns?: Array<{ key: string; label: string }>
  /** 行数据 */
  rows?: Array<Record<string, unknown>>
  /** 总行数（数据可能被截断） */
  total_rows?: number
  /** 数据是否被截断 */
  truncated?: boolean

  // -- resource_ref --
  /** 资源类型 */
  resource_type?: string
  /** 资源 ID */
  resource_id?: string
  /** 资源显示名 */
  resource_name?: string
  /** 所属 Space 名称 */
  space_name?: string
  /** 打开按钮文案 */
  open_label?: string
  /**
   * present_to_user / 本地产物：为 true 时前端自动在 Space 工作区打开。
   * resource_ref 另要求新鲜 `auto_open_token`（present-<base36-ms>-*，约 5 分钟内），
   * 避免历史回放 / 虚拟列表重挂载反复抢焦点。
   */
  auto_open?: boolean
  /** 去重 + 新鲜度 token；同一资源多次 present 可区分 */
  auto_open_token?: string
  /** 显式交付物静默登记到当前任务标签，不切换 active / 不展开画布。 */
  auto_register?: boolean
  auto_register_token?: string
  /**
   * D2 优先级第 3 层 —— Agent 建议的目标 carrier appId（W6 修 L58）。
   *
   * 来源：`open_in_space(attach_resource_card=True)` 工具在后端 emit
   * `_block` 时把 effective hint 写到这里（`open_in_space.py:398`）；
   * 前端 RichResourceRef 卡片点击时透传到 `ResourcePointer.hint` 让
   * ResourceRouter 优先选 hinted carrier。
   *
   * **关键不变量**：attach_resource_card=True 场景下卡片二次打开的
   * hint 必须与首次展开（dispatchOpenInSpaceRequests 直接打开 tab）一致——
   * 否则违反 SKILL.md `open-in-space` 中"卡片应当与第一次展开等价"的契约。
   *
   * D2 用户主权：本字段仅是 hint，用户偏好（D2 第 1 层）+ session 临时
   * 切换（D2 第 2 层）始终覆盖；ResourceRouter.resolve 内部强制实现。
   */
  hint_carrier_app_id?: string

  // -- file --
  /** 文件大小（字节，file kind；与 MessageBlock.size 语义不同） */
  file_size?: number
  /**
   * 交付物标记：`local_file`（工作区）/ `oss_file`（云端 FileRecord）。
   * 无此字段的 file/image 视为 present_to_user 展示卡，不进本轮产物。
   * FileRecord UUID 复用下方 `file_id`（与 document_excerpt 同字段）。
   */
  artifact_kind?: 'local_file' | 'oss_file' | string
  /** oss_file：HTTPS 访问地址 */
  access_url?: string
  /** local_file：工作区相对路径 */
  relative_path?: string
  /** 扩展名语义类型（xlsx / png …） */
  file_type?: string
  self_check?: LocalFileArtifactSelfCheck

  // -- widget（Widget Wave 2，widget RFC §三 3.1）------------------
  /**
   * Widget 唯一 id（`wgt_<base36 ts>_<6char rand>`）。
   * 用途：
   *   - 历史回放时按 widget_id 索引重新渲染
   *   - Wave 7 sendPrompt 触发时父页面用 widget_id 校验来源 iframe
   */
  widget_id?: string
  /**
   * Widget 渲染源代码。Wave 2 是 SVG markup 字符串；Wave 6 解锁 HTML / Mermaid。
   *
   * **持久化语义**（widget RFC §11.3 双协议）：
   *   - 流式中间态走 `agent.stream.tool_call_args_delta`，**不**进 content_blocks_json
   *   - tool 真正 execute 时 emit RICH_CONTENT 进 content_blocks_json，code 完整持久化
   * Wave 4 烤图 + 移动端 image fallback 上线后 LLM history strip `code` 走
   * `llmStripKeys` 路径，避免 5KB+ SVG 每轮回流污染 context。
   */
  code?: string
  /**
   * 原始源代码。Wave 6 Mermaid 会把 `code` 写成编译后的 SVG，同时保留
   * `source_code` / `mermaid_source` 方便未来复制 Mermaid 源码或排错。
   */
  source_code?: string
  mermaid_source?: string
  /** Mermaid 编译后的 SVG；当前与 `code` 字面相同，保留显式字段表达语义。 */
  rendered_code?: string
  /**
   * Widget 格式。Wave 2 只支持 `'svg'`，Wave 6 解锁 `'html'` / `'mermaid'`。
   *
   * 用 string 而非严格 union 是为了向前兼容——服务端将来加新 format 时旧
   * 客户端能继续走 RichFallback 显示 summary，不抛 type 错误。
   */
  format?: string
  /**
   * 流式期间显示的占位文案。widget 还没收到 code 之前，RichWidget 会先显示
   * 这条文字（"Agent 正在生成可视化…" 或工具自定义）让用户感知"在做事"。
   */
  loading_message?: string
  /**
   * Widget 烤图 URL（https）。**Wave 2 不填**——Wave 4 OffscreenWindowPool
   * 烤图 + OSS 上传后才有值。移动端拿到这个 URL 显示 image fallback；桌面端
   * 历史模式优先用 `code` 重渲染（保真度），缺 `code` 时退到 image_url。
   */
  image_url?: string

  // -- flow_view（历史消息兼容；按普通 widget 的 HTML code 降级）--------
  /** widget 的可选历史语义变体；客户端按普通 widget 降级。 */
  widget_variant?: string
  /** 保留旧载荷供重放与导出读取；聊天渲染使用同块内的 HTML code。 */
  flow_view?: FlowViewPayload

  // -- 中断态（Widget Wave 3，widget RFC §五 3.6）--------------------
  /**
   * widget block 被中断时的时间戳（毫秒）。
   *
   * 触发时机：
   *   - lifecycle phase=cancelled / error / terminated → lifecycleHandler 标记
   *   - WS 死链兜底（reconcile / abortStream 路径）→ removeStreamingSession 标记
   *
   * 持久化语义：**仅 streaming 中间态用**，不进 content_blocks_json。RichWidget 检测到
   * 这个字段时显示"已中断"badge + 50% 透明度遮罩，让用户立刻识别"这是个未
   * 完成的 widget"——避免 cancel 后已渲染的 SVG 突然消失或永远停在"流式中…"
   * 状态。
   */
  interrupted_at?: number
  /**
   * 中断原因——决定 UI 视觉细节（cancelled vs error vs connection_lost）。
   *
   * 当前所有状态共享同一"已中断"badge（视觉一致性优先），未来若需要按
   * 状态区分 icon / 颜色（譬如 connection_lost 用 WifiOff icon），按这字段
   * 路由——所以保留枚举而不是 boolean。
   */
  interrupted_status?: 'cancelled' | 'error' | 'terminated' | 'unknown'

  // -- cli_output_table / cli_output_record（W4 D1：CLI stdout 自动渲染）-----------
  /**
   * 原始 CLI 命令字符串（如 `tabtin doc list --format json`）。
   * UI 在卡片头部以等宽字体显示，让用户知道数据来源，方便复制重跑。
   *
   * 注意与 `table_preview` 已有的 `columns` / `rows` 字段语义区分：
   *   - `columns` / `rows`：通用 table_preview，由 Agent 主动构造（如 SQL 查询结果）
   *   - `cli_columns` / `cli_rows` / `cli_record`：CLI stdout 自动识别后注入，
   *     带 `cli_command` 溯源 + 类型推断元数据
   *
   * 命名约定：`cli_*` 前缀统一标识"CLI stdout 自动渲染"族字段，与同 block 内
   * 通用字段（`summary` / `query`）区分；移动端 BlockItem 字段名同步对齐。
   */
  cli_command?: string
  /**
   * 列定义（cli_output_table）。`type` 用于驱动 UI 类型化渲染：
   *   - `datetime` → 人友好相对时间
   *   - `number`   → 右对齐 + 千分位
   *   - `boolean`  → ✓ / ✗ 图标
   *   - `id`       → 等宽字体 + 中段截断
   *   - `string`   → 默认（截断 + title 提示）
   */
  cli_columns?: Array<{ key: string; label: string; type?: string }>
  /** 行数据（cli_output_table）。保持 JSON 中的 key 顺序与原始 stdout 一致。 */
  cli_rows?: Array<Record<string, unknown>>
  /**
   * 行数（cli_output_table）。结构化字段而非 summary 文案——前端按 locale 拼
   * "X 条记录"显示，避免 runtime 包硬编码中文。与 `cli_rows.length` 等价但显式
   * 暴露方便 i18n 插值。
   */
  cli_row_count?: number
  /** 单对象数据（cli_output_record）。嵌套对象 / 数组由前端展开渲染。 */
  cli_record?: Record<string, unknown>

  // -- search_results（W7：web_search / rag_search / semantic_search 共用）--------
  /**
   * 搜索查询字符串。卡片头部展示 + 让用户复现搜索。
   * 与 `command` 区分：command 是 shell 命令字符串；query 是搜索关键词。
   */
  query?: string
  /**
   * 完整搜索结果列表。LLM 看 result.content 中的 top-N 摘要，UI 看本字段全集。
   *
   * 字段尽量保留可选——不同来源工具能填的字段不同：
   *   - web_search：title / url / snippet（外网）
   *   - rag_search：title / snippet / score / content_type（业务上下文）
   *   - semantic_search：title / snippet / file_path / score（代码语义）
   */
  search_results?: Array<{
    title?: string
    url?: string
    snippet?: string
    /** 相关度评分（rag/semantic）；展示时按 0-1 区间渲染百分比。 */
    score?: number
    /** rag_search 跨 content_type 命中时区分来源（table/skill/doc/code/...）。 */
    content_type?: string
    /** semantic_search / 代码搜索：来源文件路径。 */
    file_path?: string
    /** 来源标签（如域名、空间名）。 */
    source?: string
    /** 网站 favicon URL（web_search 优先；其他可省略）。 */
    favicon?: string
  }>
  /** 总命中数（可能 > search_results.length，因为只展示 top N）。 */
  total_count?: number

  // -- memory_card（W7：memory_search）--------------------------------------------
  /**
   * 记忆条目列表（memory_search）。
   *
   * `tags` 是数组以便 chip 渲染；`memo_type` 与 `memory_search` 工具的 enum 对齐
   * （about_you / insight / task_summary / skill / note / bookmark）。
   */
  memories?: Array<{
    id?: string
    content?: string
    memo_type?: string
    tags?: string[]
    importance?: number
    /** ISO 8601 创建时间字符串，UI 渲染相对时间。 */
    created_at?: string
    /** 来源链接（如 thread://session_id）。 */
    source_url?: string
  }>
  /**
   * ：执行 Agent id（memory_search 富块下发）。聊天记忆卡深链用它落到
   * 「我的 Agent → 该 Agent → 记忆」并高亮条目；缺省时仍可按 memoryId 打开治理面。
   */
  agent_id?: string
  /**
   * memory_search 分页信号 —— UI footer 提示用户"还有更多"，与 LLM 摘要中的
   * `has_more` / `next_cursor` 保持双层一致（避免 LLM 知道有更多但用户以为
   * 当前列表即全集）。当前 search_results 不带分页（搜索 API 一次返回 top-N）。
   */
  has_more?: boolean
  next_cursor?: string

  // -- document_excerpt（W7：parse_document）/ oss_file----------------
  /**
   * FileRecord UUID：document_excerpt 跳转预览；oss_file 交付物打开契约。
   */
  file_id?: string
  /**
   * 解析状态（与 docparse 后端 `data.status` 字面对齐）。
   *
   * - success：解析完成，chunks 可读
   * - parsing：后端正在解析中（已开始处理）
   * - pending：解析任务已触发但未开始
   * - partial：分页读取中（has_more=true）
   * - failed：解析失败（一般会走 isError，但保留语义）
   */
  parse_status?: 'success' | 'parsing' | 'pending' | 'partial' | 'failed'
  /** 已解析页数（parsing 中增量更新）。 */
  parsed_pages?: number
  /** 文件总页数。 */
  total_pages?: number
  /** 文档分片预览。LLM 看 result.content 文本截断，UI 看本字段结构化展开。 */
  document_chunks?: Array<{
    /** 1-based 页码。 */
    page?: number
    /** 分片正文（已截断到展示长度）。 */
    content?: string
    /** 分片类型：heading / paragraph / table / list 等。 */
    chunk_type?: string
    /** heading 层级（1-6）。 */
    heading_level?: number
  }>

  // -- task_episode（ATE-2：通用任务级 Episode 卡片）-------------------------------
  episode_id?: string
  episode_type?: string
  goal?: string
  status?: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stages?: Array<{
    id: string
    label: string
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'recovered'
    summary?: string
  }>
  user_message?: string
  warnings?: string[]
  recoveries?: string[]
  primary_artifact?: {
    kind: string
    label: string
    ref?: string
    placeholder?: boolean
    metadata?: Record<string, unknown>
  }
  artifact_refs?: Array<{
    kind: string
    label: string
    ref?: string
    placeholder?: boolean
    metadata?: Record<string, unknown>
  }>
  technical_evidence_refs?: Array<{
    kind: string
    label: string
    ref?: string
    placeholder?: boolean
    metadata?: Record<string, unknown>
  }>
  capture_scope?: Record<string, unknown>
  dataset?: {
    row_count?: number
    field_count?: number
    preview_rows?: Array<Record<string, unknown>>
  }
  fields?: Array<Record<string, unknown>>
  started_at?: string
  completed_at?: string
}

/**
 * Persisted ContentBlock shape emitted by daemon 6-piece streaming.
 *
 * UI adapters flatten `payload` into the legacy `RichContentBlock` shape when
 * rendering, but history/API contracts keep this nested shape in
 * `ChatMessage.content_blocks_json`.
 */
export interface TabTinRichContentBlock extends MessageBlock {
  type: 'tabtin_rich_content'
  kind: RichContentKind
  summary: string
  group_id?: string
  group_title?: string
  payload?: unknown
}

export interface LocalFileArtifactRichContentBlock extends TabTinRichContentBlock {
  kind: 'file'
  payload: LocalFileArtifactPayload
}

export interface OssFileArtifactRichContentBlock extends TabTinRichContentBlock {
  kind: 'file'
  payload: OssFileArtifactPayload
}

/**
 * v2 消息块
 */
export interface MessageBlock {
  type: MessageBlockType
  [key: string]: unknown
  /** 块级抵达序号（消费端时间线排序主键） */
  arrival_seq?: number
  /** 块抵达时间（ISO 8601） */
  arrived_at?: string
  /** @deprecated 历史实时流字段；新历史数据使用 arrival_seq */
  seq?: number
  /** 文本内容（text 类型） */
  text?: string
  /** 服务端文件 ID */
  file_id?: string
  /** 文件名 */
  filename?: string
  /** MIME 类型 */
  mime_type?: string
  /** 文件大小（字节） */
  size?: number
  /** 远程 URL（图片/文件下载；web_selection/web_annotation 时为页面 URL） */
  url?: string
  /** 本地预览 URL（仅前端使用） */
  preview_url?: string
  /** 文档 ID（doc_selection） */
  doc_id?: string
  /** 表格 ID（table_selection） */
  table_id?: string
  /** 记录 ID 列表（table_selection） */
  record_ids?: string[]
  /** 字段 ID 列表（table_selection） */
  field_ids?: string[]
  /** 代码文件路径，相对工作区根（code_file / code_selection） */
  file_path?: string
  /** 工作区/项目根路径（code_file / code_selection，便于解析 file_path） */
  root_path?: string
  /** 语言标识，如 typescript、python（code_file / code_selection） */
  language?: string
  /** 选区起始行号，1-based（code_selection） */
  start_line?: number
  /** 选区结束行号，1-based（code_selection） */
  end_line?: number
  /** 网页标题（web_selection/web_annotation） */
  page_title?: string
  /** 选区预览文本 */
  preview?: string
  /** 工具名称（tool_call / tool_result） */
  tool_name?: string
  /** 工具参数摘要 */
  args_summary?: string
  /** 状态 */
  status?: string
  /** 耗时（ms） */
  duration_ms?: number
  /** 结果数据 */
  data?: unknown
  /** 展示方式 */
  display?: string
  /** 来源 ID */
  source_id?: string
  /** 来源标签 */
  label?: string
  /** 文档引用：页码（document_ref） */
  page_number?: number
  /** 文档引用：bbox [x0, y0, x1, y1]（document_ref） */
  bbox?: [number, number, number, number]
  /** 文档引用：引用文本片段（document_ref） */
  ref_text?: string
  /** 通用内容字段（thinking/metadata 等 block 使用） */
  content?: string
  /** 工具调用 ID（tool_call block） */
  tool_call_id?: string
  /** 工具输入参数（tool_call block，与 ToolEvent.input 对齐） */
  input?: unknown
  /** 工具输出（tool_call block） */
  output?: unknown
  /** 是否出错（tool_call / metadata block） */
  error?: boolean | string
  /** 输出摘要（tool_call block） */
  output_summary?: string
}

/**
 * v2 附件元信息（存储在消息上）
 */
export interface MessageAttachment {
  type: 'image' | 'file' | 'video'
  file_id?: string
  filename: string
  mime_type: string
  size: number
  url?: string
  preview_url?: string
}

/**
 * 聊天消息（W3 Anthropic ContentBlock 协议对齐版 + W4c 字段名清理）。
 *
 * W4c 字段重命名：
 *   - `blocks_json` → `content_blocks_json`（与 W3 Django `ChatMessage.content_blocks_json`
 *     model 字段名对齐，详见 `apps/tabtin_django/apps/chat/conversation/models.py` §3.3.1）
 *   - `attachments_json` 退役（W3 已并入 content_blocks_json 的 image/document/file 块；
 *     API schema 仍返回空数组兼容老消息，但前端不读不写）
 *   - `agent_type` 退役（W3 已下线，API 始终返 null；前端不读不写）
 *   - `intent_confidence` 不再使用（前端从未消费过）
 *
 * 不向后兼容（v2 §六 W4c 硬底线"不留双路径"）：消费方一律读 `content_blocks_json`；
 * Django API schema 同步切换字段名（schemas.py + api/message.py 1 处 build mapping）。
 */
export interface ChatMessage {
  /** 消息ID（UUID） */
  id: string
  /** 角色 */
  role: MessageRole
  /** 本轮实际执行的 Agent；历史消息不会随会话指针切换而改写。 */
  agent_id?: string | null
  /** 已授权会话中可安全展示的 Agent 名称快照。 */
  agent_name?: string | null
  /** 已授权会话中可安全展示的 Agent 头像。 */
  agent_avatar?: string | null
  /** 客户端生成的幂等事件 ID，用于多端历史/实时去重 */
  client_event_id?: string | null
  /** 消息内容（v1 纯文本 / v2 主文本；W3 起对应 ChatMessage.text_summary） */
  content: string
  /**
   * v3 ContentBlock 数组（Anthropic Messages API 对齐，22 case discriminated union）。
   *
   * 流式期间通过 W4a `useContentBlocks(sid, mid)` hook 从 runtime store 订阅；
   * 历史回放（页面刷新 / session 切换）走 API GET /messages 返回本字段，再走
   * `adaptLegacyBlocksToContentBlocks` 兜底渲染。
   *
   * @see packages/agent-wire/src/stream-content-block.ts ContentBlockSchema
   * @see apps/tabtin_django/apps/chat/conversation/models.py ChatMessage.content_blocks_json
   */
  content_blocks_json?: MessageBlock[]
  /** 实际使用的模型ID（assistant消息才有） */
  model_id?: string | null
  /** 实际使用的模型名称（assistant消息才有） */
  model_name?: string | null
  /** 团队 Space 用户消息的发送者用户 ID */
  sender_user_id?: string | null
  /** 团队 Space 用户消息的发送者展示名 */
  sender_display_name?: string | null
  /** Agent Run ID（标识 AI 一轮操作，用于按操作粒度回滚资源） */
  agent_run_id?: string | null
  /** 检查点哈希（Shadow Git commit hash） */
  checkpoint_hash?: string | null
  /** 检查点状态索引 */
  checkpoint_state_index?: number | null
  /** 文件变更摘要（Shadow Git diff 统计） */
  diff_summary?: {
    changed: number
    insertions: number
    deletions: number
    files?: Array<{
      file: string
      changes: number
      insertions: number
      deletions: number
      binary: boolean
      /** git name-status 归一（added/modified/deleted）；老数据缺失 */
      status?: 'added' | 'modified' | 'deleted'
    }>
  } | null
  /** 聚合后的 checkpoint 版本点视图 */
  checkpoint_record?: CheckpointRecordView | null
  /** 错误码（失败消息时携带，用于重试/展示） */
  error_code?: string | null
  /** 创建时间（ISO 8601） */
  created_at: string
  /** 服务端最后更新时间（ISO 8601），用于增量对账 */
  updated_at?: string
  /** 消息元数据（agent 执行信息、token 用量等） */
  metadata?: Record<string, unknown> | null
  /**
   * 用户消息附件元信息（mobile / W3 兼容字段）。
   *
   * W3 §3.3.5：assistant 消息的 attachments_json 已并入 content_blocks_json
   * 的 image/document/file 块；user 消息的附件信息仍透传给 UI（待 Wave 8
   * 全量迁到 content_blocks_json 的 image/document/file 块后下线）。
   *
   * @deprecated 待 Wave 8 user 消息附件也走 content_blocks_json 后删除
   */
  attachments_json?: MessageAttachment[]
  /**
   * 识别的意图（assistant消息才有），可为 null。
   *
   * W3 §3.3.5：Django 端 intent / agent_type / intent_confidence 已停止生成。
   * 前端 MessageBubble 用 `intent === 'interrupted'` 判断中断态——这是兜底
   * 兼容老消息历史（DB 残留），新消息走 `stop_reason` / `error_info_json`。
   *
   * @deprecated 兼容老消息历史；新消息不再产生此值
   */
  intent?: IntentType | null

  // ──── W3 §3.3.1 顶层结构化字段 ────
  // W4c · R6-P0-1 修复：Django ChatMessageSchema 已暴露这些字段，前端类型
  // 必须同步声明——否则历史回放中 partialReason / errorClass 等中断态信号
  // 读不到（之前从 metadata 推断会拿不到 aborted 信号；正确位置在 stop_reason
  // / error_info_json）。

  /**
   * Anthropic stop_reason（assistant 消息才有）。
   *
   * 取值（W3 协议）：'end_turn' / 'max_tokens' / 'stop_sequence' / 'tool_use'
   * / 'aborted' / 'refusal' / 'error' / 'timeout'
   *
   * 前端用法：`stop_reason === 'aborted'` → 显示"已中断"；'error' / 'timeout'
   * → 显示"等待响应超时 / 出错"等。MessageBubble + legacyBlocksAdapter 通过此
   * 字段在历史回放中恢复 partialReason 语义。
   */
  stop_reason?: string | null

  /**
   * 结构化错误信息（W3 §3.3.1 derive_error_info 派生输出）。
   *
   * 含字段（assistant 消息异常完成时才有）：
   *   - `category`: 'aborted' / 'refusal' / 'error' / 'tool_exec' / 'context_overflow' / ...
   *   - `aborted`: boolean（用户主动 cancel 时为 true，前端可直接用此布尔判断）
   *   - `error_message`: 用户可见错误文案
   *   - 其他诊断字段（stage / reason / host 等，按错误类型不同）
   *
   * 前端用法：legacyBlocksAdapter 推断历史 message 的 partialReason 时优先读
   * 此字段——`error_info_json.aborted === true || error_info_json.category === 'aborted'`
   * → partialReason='aborted'；其他 category 非空 → partialReason='stream_interrupted'。
   */
  error_info_json?: Record<string, unknown> | null

  /**
   * 文本概要（W3 顶层冗余字段；与 content 等价语义）。
   *
   * 来源：daemon 落库时把 ContentBlock[] 中 text block 拼接为文本概要存到
   * 此字段。前端 MessageBubble 渲染主气泡文字时优先读 content（兼容旧形态），
   * 缺失时 fallback text_summary。
   */
  text_summary?: string | null

  /**
   * Anthropic Usage 累计 token（assistant 消息才有）。
   *
   * 含字段：input_tokens / output_tokens / cache_creation_input_tokens /
   * cache_read_input_tokens 等。前端用于显示"本条消息消耗 X tokens"调试态。
   */
  usage_json?: Record<string, unknown> | null

  /**
   * 子 Agent 运行 ID（subagent message 才有）。
   *
   * 前端用此字段判断 message 属于子 Agent timeline 还是主对话——同 W4a-L25
   * 订阅契约（runtime store messageMeta.subagent_run_id 等同此字段）。
   */
  subagent_run_id?: string | null

  /**
   * 模型名称快照（W3 落库时记录的实际使用模型，与 model_name 顶层字段冗余）。
   * 当前为兼容字段，前端读 model_name 即可。
   */
  model_name_snapshot?: string | null

  /**
   * 检查点锚点 block id / index（W3 §3.3.1 双锚定）。
   *
   * 用途：用户回滚到此 message 时，shadow git checkpoint 锁定到 content_blocks_json
   * 数组的指定 index 处的 block id——避免流式期间 block_id 漂移导致回滚失准。
   */
  checkpoint_anchor_block_id?: string | null
  checkpoint_anchor_block_index?: number | null

  // ──── W1b 协议层 message_kind 三档 ────
  //
  // 后端 ChatMessageSchema 始终返这两个字段（Django default='llm' + has_artifacts=false）。
  // 前端类型层用 optional `?:` —— 让本期不强求老 Electron 客户端立刻升级
  // （W2 起改造 MessageBubble / MessageList 按 message_kind switch UI 形态，
  // 中间窗口期可用 `?? 'llm'` fallback 安全过渡）。
  //

  /**
   * 消息语义类型——区分 LLM 主输出 / 工具产物气泡 / 错误文案气泡。
   *
   * 三档（与 wire `MessageKindSchema` + 后端 `ChatMessage.message_kind` 严格对齐）：
   * - `'llm'`：主 LLM 真实输出（含 thinking / text / tool_use 等 block；
   *   含子 Agent 主消息）。前端走完整 MessageBubble + footer（cost / rollback / fork）。
   * - `'tool_artifact'`：daemon emitDetachedMiniMessage 路径，承载
   *   `tabtin_rich_content` 块（widget / search_results / cli_output_* /
   *   present_to_user 子卡等 10 类）。前端走"产物气泡"紧凑形态：无 footer /
   *   无 MessageActions / 紧贴上一条主消息。
   * - `'error_envelope'`：daemon 自合成错误文案气泡（context overflow / capability
   *   gate 等）。显示时间戳 + 复制按钮，跳过 thinking placeholder + cost label。
   *
   * - `'environment_context'`：每轮 `<context type="environment">` 环境快照
   *   作为独立 immutable 历史块落库（role=user），稳定跨轮 prompt cache 前缀；
   *   **对用户 UI 隐藏**（MessageBubble return null），仍喂给 LLM 作历史。
   * - `'agent_profile_context'`：内容变化时注入的
   *   `<context type="agent-profile">`（personal_rules / custom_rules 等），
   *   role=user 落库；**UI 隐藏**；发给 LLM 时历史多份 keep-latest。
   *
   * - `'system_prompt_context'`：每轮实际生效的 system prompt 快照，role=user
   *   落库；**UI 隐藏**；#8550 起不进 LLM 历史（仅审计 / 导出回退；本轮规则走 system）。
   *
   * - `'hitl_interaction'`：审批 / 追问的对话内持久化事实（role=assistant），
   *   由 Django pending_interaction_service 与 PendingInteraction 同事务写入；
   *   `metadata.hitl` 承载 `{ kind, request_key, status, payload, ... }`，状态翻转随
   *   增量 sync 到达所有端，前端面板据此开/清（reconcileHitlPanelsFromMessages）。
   *   **对用户 UI 隐藏**（面板才是交互面），**且绝不喂给 LLM**。
   *
   * Fallback 行为：缺失时按 `'llm'` 处理（兼容 W1b 前的老 message 行 / 老 build
   * 缓存）—— `message.message_kind ?? 'llm'`。
   */
  message_kind?:
    | 'llm'
    | 'tool_artifact'
    | 'error_envelope'
    | 'environment_context'
    | 'agent_profile_context'
    | 'system_prompt_context'
    /** 外部历史导入边界说明（本机档案展开；对用户 UI 隐藏，须进 LLM 历史） */
    | 'external_archive_context'
    | 'compaction_summary'
    | 'hitl_interaction'

  /**
   * 是否有同 agent_run_id 的 tool_artifact 待懒加载（PRD §3.6.4）。
   *
   * 仅 `message_kind='llm'` 主消息可能为 true。配合历史 API 默认
   * `?expand_artifacts=false` 懒加载策略，前端按需触发"展开产物气泡"
   * （重拉 `?expand_artifacts=true` 或调用 artifacts 子 endpoint，待 W2/W8 实施）。
   *
   * 默认 false（包括所有 `tool_artifact` / `error_envelope` 自身）。
   */
  has_artifacts?: boolean

  // ────  引用回复 ────

  /**
   * 被引用消息的 ID（同 session 的 ChatMessage PK）。
   *
   * 「一份数据、两种消费」的存储真相：本消息引用了哪条历史消息。点击气泡引用条
   * 用它 `scrollToMessage` 跳转到原消息。被引用消息被回退 / 删除后为 null
   * （后端 SET_NULL），此时靠 `reply_to_preview` 快照兜底显示。
   */
  reply_to_message_id?: string | null

  /**
   * 被引用消息的展示快照 { role, author, text }。
   *
   * 与被引用消息同源，发送时派生并落库——被引用消息可能已滚出加载窗口 / 被 trim /
   * 被删，有此快照气泡引用条就永远显示得出来，无需额外查询。
   */
  reply_to_preview?: ReplyToPreview | null
}

/**
 * 引用回复的被引用消息快照。
 *
 * 轻量、只读——只承载气泡引用条渲染所需的最小信息。给 LLM 看的注入
 * （`<context type="quoted-message">`）是发送时从被引用消息实时派生的临时
 * prompt 拼接，不走此结构，也不落库。
 */
export interface ReplyToPreview {
  /** 被引用消息角色（user / assistant） */
  role: MessageRole
  /** 被引用消息作者展示名（Agent 名或用户名）；缺省留空 */
  author?: string
  /** 被引用消息文本摘要（气泡引用条截断展示用） */
  text: string
}

/** Agent 名称 */
export type AgentName = 'tin' | string

/**
 * 消息列表响应
 */
export interface MessageListResponse {
  /** 消息列表 */
  messages: ChatMessage[]
  /** 总消息数 */
  total: number
  /** 是否还有更多消息 */
  has_more: boolean
  /** 是否在 UI 展示单条消息费用（与计费策略对齐，可选） */
  show_per_message_cost?: boolean | null
  /** 本次返回的最早消息 ID */
  oldest_id: string | null
  /** 本次返回的最新消息 ID */
  newest_id: string | null
  /** 服务端同步水位，用于下一次 updated_after 增量对账 */
  server_timestamp?: string
}

export interface CompactionCheckpointRequest {
  summary: string
  compacted_up_to_message_id: string
  source: 'manual' | 'auto'
  focus?: string | null
  stats?: Record<string, unknown> | null
  client_event_id?: string | null
}

export interface CompactionCheckpointResponse {
  message: ChatMessage
}

/**
 * 消息查询参数
 */
export interface MessageQueryParams {
  /** 返回消息数量 */
  limit?: number
  /** 分页偏移量（兼容模式） */
  offset?: number
  /** 游标：获取此消息 ID 之前的消息 */
  before?: string
  /** 游标：获取此消息 ID 之后的消息 */
  after?: string
  /**
   * 游标：以此消息 ID 为锚点获取上下文窗口（前 limit/2 + 该消息 + 后 limit/2）。
   *
   * 用于「跳转到未加载的历史消息」：目标不在当前列表时一次拉出其前后窗口。
   * 后端按 `pagination_mode='cursor_around'` 处理；anchor 不在会话时返回空列表。
   */
  around?: string
  /** 增量同步：仅返回此 ISO8601 时间之后新增的消息 */
  updated_after?: string
  /** 增量同步上界：固定本轮分页的服务端同步水位 */
  updated_before?: string
  /**
   * 是否展开 tool_artifact 行（W1b 协议层 message_kind 懒加载，PRD §3.6.4）。
   *
   * - **默认 false**（W2 显式传 false 保持默认行为）：API 过滤掉
   *   `message_kind='tool_artifact'` 行；每条 LLM 主消息附 `has_artifacts`
   *   字段让前端按需触发"展开产物气泡"。
   * - **true**：返回全部 ChatMessage（含 tool_artifact 行），用于 dogfood 阶段
   *   验证画布历史回放或未来"展开产物"按钮 UX 实施。
   *
   */
  expand_artifacts?: boolean
  /**
   * 是否下发 `hitl_interaction` 审批/追问事实行。
   *
   * 服务端默认 **false**（保护不认识该 kind 的旧客户端/移动端）；本包
   * `MessageManager.list` 默认传 true——当前版本已支持面板派生与重载恢复。
   */
  include_hitl_facts?: boolean
}

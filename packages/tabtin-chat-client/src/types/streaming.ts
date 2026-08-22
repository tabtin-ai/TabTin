/**
 * 流式事件类型（WS-first）
 *
 * 注：``title_updated`` 不在本 union —— 它是 user-level envelope
 * （``agent.user.title_updated``），由 `chatApi.ts::registerBackgroundEventRouter`
 * 直接路由到 `useChatStore.updateSessionTitleInCaches`，不进 StreamManager
 * per-stream callback 链。
 */
export type SSEEventType =
  | 'chunk'           // AI 逐字输出
  | 'tool_call'       // 后端工具调用
  | 'done'            // 完成
  | 'error'           // 错误
  | 'connected'       // 连接成功
  | 'message'         // 通用消息
  | 'action_required' // 需要前端执行动作
  | 'frontend_action' // 前端动作请求（历史别名）
  | 'heartbeat'       // 心跳
  | 'ping'            // 心跳（历史别名）
  | 'approval_requested'  // v0.4 W1.5：批量审批请求（替代旧 review_required）
  | 'approval_resolved'   // v0.4 W1.5：批量审批响应广播
  // W4 R3 (2026-05-11): ask 三件套并存——`ask_user_required`（替代旧 `ask_choice_required`，
  // 多选问答 HITL）+ `ask_form_required` + `request_approval_required`
  | 'ask_user_required'
  | 'ask_form_required'
  | 'request_approval_required'
  | 'step'            // Agent 执行步骤
  | 'tool'            // 工具调用事件
  | 'lifecycle'       // 生命周期事件
  | 'subagent_started'
  | 'subagent_progress'
  | 'subagent_failed'
  | 'subagent_completed'
  | 'rich_content'

/**
 * 内容块事件数据
 */
export interface ChunkEventData {
  /** 内容块 */
  content: string
}

/**
 * 工具调用事件数据
 */
export interface ToolCallEventData {
  /** 工具名称 */
  tool_name: string
  /** 工具参数 */
  tool_args: Record<string, any>
}

/**
 * 完成事件数据
 */
export interface DoneEventData {
  /** 消息ID */
  message_id: string
  /** 完整内容 */
  full_content: string
  /** 附加元数据（如 errorCategory） */
  metadata?: Record<string, unknown>
}

/**
 * 错误事件数据
 */
export interface ErrorEventData {
  /** 错误信息 */
  error: string
}

/**
 * 连接成功事件数据
 */
export interface ConnectedEventData {
  /** 状态 */
  status: string
  /** 线程ID */
  thread_id: string
}

/**
 * 通用消息事件数据
 */
export interface MessageEventData {
  /** 消息类型 */
  type?: string
  /** 消息内容 */
  content?: string
  /** 原始事件载荷 */
  payload?: Record<string, any>
}

/**
 * 前端动作请求事件数据
 */
export interface ActionRequiredEventData {
  /** trace_id（可能为空） */
  trace_id?: string | null
  /** 线程ID */
  thread_id?: string
  /** 动作类型 */
  action: string
  /** 任务ID */
  task_id: string
  /** 动作参数 */
  params: Record<string, any>
  /** 动作描述 */
  description?: string
  /** 沙箱安全策略（由服务端 SandboxPolicyResolver 生成） */
  sandbox_policy?: {
    route: string
    sandbox_level?: string
    approval_required?: boolean
    deny_reason?: string
    network_mode?: string
    relaxed_rules?: string[]
  }
}

/**
 * 心跳事件数据
 */
export interface HeartbeatEventData {
  /** 时间戳 */
  timestamp?: number
}

/**
 * CLI 调用 spec（PRD-v3 §5.1 第 1 项 + 第 6 项）
 *
 * Wave A 启动包 A4 引入：HITL UI 通过本字段拿到「人类可读 resource label」(`resource_label`)
 * 与原始 typed resource id (`resource`)，渲染时若有 label 则显示 label，否则灰显 raw id
 * 并提示「无法解析」。后端 `CliInvocationSpec` 序列化时整体写入 `action_request.cli_spec`，
 * 由 Wave A5（CLI wrapper 接入 HITL build_interrupt_payload 路径）实际填充。
 *
 * 协议预留：A4 仅定义类型与 UI 渲染逻辑；后端注入由 A5+ 完成。前端代码已经能容忍
 * `cli_spec` 缺失（fallback 到既有 toolName/args 渲染）。
 */
export interface CliSpecForUI {
  /** `tabtin` / 其他白名单 binary */
  binary?: string
  /** 业务域，如 `im` / `vc` / `table` */
  domain?: string
  /** 动作动词，如 `send` / `delete` / `query` */
  verb?: string
  /** typed URI 资源 id，如 `chat:oc_xxx` / `doc:doc_yyy`；无资源参数时为 null */
  resource?: string | null
  /** 人类可读 label（如「产品三群」/「Q3 战略规划」），由后端 `resolve_resource_label` 解析，
   *  失败为 null，UI fallback 到 raw `resource` 灰显 + 提示「无法解析」。 */
  resource_label?: string | null
  /** 风险等级：`safe` / `review` / `strict`（与 `RegisteredTool.risk_level` 三档对齐） */
  risk_level?: 'safe' | 'review' | 'strict'
  /** 命中的 YAML 规则 pattern，便于审计页「为什么是这个 risk」反查 */
  matched_rule_pattern?: string
}

/**
 * 人工确认请求中的动作信息
 */
export interface ReviewActionRequest {
  /** 动作名称（前端规范字段） */
  name?: string
  /** 工具名称（后端规范字段，优先于 name） */
  tool_name?: string
  /** 工具调用 ID（用于 per-tool 决策） */
  tool_call_id?: string
  /** 动作参数 */
  args?: Record<string, any>
  /** 动作参数（后端规范字段，优先于 args） */
  arguments?: Record<string, any>
  /** 动作描述 */
  description?: string
  /**
   * CLI 调用 spec（A4 引入，A5+ 实际填充）
   *
   * 当本动作是 CLI 类（`tabtin <app> <verb> ...`）时，后端把
   * 解析得到的 `CliInvocationSpec` 子集写入本字段，让 HITL UI 渲染人类可读的
   * resource label 而不是裸 id。非 CLI 类动作或后端尚未接入时本字段缺失。
   */
  cli_spec?: CliSpecForUI
}

/**
 * 人工确认配置
 */
export interface ReviewConfig {
  /** 动作名称 */
  action_name: string
  /** 允许的决策 */
  allowed_decisions: Array<'approve' | 'edit' | 'reject'>
}

/**
 * 人工确认请求事件
 */
export interface ReviewRequiredEventData {
  /** 线程 ID */
  thread_id: string
  /** 中断 ID */
  interrupt_id?: string
  /** 动作列表 */
  action_requests: ReviewActionRequest[]
  /** 审查配置 */
  review_configs: ReviewConfig[]
  /** 可选：提示文本 */
  message?: string
  /** 可选：关联的消息 ID */
  message_id?: string
  /** 统一交互类型（供多端做通用路由） */
  interaction_type?: StructuredInteractionType
  /** 是否阻塞主输入区 */
  blocking_policy?: StructuredInteractionBlockingPolicy
}

/**
 * AskUser naming convention
 * - Canonical product interaction name: `ask_user`
 * - W4 R3 (2026-05-11): ask 三件套并存——`ask_user_required`（替代旧
 *   `ask_choice_required`，多选问答 HITL）+
 *   `ask_form_required` + `request_approval_required`
 *
 * 路径权限治理 W7 / B4：`LEGACY_ASK_QUESTION_TOOL_NAME` 死代码已清退（D3 不留兼容；
 * runtime / tool-system did_you_mean / Daemon 端 0 caller）。
 */
export const ASK_USER_INTERACTION_TYPE = 'ask_user' as const
export const ASK_USER_REQUIRED_EVENT = 'ask_user_required' as const
export const ASK_FORM_REQUIRED_EVENT = 'ask_form_required' as const
export const REQUEST_APPROVAL_REQUIRED_EVENT = 'request_approval_required' as const

export type StructuredInteractionType = 'ask_user' | 'review' | 'preset_input' | 'app_form'
export type StructuredInteractionBlockingPolicy = 'soft' | 'hard'
export type StructuredInteractionResponseType = 'submit' | 'skip'

export interface AskUserQuestionOption {
  id: string
  label: string
  description?: string
  /** W4：可选预览内容（mockup / code snippet 等），UI 在选项卡片下渲染。 */
  preview?: string
}
export interface AskUserQuestion {
  id: string
  prompt: string
  /** W4：极短标签（≤12 字符 chip / tag），UI 在问题旁显示。可选。 */
  header?: string
  options: AskUserQuestionOption[]
  /** 定制「其他」入口文案（与普通 option 同结构）；未传时前端走内置 i18n。 */
  other_option?: AskUserQuestionOption
  allow_multiple?: boolean
  allow_free_text?: boolean
}

export type AskUserFormMode = 'questions' | 'fields' | 'text_fallback' | 'approval'

/**
 * Ask 交互的语义意图（M1 人机交互闭环）：
 * - 'collect' (默认): Agent 不知道答案，向用户收集 — 中性表单，返回字段值
 * - 'approve': Agent 已决定方案，请用户确认 — 顶部展示 rationale，字段预填可改，
 *              双按钮（确认/取消），返回 { approved, fields, modified_fields }
 * - 'choose': 让用户从 2-5 个选项中选 — questions 模式
 */
export type AskUserIntent = 'collect' | 'approve' | 'choose'

/**
 * Ask · approve 模式的风险分层，影响视觉警示与提交确认机制。
 * - 'safe' (默认): 普通样式
 * - 'review': 边框警示色，提示仔细检查
 * - 'high': 醒目警告 + 长按确认（防误点）
 */
export type AskUserRiskLevel = 'safe' | 'review' | 'high'

export interface PresetFieldVisibleWhen {
  field: string
  equals: unknown
}

export interface PresetFieldValidationDef {
  pattern?: 'url' | 'email' | string
  type?: 'number' | 'integer'
  min?: number
  max?: number
  maxLength?: number
}

export interface PresetFieldDef {
  key: string
  label: string
  label_key?: string
  type?: string
  required?: boolean
  default?: unknown
  placeholder?: string
  placeholder_key?: string
  options?: AskUserQuestionOption[]
  description?: string
  validation?: PresetFieldValidationDef
  group?: string
  col?: number
  error_message?: string
  error_message_key?: string
  visible_when?: PresetFieldVisibleWhen
  config?: Record<string, unknown>
}

export interface AddonParamDef {
  key: string
  label: string
  label_key?: string
  icon?: string
  default_active?: boolean
  fields?: PresetFieldDef[]
  // 向后兼容：无 fields 时用以下属性构建单字段
  type?: string
  default?: unknown
  options?: AskUserQuestionOption[]
}

export interface AskUserRequiredEventData {
  thread_id: string; interrupt_id?: string;
  questions?: AskUserQuestion[]; title?: string;
  tool_call_id: string; message_id?: string; message?: string;
  form_mode?: AskUserFormMode;
  fields?: PresetFieldDef[];
  addons?: AddonParamDef[];
  interaction_type?: StructuredInteractionType;
  blocking_policy?: StructuredInteractionBlockingPolicy;
  /** M1 人机交互闭环：交互意图，驱动前端 UI 路由（FieldsForm / ConfigConfirmCard / QuestionsForm） */
  intent?: AskUserIntent;
  /** intent='approve' 必填：向用户解释提议方案 */
  rationale?: string;
  /** 视觉警示等级（默认 safe） */
  risk_level?: AskUserRiskLevel;
  /** 自定义主按钮文案（如 '创建任务'） */
  submit_label?: string;
  /** 自定义拒绝按钮文案（仅 approve 模式，如 '不创建'） */
  decline_label?: string;
  /** 引用平台已注册的 preset id 作为 schema 模板 */
  preset_id?: string;
  /** request_approval 展示用结构化明细；只读，不作为表单字段回传 */
  details?: unknown;
}
export interface AskUserAnswer {
  question_id: string; selected_options: string[]; free_text?: string;
}
export interface AskUserAnswerEnvelope {
  kind: 'ask_user'
  response_type: StructuredInteractionResponseType
  form_mode: AskUserFormMode
  /** M1：透传交互 intent，便于后端 / Agent 区分 collect/approve/choose */
  intent?: AskUserIntent
  answers?: AskUserAnswer[]
  field_values?: Record<string, unknown>
  /** 与 form_mode === 'text_fallback' 配套 */
  text?: string
  /** intent='approve' 模式：用户是否确认（false = 拒绝） */
  approved?: boolean
  /** intent='approve' 模式：用户实际修改过的字段 key 列表（相对 default） */
  modified_fields?: string[]
}
/**
 * 流式事件数据联合类型
 */
export type SSEEventData =
  | ChunkEventData
  | ToolCallEventData
  | DoneEventData
  | ErrorEventData
  | ConnectedEventData
  | MessageEventData
  | ActionRequiredEventData
  | HeartbeatEventData
  | ReviewRequiredEventData
  | AskUserRequiredEventData

/**
 * 流式回调接口
 */
export interface StreamCallbacks {
  /** 接收到内容块时的回调 */
  onChunk?: (chunk: string, fullContent: string) => void
  /** 工具调用时的回调 */
  onToolCall?: (toolName: string, toolArgs: Record<string, any>) => void
  /** 完成时的回调 */
  onDone?: (messageId: string, fullContent: string, metadata?: Record<string, unknown>) => void
  /** 错误时的回调 (error message, optional error category) */
  onError?: (error: string, errorCategory?: string) => void
  /** 连接打开时的回调 */
  onOpen?: () => void
  /** 连接成功时的回调 */
  onConnected?: (threadId: string) => void
  /** 通用消息回调（可选） */
  onMessage?: (message: MessageEventData) => void
  /** 检测到 WS 序列号缺口时的回调（覆盖所有 envelope） */
  onSeqGap?: (info: { expectedSeq: number; actualSeq: number; gap: number }) => void
  /** 需要前端执行动作时的回调 */
  onActionRequired?: (action: ActionRequiredEventData, taskId: string) => void | Promise<void>
  /** 心跳时的回调（可选） */
  onHeartbeat?: () => void
  /**
   * v0.4 W1.5（PRD §7.4 / §7.5）：批量审批请求回调（替代旧 onReviewRequired）。
   * payload 是 ApprovalRequestedPayload（含 batch_id + action_requests[] + runtime_mode + expires_at）。
   */
  onApprovalRequested?: (data: Record<string, unknown>) => void
  /**
   * v0.4 W1.5：批量审批响应广播（first-resolve / 跨端镜像 / rollback cancel 都走此事件）。
   * payload 是 ApprovalResolvedPayload（含 batch_id + decisions[]）。
   */
  onApprovalResolved?: (data: Record<string, unknown>) => void
  /** 需要用户回答问题的回调 */
  onAskUserRequired?: (data: AskUserRequiredEventData) => void
  /** LLM 重试时通知前端清空已接收的部分内容 */
  onContentReset?: () => void
  onSuspended?: () => void
  onRunCompleted?: (runId: string, status: string) => void
  onRunStillRunning?: () => void
  onHitlRestored?: (interaction: Record<string, unknown>) => void
}

/**
 * 前端动作结果
 */
export interface ActionResultRequest {
  /** 动作是否执行成功 */
  success: boolean
  /** 追踪 ID（可选，建议提供） */
  trace_id?: string
  /** 清洗后的 HTML（网页抓取任务） */
  clean_html?: string
  /** 骨架 HTML（可选） */
  skeleton_html?: string
  /** 页面标题（可选） */
  title?: string
  /** 实际访问的 URL（可选） */
  url?: string
  /** 内容长度（字节） */
  content_length?: number
  /** 错误信息（失败时必填） */
  error?: string

  // Browser Agent execute_act 扩展字段
  /** 执行的动作列表 */
  executed_actions?: Array<{
    type: string
    selector?: string
    value?: string
    timestamp?: number
    [key: string]: any
  }>
  /** 前端执行耗时（毫秒） */
  frontend_execution_time_ms?: number
  /** 页面 URL */
  page_url?: string
  /** 页面标题 */
  page_title?: string
  /** 页面状态快照 */
  snapshot?: Record<string, any>
  /** 页面变化差异 */
  diff?: Record<string, any>
  /** 操作后的截图（Base64 编码的 PNG 图片，用于 Vision 模型） */
  screenshot_base64?: string
  /** 观察到的元素列表（Observe 任务） */
  observed_elements?: Array<Record<string, any>>
  /** 无障碍树（Browser Agent observe/snapshot 场景） */
  accessibility_tree?: string
  /** XPath 映射（Browser Agent observe 场景） */
  xpath_map?: Record<string, string>
  /** 自定义数据（任意 JSON 对象） */
  data?: Record<string, any>
}












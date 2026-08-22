/**
 * engine/contracts 第 2 层 —— 对话消息契约。
 *
 * Message / ContentBlock 家族（引擎内部会话状态的简化消息格式）+
 * Internal Message Markers（W4.3.2 隐形标记 SSoT）+ SystemBlock / ToolParam +
 * NormalizationLevel（FR-03）。
 *
 * 分层规则见 wire-protocol.ts 头注释；本层不 import 任何兄弟契约。
 */

// ─── Message Types ──────────────────────────────────────────────────
// Simplified message format for the engine's internal conversation state.

export type MessageRole = 'user' | 'assistant' | 'system';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
  presentation?: {
    kind: string;
    data?: Record<string, unknown>;
  };
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
  file_id?: string;
  filename?: string;
  mime_type?: string;
  detail?: 'low' | 'high' | 'auto';
  width?: number;
  height?: number;
}

/** Chat video multimodal input ( MVP：仅公网/OSS URL，不做 base64)。 */
export type VideoSource = { type: 'url'; url: string };

export interface VideoBlock {
  type: 'video';
  source: VideoSource;
  file_id?: string;
  filename?: string;
  mime_type?: string;
}

/**
 * 聊天文档原生多模态输入：PDF / Office 等 file 附件直喂模型。
 * 默认走 URL（OSS CDN）；本机不可达时可由 Host 收成 base64 data URL。
 */
export type DocumentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export interface DocumentBlock {
  type: 'document';
  source: DocumentSource;
  /** Host 资源身份；历史轮降为 Agent 资源引用时必须保留。 */
  file_id?: string;
  title?: string;
  mime_type?: string;
}

/**
 * 用户文件附件持久化块。
 *
 * 与 DB `content_blocks_json` / host `buildAttachmentMessageBlocks` /
 * 前端 `deriveUserAttachments` 扁平形态对齐；不进 LLM 多模态 part
 *（proxy-provider 转 text/image/video/document；file 块仅 UI/落库）。
 */
export interface FileBlock {
  type: 'file';
  file_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  url?: string;
  preview_url?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock
  | VideoBlock
  | DocumentBlock
  | FileBlock;

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

export type MessageParam = Message;

// ─── Internal Message Markers (W4.3.2) ──────────────────────────────
//
// 引擎内部 hook / 工具链有时需要在 Message 上打"隐形标记"，让下游 normalize 阶段
// 把它跟普通用户 user message 区分开。最典型场景就是 W4.3.2 dogfood P0：
//
//   `context-injector` hook 在 `beforeIteration` 时曾 prepend 一条
//   `{role:'user', content:[{type:'text', text:'<context>...</context>'}]}` 到
//   `state.messages` 起首；这条 user 跟"用户真实输入"在 `mergeConsecutiveMessages`
//   眼里都是 `'other'`，旧实现就把它们合并 → LLM thinking 误解"用户同时请求两件事"。
//   新路径在 runtime 内部以 `role:'system'` 保存注入消息，只在 LLM 出口投影成
//   provider 兼容的 `role:'user'`。
//
// 修法：把 marker 字符串提到 SSoT，让注入方（context-injector / continuation 路径）
// 跟检测方（message-normalizer.classifyUserMessage）共享同一份字面量，避免任意一方
// 改 key 字符串后另一方"看不见 marker → 仍按 'other' 合并"再次回归。
//
// **设计取舍**：marker 挂在 Message 上是"附加属性"——不进 Message 类型签名（保持
// 跨边界 wire 协议干净），靠 type assertion 读。两点保护：
//   1) marker 只在 in-memory state.messages 上短暂存在；持久化 / 跨进程传递前
//      会被 spread / JSON 序列化丢掉（这是预期行为，对 wire 透明）。
//   2) 任何 hook / 工具想跟 normalizer 协作语义时，都必须**通过本常量**写 marker，
//      不许散写字面量。

/** Marker keys (string properties) that may appear on Message objects. */
export const INTERNAL_MESSAGE_MARKERS = {
  /**
   * context-injector hook 注入的内部 system message。
   * 见 `engine/message-normalizer.ts` `classifyUserMessage` 四分类
   * （`tool_result_only` / `context_injection` / `continuation` / `other`）。
   */
  CONTEXT_INJECTION: '__context_injector__',
  /**
   * 历史里**已落库**的 environment context 块。
   *
   * 与 `CONTEXT_INJECTION` 的区别：`CONTEXT_INJECTION` 是当前轮 in-memory 注入的
   * **fresh** 块，由 context-injector 每轮 filter + 重插；本 marker 标的是**过往轮
   * 落库后从历史重建**的 context 块——它是 immutable 历史的一部分，**injector 不
   * 得 filter / 移动它**。两者用不同 marker，让 injector 的「删旧 fresh」filter
   * 天然不碰历史块（无需位置判断）。
   *
   * 该 marker 由 query.ts 在装填 initialMessages 后按 content（`<context
   * type="environment">` wrapper）识别并补打——marker 本身不跨落库存活，重建时
   * 重新标记，下游 classify / normalizer 复用同一套 marker 逻辑。
   */
  HISTORICAL_CONTEXT: '__historical_context__',
  /**
   * memory-injector hook 注入的 user message（M3 阶段 3）：
   * `<memory_recall>` 块——每轮 LLM 前从 TabMemo 拉相关 memo 注入。
   *
   * 与 ``CONTEXT_INJECTION`` 对称：marker 字符串当 SSoT 让 hook + 任何
   * 想跟它协作的下游（譬如 message-normalizer 区分注入 vs 真用户输入）
   * 共享同一份字符串，不允许散写字面量。
   */
  MEMORY_INJECTION: '__memory_injector__',
  /**
   * agent-profile hook 注入的 user message：
   * `<context type="agent-profile">`——当前会话 Agent 的展示名 / 目标。
   *
   * 对话中可切换 Agent，故**不**烘焙进 system prompt，而与 context /
   * memory-recall 同构贴当前 user 消息之前；message-normalizer 用本 marker
   * 归独立 kind，防止与相邻真用户输入合并。
   */
  AGENT_PROFILE_INJECTION: '__agent_profile_injector__',
  /**
   * 历史里**已落库**的 agent-profile 块。
   *
   * 与 `AGENT_PROFILE_INJECTION` 的区别：后者是当前轮 in-memory **fresh** 注入；
   * 本 marker 标的是过往轮落库后从历史重建的 profile——immutable，hook 不得
   * filter / 移动。变化检测比较「当前 fingerprint vs 历史最新一份」时读这类块。
   */
  HISTORICAL_AGENT_PROFILE: '__historical_agent_profile__',
  /**
   * max_tokens continuation 路径补的 user "Continue exactly..."。
   * 检测点同 `CONTEXT_INJECTION`——message-normalizer 用 marker 优先策略
   * 在合并阶段把它跟普通 user 视为不同 kind 不合并。
   */
  CONTINUATION: '__continuation_marker__',
  /**
   * 工具执行后补入下一次 LLM 调用的非文本消息（例如 read_file 读取到的图片）。
   *
   * 模型协议仍需要把图片作为 user message 输入；此 marker 仅标注其产品作者是
   * 工具系统，而不是用户，供快照观测和消息持久化边界正确投影。
   */
  TOOL_INJECTED: '__tool_injected__',
  /**
   * LSP diagnostic attachment hook 注入的 user message
   * （含 `<system-reminder><new-diagnostics>...</new-diagnostics></system-reminder>`）。
   *
   *   内部附件 / meta 消息用 InternalMessageMarker 标记
   */
  LSP_DIAGNOSTICS_INJECTION: '__lsp_diagnostics_injector__',
  /**
   * 阶段 6 议题 2：dynamic-tool-manager `evictStale` 触发时由
   * `engine/query.ts` push 的中文 `[system] 工具已下线…` notice。
   *
   * 历史这条 user message **没有 marker**——message-normalizer 的
   * `classifyUserMessage` 把它归到 'other'，跟相邻的真用户输入合并风险存在
   * （目前生产 38 session 0 触发，但属契约漏洞，与 dogfood W4 撞过的 P0 同型）。
   * 本 marker 由 query.ts:4710 注入时 `setInternalMarker` 标识，让 normalizer
   * 把它归独立 kind ('tool_eviction_notice')，与所有相邻 user 类型都不合并。
   */
  TOOL_EVICTION_NOTICE: '__tool_eviction_notice__',
  /**
   * Phase 2 mode-reminder-injector hook 注入的 per-turn sparse reminder。
   * 紧挨最后一条真实 user message 之后；message-normalizer 独立 kind 防合并。
   */
  MODE_REMINDER_INJECTION: '__mode_reminder_injector__',
  /**
   * Phase 3：用户批准 switch_mode 后于下一轮 iteration 0 注入的一次性 reminder。
   */
  MODE_TRANSITION_REMINDER: '__mode_transition_reminder__',
  /**
   * todo-state-injector hook 注入的每轮活跃待办快照。
   */
  TODO_STATE_INJECTION: '__todo_state_injector__',
  /**
   * relevant-recall-injector hook 注入的每轮相关能力召回块：
   * `<relevant_skills>` / `<relevant_mcp>` / `<relevant_cli>`。
   *
   * 原先这些块拼进 context-injector 的 `<context>` 消息、被  幂等闸门冻结
   * （整个 run 只注入一次）。为让召回随 in_progress todo 推进刷新，拆出独立
   * fresh 块：与 `CONTEXT_INJECTION` / `TODO_STATE_INJECTION` 对称，每轮 filter
   * 掉旧块再按当前召回内容重插；message-normalizer 用本 marker 归独立 kind
   * 防与相邻真用户输入合并。
   */
  RELEVANT_RECALL_INJECTION: '__relevant_recall_injector__',
  /**
   * end_turn 完成度 gate：仍有未完成 todo 时阻止 DONE 的 nudge。
   */
  TODO_COMPLETION_NUDGE: '__todo_completion_nudge__',
  /**
   * 项目规则自动加载（AGENTS.md MVP）：`rules-injector` hook 每轮 LLM 前从
   * 工作目录根部 `AGENTS.md` 读到内容，包成 `<project_rules>` user message
   * 注入 messages 最前。
   *
   * 与其他注入 marker 对称：message-normalizer 的 `classifyUserMessage` 用本
   * marker 把它归独立 kind（'project_rules'），跟相邻真用户输入不合并——否则
   * 重蹈 dogfood W4 P0（合成 user 漏 marker → 落 'other' → 被合并 → LLM 把
   * 项目规约误当用户当前请求的一部分）。
   */
  PROJECT_RULES_INJECTION: '__project_rules_injector__',
} as const;

export type InternalMessageMarker =
  (typeof INTERNAL_MESSAGE_MARKERS)[keyof typeof INTERNAL_MESSAGE_MARKERS];

/**
 * 判断 message 上是否带某个内部 marker。
 *
 * 通过 `unknown` 双层 cast 读 marker，避免污染 Message 类型签名，
 * 同时把"读取错误的 marker key"挪到编译期捕获。
 *
 * Returns true when the property is exactly `true`. Any other value
 * (undefined / false / non-bool) is treated as absent — this guards
 * against partially-serialised objects where the property survives
 * structurally but not its truthy semantics.
 */
export function hasInternalMarker(
  msg: Message,
  marker: InternalMessageMarker,
): boolean {
  const bag = msg as unknown as Record<string, unknown>;
  return bag[marker] === true;
}

/**
 * 给 message 打内部 marker（in-place 改写 + 返回原引用）。
 *
 * 调用方通常自己 spread 一份新对象再 set marker，确保不污染上游引用。
 * 提供这个 helper 是为了让"创建 + 标记"在调用点表达紧凑，避免每个 hook
 * 自己写 `(msg as unknown as Record<string, unknown>)[marker] = true`
 * 这种丑陋样板。
 */
export function setInternalMarker(
  msg: Message,
  marker: InternalMessageMarker,
): Message {
  (msg as unknown as Record<string, unknown>)[marker] = true;
  return msg;
}

/**
 * system prompt 的分块形式。不带 cache 字段 —— 显式 cache 断点由 proxy-provider
 * 的 applyExplicitCache 按 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 自动分配（PRD §5.5），
 * 上层无需也无法逐块标注。
 */
export interface SystemBlock {
  type: 'text';
  text: string;
}

export interface ToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ─── Message Normalization (FR-03) ───────────────────────────────────

/**
 * FR-03 消息规范化级别（类型定义住在 `types.ts` — 唯一真相源；实现
 * 与默认常量在 `engine/message-normalizer.ts`）。
 *
 * - `'off'`：跳过整个 normalize 流程（调试或紧急回滚）。
 * - `'conservative'`：默认级别；修复结构性非法（合并连续同角色、
 *   orphan tool_use/result 修复、thinking-only 过滤、空内容丢弃）。
 * - `'full'`：`conservative` 超集，额外做 whitespace-only assistant
 *   丢弃 + 末尾 assistant trailing-thinking 剥离。
 *
 * 所有字段级语义详情见 `message-normalizer.ts` 模块 docstring 和
 * `EngineConfig.normalizationLevel` 说明。
 */
export type NormalizationLevel = 'off' | 'conservative' | 'full';

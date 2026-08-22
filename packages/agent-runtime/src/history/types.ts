/**
 * 跨轮记忆 · 宿主无关的消息类型。
 *
 * 这些类型定义了"从持久化/内存消息源 → runtime initialMessages"这条链路上
 * 用到的中间形态和输入形态。任何宿主（Electron / Daemon / CLI / Web）只要
 * 能提供符合 HistorySourceMessage 接口的数据，就能复用全部装填逻辑。
 */

import type {
  ContentBlock,
} from '../engine/contracts/conversation.js';

/**
 * 装填后可直接注入 runtime `initialMessages` 的单条消息。
 *
 * 与 engine `Message` 形态对齐（`role` + `content`），但 content 在
 * MVP 阶段（纯文本历史）仍可为 `string`，引擎两种都接受。
 */
export interface RuntimeHistoryMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  sourceMessageId?: string;
}

/**
 * 宿主传入的原始消息——"窄接口"设计。
 *
 * 只描述 selectRecentHistoryForRuntime 真正读取的字段，不依赖
 * @tabtin/chat-client 的完整 ChatMessage，让 Daemon 可以从 Django API
 * 返回的 JSON 直接映射，无需引入 chat-client 包。
 */
export interface HistorySourceMessage {
  id: string;
  role: string;
  content?: string | null;
  message_kind?: string | null;
  metadata?: Record<string, unknown> | null;
  /** v2 消息块（blocks_json），assistant 的 tool_call 从这里展开。 */
  blocks_json?: HistoryMessageBlock[] | null;
}

/**
 * blocks_json 里单个 block 的窄视图。
 *
 * 只列出装填逻辑实际读取的字段，与 @tabtin/chat-client 的 MessageBlock
 * 兼容但不依赖。
 */
/**
 * 装填逻辑已知的 block type。新增 MessageBlockType 时需同步此处。
 * SYNC-CHECK: packages/tabtin-chat-client/src/types/message.ts → MessageBlockType
 */
export const KNOWN_HISTORY_BLOCK_TYPES = ['text', 'tool_call', 'tool_use', 'tool_result', 'thinking', 'metadata', 'rich_content', 'tabtin_rich_content'] as const;

/**
 * blocks_json 里单个 block 的窄视图。
 *
 * 只列出装填逻辑实际读取的字段，与 @tabtin/chat-client 的 MessageBlock
 * 兼容但不依赖。
 */
export interface HistoryMessageBlock {
  type: string;
  text?: string;
  kind?: string;
  summary?: string;
  group_id?: string;
  payload?: unknown;
  // 旧单块 tool_call 格式字段
  tool_call_id?: string;
  tool_name?: string;
  input?: unknown;
  output?: unknown;
  output_summary?: string;
  error?: boolean | string;
  // Anthropic content block 格式字段（tool_use / 独立 tool_result）
  id?: string;
  name?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface SelectRecentHistoryOptions {
  /**
   * 返回的最大原始消息条数（user+assistant 合计）。推荐 10。
   *
   * 展开 tool 链后生成的 RuntimeHistoryMessage 数量可能略多于此值
   *（每个带 tool_call 的 assistant 展开后多出一条合成 user）。
   */
  maxMessages: number;
  /**
   * 是否排除"本轮占位消息"。发消息时 UI 层先乐观 push 一条 temp-user-*
   * 占位，此时历史不应含本轮。
   */
  excludeCurrentTurn: boolean;
  /**
   * 可选：本轮 user 消息的 id。relay ACK 回来后 temp-id 可能已被替换成
   * server_id，传入具体 id 精确排除。
   */
  currentUserMessageId?: string;
  /**
   * 当前 session id。当 tool_call 的 output 被云端瘦身清理后，装填时生成
   * 引用路径指向本地 tool-logs 归档。
   */
  sessionId?: string;
  /**
   * 自动压缩持久化需要知道 runtime history 对应的 ChatMessage id。
   * 默认关闭，保持旧调用返回形态不变。
   */
  includeSourceMessageIds?: boolean;
  /**
   *  严格模式：`excludeCurrentTurn=true` 但漏传 `currentUserMessageId` 时
   * **fail-fast 抛错**，而非静默 `console.warn` + 不剔除本轮 user。
   *
   * 默认 `false`——保持现有 warn 兜底语义（`history.test.ts` 锁定用例：漏传 id
   * 时 warn + 本轮 user 仍被装填）。高保障主路径（如 Electron sendMessageAction）
   * 可显式开启，把"漏传本轮 user id"的契约漂移从"可能把用户刚发的话再送一遍
   * LLM"升级为"立即抛错、阻断本轮"，避免本轮 user 既进 history 又进
   * initialMessages 重复送 LLM。
   */
  strictCurrentTurn?: boolean;
  /**
   * 是否保留"含 tool_call 的 assistant 消息"的 thinking 块（跨轮 reasoning 回传）。
   *
   * 默认 false：thinking 一律丢弃（ 现状，见模块注释）。仅当目标模型的
   * ``reasoningHistoryPolicy === 'preserve_for_tools'``（DeepSeek V4 implicit thinking）
   * 时由调用方置 true——这类上游要求"发生过工具调用的 assistant，其 reasoning 必须在
   * 后续所有请求回传，否则 400"。保留后由 proxy-provider 的 convertAssistantMessage
   * 按 policy 决定是否真发上游（非 DeepSeek 仍 strip），故本开关对其它 provider 无副作用。
   * 非工具轮的 thinking 在本开关下仍丢弃（上游不要求、省 token）。
   * 若模型要求始终回传，请改用 ``preserveAllReasoningHistory``。
   */
  preserveReasoningForToolTurns?: boolean;
  /**
   * 是否保留**所有** assistant 消息的 thinking 块（Kimi K3 等保留式思考始终开启）。
   * 为 true 时忽略工具轮限制；与 ``preserveReasoningForToolTurns`` 可并存。
   */
  preserveAllReasoningHistory?: boolean;
}

export interface CrossTurnMemoryConfig {
  cross_turn_memory?: boolean;
  [key: string]: unknown;
}

/**
 * 默认保留的最大历史消息条数。调用方应引用此常量而非硬编码。
 *
 * ：**滑动窗口已禁用**（值 = `Infinity`）。
 *
 * 旧行为：固定取最后 10 条历史。问题——对话超 10 条后窗口每轮右移，`messages[0]`
 * 每轮指向不同历史消息，整条数组左移，prompt cache 前缀从 `[0]` 就断（与
 * context 注入位置无关的另一个独立前缀杀手）。env context 累积后窗口填满
 * 更快，问题更显。
 *
 * 新行为：前端 / 宿主不再按固定条数截断，把**全部历史**交给 runtime；超 context
 * window 的截断由 runtime `CompactionOrchestrator` 在 LLM 调用前按 token 预算处理
 * （reactive compact / summary / `compaction_summary` 检查点 / emergency）。这让历史
 * 前缀大部分轮次 byte-stable，只在偶尔触发 compaction 的那一轮断一次（按块滑动），
 * 而非每轮整体平移。
 *
 * 注：release 分支曾以 200 作有限安全网；#2099 经产品确认彻底禁用条数上限，截断完全
 * 交给 compaction（含上述 `compaction_summary` 检查点），不再保留条数兜底。
 *
 * 取值口径：
 *   - `selectRecentHistoryForRuntime`：`eligible.length <= Infinity` 恒真 → 不 slice；
 *   - 宿主 `.slice(-Infinity)`：start 归零 → 返回全量。
 */
export const DEFAULT_MAX_HISTORY_MESSAGES = Number.POSITIVE_INFINITY;

/**
 *  / ：绝不进入 LLM 历史的 message_kind 集合（SSoT）。
 *
 * - `hitl_interaction`：审批 / 追问的对话内持久化事实（前端面板据其 metadata.hitl
 *   状态开/清），对 LLM 无语义——历史装填时按本集合 skip。
 * - `system_prompt_context`：曾由 prelude 落库的 system prompt 审计副本
 *   （写路径已停）；本轮规则只走 `llmRequest.system`。旧会话行仍可能存在，故继续
 *   排除，避免跨轮以 user history 回灌。AdminDash 可读旧副本作导出回退。
 *
 * 注意与既有 kind 的区别：
 *   - `environment_context` 是「UI 隐藏但**故意**喂 LLM」（prompt cache 前缀），不在此列；
 *   - `agent_profile_context`同样喂 LLM，但装填时 keep-latest（只留最新一份），
 *     不在此列（全丢会让「未重新注入」的轮次模型看不到偏好）；
 *   - `compaction_summary` 走检查点专用逻辑（findLatestCompactionCheckpoint），也不并入。
 *
 * Django daemon 转发路径的对应过滤在 `prompt_forward_service._assemble_cross_turn_history`
 * 与 `context_assembler._RECOVERY_MESSAGE_KINDS`，与本集合保持同口径。
 * 本地 transcript 权威源见 `reconstructMessagesFromBlockRecords` /
 * `reconstructMessagesFromTranscriptEntries`。
 */
export const EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  'hitl_interaction',
  'system_prompt_context',
]);

/**
 * 单条 tool_result 注入历史时的字符上限。
 *
 * 跨轮记忆装填时，历史中的 tool output（如 read_file 返回的大文件、grep 的长结果）
 * 可能极长。此常量做 per-tool-result 的 hard cap，截断后附带尾注引导查阅
 * tool-logs 归档。
 *
 *  canonical result 契约：上限从 2000 提到 40_000——终端源头 inline 上限
 * 是 30KB stdout（shell.ts `STDOUT_INLINE_MAX_BYTES`），但装填的是完整 JSON
 * envelope（stdout 经转义 + status / exit_code / output_file 等字段），顶格
 * 结果序列化后会超过 30_000 字符；40_000 给 envelope 开销留余量，保证「产生
 * 时限长一次、装填原样复用」在最重的合法场景也成立（不把 envelope 尾部的
 * output_file 等取证字段截掉）。对照实测：Codex 单条工具响应上限约 4 万字符、
 * 单会话累计保留 35~46 万字符原始证据，缓存命中仍达 89~93%（前缀稳定比历史
 * 小更重要，见 ）。
 *
 * 整体水位由 CompactionOrchestrator 在运行时按 pressure 走 time-based MC /
 * LLM summary / emergency hard trim 处理；不做装填阶段事后改写历史。
 */
export const TOOL_RESULT_MAX_CHARS = 40_000;

/**
 * engine/contracts 第 4 层 —— 工具系统契约。
 *
 * Tool / ToolProvider / ToolContext / ToolResult（含 signals /
 * contextModifier）/ JsonSchema / ReadFileState / FileHistorySink /
 * RuntimeMode。
 *
 * 分层规则见 wire-protocol.ts 头注释；本层只允许 import
 * wire-protocol / conversation / model-llm。`ToolContext.interrupt` 指向
 * 第 5 层 hitl 的 InterruptPort——用 `import('./hitl.js')` 内联类型引用
 * （类型擦除、运行时零依赖），不引入反向顶层 import。
 */

import type { StreamEvent } from './wire-protocol.js';
import type { ContentBlock, Message, ToolResultBlock } from './conversation.js';

// ─── Tool System ────────────────────────────────────────────────────

/**
 * 单个文件的"上次 read 快照"。`edit_file` / `write_file` 在覆写已存在
 * 文件之前检查此条目用于 stale-read 校验（mtime 漂移且内容不同时拒绝），
 * 防止 LLM 用过时上下文覆盖外部刚改过的文件。
 *
 * stale-read 规则：
 *   - mtime 漂移且内容不同 → `error_kind=tool_stale_read`
 *   - mtime 抖动但内容相同（macOS iCloud / Windows AV）→ 放行
 *
 * **W2（2026-05-10）**：删除 `isPartialView` 字段。
 * TabTin 旧实现曾把它当作"是否 partial range read"使用，导致 dogfood
 * 死循环（partial read 后 edit 被拒）。partial vs full read 的区分靠
 * `(offset, limit)` 元组即可。
 *
 * 写入时机：
 *   - tabcode-adapter `read_file` 成功后写入（offset/limit 取自 LLM 入参）
 *   - tabcode-adapter `edit_file` / `write_file` 完成后 refreshSnapshot
 *     重读全文写入（offset=undefined / limit=undefined，重置为 full state）
 *
 * 检查时机：
 *   - tabcode-adapter `edit_file` execute 前（stale-read 校验）
 *   - tabcode-adapter `write_file` execute 前（仅当文件已存在）
 *   - tabcode-adapter `read_file` 入口处的 dedup（offset/limit/timestamp 全等）
 */
export interface ReadFileStateEntry {
  /** 上次 read 时的内容（CRLF 已 normalize 为 LF）。 */
  content: string;
  /** 文件 mtime（毫秒）。read 当时的快照，用于 stale-read 比对。 */
  timestamp: number;
  /** 本条目写入时间（Date.now()），用于 LRU 淘汰排序。 */
  readAt: number;
  /**
   * read 调用的 offset 入参（默认 1）。dedup 比对用——edit/write 后的
   * refreshSnapshot 不写此字段（保持 undefined，即 full state；dedup
   * 入口用 `offset === undefined` 判断"这是 edit 后的 entry，不要
   * dedup 上次 read 内容"）。
   */
  offset?: number;
  /** read 调用的 limit 入参。 */
  limit?: number;
}

/**
 * `ReadFileState` 跨工具状态：tool A 写、tool B 读。Map 键为绝对路径。
 *
 * 生命周期：由宿主在 `EngineConfig.readFileState` 注入；通常按 query
 * 生命周期 new Map() 即可——下一轮 query 重置。query.ts 会把它透传到每
 * 一次 `ToolContext.readFileState`。
 */
export type ReadFileState = Map<string, ReadFileStateEntry>;

/**
 * image dedup entry —— 反映"上次 read 这张图时的判等签名 + 文案上下文"。
 *
 * 实现与 LRU 在宿主业务工具包；类型留在内核契约，供 EngineConfig /
 * ToolContext 透传而不反向依赖宿主。
 */
export interface ImageDedupEntry {
  mtimeMs: number;
  sizeBytes: number;
  sha256: string;
  readAt: number;
  mediaType: string;
  base64Bytes: number;
  wasResized: boolean;
}

/**
 * localDoc dedup entry —— 反映"上次 read 这份 PDF / DOCX / XLSX 时的判等签名"。
 */
export interface LocalDocDedupEntry {
  mtimeMs: number;
  sizeBytes: number;
  sha256: string;
  readAt: number;
  mimeType: string;
  textBytes: number;
  pages?: number;
}

/** image / localDoc dedup 状态 Map；与文本 `ReadFileState` 物理隔离。 */
export type ImageReadFileState = Map<string, ImageDedupEntry>;
export type LocalDocReadFileState = Map<string, LocalDocDedupEntry>;

/**
 * per-file 回退引擎的最小接口（agent-runtime 不依赖具体实现，由 host 注入
 * `@tabtin/file-history-core` 的 FileHistoryService）。替代旧 shadow git checkpoint。
 * - `beginSnapshot`：一轮 Agent 开始时建立回退锚点（anchorId = agentRunId）。
 * - `trackEdit`：写文件工具执行前备份"改之前"内容（绝对路径）。备份归属到**指定
 *   anchorId** 的 snapshot（= 本轮 agentRunId），而非"最新 snapshot"——并发 /
 *   多 runtime / beginSnapshot 失败时都不会归错轮（见 file-history-core INV-6）。
 */
export interface FileHistorySink {
  beginSnapshot(anchorId: string): Promise<void>;
  trackEdit(anchorId: string, absPath: string): Promise<void>;
  /**
   * P2-5②（可选）：一轮 Agent 结束时强制把 snapshot 元数据落盘，**绕开 debounce
   * 窗口**——避免进程在窗口内退出导致最后一轮的回退账丢失。host 注入的
   * `FileHistoryService` 实现并返回健康状态；runtime 只 best-effort 调用、不消费
   * 返回值。未实现（旧 host / 测试 stub）时 run-end 不强制 flush，退化到 debounce
   * + host stop 兜底，不破坏旧路径。
   */
  flushNow?(): Promise<unknown>;
}

export type RuntimeMode = 'interactive' | 'solo' | 'scheduled' | 'batch';

export interface ToolInterruptPort {
  isAvailable(): boolean;
  isBatchAvailable(): boolean;
  interrupt<T = unknown>(req: unknown): Promise<{ status: 'resolved'; value: T } | { status: 'timeout'; message: string }>;
  interruptBatch(params: unknown): Promise<{
    batchId: string;
    decisions: Array<{
      requestId: string;
      toolCallId: string;
      outcome: 'allow' | 'deny' | 'cancelled';
      scope?: 'once' | 'thread' | 'always';
      rejectionMessage?: string;
    }>;
  }>;
  resumePending(args: unknown): Promise<{ toolResultBlocks: ToolResultBlock[] }>;
}

export interface ToolCallMetadata {
  /**
   * LLM 对本次工具调用目的的简短说明。它是 runtime 原生元数据，不属于任何
   * 单个工具的业务 input；orchestration 在 schema 校验 / judge / execute 前
   * 从顶层 input 剥离，并通过 ToolContext 与 lifecycle meta 透传。
   */
  intent?: string;
}

export interface ToolContext {
  /**
   * 业务对话 thread id（"用户在哪个 chat 里"）。跟 `host.sessions Map` 的 key
   * 同源。子 Agent 上此字段是父对话 id（ CLI / tab scope），**不再**兼
   * 后台完成通知路由。通知路由见 `notificationThreadId`。
   *
   * **不要**跟 `runtimeId`（runtime UUID）混。语义差异详见 §17.5 命名映射表
   */
  threadId: string;
  /**
   * 后台完成通知的 drain 路由键。
   * 主 Agent = `threadId`；子 Agent = `assistantSubagentRunId`（与
   * `drainSubagentNotifications(childId)` 对齐）。Shell 优先读本字段，
   * 缺省再按 `resolveToolNotificationThreadId` 回落 `threadId`。
   */
  notificationThreadId?: string;
  /**
   * 本次 Agent query / turn 的运行 ID。与 lifecycle.start.payload.run_id 同源，
   * 也是 ChatMessage.agent_run_id 和结构化资源 ChangeLog.agent_run_id 应使用
   * 的 per-turn 归因锚点。
   *
   * `threadId` 表示"在哪个对话里"，`agentRunId` 表示"这一次 Agent 回复"。
   * shell/CLI 子进程通过 TABTIN_AGENT_RUN_ID 透传该值，避免把对话维度 ID
   * 写入 ChangeLog 后导致 rollback_agent_run 查不到本轮资源变更。
   */
  agentRunId?: string;
  /**
   * Runtime 实例 UUID（`crypto.randomUUID()` 每次 `createRuntime` 生成）。
   * 仅用于 telemetry / trace / 进程内独立子系统的隔离命名（如
   * `persistLargeOutput` 文件名、`spacePaths.warnIfSessionUnscoped` 诊断日志）。
   *
   * **不要**当作"业务对话身份"使用——业务对话用 `threadId`。
   * §17.6 D4.c 拍板：`runQuery` 闭包参数 / `AgentRuntime.getRuntimeId()` /
   * 本字段名彻底无歧义。
   */
  runtimeId: string;
  /**
   * 当前这一层 Agent runtime 实际使用的模型。共享工具实例在多级子 Agent 中
   * 不能只看根 runtime 的静态配置；`agent` 工具用它实现“继承直接父 Agent”。
   * 可选以兼容旧宿主与手写测试 context。
   */
  model?: string;
  /**
   * 当前运行的交互档。`scheduled` 表示无人值守任务，面向用户的 ask 工具
   * 不能发 UI 卡片等待人工响应。
   *
   * 缺省视为 `interactive`，兼容未接入四态交互档的测试 / 旧宿主。
   */
  runtimeMode?: RuntimeMode;
  /**
   * 子 Agent 嵌套深度：主 Agent = 0，子 = 1，孙 = 2（"父子孙三级"上限）。
   *
   * **来源**：`EngineConfig.subagentDepth`（query.ts 构造 ToolContext 时透传）。
   * 主 host 缺省 0；`fork-query` 给子 runtime 的 `childEngineConfig.subagentDepth`
   * = 父深度 + 1。
   *
   * **消费者**：`agent` 工具（agent-tool.ts）—— fork 子 Agent 时按
   * `childDepth = (context.subagentDepth ?? 0) + 1` 判定是否给子 Agent `agent`
   * 工具：`childDepth >= MAX_SUBAGENT_DEPTH(2)` 时剔除（孙 Agent 拿不到 agent）。
   * 主防线是 none 继承（决策 1，agent-tool.ts execute 硬编码 inheritMode='none'）
   * 挡住父原文污染——子 Agent 不会被父任务带跑，三级嵌套可安全保留。结构性
   * 剔除 agent 工具是孙层兜底（dogfood ）。
   */
  subagentDepth?: number;
  /** 当前服务端任务的可信计费作用域，子 Agent 派生独立子作用域。 */
  billingIdempotencyScope?: string;
  /**
   * **WP0 收尾 + WP1（2026-05-13）**：当前 tool_use 的 LLM 唯一 ID（来自
   * Anthropic / OpenAI 的 `tool_use.id`，由 orchestration 按每 block 注入）。
   *
   * **透传链路**：
   *   - 生产路径：`query.ts` → `runTools` → `executeBatchParallel` /
   *     `executeSingleTool`，在 orchestration 内**按每个 block 覆盖**到
   *     `ToolContext` 上传给 `executeTool`（query.ts 主循环 / pre-start
   *     构造的 ToolContext 本身**不带**此字段——它是对话级别的，跨多 tool
   *     共用一份）。
   *   - pre-start 路径（query.ts 内 `executeTool(preStartCandidate, ...,
   *     preStartToolContext)`）也按 `chunk.toolUse.id` 覆盖一次，与主循环
   *     语义一致。
   *
   * **消费者**：当前唯一消费者是 ShellCap `run_terminal_command`——把它
   * 填进 `PtyManagerBridge.AgentCommandRequest.agentMeta.toolUseId`，让
   * PTY session 跟 LLM tool_use 关联（UI 标识 / 跨 Wave 审计 / debug）。
   * 其他工具暂不消费，但字段在 ToolContext 上是契约级承诺——orchestration
   * 始终透传，未来工具直接拿即可。
   *
   * **可选**：legacy 路径（不经 tool-orchestration 的旧测试）/ 单测 mock
   * context 可省略——字段 `?:` 而非必填。生产链路全部透传。
   *
   * **生产路径见 undefined 的契约**：消费者（如 ShellCap）若在生产链路
   * 见到 `context.toolUseId === undefined`，视为**orchestration 透传断层**
   * → 同步 throw 拒绝执行，不要降级为 threadId / 空字符串 / 自生 UUID。
   * agentMeta.toolUseId 是 PTY tab 标题 / agent-session-created 事件 / 审计
   * 落库的唯一锚点，背离会破坏"每步可追溯"产品价值。单测自己显式构造
   * `toolUseId: 'mock-tool-use'` 即可。
   */
  toolUseId?: string;
  /** 当前 tool_use 的 runtime 原生调用元数据。 */
  toolCallMetadata?: ToolCallMetadata;
  /**
   * （第一刀 · 补丁）：当前正在装配的 assistant 消息的稳定
   * `messageId`（== `AssistantResult.currentLLMMessageId`，由 loop.pushAssistantMessage
   * 时随 `EngineState.currentAssistantMessageId` 一起写入）。
   *
   * 用途：HITL 挂起前（ask-tools `emitAndWait` / LocalPermissionHandler 走
   * `hitl-persist.ts::persistCurrentAssistantForHitlResume`）以 `partial: true`
   * 抢先落库一次 assistant——crash mid-await 时 restore 回来 `state.messages`
   * 就带上 tool_use 块，restorer inject 的 tool_result 能与之配对，杜绝
   * `dropOrphanToolResults` 静默丢。
   *
   * 与 `toolUseId`（LLM 生成的 `tool_use.id`）无关；两者一起用：`toolUseId`
   * 让 restorer 用真实 pairing 键，`assistantMessageId` 让 partial 与 final
   * upsert 同一条 ChatMessage。缺省（旧宿主 / 测试 stub）时 partial persist
   * 走 no-op，退化为原路径的整轮 co-locate persist。
   */
  assistantMessageId?: string;
  /**
   * 当前 runtime 的 `EngineConfig.subagentRunId`（fork 的子 Agent 才有；
   * 主 Agent 缺省）。与 `assistantMessageId` 一起给 HITL 挂起前的 partial
   * persist 使用——`buildAssistantPersistEvent` 会在 payload 上带
   * `subagent_run_id`，partial 与 final 必须同源，否则 renderer 分片规则
   * 会把两次 upsert 拆到不同卡片。
   */
  assistantSubagentRunId?: string;
  /**
   * **字段保留作为相对路径解析基准**（不再参与权限判定，权限走
   * `workspaceSnapshot.allowedPaths`）。
   *
   * 单字符串 workspace 根目录。
   *
   * **语义**（路径权限治理 Wave 1 收紧）：仅作为「相对路径解析基准」，
   * **不再参与权限判定**。所有「这条路径在不在工作区里」的判断必须走
   * `workspaceSnapshot.allowedPaths`（多目录列表）—— 由 v3
   * `WorkspaceSnapshot` 单源派生，配合用户在 TabCode / TabFolder 实时
   * 打开的项目集合，单字符串无法表达多目录语义。
   *
   * 旧 single-string boundary 检查（`path.startsWith(workspaceRoot + sep)`）
   * 已从 `action-tools/tabcode/index.ts:checkFilePathSecurity` 移除——
   * 用户在 TabCode 临时打开 `/Users/x/dev/proj/` 但 `_workspace_root`
   * 仍是 sandbox 路径时，read 通了 write 撞 boundary 的 dogfood bug 由
   * 此根除。
   */
  workspaceRoot?: string;
  /**
   * 路径权限治理 Wave 1：工作区边界（`allowedPaths` / `allowedFiles`）。
   * 由 `query.ts` 从 `EngineConfig.toolRiskPolicy.resolveSnapshot()?.workspace`
   * 派生填入（ Stage 3）。
   *
   * `undefined` 时 adapter 退化为「没有显式工作区列表」——仅红线 + 敏感路径兜底。
   */
  workspaceSnapshot?: import('./tool-risk-policy.js').WorkspaceBoundary;
  /**
   * 路径权限治理 Wave 1：本次 tool 调用的权限上下文。
   *
   * `judgedDecision === 'allow'` 表示本次调用已经过 v3 `judge()` 管线
   * 决策（`workspace_in` / `memo_allow` / `yolo_allow` /
   * `workspace_out + 用户 once allow` 等任一路径放行），
   * adapter 注入到 action-tool payload 的 `_already_judged: true`，
   * `checkFilePathSecurity` 见到此信号即跳过 boundary 检查（信任
   * judge 决策，避免 single-string `_workspace_root` 与多目录
   * `allowedPaths` 双轨不通信导致的二次拦截）。
   *
   * 红线 + 敏感路径检查永远不跳过（深度防御），与 yolo 同语义。
   *
   * 设置时机：`tool-orchestration.ts` 在 `runJudgeFilter` /
   * `runEnforceFilter` 通过后构造 `executeContext`，对所有进入
   * `executeBatchParallel` / `executeSingleTool` 的 item 一次性透传。
   * 子 Agent fork 不透传此字段——子 Agent 自己重新走 judge 流程。
   */
  permissionContext?: {
    judgedDecision?: 'allow';
    /** Hilt v3 approvalKey（memo / scope 复用），可选透传给 adapter / action-tools 排错。 */
    approvalKey?: string;
  };
  abortSignal: AbortSignal;
  /** Accumulated messages up to current point */
  messages: Message[];
  /** Push a stream event to the renderer (injected by host). */
  emitStreamEvent?: (event: StreamEvent) => void;
  /**
   * Wave 2 envelope helper：让工具实现 emit 一条独立的 `tabtin_rich_content`
   * ContentBlock（content_block_start + 可选 content_block_delta + content_block_stop
   * 三件套），不需要工具自己拼 envelope 公共字段。
   *
   * 注入路径：`query.ts` 主循环构造 ToolContext 时通过 `EnvelopeEmitter.emitInlineBlock`
   * 包装一层。`emitStreamEvent` 当前仍注入是给工具发其它 stream event（譬如
   * lifecycle / system_notice 等）；本 helper 是工具产出富内容的**唯一**入口
   * （W4.5 第二波 B2 删 `StreamEvents.RICH_CONTENT` 协议事件后，富内容路径
   * 统一走本 helper → daemon detached mini-message → reassembler 落库到
   * ChatMessage.content_blocks_json）。
   *
   * 参数：
   *   - `kind` / `summary` / `payload` 对应 `TabTinRichContentBlockSchema` 字段
   *     （`payload` 包含工具 specific 数据，如 search_results / table rows / file path）
   *   - `groupId` 用于把同 group 内多条 rich_content 关联起来（tabcode adapter 多 widget）
   *
   * **不"假流式切片"**：rich_content block 一次性给完整 payload；本 helper 只 emit
   * start + stop（不 emit delta），让消费方按 block_id 一次性渲染卡片。
   */
  emitRichContentBlock?: (args: {
    kind:
      | 'image'
      | 'table_preview'
      | 'resource_ref'
      | 'file'
      | 'widget'
      | 'cli_output_table'
      | 'cli_output_record'
      | 'search_results'
      | 'memory_card'
      | 'document_excerpt'
      | 'task_episode'
      | 'plan';
    summary: string;
    groupId?: string;
    payload?: Record<string, unknown>;
  }) => void;
  /**
   * @deprecated  批次 5 起工具侧 HITL 走 `interrupt` 单原语；本字段仅
   * 作为宿主原语透传保留（LocalPermissionHandler / 子 Agent 包装仍消费）。
   */
  waitForUserInput?: (requestId: string) => Promise<unknown>;
  /**
   * HITL 单原语（`QueryDeps.interrupt`，主循环构造 ToolContext 时注入）：
   * ask 三件套 / switch_mode 的「emit 卡片 + 挂起等人 + 超时」统一走这里。
   */
  interrupt?: ToolInterruptPort;
  /**
   * Phase 3：true = 无 UI 宿主（Daemon headless）；`switch_mode` 等需客户端审批
   * 的工具返回 `requires_client_approval`。
   */
  isHeadlessHost?: boolean;

  /**
   * Wave 1.5（Skill 运行时密钥注入）：当前 Agent 正在执行的 Skill 上下文。
   *
   * 由 `skill_invoke` 工具返回 `contextModifier.activeSkill` 设置，
   * `query.ts` 写入 `state.__activeSkillKey`，随后每次构造 `ToolContext`
   * 都会把 `state.__activeSkillKey` + `effectiveSpaceId` 组合进来。
   *
   * 主要消费者：`capability/core/shell.ts` —— run_terminal_command 执行前若见到
   * `skillContext` 就走凭据解析器派生密钥 env 并注入到子进程。
   *
   * 生命周期（Wave 1.5 PROD-4 拍板，2026-04-24）：
   * - `skill_invoke` 展开 Skill 后 activeSkill 被写入，本上下文持续生效，
   *   **直到**：(a) 下一次 `skill_invoke` 覆盖为新 Skill；(b) 当前会话结束
   *   （state 被释放，skillContext 随之消失）。
   * - **包括 Skill body 结束后、没有 skill_invoke 的裸 run_terminal_command 命令也会继承**
   *   同一 skillContext——即 Agent 在执行完 Skill 后继续跟用户对话、做
   *   延伸命令（如某 Skill 完成主操作后再跑同一 CLI 的 list 子命令确认），
   *   这些命令仍会注入该 Skill 绑定的密钥。
   * - 设计意图：Agent 常在 Skill 执行后做验证 / 查询 / 补操作，这些延伸
   *   命令通常需要**同一把密钥**；若自动在 Skill body 结束时清空，Agent
   *   下一条命令就会因 env 缺失而失败，用户体感"同一个 Skill 有时能跑
   *   有时不能"，反而更混乱。
   * - **不**会因为任一轮普通 run_terminal_command 调用自动清空（同一 Skill 内连续多轮
   *   子命令需要持续注入密钥，清空会破坏语义）。
   */
  skillContext?: {
    /** 当前 Skill 的 canonical key（如 `user:<skill-name>`）。 */
    skillKey: string;
    /**
     * 可选：Skill frontmatter 里的 `primary_env` 字段。如果宿主能在
     * `skill_invoke` 执行时拿到它（如 LocalSkillRegistry 已解析 meta），
     * 转发到这里；后端派生单密钥 env 时作为兜底 hint 使用。缺省时
     * 后端仅靠 `service_name` 映射表派生，不会报错——只是未知服务名
     * 会 422 需要显式配置。
     */
    primaryEnv?: string;
  };

  /**
   * read-before-edit 跨工具共享状态。`read_file` 执行成功
   * 后写入；`edit_file` / `write_file`（覆写）执行前检查。
   *
   * 由 `EngineConfig.readFileState` 注入到每一次 ToolContext，跨 turn 同
   * 一 query 内共享同一 Map 引用。详见 `ReadFileStateEntry` docstring。
   *
   * `undefined` 时各工具按"未启用 read-before-edit 加固"行为处理（旧测
   * 试 / 早期宿主），保持向后兼容。
   */
  readFileState?: ReadFileState;
  /**
   * per-file 回退引擎（替代 shadow git）。写文件工具在写盘前调 `trackEdit`
   * 备份改前内容；`undefined` 时 track no-op，不破坏旧 host。
   */
  fileHistory?: FileHistorySink;
  /**
   * **本轮顶层对话锚点**（= 顶层 agent run 的 `agentRunId`）。
   *
   * 一个「对话轮」（用户发一条消息 → Agent 一轮回复，含它 fork 的所有子 / 孙
   * agent）共用一个 anchorId。子 agent fork 时**继承父的 anchorId**，不另建自己的
   * anchor——子改的文件归到父轮锚点，回退父轮会一并恢复子改动（§3.9 规则 2）。
   *
   * 与 `agentRunId` 的关系：`agentRunId` 是**本 runtime** 的 runId（用于 ChangeLog
   * 等 per-runtime 归因，子 runtime 有自己的 runId）；`fileHistoryAnchorId` 是**对话
   * 轮**锚点（顶层 runId，全链路透传给后代）。顶层 query 二者相等；子 runtime 里
   * `agentRunId`=子 runId、`fileHistoryAnchorId`=父轮 runId。
   *
   * 由 `query.ts` 构造 ToolContext 时填入（`config.fileHistoryAnchorId ?? runId`）。
   * 工具层 `tabcode-adapter.ts` 的 trackEdit 用 `ctx.fileHistoryAnchorId ?? ctx.agentRunId`。
   * `undefined`（legacy 测试 / 未注入）时回落 `agentRunId`，与旧行为一致。
   */
  fileHistoryAnchorId?: string;
  /**
   * **W2（2026-05-13）**：image dedup 状态。反复 `read_file` 同一张图时
   * 命中后返 system-reminder stub（不再重复塞 base64 ImageBlock 进 history），
   * 长会话不再 token 复利炸。
   *
   * **跨 Wave 不变量 #6**：与 `readFileState`（文本 / 25MB byte budget）
   * 物理隔离的独立 Map + 独立 50MB byte budget；不扩 `ReadFileStateEntry`
   * schema。详见 `binary-dedup-state.ts` jsdoc。
   *
   * 由宿主在 `createRuntimeForSession` 时 `new Map()` 注入；`undefined`
   * 时 image dedup 不启用，行为退化为旧版每次重塞 base64（兼容旧测试 /
   * 临时性 host）。Electron / Daemon 两端 host 默认注入。
   */
  imageReadFileState?: ImageReadFileState;
  /**
   * **W2（2026-05-13）**：localDoc dedup 状态。反复 `read_file` 同一份
   * PDF / DOCX / XLSX 时命中后返 system-reminder stub（不再重复塞解析后
   * 的全文进 tool_result）。
   *
   * **跨 Wave 不变量 #6**：与 `readFileState` 物理隔离的独立 Map + 独立
   * 50MB byte budget；不扩 `ReadFileStateEntry` schema。详见宿主侧
   * binary-dedup-state 实现。
   *
   * 由宿主注入；`undefined` 时 localDoc dedup 不启用。
   */
  localDocReadFileState?: LocalDocReadFileState;
}

/**
 * 工具结果**结构化 signals 通道**（FR-12）。Tool 写者通过 `signals` 表达
 * "我希望引擎做什么"，而非把指令编码在 `content` JSON 里——后者每个消费者
 * 都得 grep 字段名，前后不兼容、容易漂移。
 *
 * `query.ts` 在每轮 ReAct loop 工具结果扫描阶段读 signals。H3 阶段已清退
 * 所有 JSON fallback (`__end_conversation__` / `_pending_condense` /
 * `_pending_tool_activations`) —— signals 是唯一入口。
 *
 * | 字段 | 引擎行为 |
 * |---|---|
 * | `endConversation: { reason }` | 结束本次 query，走 SYSTEM_NOTICE + DONE |
 * | `pendingCondense: { context }` | 下一轮 reactive compact，把 context 作为 summary 注入 |
 * | `suspendRun: { reason, pendingSubagentIds }` | 非错误结束当前 query，等待后台完成通知重新激活 |
 *
 * **canonical 范例**：
 * - Skill 激活 → `packages/agent-runtime/src/skills/skill-activation.ts`
 *
 * W3 (2026-05-10): the original `summarize_context` example was removed
 * along with the tool itself. `pendingCondense` is preserved as an
 * extension-point channel — any future tool can opt into the reactive
 * compact pipeline by emitting `signals.pendingCondense.context`, but no
 * built-in tool uses it after W3.
 */
export interface ToolResultSignals {
  /**
   * 工具请求引擎结束本次 query（emit SYSTEM_NOTICE + DONE，附 reason）。
   *
   * 当前没有内置工具会写这个 signal —— 历史使用方 `terminate_conversation`
   * 已下架。入口保留是因为它是引擎契约的一部分：未来引擎级工具（例如安全
   * 审批层、token 预算守卫）可能需要主动终止 query，比每次新加这种工具
   * 时再扩 signal shape 更便宜。
   */
  endConversation?: { reason: string };
  pendingCondense?: { context: string };
  /**
   * 后台任务等待屏障：结束当前 query，但不把任务标成失败或最终完成。
   *
   * 当前唯一生产者是 `agent(wait_agent_ids=...)`。子任务全部进入终态后，
   * SubagentManager 会把聚合完成通知投进 NotificationQueue，由现有 idle drain
   * 重新激活父 Agent。这里不承载等待逻辑，只表达运行时控制意图。
   */
  suspendRun?: {
    reason: 'awaiting_subagents';
    pendingSubagentIds: string[];
    /**
     * 内部回滚句柄：若同批 `endConversation`、hard-stop 或后处理异常让本次
     * query 没有真正进入 suspended DONE，引擎必须调用它撤销已登记屏障。
     *
     * 该函数不进入 wire / 持久化协议，只在本轮 `ToolExecutionResult` 内存态流转。
     */
    onDiscard?: () => void;
  };
}

/**
 * Wave 2a: runtime context modifications that a tool can request via
 * `ToolResult.contextModifier`. Applied by `query.ts` after
 * `newMessages` injection.
 *
 * **Current consumption status**:
 * - `modelOverride`: **active** — immediately writes `state.model` and
 *   recalibrates `tokenEstimator`.
 * - `allowedTools`: **reserved** — written to `state.__allowedToolsOverride`
 *   for consumption by Wave 2b `skill_invoke` + permission layer. No
 *   runtime reader exists yet; the field is safe to populate but has no
 *   effect until the permission path is wired.
 * - `effortOverride`: **reserved** — written to `state.__effortOverride`
 *   for consumption by the LLM request builder when effort-aware
 *   providers are supported. No runtime reader exists yet.
 */
export interface ToolResultContextModifier {
  /** Tool names to add to the session's permission allow-list. */
  allowedTools?: string[];
  /** Switch the LLM model for subsequent iterations in this run. */
  modelOverride?: string;
  /**
   *  — Switch the agent mode for subsequent iterations **in this run**.
   *
   * Set by `switch_mode` after the user approves the HITL proposal. By the time
   * this is applied, the host has already reconfigured the live runtime for the
   * new mode (toolProvider toolset + system prompt + ShellCap restricted-shell
   * checker + policy context). `query.ts` consumes this by **re-reading**
   * `config.tools.getTools()` + `config.systemPrompt` and rebuilding the
   * turn-local `toolParams` / `toolMap` / `toolRegistry` / base system prompt,
   * so the same turn continues under the new mode — no new turn, no injected
   * user message. Value is the target `AgentModeName` (kept as string here to
   * avoid an engine→agent-modes dependency).
   */
  modeOverride?: string;
  /** Adjust thinking effort level for subsequent LLM calls. */
  effortOverride?: 'low' | 'medium' | 'high';
  /**
   * Wave 1.5 — mark the current Skill as "active" so downstream `run_terminal_command` (and
   * any future tool consumer) can resolve Skill-bound credentials for env
   * injection. Set by `skill_invoke`; cleared only by a subsequent
   * `activeSkill` override (not automatically after N turns).
   *
   * Pass `null` to explicitly clear the current binding (reserved for
   * future use—no tool currently emits a clear). Field is read by
   * `query.ts` into `state.__activeSkillKey` + `state.__activeSkillPrimaryEnv`
   * and then propagated into each newly constructed `ToolContext.skillContext`.
   */
  activeSkill?: { skillKey: string; primaryEnv?: string } | null;
}

export interface ToolResult {
  content: string | ContentBlock[];
  isError?: boolean;
  /**
   * 本次结果的展示语义。只写 canonical transcript / lifecycle，不进入 LLM
   * tool_result，供历史回放与实时流消费同一份 UI 契约。
   */
  presentation?: ToolPresentation;
  /**
   * Optional compact replacement used only when the result is fed back into
   * the next LLM call. The canonical `content` remains available to runtime
   * callers, stream events, logs, and explicit debug/evidence inspection.
   */
  llmContextContent?: string | ContentBlock[];
  /** Strip these keys from the JSON result before sending to LLM */
  llmStripKeys?: string[];
  /**
   * 瞬态、非-LLM-facing 的宿主元数据——**任何工具**都可附带给 host 注册的
   * `afterToolResult` hook 消费的结构化数据（不带业务语义；具体形状由工具与
   * 其消费 hook 约定）。
   *
   * 契约：
   * - **不进 LLM**：主循环构造 tool_result block 时只取 `content` /
   *   `llmContextContent`，不读本字段（见 `tool-policies.ts::buildToolResultBlockSets`）。
   * - **不落库**：本字段不进 persist 事件；消费方 hook 处理完**必须置空**
   *   （`result.hostMetadata = undefined`），杜绝大体量原文（如完整 stdout）
   *   经其它序列化路径泄漏。
   * - **瞬态**：只在「工具执行 → afterToolResult」这一跳内有效，engine 主
   *   循环不读、不透传、不持久化。
   */
  hostMetadata?: Record<string, unknown>;
  /**
   * Structured signals for engine-level side effects. Preferred over
   * embedding signals in content JSON—see `ToolResultSignals` docstring
   * for migration notes; canonical example is `skill_invoke` (W3 removed
   * the prior `summarize_context` example along with that tool).
   */
  signals?: ToolResultSignals;

  /**
   * Messages to inject into the conversation history after the normal
   * `tool_result` message has been constructed.
   *
   * Primary consumer: `skill_invoke` — expands a SKILL.md into one or more
   * `role: 'user'` messages so the LLM treats the skill content as a user
   * instruction (RLHF compliance) rather than a tool observation it may
   * choose to ignore.
   *
   * Processing order in `query.ts`:
   *   1. Normal `tool_result` message is pushed (preserves Anthropic/OpenAI
   *      tool_use ↔ tool_result pairing — breaking this causes API 400).
   *   2. `newMessages` are appended immediately after.
   *   3. `contextPressure` is recalculated to prevent 187K token blowups
   *      (F3 budget guard).
   *
   * Classifies API errors for `SkillTool.call()` → `returns.newMessages`.
   */
  newMessages?: Message[];

  /**
   * Runtime context modifications applied after `newMessages` injection.
   *
   * Allows a tool (primarily `skill_invoke`) to alter the engine's runtime
   * behavior for subsequent iterations without changing the Tool.execute
   * signature to AsyncGenerator.
   *
   * Classifies API errors for `SkillTool.call()` → `returns.contextModifier`.
   * See `ToolResultContextModifier` for per-field semantics.
   */
  contextModifier?: ToolResultContextModifier;

  // ── M1 W1.1 新增（字段占位）；M6 实装行为 ───────────────────────────
  //
  // Guardrail 软替换：当 HITLCap / GuardrailCap 拦截 tool 的输入 / 输出
  // 时，可以返回 `rejectedContent` 作为**替代**给 LLM 的内容——模型看到
  // 这段内容而不是原始 tool 结果，但把工具调用视为"成功"（不进 error
  // 路径）。
  //
  // 区别于 `isError: true`：
  //   - `isError: true`            → 工具失败 / 权限拒绝 → 模型应重试或换路
  //   - `rejectedContent: [...]`   → 工具执行成功但内容被软替换 → 模型按
  //                                    替代内容继续
  //
  // 典型场景：
  //   - PII 扫描命中 → 把含用户银行卡号的 tool_result 替换为"敏感信息已过滤"
  //   - 合规 guardrail → 医疗建议输出被替换为"需人工审核"
  //
  // **M1 仅占位**——runtime 识别 + 回灌行为由 M6 实装：
  //   - runTools 看到此字段后，把 `rejectedContent` 作为 tool_result.content
  //     回灌给 LLM（而非 `content`）
  //   - `isError` 默认 false（若 Capability 显式 set true 则走 error 路径）
  //   - AuditCap.on_tool_rejected hook 记录审计
  //
  // 详M1 §3.8 + 总控 Part 10.6 M6 Charter §6.4。
  /** Guardrail 软替换：替代给 LLM 的内容。M1 仅占位字段，M6 实装行为。 */
  rejectedContent?: ContentBlock[];
  /** 软替换的原因说明（审计用，不给 LLM 看）。M1 仅占位字段。 */
  rejectedReason?: string;
}

/** JSON Schema object describing a tool's input parameters. */
export type JsonSchema = Record<string, unknown>;

/**
 * 非 LLM-facing 的工具展示语义。
 *
 * 工具/宿主在执行侧根据结构化输入解析一次，生命周期事件再把它透传给客户端。
 * Renderer 只能按 `kind` 选择专属 UI，不应从 command / output 文本反推业务意图。
 */
export interface ToolPresentation {
  kind: string;
  data?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  /**
   * JSON Schema (Draft-07 subset) describing tool input.
   *
   * **Runtime validation is enforced** by `validateToolInput`
   * (`tool-schema-validator.ts`) when `EngineConfig.toolSchemaValidation`
   * is `'warn'` (default) or `'strict'` — see FR-07. The supported
   * subset covers `type` / `properties` / `required` / `enum` /
   * `format` (allowlisted: `web-search-freshness` only) / `items` /
   * `minItems` / `maxItems` / `minimum` / `maximum` /
   * `additionalProperties`. Arbitrary JSON Schema `pattern` is never
   * compiled or executed. Unknown `format` values fail as `unsupported`.
   * Higher-level constructs (`$ref`, `oneOf`, …) are not implemented —
   * extend the validator first if a tool needs them.
   */
  inputSchema: JsonSchema;
  /**
   * 从本次工具输入派生展示语义。
   *
   * 这是执行协议的一部分，不暴露给模型，也不参与工具 schema 校验。解析失败
   * 必须返回 undefined；engine 会把 resolver 异常降级为无专属展示，绝不影响执行。
   */
  resolvePresentation?: (input: unknown) => ToolPresentation | undefined;
  /**
   * Read-only tools run in parallel; write tools run sequentially.
   * Safe reads run in parallel; unsafe writes run serially.
   */
  isReadOnly: boolean;
  /**
   * Product registration risk level (`safe` / `review` / `strict`), aligned with
   * Django BaseTool.risk_level and action-tools manifest. HITL wire events use
   * `low` / `medium` / `high` — map via `@tabtin/agent-wire` `inferWireRiskLevelFromTool`.
   */
  riskLevel?: 'safe' | 'review' | 'strict';
  /**
   * Non-readOnly tools that are still safe to run concurrently (e.g. agent tool
   * which forks independent sub-queries). Checked by tool-orchestration alongside
   * isReadOnly and command heuristics.
   */
  concurrencySafe?: boolean;
  /**
   * Per-input dynamic concurrency check (T-P1-5, follows our
   * `isConcurrencySafe(input)`). When provided, tool-orchestration calls this
   * BEFORE falling back to the static `isReadOnly` / `concurrencySafe` / command
   * heuristic chain. Return `true` to allow parallel execution for this specific
   * input, `false` to force serial.
   *
   * Typical use: `run_terminal_command` inspecting `input.command` with a proper parser
   * (shell-quote) instead of a regex, or a file-write tool checking whether
   * two calls target different paths.
   *
   * Tools that don't implement this field get the existing default logic.
   */
  isConcurrencySafe?: (input: unknown) => boolean;
  /** Optional write-op classifier for judge memo / batch grouping (tool-orchestration). */
  isWriteOp?: (input: unknown) => boolean;
  /**
   * （原名 `highRisk`，2026-07-15 改名）：`true` = 本工具即便 `isReadOnly`
   * 也**不能走** `query.ts` 的 pre-start 只读快路径，必须完整经过 permission
   * 管线（L34 H2-B）。
   *
   * 典型场景：工具输出是**不可信外部内容**（`web_search` / `parse_document` /
   * `mcp_call_tool` 连任意服务器）——虽然只读，但不应绕过权限判定提前执行。
   *
   * 改名原因：旧名 `highRisk` 与审批风险档（`riskLevel: safe/review/strict`）
   * 极易混淆——它从来不是审批等级。W3 (2026-05-10) 起 fence 包裹改为按工具名
   * 显式 allow-list（见 `tool-output-sanitizer.ts`），本字段只管 pre-start。
   * telemetry 键 `high_risk` / `tool.prestart_blocked_high_risk` 保持原名，
   * 避免仪表盘断档。
   */
  disablePreStart?: boolean;
  /**
   * T-P1-3: per-tool result size cap (characters). When a single tool result
   * exceeds this limit, `enforceToolOutputBudget` truncates it and persists
   * the full content to `ToolResultStorage` before applying the global budget.
   *
   * `undefined` or `Infinity` means no per-tool cap — the result only goes
   * through the global per-round budget (150 k default). Tools that routinely
   * produce large output (browser-surface content, rag_search) should
   * declare an explicit cap so results get persisted early instead of
   * accumulating until the global budget fires.
   */
  maxResultSizeChars?: number;
  /**
   * Optional execution timeout for this tool.
   *
   * The orchestration layer has a conservative fallback timeout for ordinary
   * tools, but long-running tools such as shell commands and user interaction
   * must own their own timing contract. Returning `0` or a negative value means
   * "do not wrap this tool with the generic timeout".
   */
  executionTimeoutMs?: number | ((input: unknown) => number | undefined);
  /**
   * Hilt v3: 从工具输入中提取归一化参数（command / file_path / path 等）。
   * judge() 在 extractPath / extractSubcmd 等回调里读返回字典；未声明时由
   * 默认提取逻辑（读 command / file_path / path / cwd）兜底。
   */
  extractPolicyParams?: (input: unknown) => Record<string, unknown>;
  /**
   * v3 judge 路径钩子。file 类优先于 extractPolicyParams。
   * 可返回相对路径；orchestration 会按 workspaceRoot 收成绝对路径。
   */
  extractPath?: (input: unknown) => string | readonly string[] | undefined;
  /**
   * Hilt v3: 工具的策略动作分类。judge() 按此字段决定走哪条判决路径。
   * 未声明时默认 'object'（保守：不走工作区，yolo 关时 ask）。
   */
  policyActionKind?: string;
  /**
   * Hilt v3: device 类工具的风险等级。observe = 始终 allow，interact = yolo 关时 ask。
   */
  deviceActionRisk?: 'observe' | 'interact';
  /**
   * W2-轮 1（PRD 05 v0.4 §6.5 / §8.5）：返回用于审批 memoization 的归一化 key。
   *
   * - 由 Layer 4 Memoization 调用，构造 `{ns}::{tool_name.toLowerCase()}::{key}`
   *   作为 ``ApprovalMemoStore`` 的查询键。
   * - 返回 ``null`` 表示本次调用不适合 memoize（敏感入参 / 一次性操作）；
   *   返回 ``{ key }`` 表示参与 memo（可选 ``ttlHint`` 给将来 LRU 用）。
   * - 缺省（不声明此函数）时 Layer 4 用 ``stableJsonStringify(input)`` 兜底。
   *
   * 典型实现（PRD §6.5 范例）：
   * - run_terminal_command / shell：归一化命令（剥参数只留 argv0 + 关键选项模式），否则
   *   ``npm install express`` 与 ``npm install lodash`` 会被认作不同
   * - write_file：``file_path``（同一 path 的所有写入共用授权）
   * - sql.execute：DML 关键字 + table（不 memoize 具体 WHERE）
   */
  getApprovalKey?: (input: unknown) => { key: string; ttlHint?: number } | null;
  /**
   * W2-轮 1（PRD 05 v0.4 §6.5 / §8.5）：MCP / 子 Agent 工具加 namespace，
   * 防止不同 namespace 同名工具的 memo key 串台。空 / undefined 视为顶层。
   */
  toolNamespace?: string;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface ToolProvider {
  getTools(): Tool[];
  /** Optional: refresh tools mid-conversation (e.g., after MCP reconnect) */
  refreshTools?(): Promise<void>;
}

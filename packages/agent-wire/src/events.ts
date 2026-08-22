/**
 * Canonical event type constants for Agent runtime communication.
 *
 * **协议层归零进度（Wave 1 起协议双轨，W4.5 第三波 C1 收尾）**
 *
 * 截至 2026-05-13（W4.5 第三波 C1），本文件**只承载新协议**：
 *
 * 1. **新协议（Anthropic Messages API 风，唯一活路径）**：
 *    - `ContentBlockEvents.MESSAGE_START / MESSAGE_DELTA / MESSAGE_STOP`
 *      `CONTENT_BLOCK_START / CONTENT_BLOCK_DELTA / CONTENT_BLOCK_STOP`
 *    - 命名空间 `agent.stream.message.*` / `agent.stream.content_block.*`
 *    - Schema 定义见 `stream-content-block.ts`
 *
 * 2. **W4.5 第三波 C1 物理删除（2026-05-13）**：以下 9 个老 `StreamEvents.*`
 *    常量已彻底下线，daemon emit / Renderer listener / Django relay 白名单 /
 *    iOS / Android case 同步清空：
 *      - `ASSISTANT` / `REASONING` / `TOOL` / `CHUNK` / `REVIEW_REQUIRED`
 *      - `TOOL_TIMEOUT` / `TOOL_HEARTBEAT` / `CONTENT_RESET` / `TOOL_CALL_ARGS_DELTA`
 *    保留的"业务命名"字面量（不混淆）：
 *      (a) lite-blocks-collector.ts 仍用字面量 `'agent.stream.assistant'` inject
 *          一条兼容事件给 Django relay 走 `_write_chat_messages` 落库（W4a 临时桥，
 *          `@cleanup-after W4c-Django-reconstructor`）。Django 端 `AgentStreamEvent.ASSISTANT`
 *          短名常量 + `RELAY_ALLOWED_SHORT_NAMES` 中的 `assistant` 同步保留供桥使用。
 *      (b) sse-adapter.ts 仍把 `agent.stream.assistant(phase='final')` 映射到 SSE
 *          `text_done`，覆盖 lite-collector inject 出来的事件——CLI 路径仍要消费它。
 *
 * 3. **W4.5 第二波 B2 物理删除（2026-05-12）**：`RICH_CONTENT` 常量已下线——
 *    daemon 0 处真 emit `agent.stream.rich_content`，统一走 ContentBlock
 *    `tabtin_rich_content` 路径（schema 见 `stream-content-block.ts::
 *    TabTinRichContentBlockSchema`）。
 *
 * 4. **`STEP` 老协议常量保留**（C1 范围外）：daemon `query.ts:2896, 3633` 仍 yield
 *    `StreamEvents.STEP`（thinking 步骤"开始/结束"信号），W5 / W6 mobile 仍消费
 *    本事件渲染 thinking 步骤卡片。这两处 yield 属 daemon 业务逻辑，C1 不动；
 *    W5/W6 接 6 件套 + 移除 mobile handleStep 后，再做下一轮 daemon STEP yield
 *    清理。
 *
 * 后续新增协议事件请直接走新协议；老协议常量已不再添加。
 *
 * Five namespaces:
 *  - agent.stream.*    : Daemon/Electron host → Backend → Frontend
 *                        （设备端本地 runtime 经 relay_events 批量回传，
 *                        Backend 落库后按 agent.stream.{thread_id} topic 广播；
 *                        per-turn streaming events）
 *  - agent.session.*   : Backend → Frontend (session-level async events that
 *                        may arrive after agent.stream.done; bound to
 *                        agent.session.{session_id} topic with lifecycle
 *                        tied to ChatSession activation rather than stream slot)
 *  - agent.user.*      : Backend → Frontend (用户级广播事件，扇出对象是
 *                        登录用户本身——通过 channel layer group `user.{user_id}`
 *                        投递，**不绑 topic 订阅**；客户端 auth.ok 时已自动加入
 *                        该 group，无需 syncSubscriptions。该通道只负责实时提醒；
 *                        断网/离线/晚进入恢复必须依赖对应 REST 事实源
 *                        （例如 pending interactions）。
 *                        典型事件：标题更新 / 通知 / 权限变更——这些事件的
 *                        逻辑接收者是「用户」，而非某条 stream / session）
 *  - agent.prompt.*    : Backend → Daemon/Electron (commands / control)
 *  - agent.permission.*: Backend → Daemon/Electron (设备/Daemon 侧权限应答；
 *                        与 `agent.user.permission.changed` 区分——后者是
 *                        前端缓存刷新信号，前者是 Daemon 收到的具体权限决策)
 *
 * 易混淆的近义命名：
 *  - `StreamEvents.USER = 'agent.stream.user'`：单轮 stream 内的「用户消息」事件，
 *    跟 thread_id 绑定，跟 `UserEvents`（用户级广播）**不是同一回事**。如果不
 *    确定该用哪个，问"这条消息丢了用户感知到的损失是什么"——丢了某轮上下文
 *    用 stream，丢了一个跨会话/跨设备的状态用 user。
 *
 * 历史命名说明：曾存在 `agent.external.*` → `agent.runtime.*` 命名空间，承载
 * 已移除的外部 Agent 桥接原始事件。该桥接接入线 2026-Q2 砍掉、从未上线；
 * 2026-05 彻底清理时整条 `agent.runtime.*` 协议一并删除——设备端本地
 * runtime 的流式事件统一走 `agent.stream.*`（relay_events 批量回传），
 * prompt.forward 失败兜底也复用同一条 `agent.stream.done(error)` 路径。
 */

import { z } from 'zod';

// ─── Stream Events (Backend → Frontend) ─────────────────────────────

export const StreamEvents = {
  LIFECYCLE: 'agent.stream.lifecycle',
  // ── W4.5 第三波 C1 物理删除（2026-05-13）──
  // 删除：ASSISTANT / REASONING / TOOL / CHUNK / REVIEW_REQUIRED
  // 详见文件顶部 docblock 第 2 节"W4.5 第三波 C1 物理删除"+ 跨包 consumer
  // 同步清单。lite-blocks-collector.ts 用字面量 `'agent.stream.assistant'`
  // inject 临时桥事件——不依赖本常量；保留 Django 端 ASSISTANT 短名走 relay
  // 直到 W4c-Django-reconstructor 完成。
  /**
   * **C1 范围外（2026-05-13）**：daemon `query.ts:2896, 3633` 仍 yield
   * `StreamEvents.STEP`（thinking 步骤"开始/结束"信号），W5 / W6 mobile
   * 仍消费本事件渲染 thinking 步骤卡片。本常量保留到 W5/W6 完成 6 件套
   * 接管 + mobile 删 handleStep 后，再做下一轮 daemon STEP yield 清理。
   *
   * 设计意图：新协议下"步骤分组"由 BlockTimeline 客户端按 ContentBlock
   * 顺序自然承接，不再需要独立 step 事件。
   */
  STEP: 'agent.stream.step',
  DONE: 'agent.stream.done',
  /**
   * Ask 工具事件（W4 R3 / 2026-05-11 修订）：
   *
   *   - `ASK_USER_REQUIRED`：单选 / 多选问题（AskUserQuestion 协议）。
   *     ask_user 工具发起；UI 按 questions[] 渲染。
   *   - `ASK_FORM_REQUIRED`：多字段结构化表单（凭证 / ID / URL / 自定义参数）。
   *     ask_form 工具发起；UI 按 fields[] 渲染。
   *   - `REQUEST_APPROVAL_REQUIRED`：destructive 操作授权（含 risk_level 视觉分级）。
   *     request_approval 工具发起；UI 按 risk_level 渲染红色批准按钮。
   *
   * 历史：W4 (2026-05-11) 短暂把三件套合并为单 ASK_USER_REQUIRED；平台型产品里
   *   表单 / 授权各有独立产品语义不可合并。W4 R3 (2026-05-11 dogfood 审计后) 拆回
   *   三件套，但保留 W4 的 ASK_USER_REQUIRED 兼容 ask_choice 场景 + 新字段
   *   header / preview / W4 R2 dedup 守护。
   *
   *   payload schema 见 `approval.ts::AskUserRequestSchema` / `AskFormRequestSchema` /
   *   `RequestApprovalRequestSchema` / `AskInteractionRequestSchema` discriminatedUnion。
   */
  ASK_USER_REQUIRED: 'agent.stream.ask_user_required',
  ASK_FORM_REQUIRED: 'agent.stream.ask_form_required',
  REQUEST_APPROVAL_REQUIRED: 'agent.stream.request_approval_required',
  /**
   * ask 三件套（ask_user / ask_form / request_approval）终态事件。
   *
   * 与三件套 `*_REQUIRED` 对称：runtime 的 HITL waiter 结束（answered / skipped /
   * expired）后由 runtime 补发，按 `request_id` 定位。Django relay 据此调
   * `mark_single_hitl_resolved`（落 PG 终态 + 发 `interaction_resolved` user 事件）
   * 并 reliable 重广播到 `agent.stream.{thread}` topic，让观察镜像 / 其它端收敛
   * 关面板——根治「跳过后 ask 面板被可靠 `*_required` 重放复活」。
   *
   * 单事件覆盖三种 kind：终态只需 `request_id` 定位，服务端
   * `mark_single_hitl_resolved` 本就 kind 无关（按 request_id 遍历三种 kind）；
   * 批量审批走对称的 `APPROVAL_RESOLVED`。
   *
   * payload schema 见 `approval.ts::SingleHitlResolvedPayloadSchema`。
   */
  SINGLE_HITL_RESOLVED: 'agent.stream.single_hitl_resolved',
  MESSAGE_PERSISTED: 'agent.stream.message_persisted',
  /**
   * Backend → frontend: emitted only after a ChatMessage row is committed/readable.
   * `message_stop` means runtime finished the message; this event means HTTP history
   * can safely reconcile that exact message_id.
   */
  MESSAGE_COMMITTED: 'agent.stream.message_committed',
  TODO: 'agent.stream.todo',
  /**
   * 对话回退全端收敛。Django apply 成功后广播给所有订阅
   * `agent.stream.{thread}` 的端（含其他设备 / 窗口），各端据此从服务端重拉
   * 全量最新消息（服务端已套 revert 可见性过滤），统一收敛——不再各端各截、
   * 不再要刷新。与 `REWIND`（落 messages.jsonl 的本地 transcript 软标记）区分：
   * 本事件是「跨端 UI 收敛信号」，不落盘、不影响 LLM 上下文。
   *
   * Payload: `{ session_id; target_message_id; target_role; keep_message_count; mode; revert_at }`
   */
  ROLLBACK: 'agent.stream.rollback',
  /** 对话回退撤销全端收敛。Payload: `{ session_id }`。 */
  UNREVERT: 'agent.stream.unrevert',
  SSH_OUTPUT: 'agent.stream.ssh_output',
  COMPACTION: 'agent.stream.compaction',
  /**
   * 对话回退边界标记。落在 `messages.jsonl` 里的「软回退」标记，与
   * `compaction:done` 同属「重建边界」元事件，但方向相反：compaction 清掉之前
   * 的消息（drop head），rewind 在重建到此标记时把累积消息截断到
   * `keep_message_count`（drop tail），让被回退的轮次不再进入 LLM 上下文。
   *
   * 软语义（保留 unrevert）：写入标记不删行，`reconstructMessagesFromTranscriptEntries`
   * 按行内顺序处理标记即可让上下文立刻正确；物理截断（`commitRewind`）推迟到用户
   * 发下一条消息时，与 Django `cleanup_reverted_messages` 两段式对称。
   *
   * 只落 `messages.jsonl`（软标记，可 unrevert）。events.jsonl 侧的回退在 `commitRewind`
   * 阶段由 `EventStorage.truncateFrom(cut_ts)` 直接物理删除，与后端 DB / PG
   * ConversationState、messages.jsonl 三层对称物理删，不写标记事件。
   *
   * Payload: `{ phase: 'mark'; keep_message_count: number; mode?: string; reason?: string }`
   */
  REWIND: 'agent.stream.rewind',
  CONTEXT_PRESSURE: 'agent.stream.context_pressure',
  SUBAGENT_STARTED: 'agent.stream.subagent_started',
  SUBAGENT_COMPLETED: 'agent.stream.subagent_completed',
  SUBAGENT_FAILED: 'agent.stream.subagent_failed',
  SUBAGENT_PROGRESS: 'agent.stream.subagent_progress',
  /**
   * 子 Agent HITL 审批请求（relay 观测用，不在主路径上）。
   *
   * **#9155 Wave3 幽灵清单（W-H④）**：wire 常量 + Electron `subagentHandler` + Django
   * 白名单已就绪，**runtime 零 emit**。子 HITL 主路径仍走父 channel 的
   * `APPROVAL_REQUESTED` 直发——本事件仅预留「子独立 HITL 观测」；**勿删常量**
   *（跨端契约 + 前端 handler 已挂）。接线需另开 issue，并与 APPROVAL_REQUESTED 划界。
   */
  SUBAGENT_HITL_REQUIRED: 'agent.stream.subagent_hitl_required',
  /** 子 Agent 排队中（active pool 满，等待 slot 释放）。已全链路接通。 */
  SUBAGENT_QUEUED: 'agent.stream.subagent_queued',
  /**
   * 旧版子 Agent 正文包装事件。#11099 起 runtime 不再生产：子 Agent 与主 Agent
   * 走同一套 `agent.stream.*`，只用 payload.`subagent_run_id` 区分归属。
   * 常量保留给旧客户端 / 旧 Host 入站兼容；服务端仍接受并解包。
   */
  SUBAGENT_STREAM_EVENT: 'agent.stream.subagent_stream_event',
  /**
   * 主 Agent 自主 push 汇报消息（stream 协议预留）。
   *
   * **#9155 Wave3 幽灵清单（W-H④）**：wire + Electron handler 已就绪，**runtime 零
   * emit**。生产 proactive 汇报走 Electron Main IPC
   * `agent-engine:proactive-report-ready` → Renderer 注入文案，**不经本 stream 事件**。
   * 统一 IPC vs stream 需另开 issue；**勿删常量**。
   */
  SPEAKER_PUSH_MESSAGE: 'agent.stream.speaker_push_message',
  /**
   * 子 Agent 的 LLM 调用事件（relay / Dashboard 观测预留）。
   *
   * **#9155 Wave3 幽灵清单（W-H④）**：wire + Electron handler（现仅 debug log）已就绪，
   * **runtime 零 emit**。若要在 fork-query LLM 边界接线 + Django trace，另开 issue；
   * **勿删常量**。
   */
  SUBAGENT_MODEL_CALL: 'agent.stream.subagent_model_call',
  /**
   * PG state persistence failed after content delivery.
   * The assistant reply was already streamed/returned to the user, but the
   * conversation state may be stale on the next turn.  Frontend should show
   * a non-fatal warning; the `done` event still follows normally.
   *
   * Payload: `{ thread_id: string; error: string }`
   */
  PERSIST_ERROR: 'agent.stream.persist_error',
  CHECKPOINT_FAILED: 'agent.stream.checkpoint_failed',
  CHECKPOINT_SUCCESS: 'agent.stream.checkpoint_success',
  // ：agent.stream.plan / agent.stream.mode 已物理删（全仓 0 emit；
  // plan 走 tabtin_rich_content kind=plan；mode 走本地 setAgentMode /
  // MODE_SWITCH_PROPOSAL）。
  SYSTEM_NOTICE: 'agent.stream.system_notice',
  MONITOR_STATUS: 'agent.stream.monitor_status',
  // ── W4.5 第三波 C1 物理删除（2026-05-13）──
  // 删除：TOOL_TIMEOUT / TOOL_HEARTBEAT / CONTENT_RESET
  // 详见文件顶部 docblock 第 2 节"W4.5 第三波 C1 物理删除"。
  LLM_HEARTBEAT: 'agent.stream.llm_heartbeat',
  /** Phase 2 · Debug Observability：每次 LLM 调用前的完整入参快照。 */
  LLM_REQUEST: 'agent.stream.llm_request',
  /** Debug Observability：每次 LLM 调用完成后的单轮 usage 事实。 */
  LLM_USAGE: 'agent.stream.llm_usage',
  /** M2.5 铺路：用户消息事件（替代 sync_api）。仅定义，消费端后续实现。 */
  USER: 'agent.stream.user',
  /**
   *  A1（落库与分发分链路）：消息级持久化事件。
   *
   * daemon 在「一条消息真正完整」的边界（assistant 的所有 tool_result 全齐 /
   * 纯文本消息 message_stop）把**整条已组装好的 ContentBlock[]**（text + tool_use +
   * 同 message 的 tool_result 已 co-locate）一次性发出，Django 单次幂等 upsert
   * 落库——**不再**依赖 6 件套增量重组。彻底消除 relay 乱序导致的
   * 「content_block_start 但无 message_start」丢块 + per-tool_result 多次 update。
   *
   * 与 6 件套的分工：6 件套继续走广播（其它端实时显示 + 本端 IPC live），
   * 本事件**仅持久化**。两条链路解耦——广播并行乱序无所谓，落库由本事件保序。
   *
   * §9.4.6「不新增 event type」红线已由用户就本事件显式批准破例（持久化语义
   * 与流式内容事件正交，无法靠扩既有 payload 干净表达）。
   *
   * Payload：`PersistMessageEventPayloadSchema`。
   */
  PERSIST_MESSAGE: 'agent.stream.persist_message',
  /**
   * ：LLM 调用快照上云——本地 snapshots.jsonl（LLMCallSnapshot：system
   * prompt 分段 + messages 摘要 + 工具 inputSchema）的云端副本通道。宿主在
   * `llm_request` 落盘快照时同步 push 本事件给 relay；Django detail 级异步写
   * `chat_llm_snapshot`（不广播、不进 TraceEvent、失败不 NAK）。超限时客户端
   * 先按字段截断（见 agent-host `delivery/llm-snapshot-projection.ts`）。
   */
  LLM_SNAPSHOT: 'agent.stream.llm_snapshot',
  /** M2.5 铺路：runtime 状态快照（每轮结束 / checkpoint）。仅定义，消费端后续实现。 */
  STATE_SNAPSHOT: 'agent.stream.state_snapshot',
  /** M2 协议补齐：LLM Proxy 计费尾帧。 */
  BILLING: 'agent.stream.billing',
  /**
   * Plan 模式 `plan_create` 工具落库成功后立刻通过本事件 emit 给 renderer。
   *
   * 来源：`packages/agent-runtime/src/tools/plan-tools.ts::createPlanCreateTool` →
   *   `context.emitStreamEvent` → 主进程 `sender.send`。
   *
   * 渲染端在 chat 流中插入 metadata.kind='plan_proposal' 的 system 消息，由
   * `PlanProposalCard` 渲染为 inline 卡片（执行按钮 + 打开文档）。LLM 不参与
   * 「该不该执行」的决策——这条事件只是把已落库的 plan 草稿展示给用户。
   *
   * Payload schema：`PlanProposalEventPayloadSchema`（见 `plan-proposal.ts`）。
   */
  PLAN_PROPOSAL: 'agent.stream.plan_proposal',
  /**
   * Plan 模式 `switch_mode` 工具请求切 agent 时 emit，渲染端插入 ModeSwitchProposalCard。
   *
   * Payload schema：`ModeSwitchProposalEventPayloadSchema`（见 `mode-switch-proposal.ts`）。
   */
  MODE_SWITCH_PROPOSAL: 'agent.stream.mode_switch_proposal',
  /**
   * 统一审批事件（v0.4 W1.5）。runtime / Django 都不再 emit
   * 旧 review_required；`approval_type` v0.4 唯一值是 `tool_permission`（保留
   * discriminator 字段供未来扩展，譬如 Skill 安装审批 / Organization admin 跨成员
   * 审批等场景）。
   *
   * Payload schema：`ApprovalRequestedPayloadSchema`（见 `approval.ts`）。
   */
  APPROVAL_REQUESTED: 'agent.stream.approval_requested',
  /**
   * 审批解决事件（与 APPROVAL_REQUESTED 对称）。
   * outcome ∈ { allow / deny / cancelled / expired / cancelled_by_rollback }。
   *
   * Payload schema：`ApprovalResolvedPayloadSchema`（见 `approval.ts`）。
   */
  APPROVAL_RESOLVED: 'agent.stream.approval_resolved',
  /**
   *  发送队列下沉：session 忙时一条待执行消息被 runtime 入队。
   * 由执行端 runtime（Electron/Daemon host）发出，前端据此把该消息标记为
   * 「排队中」（复用现有排队 UI），busy/queue 以 runtime 为唯一真相、前端不再
   * 用 isStreaming 影子判定。payload：`{ session_id, client_message_id, position }`。
   */
  MESSAGE_QUEUED: 'agent.stream.message_queued',
  /**
   * ：排队消息被 drain 出队、开始真正执行（与 MESSAGE_QUEUED 对称）。
   * 前端据此把「排队中」态切回正常 streaming。payload：`{ session_id, client_message_id }`。
   */
  MESSAGE_DEQUEUED: 'agent.stream.message_dequeued',
  /**
   * ：执行态 busy 独立同步事件（状态机在 runtime，前端只镜像）。
   * 与 lifecycle / MESSAGE_QUEUED / envelope.terminal 分离——那些业务/传输帧
   * 不得再改前端 busy。Payload：`AgentRunSyncPayloadSchema`（见 `run-sync.ts`）。
   */
  RUN_SYNC: 'agent.stream.run_sync',
  // ── W4.5 第三波 C1 物理删除（2026-05-13）──
  // 删除：TOOL_CALL_ARGS_DELTA
  // 新协议下 widget 真流式 args 走 ContentBlockEvents.CONTENT_BLOCK_DELTA 配合
  // `delta.type === 'input_json_delta'`，相同 transient 语义；前端
  // toolCallArgsDeltaHandler 的 in-memory buffer 通过 streamMessageHandler
  // 在分发 input_json_delta 时由 feedInputJsonDelta 喂数据（不再依赖独立事件类型）。
} as const;

export type StreamEventType = typeof StreamEvents[keyof typeof StreamEvents];

// ─── Session Events (Backend → Frontend, session-level topic) ──────
//
// 这些事件投递到 agent.session.{session_id} topic，订阅生命周期与
// ChatSession 激活/离开绑定——独立于单轮 agent.stream.{thread_id} 的
// stream slot cleanup。适用于：
//   * LLM 增强结果在 agent.stream.done 数十秒后才返回
//   * 跨多轮对话的系统通知（checkpoint 状态变化等）
//   * 不依赖 thread_id、按 session_id 路由的异步事件

export const SessionEvents = {
  /** 会话模型已变更；消费者收到后应重新拉取会话详情，不信任事件快照。 */
  MODEL_CHANGED: 'agent.session.model_changed',
  /** LLM 增强版决策摘要已开始生成（status=pending）— 让前端展示 Loader 动画 */
  DECISION_SUMMARY_PENDING: 'agent.session.decision_summary_pending',
  /** LLM 增强版决策摘要生成完成 */
  DECISION_SUMMARY_READY: 'agent.session.decision_summary_ready',
  /** LLM 决策摘要生成失败（保留 basic 版本，但状态切到 failed） */
  DECISION_SUMMARY_FAILED: 'agent.session.decision_summary_failed',
} as const;

export type SessionEventType = typeof SessionEvents[keyof typeof SessionEvents];

// ─── User Events (Backend → Frontend, user-level broadcast) ────────
//
// 详见文件顶部 docblock 中 `agent.user.*` 段——本块只列三个判别准则与反例，
// 避免和顶层注释完全复述。
//
// 选 user 命名空间的判别（任一满足即应放在这里）：
//   * "事件的逻辑接收者是用户本人"（不是某条流 / 某个会话）
//   * "用户切换会话或刷新页面后仍应收到"
//   * "离线设备上线后应能补到（不会被 slot/session 清理误丢）"
//
// 反例（仍走 stream/session）：
//   * agent.stream.assistant — 必须绑 thread_id，离线不补送
//   * agent.session.decision_summary_* — 当前归属 session（接收者语义还是
//     "正在看这个会话的用户"）；若未来产品判定接收者升级为"会话所属用户本人"，
//     再迁到 agent.user.* 命名空间，本期不动。

export const UserEvents = {
  /** LLM 生成的对话标题就绪——投递给"该会话所属的用户"，无论用户当前停留在哪个会话。 */
  TITLE_UPDATED: 'agent.user.title_updated',
  /** 新通知到达——必须在用户上线时补送（离线期间产生的通知不能丢）。 */
  NOTIFICATION_NEW: 'agent.user.notification.new',
  /** 用户级权限变更（角色 / 套餐 / 设备授权状态等）——客户端实时刷新本地缓存。 */
  PERMISSION_CHANGED: 'agent.user.permission.changed',
  /** Agent 进入等待用户处理状态——移动端/桌面端可拉 pending-interactions 恢复。 */
  INTERACTION_REQUESTED: 'agent.user.interaction_requested',
  /** 用户待处理事项已被任一端处理——所有端应收起对应 UI。 */
  INTERACTION_RESOLVED: 'agent.user.interaction_resolved',
  /** 用户待处理事项已过期——所有端应收起或显示不可操作状态。 */
  INTERACTION_EXPIRED: 'agent.user.interaction_expired',
  /**
   * 团队 Space 其他成员新建了会话——payload 带完整 session
   * schema，前端直接 upsert 进对应 Space 的会话列表。创建者本人不收。
   * 离线/丢事件恢复事实源：sessions.list（进入 Space 时静默 revalidate）。
   */
  SESSION_CREATED: 'agent.user.session_created',
  /**
   * Project Task 协作失效——payload 仅 project_id / task_id /
   * event_type / version，零私有正文。客户端按 version 去重后重拉权限 API。
   * 离线恢复：打开 Project / WS 重连 / 窗口焦点时 revalidate。
   */
  PROJECT_TASK_INVALIDATED: 'agent.user.project_task_invalidated',
} as const;

export type UserEventType = typeof UserEvents[keyof typeof UserEvents];

// ─── Chat Session Events (Backend → Frontend, user-level delivery) ──
//
// 该事件虽然通过用户级 gateway group 扇出，但逻辑名属于 chat.session 域，
// 不使用 agent.user.* 前缀。payload 与 ChatSession.run_state 快照同形，客户端
// 通过 sequence + revision 做单调合并。

export const ChatSessionEvents = {
  /** 会话当前 run 的权威投影发生变化。 */
  RUN_STATE_UPDATED: 'chat.session.run_state.updated',
  /**
   * 同账号会话目录活动变化——仅投递给 session owner。
   * 用于跨设备 upsert 列表行并按 last_message_at 重排；不恢复团队
   * `agent.user.session_created` 广播。
   */
  ACTIVITY_UPDATED: 'chat.session.activity.updated',
} as const;

export type ChatSessionEventType = typeof ChatSessionEvents[keyof typeof ChatSessionEvents];

// ─── Organization Events (Backend → Frontend, user-level broadcast) ─

export const OrganizationEvents = {
  /** 用户所属组织集合变化（加入 / 移出 / auth 同步）。 */
  MEMBERSHIP_CHANGED: 'organization.membership_changed',
  /** 组织资料变更（名称 / 描述 / 图标 / settings）——成员侧增量合并 store。 */
  UPDATED: 'organization.updated',
} as const;

export type OrganizationEventType = typeof OrganizationEvents[keyof typeof OrganizationEvents];

// ─── Prompt Forward Events (Backend → Daemon) ───────────────────────

export const PromptEvents = {
  FORWARD: 'agent.prompt.forward',
  /** Execution host accepted a reliable forward into its local AgentHost queue. */
  ADMITTED: 'agent.prompt.admitted',
  CANCEL: 'agent.prompt.cancel',
} as const;

export type PromptEventType = typeof PromptEvents[keyof typeof PromptEvents];

// ─── Permission Events (Backend → Daemon) ───────────────────────────

export const PermissionEvents = {
  RESPONSE: 'agent.permission.response',
  RESET_SESSION: 'agent.permission.reset_session',
  MODE_UPDATE: 'agent.permission.mode_update',
} as const;

export type PermissionEventType = typeof PermissionEvents[keyof typeof PermissionEvents];

// ─── Helpers ─────────────────────────────────────────────────────────

const STREAM_PREFIX = 'agent.stream.';
const SESSION_PREFIX = 'agent.session.';
const USER_PREFIX = 'agent.user.';

export function isStreamEvent(eventType: string): boolean {
  return eventType.startsWith(STREAM_PREFIX);
}

export function isSessionEvent(eventType: string): boolean {
  return eventType.startsWith(SESSION_PREFIX);
}

export function isUserEvent(eventType: string): boolean {
  return eventType.startsWith(USER_PREFIX);
}

export function stripStreamPrefix(eventType: string): string {
  return eventType.startsWith(STREAM_PREFIX)
    ? eventType.slice(STREAM_PREFIX.length)
    : eventType;
}

export function stripSessionPrefix(eventType: string): string {
  return eventType.startsWith(SESSION_PREFIX)
    ? eventType.slice(SESSION_PREFIX.length)
    : eventType;
}

export function stripUserPrefix(eventType: string): string {
  return eventType.startsWith(USER_PREFIX)
    ? eventType.slice(USER_PREFIX.length)
    : eventType;
}

// ─── ContentBlock Streaming Events ───────────────────────────────────
// (Anthropic Messages API alignment, Wave 1 introduces / Wave 7 老协议下线)
//
// 6 件套事件命名空间分两类：
//
//   * `agent.stream.message.*`        — LLM 整轮元信息（开始 / delta / 结束 +
//                                       cumulative usage / stop_reason）
//   * `agent.stream.content_block.*`  — 单条 ContentBlock 的生命周期（开始 /
//                                       增量 / 结束）
//
// **Anthropic 协议硬约束**：一个 message 内的 content_block_* 事件**严格串行**：
//   `content_block_start(N) → content_block_delta(N)* → content_block_stop(N)
//    → content_block_start(N+1)`
//   禁止 start(5) 在 stop(4) 之前。`proxy-provider` 必须把 OpenAI 等并行
//   streaming 重排成串行后才能 yield 下游。
//
// Schema 定义：`stream-content-block.ts`
//
// **不要混淆**：
//   - `content_block.*` 事件 ≠ 老 `tool_call_args_delta`（W4.5 第三波 C1 物理删，
//     widget 真流式 args 改走 `content_block_delta(input_json_delta)`）
//   - `message.*` 事件 ≠ 顶层 `MESSAGE_PERSISTED`（后者是后端落库通知，不是 LLM 流）

// 历史注：W4a 阶段曾在此 export 一个名为 `tabtin-tool-runtime` 的 `model_id`
// 占位字符串常量，作为 daemon / Django / Renderer 三端识别"工具产出 mini-message"
// 的字面量契约——实战踩到 silent regress。本 Wave 把
// 识别契约升级为显式协议字段 `message_kind`（见
// `stream-content-block.ts::MessageStartSchema.message_kind`），wire 层不再
// 承载该字面量；daemon emit 时仍需要给 `model_id` 字段填占位字符串，该实现
// 细节单点存活在 `@tabtin/agent-runtime::envelope-emitter.ts` 内部常量里，
// 不再 cross-package export。

export const ContentBlockEvents = {
  /** LLM API 调用开始 — payload 含 message_id / role / model_id / model_name / started_at / run_id / subagent_run_id? / message_kind / _seq */
  MESSAGE_START: 'agent.stream.message_start',
  /** LLM 整轮元信息增量 — payload.delta 含 stop_reason / stop_sequence / usage（**cumulative**） */
  MESSAGE_DELTA: 'agent.stream.message_delta',
  /** LLM 整轮结束 — payload 含 message_id / persisted_id? / block_id_overrides? / _seq */
  MESSAGE_STOP: 'agent.stream.message_stop',
  /** 单条 ContentBlock 开始 — payload 含 message_id / index / block_id / block (空壳) / _seq */
  CONTENT_BLOCK_START: 'agent.stream.content_block_start',
  /** 单条 ContentBlock 增量 — payload 含 message_id / index / delta (discriminated union 6 种) / _seq */
  CONTENT_BLOCK_DELTA: 'agent.stream.content_block_delta',
  /** 单条 ContentBlock 结束 — payload 含 message_id / index / _seq */
  CONTENT_BLOCK_STOP: 'agent.stream.content_block_stop',
} as const;

export type ContentBlockEventType = typeof ContentBlockEvents[keyof typeof ContentBlockEvents];

const CONTENT_BLOCK_EVENT_TYPES = new Set<string>(Object.values(ContentBlockEvents));

/**
 * 判断给定事件名是否属于 ContentBlock 6 件套（含 message_* 与 content_block_*）。
 *
 * 用途：consumer side 可基于此快速过滤 / 路由（避免硬编码 6 个字符串比较）。
 * 不与 `isStreamEvent` 重叠 —— ContentBlock 事件本身也是 stream 事件，但反之
 * 不一定（lifecycle / done / approval_* 等都是 stream 但不属于 ContentBlock）。
 */
export function isContentBlockEvent(eventType: string): eventType is ContentBlockEventType {
  return CONTENT_BLOCK_EVENT_TYPES.has(eventType);
}

// ─── USER Event Payload Schema ───────────────────────────────────────
//
// 2026-05-23 push 通知重构 commit 4：显式声明 `StreamEvents.USER`
// (`agent.stream.user`) 的 payload 形状。
//
// 历史背景：M2.5 引入 USER 事件常量后 payload 形状只在 runtime emit 处
// 约定（`packages/agent-runtime/src/engine/query.ts` 主轮开头那段），从
// 未显式 schema 化——`source` / `tool_call_id` 等字段藏在 "payload 是
// `Record<string, unknown>`" 里，半年后没人记得它们存在。本次 push 通知
// 重构必须新增 `triggered_by` 字段，借机把现有字段一并显式声明，避免漂移。
//
// **关键约束**：
//   - 不新增 event type，只扩既有 USER event payload schema
//   - 所有新字段 optional，旧 emitter 不传时与现状完全兼容
//   - Django relay_message_writer 走 `payload.get(...)` 已天然兼容 optional

export const UserEventPayloadSchema = z.object({
  client_event_id: z.string(),
  content: z.string(),
  /** 本轮可见 user 消息的真实发送者；共享执行时与设备 owner 不同。 */
  sender_user_id: z.string().optional(),
  attachments_json: z.array(z.unknown()).optional(),
  blocks_json: z.array(z.record(z.unknown())).optional(),
  /**
   * 业务来源标签。runtime 在 skill `newMessages` 注入路径上设
   * `'skill_invoke'`；常规用户输入不设。Django relay 提升到
   * `ChatMessage.metadata.source`，前端 MessageBubble 据此渲染
   * "Skill 指令" 徽章（详见 `relay_message_writer.build_chat_message_metadata`）。
   */
  source: z.string().optional(),
  /**
   * Skill 注入路径上关联到对应 tool_call 步骤位置（前端
   * SkillInjectionInlineCard inline 渲染所需）。Django relay 提升到
   * `metadata.tool_call_id`。
   */
  tool_call_id: z.string().optional(),
  /**
   * 2026-05-23 push 通知重构 commit 4：触发来源。
   *
   * - `undefined` / `'user'`：常规用户输入（IPC `agent-engine:query`
   *   / WS `agent.prompt.forward`）
   * - `'push-notification'`：host 内部循环触发（后台命令完成等系统事件
   *   → push notification → host._tryDrain 起新一轮 turn）
   * - `'continuation'`：同一会话续跑（错误卡重试等），不是新的用户轮次
   *
   * 用途链路：
   *   1. renderer 据此做 D6 视觉区分（系统注入 vs 用户输入）
   *   2. Django `relay_message_writer.build_chat_message_metadata` 提升到
   *      `ChatMessage.metadata.triggered_by` 持久化，刷新会话不丢
   */
  triggered_by: z.enum(['user', 'push-notification', 'continuation']).optional(),
});

export type UserEventPayload = z.infer<typeof UserEventPayloadSchema>;

// ─── PERSIST_MESSAGE Event Payload Schema（ A1）───────────────────
//
// 消息级持久化：daemon 在消息完整边界发整条 ContentBlock[]，Django 幂等 upsert。
// 幂等 key 约定：
//   - assistant：`message_id`（== daemon emit 的 message_start.message_id，
//     落库为 ChatMessage.id），与 6 件套 reassembler 老路径同命名空间，切换零冲突。
//   - user：`client_event_id`（沿用 user 路径 dedup key）。
export const PersistMessageEventPayloadSchema = z.object({
  /** 消息稳定 ID。assistant = message_start.message_id；落库为 ChatMessage.id。 */
  message_id: z.string(),
  /** user 路径 dedup key；assistant 也带上供链路追溯。 */
  client_event_id: z.string().optional(),
  /** 'assistant' | 'user'——决定落库 role 与 dedup key 选择。 */
  role: z.enum(['assistant', 'user']),
  /** 完整、有序、co-locate 好的 ContentBlock[]（text + tool_use + 同 message tool_result）。 */
  blocks_json: z.array(z.record(z.unknown())),
  trace_id: z.string().optional(),
  /** 块级/消息级权威排序键（微秒单调，与 6 件套同口径）。 */
  arrival_seq: z.number().optional(),
  /** 事件唯一身份：跨源去重键；与 arrival_seq（排序）职责分离。 */
  event_id: z.string().optional(),
  /** 子 Agent 归属；非空表示该消息属于子 Agent（前端按此隔离主时间线）。 */
  subagent_run_id: z.string().optional(),
  /**
   * Per-turn 归因锚点（= runtime runId / ToolContext.agentRunId）。
   * 写入 ChatMessage.agent_run_id；与 envelope `run_id` 同源但字段名即库列契约。
   */
  agent_run_id: z.string().optional(),
  /** 'llm' | 'tool_artifact' | 'error_envelope' 等，沿用 message_start 语义。 */
  message_kind: z.string().optional(),
  /** end_turn / tool_use / aborted / error 等，供历史回放标注终态。 */
  stop_reason: z.string().optional(),
  /** cost/cache/compact/错误等分项，沿用 buildTerminalAssistantPayload 口径。 */
  metadata: z.record(z.unknown()).optional(),
  /** 是否未完成（abort / stall / 强制收尾）——历史回放标「…（未完成）」。 */
  partial: z.boolean().optional(),
  /** 终态结构化错误；正文块可为空，消费端据此恢复统一错误卡片。 */
  error_info_json: z.record(z.unknown()).optional(),
});

export type PersistMessageEventPayload = z.infer<typeof PersistMessageEventPayloadSchema>;

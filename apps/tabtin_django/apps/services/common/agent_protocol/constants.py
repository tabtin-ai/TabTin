"""Multiagent 模块常量 — 事件类型等单一数据源。

值格式约定
---------
- **短名称 + 拼装 helper**（AgentStreamEvent / AgentUserEvent /
  InternalStreamEvent）：常量值仅为事件名（如 ``"lifecycle"`` /
  ``"title_updated"``），完整 WS ``type`` 字段由 namespace helper 组装：

  * ``stream_event_type("lifecycle")``  → ``"agent.stream.lifecycle"``
  * ``user_event_type("title_updated")`` → ``"agent.user.title_updated"``

  **千万不要**把短名直接当 envelope ``type`` 用——envelope 字段需要完整
  ``agent.<kind>.<name>`` 路径，否则前端 router 无法识别。

- **完整路径**（其他所有常量类，如 PromptForwardEvent / TrackerEvent /
  AgentActionEvent）：常量值即完整 ``type`` 字段，如
  ``"agent.prompt.forward"`` / ``"tracker.progress"``，直接传入
  ``build_envelope(message_type=...)``，不再经过 namespace 组装。

前后端对齐
---------
本模块的事件常量类与 TS 协议包 ``@tabtin/agent-wire``（路径
``packages/agent-wire/src/events.ts``）中的常量对象一一对应。``agent-wire``
是当前协议 SSOT；历史路径 ``packages/ws-gateway-client/src/events.ts``
对客户端订阅辅助类型仍在用，但**事件常量定义已统一收敛到 agent-wire**——
新增 / 修改协议常量请同时改两端。

  后端                        TS (`agent-wire/src/events.ts`)
  AgentStreamEvent          ↔ StreamEvents
  AgentUserEvent            ↔ UserEvents          ← W0 新增（用户级广播）
  AgentActionEvent          ↔ MonitorActionEvents / 见 ws-gateway-client
  TrackerEvent              ↔ TrackerEvents (ws-gateway-client；波次 4 改名)
  InternalStreamEvent       — （后端内部，无前端对应）
  FrontendDispatchEvent     — （后端内部，无前端对应）
  PromptForwardEvent        ↔ PromptEvents / PermissionEvents
"""


import functools

from apps.chat.conversation.utils import CHAT_SESSION_PREFIX  # noqa: F401 — single source of truth

# Tracker 模块波次 4 Stage 2.4 一刀切（2026-05-25）：
#
# 此前的双前缀并存方案（``TABGOAL_STATE_PREFIX`` + ``AGENDA_GOAL_STATE_PREFIX``）
# 已全部下线。新主路径统一使用 ``TRACKER_STATE_PREFIX = "_tracker_"``；
# 因产品未上线，不需要保留双读历史前缀（charter §3.4 + PRD v2 §3 决策 6）。

ORIGIN_STATE_PREFIX = "_origin_"

# Tracker 关联 state 前缀（charter v1.8 §6.7 / §7.2）。
TRACKER_STATE_PREFIX = "_tracker_"

# Agent state / app_context 键名（与前端 WS / TinAgent 状态约定一致；改名需全链路审计）。
# Wave 2 续作：单 Skill 执行模型下不再有「步骤」概念，``*_STEP_RUN_ID_KEY`` 已删。
TRACKER_TRACKER_RUN_ID_KEY = f"{TRACKER_STATE_PREFIX}tracker_run_id"
TRACKER_TRACKER_ID_KEY = f"{TRACKER_STATE_PREFIX}tracker_id"
TRACKER_ORGANIZATION_ID_KEY = f"{TRACKER_STATE_PREFIX}organization_id"

# 对话 / 内部同步元数据中的「来自 Tracker 步骤」标识。
EXECUTION_SOURCE_TRACKER = "tracker"
CHAT_METADATA_ORIGIN_TRACKER = "tracker"

TIN_AGENT_NAME = "tin"
TIN_AGENT_LEGACY_THREAD_PREFIX = "tin"
TIN_AGENT_ALLOWED_THREAD_PREFIXES = (
    CHAT_SESSION_PREFIX,
    f"{TIN_AGENT_LEGACY_THREAD_PREFIX}-",
)


@functools.cache
def get_base_tool_domains() -> list[str]:
    from apps.services.common.app_registry import get_base_tool_domains as _base
    return list(_base())


@functools.cache
def get_default_tool_domains() -> list[str]:
    from apps.services.common.app_registry import get_default_tool_domains as _default
    return list(_default())


# ---------------------------------------------------------------------------
# 凭据安全相关常量 — Single Source of Truth
#
# 三层防线：
#   1. tool_executor   → CREDENTIAL_SENSITIVE_TOOLS  → mask_sensitive_tool_output
#   2. ws/bus.py       → SENSITIVE_DEVICE_ACTIONS     → _sanitize_envelope_for_buffer
#   3. step_display.py → CREDENTIAL_DISPLAY_TOOLS     → summarize_tool_output
#
# 隐性耦合注意：
#   screen_type_secret 通过 action_override="screen_type_in_element" 下发设备，
#   因此 SENSITIVE_DEVICE_ACTIONS 必须包含 screen_type_in_element 以确保
#   bus.py 对含密码的 envelope 执行脱敏。移除 screen_type_in_element 将导致
#   screen_type_secret 的密码明文写入 Redis buffer。
# ---------------------------------------------------------------------------

CREDENTIAL_SENSITIVE_TOOLS: frozenset[str] = frozenset({
    "credential_retrieve",
    "screen_type_secret",
})
"""tool_executor 层：输出中的 password/text 字段需要脱敏（对话持久化 / 前端展示）。

消费方：tool_executor.mask_sensitive_tool_output()
"""

SENSITIVE_DEVICE_ACTIONS: frozenset[str] = frozenset({
    "screen_type_text",
    "screen_type_in_element",
    "screen_type_secret",
})
"""WS bus 层：params 中可能含明文的 device action（Redis buffer 写入前脱敏）。

消费方：ws/bus._sanitize_envelope_for_buffer()

screen_type_in_element 必须保留——screen_type_secret 经 action_override 后
以此 action name 下发，缺少它将导致密码泄露到 Redis Stream。
"""

CREDENTIAL_DISPLAY_TOOLS: frozenset[str] = frozenset({
    "credential_retrieve",
    "screen_type_secret",
})
"""step_display 层：需要特殊摘要文案的 tool name（避免在 UI 步骤中展示敏感内容）。

消费方：step_display.summarize_tool_output()

当前与 CREDENTIAL_SENSITIVE_TOOLS 内容一致，但语义不同：
SENSITIVE = "输出需要脱敏"，DISPLAY = "步骤摘要需要替换"，
未来可能出现只需脱敏不需替换摘要（或反之）的工具。
"""


class AgentStreamEvent:
    """agent.stream.* 事件完整注册表（短名称，由 stream_event_type() 组装完整路径）。

    TS 侧对应 ``StreamEvents``（packages/agent-wire/src/events.ts）。

    relay_handler 白名单从 ``RELAY_ALLOWED_SHORT_NAMES`` 自动导出，
    新增事件时只需在此类添加常量并加入 ``RELAY_ALLOWED_SHORT_NAMES`` 即可。

    命名空间归属
    -----------
    本类仅承载"事件接收者是单轮 stream slot"的事件——绑 topic
    ``agent.stream.{thread_id}``，slot 清理后晚到事件会 silent drop。
    若事件的逻辑接收者是「用户本人」（如标题更新 / 通知 / 权限变更），
    应放在 :class:`AgentUserEvent` 走 ``publish_to_user``，而非这里。
    """

    LIFECYCLE = "lifecycle"
    # ── W4.5 第三波 C1（2026-05-13）物理删除：REASONING / TOOL / CHUNK /
    #    REVIEW_REQUIRED 短名。wire 层 `StreamEvents.*` 同名常量已删；daemon
    #    0 emit、Renderer / iOS / Android listener 同步清。详见 wire
    #    `packages/agent-wire/src/events.ts` 顶部 docblock。
    #
    # **保留 ASSISTANT 短名**：`lite_blocks_collector` 临时桥（W4a-L16）仍 inject
    #    `agent.stream.assistant(phase='final')` 让 `relay_message_writer` 走
    #    `_is_persistable_message` 落库 ChatMessage with content_blocks_json。
    #    `@cleanup-after W4c-Django-reconstructor`：W4c reassembler 主路径接管
    #    后翻 `LITE_COLLECTOR_ENABLED=false` flag → daemon 桥沉默 → 然后清。
    # **保留 STEP 短名**：daemon `query.ts` 仍 emit thinking 步骤事件，W5/W6
    #    mobile 仍消费它渲染步骤卡片；待 W5/W6 完成 6 件套接管后再清。
    ASSISTANT = "assistant"
    STEP = "step"
    DONE = "done"
    PLAN_APPROVAL_REQUIRED = "plan_approval_required"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_RESOLVED = "approval_resolved"
    # W4 R3（2026-05-11）：ask 三件套并存。
    #   - ASK_USER_REQUIRED → ask_user 工具（AskUserQuestion 协议；替代 W4 之前的 ask_choice_required）
    #   - ASK_FORM_REQUIRED → ask_form 工具（多字段填表，TabTin HITL 扩展）
    #   - REQUEST_APPROVAL_REQUIRED → request_approval 工具（已决方案审批，
    #     TabTin HITL 扩展，必带 risk_level）
    # schema 源：packages/agent-wire/src/approval.ts
    #   AskUserRequestSchema / AskFormRequestSchema / RequestApprovalRequestSchema
    ASK_USER_REQUIRED = "ask_user_required"
    ASK_FORM_REQUIRED = "ask_form_required"
    REQUEST_APPROVAL_REQUIRED = "request_approval_required"
    # ：ask 三件套（ask_user / ask_form / request_approval）终态事件，与三件套
    # *_REQUIRED 对称。runtime 的 HITL waiter 结束（answered / skipped / expired）后补发，
    # 按 request_id 定位。relay_handler 据此 mark_single_hitl_resolved（落 PG 终态 +
    # 发 interaction_resolved user 事件）并 reliable 重广播到 topic，全端收敛关面板——
    # 根治「本地 IPC 跳过后 ask 面板被可靠 *_required 重放复活」。
    # wire schema 源：packages/agent-wire/src/approval.ts::SingleHitlResolvedPayloadSchema
    SINGLE_HITL_RESOLVED = "single_hitl_resolved"
    MESSAGE_PERSISTED = "message_persisted"
    # 后端专用事实事件：ChatMessage 已提交且历史接口可读。
    # 不加入 RELAY_ALLOWED_SHORT_NAMES，避免 runtime/客户端伪造后端落库事实。
    MESSAGE_COMMITTED = "message_committed"
    TODO = "todo"
    SSH_OUTPUT = "ssh_output"
    COMPACTION = "compaction"
    CONTEXT_PRESSURE = "context_pressure"
    SUBAGENT_STARTED = "subagent_started"
    SUBAGENT_COMPLETED = "subagent_completed"
    SUBAGENT_FAILED = "subagent_failed"
    SUBAGENT_PROGRESS = "subagent_progress"
    # 子 Agent 内层 transcript 实时透传。payload.child_event 可能是高频
    # content_block_delta；只给观察端直播，不写 TraceEvent（见
    # EXCLUDED_FROM_TRACE）。
    SUBAGENT_STREAM_EVENT = "subagent_stream_event"
    PERSIST_ERROR = "persist_error"
    SYSTEM_NOTICE = "system_notice"
    #  对话回退全端收敛：apply 成功后广播给所有订阅端（含其他设备/窗口），
    # 让各端统一截断本地消息时间线 / 恢复，不再各截各的、不再要刷新。
    ROLLBACK = "rollback"
    UNREVERT = "unrevert"
    LLM_HEARTBEAT = "llm_heartbeat"
    MONITOR_STATUS = "monitor_status"
    # W4.5 第二波 B2 物理删 RICH_CONTENT（短名 `rich_content`）：daemon 0 处真
    # emit `agent.stream.rich_content`，工具产出走 ContentBlock `tabtin_rich_content`
    # 块（content_block_start/delta/stop 三件套，由 ContentBlockReassembler 重组）。
    # wire 层常量 `StreamEvents.RICH_CONTENT` 已同步删除；Renderer / 4 端 mobile
    # listener 也物理删——保留本注释作历史标记，方便未来 grep 定位下线时间点。
    #
    # W4.5 第三波 C1（2026-05-13）同模式继续物理删：TOOL_TIMEOUT / TOOL_HEARTBEAT
    # / CONTENT_RESET 三个短名——wire 层常量已删（详见 wire events.ts 顶部 docblock），
    # daemon 0 emit、Django publisher / Renderer 兜底全部清空，链路从源头封死。
    #  行为审计：AuditCap 生命周期事件（runtime createRelayAuditWriter emit）。
    # 加入 RELAY_ALLOWED_SHORT_NAMES 让它至少经 detail 后台流程落 TraceEvent，
    # 否则 relay_handler 直接 skip（bugbot 评审：事件既不落库也无告警，emit 形同虚设）。
    # 专用 PermissionAudit/统一审计表持久化仍属  后续专题。
    AUDIT_CAP = "audit_cap"
    CHECKPOINT_FAILED = "checkpoint_failed"
    CHECKPOINT_SUCCESS = "checkpoint_success"
    LLM_REQUEST = "llm_request"
    # ：每次 LLM iteration 完成后的结构化 usage 事实。进普通 detail
    # TraceEvent，便于按 iterationId 直接查询 token / cache / reasoning / duration。
    LLM_USAGE = "llm_usage"
    # ：LLM 调用快照上云（本地 snapshots.jsonl 的云端副本）。detail 级
    # （不进 CRITICAL / EXCLUDED），由 relay_llm_snapshot_writer 异步写
    # chat_llm_snapshot 表；含 system prompt / 工具 schema，不广播。
    LLM_SNAPSHOT = "llm_snapshot"

    # Runtime 产生的用户可见提案。两者都必须经过 relay 广播给 mobile / web
    # observer；此前 Python registry 漏项会在 relay_handler 里被
    # event_not_allowed 静默跳过，而 Electron 本地 IPC 仍可见。
    PLAN_PROPOSAL = "plan_proposal"
    MODE_SWITCH_PROPOSAL = "mode_switch_proposal"

    # Runtime session 队列权威状态。观察端据此把本地消息投影为排队 / 已出队，
    # 不能退回客户端根据 isStreaming 猜测。
    MESSAGE_QUEUED = "message_queued"
    MESSAGE_DEQUEUED = "message_dequeued"

    # M2.5 铺路：新增事件类型（仅定义，消费端后续实现）
    USER = "user"                    # agent.stream.user
    STATE_SNAPSHOT = "state_snapshot"  # agent.stream.state_snapshot
    BILLING = "billing"              # agent.stream.billing

    #  A1（落库与分发分链路）：消息级持久化事件。daemon 在一条消息
    # 「真正完整」边界发整条 ContentBlock[]（含 co-locate 的 tool_result），
    # Django 单次幂等 upsert，杜绝 6 件套 relay 乱序丢块 + per-tool_result
    # 多次 update。仅落库，不广播（_async_publish_ws 显式跳过）。
    PERSIST_MESSAGE = "persist_message"  # agent.stream.persist_message

    # PRD 06：子 Agent 协调新增事件
    SUBAGENT_HITL_REQUIRED = "subagent_hitl_required"    # 子 Agent HITL 审批请求
    SUBAGENT_QUEUED = "subagent_queued"                  # 子 Agent 排队等待 slot
    SPEAKER_PUSH_MESSAGE = "speaker_push_message"        # 主 Agent 自主 push 汇报
    SUBAGENT_MODEL_CALL = "subagent_model_call"          # PRD 06 §5.3.2：子 Agent LLM 调用事件

    # ── W4.5 第三波 C1（2026-05-13）物理删：TOOL_CALL_ARGS_DELTA 短名 ──
    # wire `StreamEvents.TOOL_CALL_ARGS_DELTA` 已删，daemon 0 emit；widget 真
    # 流式 args 改走 `content_block_delta(input_json_delta)`，相同 transient
    # 语义。EXCLUDED_FROM_TRACE 集合中的 TOOL_CALL_ARGS_DELTA 条目同步移除。

    # ── W3 §3.3 Anthropic 6 件套（Wave 2 daemon 端已 emit；W3 让 Django relay
    #   接管消费 → 重组 ContentBlock[] → 落库 chat_message.content_blocks_json） ──
    #
    # 协议层面 ContentBlockReassembler 用 generated Pydantic 强 typed 解析
    # （`apps/services/wire_generated/` 下 6 个 root model）。relay_handler
    # 把 6 件套全部归入 critical 通道（即便 content_block_delta 高频，也是
    # 主要消费场景——必须 publish 给前端 SSE + 进 reassembler 内存累积；不
    # 写 trace_event 即可——加进 EXCLUDED_FROM_TRACE）。
    #
    # **生命周期**：W3 完成后 daemon `LITE_COLLECTOR_ENABLED=false` 翻开关，
    # daemon 不再 inject `agent.stream.assistant(phase='final')` 兼容事件，
    # 6 件套成为 daemon → Django chat_message 的唯一落库链路。
    MESSAGE_START = "message_start"
    MESSAGE_DELTA = "message_delta"
    MESSAGE_STOP = "message_stop"
    CONTENT_BLOCK_START = "content_block_start"
    CONTENT_BLOCK_DELTA = "content_block_delta"
    CONTENT_BLOCK_STOP = "content_block_stop"


class AgentUserEvent:
    """agent.user.* 用户级广播事件短名称（由 user_event_type() 组装完整路径）。

    与 TS 侧 ``UserEvents``（packages/agent-wire/src/events.ts）镜像。

    投递通道
    -------
    这些事件**不绑 topic 订阅**——publisher 调用
    ``apps.services.common.ws.bus.publish_to_user(user_id, event)``，事件被广播
    到 channel layer group ``user.{user_id}``。
    客户端 auth.ok 后已自动加入该 group，无需 syncSubscriptions / 不依赖
    stream slot 或 ChatSession 当前激活状态。该通道只负责实时提醒；离线/断网
    补漏必须由对应 REST 事实源承担（如 pending-interactions）。

    使用判别
    -------
    "事件的逻辑接收者是用户本人"（不是某条 stream / 某个会话）；用户切换
    会话或刷新页面后仍应收到；离线设备上线后应能补到——满足任一条都应放
    在 ``agent.user.*`` 命名空间，而不是塞回 ``agent.stream.*`` /
    ``agent.session.*``（前者随单轮 stream slot 清理而 silent drop，后者
    跟 ChatSession 激活绑定）。

    完整路径示例：``agent.user.title_updated``、``agent.user.notification.new``、
    ``agent.user.permission.changed``。

    易混淆命名澄清
    -------------
    ``agent.user.permission.changed`` vs ``agent.permission.*``
    （:class:`PromptForwardEvent.PERMISSION_RESPONSE` / TS ``PermissionEvents``）：

    * ``agent.user.permission.changed`` → **前端缓存刷新信号**：用户级权限
      （角色 / 套餐 / 设备授权状态等）变化后通知所有在线客户端 re-fetch；
    * ``agent.permission.*`` → **Daemon 侧权限决策应答**：Backend 把单次 tool
      permission 决策结果下发给具体设备/Daemon；走 device 通道，不用 user group。

    集合范围
    --------
    想加新成员请同步在 TS ``UserEvents`` 镜像，并确认是否有 REST 事实源负责
    离线/晚进入恢复。
    """

    TITLE_UPDATED = "title_updated"
    NOTIFICATION_NEW = "notification.new"
    PERMISSION_CHANGED = "permission.changed"
    INTERACTION_REQUESTED = "interaction_requested"
    INTERACTION_RESOLVED = "interaction_resolved"
    INTERACTION_EXPIRED = "interaction_expired"
    # 团队 Space 其他成员新建了会话——接收者是"同团队 Space 的
    # 其他成员"，与其当前停留界面无关，符合 user 级判别。离线恢复事实源：
    # sessions.list（前端 loadSessions 进入 Space 时静默 revalidate 兜底）。
    SESSION_CREATED = "session_created"
    # Project Task 协作失效——payload 仅 project_id / task_id /
    # event_type / version，不含私有正文或 session id。接收者为 Project 全部
    # active 成员；完整数据仍由权限过滤后的 listTasks / inbox API 重拉。
    # 离线恢复事实源：打开 Project / WS 重连 / 窗口焦点恢复时的 revalidate。
    PROJECT_TASK_INVALIDATED = "project_task_invalidated"


RELAY_ALLOWED_SHORT_NAMES: frozenset[str] = frozenset({
    # **保留 ASSISTANT**：lite_blocks_collector 临时桥仍 inject 这条事件让
    # `relay_message_writer` 落库 ChatMessage（@cleanup-after W4c-Django-reconstructor）。
    # **保留 STEP**：daemon `query.ts` 仍 emit thinking 步骤事件给 W5/W6 mobile 渲染。
    AgentStreamEvent.ASSISTANT,
    AgentStreamEvent.STEP,
    AgentStreamEvent.LIFECYCLE,
    AgentStreamEvent.DONE,
    AgentStreamEvent.SYSTEM_NOTICE,
    AgentStreamEvent.COMPACTION,
    AgentStreamEvent.APPROVAL_REQUESTED,
    AgentStreamEvent.APPROVAL_RESOLVED,
    # PLAN_APPROVAL_REQUIRED 已从白名单移除（plan-approval 整套已下线，无 publish caller；
    # 常量保留供历史 trace event 反序列化兼容）。新链路走 plan-execute-handler IPC。
    AgentStreamEvent.ASK_USER_REQUIRED,
    AgentStreamEvent.ASK_FORM_REQUIRED,
    AgentStreamEvent.REQUEST_APPROVAL_REQUIRED,
    # ：单 HITL 终态回流事件——不入白名单会被 relay silent drop。
    AgentStreamEvent.SINGLE_HITL_RESOLVED,
    AgentStreamEvent.TODO,
    # W4.5 第二波 B2：`AgentStreamEvent.RICH_CONTENT` 已物理删——daemon 0 emit
    # 这条事件，工具产出走 ContentBlock `tabtin_rich_content` 块（六件套路径）。
    # relay 白名单同步移除短名 `rich_content`：即便有人手贱再加 publisher 调用
    # 也会被 RELAY_ALLOWED_SHORT_NAMES 拦截下来，防 silent bypass 复辟。
    #
    # W4.5 第三波 C1（2026-05-13）同模式继续清：REASONING / TOOL / CHUNK /
    # REVIEW_REQUIRED / TOOL_TIMEOUT / TOOL_HEARTBEAT / CONTENT_RESET /
    # TOOL_CALL_ARGS_DELTA 8 个短名同步从白名单移除——即便有人手贱重新引入
    # publisher 调用，也会被 RELAY_ALLOWED_SHORT_NAMES 拦截。
    AgentStreamEvent.AUDIT_CAP,  # ：AuditCap 生命周期事件落 TraceEvent
    AgentStreamEvent.CHECKPOINT_FAILED,
    AgentStreamEvent.CHECKPOINT_SUCCESS,
    AgentStreamEvent.LLM_REQUEST,
    AgentStreamEvent.LLM_USAGE,
    AgentStreamEvent.LLM_SNAPSHOT,  # ：LLM 快照上云（detail 异步写 chat_llm_snapshot）
    AgentStreamEvent.SUBAGENT_STARTED,
    AgentStreamEvent.SUBAGENT_PROGRESS,
    AgentStreamEvent.SUBAGENT_FAILED,
    AgentStreamEvent.SUBAGENT_COMPLETED,
    AgentStreamEvent.SUBAGENT_STREAM_EVENT,
    AgentStreamEvent.PLAN_PROPOSAL,
    AgentStreamEvent.MODE_SWITCH_PROPOSAL,
    AgentStreamEvent.MESSAGE_QUEUED,
    AgentStreamEvent.MESSAGE_DEQUEUED,
    AgentStreamEvent.USER,
    AgentStreamEvent.PERSIST_MESSAGE,  #  A1：消息级持久化（critical 同步落库，不广播）
    AgentStreamEvent.STATE_SNAPSHOT,
    AgentStreamEvent.BILLING,
    AgentStreamEvent.PERSIST_ERROR,
    # PRD 06：子 Agent 协调新增事件
    AgentStreamEvent.SUBAGENT_HITL_REQUIRED,
    AgentStreamEvent.SUBAGENT_QUEUED,
    AgentStreamEvent.SPEAKER_PUSH_MESSAGE,
    AgentStreamEvent.SUBAGENT_MODEL_CALL,
    # ── W3 Anthropic 6 件套（详见 AgentStreamEvent.MESSAGE_START 上方注释） ──
    # daemon Wave 2 已 emit；W3 让 Django relay_handler 接收 + ContentBlockReassembler
    # 消费成 chat_message.content_blocks_json 落库。
    # **content_block_delta** 频率高但被加进 EXCLUDED_FROM_TRACE 阻止后台
    # trace 写库；其余 5 件套都是低频，可以走正常 trace 写库（毕竟这些是
    # 重组关键事件，trace 上要能看到完整 6 件套时序）。
    AgentStreamEvent.MESSAGE_START,
    AgentStreamEvent.MESSAGE_DELTA,
    AgentStreamEvent.MESSAGE_STOP,
    AgentStreamEvent.CONTENT_BLOCK_START,
    AgentStreamEvent.CONTENT_BLOCK_DELTA,
    AgentStreamEvent.CONTENT_BLOCK_STOP,
})


# **绝不写入 TraceEvent 表**的事件白名单。
#
# relay_handler 在调用 `_spawn_background_trace_write` 前会 filter 掉本集合。
# 分类注意：`_classify_event` **先**判 CRITICAL_EVENT_TYPES，再判本集合——
# 因此「既 critical 又 excluded」的事件（如 content_block_delta / persist_message）
# 仍走 critical 同步写 ChatMessage，但**不会**进 TraceEvent。
#
# 设计原则：高频流式中间态、或与「一次 Agent 运行」无关的落库旁路，不进
# ExecutionTrace；只有 lifecycle / llm / tool 等运行过程才进 AdminDash 执行记录。
EXCLUDED_FROM_TRACE: frozenset[str] = frozenset({
    # ── 6 件套纯转发：不写 TraceEvent（critical∩excluded 双挂时仍可同步落库）──
    AgentStreamEvent.MESSAGE_START,
    AgentStreamEvent.MESSAGE_DELTA,
    AgentStreamEvent.MESSAGE_STOP,
    AgentStreamEvent.CONTENT_BLOCK_START,
    AgentStreamEvent.CONTENT_BLOCK_DELTA,
    AgentStreamEvent.CONTENT_BLOCK_STOP,
    # 子 Agent 内层事件会包裹同一套 message/content_block 直播事件，频率与
    # content_block_delta 同量级；保留 WS Redis buffer 续传，但不写 PG TraceEvent。
    AgentStreamEvent.SUBAGENT_STREAM_EVENT,
    # ：llm_snapshot 快照体可达数百 KB（system + messages + tools 全文），
    # 绝不进 TraceEvent / detail 通道；relay_handler 循环里单独截获，走
    # relay_llm_snapshot_writer 异步写 chat_llm_snapshot（也不广播）。
    AgentStreamEvent.LLM_SNAPSHOT,
    # ：persist_message 是 ChatMessage 落库权威（仍属 CRITICAL），但常以
    # session_id 充当 trace_id，又永不发 lifecycle/done → 在 AdminDash 留下
    # 永久「运行中」幽灵执行。故排除 TraceEvent；对话落库路径不变。
    AgentStreamEvent.PERSIST_MESSAGE,
})


class InternalStreamEvent:
    """agent_engine ↔ chat_service 内部流式事件（短名称，不直接暴露给前端）。

    编排层将其转换为 AgentStreamEvent 后通过 ChatStreamPublisher 推送。
    LIFECYCLE/STEP 复用 AgentStreamEvent 短名称以便匹配。

    Wave 6（路径权限治理 + ask_question 收敛）：删除 ``ASK_USER_REQUIRED``
    成员——云端编排已移除（Wave 11）。
    W4 R3（2026-05-11）：ask 三件套并存
    （``ask_user_required`` / ``ask_form_required`` / ``request_approval_required``）；
    本地 runtime（Daemon → relay）直接走 ``AgentStreamEvent`` 公开命名空间，
    不再经由 InternalStreamEvent 中转。
    """

    LIFECYCLE = "lifecycle"
    STEP = "step"
    ASSISTANT_DELTA = "assistant.delta"
    ASSISTANT_FINAL = "assistant.final"
    REASONING_DELTA = "reasoning.delta"
    TOOL_START = "tool.start"
    TOOL_END = "tool.end"
    TODO_UPDATE = "todo.update"
    SYSTEM_NOTICE = "system.notice"
    ERROR = "error"
    CHECKPOINT = "checkpoint"
    CONTENT_RESET = "content.reset"
    PERSIST_ERROR = "persist_error"
    RICH_CONTENT_BLOCKS = "rich_content.blocks"


# Wave 6（路径权限治理 + ask_question 收敛）：删除 ``ASK_USER_*`` 四个常量。
#
# 历史命名约定（Wave 11 之前的云端编排路径）：
#   - 产品交互名：``ask_user``
#   - 后端工具 ID：``ask_question``
#   - 流事件 / message intent：``ask_user_required``
#
# Wave 11 下线 ``/api/orchestration/agent/{invoke,review,answer}`` REST 端点后，
# 本地 runtime（Daemon → relay）改走 ``ask_choice_required`` / ``ask_form_required``
# / ``request_approval_required`` 三件套——四个旧常量随之失去全部生产方与消费方，
# Wave 6 一并清除（D3 不留兼容；pre-launch 无历史 ChatMessage.intent 数据库残留）。
#
# W4 R3（2026-05-11）：ask 三件套并存
# （``ask_user_required`` 替代旧 ``ask_choice_required``，AskUserQuestion 协议；
# ``ask_form_required`` 与 ``request_approval_required`` 是 TabTin HITL 扩展）。
# schema 见 ``packages/agent-wire/src/approval.ts``。


class FrontendDispatchEvent:
    """frontend_dispatcher 推送给前端的事件标识。"""

    FRONTEND_ACTION = "frontend_action"


class PromptForwardEvent:
    """prompt_forward_service 推送给 Daemon/Electron 的 WS message_type（完整路径）。"""

    FORWARD = "agent.prompt.forward"
    ADMITTED = "agent.prompt.admitted"
    CANCEL = "agent.prompt.cancel"
    PAUSE = "agent.prompt.pause"
    RESUME = "agent.prompt.resume"
    # W5-a（2026-05-30）：取消单个子 Agent。字面量必须正好等于 daemon 接收端
    # 等待的 ``agent.subagent.cancel``（daemon.ts case + gateway-client 入站白名单
    # + SubagentCancelPayloadSchema 三处契约都按此字面量对接），改名即断链。
    SUBAGENT_CANCEL = "agent.subagent.cancel"
    PERMISSION_RESPONSE = "agent.permission.response"
    PERMISSION_RESET_SESSION = "agent.permission.reset_session"
    PERMISSION_MODE_UPDATE = "agent.permission.mode_update"


VALID_PERMISSION_MODES: frozenset[str] = frozenset({
    "default", "auto-approve-reads", "auto-approve-edits", "full-auto",
})


class TrackerEvent:
    """Tracker WS 事件（完整路径，跨 multiagent / tracker 共享）。

    Tracker 模块波次 4 Stage 2.3 一刀切（2026-05-25）：
    - 字符串值 ``goal.*`` → ``tracker.*``
    - 类名 ``GoalEvent`` → ``TrackerEvent``
    - 删除 ``TOPIC_PREFIX``（原 ``goal.events``）—— 主 topic ``tracker.events.*``
      由 ``TrackerNotificationService.TRACKER_TOPIC_PREFIX`` 单一定义。

    单 Skill 执行模型下不再有「步骤」概念，已删除 STEP_STARTED / STEP_FINISHED /
    STEP_SUB_PROGRESS / CHECKPOINT 四个常量。前端事件订阅同步删除。
    """

    PROGRESS = "tracker.progress"
    RUN_STARTED = "tracker.run.started"
    RUN_COMPLETED = "tracker.run.completed"
    RUN_FAILED = "tracker.run.failed"
    # Module F 续作（2026-05-26）：用户主动取消时使用独立 event type，避免与
    # RUN_FAILED 共用 wire 通道。修复前 cancel_run 推 RUN_FAILED + status=cancelled
    # 的语义错位（event type 表"失败"，payload status 又表"已取消"）。
    RUN_CANCELLED = "tracker.run.cancelled"
    NOTIFICATION = "tracker.notification"
    HEALTH_ALERT = "tracker.health_alert"
    TRIGGER_FILTERED = "tracker.trigger.filtered"


class AgentActionEvent:
    """agent.action.* WS 事件（完整路径）— WS Gateway 协议层使用。"""

    REQUEST = "agent.action.request"
    RESULT = "agent.action.result"
    RESULT_OK = "agent.action.result.ok"
    APPROVAL_REQUEST = "agent.action.approval_request"
    APPROVAL_REQUEST_OK = "agent.action.approval_request.ok"
    APPROVAL_RESPONSE = "agent.action.approval_response"
    APPROVAL_RESPONSE_OK = "agent.action.approval_response.ok"
    APPROVAL_RESPONSE_NAK = "agent.action.approval_response.nak"
    APPROVAL_RESOLVED = "agent.action.approval_resolved"
    # v0.4 W2-轮 1（PRD 05 §7.3 / §8.1.2）：Agent.agent_config.approval_memo
    # 写入后广播给所有客户端，触发 generation 比对 + 按需 re-fetch。
    # 详细注释见 packages/ws-gateway-client/src/events.ts:AgentActionEvents.APPROVAL_MEMO_UPDATED。
    APPROVAL_MEMO_UPDATED = "agent.action.approval_memo_updated"
    RESOLVED = "agent.action.resolved"


class ToolDiscoveryEvent:
    """agent.tool_discovery.* WS 事件（完整路径）— 本地 AI 工具检测协议。"""

    REQUEST = "agent.tool_discovery.request"
    RESULT = "agent.tool_discovery.result"

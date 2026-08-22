"""
Conversation Models

会话和消息数据模型
"""

import uuid
from django.db import models
from django.contrib.auth import get_user_model
from django.utils import timezone

User = get_user_model()


# v0.1 宪法 §5.1：跨库软引用 LLMModel（services_llm 在 PG / conversation 在 MySQL）
# 三个字段共用同一套 factory 配置，避免硬编码 ``apps.services.llm.models`` import。
#
# 这三个 softref 显式标记 no_cascade_needed=True：LLMModel 是 admin-managed metadata
# （SceneRegistry 配置/手动停用），删除极少；即便删了，让 ChatSession.current_model_id
# 保留 stale ID 反而是审计需要——历史消息追溯当时使用的 model。
# ``[softref_no_cascade]`` 体检会因为这个标记静默；不标记的话所有 report_only softref
# 都会被报 WARNING，提示开发者"是漏注册 cascade signal 了吗？"
_LLM_TARGET = "llm.LLMModel"
_LLM_SELECT_RELATED = ("provider",)
_LLM_NO_CASCADE_REASON = (
    "LLMModel is admin-managed metadata; deletion is rare and stale model_id "
    "on historical chat is intentional for audit/replay."
)


class ChatSession(models.Model):
    """会话模型"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, verbose_name='用户')
    organization_id = models.CharField(max_length=100, verbose_name='组织ID')
    # ── 执行现场 Workspace（ 终态：会话双键「谁干 × 在哪干」）──
    # space FK 已 Drop（0066）；执行现场一律读本字段。存量由 conversation
    # 0060/0062 回填（Workspace.id 复用源 Space.id）。on_delete=SET_NULL：
    # 删现场保留对话历史。
    workspace = models.ForeignKey(
        'tabtinspace.Workspace',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column='workspace_id',
        related_name='+',
        verbose_name='执行现场',
        help_text='会话的执行现场（tabtinspace.Workspace）；在哪台设备哪个目录干活的直挂锚点。',
    )
    # ── 协作场 Project（可选）──────────────────────────────────────
    # Workspace 表示「在哪执行」，Project 表示「为哪个协作场执行」。二者不能再借用
    # 同一个 space_id 表达；个人会话没有 project，Project 会话仍必须另绑成员自己的
    # Workspace。
    project = models.ForeignKey(
        'tabtinspace.Project',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='chat_sessions',
        verbose_name='协作 Project',
        help_text='可选的协作场归属；不代表执行目录或设备。',
    )
    # ── 当前 Agent 指针（ 会话内可切换执行者）──
    # 每次发送可以显式切换本指针；下一轮默认使用当前值。历史执行者归属记录在
    # ChatMessage.agent，不随指针变化而改写。删 Agent 后保留对话历史。
    agent = models.ForeignKey(
        'agent.Agent',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column='agent_id',
        db_index=False,
        related_name='+',
        verbose_name='执行 Agent',
        help_text='会话的执行 Agent（agent.Agent）；一 Agent 管多会话的直挂锚点。',
    )
    # ── 会话级 AgentMode（ M3 IA 后端准备，audit 底稿 §6）──
    # 用户在本会话选择的交互模式（ask/agent/plan/study/yolo/group，SSoT 见
    # apps/services/agent_engine/_data/agent-mode-contract.json）。'' = 未显式
    # 设置（前端回退自身默认）。写路径：
    # - create_session（ 模板 / 客户端显式）
    # - chat.send_message 收到非空且与存量不同时
    # - update_session 可选 agent_mode（ Composer 跨端即时同步）
    #
    # 授权边界：本字段只记忆用户的模式选择，不构成授权依据。
    agent_mode = models.CharField(
        max_length=16, blank=True, default='',
        verbose_name='会话交互模式',
        help_text="会话级 AgentMode 记忆（ask/agent/plan/study/yolo/group）；空 = 未显式设置。不承载授权语义。",
    )
    target_device_id = models.CharField(
        max_length=64,
        blank=True,
        default='',
        verbose_name='目标设备 ID',
        help_text='Daemon Control 设备 ID；创建会话后冻结，空值沿用 Workspace 绑定路由。',
    )
    target_device_installation_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='目标设备安装 ID',
        help_text='Daemon Control 解析出的 Gateway 路由 ID；仅供 Django 定向投递。',
    )
    thread_id = models.CharField(max_length=255, null=True, blank=True, unique=True, verbose_name='Agent 线程ID')
    parent_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='父会话ID',
                                  help_text='子 Agent 创建的 child session 指向父会话')

    title = models.CharField(max_length=255, blank=True, verbose_name='会话标题')
    status = models.CharField(max_length=20, default='active', verbose_name='会话状态')
    is_pinned = models.BooleanField(default=False, verbose_name='是否置顶')
    pinned_at = models.DateTimeField(null=True, blank=True, verbose_name='置顶时间')
    is_paused = models.BooleanField(
        default=False,
        verbose_name='当前任务是否暂停',
        help_text='协作式暂停：当前步骤完成后在下一轮推理前挂起；resume 后继续。',
    )

    # ── 模型配置（v0.1 宪法 §5.1：services_llm 在 PG，本表在 MySQL，跨库软引用） ──
    # 之前 ForeignKey 即便加了 db_constraint=False，Django ORM 在赋值阶段仍会调
    # ``router.allow_relation`` 校验跨库关系，会被 LlmRouter 拒绝（错误：
    # ``Cannot assign LLMModel: the current database router prevents this relation``）。
    # 故彻底退化为 UUIDField + ``@property`` 软引用 accessor：
    #   - 业务赋值用 ``session.current_model_id = model_instance.id``（不再支持
    #     ``session.current_model = model_instance``——property 无 setter）
    #   - 业务读取仍可用 ``session.current_model.model_name`` 链式访问（property
    #     懒查询 LLMModel）；批量场景请先调
    #     ``attach_llm_models_to_sessions(sessions)`` 预加载，避免 N+1
    # ``db_index`` 不开（避免 Django 给 UUIDField 自动建一个新名字的 implicit index——
    # 跟 FK 时代旧 implicit index 名不一致会让 schema 漂移）；查询走下面 Meta.indexes
    # 显式声明的 ``chat_sess_curr_model_idx``。
    # 单库治理：services_llm 与 conversation 同库（PG）后恢复为物理 FK。
    # db_column 保持 current_model_id/default_model_id 不变（不动列、不动数据）；
    # db_index=False 沿用原"不开 implicit index、走 Meta.indexes"的设计；
    # on_delete=SET_NULL 对齐原软引用语义（LLMModel 极少删，删了置空、保留会话）。
    current_model = models.ForeignKey(
        _LLM_TARGET,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column='current_model_id',
        db_index=False,
        related_name='+',
        verbose_name='当前使用的模型',
        help_text='当前 LLM 模型（llm.LLMModel）'
    )
    default_model = models.ForeignKey(
        _LLM_TARGET,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column='default_model_id',
        db_index=False,
        related_name='+',
        verbose_name='会话默认模型',
        help_text='会话创建时的初始 LLM 模型（llm.LLMModel）'
    )

    # 用户在当前模型上选择的上下文档位 ID（如 'standard' / 'long_1m'）。
    # 字段语义对应 LLMModel.custom_billing_config.tiered_pricing.tiers[].id。
    # 留空 = 走默认档（is_default=True 或第一档）。
    context_tier_id = models.CharField(
        max_length=64, blank=True, default='',
        verbose_name='上下文档位ID',
        help_text='用户主动选择的上下文档位（如 1M 长上下文）；留空走模型默认档。'
    )
    model_param_overrides = models.JSONField(
        blank=True,
        default=dict,
        verbose_name='模型运行参数',
        help_text=(
            '会话级 Runtime Profile 意图(v2: thinking_mode 等)。'
            '切模型时保留意图并按新模型重解析；不持久化 resolved。'
        ),
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')
    last_message_at = models.DateTimeField(null=True, blank=True, verbose_name='最后消息时间')
    input_tokens = models.BigIntegerField(default=0, verbose_name='输入Token数')
    output_tokens = models.BigIntegerField(default=0, verbose_name='输出Token数')
    total_tokens = models.BigIntegerField(default=0, verbose_name='总Token数')
    # 缓存命中 / 写入 input tokens 会话累计——与 input/output 同路径由
    # RelayMessageWriter F() 累加。input_tokens 为「按输入计费」的非
    # cache 部分，缓存单价不同故单列，不并入 input_tokens / total_tokens。
    cache_read_input_tokens = models.BigIntegerField(default=0, verbose_name='缓存命中Token数')
    cache_creation_input_tokens = models.BigIntegerField(default=0, verbose_name='缓存写入Token数')
    # DEPRECATED (2026-05-10) — messages-as-truth 改造后此字段无消费方：
    #
    # 历史上由 Django 编排层（services/agent_engine `persist_token_usage_effects`）
    # 在每次 LLM 调用结束时 SET 写入 = 最近一次 input_tokens（语义：当前送进
    # LLM 的真实上下文规模）。`fdacd48de` 编排迁移到本地 agent-runtime 时，
    # 这个写入路径被一并删除（RelayMessageWriter 只复刻了 input/output/total
    # 的 F() 累加），导致此字段长期为 0、前端 TokenUsageRing 永远不显示。
    #
    # 前端不再读这个字段——
    # contextTokens 直接从 ChatMessage.metadata 的 `last_input_tokens` /
    # `last_cache_read_input_tokens` / `last_cache_creation_input_tokens`（来自
    # runtime `state._lastUsageAnchor`）派生。详见
    # `apps/tabtin-electron/.../utils/chatMessageContextUsage.ts`。
    #
    # 因此此字段当前**无消费方**——保留只是为了向后兼容（不破坏 API schema /
    # 历史数据迁移），新代码请勿读取或写入。如未来确认无任何下游依赖，可走
    # 一次 deprecation migration 删字段。
    context_tokens = models.IntegerField(default=0, verbose_name='上下文Token数')
    compaction_count = models.IntegerField(default=0, verbose_name='压缩次数')
    last_compaction_at = models.DateTimeField(null=True, blank=True, verbose_name='最后压缩时间')

    # Memory v2 — 增量提取与空闲结算
    memory_extracted_index = models.IntegerField(
        default=0, verbose_name='记忆已提取消息游标',
        help_text='L2 增量提取的消息索引游标，仅处理此索引之后的新消息',
    )
    memory_settled = models.BooleanField(
        default=False, verbose_name='记忆已完整结算',
        help_text='L4 空闲结算完成后标记为 True',
    )
    memory_quick_settled = models.BooleanField(
        default=False, verbose_name='记忆已快速结算',
        help_text='新 session 首条消息时对前序未结算 session 做的轻量结算标记',
    )

    # Fork（会话分叉）
    forked_from_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        verbose_name='源会话ID',
        help_text='Fork 创建时记录来源 session，用于 UI 展示分叉关系',
    )
    fork_point_message_id = models.UUIDField(
        null=True, blank=True,
        verbose_name='分叉点消息ID',
        help_text='Fork 时的最后一条消息 ID（源 session 中的 message PK）',
    )
    FORK_COPY_STATUS_CHOICES = (
        ('pending', '复制中'),
        ('complete', '已完成'),
        ('failed', '复制失败'),
    )
    fork_copy_status = models.CharField(
        max_length=16,
        choices=FORK_COPY_STATUS_CHOICES,
        null=True,
        blank=True,
        verbose_name='Fork 消息复制状态',
        help_text='大 fork 异步复制进度；null 表示同步 fork 或非 fork 会话',
    )

    # 软回滚状态（非空时表示会话处于已回滚、待清理状态）
    revert_message_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        verbose_name='回滚点消息ID',
        help_text='非空时表示会话处于已回滚状态，该 ID 为回滚的目标消息',
    )
    revert_snapshot_hash = models.CharField(
        max_length=64, null=True, blank=True,
        verbose_name='回滚前快照哈希',
        help_text='回滚前创建的 safety checkpoint hash，用于 unrevert 时恢复文件',
    )
    revert_state_index = models.IntegerField(
        null=True, blank=True,
        verbose_name='回滚目标PG状态索引',
        help_text='cleanup 时用于截断 ConversationState.messages_json 的索引',
    )
    revert_at = models.DateTimeField(
        null=True, blank=True,
        verbose_name='回滚时间',
    )
    revert_resource_state = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='回退前的资源版本状态',
        help_text='记录 rollback_resources 执行前各资源的当前版本 ID，用于 unrevert 时反向恢复',
    )
    revert_history = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='回退操作历史',
        help_text='按时间顺序记录本 session 的每次回退/撤销回退操作，格式: [{type, target_message_id, snapshot_hash, messages_removed, resources, created_at}, ...]',
    )

    # ── 标题生成状态（防"无标题对话"批量出现） ──
    # 历史上 spawn_title_thread 用 daemon thread + fire-and-forget，进程重启 / LLM 抖动
    # 都会导致标题生成静默失败，没有任何重试或可观测性。新方案改成 Celery task
    # (conversation.generate_session_title) + 这两个字段做"重试游标"：
    #   - in_progress: 已入队、未完成
    #   - failed: 多轮 Celery retry 用完仍失败；backfill_session_titles 周期任务会捞起重试
    #   - done: 真正生成成功；should_generate_title 返回 False 时也会被标成 done
    # 默认 pending，新 session 创建时还没入队。
    TITLE_GENERATION_STATUS_CHOICES = (
        ('pending', '待生成'),
        ('in_progress', '生成中'),
        ('done', '已完成'),
        ('failed', '生成失败'),
    )
    title_generation_status = models.CharField(
        max_length=16,
        choices=TITLE_GENERATION_STATUS_CHOICES,
        default='pending',
        verbose_name='标题生成状态',
        help_text='驱动 conversation.backfill_session_titles 周期补偿，避免 daemon thread 时代的"无标题对话"问题',
    )
    title_generation_failed_at = models.DateTimeField(
        null=True, blank=True,
        verbose_name='标题生成失败时间',
        help_text='最近一次失败的时间戳；done 后清空',
    )

    # 任务列表锚点「主工作面」：由执行事实 / 冷启动弱信号更新，不是 UI 焦点。
    # wire: chat | doc | browser | code；table 产物归并进 doc。见 session_surface_policy。
    primary_surface = models.CharField(
        max_length=16,
        default='chat',
        db_index=False,
        verbose_name='主工作面',
        help_text='任务列表锚点：chat/doc/browser/code；由执行事实更新，非 UI 焦点。',
    )

    class Meta:
        db_table = 'chat_session'
        verbose_name = '聊天会话'
        verbose_name_plural = '聊天会话'
        # 注：这是 fallback 排序，admin / shell 这种没显式 order_by 的场景用。
        # 业务视图（list_sessions / list_all_sessions / sidebar 显示）必须显式
        # 用 ``Coalesce('last_message_at', 'updated_at').desc()``——后端
        # ``update_last_message_time()`` 只 bump ``last_message_at`` 不动
        # ``updated_at``，按 ``updated_at`` 排会让"今天发新消息的旧会话"留在
        # 旧时间分组里（见 chat-session-sort.ts 同源注释）。
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['user', '-updated_at']),
            models.Index(fields=['organization_id', '-updated_at']),
            models.Index(fields=['workspace', '-updated_at'], name='chat_sess_ws_updated_idx'),
            models.Index(fields=['current_model'], name='chat_sess_curr_model_idx'),
            models.Index(
                fields=['workspace', 'memory_settled', '-updated_at'],
                name='idx_session_memory_settle_ws',
            ),
            models.Index(
                fields=['workspace', 'memory_quick_settled', '-updated_at'],
                name='idx_session_quick_settle_ws',
            ),
            # 配合 conversation.backfill_session_titles 周期扫描的 WHERE 条件：
            #   status='active' AND title_generation_status IN (...) AND last_message_at < ...
            # 没有这个复合索引会全表 filesort——dev 阶段无所谓，生产规模一上来每
            # 30 分钟一次扫描会非常贵。
            models.Index(
                fields=['status', 'title_generation_status', '-last_message_at'],
                name='chat_sess_title_backfill_idx',
            ),
        ]

    def save(self, *args, **kwargs):
        if not self.thread_id:
            if not self.id:
                import uuid as _uuid
                self.id = _uuid.uuid4()
            self.thread_id = f"chat-session-{self.id}"
        super().save(*args, **kwargs)

    def __str__(self):
        return f"Session {self.id} - {self.user.username}"

    # current_model / default_model 现为物理 FK（见上字段定义）；
    # 旧链式访问 ``session.current_model.model_name`` 与赋值 ``session.current_model_id = x``
    # 均由 FK 原生支持。批量场景用 ``attach_llm_models_to_sessions(sessions)`` 预填 FK 缓存
    # （内部走 select_related 同款 set_cached_value，避免 N+1）。

    @property
    def effective_thread_id(self) -> str:
        """返回确定性的 thread_id，不触发数据库写入。"""
        return self.thread_id or f"chat-session-{self.id}"

    def update_last_message_time(self):
        self.last_message_at = timezone.now()
        self.save(update_fields=['last_message_at'])
        from .services.session_activity_publisher import publish_session_activity
        publish_session_activity(self, reason="message")

    def append_revert_history(self, entry: dict, max_entries: int = 50) -> None:
        """向回退历史追加一条记录，并裁剪到固定长度。"""
        history = list(self.revert_history or [])
        history.append(entry)
        self.revert_history = history[-max_entries:]


class ChatMessage(models.Model):
    """消息模型（W3 Anthropic ContentBlock 协议对齐版）。

    v3 §3.3.1 字段重做：blocks_json / content / attachments_json / agent_type /
    intent / intent_confidence / error_code / blocks_trimmed_at 全部下线，统一
    收口为 content_blocks_json（Anthropic ContentBlock[] 形态）+ 顶层结构化
    元字段（text_summary / error_info_json / usage_json / model_name_snapshot /
    stop_reason / subagent_run_id / checkpoint_anchor_block_*）。

    Migration 0038（一步到位）：drop 老字段 + add 新字段。产品未上线，无历史
    用户数据要保护——Migration RunPython 会 TRUNCATE chat_message + 关联 PG
    conversation_state 表，确保格式干净不留 v1/v2 漂移残留。
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(ChatSession, on_delete=models.CASCADE, related_name='messages', verbose_name='所属会话')
    agent = models.ForeignKey(
        'agent.Agent',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        verbose_name='本轮执行 Agent',
        help_text='assistant/tool_artifact 消息的实际执行者；历史归属不随会话当前指针变化。',
    )

    role = models.CharField(max_length=20, verbose_name='角色')  # user/assistant/system/tool
    trace_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='Trace ID')

    # ── 协议层 message_kind：ChatMessage 语义类型显式标记 ────────────────────
    # 取代旧"model_id 字面量 + synthetic 隐式判别"的协议层 hack——daemon wire
    # `MessageStartSchema.message_kind` 必填三档，reassembler `_on_message_start`
    # 直读 evt.message_kind.value 到 state.message_kind，落库时本字段 = state.message_kind。
    #
    # 三档语义（与 wire `MessageKindSchema` 严格对齐）：
    #   - 'llm'           主 LLM 真实输出（最常见）：含 thinking / text / tool_use 等 block；
    #                     含子 Agent 主消息（subagent_run_id 区分，不变 kind）
    #   - 'tool_artifact' 工具产物气泡（daemon emitDetachedMiniMessage 路径）：承载
    #                     tabtin_rich_content 块（widget / search_results / cli_output_*
    #                     / present_to_user 子卡 / document_excerpt / memory_card 等 10
    #                     类，展示形态由 tabtin_rich_content.kind 决定，前端 RichKindRouter
    #                     二级路由）。前端走"产物气泡"紧凑形态：无 footer / 无 MessageActions
    #   - 'error_envelope' 自合成错误文案气泡（daemon `emitAssistantErrorMessageEnvelope`
    #                      路径）：承载 text block，UI 显示时间戳 + 复制按钮，跳过
    #                      thinking placeholder + 跳过 MessageCostLabel
    #
    # 持久化策略说明：daemon 主循环 push 的 role=user + 含 tool_result block 的合成
    # 消息走"合并到对应 assistant"路径（reassembler `_merge_tool_results_into_assistants`），
    # **不会**作为独立 ChatMessage 落表——所以本字段实际可见的只有 3 类。
    #
    # default='llm'：迁移老数据时自动覆盖（W3 之前 ChatMessage 全是 LLM 主消息）。
    #
    # **2026-05-23 dogfood 复盘**：原注释「mini-message 因 Django reassembler bug
    # 跳过落库已永久丢失」把这件事当成"老数据"问题。实际上根因在 daemon 端
    # `EnvelopeEmitter.emitDetachedMiniMessage` 默认 messageId 用了
    # `` `msg_inline_${nodeRandomUUID()}` `` 加前缀形态——下游
    # `relay_message_writer.py:702-708` `uuid.UUID(message_id)` 校验失败 →
    # silently skip → **每条新 widget / search_results / cli_output 都在丢**
    # （不是只有老数据）。修复见 packages/agent-runtime/src/engine/envelope-emitter.ts
    # 把 default 改成 `nodeRandomUUID()`（与 query.ts 主消息路径同款）。修复前
    # 的对话历史里 mini-message 已无法找回，但修复后新对话能正确落库。
    message_kind = models.CharField(
        max_length=24,
        choices=[
            ('llm', 'LLM Output'),
            ('tool_artifact', 'Tool Artifact'),
            ('error_envelope', 'Error Envelope'),
            # ：environment_context —— 每轮 <context type="environment"> 环境快照
            # 作为独立 immutable 历史块落库（role=system），稳定跨轮 prompt cache 前缀；
            # 对用户 UI 隐藏（前端过滤），仍喂给 LLM 作历史。
            ('environment_context', 'Environment Context'),
            # ：agent_profile_context —— 内容变化时注入的
            # <context type="agent-profile">（personal_rules / custom_rules 等），
            # role=system 落库；UI 隐藏；发给 LLM 时历史多份 keep-latest。
            ('agent_profile_context', 'Agent Profile Context'),
            # system_prompt_context —— 每轮实际生效的 system prompt 快照；
            # role=system 落库；UI 隐藏；#8550 起不进 LLM 历史（仅审计 / 导出回退）。
            ('system_prompt_context', 'System Prompt Context'),
            ('compaction_summary', 'Compaction Summary'),
            # ：hitl_interaction —— 审批 / 追问的对话内持久化事实（由
            # pending_interaction_service 与 PendingInteraction 同事务写入）。
            # metadata.hitl 承载 { kind, request_key, status, payload, ... }；
            # 状态翻转（pending→resolved/expired）靠 updated_at 随增量 sync 到达
            # 所有端，前端面板据此开/清。UI 消息流隐藏；绝不进 LLM 历史。
            ('hitl_interaction', 'HITL Interaction'),
            ('external_archive_context', 'External Archive Context'),
        ],
        default='llm',
        verbose_name='消息语义类型',
        help_text=(
            'ChatMessage 语义类型——区分 LLM 输出 / 工具产物气泡 / 错误文案。'
            '替换原来用 model_id 字面量 + synthetic 隐式判别的协议层 hack。'
            'daemon 主循环 push 的 role=user + 含 tool_result block 的合成消息走合并路径，'
            '不会作为独立 ChatMessage 落表（在 reassembler 层合并到对应 LLM 消息）。'
        ),
    )

    # ── W3 §3.3.1 核心字段：Anthropic ContentBlock[] ────────────────────
    # blocks_json + attachments_json + content 三件套合并为 content_blocks_json
    # 单一字段。所有结构化消息内容（text / tool_use / tool_result / thinking /
    # image / document / tabtin_* 等 25+ 块类型）由其承载。schema 见
    # apps/services/wire_generated/any_event.py 的 ContentBlock RootModel。
    content_blocks_json = models.JSONField(
        default=list, blank=True,
        verbose_name='ContentBlock 数组',
        help_text='严格按 Anthropic ContentBlock[] schema（v3 §2.2）；含 text / '
                  'tool_use / tool_result / thinking / image / document / '
                  'tabtin_* 等所有结构化块类型',
    )

    # ── W3 兜底/搜索字段：text_summary ─────────────────────────────────
    # 由 ContentBlockReassembler 在 message_stop 时反推（join content_blocks 中
    # 所有 text 块前 200 字）。供会话列表 summary_only 模式 / 全文搜索 / 兜底
    # 渲染（所有 ContentBlock 类型未识别时的 fallback）使用。
    text_summary = models.TextField(
        blank=True, default='',
        verbose_name='文本摘要',
        help_text='content_blocks_json 中 text 块前 200 字的拼接，用于会话列表 / 全文搜索',
    )

    # ── W3 §3.3.1 结构化元字段 ────────────────────────────────────────
    error_info_json = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='结构化错误信息',
        help_text='ErrorInfo: { error_class, error_message, suggested_action, '
                  'category: aborted/timeout/protocol_error/runtime_failed/budget_exceeded }',
    )
    usage_json = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='Token 用量',
        help_text='TokenUsage: { input_tokens, output_tokens, '
                  'cache_creation_input_tokens?, cache_read_input_tokens? }；'
                  'Anthropic 协议 cumulative 语义（已是最终值，消费方不要再累加）',
    )
    model_name_snapshot = models.CharField(
        max_length=100, blank=True, default='',
        verbose_name='模型名称快照',
        help_text='写盘瞬间的 LLMModel.display_name，与 model_id 双写防 LLMModel '
                  '后续重命名导致历史回看错',
    )
    stop_reason = models.CharField(
        max_length=32, blank=True, default='',
        verbose_name='结束原因',
        help_text='end_turn / max_tokens / tool_use / stop_sequence / aborted / '
                  'pause_turn / refusal / error 等（开放枚举，与 Anthropic 协议对齐）',
    )
    subagent_run_id = models.CharField(
        max_length=64, blank=True, default='',
        verbose_name='子 Agent run ID',
        help_text='识别本消息是否来自 subagent（非空时）；与 SubtaskRun.subagent_run_id 关联',
    )

    # ── W3 §3.3.1 Checkpoint block 粒度锚点 ──────────────────────────
    # 与 checkpoint_hash + checkpoint_state_index 组成"双锚定"——即便后续
    # ContentBlock trim / 重排，仍能通过 block_id 精确定位锚点 block。
    checkpoint_anchor_block_id = models.CharField(
        max_length=64, blank=True, default='',
        verbose_name='Checkpoint 锚点 block ID',
        help_text='Checkpoint 落地瞬间该消息内某个 block 的 block_id 锚点，'
                  '配合 checkpoint_anchor_block_index 防 trim 重排错位',
    )
    checkpoint_anchor_block_index = models.IntegerField(
        null=True, blank=True,
        verbose_name='Checkpoint 锚点 block index',
        help_text='锚点 block 在 content_blocks_json 数组中的 index（双锚定）',
    )
    content_blocks_trimmed_at = models.DateTimeField(
        null=True, blank=True, default=None, db_index=True,
        verbose_name='content_blocks_json 瘦身时间',
        help_text='非空表示 content_blocks_json 已被定时任务瘦身（thinking / '
                  'tool_use.input / tool_result.content 等大字段被截断为 head + tail）',
    )

    # ── 模型信息：单库治理后恢复为物理 FK（同 ChatSession.current_model 设计） ──
    # db_column=model_id 保列名不动数据；db_index=False 走 Meta.indexes 的
    # chat_msg_model_id_idx；on_delete=SET_NULL 对齐原软引用语义。
    model = models.ForeignKey(
        _LLM_TARGET,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column='model_id',
        db_index=False,
        related_name='+',
        verbose_name='使用的模型',
        help_text='生成此消息的 LLM 模型（llm.LLMModel）'
    )

    # 检查点数据（仅 assistant 消息在 agent run 完成后设置）
    checkpoint_hash = models.CharField(
        max_length=64, null=True, blank=True, db_index=True,
        verbose_name='检查点哈希',
        help_text='Shadow Git commit hash，标识该消息对应的文件快照',
    )
    checkpoint_state_index = models.IntegerField(
        null=True, blank=True,
        verbose_name='检查点状态索引',
        help_text='创建检查点时 ConversationState.messages_json 的长度',
    )
    diff_summary = models.JSONField(
        null=True, blank=True,
        verbose_name='文件变更摘要',
        help_text='Shadow Git 计算的文件变更摘要，包含 changed/insertions/deletions/files 等信息',
    )
    changed_files = models.JSONField(
        null=True, blank=True,
        verbose_name='变更文件列表',
        help_text='该 checkpoint 关联的变更文件路径数组，由 Agent Turn 执行期间收集',
    )

    agent_run_id = models.CharField(
        max_length=64, blank=True, default='', db_index=True,
        verbose_name='Agent Run ID',
        help_text='关联的 Agent Run ID，用于按 run 聚合消息与资源变更',
    )

    sender_user_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        db_index=True,
        verbose_name='消息发送者用户ID',
    )

    metadata = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='消息元数据',
        help_text='存储 credits_consumed / source / 旧 agent_type / intent 等附加信息；'
                  'W3 后老字段并入此处兜底（结构化字段优先用顶层 stop_reason / '
                  'usage_json / error_info_json / subagent_run_id）',
    )

    client_event_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        verbose_name='客户端事件 ID',
        help_text='relay_events 上行的幂等去重键，由客户端 RelayBuffer 生成',
    )

    # ──  引用回复：被引用的消息 + 展示快照 ──────────────────────────
    # 「一份数据、两种消费」：
    #   - reply_to：指向被引用的 ChatMessage（是谁）。on_delete=SET_NULL——被引用
    #     消息被回退 / 删除时，引用方不连带消失，只是失去跳转目标（气泡靠 preview
    #     兜底显示）。
    #   - reply_to_preview：从被引用消息派生的轻量快照（当时说了啥），供气泡渲染
    #     引用条——被引用消息可能已滚出加载窗口 / 被 trim / 被删，有快照就永远
    #     显示得出来，不用额外查询。形态：{ role, author, text }。
    # 注意：给 LLM 看的注入（<context type="quoted-message">）是发送时从被引用消息
    # 实时派生的临时 prompt 拼接，不落库——不存在「两处数据不一致」。
    reply_to = models.ForeignKey(
        'self',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='replies',
        verbose_name='引用的消息',
        help_text='本消息「引用回复」指向的被引用 ChatMessage；被引用消息删除时置 NULL',
    )
    reply_to_preview = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name='被引用消息快照',
        help_text='被引用消息的展示快照 { role, author, text }，供气泡引用条渲染；'
                  '与被引用消息同源，被引用消息删除后仍可显示',
    )

    # ──  对话时间权威 ────────────────────────────────────────────
    # runtime emit 时分配的单调 epoch 微秒，是消息在**对话中**的真实
    # 时间；created_at 只是落库时间——relay 迟到重投 / RelayRetryQueue recover
    # 场景下二者可以完全颠倒。回退边界（preview / 可见性过滤 / cleanup）以本
    # 字段为准（NULL = legacy 行，回落 created_at），见
    # services/conversation_time.py。
    arrival_seq = models.BigIntegerField(
        null=True, blank=True, default=None,
        verbose_name='对话时间序（epoch 微秒）',
        help_text='agent-runtime emit 分配的单调对话时间；回退边界的权威时间轴，'
                  'NULL 表示 legacy 行（边界计算回落 created_at）',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'chat_message'
        verbose_name = '聊天消息'
        verbose_name_plural = '聊天消息'
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['session', 'created_at']),
            # ：回退边界按对话时间过滤（session 内 arrival_seq 范围查询）
            models.Index(fields=['session', 'arrival_seq'], name='chat_msg_sess_arrival_idx'),
            models.Index(fields=['session', 'updated_at', 'id'], name='chat_msg_sess_updated_idx'),
            models.Index(fields=['role', 'created_at']),
            models.Index(fields=['model'], name='chat_msg_model_id_idx'),
            models.Index(fields=['checkpoint_hash'], name='chat_msg_ckpt_hash_idx'),
            # W3 §3.3.1 新增复合索引（会话维度 + 时间序 + 角色过滤）
            models.Index(fields=['session', 'created_at', 'role'], name='chat_msg_sess_time_role_idx'),
        ]
        constraints = [
            # 去掉 partial condition（W036：MySQL 不支持 conditional unique）。
            # 两库默认行为已经满足"NULL 不参与唯一比较"——MySQL UNIQUE 对多个 NULL
            # 视为不冲突，PostgreSQL 同样默认 NULLS DISTINCT。所以普通 UniqueConstraint
            # 跨库语义等价于原来的 partial 条件，但这次 MySQL 也会真正创建索引，
            # `_upsert_chat_message` 依赖的 IntegrityError 幂等路径在双库都能触发。
            models.UniqueConstraint(
                fields=['session', 'client_event_id'],
                name='uq_session_client_event_id',
            ),
        ]

    def __str__(self):
        return f"{self.role}: {(self.text_summary or '')[:50]}"



class ChatContext(models.Model):
    """
    会话上下文模型 - 阶段4.5新增

    存储会话的上下文信息，帮助AI理解当前对话的环境
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.OneToOneField(ChatSession, on_delete=models.CASCADE, related_name='context', verbose_name='所属会话')

    # 当前关注的对象
    current_space_id = models.CharField(max_length=100, blank=True, verbose_name='当前 Space ID')
    # 协作 Project 与当前资源宿主分开存：前者回答「为哪个协作场工作」，后者回答
    # 「用户正在看哪个资源」。数据库列名保持 current_project_id，便于 API / runtime
    # 直接传递，删除 Project 时保留聊天记录与其余资源上下文。
    current_project = models.ForeignKey(
        'tabtinspace.Project',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
        verbose_name='当前协作 Project',
    )
    current_table_id = models.CharField(max_length=100, blank=True, verbose_name='当前表格ID')
    current_view_id = models.CharField(max_length=100, blank=True, verbose_name='当前视图ID')

    # 最近访问的对象（JSON存储列表）
    recent_spaces = models.JSONField(default=list, verbose_name='最近 Space 列表')
    recent_tables = models.JSONField(default=list, verbose_name='最近表格列表')
    recent_views = models.JSONField(default=list, verbose_name='最近视图列表')

    # 其他上下文信息
    context_data = models.JSONField(default=dict, verbose_name='其他上下文数据')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'chat_context'
        verbose_name = '会话上下文'
        verbose_name_plural = '会话上下文'
        indexes = [
            models.Index(fields=['current_space_id']),
            models.Index(fields=['current_table_id']),
        ]

    def __str__(self):
        return f"Context for Session {self.session_id}"

    def add_recent_space(self, space_id: str, max_count: int = 5):
        """添加到最近 Space 列表"""
        if space_id in self.recent_spaces:
            self.recent_spaces.remove(space_id)
        self.recent_spaces.insert(0, space_id)
        self.recent_spaces = self.recent_spaces[:max_count]
        self.save(update_fields=['recent_spaces', 'updated_at'])

    def add_recent_table(self, table_id: str, max_count: int = 10):
        """添加到最近表格列表"""
        if table_id in self.recent_tables:
            self.recent_tables.remove(table_id)
        self.recent_tables.insert(0, table_id)
        self.recent_tables = self.recent_tables[:max_count]
        self.save(update_fields=['recent_tables', 'updated_at'])

    def set_current_table(self, table_id: str, space_id: str = None):
        """设置当前表格（同时更新到最近列表）"""
        self.current_table_id = table_id
        if space_id:
            self.current_space_id = space_id
            self.add_recent_space(space_id)
        self.add_recent_table(table_id)

    def clear_current(self):
        """清除当前上下文"""
        self.current_space_id = ""
        self.current_table_id = ""
        self.current_view_id = ""
        self.save(update_fields=['current_space_id', 'current_table_id', 'current_view_id', 'updated_at'])


class EngineRuntimeConfig(models.Model):
    """Agent 引擎运行时参数（pk=1 单例，取代旧 chat 全局配置 中的运行时参数子集）。"""

    id = models.IntegerField(primary_key=True, default=1)

    engine_max_iterations = models.IntegerField(default=25)
    engine_task_max_iterations = models.IntegerField(default=15)
    engine_max_tool_calls = models.IntegerField(default=10)
    engine_task_timeout = models.IntegerField(default=300)
    engine_subagent_timeout = models.IntegerField(default=120)
    engine_max_plan_steps = models.IntegerField(default=5)
    engine_allow_clarification = models.BooleanField(default=True)

    #  第三波：ctx_* 三档阈值经 prompt_forward_service 下发到宿主
    # EngineConfig.pressureThresholds（云端 > env > runtime 默认）。语义映射：
    #   ctx_pressure_high            → microCompactStart（微压缩起点）
    #   ctx_summary_trigger_fraction → llmSummaryStart（摘要档起点）
    #   ctx_pressure_critical        → emergencyStart（紧急档起点，默认对齐
    #                                  runtime 0.95，migration 0054 统一口径）
    # 原 ctx_pressure_medium（无对应档位）与 ctx_summary_keep_messages /
    # ctx_emergency_keep_messages（本地已改动态保尾）随 0054 删除。
    ctx_default_window_tokens = models.IntegerField(default=200_000)
    ctx_pressure_high = models.FloatField(default=0.75)
    ctx_pressure_critical = models.FloatField(default=0.95)
    ctx_summary_trigger_fraction = models.FloatField(default=0.85)

    guard_doom_loop_warn = models.IntegerField(default=3)
    guard_doom_loop_break = models.IntegerField(default=5)
    guard_tool_output_max_chars = models.IntegerField(default=50_000)
    guard_max_compaction_attempts = models.IntegerField(default=2)

    feat_parallel_tool_execution = models.BooleanField(default=False)
    feat_tool_cache_enabled = models.BooleanField(default=True)
    feat_tool_cache_max_entries = models.IntegerField(default=64)

    subagent_max_active = models.IntegerField(default=2)
    subagent_queue_limit = models.IntegerField(default=20)
    subagent_global_queue_limit = models.IntegerField(default=200)

    cleanup_trace_retention_days = models.IntegerField(default=14)
    cleanup_stale_subagent_minutes = models.IntegerField(default=5)
    cleanup_blocks_retention_hours = models.IntegerField(default=24)
    # ：LLM 调用快照（chat_llm_snapshot）保留天数。快照含 system prompt /
    # 工具 schema 全文，属调试观测数据，与对话正文生命周期解耦、到期清理。
    cleanup_llm_snapshot_retention_days = models.IntegerField(default=90)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'chat_engine_runtime_config'
        verbose_name = 'Engine 运行时配置'
        verbose_name_plural = 'Engine 运行时配置'

    def __str__(self):
        return f"EngineRuntimeConfig (pk={self.id})"

    @classmethod
    def get_config(cls) -> 'EngineRuntimeConfig':
        """获取单例配置（不存在则自动创建，pk=1）。"""
        config, _ = cls.objects.get_or_create(pk=1)
        return config


class PendingToolResult(models.Model):
    """tool_result 暂存表——根治"工具结果与对应 assistant 消息落库乱序/竞态导致永久丢失"。

    **背景**：daemon 工具执行结果通过合成 user message（含 tool_result block）经
    relay → reassembler 合并进对应 assistant `ChatMessage.content_blocks_json`
    （`_merge_tool_results_into_assistants`）。该合并依赖"目标 assistant message
    已落库"——但实战里存在三种竞态会让目标当时不存在：

      1. **乱序**：承载 tool_result 的 user message 比承载 tool_use 的 assistant
         message 先到 Django（relay/批次顺序无强保证）。
      2. **assistant 落库失败重试**：assistant 这批 DB 写失败 state 保留待重试，
         而 tool_result 那批已处理。
      3. **慢命令**：60s 后台命令的 tool_result 远晚于 assistant 到达。

    旧实现在"找不到目标"时仅 `log.warning` **丢弃**，刷新页面后历史回放（走
    `messages.list` 读 `content_blocks_json`）永久看不到结果，前端显示
    "结果正在同步…"。

    本表把这类 tool_result **持久暂存**，由两道防线 drain 补合并：
      - **写时补偿**：对应 assistant message 落库时回查本表（`drain_for_message`）。
      - **读时自愈**：`messages.list` 返回前对"有 tool_use 缺 tool_result"的
        assistant message 兜底补齐（最后防线）。
    合并成功后删除对应行——本表只承载"在途未配对"的 tool_result，稳态为空。

    **幂等**：`(session_id, agent_run_id, tool_use_id)` 唯一——daemon retry /
    WS replay 撞同一 tool_use_id 时 `update_or_create` 覆盖，不产生重复。
    """

    id = models.BigAutoField(primary_key=True)
    session_id = models.CharField(
        max_length=64, db_index=True, verbose_name='会话 ID',
        help_text='ChatSession.id（UUID 字符串软引用，不建 FK——临时数据避免级联约束）',
    )
    agent_run_id = models.CharField(
        max_length=64, blank=True, default='', db_index=True, verbose_name='Agent Run ID',
        help_text='合成 user message 的 run_id（= 对应 assistant ChatMessage.agent_run_id），'
                  '与 tool_use_id 组合在同一 run 内唯一定位 tool_use',
    )
    tool_use_id = models.CharField(
        max_length=128, verbose_name='tool_use ID',
        help_text='对应 tool_use block 的 id（daemon per-run counter，如 run_terminal_command:25）',
    )
    block_json = models.JSONField(
        verbose_name='tool_result block',
        help_text='完整的 Anthropic tool_result ContentBlock dict '
                  '（{type, tool_use_id, content, is_error?}），合并时整体 append 进目标消息',
    )
    is_error = models.BooleanField(
        default=False, verbose_name='是否错误结果',
        help_text='冗余 block_json.is_error，便于不解 JSON 直接统计/排障',
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'chat_pending_tool_result'
        verbose_name = '待合并工具结果'
        verbose_name_plural = '待合并工具结果'
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['session_id', 'agent_run_id'], name='pending_tr_sess_run_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['session_id', 'agent_run_id', 'tool_use_id'],
                name='uq_pending_tool_result',
            ),
        ]

    def __str__(self):
        return f"PendingToolResult(session={self.session_id} run={self.agent_run_id} tool={self.tool_use_id})"


class ChatLLMSnapshot(models.Model):
    """LLM 调用快照——本地 snapshots.jsonl 的云端副本。

    runtime 每次真实调用 LLM 前产出 `LLMCallSnapshot`（system prompt 分段 +
    messages 摘要 + 工具完整 inputSchema + 事后补发的 response 元信息），本地
    落 `snapshots.jsonl`，经 relay `agent.stream.llm_snapshot`（detail 级，
    异步写、失败不阻塞对话）同步到本表。用途：跨设备排障「当时真发给模型
    什么」；不是对话正文，不进 messages.list。

    **敏感性**：含内部 system prompt 与工具 schema 全文——只允许本人 /
    管理端读取，不进任何 WS 广播 topic；按
    `EngineRuntimeConfig.cleanup_llm_snapshot_retention_days`（默认 90 天）
    由 Celery 定时清理。

    **幂等**：`(session_id, run_id, iteration)` 唯一——relay 重试 / 回补重放
    同一次调用时 `update_or_create` 覆盖（response 补发场景同样命中该键，
    带 response 的后到快照覆盖先到的纯请求快照）。

    **软引用 session**：与 PendingToolResult 同理——观测旁路数据不建 FK，
    避免会话删除级联扫大表；清理任务独立按时间批删。
    """

    id = models.BigAutoField(primary_key=True)
    session_id = models.CharField(
        max_length=64, db_index=True, verbose_name='会话 ID',
        help_text='ChatSession.id（UUID 字符串软引用，不建 FK）',
    )
    thread_id = models.CharField(
        max_length=128, blank=True, default='', verbose_name='线程 ID',
        help_text='runtime 侧业务 thread id（与本地 snapshots.jsonl 目录对齐）',
    )
    run_id = models.CharField(
        max_length=64, verbose_name='Run ID',
        help_text='本次 query 的 runId（= trace_id），与 iteration 组合唯一定位一次 LLM 调用',
    )
    iteration = models.IntegerField(default=0, verbose_name='迭代序号')
    model = models.CharField(
        max_length=128, blank=True, default='', verbose_name='模型',
    )
    snapshot_json = models.JSONField(
        verbose_name='快照体',
        help_text='LLMCallSnapshot 完整体（system sections / messages 摘要 / '
                  'tools schema / response 元信息）；客户端超限时按字段截断并带 '
                  'truncated 标记',
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'chat_llm_snapshot'
        verbose_name = 'LLM 调用快照'
        verbose_name_plural = 'LLM 调用快照'
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['session_id', 'created_at'], name='llm_snap_sess_created_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['session_id', 'run_id', 'iteration'],
                name='uq_llm_snapshot_call',
            ),
        ]

    def __str__(self):
        return f"ChatLLMSnapshot(session={self.session_id} run={self.run_id} iter={self.iteration})"


class SessionShare(models.Model):
    """会话共享授权（ 共享 Agent 任务，文档协同式）。

    owner 把自己的一条 ChatSession 授权给同 Organization 的另一个用户，
    grantee 进入 owner 的**同一个会话**（组织内全量透明）：
    - **查看**（基础能力，授权即有）：经主鉴权
      ``_get_session_with_shared_access`` / ``user_can_access_session`` 第三分支
      放行——读端点 + WS 实时流全量可见（过程 / 工具 / 产物）。
    - **fork**（can_fork 叠加位）：把快照（正文 + 工具名 + 附件引用）抄写成
      接收人自己的 Agent × Workspace 新会话（见 services/session_materializer.py）。
    - **对话**（can_chat 叠加位）：发言驱动——grantee 经 shared-chat 端点在
      本会话发消息驱动 Agent；执行在 owner 设备、费用归 owner、审批仅 owner，
      每次发言写 chatted 审计事件。

    安全边界：``_get_session_with_shared_access`` 默认
    ``include_session_share=False``；读端点 / WS 须显式 ``True`` 才放行第 3
    分支。副作用端点保持默认或显式 False 拦掉 grantee；发言驱动唯一入口是
    shared-chat（can_chat 门 + owner 执行身份）。不共享执行现场
    （workspace / device / 目录）。客户端按 can_chat 档开放统一 Composer。

    每次发出的 IM 卡片都对应一条独立授权，后续重新分享不得覆盖
    历史卡片的权限。IM 卡片锚点由 Django 主链路回填：会话引用、稳定消息引用与
    会话内序号。

    生命周期：新建共享先落 ``pending``（意图已记录，不授会话读权限 /
    资源 ACL）；v2 卡投递确认后仍等待接收方加入，加入后才 ``activate`` 为
    ``active``。``revoked`` 为停止共享。
    """

    STATUS_CHOICES = (
        ('pending', '待生效'),
        ('active', '生效中'),
        ('revoked', '已撤销'),
    )
    CARD_REFRESH_STATUS_CHOICES = (
        ('confirmed', '已确认'),
        ('unconfirmed', '待重试'),
    )
    CARD_CONTRACT_CHOICES = (
        ('session_share', '历史共享卡'),
        ('session_share_v2', '共享卡 v2'),
    )
    DELIVERY_STATUS_CHOICES = (
        ('pending', '待确认'),
        ('confirmed', '已确认'),
        ('unconfirmed', '未确认'),
        ('rejected', '已拒绝'),
    )
    ELIGIBILITY_STATUS_CHOICES = (
        ('eligible', '有效'),
        ('ineligible', '资格失效'),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(
        ChatSession,
        on_delete=models.CASCADE,
        related_name='shares',
        verbose_name='被共享会话',
    )
    organization_id = models.CharField(
        max_length=100, db_index=True, verbose_name='组织ID',
        help_text='共享边界：grantee 必须是该 Organization 成员（创建时快照自 session）。',
    )
    owner_user_id = models.CharField(
        max_length=100, verbose_name='会话 owner 用户ID',
        help_text='创建时快照自 session.user_id；仅 owner 可授予 / 撤销。',
    )
    grantee_user_id = models.CharField(
        max_length=100, db_index=True, verbose_name='被授权用户ID',
    )
    can_fork = models.BooleanField(
        default=False, verbose_name='允许 fork',
        help_text='允许接收人把会话快照抄写成自己的新会话。',
    )
    can_chat = models.BooleanField(
        default=False, verbose_name='允许对话',
        help_text='允许接收人经 shared-chat 端点发言驱动本会话（执行在 owner 设备、费用归 owner）。',
    )
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default='active',
        verbose_name='共享状态',
        help_text='pending=待投递或待接收方加入；active=授权生效；revoked=已停止。',
    )
    card_contract = models.CharField(
        max_length=32,
        choices=CARD_CONTRACT_CHOICES,
        default='session_share',
        verbose_name='卡片契约',
    )
    card_schema_version = models.PositiveSmallIntegerField(
        default=1,
        verbose_name='卡片结构版本',
    )
    version = models.PositiveBigIntegerField(
        default=1,
        verbose_name='对象版本',
    )
    access_epoch = models.PositiveBigIntegerField(
        default=1,
        verbose_name='访问纪元',
        help_text='停止、恢复或资格失效时递增，使旧实时订阅立即失效。',
    )
    delivery_status = models.CharField(
        max_length=16,
        choices=DELIVERY_STATUS_CHOICES,
        default='confirmed',
        verbose_name='卡片投递状态',
    )
    eligibility_status = models.CharField(
        max_length=16,
        choices=ELIGIBILITY_STATUS_CHOICES,
        default='eligible',
        verbose_name='共享资格状态',
    )
    ineligibility_reason = models.CharField(
        max_length=64,
        blank=True,
        default='',
        verbose_name='资格失效原因',
    )
    card_conversation_id = models.CharField(
        max_length=100, blank=True, default='',
        verbose_name='IM 卡片会话ID',
        help_text='tabchat Conversation 软引用（IM 发卡编排在 tabchat 侧回填）。',
    )
    card_message_id = models.BigIntegerField(
        null=True, blank=True,
        verbose_name='IM 卡片消息序号',
        help_text='历史消息序号，仅用于展示与诊断。',
    )
    card_message_ref = models.UUIDField(
        null=True, blank=True, unique=True,
        verbose_name='IM 卡片稳定消息引用',
        help_text='Django IM 消息对应的稳定 MessageRef，用于原消息刷新。',
    )
    card_refresh_status = models.CharField(
        max_length=16,
        choices=CARD_REFRESH_STATUS_CHOICES,
        default='confirmed',
        db_index=True,
        verbose_name='IM 卡片刷新状态',
        help_text='unconfirmed 表示授权事实已提交，但 IM 卡片投影仍需后台重试。',
    )
    forked_session_id = models.UUIDField(
        null=True, blank=True,
        verbose_name='接收人 fork 出的会话ID',
        help_text='shared-fork 成功后回填最新一份副本；每次显式 fork 都新建，旧副本保留。',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')
    revoked_at = models.DateTimeField(null=True, blank=True, verbose_name='撤销时间')

    class Meta:
        db_table = 'chat_session_share'
        verbose_name = '会话共享授权'
        verbose_name_plural = '会话共享授权'
        ordering = ['-created_at']

    def __str__(self):
        return (
            f"SessionShare(session={self.session_id} grantee={self.grantee_user_id} "
            f"[{self.status}])"
        )


class SessionShareResourceGrant(models.Model):
    """任务共享为云文档/表格带来的可追溯资源访问来源。

    ``DocumentPermission`` / ``TablePermission`` 仍是资源 ACL 的执行面，
    但一条 ACL 记录可能被任务共享、手动协作或 IM 资源卡共同使用。本表只
    记录任务共享这一来源，使停止共享只回收它实际带来的访问权。
    """

    RESOURCE_TYPE_CHOICES = (
        ("document", "TabDoc"),
        ("table", "TabData"),
    )
    PERMISSION_CHOICES = (
        ("viewer", "只读"),
        ("editor", "可编辑"),
        ("admin", "管理员"),
        ("owner", "所有者"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    share = models.ForeignKey(
        SessionShare,
        on_delete=models.CASCADE,
        related_name="resource_grants",
    )
    resource_type = models.CharField(max_length=16, choices=RESOURCE_TYPE_CHOICES)
    resource_id = models.UUIDField()
    grantee_user_id = models.CharField(max_length=100, db_index=True)
    is_active = models.BooleanField(default=True, db_index=True)
    manages_resource_permission = models.BooleanField(
        default=False,
        help_text="该来源创建/恢复了资源 ACL；最后一个此类来源撤销时才能失活 ACL。",
    )
    has_independent_access = models.BooleanField(
        default=False,
        help_text="共享前或共享后已由其他渠道确认的访问权，停止共享时必须保留。",
    )
    granted_permission = models.CharField(
        max_length=16,
        choices=PERMISSION_CHOICES,
        default="viewer",
        help_text="该共享来源要求的资源权限；由 SessionShare 权限档位派生。",
    )
    independent_permission = models.CharField(
        max_length=16,
        choices=PERMISSION_CHOICES,
        null=True,
        blank=True,
        help_text="共享来源之外已确认的资源权限，用于撤销后恢复而非一律失活。",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_session_share_resource_grant"
        constraints = [
            models.UniqueConstraint(
                fields=["share", "resource_type", "resource_id"],
                name="uq_session_share_resource_grant",
            ),
        ]
        indexes = [
            models.Index(
                fields=["resource_type", "resource_id", "grantee_user_id", "is_active"],
                name="chat_ssrg_resource_user_idx",
            ),
        ]


class SessionShareResourceSyncJob(models.Model):
    """消息产物 ACL 同步任务；与消息写入同库持久化，避免 broker 故障丢任务。"""

    STATUS_CHOICES = (
        ("pending", "待处理"),
        ("processing", "处理中"),
        ("retry", "待重试"),
        ("done", "已完成"),
        ("dead", "已终止"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(
        "ChatMessage",
        on_delete=models.CASCADE,
        related_name="share_resource_sync_jobs",
    )
    content_digest = models.CharField(max_length=64)
    status = models.CharField(
        max_length=16,
        choices=STATUS_CHOICES,
        default="pending",
        db_index=True,
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    next_retry_at = models.DateTimeField(null=True, blank=True, db_index=True)
    last_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "chat_session_share_resource_sync_job"
        constraints = [
            models.UniqueConstraint(
                fields=["message", "content_digest"],
                name="uq_share_resource_sync_message_digest",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "next_retry_at"],
                name="chat_ssrsj_status_retry_idx",
            ),
        ]


class SessionWorkspaceFileReference(models.Model):
    """会话中结构化引用过的工作区本地文件（写时索引）。

    预览鉴权的真相源：SessionShare grantee 只能预览本表中的有效相对路径，
    不开放整个 working_dir，也不从自由文本猜路径。
    """

    SOURCE_KIND_CHOICES = (
        ("local_file", "local_file 产物卡"),
        ("tool_mutation", "write/edit 工具产物"),
        ("shell_history", "终端 file_history"),
        ("resource_link", "tabtin://resource/file/ 链接"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(
        ChatSession,
        on_delete=models.CASCADE,
        related_name="workspace_file_refs",
        verbose_name="所属会话",
    )
    relative_path = models.CharField(max_length=1024, verbose_name="规范化相对路径")
    path_key = models.CharField(
        max_length=1024,
        verbose_name="去重键",
        help_text="relative_path 的小写形式，用于唯一约束。",
    )
    filename = models.CharField(max_length=255, blank=True, default="")
    source_kind = models.CharField(max_length=32, choices=SOURCE_KIND_CHOICES)
    source_message = models.ForeignKey(
        "ChatMessage",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    source_block_index = models.IntegerField(null=True, blank=True)
    file_type = models.CharField(max_length=64, blank=True, default="")
    mime_type = models.CharField(max_length=128, blank=True, default="")
    file_size = models.BigIntegerField(null=True, blank=True)
    is_active = models.BooleanField(default=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deactivated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_session_workspace_file_ref"
        verbose_name = "会话工作区文件引用"
        verbose_name_plural = "会话工作区文件引用"
        constraints = [
            models.UniqueConstraint(
                fields=["session", "path_key"],
                name="uq_session_workspace_file_ref",
            ),
        ]
        indexes = [
            models.Index(
                fields=["session", "is_active"],
                name="chat_swfr_session_active_idx",
            ),
        ]

    def __str__(self):
        return (
            f"SessionWorkspaceFileReference(session={self.session_id} "
            f"path={self.relative_path} active={self.is_active})"
        )


class SessionWorkspaceFileSnapshot(models.Model):
    """共享预览用的单文件临时物化快照（OSS）。

    内容走短期 signed URL / Range，不经 WS 传字节，也不暴露本机绝对路径。
    """

    STATUS_CHOICES = (
        ("pending", "物化中"),
        ("ready", "就绪"),
        ("failed", "失败"),
        ("revoked", "已撤销"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference = models.ForeignKey(
        SessionWorkspaceFileReference,
        on_delete=models.CASCADE,
        related_name="snapshots",
    )
    session = models.ForeignKey(
        ChatSession,
        on_delete=models.CASCADE,
        related_name="workspace_file_snapshots",
    )
    content_version = models.CharField(max_length=128)
    object_key = models.CharField(max_length=512, blank=True, default="")
    size_bytes = models.BigIntegerField(null=True, blank=True)
    mime_type = models.CharField(max_length=128, blank=True, default="")
    preview_kind = models.CharField(max_length=32, blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="pending")
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=512, blank=True, default="")
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    ready_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_session_workspace_file_snapshot"
        verbose_name = "会话工作区文件快照"
        verbose_name_plural = "会话工作区文件快照"
        constraints = [
            models.UniqueConstraint(
                fields=["reference", "content_version"],
                name="uq_session_workspace_file_snapshot",
            ),
        ]
        indexes = [
            models.Index(
                fields=["session", "status"],
                name="chat_swfs_session_status_idx",
            ),
        ]

    def __str__(self):
        return (
            f"SessionWorkspaceFileSnapshot(ref={self.reference_id} "
            f"version={self.content_version} status={self.status})"
        )


class SessionShareEvent(models.Model):
    """会话共享审计流水（append-only，姿势对齐 tabchat HandoffEvent）。

    每条共享能回答「谁何时授予 / 改权限、谁看过、谁 fork 了、何时撤销」。
    """

    EVENT_TYPE_CHOICES = (
        ('created', '创建'),
        ('updated', '更新权限'),
        ('viewed', '查看'),
        ('forked', 'Fork'),
        ('chatted', '发言驱动'),
        ('revoked', '撤销'),
    )

    id = models.BigAutoField(primary_key=True)
    share = models.ForeignKey(
        SessionShare,
        on_delete=models.CASCADE,
        related_name='events',
        verbose_name='所属共享',
    )
    actor_user_id = models.CharField(max_length=100, verbose_name='操作者用户ID')
    event_type = models.CharField(
        max_length=16, choices=EVENT_TYPE_CHOICES, verbose_name='事件类型',
    )
    client_message_id = models.UUIDField(
        null=True,
        blank=True,
        verbose_name='共享发言客户端消息ID',
    )
    payload_json = models.JSONField(default=dict, blank=True, verbose_name='事件载荷')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'chat_session_share_event'
        verbose_name = '会话共享审计事件'
        verbose_name_plural = '会话共享审计事件'
        indexes = [
            models.Index(fields=['share', '-created_at'], name='chat_share_evt_share_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['share', 'client_message_id'],
                condition=models.Q(
                    event_type='chatted',
                    client_message_id__isnull=False,
                ),
                name='uq_share_chatted_client_msg',
            ),
        ]

    def __str__(self):
        return f"SessionShareEvent({self.event_type} by {self.actor_user_id} on {self.share_id})"


class ChatMessageWithdrawEvent(models.Model):
    """#9614 未答轮次撤回审计快照（硬删前留底）。

    语义是「这轮从未问过」——消息行物理删除后，本表保留被删消息的
    序列化快照，供排障 / 审计；不参与历史读路径，也不引入 withdrawn 软标记。
    """

    id = models.BigAutoField(primary_key=True)
    session = models.ForeignKey(
        ChatSession,
        on_delete=models.CASCADE,
        related_name='withdraw_events',
        verbose_name='所属会话',
    )
    organization_id = models.CharField(
        max_length=100, db_index=True, verbose_name='组织ID',
    )
    actor_user_id = models.CharField(max_length=100, verbose_name='操作者用户ID')
    source = models.CharField(
        max_length=32,
        verbose_name='来源',
        help_text='electron_runtime / mobile_cancel / daemon_runtime',
    )
    client_message_id = models.CharField(
        max_length=64, db_index=True, verbose_name='被撤轮次客户端消息ID',
    )
    payload_json = models.JSONField(
        default=list,
        blank=True,
        verbose_name='被删消息快照',
        help_text='数组：每项含 id / role / text_summary / content_blocks_json / created_at',
    )
    deleted_count = models.IntegerField(default=0, verbose_name='实际删除行数')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'chat_message_withdraw_event'
        verbose_name = '未答轮次撤回审计事件'
        verbose_name_plural = '未答轮次撤回审计事件'
        indexes = [
            models.Index(
                fields=['session', '-created_at'],
                name='chat_withdraw_evt_sess_idx',
            ),
        ]

    def __str__(self):
        return (
            f"ChatMessageWithdrawEvent(session={self.session_id} "
            f"client={self.client_message_id} deleted={self.deleted_count})"
        )


class SessionContinuation(models.Model):
    """发送时冻结的一次性任务续接包。"""

    CONTEXT_STATUS_CHOICES = (
        ("complete", "完整"),
        ("truncated", "已截断"),
        ("empty", "空上下文"),
    )
    DELIVERY_STATUS_CHOICES = SessionShare.DELIVERY_STATUS_CHOICES
    CREATION_STATUS_CHOICES = (
        ("available", "可创建"),
        ("failed", "创建失败"),
        ("created", "已创建"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.CharField(max_length=100, db_index=True)
    source_session_id = models.UUIDField()
    sender_user_id = models.CharField(max_length=100, db_index=True)
    recipient_user_id = models.CharField(max_length=100, db_index=True)
    title_snapshot = models.CharField(max_length=255, blank=True, default="")
    snapshot_schema_version = models.PositiveSmallIntegerField(default=1)
    frozen_context_json = models.JSONField(default=list)
    snapshot_turn_count = models.PositiveIntegerField(default=0)
    context_status = models.CharField(
        max_length=16,
        choices=CONTEXT_STATUS_CHOICES,
        default="complete",
    )
    resources_json = models.JSONField(default=list)
    resource_status = models.CharField(max_length=16, default="none")
    delivery_status = models.CharField(
        max_length=16,
        choices=DELIVERY_STATUS_CHOICES,
        default="pending",
    )
    creation_status = models.CharField(
        max_length=16,
        choices=CREATION_STATUS_CHOICES,
        default="available",
    )
    version = models.PositiveBigIntegerField(default=1)
    client_request_id = models.UUIDField(unique=True)
    card_conversation_id = models.CharField(max_length=100, blank=True, default="")
    card_message_ref = models.UUIDField(unique=True)
    card_message_sequence = models.BigIntegerField(null=True, blank=True)
    materialize_request_id = models.UUIDField(null=True, blank=True, unique=True)
    target_agent_id = models.UUIDField(null=True, blank=True)
    target_workspace_id = models.UUIDField(null=True, blank=True)
    linked_session_id = models.UUIDField(null=True, blank=True, unique=True)
    last_error_code = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    materialized_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_session_continuation"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                check=~models.Q(sender_user_id=models.F("recipient_user_id")),
                name="chat_cont_sender_ne_recipient",
            ),
        ]


class SessionContinuationEvent(models.Model):
    id = models.BigAutoField(primary_key=True)
    continuation = models.ForeignKey(
        SessionContinuation,
        on_delete=models.CASCADE,
        related_name="events",
    )
    actor_user_id = models.CharField(max_length=100, blank=True, default="")
    event_type = models.CharField(max_length=32)
    payload_json = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "chat_session_continuation_event"
        indexes = [
            models.Index(
                fields=["continuation", "-created_at"],
                name="chat_cont_evt_cont_idx",
            ),
        ]

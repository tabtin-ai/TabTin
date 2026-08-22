"""Agent Memory 领域数据模型（ W6：模型层从 TabMemo 彻底解耦）。

``AgentMemory`` 是 Agent 从交互中蒸馏的记忆行，跟 **agent 生命周期**走
（agent 删则记忆删），不是用户笔记资产。历史上曾寄居 ``apps.tabmemo``
（``db_table=tabmemo_agent_memory``）作为分家过渡态；本模块把它落到独立
领域 ``agent_memory``（``app_label=agent_memory``，``db_table=agent_memory_entry``），
与 TabMemo 用户笔记彻底物理分离。

读写统一经 ``apps.agent_memory.repository.AgentMemoryRepository`` 收口；
路由由 ``apps.agent_memory.db_router.AgentMemoryRouter`` 交给 router（不显式
``.using()``，避免跨连接 ``select_for_update`` split 死锁，见  W1 教训）。
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from apps.services.common.base_models import TimeStampedModel


class AgentMemory(TimeStampedModel):
    """Agent 记忆（ M4.5/C5 分家拆表，audit §10.11；#4118 独立领域）。

    memo_type 语义（沿用原字段名，减少蒸馏管道切换面）:
      - about_you:    Agent 对用户的观察（偏好、习惯、事实）
      - insight:      Agent 从交互中提炼的洞察
      - task_summary: Agent 对任务/会话的结构化摘要
      - diary:        面向用户展示的工作日记

    维度：``agent``（主锚）× ``owner_id``（记忆涉及的用户——蒸馏输入来自
    该用户的交互，召回/合并按 (agent, owner) 隔离）+ ``organization_id``
    （租户隔离）。无 space 维度——现场信息由 ``source_url``（thread://）溯源。

    生命周期：active ↔ archived 两态（idle_settlement / importance_adjust
    归档过期记忆；compaction 合并后归档旧行）。无回收站——记忆不是用户
    可回收资产。
    """

    agent = models.ForeignKey(
        "agent.Agent",
        on_delete=models.CASCADE,
        db_column="agent_id",
        related_name="memories",
        verbose_name="所属 Agent",
        help_text="记忆归属的 Agent（会话直挂执行分身优先，workspace 1:1 回退）。",
    )
    organization_id = models.UUIDField(db_index=True, verbose_name="所属组织")
    owner_id = models.UUIDField(
        db_index=True, null=True, blank=True, verbose_name="记忆涉及的用户",
        help_text="蒸馏输入来自该用户的交互；召回/合并按 (agent, owner) 隔离。",
    )

    class Status(models.TextChoices):
        ACTIVE = "active", "活跃"
        ARCHIVED = "archived", "已归档"

    class MemoType(models.TextChoices):
        ABOUT_YOU = "about_you", "关于你"
        INSIGHT = "insight", "洞察"
        TASK_SUMMARY = "task_summary", "任务摘要"
        DIARY = "diary", "工作日记"

    # ── 内容（与 Memo 同构，便于日记视图复用渲染） ──
    content_json = models.JSONField(
        default=dict, blank=True, verbose_name="ProseMirror JSON",
    )
    content_plaintext = models.TextField(
        blank=True, default="", verbose_name="纯文本",
        help_text="用于去重（Jaccard）、列表预览与关键字检索",
    )
    content_markdown = models.TextField(
        blank=True, default="", verbose_name="Markdown 副本",
        help_text="记忆注入 / Agent 读取用",
    )

    memo_type = models.CharField(
        max_length=30, choices=MemoType.choices,
        db_index=True, verbose_name="记忆类型",
        help_text="about_you/insight/task_summary/diary",
    )
    title = models.CharField(
        max_length=255, blank=True, default="", verbose_name="标题",
        help_text="日记（diary）等面向用户展示的记忆行标题；蒸馏三型为空。",
    )
    importance = models.PositiveSmallIntegerField(
        null=True, blank=True, verbose_name="重要性",
        help_text="重要程度 1-5，importance_adjust 动态调整",
    )
    access_count = models.PositiveIntegerField(
        default=0, verbose_name="访问计数",
        help_text="召回命中次数，用于 importance 动态调整和过期归档判断",
    )

    tags = models.JSONField(default=list, blank=True, verbose_name="标签")
    ai_tags = models.JSONField(
        default=list, blank=True, verbose_name="AI 标签",
        help_text='蒸馏附带的结构化标记，如 ["emotion:neutral"]',
    )
    source_url = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="来源",
        help_text="溯源标识（thread://<thread_id> 等）",
    )

    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE,
        db_index=True, verbose_name="状态",
    )
    supersedes = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="revisions",
        verbose_name="被修正的记忆",
        help_text="修正操作新建替代记录并归档原记录；该字段保留修订来源。",
    )
    forgotten_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name="忘记时间",
        help_text="非空表示用户已要求忘记；所有默认读取必须排除此类记录。",
    )

    class Meta:
        db_table = "agent_memory_entry"
        ordering = ["-created_at"]
        verbose_name = "Agent 记忆"
        verbose_name_plural = "Agent 记忆"
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(importance__isnull=True)
                    | models.Q(importance__gte=1, importance__lte=5)
                ),
                name="agent_memory_importance_range",
            ),
        ]
        indexes = [
            models.Index(
                fields=["agent", "memo_type", "status"],
                name="agent_memory_type_status_idx",
            ),
            models.Index(
                fields=["agent", "owner_id", "status", "-created_at"],
                name="agent_memory_owner_idx",
            ),
            models.Index(
                fields=["organization_id", "status"],
                name="agent_memory_org_status_idx",
            ),
        ]

    def __str__(self):
        preview = (self.content_plaintext or "")[:40]
        return f"AgentMemory({self.id}, agent={self.agent_id}, {preview!r})"


class WorkspaceMemorySettings(TimeStampedModel):
    """Personal / Organization 记忆增强策略的单一持久化事实。

    这里的 Workspace 是记忆归属语义，不是本地目录型
    ``tabtinspace.Workspace``：personal 由 User 唯一拥有，organization 由
    Organization 唯一拥有。数据库约束和 ``clean`` 同时守住 owner XOR 与模型
    模式形状，避免 NULL 承载多重语义。
    """

    class Scope(models.TextChoices):
        PERSONAL = "personal", "Personal"
        ORGANIZATION = "organization", "Organization"

    class ModelMode(models.TextChoices):
        OFFICIAL_DEFAULT = "official_default", "Official Default"
        EXPLICIT_MODEL = "explicit_model", "Explicit Model"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scope = models.CharField(max_length=20, choices=Scope.choices)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="personal_workspace_memory_settings",
        verbose_name="Personal Workspace 所属用户",
    )
    organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="workspace_memory_settings",
        verbose_name="Organization Workspace 所属组织",
    )
    auto_memory_enabled = models.BooleanField(
        default=False,
        verbose_name="自动记忆增强",
        help_text="新 Workspace 默认关闭；存量兼容由独立数据迁移显式回填开启。",
    )
    memory_model_mode = models.CharField(
        max_length=24,
        choices=ModelMode.choices,
        default=ModelMode.OFFICIAL_DEFAULT,
        verbose_name="记忆模型模式",
    )
    memory_model = models.ForeignKey(
        "llm.LLMModel",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="workspace_memory_settings",
        verbose_name="精确记忆模型",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_workspace_memory_settings",
        verbose_name="创建人",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="updated_workspace_memory_settings",
        verbose_name="更新人",
    )

    class Meta:
        db_table = "agent_memory_workspace_settings"
        verbose_name = "Workspace Memory Settings"
        verbose_name_plural = "Workspace Memory Settings"
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(
                        scope="personal",
                        user__isnull=False,
                        organization__isnull=True,
                    )
                    | models.Q(
                        scope="organization",
                        user__isnull=True,
                        organization__isnull=False,
                    )
                ),
                name="wm_settings_owner_scope_xor",
            ),
            models.CheckConstraint(
                check=(
                    models.Q(
                        memory_model_mode="official_default",
                        memory_model__isnull=True,
                    )
                    | models.Q(
                        memory_model_mode="explicit_model",
                        memory_model__isnull=False,
                    )
                ),
                name="wm_settings_model_mode_shape",
            ),
            models.UniqueConstraint(
                fields=["user"],
                condition=models.Q(scope="personal"),
                name="wm_settings_personal_user_uniq",
            ),
            models.UniqueConstraint(
                fields=["organization"],
                condition=models.Q(scope="organization"),
                name="wm_settings_organization_uniq",
            ),
        ]

    def clean(self):
        super().clean()
        personal_shape = (
            self.scope == self.Scope.PERSONAL
            and self.user_id is not None
            and self.organization_id is None
        )
        organization_shape = (
            self.scope == self.Scope.ORGANIZATION
            and self.user_id is None
            and self.organization_id is not None
        )
        if not (personal_shape or organization_shape):
            raise ValidationError(
                {"scope": "scope 与 user / organization 归属不一致"}
            )

        official_shape = (
            self.memory_model_mode == self.ModelMode.OFFICIAL_DEFAULT
            and self.memory_model_id is None
        )
        explicit_shape = (
            self.memory_model_mode == self.ModelMode.EXPLICIT_MODEL
            and self.memory_model_id is not None
        )
        if not (official_shape or explicit_shape):
            raise ValidationError(
                {"memory_model_mode": "模型模式与 memory_model 形状不一致"}
            )

    def __str__(self):
        owner = self.user_id if self.scope == self.Scope.PERSONAL else self.organization_id
        return f"WorkspaceMemorySettings({self.scope}:{owner})"

"""
TabMemo 碎片笔记数据模型

存储架构:
  - Memo 是碎片卡片主表，继承 SpaceResourceModel
  - content_json 以 ProseMirror JSON 存储精简 TipTap 内容
  - MemoAttachment 存附件（图片/文件）
  - MemoCollection 存碎片集合（文件夹式归类）
  - MemoCollectionMembership 多对多关联
"""

from __future__ import annotations

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.services.common.base_models import (
    SpaceResourceModel,
    TimeStampedModel,
    TrashableModelMixin,
)


class Memo(SpaceResourceModel, TrashableModelMixin):
    """碎片笔记卡片

    memo_type 语义:
      - note:         用户手写笔记（默认）
      - bookmark:     URL 书签收藏
      - about_you:    Agent 对用户的观察（偏好、习惯、事实）
      - insight:      Agent 从交互中提炼的洞察
      - task_summary: 用户层任务/会话小结（用于日结输入）
      - diary:        Agent 层工作日记
    """

    # 覆盖 SpaceResourceModel 的 space_id，使其可选
    # None 表示纯个人碎片，不绑定到任何 Space
    space_id = models.UUIDField(db_index=True, null=True, blank=True)

    class Status(models.TextChoices):
        ACTIVE = "active", "活跃"
        ARCHIVED = "archived", "已归档"
        TRASHED = "trashed", "已删除"

    class Source(models.TextChoices):
        MANUAL = "manual", "手动输入"
        BROWSER = "browser", "浏览器采集"
        SHARE = "share", "移动端分享"
        API = "api", "API 推送"
        AGENT = "agent", "Agent 创建"
        VOICE = "voice", "语音输入"

    class MemoType(models.TextChoices):
        NOTE = "note", "笔记"
        BOOKMARK = "bookmark", "书签"
        ABOUT_YOU = "about_you", "关于你"
        INSIGHT = "insight", "洞察"
        TASK_SUMMARY = "task_summary", "任务摘要"
        DIARY = "diary", "工作日记"

    class Color(models.TextChoices):
        NONE = "", "无颜色"
        YELLOW = "yellow", "黄色"
        BLUE = "blue", "蓝色"
        GREEN = "green", "绿色"
        PINK = "pink", "粉色"
        PURPLE = "purple", "紫色"
        ORANGE = "orange", "橙色"
        GRAY = "gray", "灰色"

    # ── 内容 ──
    content_json = models.JSONField(
        default=dict, blank=True, verbose_name="ProseMirror JSON",
        help_text="结构化内容，TipTap/ProseMirror JSON 格式",
    )
    content_plaintext = models.TextField(
        blank=True, default="", verbose_name="纯文本（搜索用）",
        help_text="由 content_json 提取的纯文本，用于全文搜索和列表预览",
    )
    content_markdown = models.TextField(
        blank=True, default="", verbose_name="Markdown 副本",
        help_text="Markdown 格式副本，用于快速编辑和 Agent 读取",
    )

    # ── 类型与重要性 ──
    memo_type = models.CharField(
        max_length=30, choices=MemoType.choices, default=MemoType.NOTE,
        db_index=True, verbose_name="碎片类型",
        help_text="碎片类型: note/bookmark/about_you/insight/task_summary/diary",
    )
    importance = models.PositiveSmallIntegerField(
        null=True, blank=True, verbose_name="重要性",
        help_text="重要程度 1-5，Agent 创建的 memo 使用此字段",
    )

    # ── 元数据 ──
    color = models.CharField(
        max_length=20, choices=Color.choices, default="", blank=True,
        verbose_name="卡片颜色",
        help_text="可选值: yellow/blue/green/pink/purple/orange/gray",
    )
    source = models.CharField(
        max_length=50, choices=Source.choices, default=Source.MANUAL,
        verbose_name="来源",
        help_text="来源标识: manual/browser/share/api/agent/voice",
    )
    source_url = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="来源 URL",
        help_text="碎片来源的原始 URL（浏览器采集等场景）",
    )
    agent_id = models.UUIDField(
        db_index=True, null=True, blank=True, verbose_name="关联 Agent",
        help_text="Agent 层记忆归属。task_summary 可作为来源线索，diary 必填。",
    )
    is_pinned = models.BooleanField(
        default=False, verbose_name="置顶",
        help_text="置顶碎片在列表中排在最前面",
    )

    # ── 标签 ──
    tags = models.JSONField(
        default=list, blank=True, verbose_name="用户标签",
        help_text='用户手动添加的标签列表，如 ["设计", "灵感"]',
    )
    ai_tags = models.JSONField(
        default=list, blank=True, verbose_name="AI 自动标签",
        help_text="由 AI 自动分析生成的标签列表",
    )

    # ── URL 书签预览 ──
    bookmark_url = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="书签 URL",
    )
    bookmark_title = models.CharField(
        max_length=500, blank=True, default="", verbose_name="书签标题",
    )
    bookmark_description = models.TextField(
        blank=True, default="", verbose_name="书签描述",
    )
    bookmark_image = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="书签缩略图",
    )

    # ── 访问计数（Agent 记忆召回命中） ──
    access_count = models.PositiveIntegerField(
        default=0, verbose_name="访问计数",
        help_text="Agent 记忆召回命中次数，用于 importance 动态调整和过期归档判断",
    )

    # ── 状态 ──
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE,
        db_index=True, verbose_name="状态",
        help_text="碎片生命周期状态: active/archived/trashed",
    )

    # ── 全文搜索 ──
    # NOTE: search_vector 无数据库触发器自动维护，依赖 Service 层
    # (memo_service.py) 在 create/update 时显式调用 SearchVector 更新。
    # 后续可考虑添加 PostgreSQL trigger 以保证一致性（需新增迁移文件）。
    search_vector = SearchVectorField(
        null=True, blank=True, verbose_name="搜索向量",
        help_text="PostgreSQL tsvector，由 content_plaintext + bookmark + tags + ai_tags 生成；"
                  "由 Service 层维护，无数据库触发器",
    )

    # ── 审计 ──
    created_by = models.ForeignKey(
        "users_auth.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    updated_by = models.ForeignKey(
        "users_auth.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )

    class Meta:
        db_table = "tabmemo_memo"
        ordering = ["-is_pinned", "-created_at"]
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(importance__isnull=True)
                    | models.Q(importance__gte=1, importance__lte=5)
                ),
                name="tm_importance_range_1_5",
            ),
        ]
        indexes = [
            models.Index(
                fields=["organization_id", "status"],
                name="tm_ws_status_idx",
            ),
            models.Index(
                fields=["organization_id", "-created_at"],
                name="tm_ws_created_idx",
            ),
            models.Index(
                fields=["organization_id", "space_id", "status"],
                name="tm_ws_as_status_idx",
                condition=models.Q(space_id__isnull=False),
            ),
            models.Index(
                fields=["organization_id", "owner_id", "status"],
                name="tm_ws_owner_status_idx",
                condition=models.Q(space_id__isnull=True),
            ),
            GinIndex(
                fields=["search_vector"],
                name="tm_search_gin_idx",
            ),
            GinIndex(
                fields=["tags"],
                name="tm_tags_gin_idx",
            ),
            models.Index(
                fields=["space_id", "memo_type", "status"],
                name="tm_space_type_status_idx",
                condition=models.Q(space_id__isnull=False),
            ),
            models.Index(
                fields=["organization_id", "agent_id", "memo_type", "status", "-created_at"],
                name="tm_org_agent_type_status_idx",
                condition=models.Q(agent_id__isnull=False),
            ),
            # BC-25: (organization_id, space_id, created_at) 覆盖 Space 内时间线查询
            models.Index(
                fields=["organization_id", "space_id", "-created_at"],
                name="tm_ws_space_created_idx",
            ),
            # BC-26: (organization_id, owner_id, created_at) 覆盖个人碎片时间线查询
            models.Index(
                fields=["organization_id", "owner_id", "-created_at"],
                name="tm_ws_owner_created_idx",
            ),
        ]

    def __str__(self):
        preview = (self.content_plaintext or "")[:40]
        return f"Memo({self.id}, {preview!r})"

    # ── ContextSyncMixin ──

    def get_context_type(self) -> str:
        return "tabmemo"

    def get_context_title(self) -> str:
        text = (self.content_plaintext or "").strip()
        if text:
            first_line = text.split("\n", 1)[0]
            return first_line[:50] if len(first_line) > 50 else first_line
        if self.bookmark_title:
            return self.bookmark_title[:50]
        return "未命名碎片"

    def get_context_metadata(self) -> dict:
        return {
            "memo_type": self.memo_type,
            "color": self.color,
            "tags": self.tags or [],
            "has_bookmark": bool(self.bookmark_url),
            "has_attachments": self.attachments.exists() if self.pk else False,
            "is_pinned": self.is_pinned,
            "source": self.source,
            "importance": self.importance,
        }

    def get_context_preview(self) -> str:
        return (self.content_plaintext or "")[:200]

    def get_context_status(self) -> str:
        return self.status or ""

    def is_context_archived(self) -> bool:
        return self.status == self.Status.ARCHIVED


class MemoAttachment(TimeStampedModel):
    """Memo 附件（图片/文件/音视频）"""

    class FileType(models.TextChoices):
        IMAGE = "image", "图片"
        FILE = "file", "文件"
        VIDEO = "video", "视频"
        AUDIO = "audio", "音频"

    memo = models.ForeignKey(
        Memo, on_delete=models.CASCADE, related_name="attachments",
    )
    file_type = models.CharField(
        max_length=20, choices=FileType.choices, verbose_name="文件类型",
        help_text="附件类型: image/file/video/audio",
    )
    file_url = models.URLField(
        max_length=2048, verbose_name="OSS URL",
        help_text="文件在 OSS 中的访问地址",
    )
    file_name = models.CharField(max_length=500, verbose_name="文件名")
    file_size = models.PositiveIntegerField(
        default=0, verbose_name="文件大小(bytes)",
        help_text="文件大小（字节）",
    )
    mime_type = models.CharField(
        max_length=100, blank=True, default="", verbose_name="MIME 类型",
    )
    thumbnail_url = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="缩略图 URL",
    )
    sort_order = models.PositiveIntegerField(default=0, verbose_name="排序序号")

    class Meta:
        db_table = "tabmemo_attachment"
        ordering = ["sort_order", "created_at"]

    def __str__(self):
        return f"Attachment({self.file_name}, memo={self.memo_id})"


class MemoCollection(SpaceResourceModel, TrashableModelMixin):
    """碎片集合（文件夹式归类）

    BC-24: 支持软删除，与 Memo 保持一致的回收站体验。
    """

    # 覆盖 SpaceResourceModel 的 space_id，使其可选
    space_id = models.UUIDField(db_index=True, null=True, blank=True)

    class Status(models.TextChoices):
        ACTIVE = "active", "活跃"
        TRASHED = "trashed", "已删除"

    title = models.CharField(max_length=255, verbose_name="集合名称")
    description = models.TextField(blank=True, default="", verbose_name="描述")
    icon = models.CharField(max_length=50, blank=True, default="", verbose_name="图标")
    color = models.CharField(max_length=20, blank=True, default="", verbose_name="颜色")
    is_smart = models.BooleanField(
        default=False, verbose_name="智能集合",
        help_text="智能集合基于 smart_filter 自动匹配碎片",
    )
    smart_filter = models.JSONField(
        default=dict, blank=True,
        verbose_name="智能过滤条件",
        help_text='例: {"tags": ["设计"], "keywords": ["UI"]}',
    )
    sort_order = models.PositiveIntegerField(default=0, verbose_name="排序序号")

    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE,
        db_index=True, verbose_name="状态",
        help_text="集合生命周期状态: active/trashed",
    )

    created_by = models.ForeignKey(
        "users_auth.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )

    def get_context_type(self) -> str:
        return "memo_collection"

    def get_context_title(self) -> str:
        return self.title

    def get_context_metadata(self) -> dict:
        return {"icon": self.icon, "color": self.color, "is_smart": self.is_smart}

    class Meta:
        db_table = "tabmemo_collection"
        ordering = ["sort_order", "created_at"]
        indexes = [
            models.Index(
                fields=["organization_id", "space_id"],
                name="tm_coll_ws_as_idx",
            ),
        ]

    def __str__(self):
        return f"Collection({self.id}, {self.title})"


class MemoCollectionMembership(TimeStampedModel):
    """Memo 与 Collection 的多对多关系"""

    memo = models.ForeignKey(
        Memo, on_delete=models.CASCADE, related_name="collection_memberships",
    )
    collection = models.ForeignKey(
        MemoCollection, on_delete=models.CASCADE, related_name="memo_memberships",
    )
    sort_order = models.PositiveIntegerField(default=0, verbose_name="排序序号")

    class Meta:
        db_table = "tabmemo_membership"
        ordering = ["sort_order", "created_at"]
        indexes = [
            models.Index(
                fields=["collection", "sort_order"],
                name="tm_membership_coll_sort_idx",
            ),
        ]
        constraints = [
            # BC-27: unique_together → UniqueConstraint
            models.UniqueConstraint(
                fields=["memo", "collection"],
                name="tm_membership_memo_coll_uniq",
            ),
        ]

    def __str__(self):
        return f"Membership(memo={self.memo_id}, coll={self.collection_id})"


class MemoAgentGrant(TimeStampedModel):
    """Agent 可见性授权：控制哪些 Space 的 Agent 可以访问哪些 Memo/Collection"""

    organization_id = models.UUIDField(db_index=True)

    # 授权目标（二选一）
    memo = models.ForeignKey(
        Memo, on_delete=models.CASCADE, null=True, blank=True,
        related_name="agent_grants",
    )
    collection = models.ForeignKey(
        MemoCollection, on_delete=models.CASCADE, null=True, blank=True,
        related_name="agent_grants",
    )

    # 授权给哪个 Space（该 Space 下所有 Agent 可见）
    target_space_id = models.UUIDField(db_index=True)

    # 权限级别
    permission = models.CharField(
        max_length=10,
        choices=[("read", "只读"), ("write", "读写")],
        default="read",
        verbose_name="权限级别",
    )

    # 授权人 — 使用裸 UUID 而非 ForeignKey，原因：
    # 1. User 表在 MySQL（default db），本模型在 PostgreSQL，跨库 FK 不可用
    # 2. 与 SpaceResourceModel 中 owner_id 保持一致的跨库引用策略
    granted_by = models.UUIDField(db_index=True)

    class Meta:
        db_table = "tabmemo_agent_grant"
        indexes = [
            models.Index(
                fields=["target_space_id", "organization_id"],
                name="tm_grant_space_ws_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["memo", "target_space_id"],
                name="tm_grant_memo_space_uniq",
                condition=models.Q(memo__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["collection", "target_space_id"],
                name="tm_grant_coll_space_uniq",
                condition=models.Q(collection__isnull=False),
            ),
            # memo 和 collection 必须二选一，不能同时为空或同时非空
            models.CheckConstraint(
                check=(
                    models.Q(memo__isnull=False, collection__isnull=True)
                    | models.Q(memo__isnull=True, collection__isnull=False)
                ),
                name="tm_grant_memo_or_coll_xor",
            ),
        ]

    def __str__(self):
        target = f"memo={self.memo_id}" if self.memo_id else f"coll={self.collection_id}"
        return f"AgentGrant({target}, space={self.target_space_id}, {self.permission})"


class MemoRecordStyle(TimeStampedModel):
    """Agent 笔记「记录风格」偏好（per-(user, organization)）。

    控制当前用户在某 Organization 下、其 Agent 蒸馏笔记（memory_capture /
    task_summary）时的记录风格。与 Memo / UserPortrait 同维度——一个用户在
    N 个 Organization 有 N 份独立配置，跨 Organization 物理隔离（多 Organization 切换各一套）。

    与 per-Agent ``agent_config.memory`` 的关系：
      - ``agent_config.memory.enabled`` / ``observer`` 仍是 per-Agent 的记忆基础
        开关与触发参数（何时跑、跑不跑）。
      - 本模型是叠加在其上的「用户级记录风格」——蒸馏链路在 per-Agent gate 通过后，
        再读本配置决定「记不记」（``enabled``）与「怎么记」（``style`` /
        ``custom_config`` / ``extra_preference``）。

    跨库引用：``user_id`` / ``organization_id`` 用裸 UUIDField，与同 app 的
    ``MemoAgentGrant`` 一致（tabmemo 路由到 PostgreSQL，沿用既有跨库引用策略，
    不引入跨 alias FK）。
    """

    class Style(models.TextChoices):
        # faithful = 现状默认行为：记过程/结果/踩坑，偏客观
        FAITHFUL = "faithful", "忠实记录"
        # minimal = 惜字如金，只留结论
        MINIMAL = "minimal", "极简"
        # companion = 记 Agent 对人/事的判断与觉察，第一人称（「洞察伙伴」）
        COMPANION = "companion", "洞察伙伴"
        # custom = 由 custom_config 维度决定
        CUSTOM = "custom", "自定义"

    # TM-16: 不声明单列 db_index——(user_id, organization_id) 复合唯一约束的底层索引
    # 已能服务 user_id 前缀查询（leftmost prefix），单列索引冗余、徒增写放大与存储。
    user_id = models.UUIDField(
        verbose_name="所属用户",
        help_text="(user_id, organization_id) 复合唯一——一个用户在每个 Organization 一份记录风格",
    )
    organization_id = models.UUIDField(
        db_index=True, verbose_name="所属 Organization",
    )

    enabled = models.BooleanField(
        default=True, verbose_name="记录总开关",
        help_text="关闭后该用户在本 Organization 的所有 Agent 不再蒸馏写入笔记",
    )
    style = models.CharField(
        max_length=20, choices=Style.choices, default=Style.FAITHFUL,
        verbose_name="记录风格",
        help_text="faithful/minimal/companion/custom；custom 时读 custom_config",
    )
    custom_config = models.JSONField(
        default=dict, blank=True, verbose_name="自定义维度",
        help_text='style=custom 时生效，例: '
                  '{"density":"moderate","depth":"with_judgment",'
                  '"tone":"warm","focus":["about_user","method"]}',
    )
    extra_preference = models.TextField(
        blank=True, default="", verbose_name="额外记录偏好",
        help_text="用户自由文本偏好，作为受控变量注入蒸馏 prompt 固定槽位（非裸 prompt）",
    )

    class Meta:
        db_table = "tabmemo_record_style"
        verbose_name = "记忆记录风格"
        verbose_name_plural = "记忆记录风格"
        constraints = [
            models.UniqueConstraint(
                fields=["user_id", "organization_id"],
                name="tm_record_style_user_ws_uniq",
            ),
        ]

    def __str__(self):
        return f"MemoRecordStyle(user={self.user_id}, ws={self.organization_id}, {self.style})"

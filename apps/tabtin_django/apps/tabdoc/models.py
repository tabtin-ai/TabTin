"""
TabDoc 数据模型 (V3)

存储架构（3-table + Agent-Human 协作）:

- Document:           当前文档最新状态（内容字段原地更新），Y.js binary 为 source of truth
- DocUpdate:          Y.js 增量更新队列（Hocuspocus onStore 写入，Celery 定时合并到 Document）
- DocHistory:         版本历史快照（只存 Y.js binary，支持全量/增量 diff + TTL 过期）
- DocumentPermission: 继承 ResourcePermission 统一权限基类

已废弃（保留表结构兼容读取，不再写入）:
- DocumentVersion:    旧版全量快照 → 被 DocHistory 替代
- DocumentRevision:   更早期的全量 Revision → 被 DocHistory 替代
"""

import secrets
import uuid

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models
from django.utils import timezone

from apps.services.common.base_models import (
    SpaceResourceModel,
    ResourcePermission,
    TimeStampedModel,
    TrashableModelMixin,
)

User = get_user_model()

# ── 版本历史配置 ──
# TTL 默认值（秒），可按用户套餐覆盖
HISTORY_TTL_FREE = 7 * 24 * 3600       # 免费用户: 7 天
HISTORY_TTL_PRO = 30 * 24 * 3600       # Pro 用户: 30 天
HISTORY_TTL_TEAM = 90 * 24 * 3600      # Team 用户: 90 天
HISTORY_MIN_INTERVAL = 5                # 最小间隔 5 秒（过滤连续打字的高频 autoSave，但不影响 Agent 操作立即记录）
HISTORY_SNAPSHOT_EVERY = 10             # 每 N 次增量 diff 后创建一个全量锚点
HISTORY_SNAPSHOT_MAX_AGE = 30 * 60      # 或每 30 分钟创建一个全量锚点

# 兼容旧代码引用
MAX_VERSIONS_PER_DOC = 20


class Document(SpaceResourceModel, TrashableModelMixin):
    """
    文档模型 (V3)

    继承自 SpaceResourceModel，自动获得:
      - id (UUID), created_at, updated_at
      - organization_id, space_id

    内容字段:
      - description_binary:    Y.js CRDT 二进制 — source of truth
      - description_markdown:  Markdown/HTML 文本副本（创建时为 Markdown，协作 store 后可能为 HTML）
      - description_json:      ProseMirror/TipTap JSON（编辑器状态）
      - description_plaintext: 纯文本（搜索 + 摘要）

    Agent 读写 Markdown 不落库，通过运行时转换:
      - 读: pmJsonToMarkdown(description_json)
      - 写: markdownToPmJson(md) → description_json，再派生其他格式

    归属追踪:
      - last_editor_type: "user" / "agent" / "system"
      - last_editor_id:   user_id 或 agent_id 的 UUID 字符串
    """

    EDITOR_TYPE_CHOICES = [
        ("user", "User"),
        ("agent", "Agent"),
        ("system", "System"),
    ]

    STATUS_CHOICES = [
        ("active", "Active"),
        ("archived", "Archived"),
        ("trashed", "Trashed"),
    ]

    FONT_STYLE_CHOICES = [
        ("default", "Default"),
        ("serif", "Serif"),
        ("mono", "Mono"),
    ]

    parent = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="children",
    )
    title = models.CharField(max_length=255, default="未命名文档")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="active")
    latest_version = models.PositiveIntegerField(default=0)

    # ── 文档内容（原地更新） ──
    description_binary = models.BinaryField(
        null=True, blank=True, verbose_name="Y.js CRDT 二进制（source of truth）"
    )
    description_markdown = models.TextField(
        blank=True, default="<p></p>", verbose_name="Markdown/HTML 文本副本"
    )
    description_json = models.JSONField(
        default=dict, blank=True, verbose_name="ProseMirror JSON"
    )
    description_plaintext = models.TextField(
        blank=True, default="", verbose_name="纯文本（搜索用）"
    )

    # ── 归属追踪（最后编辑者） ──
    last_editor_type = models.CharField(
        max_length=16,
        choices=EDITOR_TYPE_CHOICES,
        blank=True,
        default="",
        verbose_name="最后编辑者类型",
    )
    last_editor_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="最后编辑者 ID",
    )

    # ── 文档属性 ──
    icon = models.CharField(max_length=64, blank=True, default="", verbose_name="图标/Emoji")
    cover_image = models.CharField(
        max_length=1024,
        blank=True,
        default="",
        verbose_name="封面图片文件引用",
        help_text="优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容",
    )
    cover_position = models.FloatField(default=0.5, verbose_name="封面裁剪位置 (0-1)")

    # ── 分类与标签 ──
    tags = models.JSONField(default=list, blank=True, verbose_name="标签列表")

    # ── 自定义属性（灵活 KV，类似 Notion database properties） ──
    properties = models.JSONField(default=dict, blank=True, verbose_name="自定义属性")

    # ── 隐私控制 ──
    is_private = models.BooleanField(
        default=False,
        verbose_name="是否私密文档",
        help_text="私密文档不回退空间权限，必须有直接权限记录才能访问",
    )

    # ── 展示设置 ──
    is_full_width = models.BooleanField(default=False, verbose_name="是否全宽展示")
    font_style = models.CharField(
        max_length=32, choices=FONT_STYLE_CHOICES, default="default", verbose_name="字体风格"
    )

    # ── 全文搜索向量 ──
    search_vector = SearchVectorField(null=True, blank=True, verbose_name="搜索向量")

    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_documents_created",
    )
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_documents_updated",
    )

    class Meta:
        db_table = "tabdoc_document"
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["organization_id", "space_id"], name="doc_ws_proj_idx"),
            models.Index(fields=["space_id", "status"], name="doc_proj_status_idx"),
            models.Index(fields=["parent", "updated_at"], name="doc_parent_updated_idx"),
            GinIndex(fields=["search_vector"], name="doc_search_vector_gin_idx"),
        ]

    def __str__(self):
        return f"{self.title} ({self.id})"

    # ── ContextSyncMixin 实现 ──

    def get_context_type(self) -> str:
        return "tabdoc"

    def get_context_title(self) -> str:
        return self.title or "未命名文档"

    def get_context_metadata(self) -> dict:
        from apps.services.oss.services.public_assets import build_public_asset_url

        return {
            "current_doc_id": str(self.id),
            "document_id": str(self.id),
            "doc_id": str(self.id),
            "parent_id": str(self.parent_id) if self.parent_id else None,
            "latest_version": self.latest_version,
            "icon": self.icon or "",
            "cover_image": build_public_asset_url(self.cover_image or ""),
            "tags": self.tags or [],
        }

    def get_context_preview(self) -> str:
        text = (self.description_plaintext or "").strip()
        if text:
            return text[:200]
        if self.latest_version > 0:
            return f"v{self.latest_version}"
        return ""

    def get_context_status(self) -> str:
        return self.status or ""

    def is_context_archived(self) -> bool:
        return self.status == "archived"


class DocumentRecoveryDraft(models.Model):
    """A non-canonical copy of an editor draft that could not be merged safely.

    Recovery drafts deliberately live outside ``Document`` and ``VersionHistory``:
    recording one must never change the visible document or create a misleading
    normal revision.  They are short lived and can only be restored explicitly.
    """

    STATUS_ACTIVE = "active"
    STATUS_RESTORED = "restored"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_RESTORED, "Restored"),
        (STATUS_EXPIRED, "Expired"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="recovery_drafts")
    organization_id = models.UUIDField(db_index=True)
    creator = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_recovery_drafts_created",
    )
    base_version = models.PositiveIntegerField(null=True, blank=True)
    content_pm_json = models.JSONField(default=dict, blank=True)
    content_markdown = models.TextField(blank=True, default="")
    content_plaintext = models.TextField(blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    expires_at = models.DateTimeField(db_index=True)
    restored_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tabdoc_document_recovery_draft"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["document", "status", "-created_at"], name="doc_recovery_doc_state_idx"),
            models.Index(fields=["creator", "status"], name="doc_recovery_creator_state_idx"),
        ]


class DocChunk(models.Model):
    """
    文档分块存储（大文档优化）

    超大文档（100+ 页）的 Y.js binary 可能达到 MB 级，初始加载和合并都很慢。
    DocChunk 将文档按章节/Block 分片存储，支持按需加载。

    分块策略:
    - 按 Y.js subdocument 方案：每个顶级 Block（heading + 其下内容）为一个 chunk
    - chunk_index: 在文档中的顺序位置
    - blob: 该 chunk 的 Y.js subdocument binary（zlib 压缩）
    - 首屏加载: 只加载前 N 个 chunk + 元数据
    - 滚动加载: 按 chunk_index 范围请求后续 chunk

    Document.description_binary 仍保留完整 state（兼容层），
    DocChunk 是并行的分块视图，用于优化加载性能。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(
        Document, on_delete=models.CASCADE, related_name="chunks",
    )
    chunk_index = models.PositiveIntegerField(
        verbose_name="分块序号（从 0 开始）",
    )
    chunk_key = models.CharField(
        max_length=128, blank=True, default="",
        verbose_name="分块标识（如 heading Block ID）",
    )
    blob = models.BinaryField(
        verbose_name="zlib 压缩的 Y.js subdocument binary",
    )
    blob_size = models.PositiveIntegerField(default=0, verbose_name="blob 字节数")
    block_count = models.PositiveIntegerField(
        default=0, verbose_name="该 chunk 包含的 Block 数量",
    )
    plaintext_preview = models.TextField(
        blank=True, default="",
        verbose_name="纯文本预览（用于目录/大纲，<200 字）",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tabdoc_chunk"
        ordering = ["chunk_index"]
        constraints = [
            models.UniqueConstraint(
                fields=["document", "chunk_index"],
                name="doc_chunk_doc_index_unique",
            ),
        ]

    def __str__(self):
        return f"Chunk {self.chunk_index} of {self.document_id} ({self.blob_size}B)"


class DocUpdate(models.Model):
    """
    Y.js 增量更新队列

    Hocuspocus onStoreDocument 时写入，Celery 定时合并到 Document.description_binary。
    每条记录是一个 Y.js update binary，体积通常很小（几十字节~几KB）。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="updates")
    blob = models.BinaryField(verbose_name="Y.js update binary")
    editor_type = models.CharField(
        max_length=16, blank=True, default="", verbose_name="编辑者类型 (user/agent/system)"
    )
    editor_id = models.CharField(
        max_length=64, blank=True, default="", verbose_name="编辑者 ID"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabdoc_update"
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["document", "created_at"], name="docupd_doc_created_idx"),
        ]

    def __str__(self):
        return f"Update {self.id} for {self.document_id} @ {self.created_at}"


class DocHistory(models.Model):
    """
    [已废弃 — 写入路径已下线] 版本历史快照 + TTL

    写入路径已于 P2 阶段下线，新版本历史统一写入 collab.VersionHistory。
    表结构和存量数据保留，供以下场景只读使用：
      - 旧数据恢复（_resolve_history_content_by_id 回退分支）
      - 存量数据迁移（migrate_doc_histories_incremental 任务）
      - 清理任务（cleanup_expired_history 清理存量过期数据）

    原设计：
      只存 Y.js binary，其他格式（HTML/JSON/Markdown）查看时按需转换，不落库。
      支持全量快照和增量 diff 两种类型（类似 Git packfile）。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="histories")
    organization_id = models.UUIDField(verbose_name="Organization ID")

    # ── 版本数据 ──
    blob = models.BinaryField(verbose_name="Y.js binary（全量快照或增量 diff）")
    is_snapshot = models.BooleanField(
        default=True, verbose_name="是否全量快照（False=增量 diff）"
    )
    base_history = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="diffs",
        verbose_name="增量 diff 基于的全量快照",
    )

    # ── 归属追踪 ──
    editor_type = models.CharField(
        max_length=16, blank=True, default="", verbose_name="触发者类型 (user/agent/system)"
    )
    editor_id = models.CharField(
        max_length=64, blank=True, default="", verbose_name="触发者 ID"
    )

    # ── TTL ──
    expired_at = models.DateTimeField(
        db_index=True, null=True, blank=True, verbose_name="过期时间（TTL，命名版本为 NULL）"
    )

    # ── 命名版本 ──
    is_named = models.BooleanField(default=False, verbose_name="是否用户手动保存的命名版本")
    name = models.CharField(max_length=200, blank=True, default="", verbose_name="版本名称")
    pinned = models.BooleanField(default=False, verbose_name="是否置顶（不受 TTL/降采样影响）")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabdoc_history"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["document", "created_at"], name="dochist_doc_created_idx"),
            models.Index(fields=["document", "is_snapshot"], name="dochist_doc_snap_idx"),
            models.Index(fields=["document", "is_named"], name="dochist_doc_named_idx"),
            models.Index(fields=["document", "expired_at"], name="dochist_doc_expired_idx"),
        ]

    def __str__(self):
        if self.is_named:
            label = self.name or "命名版本"
            return f"NamedVersion {self.id} ({label}) for {self.document_id} @ {self.created_at}"
        kind = "snapshot" if self.is_snapshot else "diff"
        return f"History {self.id} ({kind}) for {self.document_id} @ {self.created_at}"


# ═══════════════════════════════════════════════════════════════════
# 以下模型已废弃，保留表结构兼容读取，不再写入新数据。
# 新内容通过 DocUpdate + DocHistory 管理。
# ═══════════════════════════════════════════════════════════════════


class DocumentVersion(models.Model):
    """
    [已废弃] 旧版全量快照 → 被 DocHistory 替代。

    保留表结构用于兼容读取旧数据，不再写入。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="versions")
    organization_id = models.UUIDField(verbose_name="Organization ID")

    description_binary = models.BinaryField(null=True, blank=True)
    description_markdown = models.TextField(blank=True, default="<p></p>")
    description_json = models.JSONField(default=dict, blank=True)
    description_plaintext = models.TextField(blank=True, default="")
    version = models.PositiveIntegerField(null=True, blank=True)

    last_saved_at = models.DateTimeField(verbose_name="原始保存时间")
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_versions_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabdoc_version"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["document", "created_at"], name="docver_doc_created_idx"),
            models.Index(fields=["document", "version"], name="docver_doc_ver_idx"),
        ]

    def __str__(self):
        return f"{self.document_id}@{self.created_at}"


class DocumentRevision(models.Model):
    """
    [已废弃] 更早期的全量 Revision → 被 DocHistory 替代。

    保留表结构用于兼容读取旧数据，不再写入。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="revisions")
    version = models.PositiveIntegerField()
    content_pm_json = models.JSONField(default=dict)
    content_markdown = models.TextField(blank=True, default="")
    content_plaintext = models.TextField(blank=True, default="")

    editor = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_revisions_edited",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabdoc_revision"
        ordering = ["-version", "-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["document", "version"], name="doc_revision_unique_version"),
        ]
        indexes = [
            models.Index(fields=["document", "version"], name="doc_revision_doc_ver_idx"),
        ]

    def __str__(self):
        return f"{self.document_id}@v{self.version}"


class DocumentPermission(ResourcePermission):
    """
    文档权限覆盖

    继承自 ResourcePermission 统一权限基类，自动获得:
      - id (UUID), subject_type, subject_id, permission, is_active
      - granted_by (授权人 ID 字符串), created_at, updated_at
      - has_at_least(required_permission) 工具方法

    额外添加:
      - document (FK → Document)
      - created_by (FK → User)

    注意: subject_type 支持 user/role/agent（继承自基类），
    但当前业务逻辑仅处理 user 和 role，agent 待后续支持。
    """

    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="permissions")
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_permissions_created",
    )

    class Meta(ResourcePermission.Meta):
        db_table = "tabdoc_permission"
        constraints = [
            models.UniqueConstraint(
                fields=["document", "subject_type", "subject_id"],
                name="doc_perm_unique_active_subject",
                condition=models.Q(is_active=True),
            ),
        ]
        indexes = [
            models.Index(fields=["document", "is_active"], name="doc_perm_doc_active_idx"),
            models.Index(fields=["subject_type", "subject_id"], name="doc_perm_subject_idx"),
        ]

    def __str__(self):
        return f"{self.document_id}:{self.subject_type}:{self.subject_id}={self.permission}"


class DocumentAdminActionLog(models.Model):
    """文档后台治理动作日志。"""

    ACTION_TYPE_CHOICES = [
        ("batch_archive", "批量归档"),
        ("batch_restore", "批量恢复"),
        ("batch_trash", "批量逻辑删除"),
        ("batch_untrash", "批量回收站恢复"),
        ("single_archive", "单文档归档"),
        ("single_restore", "单文档恢复"),
        ("single_trash", "单文档逻辑删除"),
        ("single_untrash", "单文档回收站恢复"),
        ("restore_version", "版本恢复"),
        ("update_permissions", "权限覆盖更新"),
        ("audit_export", "审计导出"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    action_type = models.CharField(
        max_length=64,
        choices=ACTION_TYPE_CHOICES,
        db_index=True,
        verbose_name="动作类型",
    )

    operator_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name="操作人 ID",
    )
    operator_name = models.CharField(
        max_length=255,
        blank=True,
        default="",
        verbose_name="操作人展示名",
    )

    target_document_ids = models.JSONField(
        default=list,
        verbose_name="目标文档 ID 列表",
        help_text="治理动作影响的文档 ID 列表",
    )
    target_document_ids_text = models.TextField(
        blank=True,
        default="",
        verbose_name="目标文档检索文本",
        help_text="格式: |doc_id_1|doc_id_2|，用于模糊检索",
    )

    requested_count = models.PositiveIntegerField(default=0, verbose_name="请求总数")
    updated_count = models.PositiveIntegerField(default=0, verbose_name="成功处理数")
    skipped_count = models.PositiveIntegerField(default=0, verbose_name="跳过数")
    dry_run = models.BooleanField(default=False, verbose_name="是否 dry-run")

    success = models.BooleanField(default=True, db_index=True, verbose_name="是否成功")
    result_message = models.TextField(blank=True, default="", verbose_name="结果信息")
    error_message = models.TextField(blank=True, default="", verbose_name="错误信息")

    request_payload = models.JSONField(default=dict, verbose_name="请求快照")
    result_payload = models.JSONField(default=dict, verbose_name="结果快照")

    trace_id = models.CharField(
        max_length=128,
        blank=True,
        default="",
        db_index=True,
        verbose_name="链路追踪 ID",
    )
    ip_address = models.GenericIPAddressField(
        null=True,
        blank=True,
        verbose_name="IP 地址",
    )
    user_agent = models.TextField(blank=True, default="", verbose_name="User-Agent")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "tabdoc_admin_action_log"
        verbose_name = "文档后台治理动作日志"
        verbose_name_plural = "文档后台治理动作日志"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["action_type", "created_at"], name="docadm_action_created_idx"),
            models.Index(fields=["operator_id", "created_at"], name="docadm_operator_created_idx"),
            models.Index(fields=["success", "created_at"], name="docadm_success_created_idx"),
            models.Index(fields=["dry_run", "created_at"], name="docadm_dryrun_created_idx"),
        ]

    def __str__(self):
        status = "success" if self.success else "failed"
        return f"{self.action_type} ({status}) @ {self.created_at.isoformat()}"


def _generate_share_id() -> str:
    return secrets.token_urlsafe(12)[:16]


class DocumentShare(models.Model):
    """文档分享 — 支持公开链接和组织限定两种模式

    公开链接：任何人可通过 share_id 访问（可选密码保护），只读
    组织限定：需登录且属于对应 organization，可选 view/comment/edit 权限
    """

    SHARE_TYPE_CHOICES = [
        ("public", "公开链接"),
        ("organization", "组织限定"),
    ]
    PERMISSION_CHOICES = [
        ("view", "只读"),
        ("comment", "可评论"),
        ("edit", "可编辑"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="shares",
        verbose_name="所属文档",
    )

    share_type = models.CharField(
        max_length=20,
        choices=SHARE_TYPE_CHOICES,
        default="organization",
        verbose_name="分享类型",
    )
    share_id = models.CharField(
        max_length=20,
        unique=True,
        default=_generate_share_id,
        verbose_name="分享 ID（短链接）",
    )
    password_hash = models.CharField(
        max_length=255,
        blank=True,
        verbose_name="访问密码哈希",
    )
    permission = models.CharField(
        max_length=20,
        choices=PERMISSION_CHOICES,
        default="view",
        verbose_name="权限",
    )

    expire_at = models.DateTimeField(null=True, blank=True, verbose_name="过期时间")
    max_visits = models.IntegerField(null=True, blank=True, verbose_name="最大访问次数")
    visit_count = models.IntegerField(default=0, verbose_name="访问计数")

    organization_id = models.CharField(
        max_length=36,
        blank=True,
        verbose_name="限定 Organization ID",
        help_text="share_type=organization 时必填",
    )

    allow_download = models.BooleanField(default=True, verbose_name="允许下载")
    allow_copy = models.BooleanField(default=True, verbose_name="允许复制内容")

    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否生效")

    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_shares_created",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "tabdoc_share"
        verbose_name = "文档分享"
        verbose_name_plural = "文档分享"
        indexes = [
            models.Index(fields=["document", "is_active"], name="docshare_doc_active_idx"),
            models.Index(fields=["share_type", "organization_id"], name="docshare_type_wt_idx"),
            models.Index(fields=["created_at"], name="docshare_created_idx"),
        ]
        constraints = [
            # 每文档最多一条 active share，防止 public/organization 双活导致「收窄失效」。
            models.UniqueConstraint(
                fields=["document"],
                condition=models.Q(is_active=True),
                name="docshare_one_active_per_document",
            ),
        ]

    def __str__(self):
        return f"{self.document_id}:{self.share_type}:{self.share_id}"

    def is_expired(self) -> bool:
        if self.expire_at and timezone.now() > self.expire_at:
            return True
        if self.max_visits and self.visit_count >= self.max_visits:
            return True
        return False

    def set_password(self, raw_password: str) -> None:
        if raw_password:
            self.password_hash = make_password(raw_password)
        else:
            self.password_hash = ""

    def check_password(self, raw_password: str) -> bool:
        if not self.password_hash:
            return True
        return check_password(raw_password, self.password_hash)

    @property
    def has_password(self) -> bool:
        return bool(self.password_hash)

    def refresh_share_id(self) -> str:
        self.share_id = _generate_share_id()
        return self.share_id

    def increment_visit(self) -> None:
        self.visit_count = models.F("visit_count") + 1
        self.save(update_fields=["visit_count"])


class DocumentShareComment(models.Model):
    """文档评论，可来自公开分享页或登录后的文档评论入口。

    评论独立于正文版本保存，避免 ``permission=comment`` 触发文档内容变更。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="share_comments",
        verbose_name="所属文档",
    )
    share = models.ForeignKey(
        DocumentShare,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="comments",
        verbose_name="来源分享",
    )
    author = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_constraint=False,
        related_name="tabdoc_share_comments",
        verbose_name="评论者",
    )
    author_name = models.CharField(
        max_length=80,
        blank=True,
        default="",
        verbose_name="评论者名称",
    )
    selected_text = models.TextField(blank=True, default="", verbose_name="评论所选文本")
    body = models.TextField(verbose_name="评论内容")
    mention_user_ids = models.JSONField(
        default=list,
        blank=True,
        verbose_name="提及用户 ID 列表",
    )
    is_deleted = models.BooleanField(default=False, db_index=True, verbose_name="是否删除")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "tabdoc_share_comment"
        verbose_name = "文档分享评论"
        verbose_name_plural = "文档分享评论"
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["document", "is_deleted", "created_at"],
                name="docshc_doc_deleted_created_idx",
            ),
            models.Index(fields=["share", "created_at"], name="docshc_share_created_idx"),
        ]

    def __str__(self):
        return f"{self.document_id}:{self.share_id or 'document'}:{self.id}"


class CommentThread(models.Model):
    """文档批注线程；讨论状态与正文锚点状态彼此独立。"""

    class Scope(models.TextChoices):
        DOCUMENT = "document", "全文"
        TEXT_RANGE = "text_range", "文本选区"
        BLOCK = "block", "内容块"

    class Status(models.TextChoices):
        OPEN = "open", "待处理"
        RESOLVED = "resolved", "已解决"

    class AnchorStatus(models.TextChoices):
        NONE = "none", "无锚点"
        ATTACHED = "attached", "已关联"
        ORPHANED = "orphaned", "已失联"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(
        Document,
        on_delete=models.CASCADE,
        related_name="comment_threads",
        verbose_name="所属文档",
    )
    organization_id = models.UUIDField(verbose_name="Organization ID")
    scope = models.CharField(
        max_length=16,
        choices=Scope.choices,
        default=Scope.DOCUMENT,
        verbose_name="批注范围",
    )
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.OPEN,
        verbose_name="线程状态",
    )
    anchor = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="版本化正文锚点",
    )
    anchor_status = models.CharField(
        max_length=16,
        choices=AnchorStatus.choices,
        default=AnchorStatus.NONE,
        verbose_name="锚点状态",
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_comment_threads_created",
    )
    resolved_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_comment_threads_resolved",
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tabdoc_comment_thread"
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(
                fields=["document", "status", "created_at"],
                name="docct_doc_status_created_idx",
            ),
            models.Index(
                fields=["organization_id", "document"],
                name="docct_org_document_idx",
            ),
        ]


class CommentMessage(models.Model):
    """批注线程消息；根消息 ID 与旧评论投影 ID 保持一致。"""

    class Kind(models.TextChoices):
        ROOT = "root", "根消息"
        REPLY = "reply", "回复"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    thread = models.ForeignKey(
        CommentThread,
        on_delete=models.CASCADE,
        related_name="messages",
        verbose_name="所属线程",
    )
    kind = models.CharField(
        max_length=16,
        choices=Kind.choices,
        default=Kind.REPLY,
        verbose_name="消息类型",
    )
    author = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_comment_messages",
        verbose_name="消息作者",
    )
    share = models.ForeignKey(
        DocumentShare,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="comment_messages",
        verbose_name="来源分享",
    )
    author_name = models.CharField(max_length=80, blank=True, default="")
    body = models.TextField(verbose_name="消息内容")
    mention_user_ids = models.JSONField(default=list, blank=True)
    client_request_id = models.CharField(max_length=100, null=True, blank=True)
    is_deleted = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tabdoc_comment_message"
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(
                fields=["thread", "is_deleted", "created_at"],
                name="doccm_thread_del_created_idx",
            ),
            models.Index(
                fields=["author", "created_at"],
                name="doccm_author_created_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["thread"],
                condition=models.Q(kind="root"),
                name="doccm_one_root_per_thread",
            ),
            models.UniqueConstraint(
                fields=["author", "client_request_id"],
                condition=models.Q(
                    author__isnull=False,
                    client_request_id__isnull=False,
                ),
                name="doccm_author_request_uniq",
            ),
        ]


class CommentAttachment(models.Model):
    """批注消息附件；关联写入只能经 DocumentCommentService 的私有绑定 seam。"""

    class AttachmentType(models.TextChoices):
        IMAGE = "image", "图片"
        FILE = "file", "文件"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(
        CommentMessage,
        on_delete=models.CASCADE,
        related_name="attachments",
        verbose_name="所属消息",
    )
    file_record = models.ForeignKey(
        "oss.FileRecord",
        on_delete=models.PROTECT,
        related_name="tabdoc_comment_attachments",
        verbose_name="私有文件记录",
    )
    organization_id = models.UUIDField(verbose_name="Organization ID")
    attachment_type = models.CharField(
        max_length=16,
        choices=AttachmentType.choices,
        default=AttachmentType.IMAGE,
    )
    metadata = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabdoc_comment_attachments_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabdoc_comment_attachment"
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(
                fields=["message", "created_at"],
                name="docca_message_created_idx",
            ),
            models.Index(
                fields=["organization_id", "created_at"],
                name="docca_org_created_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["file_record"],
                name="docca_file_record_uniq",
            ),
        ]

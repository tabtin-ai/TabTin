"""
Collab 统一数据模型

VersionHistory — 通用版本历史表
  所有模块（docs/table/design/slide/video）共用一张表，
  通过 resource_type + resource_id 区分资源。
  支持全量快照 + 增量 diff 的混合版本链。

ChangeLog — 通用变更记录表
  记录每次操作的结构化摘要，支持通过 agent_run_id 关联
  同一轮 Agent 操作涉及的所有跨模块变更。
"""
import uuid
import zlib

from django.db import models
from django.utils import timezone


class VersionHistory(models.Model):
    """
    通用版本历史。

    全量快照: is_snapshot=True, base_history=NULL
    增量 diff: is_snapshot=False, base_history → 最近的全量锚点
    命名版本: is_named=True, expired_at=NULL (永不过期)
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    resource_type = models.CharField(
        max_length=20,
        db_index=True,
        verbose_name="资源类型",
        help_text="docs / table / design / slide / video / canvas",
    )
    resource_id = models.UUIDField(
        db_index=True,
        verbose_name="资源 ID",
        help_text="对应模块的主资源 ID（document_id / table_id / project_id / file_id）",
    )

    blob = models.BinaryField(
        verbose_name="版本数据",
        help_text="zlib 压缩的全量快照或增量 diff",
    )
    blob_size = models.PositiveIntegerField(
        default=0,
        verbose_name="blob 原始字节数",
    )

    is_snapshot = models.BooleanField(
        default=True,
        verbose_name="全量快照",
        help_text="True=全量快照, False=增量 diff",
    )
    base_history = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="diffs",
        verbose_name="增量 diff 的基版本",
    )

    editor_type = models.CharField(
        max_length=16,
        blank=True,
        default="user",
        db_index=True,
        verbose_name="编辑者类型",
        help_text="user / agent / system",
    )
    editor_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="编辑者 ID",
    )
    editor_name = models.CharField(
        max_length=128,
        blank=True,
        default="",
        verbose_name="编辑者名称",
    )

    expired_at = models.DateTimeField(
        db_index=True,
        null=True,
        blank=True,
        verbose_name="过期时间",
        help_text="NULL=永不过期（命名版本/置顶版本）",
    )

    is_named = models.BooleanField(default=False, verbose_name="命名版本")
    name = models.CharField(max_length=200, blank=True, default="", verbose_name="版本名称")
    pinned = models.BooleanField(default=False, verbose_name="置顶")

    organization_id = models.UUIDField(
        db_index=True,
        null=True,
        blank=True,
        verbose_name="组织 ID",
        help_text="用于按组织隔离版本数据",
    )

    metadata = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="模块特有元数据",
        help_text="如 page_count, shape_count, record_count, version/revn 等",
    )

    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "collab_version_history"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["resource_type", "resource_id", "-created_at"],
                name="idx_vh_resource_time",
            ),
            models.Index(
                fields=["resource_type", "resource_id", "is_snapshot"],
                name="idx_vh_resource_snapshot",
            ),
        ]
        verbose_name = "版本历史"
        verbose_name_plural = "版本历史"

    def __str__(self):
        tag = "snapshot" if self.is_snapshot else "diff"
        named = f" [{self.name}]" if self.is_named else ""
        return f"VH({self.resource_type}:{self.resource_id} {tag}{named})"

    @property
    def decompressed_blob(self) -> bytes | None:
        if not self.blob:
            return None
        try:
            return zlib.decompress(self.blob)
        except Exception:
            return None


class ChangeLog(models.Model):
    """
    通用变更记录。

    记录每次操作的结构化变更，支持审计、时间线展示和跨模块 Agent 操作追踪。
    通过 agent_run_id 可查询同一轮 Agent 操作涉及的所有资源变更。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    resource_type = models.CharField(
        max_length=20,
        db_index=True,
        verbose_name="资源类型",
    )
    resource_id = models.UUIDField(
        db_index=True,
        verbose_name="资源 ID",
    )

    change_type = models.CharField(
        max_length=64,
        verbose_name="变更类型",
        help_text="create / update / delete / restore / schema_version_token_bumped / field_restore",
    )
    summary = models.CharField(
        max_length=500,
        blank=True,
        default="",
        verbose_name="变更摘要",
        help_text="人可读的操作描述",
    )
    changes = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="变更详情",
        help_text="结构化的变更内容，格式由各模块 adapter 定义",
    )

    editor_type = models.CharField(
        max_length=16,
        blank=True,
        default="user",
        db_index=True,
        verbose_name="编辑者类型",
    )
    editor_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="编辑者 ID",
    )
    editor_name = models.CharField(
        max_length=128,
        blank=True,
        default="",
        verbose_name="编辑者名称",
    )

    agent_run_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        verbose_name="Agent Run ID",
        help_text="关联同一轮 Agent 操作的所有跨模块变更",
    )

    session_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        verbose_name="关联会话 ID",
        help_text="产生该变更的 ChatSession ID。跨库读优化的反范式设计——ChangeLog 在 PG，ChatSession 在 MySQL，无法跨库 JOIN",
    )

    version_history = models.ForeignKey(
        VersionHistory,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="change_logs",
        verbose_name="关联版本",
    )

    metadata = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="附加信息",
    )

    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "collab_change_log"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["resource_type", "resource_id", "-created_at"],
                name="idx_cl_resource_time",
            ),
            models.Index(
                fields=["agent_run_id", "-created_at"],
                name="idx_cl_agent_run",
            ),
        ]
        verbose_name = "变更记录"
        verbose_name_plural = "变更记录"

    def __str__(self):
        return f"CL({self.resource_type}:{self.resource_id} {self.change_type})"


class SpaceCheckpoint(models.Model):
    """
    空间级检查点。

    在某一时刻对 Agent Space 下所有资源的版本状态做快照。
    通过 version_refs 记录每个资源当时的最新 VersionHistory ID。
    可选关联 Chat checkpoint（Shadow Git commit hash）。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization_id = models.UUIDField(
        db_index=True,
        verbose_name="组织 ID",
    )
    space_id = models.UUIDField(
        db_index=True,
        verbose_name="所属空间",
    )

    name = models.CharField(
        max_length=200,
        blank=True,
        default="",
        verbose_name="检查点名称",
    )

    version_refs = models.JSONField(
        default=dict,
        verbose_name="资源版本引用",
        help_text='{"resource_type:resource_id": "version_history_id", ...}',
    )

    file_checkpoint_hash = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="文件系统检查点",
        help_text="Shadow Git commit hash（TabCode 文件快照）",
    )

    agent_run_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        verbose_name="关联 Agent Run",
    )

    # 优先级约定：前端读取 session/message 锚点时，优先使用这两个一等字段；
    # metadata.checkpoint_context 中的 session_id / assistant_message_id 作为 fallback。
    # 一等字段支持 DB 索引查询，metadata 中的副本供 checkpoint_context 结构完整性自包含。
    anchor_session_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        verbose_name="锚定会话 ID",
        help_text="产生该 checkpoint 的 ChatSession ID，用于快速定位对话",
    )
    anchor_message_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="锚定消息 ID",
        help_text="产生该 checkpoint 的 assistant 消息 ID，用于前端 scrollToMessage 定位",
    )

    trigger = models.CharField(
        max_length=32,
        default="manual",
        verbose_name="触发方式",
        help_text=(
            "agent_turn_done / safety_before_restore / error_compensation / "
            "tabdata_auto_anchor / pre_approval / manual / system_recovery"
        ),
    )

    editor_type = models.CharField(max_length=16, blank=True, default="user")
    editor_id = models.CharField(max_length=64, blank=True, default="")
    editor_name = models.CharField(max_length=128, blank=True, default="")

    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "collab_space_checkpoint"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["space_id", "-created_at"],
                name="idx_sc_space_time",
            ),
            models.Index(
                fields=["space_id", "file_checkpoint_hash"],
                name="idx_sc_space_filehash",
            ),
        ]
        verbose_name = "空间检查点"
        verbose_name_plural = "空间检查点"

    def __str__(self):
        name = f" [{self.name}]" if self.name else ""
        return f"SC({self.space_id}{name})"

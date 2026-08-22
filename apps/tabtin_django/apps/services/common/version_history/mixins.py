"""
VersionHistoryMixin — Django Model Mixin

统一版本历史存储结构，TabDoc / TabSlide 的 History Model 可继承此 Mixin。

字段:
    blob            BinaryField    zlib 压缩的版本数据（全量快照或增量 diff）
    blob_size       int            原始 blob 字节数（用于统计）
    is_snapshot     bool           True=全量快照, False=增量 diff
    base_history    FK(self)       增量 diff 的基版本（全量锚点），全量快照为 NULL
    editor_type     str            触发者类型 (human/agent/system)
    editor_id       str            触发者 ID
    expired_at      DateTime       TTL 过期时间, NULL=永不过期
    is_named        bool           用户手动保存的命名版本
    name            str            版本名称
    pinned          bool           置顶版本（不受 TTL/降采样影响）
    created_at      DateTime       创建时间

注意: 此 Mixin 是抽象的，不创建数据库表。子类必须自行定义关联字段（如 document FK）。
"""
import uuid

from django.db import models


class VersionHistoryMixin(models.Model):
    """
    版本历史统一字段 Mixin。

    子类需添加:
    - 关联 FK（如 document / project / file）
    - organization_id（如需要）
    - 模块特有字段（如 page_count, shape_count 等）
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    blob = models.BinaryField(verbose_name="zlib 压缩版本数据（全量快照或增量 diff）")
    blob_size = models.PositiveIntegerField(default=0, verbose_name="blob 字节数")

    is_snapshot = models.BooleanField(
        default=True, verbose_name="是否全量快照（False=增量 diff）"
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
        max_length=16, blank=True, default="", verbose_name="触发者类型"
    )
    editor_id = models.CharField(
        max_length=64, blank=True, default="", verbose_name="触发者 ID"
    )

    expired_at = models.DateTimeField(
        db_index=True, null=True, blank=True,
        verbose_name="过期时间（NULL=永不过期）",
    )

    is_named = models.BooleanField(default=False, verbose_name="命名版本")
    name = models.CharField(max_length=200, blank=True, default="", verbose_name="版本名称")
    pinned = models.BooleanField(default=False, verbose_name="置顶（不受 TTL/降采样影响）")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True
        ordering = ["-created_at"]

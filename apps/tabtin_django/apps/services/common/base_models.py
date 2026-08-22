"""
通用抽象基类

提供所有 App 模型的共享字段定义，消除跨模块重复代码。
所有基类均为 abstract = True，不会生成数据库表。

层次结构：
  TimeStampedModel               — UUID 主键 + created_at + updated_at
  ├── SpaceResourceModel         — 加 organization_id + space_id + owner_id（团队资源，可选记录 Space 上下文）
  ├── SoftDeleteModel            — 加 is_deleted + deleted_at（统一软删除）
  └── ResourcePermission         — 统一资源权限基类（subject_type + subject_id + permission）

Mixin:
  ContextSyncMixin               — ContextItem 自动同步协议（配合 ResourceBridge 使用）
  TrashableModelMixin            — 回收站支持（trashed_at + trashed_by + previous_status）

注意：
  - created_by / updated_by 不放入基类（各模块 related_name 不同，放入会产生不必要的迁移）
  - 各模块应自行定义 Meta.indexes（含有意义的 name，避免 Django 自动命名冲突）
"""

import uuid

from django.db import models
from django.utils import timezone

from apps.services.common.constants import RESOURCE_PERMISSION_CHOICES, ROLE_LEVELS


# ── Managers ──


class SoftDeleteManager(models.Manager):
    """
    默认只返回未被软删除的记录。

    Usage:
        class MyModel(SoftDeleteModel):
            objects = SoftDeleteManager()       # 默认排除已删除
            all_objects = models.Manager()      # 包含已删除

        MyModel.objects.all()          # 只有 is_deleted=False 的记录
        MyModel.all_objects.all()      # 全部记录（含已删除）
    """

    def get_queryset(self):
        return super().get_queryset().filter(is_deleted=False)


# ── Mixins ──


class ContextSyncMixin:
    """
    ContextItem 自动同步协议。

    让 App 资源模型具备 ContextItem 自动同步能力。子类实现 3 个方法后，
    通过 ResourceBridge.on_create/on_update/on_archive 即可自动完成
    ContextItem 同步、跨 App 事件发射等平台级行为。

    Usage:
        class Document(SpaceResourceModel):  # SpaceResourceModel 已包含此 Mixin
            title = models.CharField(...)

            def get_context_type(self) -> str:
                return "tabdoc"

            def get_context_title(self) -> str:
                return self.title

            def get_context_metadata(self) -> dict:
                return {"parent_id": str(self.parent_id) if self.parent_id else None}

        # 在 Service 层调用：
        ResourceBridge.on_create(document, user=self.user)

    See Also:
        - tabtinspace/services/resource_bridge.py — ResourceBridge 核心服务
    """

    def get_context_type(self) -> str:
        """
        资源类型标识，用于 ContextItem.item_type。

        Returns:
            类型字符串，如 'tabdata'、'tabdoc'、'tabslide'
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} must implement get_context_type()"
        )

    def get_context_title(self) -> str:
        """
        在 Context Space 中显示的资源标题。

        Returns:
            标题字符串
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} must implement get_context_title()"
        )

    def get_context_metadata(self) -> dict:
        """
        附加元数据，存入 ContextItem.metadata。

        默认返回空字典。子类可覆盖以提供 icon、preview、缩略图等信息。

        Returns:
            元数据字典
        """
        return {}

    def get_context_preview(self) -> str:
        """
        资源预览摘要，存入 ContextItem.preview，用于搜索和列表展示。

        默认返回空字符串。子类可覆盖以提供描述信息。

        Returns:
            预览字符串
        """
        return ""

    def get_context_status(self) -> str:
        """
        资源状态，存入 ContextItem.status。

        默认返回空字符串。子类可覆盖以提供状态信息（如 active/archived）。

        Returns:
            状态字符串
        """
        status = getattr(self, "status", "")
        return status if isinstance(status, str) else ""

    def is_context_archived(self) -> bool:
        """
        资源是否已归档。

        自动检测 is_archived 或 status=='archived' 字段。子类可覆盖。

        Returns:
            是否归档
        """
        if hasattr(self, "is_archived"):
            return bool(self.is_archived)
        if hasattr(self, "status"):
            return self.status == "archived"
        return False

    def get_restore_quota_filter(self) -> dict:
        """
        恢复时存储配额预检查的 OSSFileUsage context_filter。

        默认按 resource.id 匹配，模块如需关联子资源文件可 override。

        Returns:
            传给 check_restore_storage_quota 的 context_filter 字典
        """
        return {"context_id": str(self.id)}

    def is_context_trashed(self) -> bool:
        """
        资源是否在回收站中。

        自动检测 trashed_at 或 status=='trashed' 字段。子类可覆盖。

        Returns:
            是否在回收站
        """
        if hasattr(self, "trashed_at") and getattr(self, "trashed_at", None) is not None:
            return True
        if hasattr(self, "status"):
            return self.status == "trashed"
        return False


# ── Abstract Mixins (DB Fields) ──


class TrashableModelMixin(models.Model):
    """
    回收站支持 Mixin

    为资源模型提供统一的回收站字段和操作方法。
    资源被 trash 后进入回收站，保留 previous_status 以便恢复。

    提供：
      - trashed_at       — 进入回收站的时间（None 表示不在回收站）
      - trashed_by       — 操作人 ID（UUID，跨库安全）
      - previous_status  — trash 前的状态，恢复时回到此状态

    用法:
        class Document(SpaceResourceModel, TrashableModelMixin):
            STATUS_CHOICES = [
                ("active", "Active"),
                ("archived", "Archived"),
                ("trashed", "Trashed"),
            ]
            status = models.CharField(...)

        # 移入回收站
        doc.trash(user_id=str(user.id))

        # 从回收站恢复
        doc.restore_from_trash()
    """

    trashed_at = models.DateTimeField(
        null=True, blank=True, db_index=True, verbose_name="回收站时间",
        help_text="进入回收站的时间，为 NULL 表示不在回收站",
    )
    trashed_by = models.UUIDField(
        null=True, blank=True, verbose_name="回收站操作人",
        help_text="将资源移入回收站的用户 ID",
    )
    previous_status = models.CharField(
        max_length=20, blank=True, default="", verbose_name="回收前状态",
        help_text="进入回收站前的 status 值，恢复时回到此状态",
    )

    class Meta:
        abstract = True

    @property
    def is_trashed(self) -> bool:
        return self.trashed_at is not None

    def trash(self, user_id=None, save=True, trashed_at=None):
        """
        将资源移入回收站。

        记录当前 status → previous_status，然后将 status 设为 trashed。

        Args:
            user_id: 操作人 ID（str 或 UUID）
            save: 是否立即保存到数据库（默认 True）
            trashed_at: 指定的 trash 时间戳（None 则自动取当前时间，级联 trash 时传入统一时间戳）
        """
        import uuid as _uuid

        current_status = getattr(self, "status", None)
        if current_status == "trashed":
            return

        if current_status is not None:
            self.previous_status = current_status
            self.status = "trashed"
        elif hasattr(self, "is_archived"):
            self.previous_status = "archived" if self.is_archived else "active"

        self.trashed_at = trashed_at or timezone.now()
        if user_id:
            self.trashed_by = user_id if isinstance(user_id, _uuid.UUID) else _uuid.UUID(str(user_id))

        if save:
            update_fields = ["trashed_at", "trashed_by", "previous_status"]
            if current_status is not None:
                update_fields.append("status")
            if hasattr(self, "updated_at"):
                update_fields.append("updated_at")
            self.save(update_fields=update_fields)

    def restore_from_trash(self, save=True):
        """
        从回收站恢复资源。

        将 status 恢复为 previous_status（默认 active），清除回收站字段。

        Args:
            save: 是否立即保存到数据库（默认 True）
        """
        if not self.trashed_at:
            return

        target_status = self.previous_status or "active"

        current_status = getattr(self, "status", None)
        if current_status is not None:
            self.status = target_status
        elif hasattr(self, "is_archived"):
            self.is_archived = (target_status == "archived")

        self.trashed_at = None
        self.trashed_by = None
        self.previous_status = ""

        if save:
            update_fields = ["trashed_at", "trashed_by", "previous_status"]
            if current_status is not None:
                update_fields.append("status")
            elif hasattr(self, "is_archived"):
                update_fields.append("is_archived")
            if hasattr(self, "updated_at"):
                update_fields.append("updated_at")
            self.save(update_fields=update_fields)


# ── Abstract Base Models ──


class TimeStampedModel(models.Model):
    """
    所有可更新资源的基类

    提供：
      - UUID v4 主键
      - created_at（自动记录创建时间）
      - updated_at（自动记录更新时间）
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class SpaceResourceModel(TimeStampedModel, ContextSyncMixin):
    """
    团队云资源基类

    提供：
      - organization_id  — 所属组织 ID（UUID，非外键，跨库安全）
      - space_id      — 创建/打开时的 Space 上下文（UUID，非外键，跨库安全，可为空）
      - owner_id      — 资源创建者 ID（UUID，退出 Space 不影响资源归属）
      - ContextSyncMixin — ContextItem 自动同步协议

    Space 是本地执行现场，不再是云资源 owner。资源归属以 organization_id 为准；
    space_id 仅用于兼容旧接口、最近上下文、ContextItem 展示和 TabData 物理分区等
    仍在迁移中的场景。

    使用 UUID 而非 ForeignKey 的原因：
      1. 跨数据库（PostgreSQL ↔ MySQL）时外键约束不可用
      2. 保持与 tabtinspace 模块的松耦合
      3. 权限应优先走 organization / resource 权限，space_id 只作为可选上下文
    """

    organization_id = models.UUIDField(db_index=True)
    space_id = models.UUIDField(db_index=True, null=True, blank=True)
    owner_id = models.UUIDField(db_index=True, null=True, blank=True)

    class Meta(TimeStampedModel.Meta):
        abstract = True


# 向后兼容别名（将逐步移除）
ProjectResourceModel = SpaceResourceModel


class SoftDeleteModel(TimeStampedModel):
    """
    统一软删除 Mixin

    提供：
      - is_deleted  — 软删除标记（默认 False）
      - deleted_at  — 删除时间（软删除时自动写入）

    用法:
        class MyModel(SoftDeleteModel):
            objects = SoftDeleteManager()       # 默认排除已删除
            all_objects = models.Manager()      # 包含已删除
            name = models.CharField(...)

        # 软删除
        obj.soft_delete()

        # 恢复
        obj.restore()

        # 查询只返回未删除的记录
        MyModel.objects.filter(...)

        # 查询包含已删除的记录
        MyModel.all_objects.filter(...)

    注意:
      - 子类如果同时需要 space 关联，应继承 SoftDeleteSpaceResourceModel
      - 子类可覆盖 soft_delete() 添加级联逻辑
      - 需要在 UniqueConstraint 中加 condition=Q(is_deleted=False) 来防止与已删除记录冲突
    """

    is_deleted = models.BooleanField(default=False, db_index=True, verbose_name="是否已删除")
    deleted_at = models.DateTimeField(null=True, blank=True, verbose_name="删除时间")

    objects = SoftDeleteManager()
    all_objects = models.Manager()

    class Meta(TimeStampedModel.Meta):
        abstract = True

    def soft_delete(self, save=True):
        """
        软删除当前记录

        Args:
            save: 是否立即保存到数据库（默认 True）
        """
        self.is_deleted = True
        self.deleted_at = timezone.now()
        if save:
            self.save(update_fields=["is_deleted", "deleted_at", "updated_at"])

    def restore(self, save=True):
        """
        恢复被软删除的记录

        Args:
            save: 是否立即保存到数据库（默认 True）
        """
        self.is_deleted = False
        self.deleted_at = None
        if save:
            self.save(update_fields=["is_deleted", "deleted_at", "updated_at"])

    # 向后兼容：tabdata 模块使用 mark_deleted() 方法
    def mark_deleted(self):
        """向后兼容方法，等同于 soft_delete()"""
        self.soft_delete()


class SoftDeleteSpaceResourceModel(SpaceResourceModel):
    """
    带软删除的 Space 资源基类

    组合了 SpaceResourceModel（organization_id + space_id + owner_id）和
    SoftDeleteModel（is_deleted + deleted_at）的能力。
    """

    is_deleted = models.BooleanField(default=False, db_index=True, verbose_name="是否已删除")
    deleted_at = models.DateTimeField(null=True, blank=True, verbose_name="删除时间")

    objects = SoftDeleteManager()
    all_objects = models.Manager()

    class Meta(SpaceResourceModel.Meta):
        abstract = True

    def soft_delete(self, save=True):
        self.is_deleted = True
        self.deleted_at = timezone.now()
        if save:
            self.save(update_fields=["is_deleted", "deleted_at", "updated_at"])

    def restore(self, save=True):
        self.is_deleted = False
        self.deleted_at = None
        if save:
            self.save(update_fields=["is_deleted", "deleted_at", "updated_at"])

    def mark_deleted(self):
        self.soft_delete()


# 向后兼容别名
SoftDeleteProjectResourceModel = SoftDeleteSpaceResourceModel
SoftDeleteProjectResourceModel = SoftDeleteSpaceResourceModel


class ResourcePermission(models.Model):
    """
    统一资源权限基类

    提供通用的细粒度资源权限模型，各模块继承后绑定具体的资源外键。

    提供：
      - subject_type  — 权限主体类型（user / role / agent）
      - subject_id    — 权限主体 ID
      - permission    — 权限级别（viewer / editor / admin）
      - is_active     — 是否生效
      - granted_by    — 授权人 ID（UUID，跨库安全）
      - created_at    — 授权时间
      - updated_at    — 更新时间

    用法:
        class DocumentPermission(ResourcePermission):
            document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="permissions")

            class Meta(ResourcePermission.Meta):
                db_table = "tabdoc_permission"
                constraints = [
                    models.UniqueConstraint(
                        fields=["document", "subject_type", "subject_id"],
                        name="doc_permission_unique_subject",
                    ),
                ]

    权限级别说明：
      - viewer: 只读查看
      - editor: 可编辑内容
      - admin:  可管理权限和设置
    """

    SUBJECT_TYPE_CHOICES = [
        ("user", "User"),
        ("role", "Role"),
        ("agent", "Agent"),
    ]
    PERMISSION_CHOICES = RESOURCE_PERMISSION_CHOICES

    # 权限级别映射，用于 has_at_least() 比较
    PERMISSION_LEVELS = {k: v for k, v in ROLE_LEVELS.items() if k != "participant"}

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    subject_type = models.CharField(
        max_length=20,
        choices=SUBJECT_TYPE_CHOICES,
        verbose_name="权限主体类型",
    )
    subject_id = models.CharField(
        max_length=64,
        verbose_name="权限主体 ID",
    )
    permission = models.CharField(
        max_length=20,
        choices=PERMISSION_CHOICES,
        default="viewer",
        verbose_name="权限级别",
    )
    is_active = models.BooleanField(default=True, verbose_name="是否生效")

    # 授权人（UUID 字符串，跨库安全）
    granted_by = models.CharField(
        max_length=64,
        blank=True,
        default="",
        verbose_name="授权人 ID",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
        # 子类必须定义：
        # 1. 资源外键（如 document, table 等）
        # 2. db_table
        # 3. UniqueConstraint（确保同一资源+主体只有一条有效权限）
        # 4. indexes（含有意义的 name）

    def has_at_least(self, required_permission: str) -> bool:
        """
        检查当前权限是否满足要求

        Args:
            required_permission: 所需的最低权限级别（viewer / editor / admin）

        Returns:
            True 如果当前权限 >= 要求的权限
        """
        if not self.is_active:
            return False
        current_level = self.PERMISSION_LEVELS.get(self.permission, 0)
        required_level = self.PERMISSION_LEVELS.get(required_permission, 0)
        return current_level >= required_level

    def __str__(self):
        return f"{self.subject_type}:{self.subject_id}={self.permission}"

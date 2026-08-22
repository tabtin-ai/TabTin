"""PublicShareService 抽象基类

详细设计：``apps/tabtin_django/apps/tabdoc/PRD-shareperm-p0-fix.md`` §3。

继承示例（伪代码）::

    class DocumentShareService(PublicShareService):
        share_model = DocumentShare
        resource_model = Document
        db_alias = "postgresql"

        @classmethod
        def check_resource_admin(cls, resource, user, *, required_role="admin"):
            from apps.tabdoc.services.document_service import DocumentService
            return DocumentService(user=user).check_document_permission(
                resource, required_role,
            )

        @classmethod
        def serialize_meta(cls, share):
            doc = share.document
            return {"title": doc.title, "icon": doc.icon, ...}

        @classmethod
        def serialize_content(cls, share):
            doc = share.document
            share.increment_visit()
            return {"description_markdown": doc.description_markdown, ...}

子类**必须 override**：

- 三个类属性 ``share_model`` / ``resource_model`` / ``db_alias``
- 三个抽象方法 ``check_resource_admin`` / ``serialize_meta`` / ``serialize_content``

基类**已实现 / 子类不许覆盖**（除非有充分理由）：

- ``generate_share_id()`` —— 统一 share_id 生成
- ``apply_password()`` —— 密码三态语义
- ``is_expired()`` —— 包装 share.is_expired()
- ``verify_share_access()`` —— 公开端点唯一鉴权门
- ``get_share_by_id()`` —— share_id 查询 + 状态校验
- ``load_resource_for_management()`` —— 管理端点唯一防越权入口
- ``validate_organization_scope()`` —— 跨租户校验（P1-3）
- ``create_or_update_share()`` / ``disable_share()`` / ``refresh_share_id()``
  —— 默认实现，子类如有特殊语义可覆盖
"""

from __future__ import annotations

import logging
import secrets
from abc import ABC, abstractmethod
from typing import Any, Optional

from django.utils import timezone

from .exceptions import (
    ShareExpiredError,
    ShareManagementPermissionDeniedError,
    ShareNotFoundError,
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
    ShareOrganizationMismatchError,
)

logger = logging.getLogger("services.public_share")


class PublicShareService(ABC):
    """匿名公开分享 + organization 限定分享的公共基类。

    职责（do）：share_id 生成、密码三态、过期判断、verify_share_access、
    横向越权防护、跨租户校验。

    非职责（don't）：资源元数据序列化（子类）、collaborator 邀请
    （走 ResourcePermission 体系）、通知与审计（事件总线）。
    """

    # ── 子类必须 override 的类属性 ──

    share_model: Any = None
    """Share 模型类（如 DocumentShare / TableShare）。子类必须指定。

    要求该模型具备：``share_id`` / ``share_type`` / ``organization_id`` /
    ``is_active`` / ``has_password`` 属性 + ``is_expired()`` / ``check_password()``
    / ``set_password()`` / ``refresh_share_id()`` 方法。
    """

    resource_model: Any = None
    """资源模型类（如 Document / Table）。子类必须指定。

    要求该模型具备：``id`` / ``owner_id`` / ``organization_id`` 字段。
    """

    db_alias: str = "postgresql"
    """数据库别名。tabdoc / tabdata / tabslide 当前都走 'postgresql'。"""

    share_id_length: int = 16
    """share_id 字符串长度。默认 16（约 96 bit 熵），子类可在
    特殊场景调整（如 tabslide 演示文稿可能想要更短的人友好 ID）。
    """

    share_select_related: tuple = ()
    """子类可设的 select_related 字段元组（如 ('document',)），用于
    get_share_by_id 查询时预取关联资源，避免序列化阶段 N+1。"""

    collab_resource_type: str | None = None
    """协作资源类型（docs / table），子类覆盖后支持签发 share collab token。"""

    valid_share_types: frozenset[str] | None = None
    """子类可声明允许的 ``share_type`` 白名单。

    - 已设置：``verify_share_access`` 对集合外取值 fail-closed（拒绝匿名/登录访问），
      防止脏数据（如拼写错误）被当成公开链接放行。
    - ``None``（默认）：保持历史语义——仅精确值 ``organization`` 走成员校验，
      其余类型视为可匿名访问的公开类（TabData 的 ``form`` / ``data`` 依赖此语义）。
    """

    # ── 抽象方法：子类必须实现 ──

    @classmethod
    @abstractmethod
    def check_resource_admin(
        cls, resource: Any, user: Any, *, required_role: str = "admin",
    ) -> bool:
        """子类桥接：调用 App 自身的权限服务判断 ``user`` 对 ``resource``
        是否具备 ``required_role`` 权限。

        实现示例：

        - tabdoc::

            from apps.tabdoc.services.document_service import DocumentService
            return DocumentService(user=user).check_document_permission(
                resource, required_role,
            )

        - tabdata::

            from apps.tabdata.services.base import BaseService
            return BaseService(user=user).check_table_permission(
                str(resource.id), required_role,
            )

        Args:
            resource: 资源实例（如 Document / Table）
            user: 已登录用户实例
            required_role: 所需角色，默认 'admin'（管理 share 时）

        Returns:
            True 如果用户具备权限，否则 False。本方法不应抛异常 ——
            异常会被 ``load_resource_for_management`` 转化为 ``ShareManagementPermissionDeniedError``。
        """
        raise NotImplementedError

    @classmethod
    @abstractmethod
    def serialize_meta(cls, share: Any) -> dict:
        """子类实现：序列化 share 的元信息（公开访问 meta 端点的响应体）。

        约束：
        - **必须包含** ``share_id`` / ``share_type`` / ``has_password`` 三字段（前端识别用）
        - 不应包含敏感内容（如完整正文、字段 schema）—— 那是 serialize_content 的职责
        - 密码未通过校验时**不要返回**业务字段（view 层自行降级到只返 has_password）

        Args:
            share: Share 模型实例

        Returns:
            dict 形式的 meta 响应体
        """
        raise NotImplementedError

    @classmethod
    @abstractmethod
    def serialize_content(cls, share: Any) -> dict:
        """子类实现：序列化 share 的完整内容（公开访问 content 端点的响应体）。

        通常应在此方法内调用 ``share.increment_visit()`` 更新访问计数。

        Args:
            share: Share 模型实例

        Returns:
            dict 形式的 content 响应体
        """
        raise NotImplementedError

    # ── 基础工具方法 ──

    @classmethod
    def generate_share_id(cls) -> str:
        """生成新的 share_id。

        默认 ``secrets.token_urlsafe(12)[:16]``，提供约 96 bit 熵；
        碰撞概率极低，且由 DB 层 UniqueConstraint 兜底（DocumentShare /
        TableShare 都对 share_id 设了 unique=True）。
        """
        return secrets.token_urlsafe(12)[: cls.share_id_length]

    @classmethod
    def apply_password(cls, share: Any, password: Optional[str]) -> bool:
        """根据三态语义更新 share 的密码字段（不 save）。

        三态：

        - ``None``  → 不动密码字段（用户切 scope 或 permission 时密码保留）
        - ``""``    → 显式清空密码
        - ``"abc"`` → 设新密码（走 set_password 走 hash）

        Args:
            share: Share 模型实例
            password: 三态值

        Returns:
            True 如果 password_hash 实际有变化（调用方据此决定是否
            把 'password_hash' 加入 update_fields），否则 False。
        """
        if password is None:
            return False
        share.set_password(password)
        return True

    @staticmethod
    def is_expired(share: Any) -> bool:
        """薄包装，转发到 ``share.is_expired()``。

        独立成方法是为了让 view 层在不依赖具体 Share 模型签名的情况下，
        统一通过 ``ServiceClass.is_expired(share)`` 调用。
        """
        return bool(share.is_expired())

    @classmethod
    def _resource_from_share(cls, share: Any) -> Any | None:
        """Best-effort load of the resource attached to a share.

        Share services set ``share_select_related`` to the relation name
        (for example ``document`` or ``table``), so prefer that contract and
        fall back to common relation names for older callers.
        """
        relation_names = tuple(cls.share_select_related or ()) + (
            "document",
            "table",
            "resource",
        )
        for relation_name in relation_names:
            resource = getattr(share, relation_name, None)
            if resource is not None and getattr(resource, "id", None):
                return resource
        return None

    @classmethod
    def _ensure_resource_shareable(cls, resource: Any | None) -> None:
        if resource is None:
            return
        if getattr(resource, "trashed_at", None) is not None:
            raise ShareNotFoundError("Shared resource is in trash")
        if getattr(resource, "status", None) == "trashed":
            raise ShareNotFoundError("Shared resource is in trash")

    # ── 公开端点入口：verify_share_access ──

    @classmethod
    def verify_share_access(
        cls,
        share: Any,
        *,
        password: str = "",
        user: Any = None,
    ) -> None:
        """**公开端点唯一鉴权门** —— meta / content / records 等端点必须先调。

        校验顺序（PRD §3.3 关键约束）：

        1. **organization 限定**：若 ``share.share_type == 'organization'``，
           要求 ``organization_id`` 非空且 user 为该 organization 成员；
           匿名访问、空 ``organization_id``（脏数据 / 错误创建）一律
           raise SharePermissionDenied——fail closed，禁止退化成公开链接。

        2. **密码保护**：若 share 有密码，要求 password 必须能通过 check。

        关键约束（PRD §4.1 P0-1 共同次因）：
        ``OrganizationMember`` 模型**没有** ``is_active`` 字段，
        因此 filter 调用绝对不能传 ``is_active=True``！
        本基类的实现已规避此坑，子类不应自行重写本方法。

        Raises:
            SharePermissionDeniedError: organization 校验失败
            SharePasswordRequiredError: 有密码但未提供
            SharePasswordIncorrectError: 密码错误
        """
        share_type = getattr(share, "share_type", "public")
        organization_id = (getattr(share, "organization_id", None) or "").strip() or None

        if cls.valid_share_types is not None and share_type not in cls.valid_share_types:
            # 脏 share_type（拼写错误 / 历史脏数据）不得退化成公开链接。
            raise SharePermissionDeniedError(
                f"unsupported share_type: {share_type!r}",
            )

        if share_type == "organization":
            # 空 organization_id 的 organization 分享视为无效配置，拒绝一切访问。
            if not organization_id:
                raise SharePermissionDeniedError(
                    "organization share missing organization_id",
                )
            if not user or not getattr(user, "id", None):
                raise SharePermissionDeniedError(
                    "Login required for organization share",
                )
            from apps.tabtinspace.models import OrganizationMember

            is_member = OrganizationMember.objects.filter(
                organization_id=organization_id,
                user=user,
            ).exists()
            if not is_member:
                raise SharePermissionDeniedError(
                    "Not a member of the organization",
                )

        if getattr(share, "has_password", False):
            if not password:
                raise SharePasswordRequiredError("Password required")
            if not share.check_password(password):
                raise SharePasswordIncorrectError("Incorrect password")

        cls._ensure_resource_shareable(cls._resource_from_share(share))

    @classmethod
    def issue_share_collab_token(cls, share: Any, *, user: Any = None) -> dict:
        """签发短时效 share collab token（调用前须已通过 verify_share_access）。"""
        from .collab_token import build_share_guest_id, issue_share_collab_token as _issue_token

        if not cls.collab_resource_type:
            raise NotImplementedError(
                f"{cls.__name__} must set collab_resource_type to issue share collab tokens",
            )

        share_permission = getattr(share, "permission", "view")
        resource = cls._resource_from_share(share)
        guest_id = build_share_guest_id(share.share_id, user)

        token = _issue_token(
            share_id=share.share_id,
            resource_type=cls.collab_resource_type,
            resource_id=str(resource.id),
            share_permission=share_permission,
            guest_id=guest_id,
        )

        from .collab_token import _SHARE_PERM_TO_COLLAB_PERM

        collab_permission = _SHARE_PERM_TO_COLLAB_PERM.get(share_permission, "view")

        return {
            "share_collab_token": token,
            "resource_type": cls.collab_resource_type,
            "resource_id": str(resource.id),
            "permission": collab_permission,
        }

    # ── 公开端点入口：get_share_by_id ──

    @classmethod
    def get_share_by_id(cls, share_id: str) -> Any:
        """根据 share_id 加载 share，并 reject 三种异常状态：
        not_found / inactive / expired。

        如子类设置了 ``share_select_related``，查询会带上对应的 select_related
        以避免后续序列化读取关联资源时的 N+1。

        Raises:
            ShareNotFoundError: 为空 / 不存在 / is_active=False
            ShareExpiredError: 已过 expire_at 或超 max_visits

        Returns:
            活跃且未过期的 Share 实例
        """
        if cls.share_model is None:
            raise NotImplementedError(
                f"{cls.__name__} must set share_model class attribute",
            )

        if not share_id:
            raise ShareNotFoundError("Share id is empty")

        manager = cls.share_model.objects.using(cls.db_alias)
        if cls.share_select_related:
            manager = manager.select_related(*cls.share_select_related)

        try:
            share = manager.get(share_id=share_id)
        except cls.share_model.DoesNotExist:
            raise ShareNotFoundError(f"Share {share_id} not found")

        if not getattr(share, "is_active", True):
            raise ShareNotFoundError(f"Share {share_id} is inactive")

        if cls.is_expired(share):
            raise ShareExpiredError(f"Share {share_id} has expired")

        cls._ensure_resource_shareable(cls._resource_from_share(share))
        return share

    # ── 管理端点入口：load_resource_for_management ──

    @classmethod
    def load_resource_for_management(
        cls,
        resource_id: Any,
        operator: Any,
        *,
        required_role: str = "admin",
    ) -> Any:
        """**管理端点唯一防越权入口** —— P0-2 修复核心。

        任何 ``create / get / close / refresh share`` 端点必须先调用本方法，
        而不是直接 ``Resource.objects.get(id=...)``。

        校验顺序：

        1. 资源存在性
        2. operator 已登录
        3. operator 是 resource owner（短路通过）
        4. 否则委托给子类 ``check_resource_admin(resource, operator, required_role)``

        Raises:
            ShareNotFoundError: 资源不存在
            ShareManagementPermissionDeniedError: 未登录或权限不足

        Returns:
            通过校验的 resource 实例
        """
        if cls.resource_model is None:
            raise NotImplementedError(
                f"{cls.__name__} must set resource_model class attribute",
            )

        try:
            resource = (
                cls.resource_model.objects.using(cls.db_alias)
                .get(id=resource_id)
            )
        except cls.resource_model.DoesNotExist:
            raise ShareNotFoundError(f"Resource {resource_id} not found")

        cls._ensure_resource_shareable(resource)

        if not operator or not getattr(operator, "id", None):
            raise ShareManagementPermissionDeniedError(
                "Login required",
            )

        owner_id = getattr(resource, "owner_id", None)
        if owner_id and str(owner_id) == str(operator.id):
            return resource

        if cls.check_resource_admin(resource, operator, required_role=required_role):
            return resource

        logger.info(
            "[PublicShare] management permission denied: operator=%s resource=%s role=%s service=%s",
            getattr(operator, "id", None),
            resource_id,
            required_role,
            cls.__name__,
        )
        raise ShareManagementPermissionDeniedError(
            f"User {operator.id} lacks {required_role} permission on resource {resource_id}",
        )

    # ── 跨租户校验 ──

    @classmethod
    def validate_organization_scope(
        cls,
        resource: Any,
        target_organization_id: Any,
    ) -> None:
        """organization 分享的严格作用域校验：``target_organization_id`` 必须非空，
        且必须等于 ``resource.organization_id``。

        本期仅支持「分享给资源所属团队」——不支持跨团队分享，因此不提供
        宽松模式。如未来要做跨团队分享，应在产品层定义清楚后再扩展，而不是
        在此留一个长期不通的开关。

        Raises:
            ShareOrganizationMismatchError: 为空或与资源所属团队不一致
        """
        if not target_organization_id:
            raise ShareOrganizationMismatchError(
                "organization_id must be non-empty for organization-scoped share",
            )

        resource_wt = getattr(resource, "organization_id", None)
        if str(target_organization_id) != str(resource_wt):
            raise ShareOrganizationMismatchError(
                f"organization_id {target_organization_id} mismatches resource organization {resource_wt}",
            )

    # ── 业务便捷方法：create_or_update / disable / refresh ──

    @classmethod
    def create_or_update_share(
        cls,
        resource: Any,
        operator: Any,
        *,
        share_type: str = "public",
        permission: str = "view",
        password: Optional[str] = None,
        expire_at: Any = None,
        allow_download: bool = True,
        allow_copy: bool = True,
        organization_id: str = "",
        extra_fields: Optional[dict] = None,
    ) -> Any:
        """创建或更新一个活跃 share（PATCH 语义）。

        - 已存在同 (resource, share_type) 活跃 share → 更新该条
        - 不存在 → 新建一条 share

        ``password`` 走三态语义（见 ``apply_password``）。

        子类如有特殊业务字段（如 tabslide 有 ``allow_export``），
        可通过 ``extra_fields`` dict 注入。

        ``share_type='organization'`` 时：若未传 ``organization_id``，从
        ``resource.organization_id`` 推导，再经 ``validate_organization_scope``
        强制非空且与资源归属一致——避免空 ID 在鉴权门被当成公开链接。

        本方法不在内部校验 operator 是否有 admin 权限 ——
        调用方必须先调 ``load_resource_for_management`` 完成防越权校验，
        否则即视为 P0-2 漏修。

        Returns:
            新建或更新后的 Share 实例
        """
        if cls.share_model is None:
            raise NotImplementedError(
                f"{cls.__name__} must set share_model class attribute",
            )

        if share_type == "organization":
            resolved_org = (organization_id or "").strip()
            if not resolved_org:
                resolved_org = str(getattr(resource, "organization_id", "") or "")
            cls.validate_organization_scope(resource, resolved_org)
            organization_id = resolved_org
        else:
            organization_id = (organization_id or "").strip()

        manager = cls.share_model.objects.using(cls.db_alias)
        resource_field = cls._get_resource_fk_name()
        lookup = {
            resource_field: resource,
            "share_type": share_type,
            "is_active": True,
        }
        existing = manager.filter(**lookup).first()

        if existing is not None:
            existing.permission = permission
            existing.expire_at = expire_at
            existing.allow_download = allow_download
            existing.allow_copy = allow_copy
            existing.organization_id = organization_id or ""
            update_fields = [
                "permission",
                "expire_at",
                "allow_download",
                "allow_copy",
                "organization_id",
                "updated_at",
            ]
            if cls.apply_password(existing, password):
                update_fields.append("password_hash")
            if extra_fields:
                for k, v in extra_fields.items():
                    setattr(existing, k, v)
                    if k not in update_fields:
                        update_fields.append(k)
            existing.save(using=cls.db_alias, update_fields=update_fields)
            return existing

        init_kwargs = {
            resource_field: resource,
            "share_type": share_type,
            "permission": permission,
            "expire_at": expire_at,
            "allow_download": allow_download,
            "allow_copy": allow_copy,
            "organization_id": organization_id or "",
            "created_by": operator,
        }
        if extra_fields:
            init_kwargs.update(extra_fields)
        share = cls.share_model(**init_kwargs)
        if password:
            share.set_password(password)
        share.save(using=cls.db_alias)
        return share

    @classmethod
    def get_active_share(
        cls,
        resource: Any,
        share_type: str = "public",
    ) -> Any:
        """获取指定资源 + 类型下当前活跃的 share（如有）。"""
        if cls.share_model is None:
            raise NotImplementedError(
                f"{cls.__name__} must set share_model class attribute",
            )
        resource_field = cls._get_resource_fk_name()
        return (
            cls.share_model.objects.using(cls.db_alias)
            .filter(**{resource_field: resource}, share_type=share_type, is_active=True)
            .first()
        )

    @classmethod
    def disable_share(
        cls,
        resource: Any,
        share_type: str = "public",
    ) -> int:
        """关闭指定资源 + 类型下当前活跃的 share。

        本方法不在内部校验 operator —— 调用方必须先走
        ``load_resource_for_management``（与 ``create_or_update_share`` 同款约束）。

        Returns:
            被关闭的 share 行数（通常 0 或 1）
        """
        if cls.share_model is None:
            raise NotImplementedError(
                f"{cls.__name__} must set share_model class attribute",
            )
        resource_field = cls._get_resource_fk_name()
        return (
            cls.share_model.objects.using(cls.db_alias)
            .filter(**{resource_field: resource}, share_type=share_type, is_active=True)
            .update(is_active=False, updated_at=timezone.now())
        )

    @classmethod
    def refresh_share_id(
        cls,
        resource: Any,
        share_type: str = "public",
    ) -> Any:
        """重新生成 share_id（让旧短链立即失效，常用于「重置链接」按钮）。

        本方法不在内部校验 operator —— 调用方必须先走
        ``load_resource_for_management``。

        Returns:
            刷新后的 Share 实例，若无活跃 share 则返回 None。
        """
        share = cls.get_active_share(resource, share_type)
        if share is None:
            return None
        share.share_id = cls.generate_share_id()
        share.save(using=cls.db_alias, update_fields=["share_id", "updated_at"])
        return share

    # ── 内部工具 ──

    @classmethod
    def _get_resource_fk_name(cls) -> str:
        """根据 ``resource_model`` 的类名推断 share 模型上对应的 ForeignKey
        字段名（Django 约定：lowercase class name）。

        例：DocumentShare.document、TableShare.table、SlideShare.slide。

        子类如违反约定可 override 本方法返回真实字段名。
        """
        if cls.resource_model is None:
            raise NotImplementedError(
                f"{cls.__name__} must set resource_model class attribute",
            )
        return cls.resource_model.__name__.lower()

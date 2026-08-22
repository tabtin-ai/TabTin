from django.conf import settings
"""
TabDoc 分享 Service

- ``DocumentShareService`` 继承自 ``PublicShareService``
  （``apps.services.common.public_share``），复用 share_id 生成、密码三态、
  过期判断、verify_share_access、横向越权防护、organization 作用域校验等核心契约，
  仅覆盖 ``check_resource_admin`` / ``serialize_meta`` / ``serialize_content``
  三个抽象方法。分享的公开/管理端点直接调用 ``DocumentShareService.*``。
- 本模块另含协作者邀请/管理（``invite_collaborators`` 等）。
"""

import logging
from datetime import timedelta
from typing import Optional

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import connections, models, transaction
from django.utils import timezone

from apps.services.common.public_share import PublicShareService
from apps.services.common.public_share.exceptions import (
    SharePublicExposureAcknowledgementRequiredError,
)
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.tabdoc.models import Document, DocumentPermission, DocumentShare, DocumentShareComment
from apps.tabdoc.services.comment_service import DocumentCommentService

logger = logging.getLogger("tabdoc.share")

TABDOC_DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
MAX_BATCH_INVITE = 50
DEDUPE_WINDOW_MINUTES = 5
VALID_PERMISSIONS = {"viewer", "editor", "admin"}
VALID_SHARE_TYPES = frozenset({"public", "organization"})
VALID_SHARE_LINK_PERMISSIONS = {"view", "comment", "edit"}
SHARE_COMMENTABLE_PERMISSIONS = {"comment", "edit"}
MAX_SHARE_MENTION_CANDIDATES = 200

__all__ = [
    "CollaboratorError",
    "DocumentShareService",
    "invite_collaborators",
    "list_collaborators",
    "list_documents_shared_with_me",
    "update_collaborator_permission",
    "remove_collaborator",
]


class CollaboratorError(Exception):
    """协作者邀请/管理 service 的统一异常基类。"""

    def __init__(self, code: str, message: str = "", status: int = 400, data=None):
        self.code = code
        self.message = message
        self.status = status
        self.data = data
        super().__init__(message or code)


class DocumentShareService(PublicShareService):
    """TabDoc 分享 service（PRD §3.4 / §5 Phase 1.1）。

    通过子类化 ``PublicShareService`` 复用 share_id 生成、密码三态、
    organization 校验、横向越权防护与跨租户校验 helper，仅覆盖以下抽象方法：

    - ``check_resource_admin``：桥接 ``DocumentService.check_document_permission``
      + R7 organization admin fallback（避免 doc 上有任何 active permission 时
      organization owner/admin 被误判为无权管理 share）
    - ``serialize_meta`` / ``serialize_content``：把 share 序列化为 view 层
      响应体（与历史 ``get_shared_document_meta`` / ``get_shared_document_content``
      行为对齐）
    """

    share_model = DocumentShare
    resource_model = Document
    db_alias = TABDOC_DB
    share_select_related = ("document",)
    collab_resource_type = "docs"
    valid_share_types = VALID_SHARE_TYPES

    @classmethod
    def check_resource_admin(
        cls,
        resource: Document,
        user,
        *,
        required_role: str = "admin",
    ) -> bool:
        """检查 user 对 document 是否具备 admin（或指定 required_role）权限。

        ：只认 owner + 显式 DocumentPermission，**不再**回退组织角色。
        组织管理员对未分享文档没有分享管理权；治理入口后置。
        """
        if not user or not getattr(user, "id", None):
            return False

        try:
            from apps.tabdoc.services.document_service import DocumentService

            svc = DocumentService(user=user)
            return bool(svc.check_document_permission(resource, required_role))
        except Exception:
            logger.exception(
                "[DocumentShareService] check_document_permission raised",
            )
            return False

    @classmethod
    def get_effective_active_share(cls, resource: Document) -> Optional[DocumentShare]:
        """返回文档当前唯一活跃分享（任意 share_type）。

        安全收口后每文档最多一条 active share；若历史脏数据仍有多条，
        优先返回 organization（更窄），再返回 public。
        """
        qs = (
            DocumentShare.objects.using(cls.db_alias)
            .filter(document=resource, is_active=True)
            .order_by("created_at")
        )
        shares = list(qs[:5])
        if not shares:
            return None
        for share in shares:
            if share.share_type == "organization":
                return share
        return shares[0]

    @classmethod
    def list_active_shares(cls, resource: Document) -> list[DocumentShare]:
        return list(
            DocumentShare.objects.using(cls.db_alias)
            .filter(document=resource, is_active=True)
            .order_by("created_at")
        )

    @classmethod
    def create_or_update_share_exclusive(
        cls,
        resource: Document,
        operator,
        *,
        share_type: str = "organization",
        permission: str = "view",
        password: Optional[str] = None,
        expire_at=None,
        allow_download: bool = True,
        allow_copy: bool = True,
        organization_id: str = "",
        acknowledge_public_exposure: bool = False,
    ) -> DocumentShare:
        """创建/更新分享，并保证每文档最多一条 active share。

        - 扩大到 ``public``（当前无*可访问*的 public）时必须
          ``acknowledge_public_exposure=True``，否则抛
          ``SharePublicExposureAcknowledgementRequiredError``。
          「可访问」= ``is_active`` 且未 ``is_expired()``；已过期的
          public 行不算，重开/续期一律走确认，避免静默复活旧链接。
        - ``share_type`` 仅接受 ``public`` / ``organization``（入口白名单，
          不依赖 API schema）；非法值直接 ``ValidationError``，避免落入
          ``else`` 后跳过 organization / public-ack 校验并写成脏数据。
        - ``share_type='organization'`` 时强制绑定资源
          ``organization_id``（可省略入参，由文档归属推导），空 ID 直接拒绝，
          避免非 HTTP 调用方写出「组织分享却匿名可访问」的脏数据。
        - 切换范围时先停用其他 share_type，再 upsert 目标类型，
          使旧公网 ``share_id`` 在收窄后立即失效。
        """
        if share_type not in VALID_SHARE_TYPES:
            raise ValidationError(
                f"share_type must be one of {sorted(VALID_SHARE_TYPES)}"
            )
        if permission not in VALID_SHARE_LINK_PERMISSIONS:
            raise ValidationError(
                f"permission must be one of {sorted(VALID_SHARE_LINK_PERMISSIONS)}"
            )

        resolved_organization_id = (organization_id or "").strip()
        if share_type == "organization":
            if not resolved_organization_id:
                resolved_organization_id = str(
                    getattr(resource, "organization_id", "") or ""
                )
            cls.validate_organization_scope(resource, resolved_organization_id)
        else:
            resolved_organization_id = ""

        with transaction.atomic(using=cls.db_alias):
            # 锁文档行，避免并发双开两条 active share。
            (
                Document.objects.using(cls.db_alias)
                .select_for_update()
                .get(pk=resource.pk)
            )
            active_shares = cls.list_active_shares(resource)
            has_accessible_public = any(
                s.share_type == "public" and not s.is_expired()
                for s in active_shares
            )
            widening_to_public = share_type == "public" and not has_accessible_public
            if widening_to_public and not acknowledge_public_exposure:
                raise SharePublicExposureAcknowledgementRequiredError(
                    "acknowledge_public_exposure required to widen share to public",
                )

            for other in active_shares:
                if other.share_type != share_type:
                    other.is_active = False
                    other.save(
                        using=cls.db_alias,
                        update_fields=["is_active", "updated_at"],
                    )

            return cls.create_or_update_share(
                resource,
                operator,
                share_type=share_type,
                permission=permission,
                password=password,
                expire_at=expire_at,
                allow_download=allow_download,
                allow_copy=allow_copy,
                organization_id=resolved_organization_id,
            )

    @classmethod
    def serialize_meta(
        cls,
        share: DocumentShare,
        *,
        include_protected: bool = True,
    ) -> dict:
        """序列化 share 的元信息。

        ``include_protected`` 控制是否返回业务字段：

        - ``True``（默认，调用方已通过 ``verify_share_access``）：返回完整 meta
          （title / icon / cover_image / cover_position / permission /
          allow_download / allow_copy / created_at + has_password，以及
          document_id / space_id / organization_id / location_path，供 Web
          登录态页签与路径展示）
        - ``False``（密码未校验 / organization 校验失败）：仅返回最小集
          （share_id / share_type / has_password / title / icon /
          cover_image / cover_position），即 PRD §4.3 P0-3 修复方案，
          避免在未授权访问下暴露 ``permission`` / ``allow_*`` / ``created_at``
          这种次敏感字段，但保留 title/icon/cover 用于前端密码态展示

        title/icon/cover 这一组属于「装饰性元信息」——前端 SharedDocPage 在
        密码态需要它们才能渲染出非白屏 UI；与 tabdata 修复对称（tabdata
        强制把 fields[] 移到密码后，是因为 fields 暴露完整业务 schema）。
        """
        doc = share.document
        from apps.tabdoc.services.image_asset_service import ImageAssetService

        cover_position_x = cls._serialize_cover_position_x(doc)
        cover_scale = cls._serialize_cover_scale(doc)
        base = {
            "share_id": share.share_id,
            "share_type": share.share_type,
            "has_password": share.has_password,
            "title": doc.title,
            "icon": doc.icon or "",
            "cover_image": (
                ImageAssetService.resolve_cover_url(doc)
                if include_protected
                else ("" if (doc.properties or {}).get("cover_image_file_id") else doc.cover_image or "")
            ),
            "cover_position": (
                doc.cover_position if doc.cover_position is not None else 0.5
            ),
            "cover_position_x": cover_position_x,
            "cover_scale": cover_scale,
        }
        if not include_protected:
            base["requires_login"] = cls.share_requires_authenticated_user(share)
            return base

        base.update({
            "permission": share.permission,
            "requires_login": cls.share_requires_authenticated_user(share),
            "allow_download": share.allow_download,
            "allow_copy": share.allow_copy,
            "created_at": share.created_at.isoformat() if share.created_at else None,
            "document_id": str(doc.id),
            "space_id": str(doc.space_id) if getattr(doc, "space_id", None) else None,
            "organization_id": (
                str(doc.organization_id) if getattr(doc, "organization_id", None) else None
            ),
            "location_path": cls._build_location_path(doc),
        })
        return base

    @classmethod
    def _build_location_path(cls, doc: Document) -> list:
        """沿 parent 链向上解析文档路径（根 → 当前），供分享页 breadcrumb。

        仅返回装饰性字段（id / title / icon）；深度上限 20，防环。
        """
        chain = []
        seen = set()
        current = doc
        for _ in range(20):
            if current is None:
                break
            current_id = str(current.id)
            if current_id in seen:
                break
            seen.add(current_id)
            chain.append({
                "id": current_id,
                "title": current.title or "",
                "icon": current.icon or "",
            })
            parent_id = getattr(current, "parent_id", None)
            if not parent_id:
                break
            current = (
                Document.objects.using(TABDOC_DB)
                .only("id", "title", "icon", "parent_id")
                .filter(id=parent_id)
                .first()
            )
        chain.reverse()
        return chain

    @staticmethod
    def _serialize_cover_position_x(doc: Document) -> float:
        properties = doc.properties if isinstance(doc.properties, dict) else {}
        value = properties.get("cover_position_x", 0.5)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0.5
        return max(0.0, min(1.0, float(value)))

    @staticmethod
    def _serialize_cover_scale(doc: Document) -> float:
        properties = doc.properties if isinstance(doc.properties, dict) else {}
        value = properties.get("cover_scale", 1.0)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 1.0
        return max(1.0, min(3.0, float(value)))

    @classmethod
    def serialize_content(cls, share: DocumentShare) -> dict:
        """序列化 share 的完整文档内容（含正文）。

        与历史 ``get_shared_document_content`` 行为一致，**包含**
        ``share.increment_visit()`` 的副作用。
        """
        doc = share.document
        share.increment_visit()
        from apps.tabdoc.services.image_asset_service import ImageAssetService
        from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown

        materialized_json = ImageAssetService.materialize_pm_json(
            doc,
            doc.description_json or {},
        )
        materialized_markdown = pm_json_to_markdown(materialized_json)

        return {
            "title": doc.title,
            "icon": doc.icon or "",
            "cover_image": ImageAssetService.resolve_cover_url(doc),
            # description_json 是 ProseMirror/TipTap JSON，供分享页用与编辑器同款的
            # 渲染管线展示（保证富文本块/排版一致）；markdown/plaintext 保留作下载与退路。
            "description_json": materialized_json,
            "description_markdown": materialized_markdown or doc.description_markdown or "",
            "description_plaintext": doc.description_plaintext or "",
            "font_style": doc.font_style or "default",
            "is_full_width": doc.is_full_width,
            "tags": doc.tags or [],
            "latest_version": int(doc.latest_version or 0),
            "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        }

    @classmethod
    def share_requires_authenticated_user(cls, share: DocumentShare) -> bool:
        """可编辑/可评论分享必须先登录，再进入交互能力。"""
        return share.permission in SHARE_COMMENTABLE_PERMISSIONS

    @classmethod
    def ensure_authenticated_interactive_user(cls, share: DocumentShare, *, user) -> None:
        if cls.share_requires_authenticated_user(share) and not getattr(user, "id", None):
            from apps.services.common.public_share.exceptions import SharePermissionDeniedError

            raise SharePermissionDeniedError("Need login")

    @classmethod
    def get_shared_content(
        cls,
        share: DocumentShare,
        *,
        user,
        password: str = "",
    ) -> dict:
        """获取分享正文；可编辑/可评论分享先要求登录。"""
        cls.ensure_authenticated_interactive_user(share, user=user)
        cls.verify_share_access(share, password=password, user=user)
        return cls.serialize_content(share)

    @classmethod
    def save_shared_content(
        cls,
        share: DocumentShare,
        *,
        user,
        password: str = "",
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
        content_pm_json: dict,
        content_markdown: str,
        content_plaintext: str,
    ) -> Document:
        """通过分享链接保存文档内容（permission=edit 时可用）。"""
        from apps.services.common.public_share.exceptions import SharePermissionDeniedError
        from apps.tabdoc.services.document_service import DocumentService

        cls.ensure_authenticated_interactive_user(share, user=user)
        cls.verify_share_access(share, password=password, user=user)
        if share.permission != "edit":
            raise SharePermissionDeniedError("Share link does not allow editing")

        doc = share.document
        svc = DocumentService(user=user, editor_type="share")
        return svc.save_content(
            doc,
            share_grant=share,
            base_version=base_version,
            base_updated_at=base_updated_at,
            content_pm_json=content_pm_json or {},
            content_markdown=content_markdown or "",
            content_plaintext=content_plaintext or "",
        )

    @classmethod
    def list_share_comments(cls, share: DocumentShare, *, user=None) -> list[dict]:
        """列出分享评论。调用方需先完成分享访问鉴权。"""
        from apps.services.common.public_share.exceptions import SharePermissionDeniedError

        cls.ensure_authenticated_interactive_user(share, user=user)
        if share.permission not in SHARE_COMMENTABLE_PERMISSIONS:
            raise SharePermissionDeniedError("Share link does not allow commenting")

        return DocumentCommentService.list_legacy_comments(share.document)

    @classmethod
    def list_share_mention_candidates(
        cls,
        share: DocumentShare,
        *,
        user,
        password: str = "",
    ) -> list[dict]:
        """返回分享评论可用的 @ 成员候选（文档所属组织成员 + owner）。

        仅 comment/edit 分享、且通过访问校验后可用；字段最小化，邮箱脱敏。
        """
        from apps.services.common.public_share.exceptions import SharePermissionDeniedError
        from apps.tabtinspace.models import OrganizationMember

        cls.ensure_authenticated_interactive_user(share, user=user)
        cls.verify_share_access(share, password=password, user=user)
        if share.permission not in SHARE_COMMENTABLE_PERMISSIONS:
            raise SharePermissionDeniedError("Share link does not allow commenting")

        document = share.document
        organization_id = getattr(document, "organization_id", None)
        if not organization_id:
            return []

        member_user_ids = list(
            OrganizationMember.objects.using(cls.db_alias)
            .filter(organization_id=organization_id)
            .order_by("joined_at")
            .values_list("user_id", flat=True)[:MAX_SHARE_MENTION_CANDIDATES]
        )
        user_ids: set[str] = {str(uid) for uid in member_user_ids if uid}
        owner_id = str(getattr(document, "owner_id", "") or "")
        if owner_id:
            user_ids.add(owner_id)
        current_user_id = str(getattr(user, "id", "") or "")
        if current_user_id:
            user_ids.add(current_user_id)
        if not user_ids:
            return []

        User = get_user_model()
        users = list(User.objects.using("default").filter(id__in=list(user_ids)))
        candidates: list[dict] = []
        for member in users:
            nickname = (getattr(member, "nickname", "") or "").strip()
            username = (getattr(member, "username", "") or "").strip()
            display_name = nickname or username or str(member.id)[:8]
            candidates.append(
                {
                    "user_id": str(member.id),
                    "display_name": display_name,
                    "account_name": username or None,
                    "avatar": build_public_asset_url(getattr(member, "avatar", "") or "") or None,
                    "email": _mask_email(getattr(member, "email", "")),
                }
            )

        candidates.sort(key=lambda item: (item["display_name"].lower(), item["user_id"]))
        return candidates[:MAX_SHARE_MENTION_CANDIDATES]

    @classmethod
    def list_document_comments(cls, document: Document) -> list[dict]:
        """列出文档下的所有评论，包含分享页评论和文档内评论。"""
        return DocumentCommentService.list_legacy_comments(document)

    @classmethod
    def create_share_comment(
        cls,
        share: DocumentShare,
        *,
        user,
        password: str = "",
        body: str,
        selected_text: str = "",
        author_name: str = "",
        mention_user_ids: Optional[list[str]] = None,
    ) -> DocumentShareComment:
        """通过分享链接新增评论（permission=comment/edit 时可用）。"""
        from apps.services.common.public_share.exceptions import SharePermissionDeniedError

        cls.ensure_authenticated_interactive_user(share, user=user)
        cls.verify_share_access(share, password=password, user=user)
        if share.permission not in SHARE_COMMENTABLE_PERMISSIONS:
            raise SharePermissionDeniedError("Share link does not allow commenting")
        if not (body or "").strip():
            raise ValueError("评论内容不能为空")

        thread = DocumentCommentService.create_thread(
            share.document,
            user=user,
            body=body,
            scope="text_range" if (selected_text or "").strip() else "document",
            selected_text=selected_text,
            author_name=author_name,
            mention_user_ids=mention_user_ids,
            share=share,
        )
        root_id = thread.messages.only("id").get(kind="root").id
        comment = DocumentShareComment.objects.using(cls.db_alias).select_related(
            "author", "share"
        ).get(id=root_id)
        return comment

    @classmethod
    def create_document_comment(
        cls,
        document: Document,
        *,
        user,
        body: str,
        selected_text: str = "",
        author_name: str = "",
        mention_user_ids: Optional[list[str]] = None,
    ) -> DocumentShareComment:
        """在登录后的文档详情内新增评论，share 为空。"""
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        if not (body or "").strip():
            raise ValueError("评论内容不能为空")

        thread = DocumentCommentService.create_thread(
            document,
            user=user,
            body=body,
            scope="text_range" if (selected_text or "").strip() else "document",
            selected_text=selected_text,
            author_name=author_name,
            mention_user_ids=mention_user_ids,
        )
        root_id = thread.messages.only("id").get(kind="root").id
        comment = DocumentShareComment.objects.using(cls.db_alias).select_related(
            "author", "share"
        ).get(id=root_id)
        return comment

    @classmethod
    def delete_document_comment(
        cls,
        document: Document,
        *,
        comment_id: str,
        user,
    ) -> DocumentShareComment:
        """软删除登录用户自己发布的文档评论。"""
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")

        comment = DocumentCommentService.delete_legacy_comment(
            document,
            comment_id,
            user=user,
        )
        return comment

    @staticmethod
    def serialize_comment(comment: DocumentShareComment) -> dict:
        return DocumentCommentService.serialize_legacy_comment(comment)


# ════════════════════════════════════════════════════════════════════
# 协作者邀请 / 管理（PRD §五块 1, D1-D11）
# ════════════════════════════════════════════════════════════════════


def _mask_email(email: Optional[str]) -> str:
    """与 search-users API 一致的邮箱脱敏（取首尾字符 + 域名）。"""
    if not email or not isinstance(email, str) or "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    if not local:
        return ""
    if len(local) <= 2:
        masked = local[0] + "***"
    else:
        masked = local[0] + "***" + local[-1]
    return f"{masked}@{domain}"


def _user_brief(u) -> dict:
    """统一 UserBrief 序列化（D9：owner / collaborator 共用）。

    User.avatar 存 OSS object key，必须经 build_public_asset_url 转成 CDN URL，
    否则分享弹窗会把相对路径当成本站资源加载失败，只剩首字母兜底。
    """
    if u is None:
        return {"user_id": "", "nickname": "", "avatar": None, "email": ""}
    nickname = getattr(u, "nickname", "") or getattr(u, "username", "") or ""
    return {
        "user_id": str(u.id),
        "nickname": nickname,
        "avatar": build_public_asset_url(getattr(u, "avatar", "") or "") or None,
        "email": _mask_email(getattr(u, "email", "")),
    }


def _format_inviter_name(inviter) -> str:
    """D3 inviter_name fallback：nickname → email 前缀 → uuid 前 8 位。"""
    if inviter is None:
        return ""
    nickname = getattr(inviter, "nickname", "") or getattr(inviter, "username", "")
    if nickname:
        return nickname
    email = getattr(inviter, "email", "") or ""
    if email and "@" in email:
        return email.split("@", 1)[0]
    return str(getattr(inviter, "id", ""))[:8]


def _get_document_for_management(document_id, operator) -> Document:
    """加载文档并校验操作者具备 admin 权限。"""
    try:
        doc = Document.objects.using(TABDOC_DB).get(id=document_id)
    except Document.DoesNotExist:
        raise CollaboratorError("DOCUMENT_NOT_FOUND", "文档不存在", status=404)

    if not operator or not getattr(operator, "id", None):
        raise CollaboratorError("AUTH_REQUIRED", "需要登录", status=401)

    # owner 直接通过
    if str(getattr(doc, "owner_id", "") or "") == str(operator.id):
        return doc

    from apps.tabdoc.services.document_service import DocumentService

    svc = DocumentService(user=operator)
    if not svc.check_document_permission(doc, "admin"):
        raise CollaboratorError(
            "PERMISSION_DENIED",
            "需要 admin 权限以管理协作者",
            status=403,
        )
    return doc


def _get_document_for_view(document_id, viewer) -> Document:
    """加载文档并校验访问者具备 viewer+ 权限。"""
    try:
        doc = Document.objects.using(TABDOC_DB).get(id=document_id)
    except Document.DoesNotExist:
        raise CollaboratorError("DOCUMENT_NOT_FOUND", "文档不存在", status=404)

    if not viewer or not getattr(viewer, "id", None):
        raise CollaboratorError("AUTH_REQUIRED", "需要登录", status=401)

    if str(getattr(doc, "owner_id", "") or "") == str(viewer.id):
        return doc

    from apps.tabdoc.services.document_service import DocumentService

    svc = DocumentService(user=viewer)
    if not svc.check_document_permission(doc, "viewer"):
        raise CollaboratorError(
            "PERMISSION_DENIED", "无访问权限", status=403,
        )
    return doc


def _build_metadata(doc: Document, action: str, inviter, *, permission_from=None, permission_to=None) -> dict:
    """D3 完整 metadata 契约：8 字段必出现。"""
    return {
        "resource_type": "doc",
        "resource_id": str(doc.id),
        "resource_title": doc.title or "",
        "action": action,
        "permission_from": permission_from,
        "permission_to": permission_to,
        "inviter_id": str(getattr(inviter, "id", "")),
        "inviter_name": _format_inviter_name(inviter),
        "organization_id": str(doc.organization_id),
        # org-only时 space_id 为 None，勿序列化成字符串 "None"
        "space_id": str(doc.space_id) if doc.space_id else "",
        "behavior": (
            "view_context"
            if action == "invited"
            else "notification_only"
        ),
    }


def _notify_or_merge(
    user_id: str,
    action: str,
    metadata: dict,
    *,
    dedupe_window_minutes: int = DEDUPE_WINDOW_MINUTES,
) -> None:
    """D7 通知去重：5 分钟窗口内合并 (user, action, resource_id) 同类未读通知。

    合并规则（PRD §四 D7）：
    - invited + permission_changed 串：合并成单条 permission_changed，更新 permission_to
    - 多次 permission_changed：保留最后一条，UPDATE metadata
    - removed / auto_removed：始终新发，不合并

    所有 DB / WS 调用都通过 NotificationService.notify 这层，
    本函数只负责"是否要复用旧记录"的判断与原地更新。
    """
    from apps.services.notification.models import Notification
    from apps.services.notification.services.notification_service import NotificationService

    resource_id = metadata.get("resource_id", "")
    resource_type = metadata.get("resource_type", "")
    title = metadata.get("_title", "")
    body = metadata.get("_body", "")
    organization_id = metadata.get("organization_id", "") or ""

    # _title / _body 是 helper 私有字段，写库前剥离
    clean_meta = {k: v for k, v in metadata.items() if not k.startswith("_")}

    if action in ("removed", "auto_removed"):
        NotificationService.notify(
            user_id=str(user_id),
            type="resource_shared",
            title=title,
            body=body,
            metadata=clean_meta,
            organization_id=organization_id,
        )
        return

    window_start = timezone.now() - timedelta(minutes=dedupe_window_minutes)
    candidate_qs = Notification.objects.filter(
        user_id=str(user_id),
        type="resource_shared",
        is_read=False,
        created_at__gte=window_start,
        metadata__resource_id=resource_id,
        metadata__resource_type=resource_type,
    ).order_by("-created_at")

    existing = None
    for n in candidate_qs:
        prev_action = (n.metadata or {}).get("action")
        if prev_action in ("invited", "permission_changed"):
            existing = n
            break

    if existing is None:
        NotificationService.notify(
            user_id=str(user_id),
            type="resource_shared",
            title=title,
            body=body,
            metadata=clean_meta,
            organization_id=organization_id,
        )
        return

    # 合并：旧 action 是 invited 或 permission_changed → 统一升级为 permission_changed
    merged_meta = dict(existing.metadata or {})
    merged_action = "permission_changed"
    merged_meta["action"] = merged_action
    # permission_from 保留旧记录里的（最早起点），permission_to 覆盖为最新
    if "permission_from" not in merged_meta or merged_meta.get("permission_from") in (None, ""):
        merged_meta["permission_from"] = clean_meta.get("permission_from")
    merged_meta["permission_to"] = clean_meta.get("permission_to")
    merged_meta["behavior"] = clean_meta.get("behavior", "notification_only")
    # 其他字段以最新为准
    for k in (
        "resource_type",
        "resource_id",
        "resource_title",
        "inviter_id",
        "inviter_name",
        "organization_id",
        "space_id",
    ):
        if k in clean_meta:
            merged_meta[k] = clean_meta[k]

    existing.metadata = merged_meta
    existing.title = title
    existing.body = body
    existing.space_id = merged_meta.get("space_id", "") or ""
    # ：合并后必须 bump created_at，否则前端 newest-wins 仍会认为更早的
    # removed 更新，IM 重授权后的 invited 盖不住「你已被移出」遮罩。
    existing.created_at = timezone.now()
    existing.save(update_fields=["metadata", "title", "body", "space_id", "created_at"])


def _build_invitation_text(metadata: dict) -> tuple[str, str]:
    """根据 action 渲染 title / body（PRD §四 D3 通知文案表）。"""
    title_label = metadata.get("resource_title", "") or "（未命名）"
    inviter_name = metadata.get("inviter_name", "") or "未知用户"
    perm_to = metadata.get("permission_to")
    action = metadata.get("action")

    perm_label = {
        "viewer": "查看",
        "editor": "编辑",
        "admin": "管理",
    }
    perm_to_label = perm_label.get(perm_to, perm_to or "")

    if action == "invited":
        return (
            f"{inviter_name} 邀请你协作《{title_label}》",
            f"权限：{perm_to_label}",
        )
    if action == "permission_changed":
        return (
            f"你在《{title_label}》的权限调整为 {perm_to_label}",
            f"操作人：{inviter_name}",
        )
    if action == "removed":
        return (
            f"你被移出《{title_label}》",
            f"操作人：{inviter_name}",
        )
    if action == "auto_removed":
        return (
            f"因离开组织，你已从《{title_label}》移除",
            "",
        )
    # 兜底
    return (f"关于《{title_label}》", "")


def _schedule_notify(user_id: str, action: str, metadata: dict) -> None:
    """在事务提交后调用 _notify_or_merge（参考 invitation_service.py:205）。"""
    title, body = _build_invitation_text(metadata)
    enriched = dict(metadata)
    enriched["_title"] = title
    enriched["_body"] = body

    def _push():
        try:
            _notify_or_merge(user_id, action, enriched)
        except Exception as exc:
            logger.warning("协作者通知推送失败（非阻断）: %s", exc)

    connections[TABDOC_DB].on_commit(_push)


def _validate_permission(permission: str) -> None:
    if permission not in VALID_PERMISSIONS:
        raise CollaboratorError(
            "INVALID_PERMISSION",
            f"权限 {permission!r} 不合法，应为 viewer/editor/admin",
            status=400,
        )


def _schedule_document_collab_revoke(
    document_id, user_id: str, *, read_only: bool = False,
) -> None:
    """事务提交后异步踢/降级该用户在单文档上的 collab-live 连接（RV-015）。"""
    document_name = f"docs:{document_id}"
    user_id = str(user_id)

    def _do_revoke():
        try:
            from apps.collab.tasks import async_revoke_document_collab_access

            async_revoke_document_collab_access.delay(
                document_name, user_id, read_only=read_only,
            )
        except Exception:
            logger.warning(
                "[ShareService] schedule document collab revoke failed doc=%s user=%s read_only=%s",
                document_name,
                user_id,
                read_only,
                exc_info=True,
            )

    connections[TABDOC_DB].on_commit(_do_revoke)


def _filter_organization_members(organization_id, user_ids: list[str]) -> set[str]:
    """跨库安全：OrganizationMember 在 postgresql 库，user_id 用字符串集合返回。"""
    from apps.tabtinspace.models import OrganizationMember

    qs = OrganizationMember.objects.using(TABDOC_DB).filter(
        organization_id=organization_id, user_id__in=user_ids,
    ).values_list("user_id", flat=True)
    return {str(uid) for uid in qs}


def invite_collaborators(
    document_id, user_ids: list[str], permission: str, inviter,
    *, reactivate_inactive: bool = True,
) -> dict:
    """邀请协作者（D1 幂等 + D7 通知去重）。

    ``reactivate_inactive=False`` 用于资源卡等“仅首次授权”入口，保证共享服务
    不会在调用方预检后重新激活已撤权记录。
    返回：{'notified': int, 'skipped': [{user_id, reason}]}
    抛出：CollaboratorError(DOCUMENT_NOT_FOUND/PERMISSION_DENIED/RATE_LIMIT_EXCEEDED/INVALID_PERMISSION)
    """
    if not isinstance(user_ids, list):
        raise CollaboratorError("INVALID_INPUT", "user_ids 必须是数组", status=400)

    user_ids = [str(uid) for uid in user_ids if uid]
    if len(user_ids) > MAX_BATCH_INVITE:
        raise CollaboratorError(
            "RATE_LIMIT_EXCEEDED",
            f"单次最多邀请 {MAX_BATCH_INVITE} 人",
            status=400,
        )

    _validate_permission(permission)

    doc = _get_document_for_management(document_id, inviter)

    skipped: list[dict] = []
    owner_id_str = _resolve_owner_id(doc)
    inviter_id_str = str(inviter.id)

    candidates: list[str] = []
    seen: set[str] = set()
    for uid in user_ids:
        if uid in seen:
            continue
        seen.add(uid)
        if uid == inviter_id_str:
            skipped.append({"user_id": uid, "reason": "self"})
            continue
        if owner_id_str and uid == owner_id_str:
            skipped.append({"user_id": uid, "reason": "is_owner"})
            continue
        candidates.append(uid)

    if not candidates:
        return {"notified": 0, "skipped": skipped}

    valid_member_ids = _filter_organization_members(doc.organization_id, candidates)
    final_targets: list[str] = []
    for uid in candidates:
        if uid not in valid_member_ids:
            skipped.append({"user_id": uid, "reason": "not_in_organization"})
        else:
            final_targets.append(uid)

    if not final_targets:
        return {"notified": 0, "skipped": skipped}

    notified_count = 0
    newly_granted: list[str] = []
    changed_user_ids: list[str] = []
    independently_granted_user_ids: list[str] = []
    with transaction.atomic(using=TABDOC_DB):
        for uid in final_targets:
            existing = (
                DocumentPermission.objects.using(TABDOC_DB)
                .filter(document=doc, subject_type="user", subject_id=uid)
                .first()
            )
            if existing and existing.is_active:
                independently_granted_user_ids.append(uid)
                if existing.permission == permission:
                    # 幂等：完全沉默
                    continue
                old_permission = existing.permission
                existing.permission = permission
                existing.save(using=TABDOC_DB, update_fields=["permission", "updated_at"])
                metadata = _build_metadata(
                    doc, "permission_changed", inviter,
                    permission_from=old_permission, permission_to=permission,
                )
                _schedule_notify(uid, "permission_changed", metadata)
                changed_user_ids.append(uid)
                if permission == "viewer" and old_permission != "viewer":
                    _schedule_document_collab_revoke(doc.id, uid, read_only=True)
                notified_count += 1
            elif existing and not existing.is_active:
                if not reactivate_inactive:
                    skipped.append({"user_id": uid, "reason": "previously_removed"})
                    continue
                old_permission = existing.permission
                existing.is_active = True
                existing.permission = permission
                existing.save(using=TABDOC_DB, update_fields=["is_active", "permission", "updated_at"])
                metadata = _build_metadata(
                    doc, "invited", inviter,
                    permission_from=None, permission_to=permission,
                )
                _schedule_notify(uid, "invited", metadata)
                newly_granted.append(uid)
                independently_granted_user_ids.append(uid)
                notified_count += 1
            else:
                DocumentPermission.objects.using(TABDOC_DB).create(
                    document=doc,
                    subject_type="user",
                    subject_id=uid,
                    permission=permission,
                    is_active=True,
                    granted_by=inviter_id_str,
                    created_by=inviter,
                )
                metadata = _build_metadata(
                    doc, "invited", inviter,
                    permission_from=None, permission_to=permission,
                )
                _schedule_notify(uid, "invited", metadata)
                newly_granted.append(uid)
                independently_granted_user_ids.append(uid)
                notified_count += 1

    if newly_granted:
        try:
            from apps.tabtinspace.services.cloud_resource_visibility_events import (
                notify_cloud_resource_access_granted,
            )

            notify_cloud_resource_access_granted(
                resource_type="tabdoc",
                resource_id=str(doc.id),
                organization_id=str(doc.organization_id) if doc.organization_id else None,
                user_ids=newly_granted,
                actor_user_id=inviter_id_str,
                title=getattr(doc, "title", None),
                space_id=str(doc.space_id) if getattr(doc, "space_id", None) else None,
            )
        except Exception:
            logger.warning(
                "[ShareService]  access_granted publish failed doc=%s",
                doc.id,
                exc_info=True,
            )

    from apps.chat.conversation.services.session_share_resource_permission_service import (
        mark_resource_access_independently_granted,
    )

    mark_resource_access_independently_granted(
        resource_type="document",
        resource_id=str(doc.id),
        user_ids=independently_granted_user_ids,
        permission=permission,
    )

    if changed_user_ids:
        try:
            from apps.tabtinspace.services.cloud_resource_visibility_events import (
                notify_cloud_resource_access_changed,
            )

            notify_cloud_resource_access_changed(
                resource_type="tabdoc",
                resource_id=str(doc.id),
                organization_id=str(doc.organization_id) if doc.organization_id else None,
                user_ids=changed_user_ids,
                actor_user_id=inviter_id_str,
                space_id=str(doc.space_id) if getattr(doc, "space_id", None) else None,
                db_alias=TABDOC_DB,
            )
        except Exception:
            logger.warning(
                "[ShareService] access_changed publish failed doc=%s users=%s",
                doc.id,
                changed_user_ids,
                exc_info=True,
            )
    return {"notified": notified_count, "skipped": skipped}


def _resolve_owner_id(doc) -> str:
    """文档 owner 的唯一事实来源是 ``Document.owner_id``。"""
    return str(getattr(doc, "owner_id", "") or "")


def _permission_for_collaborator_output(permission: str) -> str:
    if permission == "owner":
        return "admin"
    return permission


def list_collaborators(document_id, viewer) -> dict:
    """返回 {'owner': UserBrief, 'collaborators': [CollaboratorOut]}。

    D9 owner 单独 + D1 subject_type='user' 过滤；
    跨库两步查询：DocumentPermission → User.objects.filter(id__in=...)。
    """
    doc = _get_document_for_view(document_id, viewer)
    User = get_user_model()

    perms = list(
        DocumentPermission.objects.using(TABDOC_DB)
        .filter(document=doc, is_active=True, subject_type="user")
        .order_by("created_at")
    )

    subject_ids = [p.subject_id for p in perms]
    owner_id_str = _resolve_owner_id(doc)
    extra_lookup_ids = set(subject_ids)
    if owner_id_str:
        extra_lookup_ids.add(owner_id_str)

    users_map: dict[str, object] = {}
    if extra_lookup_ids:
        for u in User.objects.using("default").filter(id__in=list(extra_lookup_ids)):
            users_map[str(u.id)] = u

    owner_brief = _user_brief(users_map.get(owner_id_str)) if owner_id_str else _user_brief(None)
    # 若 owner 在 User 表查不到（不该发生但兜底），起码返回 user_id
    if owner_id_str and owner_brief["user_id"] == "":
        owner_brief = {
            "user_id": owner_id_str,
            "nickname": "",
            "avatar": None,
            "email": "",
        }

    collaborators: list[dict] = []
    for p in perms:
        # 只有 owner_id 指向的真实 owner 单独成卡片；历史 owner 权限仍需可见可收回。
        if str(p.subject_id) == owner_id_str:
            continue
        u = users_map.get(p.subject_id)
        brief = _user_brief(u) if u else {
            "user_id": p.subject_id,
            "nickname": "",
            "avatar": None,
            "email": "",
        }
        item = dict(brief)
        item["permission"] = _permission_for_collaborator_output(p.permission)
        item["created_at"] = p.created_at.isoformat() if p.created_at else None
        collaborators.append(item)

    return {"owner": owner_brief, "collaborators": collaborators}


def update_collaborator_permission(
    document_id, user_id: str, permission: str, operator,
) -> dict:
    """更新协作者权限。返回更新后的 CollaboratorOut。"""
    user_id = str(user_id)
    _validate_permission(permission)
    doc = _get_document_for_management(document_id, operator)

    owner_id_str = _resolve_owner_id(doc)
    if owner_id_str and user_id == owner_id_str:
        raise CollaboratorError(
            "CANNOT_MODIFY_OWNER", "owner 的权限不可修改", status=400,
        )

    perm = (
        DocumentPermission.objects.using(TABDOC_DB)
        .filter(document=doc, subject_type="user", subject_id=user_id, is_active=True)
        .first()
    )
    if perm is None:
        raise CollaboratorError(
            "COLLABORATOR_NOT_FOUND", "协作者不存在", status=404,
        )

    from apps.chat.conversation.services.session_share_resource_permission_service import (
        mark_resource_access_independently_granted,
    )

    mark_resource_access_independently_granted(
        resource_type="document",
        resource_id=str(doc.id),
        user_ids=[user_id],
        permission=permission,
    )

    if perm.permission == permission:
        # 沉默：不发通知
        return _serialize_collaborator(perm)

    old_permission = perm.permission
    with transaction.atomic(using=TABDOC_DB):
        perm.permission = permission
        perm.save(using=TABDOC_DB, update_fields=["permission", "updated_at"])
        metadata = _build_metadata(
            doc, "permission_changed", operator,
            permission_from=old_permission, permission_to=permission,
        )
        _schedule_notify(user_id, "permission_changed", metadata)
        # 降为 viewer：立刻把既有可写连接降为只读，避免仍写 Yjs
        if permission == "viewer" and old_permission != "viewer":
            _schedule_document_collab_revoke(doc.id, user_id, read_only=True)

    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_changed,
        )

        notify_cloud_resource_access_changed(
            resource_type="tabdoc",
            resource_id=str(doc.id),
            organization_id=str(doc.organization_id) if doc.organization_id else None,
            user_ids=[user_id],
            actor_user_id=str(operator.id) if operator else None,
            space_id=str(doc.space_id) if getattr(doc, "space_id", None) else None,
            db_alias=TABDOC_DB,
        )
    except Exception:
        logger.warning(
            "[ShareService] access_changed publish failed doc=%s user=%s",
            doc.id,
            user_id,
            exc_info=True,
        )

    return _serialize_collaborator(perm)


def remove_collaborator(
    document_id, user_id: str, operator, *, action: str = "removed",
) -> None:
    """移除协作者。action='auto_removed' 给 Wave 5 离队级联预留。"""
    user_id = str(user_id)
    if action not in ("removed", "auto_removed"):
        raise CollaboratorError(
            "INVALID_ACTION", f"action {action!r} 不合法", status=400,
        )

    doc = _get_document_for_management(document_id, operator)

    owner_id_str = _resolve_owner_id(doc)
    if owner_id_str and user_id == owner_id_str:
        raise CollaboratorError(
            "CANNOT_REMOVE_OWNER", "owner 不可移除", status=400,
        )

    perm = (
        DocumentPermission.objects.using(TABDOC_DB)
        .filter(document=doc, subject_type="user", subject_id=user_id, is_active=True)
        .first()
    )
    if perm is None:
        raise CollaboratorError(
            "COLLABORATOR_NOT_FOUND", "协作者不存在", status=404,
        )

    old_permission = perm.permission
    with transaction.atomic(using=TABDOC_DB):
        perm.is_active = False
        perm.save(using=TABDOC_DB, update_fields=["is_active", "updated_at"])
        metadata = _build_metadata(
            doc, action, operator,
            permission_from=old_permission, permission_to=None,
        )
        _schedule_notify(user_id, action, metadata)
        # 撤权后立刻踢 collab 连接，避免在线列表/Awareness 滞留
        _schedule_document_collab_revoke(doc.id, user_id, read_only=False)

    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_revoked,
        )

        notify_cloud_resource_access_revoked(
            resource_type="tabdoc",
            resource_id=str(doc.id),
            organization_id=str(doc.organization_id) if doc.organization_id else None,
            user_ids=[user_id],
            actor_user_id=str(operator.id) if operator else None,
            space_id=str(doc.space_id) if getattr(doc, "space_id", None) else None,
        )
    except Exception:
        logger.warning(
            "[ShareService]  access_revoked publish failed doc=%s user=%s",
            doc.id,
            user_id,
            exc_info=True,
        )


def _serialize_collaborator(perm: DocumentPermission) -> dict:
    """单条 CollaboratorOut 序列化（用于 update 返回）。"""
    User = get_user_model()
    user = User.objects.using("default").filter(id=perm.subject_id).first()
    base = _user_brief(user) if user else {
        "user_id": perm.subject_id,
        "nickname": "",
        "avatar": None,
        "email": "",
    }
    base["permission"] = _permission_for_collaborator_output(perm.permission)
    base["created_at"] = perm.created_at.isoformat() if perm.created_at else None
    return base


def _enrich_shared_by(items: list[dict]) -> None:
    """批量回填 shared_by 展示信息（资源所有者）到 items[i]['shared_by']。

    「分享给我」的位置列需显示「由 xxx 分享」，xxx 即资源 owner。
    一次 build_user_info_map 批量解析，避免 N+1，并复用全站统一的
    display_name + 头像解析逻辑。每条 item 需先带 owner_id（会被消费弹出）。
    """
    owner_ids: list[str] = []
    seen: set[str] = set()
    for data in items:
        oid = data.get("owner_id")
        if oid:
            oid = str(oid)
            if oid not in seen:
                seen.add(oid)
                owner_ids.append(oid)

    info_map: dict = {}
    if owner_ids:
        try:
            from apps.services.billing.services.member_usage_service import build_user_info_map
            info_map = build_user_info_map(owner_ids)
        except Exception as exc:
            logger.warning("[shared_with_me] build_user_info_map failed: %s", exc)
            info_map = {}

    for data in items:
        oid = data.pop("owner_id", None)
        info = info_map.get(str(oid)) if oid else None
        if oid and info:
            data["shared_by"] = {
                "id": str(oid),
                "display_name": info.get("display_name", ""),
                "avatar": info.get("avatar", ""),
            }
        else:
            data["shared_by"] = None


def list_documents_shared_with_me(viewer, *, organization_id: str | None = None) -> list[dict]:
    """列出「分享给我」的文档。

    Agent 私有化后，协作者无法看到他人的 bot Space，只能通过资源级
    DocumentPermission 访问被显式分享的文档。本函数即该独立访问通道的
    发现入口：返回当前用户具备有效 DocumentPermission（subject_type=user）
    但本人不是 owner 的活跃文档。

    返回的每条记录带 organization_id / document_id，足够前端按资源 id 独立打开，
    无需把文档所属的 bot Space 纳入用户的 Space 列表。
    """
    if not viewer or not getattr(viewer, "id", None):
        raise CollaboratorError("AUTH_REQUIRED", "需要登录", status=401)

    user_id = str(viewer.id)

    perms = (
        DocumentPermission.objects.using(TABDOC_DB)
        .filter(is_active=True, subject_type="user", subject_id=user_id)
        .select_related("document")
        .order_by("-document__updated_at")
    )

    items: list[dict] = []
    for perm in perms:
        doc = perm.document
        if doc is None:
            continue
        # 自己是 owner 的文档不属于「分享给我」
        if str(getattr(doc, "owner_id", "") or "") == user_id:
            continue
        # 仅活跃文档（排除归档/回收站）
        if getattr(doc, "status", "active") != "active":
            continue
        if getattr(doc, "trashed_at", None) is not None:
            continue
        if organization_id and str(doc.organization_id) != str(organization_id):
            continue
        items.append(
            {
                "resource_type": "doc",
                "document_id": str(doc.id),
                "title": doc.title or "",
                "icon": getattr(doc, "icon", "") or "",
                "organization_id": str(doc.organization_id),
                # org-only时 space_id 为 None，勿序列化成字符串 "None"
                "space_id": str(doc.space_id) if getattr(doc, "space_id", None) else "",
                "permission": _permission_for_collaborator_output(perm.permission),
                "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
                "owner_id": str(getattr(doc, "owner_id", "") or ""),
            }
        )

    _enrich_shared_by(items)
    from apps.tabtinspace.services.shared_resource_location import (
        enrich_shared_rows_with_locations,
    )

    enrich_shared_rows_with_locations(
        items,
        viewer=viewer,
        item_type="tabdoc",
        resource_id_key="document_id",
    )
    return items

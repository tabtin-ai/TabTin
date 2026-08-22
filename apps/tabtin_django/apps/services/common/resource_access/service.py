"""资源访问申请（viewer / editor）领域服务。

正典位置：``apps.services.common.resource_access``（非 IM 消息域）。
表模型仍在 ``apps.tabchat.models.ResourceAccessRequest``（ 建表）。

创建：
- IM 资源卡路径：校验来源会话成员；默认申请 viewer；当前已达请求级别则拒。
- 工具栏路径：无会话来源；仅允许已有 viewer 申请 editor。
- 权限不足页：无会话来源；仍在资源所属组织的成员可申请 viewer / editor。

批准：锁行、复核资源与 owner，复用 TabData/TabDoc ``invite_collaborators(..., req.role)``。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.tabchat.models import Conversation, ResourceAccessRequest
from apps.tabchat.utils import is_conversation_user_active

logger = logging.getLogger(__name__)

SUPPORTED_RESOURCE_TYPES = frozenset(
    {
        ResourceAccessRequest.ResourceType.TABLE,
        ResourceAccessRequest.ResourceType.DOCUMENT,
    }
)

SUPPORTED_ROLES = frozenset(
    {
        ResourceAccessRequest.Role.VIEWER,
        ResourceAccessRequest.Role.EDITOR,
    }
)

PERMISSION_DENIED_SOURCE = "permission_denied"

_ROLE_RANK = {
    ResourceAccessRequest.Role.VIEWER: 1,
    ResourceAccessRequest.Role.EDITOR: 2,
}


class ResourceAccessRequestError(Exception):
    """访问申请服务统一异常（API 层映射为 code/status）。"""

    def __init__(self, code: str, message: str = "", status: int = 400):
        self.code = code
        self.message = message or code
        self.status = status
        super().__init__(self.message)


def _parse_uuid(value: Any, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ResourceAccessRequestError(
            "INVALID_INPUT",
            f"{field} 不是合法 UUID",
            status=400,
        ) from exc


def _display_name(user) -> str:
    if not user:
        return "有人"
    return (
        getattr(user, "nickname", None)
        or getattr(user, "username", None)
        or str(getattr(user, "id", ""))[:8]
        or "有人"
    )


def _role_label(role: str) -> str:
    if role == ResourceAccessRequest.Role.EDITOR:
        return "编辑（editor）"
    return "查看（viewer）"


def _load_resource(resource_type: str, resource_id: uuid.UUID):
    """加载未进回收站的资源，返回 (resource, owner_id, title, organization_id)。"""
    if resource_type == ResourceAccessRequest.ResourceType.TABLE:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table

        table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=resource_id, trashed_at__isnull=True)
            .first()
        )
        if not table:
            raise ResourceAccessRequestError(
                "RESOURCE_NOT_FOUND",
                "表格不存在或已在回收站",
                status=404,
            )
        owner_id = str(getattr(table, "owner_id", "") or "")
        if not owner_id:
            raise ResourceAccessRequestError(
                "RESOURCE_OWNER_MISSING",
                "资源缺少 owner，无法申请访问",
                status=400,
            )
        return table, owner_id, (table.name or "未命名表格"), str(table.organization_id)

    if resource_type == ResourceAccessRequest.ResourceType.DOCUMENT:
        from apps.tabdoc.models import Document

        doc = Document.objects.filter(id=resource_id, trashed_at__isnull=True).first()
        if not doc:
            raise ResourceAccessRequestError(
                "RESOURCE_NOT_FOUND",
                "文档不存在或已在回收站",
                status=404,
            )
        owner_id = str(getattr(doc, "owner_id", "") or "")
        if not owner_id:
            raise ResourceAccessRequestError(
                "RESOURCE_OWNER_MISSING",
                "资源缺少 owner，无法申请访问",
                status=400,
            )
        return doc, owner_id, (doc.title or "未命名文档"), str(doc.organization_id)

    raise ResourceAccessRequestError(
        "INVALID_RESOURCE_TYPE",
        "仅支持 table / document 资源卡",
        status=400,
    )


def _user_has_role(resource_type: str, resource, user, role: str) -> bool:
    if resource_type == ResourceAccessRequest.ResourceType.TABLE:
        from apps.tabdata.services import TableService

        return bool(TableService(user=user).check_table_permission(str(resource.id), role))

    from apps.tabdoc.services.document_service import DocumentService

    return bool(
        DocumentService(user=user).check_document_permission(resource, required_role=role)
    )


def _grant_role(
    resource_type: str,
    resource_id: uuid.UUID,
    requester_id: str,
    owner_user,
    role: str,
) -> None:
    if resource_type == ResourceAccessRequest.ResourceType.TABLE:
        from apps.tabdata.services.share_service import CollaboratorError, invite_collaborators

        try:
            result = invite_collaborators(
                resource_id,
                [requester_id],
                role,
                owner_user,
            )
        except CollaboratorError as exc:
            raise ResourceAccessRequestError(
                getattr(exc, "code", "GRANT_FAILED"),
                getattr(exc, "message", str(exc)) or "授权失败",
                status=getattr(exc, "status", 400) or 400,
            ) from exc
        if any(
            item.get("reason") == "not_in_organization"
            for item in result.get("skipped", [])
        ):
            raise ResourceAccessRequestError(
                "NOT_ORGANIZATION_MEMBER",
                "申请人已不在资源所属组织，无法批准访问",
                status=403,
            )
        return

    from apps.tabdoc.services.share_service import CollaboratorError, invite_collaborators

    try:
        result = invite_collaborators(
            resource_id,
            [requester_id],
            role,
            owner_user,
        )
    except CollaboratorError as exc:
        raise ResourceAccessRequestError(
            getattr(exc, "code", "GRANT_FAILED"),
            getattr(exc, "message", str(exc)) or "授权失败",
            status=getattr(exc, "status", 400) or 400,
        ) from exc
    if any(
        item.get("reason") == "not_in_organization"
        for item in result.get("skipped", [])
    ):
        raise ResourceAccessRequestError(
            "NOT_ORGANIZATION_MEMBER",
            "申请人已不在资源所属组织，无法批准访问",
            status=403,
        )


def serialize_request(req: ResourceAccessRequest) -> dict[str, Any]:
    return {
        "id": str(req.id),
        "resource_type": req.resource_type,
        "resource_id": str(req.resource_id),
        "requester_id": req.requester_id,
        "owner_id": req.owner_id,
        "source_conversation_id": (
            str(req.source_conversation_id) if req.source_conversation_id else ""
        ),
        "source_message_id": req.source_message or 0,
        "source_message_ref": str(req.source_message_ref) if req.source_message_ref else None,
        "role": req.role,
        "status": req.status,
        "resolved_by": req.resolved_by or "",
        "resolved_at": req.resolved_at.isoformat() if req.resolved_at else None,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "updated_at": req.updated_at.isoformat() if req.updated_at else None,
    }


def _notify_owner(req: ResourceAccessRequest, *, resource_title: str, organization_id: str) -> None:
    from apps.services.notification.services.notification_service import NotificationService

    User = get_user_model()
    requester = User.objects.filter(id=req.requester_id).first()
    requester_name = _display_name(requester)
    role_label = _role_label(req.role)
    if req.role == ResourceAccessRequest.Role.EDITOR:
        title = f"{requester_name} 申请编辑资源"
    else:
        title = f"{requester_name} 申请查看资源"
    body = f"{requester_name} 申请{role_label}《{resource_title}》"
    # metadata 只承载导航信息；授权以 DB 请求行为权威，不信任客户端改 role。
    # role 仅用于确认弹窗展示文案，approve 仍读 DB。
    metadata = {
        "request_id": str(req.id),
        "requester_name": requester_name,
        "resource_title": resource_title,
        "resource_type": req.resource_type,
        "resource_id": str(req.resource_id),
        "source_conversation_id": (
            str(req.source_conversation_id) if req.source_conversation_id else ""
        ),
        "source_message_id": req.source_message or 0,
        "source_message_ref": str(req.source_message_ref) if req.source_message_ref else None,
        "role": req.role,
        "category": "resource_access",
        "behavior": "action_required",
    }
    try:
        NotificationService.notify(
            user_id=req.owner_id,
            type="resource_access_request",
            title=title,
            body=body,
            metadata=metadata,
            organization_id=organization_id or "",
        )
    except Exception:
        logger.exception(
            "Failed to notify owner for resource access request id=%s owner=%s",
            req.id,
            req.owner_id,
        )


def _resolve_owner_notification(req: ResourceAccessRequest) -> None:
    from apps.services.notification.services.notification_service import NotificationService

    try:
        NotificationService.resolve_resource_access_request_notification(
            user_id=req.owner_id,
            request_id=str(req.id),
            request_status=req.status,
        )
    except Exception:
        logger.exception(
            "Failed to resolve resource access notification id=%s owner=%s status=%s",
            req.id,
            req.owner_id,
            req.status,
        )


def _normalize_role(role: str | None) -> str:
    normalized = (role or ResourceAccessRequest.Role.VIEWER).strip()
    if normalized not in SUPPORTED_ROLES:
        raise ResourceAccessRequestError(
            "INVALID_ROLE",
            "仅支持申请 viewer / editor",
            status=400,
        )
    return normalized


class ResourceAccessRequestService:
    """创建 / 批准资源访问申请。"""

    @staticmethod
    def create_request(
        *,
        requester,
        resource_type: str,
        resource_id: str,
        role: str | None = None,
        authorization_header: str | None = None,
        source_conversation_id: str | None = None,
        source_message_id: int | None = None,
        source_message_ref: str | None = None,
        source_surface: str | None = None,
    ) -> dict[str, Any]:
        if not requester or not getattr(requester, "id", None):
            raise ResourceAccessRequestError("AUTH_REQUIRED", "需要登录", status=401)

        requester_id = str(requester.id)
        resource_type = (resource_type or "").strip()
        if resource_type not in SUPPORTED_RESOURCE_TYPES:
            raise ResourceAccessRequestError(
                "INVALID_RESOURCE_TYPE",
                "仅支持 table / document 资源卡",
                status=400,
            )

        requested_role = _normalize_role(role)
        resource_uuid = _parse_uuid(resource_id, "resource_id")
        normalized_source_surface = (source_surface or "").strip()
        if normalized_source_surface and normalized_source_surface != PERMISSION_DENIED_SOURCE:
            raise ResourceAccessRequestError(
                "INVALID_SOURCE_SURFACE",
                "不支持的访问申请来源",
                status=400,
            )
        is_permission_denied_request = normalized_source_surface == PERMISSION_DENIED_SOURCE

        conversation = None
        has_source_conversation = False
        message_id: int | None = None
        message_ref = None
        source_conversation_raw = (source_conversation_id or "").strip()
        if source_conversation_raw:
            has_source_conversation = True
            conversation_uuid = _parse_uuid(source_conversation_raw, "source_conversation_id")
            message_ref = (
                _parse_uuid(source_message_ref, "source_message_ref")
                if source_message_ref
                else None
            )
            if source_message_id is not None:
                try:
                    message_id = int(source_message_id)
                except (TypeError, ValueError) as exc:
                    raise ResourceAccessRequestError(
                        "INVALID_INPUT",
                        "source_message_id 非法",
                        status=400,
                    ) from exc
            if message_ref is None and message_id is None:
                raise ResourceAccessRequestError(
                    "INVALID_INPUT",
                    "source_message_id / source_message_ref 至少提供一个",
                    status=400,
                )

            conversation = Conversation.objects.filter(id=conversation_uuid).first()
            if not conversation:
                raise ResourceAccessRequestError(
                    "CONVERSATION_NOT_FOUND",
                    "会话不存在",
                    status=404,
                )
            if not is_conversation_user_active(str(conversation.id), requester_id):
                raise ResourceAccessRequestError(
                    "NOT_CONVERSATION_MEMBER",
                    "你不是该会话成员，无法申请访问",
                    status=403,
                )
        elif requested_role != ResourceAccessRequest.Role.EDITOR and not is_permission_denied_request:
            # 无 IM 来源时仅开放「已有查看 → 申请编辑」工具栏路径。
            raise ResourceAccessRequestError(
                "SOURCE_REQUIRED",
                "申请查看权限需要来源会话",
                status=400,
            )

        resource, owner_id, resource_title, organization_id = _load_resource(
            resource_type, resource_uuid
        )
        if owner_id == requester_id:
            raise ResourceAccessRequestError(
                "ALREADY_OWNER",
                "你已是资源所有者，无需申请",
                status=400,
            )

        if is_permission_denied_request:
            from apps.tabtinspace.models import OrganizationMember

            if not OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id=requester_id,
            ).exists():
                raise ResourceAccessRequestError(
                    "NOT_ORGANIZATION_MEMBER",
                    "你已不在资源所属组织，无法申请访问",
                    status=403,
                )

        if _user_has_role(resource_type, resource, requester, requested_role):
            raise ResourceAccessRequestError(
                "ALREADY_HAS_ACCESS",
                f"你已有该资源的{_role_label(requested_role)}权限",
                status=400,
            )

        # 工具栏申请 editor：必须已能打开资源（至少 viewer）。权限不足页已通过
        # 组织成员校验，可直接申请 viewer / editor。
        if not has_source_conversation and not is_permission_denied_request and not _user_has_role(
            resource_type, resource, requester, ResourceAccessRequest.Role.VIEWER
        ):
            raise ResourceAccessRequestError(
                "VIEWER_REQUIRED",
                "申请编辑权限前需要先拥有查看权限",
                status=403,
            )

        existing = (
            ResourceAccessRequest.objects.filter(
                resource_type=resource_type,
                resource_id=resource_uuid,
                requester_id=requester_id,
                status=ResourceAccessRequest.Status.PENDING,
            )
            .first()
        )
        if existing:
            existing_rank = _ROLE_RANK.get(existing.role, 0)
            requested_rank = _ROLE_RANK.get(requested_role, 0)
            if requested_rank <= existing_rank:
                return serialize_request(existing)

            existing.role = requested_role
            if has_source_conversation:
                existing.source_conversation = conversation
                existing.source_message = message_id
                existing.source_message_ref = message_ref
            existing.save(
                update_fields=[
                    "role",
                    "source_conversation",
                    "source_message",
                    "source_message_ref",
                    "updated_at",
                ]
            )
            _notify_owner(
                existing, resource_title=resource_title, organization_id=organization_id
            )
            return serialize_request(existing)

        try:
            with transaction.atomic():
                req = ResourceAccessRequest.objects.create(
                    resource_type=resource_type,
                    resource_id=resource_uuid,
                    requester_id=requester_id,
                    owner_id=owner_id,
                    source_conversation=conversation,
                    # 消息只有稳定引用、不对应本地行时，不用其 id 查询 Django Message。
                    # 稳定 message_ref 仅用于记录来源，不参与授权判定。
                    source_message=message_id,
                    source_message_ref=message_ref,
                    role=requested_role,
                    status=ResourceAccessRequest.Status.PENDING,
                )
        except IntegrityError:
            existing = (
                ResourceAccessRequest.objects.filter(
                    resource_type=resource_type,
                    resource_id=resource_uuid,
                    requester_id=requester_id,
                    status=ResourceAccessRequest.Status.PENDING,
                )
                .first()
            )
            if existing:
                return serialize_request(existing)
            raise

        _notify_owner(req, resource_title=resource_title, organization_id=organization_id)
        return serialize_request(req)

    @staticmethod
    def approve_request(*, actor, request_id: str) -> dict[str, Any]:
        if not actor or not getattr(actor, "id", None):
            raise ResourceAccessRequestError("AUTH_REQUIRED", "需要登录", status=401)

        actor_id = str(actor.id)
        request_uuid = _parse_uuid(request_id, "request_id")

        deferred_error: ResourceAccessRequestError | None = None

        with transaction.atomic():
            req = (
                ResourceAccessRequest.objects.select_for_update()
                .filter(id=request_uuid)
                .first()
            )
            if not req:
                raise ResourceAccessRequestError(
                    "REQUEST_NOT_FOUND",
                    "访问申请不存在",
                    status=404,
                )

            if req.status == ResourceAccessRequest.Status.APPROVED:
                transaction.on_commit(lambda: _resolve_owner_notification(req))
                return serialize_request(req)

            if req.status != ResourceAccessRequest.Status.PENDING:
                raise ResourceAccessRequestError(
                    "REQUEST_NOT_PENDING",
                    "该申请已不可批准",
                    status=400,
                )

            if req.owner_id != actor_id:
                raise ResourceAccessRequestError(
                    "NOT_RESOURCE_OWNER",
                    "仅资源所有者可批准访问申请",
                    status=403,
                )

            current_owner_id = ""
            current_organization_id = ""
            try:
                _resource, current_owner_id, _title, current_organization_id = _load_resource(
                    req.resource_type, req.resource_id
                )
            except ResourceAccessRequestError:
                deferred_error = ResourceAccessRequestError(
                    "RESOURCE_NOT_FOUND",
                    "资源已失效，申请已关闭",
                    status=404,
                )

            User = get_user_model()
            if deferred_error is None and not User.objects.filter(id=req.requester_id).exists():
                deferred_error = ResourceAccessRequestError(
                    "REQUESTER_NOT_FOUND",
                    "申请人不存在，申请已关闭",
                    status=404,
                )

            if deferred_error is None:
                from apps.tabtinspace.models import OrganizationMember

                if not OrganizationMember.objects.filter(
                    organization_id=current_organization_id,
                    user_id=req.requester_id,
                ).exists():
                    deferred_error = ResourceAccessRequestError(
                        "NOT_ORGANIZATION_MEMBER",
                        "申请人已不在资源所属组织，申请已关闭",
                        status=403,
                    )

            if deferred_error is not None:
                # 必须先落库再出 atomic；若在 atomic 内直接 raise 会回滚 superseded。
                req.status = ResourceAccessRequest.Status.SUPERSEDED
                req.resolved_by = actor_id
                req.resolved_at = timezone.now()
                req.save(
                    update_fields=["status", "resolved_by", "resolved_at", "updated_at"]
                )
                transaction.on_commit(lambda: _resolve_owner_notification(req))
            elif current_owner_id != actor_id:
                raise ResourceAccessRequestError(
                    "NOT_RESOURCE_OWNER",
                    "仅资源所有者可批准访问申请",
                    status=403,
                )
            else:
                # invite_collaborators 对已有同级权限幂等沉默；仍以本表标记 approved。
                try:
                    _grant_role(
                        req.resource_type,
                        req.resource_id,
                        req.requester_id,
                        actor,
                        req.role,
                    )
                except ResourceAccessRequestError as exc:
                    if exc.code != "NOT_ORGANIZATION_MEMBER":
                        raise
                    # 防住成员校验与实际授权之间的离队竞态；状态不能假成功。
                    deferred_error = exc

                if deferred_error is None:
                    req.status = ResourceAccessRequest.Status.APPROVED
                    req.resolved_by = actor_id
                    req.resolved_at = timezone.now()
                    req.save(
                        update_fields=["status", "resolved_by", "resolved_at", "updated_at"]
                    )
                    transaction.on_commit(lambda: _resolve_owner_notification(req))
                    return serialize_request(req)

                req.status = ResourceAccessRequest.Status.SUPERSEDED
                req.resolved_by = actor_id
                req.resolved_at = timezone.now()
                req.save(
                    update_fields=["status", "resolved_by", "resolved_at", "updated_at"]
                )
                transaction.on_commit(lambda: _resolve_owner_notification(req))

        if deferred_error is not None:
            raise deferred_error
        return serialize_request(req)

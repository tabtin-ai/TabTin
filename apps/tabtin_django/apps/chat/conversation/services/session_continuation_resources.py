from __future__ import annotations

from uuid import UUID

from .share_fork_turns import collect_share_resource_pointers

_VIEWER_ROLE = "viewer"
_SHARE_REQUIRED_ROLE = "admin"


def resource_snapshot(source, sender_user, recipient_user) -> tuple[list[dict], str]:
    from apps.services.oss.models import FileRecord
    from apps.tabdata.models import Table
    from apps.tabdoc.models import Document
    from apps.tabtinspace.services.cloud_resource_acl import (
        resolve_tabdata_role,
        resolve_tabdoc_role,
        resolve_tabfiles_role,
    )

    resolvers = {
        "tabdata": resolve_tabdata_role,
        "tabdoc": resolve_tabdoc_role,
        "tabfiles": resolve_tabfiles_role,
    }
    resources: list[dict] = []
    for kind, resource_id in collect_share_resource_pointers(source):
        resolver = resolvers.get(kind)
        if resolver is None or resolver(sender_user, resource_id) is None:
            continue
        if kind == "tabdata":
            label = Table.objects.filter(
                id=resource_id,
                organization_id=source.organization_id,
            ).values_list("name", flat=True).first()
        elif kind == "tabdoc":
            label = Document.objects.filter(
                id=resource_id,
                organization_id=source.organization_id,
            ).values_list("title", flat=True).first()
        else:
            label = FileRecord.objects.filter(
                id=resource_id,
                organization_id=source.organization_id,
            ).values_list(
                "file_name",
                flat=True,
            ).first()
        if not label:
            continue
        unavailable = resolver(recipient_user, resource_id) is None
        resources.append({
            "kind": kind,
            "id": str(resource_id),
            "label": str(label),
            "unavailable": unavailable,
            "reason": "需要原资源权限" if unavailable else "",
        })

    return resources, resource_status(resources)


def grant_continuation_resources(
    resources_json: list,
    *,
    sender_user,
    recipient_user,
) -> tuple[list[dict], str]:
    from apps.tabtinspace.services.cloud_resource_acl import (
        resolve_tabdata_role,
        resolve_tabdoc_role,
        resolve_tabfiles_role,
        role_at_least,
    )

    resolvers = {
        "tabdata": resolve_tabdata_role,
        "tabdoc": resolve_tabdoc_role,
        "tabfiles": resolve_tabfiles_role,
    }
    granters = {
        "tabdata": _grant_tabdata_viewer,
        "tabdoc": _grant_tabdoc_viewer,
        "tabfiles": _grant_tabfiles_viewer,
    }
    updated_resources: list[dict] = []
    for resource in resources_json:
        if not isinstance(resource, dict):
            continue
        next_resource = dict(resource)
        kind = str(resource.get("kind") or "")
        resource_id = str(resource.get("id") or "")
        if not kind or not resource_id:
            updated_resources.append(next_resource)
            continue
        resolver = resolvers.get(kind)
        granter = granters.get(kind)
        if (
            resolver is not None
            and granter is not None
            and role_at_least(resolver(sender_user, resource_id), _SHARE_REQUIRED_ROLE)
        ):
            granter(resource_id, sender_user, recipient_user)
        if resolver is not None and resolver(recipient_user, resource_id) is not None:
            next_resource["unavailable"] = False
            next_resource["reason"] = ""
        updated_resources.append(next_resource)

    return updated_resources, resource_status(updated_resources)


def resource_status(resources: list[dict]) -> str:
    if not resources:
        return "none"
    unavailable_count = sum(bool(resource.get("unavailable")) for resource in resources)
    if unavailable_count == 0:
        return "complete"
    if unavailable_count == len(resources):
        return "unavailable"
    return "partial"


def _grant_tabdata_viewer(resource_id: str, sender_user, recipient_user) -> None:
    from apps.tabdata.models import Table, TablePermission

    table = Table.objects.filter(id=resource_id).first()
    if table is None:
        return
    permission = TablePermission.objects.filter(
        table=table,
        subject_type="user",
        subject_id=str(recipient_user.id),
    ).first()
    if _active_permission_at_least(permission, _VIEWER_ROLE):
        return
    if permission is None:
        TablePermission.objects.create(
            table=table,
            subject_type="user",
            subject_id=str(recipient_user.id),
            permission=_VIEWER_ROLE,
            is_active=True,
            granted_by=str(sender_user.id),
        )
        return
    permission.permission = _VIEWER_ROLE
    permission.is_active = True
    permission.granted_by = str(sender_user.id)
    permission.save(update_fields=["permission", "is_active", "granted_by", "updated_at"])


def _grant_tabdoc_viewer(resource_id: str, sender_user, recipient_user) -> None:
    from apps.tabdoc.models import Document, DocumentPermission

    document = Document.objects.filter(id=resource_id).first()
    if document is None:
        return
    permission = DocumentPermission.objects.filter(
        document=document,
        subject_type="user",
        subject_id=str(recipient_user.id),
    ).first()
    if _active_permission_at_least(permission, _VIEWER_ROLE):
        return
    if permission is None:
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(recipient_user.id),
            permission=_VIEWER_ROLE,
            is_active=True,
            granted_by=str(sender_user.id),
            created_by=sender_user,
        )
        return
    permission.permission = _VIEWER_ROLE
    permission.is_active = True
    permission.granted_by = str(sender_user.id)
    permission.save(update_fields=["permission", "is_active", "granted_by", "updated_at"])


def _grant_tabfiles_viewer(resource_id: str, sender_user, recipient_user) -> None:
    from apps.tabtinspace.models import FilePermission
    from apps.tabtinspace.services.cloud_resource_acl import TABFILES_SHARED_PERMISSION

    try:
        file_uuid = UUID(str(resource_id))
    except (TypeError, ValueError):
        return
    permission = FilePermission.objects.filter(
        file_record_id=file_uuid,
        subject_type="user",
        subject_id=str(recipient_user.id),
    ).first()
    if _active_permission_at_least(permission, TABFILES_SHARED_PERMISSION):
        return
    if permission is None:
        FilePermission.objects.create(
            file_record_id=file_uuid,
            subject_type="user",
            subject_id=str(recipient_user.id),
            permission=TABFILES_SHARED_PERMISSION,
            is_active=True,
            granted_by=str(sender_user.id),
            created_by=sender_user,
        )
        return
    permission.permission = TABFILES_SHARED_PERMISSION
    permission.is_active = True
    permission.granted_by = str(sender_user.id)
    permission.created_by = sender_user
    permission.save(
        update_fields=[
            "permission",
            "is_active",
            "granted_by",
            "created_by",
            "updated_at",
        ],
    )


def _active_permission_at_least(permission, required: str) -> bool:
    if permission is None or not getattr(permission, "is_active", False):
        return False
    from apps.tabtinspace.services.cloud_resource_acl import role_at_least

    return role_at_least(getattr(permission, "permission", None), required)

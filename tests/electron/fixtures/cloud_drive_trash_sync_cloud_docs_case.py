"""#7437 Electron E2E：云盘删除后源资源 + ContextItem 进回收站，云文档列表收敛。"""
from __future__ import annotations

import json
import os
from uuid import uuid4

from apps.tabdata.models import Table
from apps.tabdata.services.table_service import TableService
from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import (
    ContextItem,
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from tests.electron.fixtures.e2e_auth_common import (
    DEFAULT_E2E_PASSWORD,
    build_electron_auth_payload,
    ensure_e2e_invite_redemption,
    ensure_e2e_user,
)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def ensure_user(run_id: str):
    suffix = run_id[-12:].replace("-", "").replace("_", "").lower()
    return ensure_e2e_user(
        email=f"cloud-trash-sync-{suffix}@example.com",
        username=f"cloud_trash_sync_{suffix}",
        nickname="云盘删除收敛验收用户",
        password=DEFAULT_E2E_PASSWORD,
    )


def ensure_workspace(organization: Organization, user, run_id: str) -> tuple[Workspace, bool]:
    """#3266：Space 表已 DROP，E2E 宿主改用 Workspace + Device。"""
    marker = f"[{run_id}]"
    name = f"{marker} 云盘删除收敛 Workspace"
    existing = (
        Workspace.objects.filter(organization=organization, name=name)
        .order_by("-created_at")
        .first()
    )
    if existing is not None:
        SpaceMembership.objects.get_or_create(
            workspace=existing,
            user=user,
            defaults={"role": "owner", "is_active": True},
        )
        return existing, False

    suffix = uuid4().hex[:8]
    device = Device.objects.create(
        organization=organization,
        user=user,
        name=f"E2E Cloud Trash Device {suffix}",
        device_type="electron",
        role="control",
        fingerprint=f"cloud-trash-sync-{suffix}",
        status="online",
    )
    working_dir = f"/tmp/cloud-trash-sync-{suffix}"
    workspace = Workspace.objects.create(
        organization=organization,
        device=device,
        created_by=user,
        name=name,
        description="Run-scoped Workspace for cloud trash sync E2E.",
        working_dir=working_dir,
        normalized_working_dir=working_dir,
        working_dir_type="mixed",
    )
    SpaceMembership.objects.get_or_create(
        workspace=workspace,
        user=user,
        defaults={"role": "owner", "is_active": True},
    )
    return workspace, True


def ensure_context(run_id: str):
    marker = f"[{run_id}]"
    doc_title = f"{marker} 云盘删文档验收"
    table_name = f"{marker} 云盘删表格验收"
    user, user_created = ensure_user(run_id)
    invite_redeemed = ensure_e2e_invite_redemption(user)

    organization, organization_created = Organization.objects.get_or_create(
        name=f"{marker} 云盘删除收敛 Organization",
        defaults={
            "owner": user,
            "description": "Run-scoped Organization for cloud trash sync E2E.",
            "icon": "🗑️",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "cloud-drive.trash-sync-cloud-docs"},
        },
    )
    if organization.owner_id != user.id:
        organization.owner = user
        organization.save(update_fields=["owner", "updated_at"])
    OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": "owner"},
    )

    workspace, workspace_created = ensure_workspace(organization, user, run_id)

    document = (
        Document.objects.filter(
            organization_id=organization.id,
            owner_id=user.id,
            title=doc_title,
        )
        .order_by("-created_at")
        .first()
    )
    if document is None:
        document = DocumentService(user=user).create_document(
            organization_id=str(organization.id),
            space_id=str(workspace.id),
            parent_id=None,
            collection_id=None,
            title=doc_title,
            initial_content_pm_json={},
            initial_content_markdown=f"# {doc_title}\n\n用于验证云盘删除后云文档列表收敛。",
            initial_content_plaintext=f"{marker} trash sync doc",
        )
    elif document.trashed_at is not None:
        DocumentService(user=user).restore_document(document)
        document.refresh_from_db()

    table_service = TableService(user=user)
    table = (
        Table.objects.filter(
            organization_id=organization.id,
            name=table_name,
        )
        .order_by("-created_at")
        .first()
    )
    if table is None:
        table = table_service.create_table(
            organization_id=organization.id,
            name=table_name,
            use_default_fields=True,
        )
        if table is None:
            raise RuntimeError("Failed to create TabData table for E2E prepare")
    elif table.is_trashed:
        ok = table_service.restore_table_from_trash(table.id)
        if not ok:
            raise RuntimeError("Failed to restore trashed table before E2E prepare")
        table.refresh_from_db()

    doc_item = (
        ContextItem.objects.filter(
            organization_id=organization.id,
            item_type="tabdoc",
            resource_id=str(document.id),
        )
        .order_by("-created_at")
        .first()
    )
    table_item = (
        ContextItem.objects.filter(
            organization_id=organization.id,
            item_type="tabdata",
            resource_id=str(table.id),
        )
        .order_by("-created_at")
        .first()
    )
    if doc_item is None or table_item is None:
        raise RuntimeError(
            f"Missing ContextItem after create: doc={doc_item is not None} table={table_item is not None}"
        )

    return {
        "runId": run_id,
        "marker": marker,
        "user": user,
        "userCreated": user_created,
        "inviteRedeemed": invite_redeemed,
        "organization": organization,
        "organizationCreated": organization_created,
        "workspace": workspace,
        "workspaceCreated": workspace_created,
        "document": document,
        "table": table,
        "docItem": doc_item,
        "tableItem": table_item,
        "docTitle": doc_title,
        "tableName": table_name,
    }


def _auth_space_view(workspace: Workspace):
    """兼容 build_electron_auth_payload 仍按历史 Space 字段序列化宿主。"""
    return type(
        "AuthSpaceView",
        (),
        {
            "id": workspace.id,
            "organization_id": workspace.organization_id,
            "name": workspace.name,
            "description": workspace.description or "",
            "icon": "",
            "type": "workspace",
            "status": "active",
            "is_default": False,
            "created_at": workspace.created_at,
            "updated_at": workspace.updated_at,
        },
    )()


def prepare_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    workspace = context["workspace"]
    emit({
        "runId": context["runId"],
        "marker": context["marker"],
        "prepared": True,
        "authUser": {
            "userId": str(context["user"].id),
            "created": context["userCreated"],
            "inviteRedeemed": context["inviteRedeemed"],
        },
        "organization": {
            "id": str(context["organization"].id),
            "name": context["organization"].name,
        },
        "space": {
            "id": str(workspace.id),
            "name": workspace.name,
            "type": "workspace",
        },
        "document": {
            "id": str(context["document"].id),
            "title": context["docTitle"],
            "contextItemId": str(context["docItem"].id),
        },
        "table": {
            "id": str(context["table"].id),
            "name": context["tableName"],
            "contextItemId": str(context["tableItem"].id),
        },
    })


def auth_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    emit(build_electron_auth_payload(
        user=context["user"],
        organization=context["organization"],
        space=_auth_space_view(context["workspace"]),
        created_user=False,
        space_created=False,
        invite_redeemed=ensure_e2e_invite_redemption(context["user"]),
    ))


def verify_case() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    document_id = require_env("TABTIN_E2E_DOCUMENT_ID")
    table_id = require_env("TABTIN_E2E_TABLE_ID")
    doc_item_id = require_env("TABTIN_E2E_DOC_CONTEXT_ITEM_ID")
    table_item_id = require_env("TABTIN_E2E_TABLE_CONTEXT_ITEM_ID")
    user_id = require_env("TABTIN_E2E_USER_ID")

    from django.contrib.auth import get_user_model

    User = get_user_model()
    user = User.objects.get(id=user_id)

    document = Document.objects.get(id=document_id)
    table = Table.objects.get(id=table_id)
    doc_item = ContextItem.objects.get(id=doc_item_id)
    table_item = ContextItem.objects.get(id=table_item_id)

    table_service = TableService(user=user)
    get_table_blocked = False
    get_table_error = ""
    try:
        table_service.get_table(table.id)
    except ValueError as exc:
        get_table_blocked = True
        get_table_error = str(exc)
    except Exception as exc:  # noqa: BLE001
        get_table_error = f"{type(exc).__name__}: {exc}"

    doc_service = DocumentService(user=user)
    get_doc_blocked = False
    get_doc_error = ""
    try:
        doc_service.get_document(str(document.id), required_role="viewer")
    except ValueError as exc:
        get_doc_blocked = True
        get_doc_error = str(exc)
    except Exception as exc:  # noqa: BLE001
        get_doc_error = f"{type(exc).__name__}: {exc}"

    emit({
        "runId": run_id,
        "documentTrashed": document.trashed_at is not None,
        "tableTrashed": table.is_trashed,
        "docContextTrashed": (
            doc_item.trashed_at is not None or doc_item.status == "trashed"
        ),
        "tableContextTrashed": (
            table_item.trashed_at is not None or table_item.status == "trashed"
        ),
        "getTableBlocked": get_table_blocked,
        "getTableError": get_table_error,
        "getDocumentBlocked": get_doc_blocked,
        "getDocumentError": get_doc_error,
        "ok": (
            document.trashed_at is not None
            and table.is_trashed
            and (doc_item.trashed_at is not None or doc_item.status == "trashed")
            and (table_item.trashed_at is not None or table_item.status == "trashed")
            and get_table_blocked
            and get_doc_blocked
        ),
    })


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
        return
    if mode == "auth":
        auth_case()
        return
    if mode == "verify":
        verify_case()
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()

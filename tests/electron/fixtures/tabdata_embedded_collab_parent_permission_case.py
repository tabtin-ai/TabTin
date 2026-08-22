import asyncio
import json
import os
from uuid import uuid4

from django.contrib.auth import get_user_model

from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.organization_context import OrganizationContext
from apps.tabdata.models import Table, TableField, TablePermission, TableRecord
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.table_service import TableService
from apps.tabdata.utils.record_data_access import read_data_fresh
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)

from tests.electron.fixtures.e2e_auth_common import (
    build_electron_auth_payload,
    ensure_e2e_user,
)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def ensure_org_member(organization, user, role: str) -> None:
    membership, _ = OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": role},
    )
    if membership.role != role:
        membership.role = role
        membership.save(update_fields=["role", "updated_at"])


def ensure_workspace_member(workspace, user, role: str) -> None:
    membership, _ = SpaceMembership.objects.get_or_create(
        workspace=workspace,
        user=user,
        defaults={"role": role, "is_active": True},
    )
    if membership.role != role or not membership.is_active:
        membership.role = role
        membership.is_active = True
        membership.save(update_fields=["role", "is_active", "updated_at"])


def create_workspace(organization, user, name: str) -> Workspace:
    suffix = uuid4().hex[:12]
    device = Device.objects.create(
        organization=organization,
        user=user,
        name=f"{name} Electron",
        device_type="electron",
        role="control",
        fingerprint=f"embedded-parent-permission-{suffix}",
        status="online",
    )
    working_dir = f"/tmp/embedded-parent-permission-{suffix}"
    return Workspace.objects.create(
        organization=organization,
        device=device,
        created_by=user,
        name=name,
        description="Run-scoped Workspace for embedded table permission acceptance.",
        working_dir=working_dir,
        normalized_working_dir=working_dir,
        working_dir_type="mixed",
    )


def auth_space_view(workspace: Workspace):
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
    run_id = require_env("TABTIN_E2E_RUN_ID")
    suffix = run_id[-12:].replace("-", "").replace("_", "")
    marker = f"[{run_id}]"
    owner, _ = ensure_e2e_user(
        email=f"embedded-owner-{suffix}@example.com",
        username=f"embedded_owner_{suffix}",
        nickname="内嵌表格拥有者",
    )
    collaborator, _ = ensure_e2e_user(
        email=f"embedded-collaborator-{suffix}@example.com",
        username=f"embedded_collaborator_{suffix}",
        nickname="父文档协作者",
    )
    organization = Organization.objects.create(
        name=f"{marker} 内嵌表格权限验收组织",
        owner=owner,
        type=Organization.OrganizationType.TEAM,
        is_default=False,
        settings={"e2e": True, "scenario": "tabdata.embedded-collab-parent-permission"},
    )
    ensure_org_member(organization, owner, "owner")
    ensure_org_member(organization, collaborator, "editor")

    owner_space = create_workspace(organization, owner, f"{marker} 拥有者私有工作区")
    ensure_workspace_member(owner_space, owner, "owner")
    navigation_space = create_workspace(organization, collaborator, f"{marker} 协作者导航空间")
    ensure_workspace_member(navigation_space, collaborator, "owner")

    table_title = f"{marker} 父文档内嵌协作表"
    table_service = TableService(user=owner)
    table = table_service.create_table(
        organization_id=organization.id,
        name=table_title,
        use_default_fields=False,
    )
    if table is None:
        raise RuntimeError("Failed to create acceptance table")
    fields, errors, _skipped = table_service.bulk_create_fields(
        table.id,
        [{"name": "验收内容", "field_type": "text", "is_primary": True}],
    )
    if errors or len(fields) != 1:
        raise RuntimeError(f"Failed to create acceptance field: {errors}")
    initial_value = f"{marker} 编辑前"
    record, error = RecordService(user=owner).create_record(
        table.id,
        {str(fields[0].id): initial_value},
    )
    if error:
        raise RuntimeError(error)
    # The acceptance target is a legacy/private-host table: without parent
    # context the collaborator must not inherit organization-wide access.
    Table.objects.filter(id=table.id).update(space_id=owner_space.id)
    table.refresh_from_db()

    document_title = f"{marker} 内嵌表格父文档"
    document = DocumentService(user=owner).create_document(
        organization_id=str(organization.id),
        space_id=str(owner_space.id),
        parent_id=None,
        collection_id=None,
        title=document_title,
        initial_content_pm_json={
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": marker}]},
                {
                    "type": "tabdataBlock",
                    "attrs": {"tableId": str(table.id), "title": table_title},
                },
            ],
        },
        initial_content_markdown=marker,
        initial_content_plaintext=marker,
    )
    if document is None:
        raise RuntimeError("Failed to create acceptance parent document")
    DocumentPermission.objects.create(
        document=document,
        subject_type="user",
        subject_id=str(collaborator.id),
        permission="editor",
        is_active=True,
        granted_by=str(owner.id),
        created_by=owner,
    )
    unrelated = Document.objects.create(
        organization_id=organization.id,
        space_id=owner_space.id,
        owner_id=owner.id,
        created_by=owner,
        updated_by=owner,
        title=f"{marker} 无关父文档",
        description_json={"type": "doc", "content": []},
    )
    DocumentPermission.objects.create(
        document=unrelated,
        subject_type="user",
        subject_id=str(collaborator.id),
        permission="editor",
        is_active=True,
        granted_by=str(owner.id),
        created_by=owner,
    )

    emit(
        {
            "runId": run_id,
            "marker": marker,
            "organizationId": str(organization.id),
            "ownerSpaceId": str(owner_space.id),
            "navigationSpaceId": str(navigation_space.id),
            "ownerUserId": str(owner.id),
            "collaboratorUserId": str(collaborator.id),
            "documentId": str(document.id),
            "documentTitle": document_title,
            "unrelatedDocumentId": str(unrelated.id),
            "tableId": str(table.id),
            "tableTitle": table_title,
            "fieldId": str(fields[0].id),
            "recordId": str(record.id),
            "initialValue": initial_value,
            "editedValue": f"{marker} 协作者真实 UI 已编辑",
            "prepared": True,
        }
    )


def auth_case() -> None:
    user = get_user_model().objects.get(id=require_env("TABTIN_E2E_AUTH_USER_ID"))
    organization = Organization.objects.get(id=require_env("TABTIN_E2E_ORGANIZATION_ID"))
    space = Workspace.objects.get(id=require_env("TABTIN_E2E_SPACE_ID"))
    emit(
        build_electron_auth_payload(
            user=user,
            organization=organization,
            space=auth_space_view(space),
            role=require_env("TABTIN_E2E_ROLE"),
        )
    )


def build_consumer(user, organization_id: str) -> GatewayConsumer:
    consumer = GatewayConsumer()
    consumer.user = user
    consumer.user_id = str(user.id)
    consumer.organization_ctx = OrganizationContext(organization_id, {organization_id})
    return consumer


def verify_case() -> None:
    collaborator = get_user_model().objects.get(id=require_env("TABTIN_E2E_COLLABORATOR_USER_ID"))
    organization_id = require_env("TABTIN_E2E_ORGANIZATION_ID")
    table_id = require_env("TABTIN_E2E_TABLE_ID")
    document_id = require_env("TABTIN_E2E_DOCUMENT_ID")
    unrelated_document_id = require_env("TABTIN_E2E_UNRELATED_DOCUMENT_ID")
    field_id = require_env("TABTIN_E2E_FIELD_ID")
    expected_value = require_env("TABTIN_E2E_EXPECTED_VALUE")
    records = list(TableRecord.objects.filter(table_id=table_id, is_deleted=False))
    matching_record = next(
        (
            record
            for record in records
            if read_data_fresh(record).get(field_id) == expected_value
        ),
        None,
    )
    consumer = build_consumer(collaborator, organization_id)
    direct_access = asyncio.run(consumer._check_table_access(table_id))
    inherited_access = asyncio.run(
        consumer._check_table_access(table_id, parent_document_id=document_id)
    )
    forged_access = asyncio.run(
        consumer._check_table_access(table_id, parent_document_id=unrelated_document_id)
    )
    emit(
        {
            "matchingRecordId": str(matching_record.id) if matching_record else None,
            "recordValueMatched": matching_record is not None,
            "activeRecordCount": len(records),
            "directAccess": direct_access,
            "inheritedAccess": inherited_access,
            "forgedAccess": forged_access,
            "explicitTablePermissionCount": TablePermission.objects.filter(
                table_id=table_id,
                subject_type="user",
                subject_id=str(collaborator.id),
                is_active=True,
            ).count(),
        }
    )


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
    elif mode == "auth":
        auth_case()
    elif mode == "verify":
        verify_case()
    else:
        raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()

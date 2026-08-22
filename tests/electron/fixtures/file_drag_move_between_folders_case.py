import json
import os

from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import Collection, ContextItem, Space, SpaceMembership, Organization, OrganizationMember
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
        email=f"file-drag-move-{suffix}@example.com",
        username=f"file_drag_move_{suffix}",
        nickname="文件拖拽移动验收用户",
        password=DEFAULT_E2E_PASSWORD,
    )


def ensure_context(run_id: str):
    marker = f"[{run_id}]"
    root_name = f"{marker} 文件拖拽移动验收"
    source_name = f"{marker} 源文件夹"
    target_name = f"{marker} 目标文件夹"
    file_name = f"{marker} 拖拽移动验收文档"
    user, user_created = ensure_user(run_id)
    invite_redeemed = ensure_e2e_invite_redemption(user)
    organization, organization_created = Organization.objects.get_or_create(
        name=f"{marker} 文件拖拽移动 Organization",
        defaults={
            "owner": user,
            "description": "Run-scoped Organization for Electron E2E file drag move.",
            "icon": "📁",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "file.drag-move-between-folders"},
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

    space, space_created = Space.objects.get_or_create(
        organization=organization,
        name=f"{marker} 文件拖拽移动 Space",
        defaults={
            "type": Space.SpaceType.WORKSPACE,
            "description": "Run-scoped Space for Electron E2E file drag move.",
            "status": "active",
            "is_default": False,
            "visibility": "private",
        },
    )
    if space.type != Space.SpaceType.WORKSPACE:
        space.type = Space.SpaceType.WORKSPACE
        space.save(update_fields=["type", "updated_at"])
    SpaceMembership.objects.get_or_create(
        space=space,
        user=user,
        defaults={"role": "owner", "is_active": True},
    )

    source_collection, _ = Collection.objects.get_or_create(
        space=space,
        parent=None,
        name=source_name,
        defaults={
            "icon": "📁",
            "order": 10,
            "created_by": user,
            "is_expanded": True,
        },
    )
    target_collection, _ = Collection.objects.get_or_create(
        space=space,
        parent=source_collection,
        name=target_name,
        defaults={
            "icon": "📁",
            "order": 20,
            "created_by": user,
            "is_expanded": True,
        },
    )

    document = (
        Document.objects
        .filter(
            organization_id=organization.id,
            space_id=space.id,
            owner_id=user.id,
            title=file_name,
            status="active",
            trashed_at__isnull=True,
        )
        .order_by("-created_at")
        .first()
    )
    if document is None:
        document = DocumentService(user=user).create_document(
            organization_id=str(organization.id),
            space_id=str(space.id),
            parent_id=None,
            collection_id=str(source_collection.id),
            title=file_name,
            initial_content_pm_json={},
            initial_content_markdown=f"# {file_name}\n\n用于验证云盘中通过拖拽移动文件位置。",
            initial_content_plaintext=f"{marker} 拖拽移动验收",
        )
    if document.status != "active":
        document.status = "active"
        document.save(update_fields=["status", "updated_at"])

    context_item = (
        ContextItem.objects
        .filter(space=space, item_type="tabdoc", resource_id=str(document.id), is_archived=False, trashed_at__isnull=True)
        .order_by("-created_at")
        .first()
    )
    if context_item is None:
        context_item = ContextItem.objects.create(
            space=space,
            item_type=document.get_context_type(),
            title=document.get_context_title(),
            preview=document.get_context_preview(),
            status=document.get_context_status(),
            resource_id=str(document.id),
            metadata=document.get_context_metadata(),
            order=0,
            is_archived=False,
            collection=source_collection,
            created_by=user,
            updated_by=user,
        )
    else:
        context_item.title = document.get_context_title()
        context_item.preview = document.get_context_preview()
        context_item.status = document.get_context_status()
        context_item.metadata = document.get_context_metadata()
        context_item.is_archived = False
        context_item.trashed_at = None
        context_item.trashed_by = None
        context_item.collection = source_collection
        context_item.updated_by = user
        context_item.save(update_fields=[
            "title",
            "preview",
            "status",
            "metadata",
            "is_archived",
            "trashed_at",
            "trashed_by",
            "collection",
            "updated_by",
            "updated_at",
        ])

    return {
        "runId": run_id,
        "marker": marker,
        "user": user,
        "userCreated": user_created,
        "inviteRedeemed": invite_redeemed,
        "organization": organization,
        "organizationCreated": organization_created,
        "space": space,
        "spaceCreated": space_created,
        "rootName": root_name,
        "sourceCollection": source_collection,
        "targetCollection": target_collection,
        "document": document,
        "contextItem": context_item,
    }


def prepare_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    source = context["sourceCollection"]
    target = context["targetCollection"]
    document = context["document"]
    item = context["contextItem"]
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
            "id": str(context["space"].id),
            "name": context["space"].name,
            "type": context["space"].type,
        },
        "rootFolder": {
            "name": context["rootName"],
            "path": context["rootName"],
        },
        "sourceFolder": {
            "id": str(source.id),
            "name": source.name,
            "path": source.name,
        },
        "targetFolder": {
            "id": str(target.id),
            "name": target.name,
            "path": f"{source.name}/{target.name}",
        },
        "file": {
            "name": document.title,
            "resourceId": str(document.id),
            "contextItemId": str(item.id),
            "initialCollectionId": str(source.id),
            "expectedCollectionIdAfterMove": str(target.id),
        },
        "source": "electron-e2e-file-drag-move",
    })


def auth_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    emit(build_electron_auth_payload(
        user=context["user"],
        organization=context["organization"],
        space=context["space"],
        created_user=False,
        space_created=False,
        invite_redeemed=ensure_e2e_invite_redemption(context["user"]),
    ))


def verify_case() -> None:
    context_item_id = require_env("TABTIN_E2E_CONTEXT_ITEM_ID")
    source_collection_id = require_env("TABTIN_E2E_SOURCE_COLLECTION_ID")
    target_collection_id = require_env("TABTIN_E2E_TARGET_COLLECTION_ID")
    item = ContextItem.objects.get(id=context_item_id)
    emit({
        "runId": require_env("TABTIN_E2E_RUN_ID"),
        "contextItemId": str(item.id),
        "resourceId": item.resource_id,
        "title": item.title,
        "sourceCollectionId": source_collection_id,
        "targetCollectionId": target_collection_id,
        "actualCollectionId": str(item.collection_id) if item.collection_id else None,
        "movedToTarget": str(item.collection_id) == target_collection_id,
        "stillInSource": str(item.collection_id) == source_collection_id,
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

import json
import os

from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import ContextItem, Space, SpaceMembership, Organization, OrganizationMember
from tests.electron.fixtures.e2e_auth_common import (
    DEFAULT_E2E_PASSWORD,
    build_electron_auth_payload,
    ensure_e2e_invite_redemption,
    ensure_e2e_user,
)


TITLE_REPEAT_SEGMENT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
EXPECTED_MIN_LINES = 2


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
        email=f"tabdoc-long-title-{suffix}@example.com",
        username=f"tabdoc_long_title_{suffix}",
        nickname="TabDoc 长标题验收用户",
        password=DEFAULT_E2E_PASSWORD,
    )


def ensure_context(run_id: str) -> dict:
    marker = f"[{run_id}]"
    user, user_created = ensure_user(run_id)
    invite_redeemed = ensure_e2e_invite_redemption(user)

    organization, organization_created = Organization.objects.get_or_create(
        name=f"{marker} TabDoc 长标题 Organization",
        defaults={
            "owner": user,
            "description": "Run-scoped Organization for TabDoc long-title wrapping E2E.",
            "icon": "📝",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "tabdoc.long-title-wrap"},
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
        name=f"{marker} TabDoc 长标题 Space",
        defaults={
            "type": Space.SpaceType.WORKSPACE,
            "description": "Run-scoped Space for TabDoc long-title wrapping E2E.",
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

    long_unbroken = TITLE_REPEAT_SEGMENT * 4
    title = f"{marker}-TabDocLongTitleWrap-{long_unbroken}-END"
    if len(title) > 255:
        raise RuntimeError(f"Prepared TabDoc title exceeds model max_length: {len(title)}")

    document = (
        Document.objects
        .filter(
            organization_id=organization.id,
            space_id=space.id,
            owner_id=user.id,
            title=title,
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
            collection_id=None,
            title=title,
            initial_content_pm_json={},
            initial_content_markdown=(
                "# TabDoc 长标题软换行验收\n\n"
                f"{marker} 这篇文档用于验证标题 textarea 不横向撑出页面容器。"
            ),
            initial_content_plaintext=f"{marker} TabDoc 长标题软换行验收",
        )
    if document.status != "active":
        document.status = "active"
        document.save(update_fields=["status", "updated_at"])

    context_item = (
        ContextItem.objects
        .filter(
            space=space,
            item_type="tabdoc",
            resource_id=str(document.id),
            is_archived=False,
            trashed_at__isnull=True,
        )
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
            collection=None,
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
        context_item.collection = None
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
        "document": document,
        "contextItem": context_item,
    }


def prepare_case() -> None:
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    document = context["document"]
    context_item = context["contextItem"]
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
        "document": {
            "id": str(document.id),
            "title": document.title,
            "titleLength": len(document.title),
            "expectedMinLines": EXPECTED_MIN_LINES,
        },
        "contextItem": {
            "id": str(context_item.id),
            "resourceId": context_item.resource_id,
            "title": context_item.title,
        },
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
    document_id = require_env("TABTIN_E2E_DOCUMENT_ID")
    expected_title = require_env("TABTIN_E2E_EXPECTED_TITLE")
    expected_space_id = require_env("TABTIN_E2E_SPACE_ID")
    expected_organization_id = require_env("TABTIN_E2E_ORGANIZATION_ID")
    document = Document.objects.get(id=document_id)
    context_item = (
        ContextItem.objects
        .filter(space_id=expected_space_id, item_type="tabdoc", resource_id=str(document.id))
        .order_by("-created_at")
        .first()
    )
    emit({
        "runId": require_env("TABTIN_E2E_RUN_ID"),
        "documentId": str(document.id),
        "title": document.title,
        "titleMatches": document.title == expected_title,
        "spaceId": str(document.space_id),
        "spaceMatches": str(document.space_id) == expected_space_id,
        "organizationId": str(document.organization_id),
        "organizationMatches": str(document.organization_id) == expected_organization_id,
        "status": document.status,
        "contextItem": None if context_item is None else {
            "id": str(context_item.id),
            "title": context_item.title,
            "resourceId": context_item.resource_id,
            "titleMatches": context_item.title == expected_title,
            "resourceMatches": context_item.resource_id == str(document.id),
        },
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

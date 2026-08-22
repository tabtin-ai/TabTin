import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model

from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import Space, SpaceMembership, Organization, OrganizationMember


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def optional_env(name: str, fallback: str) -> str:
    return os.environ.get(name, "").strip() or fallback


def main() -> None:
    run_id = require_env("TABTIN_E2E_RUN_ID")
    user_id = require_env("TABTIN_E2E_USER_ID")
    organization_id = require_env("TABTIN_E2E_ORGANIZATION_ID")
    space_id = require_env("TABTIN_E2E_SPACE_ID")
    organization_name = optional_env("TABTIN_E2E_ORGANIZATION_NAME", "[e2e] mirrored organization")
    space_name = optional_env("TABTIN_E2E_SPACE_NAME", "[e2e] mirrored Space")

    User = get_user_model()
    user = User.objects.get(id=UUID(user_id))

    organization, organization_created = Organization.objects.get_or_create(
        id=UUID(organization_id),
        defaults={
            "name": organization_name,
            "owner": user,
            # Mirror records use team to avoid colliding with the user's single
            # personal organization invariant when localStorage contains stale IDs.
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e_mirror": True, "source": "electron-e2e"},
        },
    )
    OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": "owner"},
    )

    space, space_created = Space.objects.get_or_create(
        id=UUID(space_id),
        defaults={
            "organization": organization,
            "name": space_name,
            "type": Space.SpaceType.WORKSPACE,
            "status": "active",
            "is_default": False,
            "visibility": "private",
        },
    )
    SpaceMembership.objects.get_or_create(
        space=space,
        user=user,
        defaults={"role": "owner"},
    )

    marker = f"tabtin-e2e-{run_id}"
    title = f"[{run_id}] TabDoc basic edit"
    markdown = f"# {marker}\n\nInitial content prepared by Electron E2E."
    document = DocumentService(user=user).create_document(
        organization_id=str(organization.id),
        space_id=str(space.id),
        parent_id=None,
        collection_id=None,
        title=title,
        initial_content_pm_json={},
        initial_content_markdown=markdown,
        initial_content_plaintext=marker,
    )

    print(
        "@@E2E@@"
        + json.dumps(
            {
                "runId": run_id,
                "docId": str(document.id),
                "spaceId": str(space.id),
                "organizationId": str(organization.id),
                "userId": str(user.id),
                "title": document.title,
                "marker": marker,
                "initialMarkdown": markdown,
                "organizationCreated": organization_created,
                "spaceCreated": space_created,
            },
            ensure_ascii=False,
        )
    )


main()

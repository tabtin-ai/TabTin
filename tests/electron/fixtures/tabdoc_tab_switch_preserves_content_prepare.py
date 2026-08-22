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

    organization, _organization_created = Organization.objects.get_or_create(
        id=UUID(organization_id),
        defaults={
            "name": organization_name,
            "owner": user,
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

    space, _space_created = Space.objects.get_or_create(
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

    lead_a = f"TT8021-LEAD-A-{run_id}"
    lead_b = f"TT8021-LEAD-B-{run_id}"
    title_a = f"[{run_id}] TabDoc switch A"
    title_b = f"[{run_id}] TabDoc switch B"
    service = DocumentService(user=user)

    doc_a = service.create_document(
        organization_id=str(organization.id),
        space_id=str(space.id),
        parent_id=None,
        collection_id=None,
        title=title_a,
        initial_content_pm_json={},
        initial_content_markdown=f"{lead_a}\n\nBody A prepared for switch regression.",
        initial_content_plaintext=lead_a,
    )
    doc_b = service.create_document(
        organization_id=str(organization.id),
        space_id=str(space.id),
        parent_id=None,
        collection_id=None,
        title=title_b,
        initial_content_pm_json={},
        initial_content_markdown=f"{lead_b}\n\nBody B prepared for switch regression.",
        initial_content_plaintext=lead_b,
    )

    print(
        "@@E2E@@"
        + json.dumps(
            {
                "runId": run_id,
                "spaceId": str(space.id),
                "organizationId": str(organization.id),
                "userId": str(user.id),
                "docAId": str(doc_a.id),
                "docBId": str(doc_b.id),
                "docATitle": doc_a.title,
                "docBTitle": doc_b.title,
                "leadMarkerA": lead_a,
                "leadMarkerB": lead_b,
            },
            ensure_ascii=False,
        )
    )


main()

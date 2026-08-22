import json
import os
from uuid import UUID

from django.contrib.auth import get_user_model

from apps.chat.conversation.models import ChatSession
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
    session_id = require_env("TABTIN_E2E_SESSION_ID")
    organization_name = optional_env("TABTIN_E2E_ORGANIZATION_NAME", "[e2e] mirrored organization")
    space_name = optional_env("TABTIN_E2E_SPACE_NAME", "[e2e] mirrored Space")

    User = get_user_model()
    user = User.objects.get(id=UUID(user_id))

    organization, organization_created = Organization.objects.get_or_create(
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

    session, session_created = ChatSession.objects.update_or_create(
        id=UUID(session_id),
        defaults={
            "user": user,
            "organization_id": organization_id,
            "space": space,
            "title": f"[{run_id}] E2E chat persistence",
            "title_generation_status": "done",
            "status": "active",
        },
    )

    marker = f"tabtin-{run_id}-chat"
    print(
        "@@E2E@@"
        + json.dumps(
            {
                "runId": run_id,
                "marker": marker,
                "messageText": f"{marker}\n\nE2E persistence check. No tools are required.",
                "userId": str(user.id),
                "organizationId": str(organization.id),
                "spaceId": str(space.id),
                "sessionId": str(session.id),
                "organizationCreated": organization_created,
                "spaceCreated": space_created,
                "sessionCreated": session_created,
                "source": "electron-selection-mirror",
            },
            ensure_ascii=False,
        )
    )


main()

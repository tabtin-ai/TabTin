import json
import os

from django.db import transaction
from django.db.models import Case, IntegerField, Q, Value, When

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.tabtinspace.models import OrganizationMember, Space, SpaceMembership
from tests.electron.fixtures.e2e_auth_common import (
    build_electron_auth_payload,
    ensure_e2e_invite_redemption,
)


ONLINE_DEVICE_STATUSES = ("online",)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def live_space_candidates():
    """Read-only queryset for existing, genuinely executable personal Spaces."""
    online_control_device = Q(
        control_device__status__in=ONLINE_DEVICE_STATUSES,
        control_device__control_status="active",
    )
    online_bound_device = Q(
        bound_device__status__in=ONLINE_DEVICE_STATUSES,
        bound_device__control_status="active",
    )
    return (
        Space.objects.select_related(
            "organization",
            "organization__owner",
            "agent",
            "bound_device",
            "control_device",
        )
        .filter(
            type=Space.SpaceType.WORKSPACE,
            status="active",
            is_archived=False,
            trashed_at__isnull=True,
            agent__isnull=False,
            agent__is_active=True,
        )
        .exclude(name__startswith="[")
        .exclude(agent__preferred_model_id="")
        .exclude(working_dir="")
        .filter(online_control_device | online_bound_device)
        .annotate(
            electron_runtime_priority=Case(
                When(agent__runtime_type="electron", then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            ),
        )
        .order_by(
            "electron_runtime_priority",
            "-is_default",
            "-last_activity_at",
            "created_at",
        )
    )


def select_active_user(space: Space):
    """Prefer active org owner; ensure its Space membership, else use active member."""
    owner = space.organization.owner
    if (
        owner
        and owner.is_active
        and OrganizationMember.objects.filter(
            organization=space.organization,
            user=owner,
        ).exists()
    ):
        membership, created = SpaceMembership.objects.get_or_create(
            space=space,
            user=owner,
            defaults={
                "role": "owner",
                "is_active": True,
                "status": SpaceMembership.Status.ACTIVE,
            },
        )
        changed = []
        if membership.role != "owner":
            membership.role = "owner"
            changed.append("role")
        if not membership.is_active:
            membership.is_active = True
            changed.append("is_active")
        if membership.status != SpaceMembership.Status.ACTIVE:
            membership.status = SpaceMembership.Status.ACTIVE
            changed.append("status")
        if changed:
            membership.save(update_fields=[*changed, "updated_at"])
        return owner, membership, bool(created or changed)

    active_memberships = (
        SpaceMembership.objects.select_related("user")
        .filter(
            space=space,
            user__isnull=False,
            user__is_active=True,
            is_active=True,
            status=SpaceMembership.Status.ACTIVE,
        )
        .order_by("joined_at")
    )
    for membership in active_memberships:
        if OrganizationMember.objects.filter(
            organization=space.organization,
            user=membership.user,
        ).exists():
            return membership.user, membership, False
    return None, None, False


def select_ready_device(space: Space):
    for device in (space.control_device, space.bound_device):
        if (
            device
            and device.status in ONLINE_DEVICE_STATUSES
            and device.control_status == "active"
        ):
            return device
    return None


def candidate_readiness(space: Space) -> dict:
    device = select_ready_device(space)
    return {
        "agentReady": bool(
            space.agent_id
            and space.agent.is_active
            and (space.agent.preferred_model_id or "").strip()
        ),
        "deviceReady": bool(
            device
        ),
        "workingDirReady": bool((space.working_dir or "").strip()),
        "preferredModelReady": bool(
            space.agent_id and (space.agent.preferred_model_id or "").strip()
        ),
    }


def select_execution_context():
    """Environment id is strict; otherwise query the best existing live Space."""
    requested_space_id = os.environ.get("TABTIN_E2E_LIVE_SPACE_ID", "").strip()
    if requested_space_id:
        try:
            space = live_space_candidates().filter(id=requested_space_id).first()
        except (TypeError, ValueError):
            space = None
        if space is None:
            return None, None, "env:invalid-or-not-ready", requested_space_id
        if not all(candidate_readiness(space).values()):
            return None, None, "env:invalid-or-not-ready", requested_space_id
        user, membership, membership_provisioned = select_active_user(space)
        if user is None:
            return None, None, "env:no-active-user-membership", requested_space_id
        return (
            space,
            (user, membership, membership_provisioned),
            "env:TABTIN_E2E_LIVE_SPACE_ID",
            requested_space_id,
        )

    for space in live_space_candidates():
        if not all(candidate_readiness(space).values()):
            continue
        user, membership, membership_provisioned = select_active_user(space)
        if user is not None:
            strategy = (
                "query:preferred-model+electron-runtime"
                if space.agent.runtime_type == "electron"
                else "query:preferred-model+online-device"
            )
            return space, (user, membership, membership_provisioned), strategy, None
    return None, None, "query:no-ready-existing-space", None


@transaction.atomic
def ensure_context(run_id: str, *, clear_session_messages: bool) -> dict:
    """Reuse an existing executable Space/user and create only a run-scoped session."""
    marker = f"tabtin-{run_id}-viewport-turn-end"
    space, selected_user, selection_strategy, requested_space_id = select_execution_context()
    if space is None or selected_user is None:
        return {
            "runId": run_id,
            "marker": marker,
            "selectionStrategy": selection_strategy,
            "requestedSpaceId": requested_space_id,
            "usesExistingExecutionSpace": False,
            "agentReady": False,
            "deviceReady": False,
            "workingDirReady": False,
            "preferredModelReady": False,
        }

    user, membership, membership_provisioned = selected_user
    organization = space.organization
    invite_redeemed = ensure_e2e_invite_redemption(user)
    readiness = candidate_readiness(space)

    session, session_created = ChatSession.objects.get_or_create(
        user=user,
        organization_id=str(organization.id),
        space=space,
        title=f"[{run_id}] viewport turn-end session",
        defaults={
            "title_generation_status": "done",
            "status": "active",
        },
    )
    if session.status != "active":
        session.status = "active"
        session.title_generation_status = "done"
        session.save(update_fields=["status", "title_generation_status", "updated_at"])

    # Prepare may be rerun: clear only this exact run-scoped session. Auth never
    # clears messages, so fetching credentials cannot destroy an in-flight turn.
    deleted = (
        ChatMessage.objects.filter(session=session).delete()[0]
        if clear_session_messages
        else 0
    )
    device = select_ready_device(space)
    if device is None:
        raise RuntimeError("Selected execution Space lost its online device during prepare")

    return {
        "runId": run_id,
        "marker": marker,
        "selectionStrategy": selection_strategy,
        "requestedSpaceId": requested_space_id,
        "usesExistingExecutionSpace": True,
        "user": user,
        "userCreated": False,
        "inviteRedeemed": invite_redeemed,
        "organization": organization,
        "organizationCreated": False,
        "space": space,
        "spaceCreated": False,
        "agentId": str(space.agent_id),
        "deviceId": str(device.id),
        "agentReady": readiness["agentReady"],
        "deviceReady": readiness["deviceReady"],
        "workingDirReady": readiness["workingDirReady"],
        "preferredModelReady": readiness["preferredModelReady"],
        "membershipReady": bool(
            membership.is_active and membership.status == SpaceMembership.Status.ACTIVE
        ),
        "membershipProvisioned": membership_provisioned,
        "organizationMemberReady": True,
        "session": session,
        "sessionCreated": session_created,
        "clearedMessageCount": deleted,
    }


def prepare_case() -> None:
    context = ensure_context(
        require_env("TABTIN_E2E_RUN_ID"),
        clear_session_messages=True,
    )
    if not context["usesExistingExecutionSpace"]:
        emit(
            {
                "runId": context["runId"],
                "marker": context["marker"],
                "organizationId": None,
                "userId": None,
                "spaceId": None,
                "sessionId": None,
                "agentId": None,
                "deviceId": None,
                "agentReady": False,
                "deviceReady": False,
                "workingDirReady": False,
                "preferredModelReady": False,
                "membershipReady": False,
                "membershipProvisioned": False,
                "organizationMemberReady": False,
                "usesExistingExecutionSpace": False,
                "selectionStrategy": context["selectionStrategy"],
                "requestedSpaceIdProvided": bool(context["requestedSpaceId"]),
                "messageCount": 0,
                "clearedMessageCount": 0,
                "organizationCreated": False,
                "spaceCreated": False,
                "sessionCreated": False,
                "userCreated": False,
                "source": "electron-e2e-chat-viewport-turn-end",
            }
        )
        return

    message_count = ChatMessage.objects.filter(session=context["session"]).count()
    space = context["space"]
    emit(
        {
            "runId": context["runId"],
            "marker": context["marker"],
            "organizationId": str(context["organization"].id),
            "userId": str(context["user"].id),
            "spaceId": str(space.id),
            "sessionId": str(context["session"].id),
            "agentId": context["agentId"],
            "deviceId": context["deviceId"],
            "agentReady": context["agentReady"],
            "deviceReady": context["deviceReady"],
            "workingDirReady": context["workingDirReady"],
            "preferredModelReady": context["preferredModelReady"],
            "membershipReady": context["membershipReady"],
            "membershipProvisioned": context["membershipProvisioned"],
            "organizationMemberReady": context["organizationMemberReady"],
            "usesExistingExecutionSpace": True,
            "selectionStrategy": context["selectionStrategy"],
            "requestedSpaceIdProvided": bool(context["requestedSpaceId"]),
            "messageCount": message_count,
            "clearedMessageCount": context["clearedMessageCount"],
            "organizationCreated": context["organizationCreated"],
            "spaceCreated": context["spaceCreated"],
            "sessionCreated": context["sessionCreated"],
            "userCreated": context["userCreated"],
            "inviteRedeemed": context["inviteRedeemed"],
            "source": "electron-e2e-chat-viewport-turn-end",
        }
    )


def auth_case() -> None:
    context = ensure_context(
        require_env("TABTIN_E2E_RUN_ID"),
        clear_session_messages=False,
    )
    if not context["usesExistingExecutionSpace"]:
        raise RuntimeError(
            "No existing executable Space available for chat viewport turn-end auth"
        )
    emit(
        build_electron_auth_payload(
            user=context["user"],
            organization=context["organization"],
            space=context["space"],
            created_user=False,
            space_created=False,
            invite_redeemed=ensure_e2e_invite_redemption(context["user"]),
        )
    )


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    if mode == "prepare":
        prepare_case()
        return
    if mode == "auth":
        auth_case()
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()

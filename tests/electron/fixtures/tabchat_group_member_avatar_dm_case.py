import json
import os

from django.db import transaction
from django.utils import timezone

from apps.tabtinspace.models import Device, Organization, OrganizationMember, SpaceMembership, Workspace
from tests.electron.fixtures.e2e_auth_common import (
    build_electron_auth_payload,
    ensure_e2e_invite_redemption,
    ensure_e2e_user,
)


OWNER = {"email": "zsctest9@tabtin.test", "username": "zsctest9", "nickname": "zsctest9"}
PEER = {"email": "zsctest10@tabtin.test", "username": "zsctest10", "nickname": "zsctest10"}


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def ensure_organization_member(organization, user, role: str) -> None:
    member, _ = OrganizationMember.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"role": role},
    )
    if member.role != role:
        member.role = role
        member.save(update_fields=["role"])


def ensure_workspace_member(workspace, user, role: str) -> None:
    member, _ = SpaceMembership.objects.get_or_create(
        workspace=workspace,
        user=user,
        defaults={"role": role, "is_active": True, "status": SpaceMembership.Status.ACTIVE},
    )
    changed = []
    if member.role != role:
        member.role = role
        changed.append("role")
    if not member.is_active:
        member.is_active = True
        changed.append("is_active")
    if member.status != SpaceMembership.Status.ACTIVE:
        member.status = SpaceMembership.Status.ACTIVE
        changed.append("status")
    if changed:
        member.save(update_fields=[*changed, "updated_at"])


def auth_space_view(workspace):
    return type("AuthSpaceView", (), {
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
    })()


@transaction.atomic
def ensure_context(run_id: str) -> dict:
    marker = f"[{run_id}]"
    fresh_suffix = "".join(char for char in run_id[-10:] if char.isalnum()).lower()
    fresh_account = {
        "email": f"dmfresh-{fresh_suffix}@tabtin.test",
        "username": f"dmfresh_{fresh_suffix}",
        "nickname": f"dmfresh_{fresh_suffix}",
    }
    owner, _ = ensure_e2e_user(**OWNER)
    peer, _ = ensure_e2e_user(**PEER)
    fresh_peer, _ = ensure_e2e_user(**fresh_account)
    ensure_e2e_invite_redemption(owner)
    ensure_e2e_invite_redemption(peer)
    ensure_e2e_invite_redemption(fresh_peer)
    organization, _ = Organization.objects.get_or_create(
        name=f"{marker} group-member-dm-e2e",
        owner=owner,
        defaults={
            "description": "Run-scoped group member DM Electron E2E.",
            "type": Organization.OrganizationType.TEAM,
            "is_default": False,
            "settings": {"e2e": True, "scenario": "tabchat.group-member-avatar-dm"},
        },
    )
    ensure_organization_member(organization, owner, "owner")
    ensure_organization_member(organization, peer, "editor")
    ensure_organization_member(organization, fresh_peer, "editor")
    device, _ = Device.objects.get_or_create(
        fingerprint=f"group-member-dm-e2e-{run_id}"[:255],
        defaults={
            "organization": organization,
            "user": owner,
            "name": f"{marker} e2e-device",
            "device_type": "electron",
            "role": "control",
            "status": "online",
            "control_status": "active",
            "os_info": {"os": "e2e", "arch": "arm64"},
            "capabilities": [],
        },
    )
    workspace, _ = Workspace.objects.get_or_create(
        organization=organization,
        device=device,
        normalized_working_dir=f"/tmp/tabtin-e2e/{run_id}",
        defaults={
            "name": f"{marker} test-workspace",
            "description": "Run-scoped group member DM workspace.",
            "working_dir": f"/tmp/tabtin-e2e/{run_id}",
            "working_dir_type": "mixed",
            "trust_status": Workspace.TrustStatus.TRUSTED,
            "trust_source": Workspace.TrustSource.SYSTEM_PROVISIONED,
            "trusted_at": timezone.now(),
            "created_by": owner,
        },
    )
    ensure_workspace_member(workspace, owner, "owner")
    ensure_workspace_member(workspace, peer, "editor")
    ensure_workspace_member(workspace, fresh_peer, "editor")
    return {
        "runId": run_id,
        "marker": marker,
        "groupName": f"{marker} 成员头像私聊回归群",
        "organization": organization,
        "workspace": workspace,
        "owner": owner,
        "peer": peer,
        "freshPeer": fresh_peer,
    }


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    context = ensure_context(require_env("TABTIN_E2E_RUN_ID"))
    if mode == "prepare":
        emit({
            "runId": context["runId"],
            "marker": context["marker"],
            "groupName": context["groupName"],
            "prepared": True,
            "organizationId": str(context["organization"].id),
            "workspaceId": str(context["workspace"].id),
            "owner": {"userId": str(context["owner"].id), "username": OWNER["username"]},
            "peer": {"userId": str(context["peer"].id), "username": PEER["username"]},
            "freshPeer": {
                "userId": str(context["freshPeer"].id),
                "username": context["freshPeer"].username,
            },
        })
        return
    if mode == "auth":
        emit(build_electron_auth_payload(
            user=context["owner"],
            organization=context["organization"],
            space=auth_space_view(context["workspace"]),
            role="owner",
            created_user=False,
            space_created=False,
            invite_redeemed=ensure_e2e_invite_redemption(context["owner"]),
        ))
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()

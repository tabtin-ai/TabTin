"""Format immutable Organization notification snapshots as canonical copy."""

from __future__ import annotations

from dataclasses import dataclass
import re
from uuid import UUID

from apps.tabtinspace.models import OrganizationMember


@dataclass(frozen=True, slots=True)
class OrganizationNotificationDisplay:
    title: str
    body: str


def _safe_name(value: object, fallback: str) -> str:
    text = str(value or "").strip()
    if not text or text.lower() in {"none", "null", "undefined"}:
        return fallback
    if re.fullmatch(r"(?:用户)?[0-9a-fA-F]{8}", text):
        return fallback
    try:
        UUID(text)
    except (ValueError, AttributeError):
        return text
    return fallback


def _role_label(value: object) -> str:
    choices = dict(OrganizationMember.ROLE_CHOICES)
    return choices.get(str(value or "").strip(), "成员")


def format_organization_notification(
    event_type: str,
    *,
    organization_name: object = None,
    inviter_name: object = None,
    invitee_name: object = None,
    member_name: object = None,
    actor_name: object = None,
    role: object = None,
    old_role: object = None,
    new_role: object = None,
    old_owner_name: object = None,
    new_owner_name: object = None,
) -> OrganizationNotificationDisplay:
    """Return canonical Title/Detail for one Organization event snapshot."""
    organization = _safe_name(organization_name, "该组织")

    if event_type == "invitation_received":
        inviter = _safe_name(inviter_name, "一位组织管理员")
        return OrganizationNotificationDisplay(
            title=f"你收到来自「{organization}」的邀请",
            body=f"{inviter}邀请你以“{_role_label(role)}”身份加入该组织。",
        )

    if event_type == "invitation_accepted":
        invitee = _safe_name(invitee_name, "一位成员")
        return OrganizationNotificationDisplay(
            title=f"{invitee}已接受组织邀请",
            body=f"对方已加入「{organization}」，角色为“{_role_label(role)}”。",
        )

    if event_type == "invitation_rejected":
        invitee = _safe_name(invitee_name, "一位成员")
        return OrganizationNotificationDisplay(
            title=f"{invitee}已拒绝组织邀请",
            body=f"对方没有加入「{organization}」。",
        )

    if event_type == "invitation_cancelled":
        actor = _safe_name(actor_name, "一位组织管理员")
        return OrganizationNotificationDisplay(
            title=f"加入「{organization}」的邀请已取消",
            body=f"该邀请已由{actor}取消，无需继续处理。",
        )

    if event_type == "invitation_sync":
        return OrganizationNotificationDisplay(
            title=f"加入「{organization}」的邀请已处理",
            body="该邀请已在其他入口完成处理，无需重复操作。",
        )

    if event_type == "member_joined_by_invitation":
        member = _safe_name(member_name, "一位成员")
        return OrganizationNotificationDisplay(
            title=f"{member}已加入「{organization}」",
            body=f"该成员通过邀请加入，角色为“{_role_label(role)}”。",
        )

    if event_type == "member_added":
        member = _safe_name(member_name, "一位成员")
        actor = _safe_name(actor_name, "一位组织管理员")
        return OrganizationNotificationDisplay(
            title=f"{member}已加入「{organization}」",
            body=f"{actor}已将该成员添加为“{_role_label(role)}”。",
        )

    if event_type == "member_removed":
        return OrganizationNotificationDisplay(
            title=f"你已被移出「{organization}」",
            body="你将无法继续访问该组织及其组织资源。",
        )

    if event_type == "role_changed":
        return OrganizationNotificationDisplay(
            title=f"你在「{organization}」的角色已变更",
            body=f"角色已由“{_role_label(old_role)}”调整为“{_role_label(new_role)}”。",
        )

    if event_type == "ownership_transferred":
        old_owner = _safe_name(old_owner_name, "原所有者")
        new_owner = _safe_name(new_owner_name, "新所有者")
        return OrganizationNotificationDisplay(
            title=f"「{organization}」的所有权已转移",
            body=f"组织所有者已由{old_owner}变更为{new_owner}。",
        )

    raise ValueError(f"unsupported organization notification event: {event_type}")

"""Organization mutation facts projected into canonical notifications."""

from __future__ import annotations

from dataclasses import dataclass
import logging

from apps.services.notification.services.notification_service import NotificationService
from apps.services.notification.services.organization_notification_formatter import (
    format_organization_notification,
)


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class OrganizationMemberAddedFact:
    organization_id: str
    organization_name: str
    actor_id: str
    actor_name: str
    affected_user_id: str
    affected_user_name: str
    role: str
    membership_id: str
    operation_id: str


@dataclass(frozen=True, slots=True)
class OrganizationMemberRemovedFact:
    organization_id: str
    organization_name: str
    actor_id: str
    actor_name: str
    affected_user_id: str
    affected_user_name: str
    membership_id: str
    operation_id: str


@dataclass(frozen=True, slots=True)
class OrganizationOwnershipTransferredFact:
    organization_id: str
    organization_name: str
    actor_id: str
    actor_name: str
    old_owner_id: str
    old_owner_name: str
    new_owner_id: str
    new_owner_name: str
    recipient_user_ids: tuple[str, ...]
    operation_id: str


@dataclass(frozen=True, slots=True)
class OrganizationRoleChangedFact:
    organization_id: str
    organization_name: str
    actor_id: str
    actor_name: str
    affected_user_id: str
    affected_user_name: str
    old_role: str
    new_role: str
    membership_id: str
    operation_id: str


OrganizationNotificationFact = (
    OrganizationMemberAddedFact
    | OrganizationMemberRemovedFact
    | OrganizationOwnershipTransferredFact
    | OrganizationRoleChangedFact
)


def project_organization_notification(fact: OrganizationNotificationFact) -> None:
    """Project one immutable Organization fact into NotificationService."""
    if isinstance(fact, OrganizationMemberAddedFact):
        event_key = f"organization:member:added:{fact.membership_id}"
        display = format_organization_notification(
            "member_added",
            organization_name=fact.organization_name,
            member_name=fact.affected_user_name,
            actor_name=fact.actor_name,
            role=fact.role,
        )
        NotificationService.notify(
            user_id=fact.affected_user_id,
            type="member_added",
            title=display.title,
            body=display.body,
            metadata={
                "canonical_display": True,
                "category": "organization",
                "behavior": "notification_only",
                "dedupe_key": event_key,
                "source_event_id": event_key,
                "channels": ["center"],
            },
            organization_id=fact.organization_id,
        )
        return

    if isinstance(fact, OrganizationMemberRemovedFact):
        event_key = f"organization:member:removed:{fact.membership_id}"
        display = format_organization_notification(
            "member_removed",
            organization_name=fact.organization_name,
        )
        NotificationService.notify(
            user_id=fact.affected_user_id,
            type="member_removed",
            title=display.title,
            body=display.body,
            metadata={
                "canonical_display": True,
                "category": "organization",
                "behavior": "notification_only",
                "desktop_delivery": "always",
                "dedupe_key": event_key,
                "source_event_id": event_key,
            },
            organization_id=fact.organization_id,
        )
        return

    if isinstance(fact, OrganizationOwnershipTransferredFact):
        source_event_id = f"organization:ownership:{fact.operation_id}"
        display = format_organization_notification(
            "ownership_transferred",
            organization_name=fact.organization_name,
            old_owner_name=fact.old_owner_name,
            new_owner_name=fact.new_owner_name,
        )
        NotificationService.notify(
            user_id=fact.new_owner_id,
            type="ownership_transfer",
            title=display.title,
            body=display.body,
            metadata={
                "canonical_display": True,
                "category": "organization",
                "behavior": "notification_only",
                "dedupe_key": f"{source_event_id}:owner",
                "source_event_id": source_event_id,
            },
            organization_id=fact.organization_id,
        )
        for user_id in fact.recipient_user_ids:
            if user_id == fact.new_owner_id:
                continue
            NotificationService.notify(
                user_id=user_id,
                type="ownership_transfer",
                title=display.title,
                body=display.body,
                metadata={
                    "canonical_display": True,
                    "category": "organization",
                    "behavior": "notification_only",
                    "dedupe_key": f"{source_event_id}:member",
                    "source_event_id": source_event_id,
                },
                organization_id=fact.organization_id,
            )
        return

    event_key = f"organization:member:role:{fact.operation_id}"
    display = format_organization_notification(
        "role_changed",
        organization_name=fact.organization_name,
        old_role=fact.old_role,
        new_role=fact.new_role,
    )
    NotificationService.notify(
        user_id=fact.affected_user_id,
        type="role_changed",
        title=display.title,
        body=display.body,
        metadata={
            "canonical_display": True,
            "category": "organization",
            "behavior": "notification_only",
            "dedupe_key": event_key,
            "source_event_id": event_key,
        },
        organization_id=fact.organization_id,
    )


def safe_project_organization_notification(fact: OrganizationNotificationFact) -> None:
    """Contain notification failures after the business transaction commits."""
    try:
        project_organization_notification(fact)
    except Exception:
        logger.warning(
            "Organization notification projection failed: fact=%s operation=%s",
            type(fact).__name__,
            fact.operation_id,
            exc_info=True,
        )

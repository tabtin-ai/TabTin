"""会话跨设备阅读水位与未读投影。"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import (
    ExecutionRun,
    SessionReadReceipt,
)
from apps.services.common.ws.bus import publish_to_user
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

READ_STATE_EVENT = "chat.session.read_state.updated"


def serialize_read_state(
    receipt: SessionReadReceipt | None,
    latest_completed_run: ExecutionRun | None,
) -> dict[str, Any]:
    return {
        "last_read_run_sequence": (
            receipt.last_read_run_sequence if receipt else 0
        ),
        "last_read_terminal_revision": (
            receipt.last_read_terminal_revision if receipt else 0
        ),
        "read_at": (
            receipt.read_at.isoformat()
            if receipt is not None and receipt.read_at
            else None
        ),
        "latest_completed_run_id": (
            str(latest_completed_run.run_id) if latest_completed_run else None
        ),
        "latest_completed_run_sequence": (
            latest_completed_run.sequence if latest_completed_run else None
        ),
        "latest_completed_terminal_revision": (
            latest_completed_run.terminal_projection_revision
            if latest_completed_run
            else None
        ),
    }


def has_unread_completed_run(
    latest_completed_run: ExecutionRun | None,
    receipt: SessionReadReceipt | None,
) -> bool:
    if (
        latest_completed_run is None
        or not latest_completed_run.unread_eligible
        or latest_completed_run.terminal_projection_revision is None
    ):
        return False
    terminal_cursor = (
        latest_completed_run.sequence,
        latest_completed_run.terminal_projection_revision,
    )
    read_cursor = (
        receipt.last_read_run_sequence if receipt else 0,
        receipt.last_read_terminal_revision if receipt else 0,
    )
    return terminal_cursor > read_cursor


class SessionReadStateService:
    @staticmethod
    def latest_completed_run(*, session_id) -> ExecutionRun | None:
        return (
            ExecutionRun.objects.filter(
                session_id=str(session_id),
                status=ExecutionRun.Status.COMPLETED,
                unread_eligible=True,
                terminal_projection_revision__isnull=False,
            )
            .order_by("-sequence")
            .first()
        )

    @staticmethod
    def snapshot(
        *,
        receipt: SessionReadReceipt | None,
        latest_completed_run: ExecutionRun | None,
    ) -> dict[str, Any]:
        return {
            "has_unread_reply": has_unread_completed_run(
                latest_completed_run,
                receipt,
            ),
            "read_state": serialize_read_state(
                receipt,
                latest_completed_run,
            ),
        }

    @classmethod
    def acknowledge(
        cls,
        *,
        session_id: str,
        user,
        through_run_id: str,
        through_revision: int,
    ) -> dict[str, Any]:
        try:
            normalized_session_id = uuid.UUID(str(session_id))
            normalized_run_id = uuid.UUID(str(through_run_id))
            normalized_revision = int(through_revision)
        except (TypeError, ValueError):
            return {"outcome": "invalid"}
        if normalized_revision < 1:
            return {"outcome": "invalid"}

        with transaction.atomic():
            session = (
                ChatSession.objects.select_for_update()
                .filter(pk=normalized_session_id)
                .only("id", "organization_id")
                .first()
            )
            if session is None:
                return {"outcome": "not_found"}
            run = (
                ExecutionRun.objects.select_for_update()
                .filter(
                    run_id=normalized_run_id,
                    session_id=str(normalized_session_id),
                )
                .first()
            )
            if (
                run is None
                or run.status != ExecutionRun.Status.COMPLETED
                or not run.unread_eligible
                or run.terminal_projection_revision != normalized_revision
            ):
                return {"outcome": "stale_or_non_terminal"}

            receipt, _ = SessionReadReceipt.objects.select_for_update().get_or_create(
                user=user,
                session=session,
            )
            current_cursor = (
                receipt.last_read_run_sequence,
                receipt.last_read_terminal_revision,
            )
            requested_cursor = (run.sequence, normalized_revision)
            advanced = requested_cursor > current_cursor
            if advanced:
                receipt.last_read_run_sequence = run.sequence
                receipt.last_read_terminal_revision = normalized_revision
                receipt.read_at = timezone.now()
                receipt.save(
                    update_fields=[
                        "last_read_run_sequence",
                        "last_read_terminal_revision",
                        "read_at",
                        "updated_at",
                    ]
                )

            latest_completed_run = cls.latest_completed_run(
                session_id=session.id,
            )
            snapshot = cls.snapshot(
                receipt=receipt,
                latest_completed_run=latest_completed_run,
            )
            cls._publish_on_commit(
                session=session,
                user_id=str(user.id),
                snapshot=snapshot,
            )
            return {
                "outcome": "advanced" if advanced else "noop",
                **snapshot,
            }

    @classmethod
    def publish_current_on_commit(
        cls,
        *,
        session: ChatSession,
    ) -> None:
        receipt = (
            SessionReadReceipt.objects.filter(
                user_id=session.user_id,
                session_id=session.id,
            )
            .first()
        )
        cls._publish_on_commit(
            session=session,
            user_id=str(session.user_id),
            snapshot=cls.snapshot(
                receipt=receipt,
                latest_completed_run=cls.latest_completed_run(
                    session_id=session.id,
                ),
            ),
        )

    @staticmethod
    def _publish_on_commit(
        *,
        session: ChatSession,
        user_id: str,
        snapshot: dict[str, Any],
    ) -> None:
        payload = {
            "session_id": str(session.id),
            "organization_id": str(session.organization_id),
            **snapshot,
        }

        def publish() -> None:
            try:
                publish_to_user(
                    user_id,
                    build_envelope(READ_STATE_EVENT, new_event_id(), payload),
                )
            except Exception:
                logger.warning(
                    "read-state publish failed session=%s",
                    session.id,
                    exc_info=True,
                )

        transaction.on_commit(publish)

__all__ = [
    "READ_STATE_EVENT",
    "SessionReadStateService",
    "has_unread_completed_run",
    "serialize_read_state",
]

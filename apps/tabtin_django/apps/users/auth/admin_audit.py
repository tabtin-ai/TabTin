"""AdminDash audit helpers."""

from __future__ import annotations

import json
from typing import Any

from django.db.models import Q, QuerySet, TextField
from django.db.models.functions import Cast

from .models import AdminSensitiveActionLog
from .utils import get_client_ip, get_user_agent


def _request_id(request) -> str:
    for key in ("HTTP_X_REQUEST_ID", "HTTP_X_TABTIN_REQUEST_ID"):
        value = request.META.get(key)
        if value:
            return str(value)
    return ""

def _jsonable(value: dict | None) -> dict:
    return json.loads(json.dumps(value or {}, default=str))


def filter_sensitive_actions_by_organization(
    qs: QuerySet[AdminSensitiveActionLog],
    organization_id: str,
) -> QuerySet[AdminSensitiveActionLog]:
    """Filter sensitive-action rows that belong to an organization.

    Matches:
    - ``target_id`` equal to the organization id (direct org targets)
    - organization id appearing in ``before_json`` / ``after_json`` text
      (nested snapshots such as trash context items)
    """
    org_id = (organization_id or "").strip()
    if not org_id:
        return qs
    return qs.annotate(
        _before_text=Cast("before_json", TextField()),
        _after_text=Cast("after_json", TextField()),
    ).filter(
        Q(target_id=org_id)
        | Q(_before_text__contains=org_id)
        | Q(_after_text__contains=org_id)
    )


def record_admin_sensitive_action(
    request,
    *,
    permission_code: str,
    action: str,
    target_type: str,
    target_id: str = "",
    reason: str,
    ticket_id: str = "",
    before_json: dict[str, Any] | None = None,
    after_json: dict[str, Any] | None = None,
    related_billing_event_id: str = "",
    related_wallet_transaction_id: str = "",
) -> AdminSensitiveActionLog:
    """Persist a high-risk AdminDash operation.

    Reason is intentionally required at the service boundary so handlers cannot
    accidentally record high-risk mutations without operator intent.
    """

    if not reason or not reason.strip():
        raise ValueError("敏感操作必须填写原因")

    actor_user = getattr(request, "auth", None)
    actor_admin_account = getattr(request, "admin_account", None)
    if actor_admin_account is None and actor_user is not None:
        from .models import AdminAccount

        actor_admin_account = AdminAccount.objects.filter(user=actor_user).first()

    return AdminSensitiveActionLog.objects.create(
        actor_user=actor_user if getattr(actor_user, "id", None) else None,
        actor_admin_account=actor_admin_account,
        permission_code=permission_code,
        action=action,
        target_type=target_type,
        target_id=str(target_id or ""),
        reason=reason.strip(),
        ticket_id=ticket_id.strip() if ticket_id else "",
        related_billing_event_id=str(related_billing_event_id or ""),
        related_wallet_transaction_id=str(related_wallet_transaction_id or ""),
        before_json=_jsonable(before_json),
        after_json=_jsonable(after_json),
        ip=get_client_ip(request),
        user_agent=get_user_agent(request),
        request_id=_request_id(request),
    )

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass

from apps.services.search.constants import SEARCH_BILLING_METER_KEY
from apps.services.search.services.types import (
    SearchRequest,
    SearchRequestFingerprint,
)

LOGICAL_INVOCATION_CONTRACT_VERSION = "search-invocation-v1"
REQUEST_FINGERPRINT_VERSION = "search-request-v1"

_LOGICAL_INVOCATION_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL,
    "tabtin://search/logical-invocation/v1",
)

logger = logging.getLogger(__name__)
_VERIFIED_INVOCATION_TOKEN = object()


@dataclass(frozen=True, slots=True, init=False)
class VerifiedSearchInvocationIdentity:
    """Identity value that can only be constructed after server-side verification."""

    logical_search_invocation_id: str
    agent_run_id: str

    def __init__(
        self,
        *,
        logical_search_invocation_id: str,
        agent_run_id: str,
        _verification_token: object,
    ) -> None:
        if _verification_token is not _VERIFIED_INVOCATION_TOKEN:
            raise TypeError("VerifiedSearchInvocationIdentity 只能由认证搜索边界创建")
        object.__setattr__(
            self,
            "logical_search_invocation_id",
            logical_search_invocation_id,
        )
        object.__setattr__(self, "agent_run_id", agent_run_id)


class SearchInvocationValidationError(Exception):
    def __init__(self, message: str, *, code: str, status_code: int):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _build_logical_search_invocation_id(
    *,
    organization_id: str,
    execution_run_id: str,
    client_tool_invocation_component: str,
) -> str:
    """Build a deterministic server namespace for one logical Agent search."""
    normalized_organization_id = str(uuid.UUID(str(organization_id)))
    normalized_run_id = str(uuid.UUID(str(execution_run_id)))
    component = str(client_tool_invocation_component or "").strip()
    if not component:
        raise ValueError("client_tool_invocation_component 不能为空")

    namespace_payload = _canonical_json(
        {
            "contract_version": LOGICAL_INVOCATION_CONTRACT_VERSION,
            "billing_subject": {
                "type": "organization",
                "id": normalized_organization_id,
            },
            "verified_execution_run_id": normalized_run_id,
            "client_tool_invocation_component": component,
        }
    )
    return str(uuid.uuid5(_LOGICAL_INVOCATION_NAMESPACE, namespace_payload))


def build_search_request_fingerprint(
    request: SearchRequest,
) -> SearchRequestFingerprint:
    """Fingerprint the provider-neutral effective request without retaining query text."""
    query_sha256 = hashlib.sha256(request.query.encode("utf-8")).hexdigest()
    payload = {
        "fingerprint_version": REQUEST_FINGERPRINT_VERSION,
        "meter_key": SEARCH_BILLING_METER_KEY,
        "query_sha256": query_sha256,
        "effective_count": request.count,
        "effective_summary": request.summary,
        "effective_freshness": request.freshness,
        "normalized_include_domains": _normalize_domains(request.include),
        "normalized_exclude_domains": _normalize_domains(request.exclude),
    }
    digest = hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()
    return SearchRequestFingerprint(
        fingerprint_version=REQUEST_FINGERPRINT_VERSION,
        meter_key=SEARCH_BILLING_METER_KEY,
        query_sha256=query_sha256,
        request_fingerprint=digest,
    )


def _verify_search_organization_access(*, user, organization_id: str) -> None:
    """Verify Search access with the canonical Organization viewer contract."""
    if not user or not organization_id:
        raise SearchInvocationValidationError(
            "无权使用该组织进行联网搜索",
            code="search_organization_forbidden",
            status_code=403,
        )
    try:
        from apps.tabtinspace.services.base import BaseService

        allowed = BaseService(user=user).check_organization_permission(
            str(organization_id),
            "viewer",
        )
    except Exception as exc:
        logger.warning(
            "[SearchInvocation] organization access validation failed: wt=%s err=%s",
            str(organization_id)[:8],
            exc,
        )
        allowed = False
    if not allowed:
        raise SearchInvocationValidationError(
            "无权使用该组织进行联网搜索",
            code="search_organization_forbidden",
            status_code=403,
        )


def resolve_verified_search_invocation(
    *,
    authenticated_user,
    organization_id: str | None,
    agent_run_id: str | None,
    client_tool_invocation_component: str | None,
) -> VerifiedSearchInvocationIdentity | None:
    """Derive an identity only after validating the authenticated HTTP actor."""
    normalized_run_input = str(agent_run_id or "").strip()
    component = str(client_tool_invocation_component or "").strip()
    normalized_organization_id = str(organization_id or "").strip()
    if normalized_organization_id:
        _verify_search_organization_access(
            user=authenticated_user,
            organization_id=normalized_organization_id,
        )
    if not normalized_run_input and not component:
        return None
    if not normalized_run_input or not component:
        raise SearchInvocationValidationError(
            "Agent 搜索必须同时提供 agent_run_id 和工具调用标识",
            code="search_invocation_context_incomplete",
            status_code=400,
        )
    if len(component) > 255:
        raise SearchInvocationValidationError(
            "工具调用标识过长",
            code="search_invocation_component_invalid",
            status_code=400,
        )
    try:
        normalized_run_id = str(uuid.UUID(normalized_run_input))
    except (TypeError, ValueError):
        raise SearchInvocationValidationError(
            "agent_run_id 格式无效",
            code="search_invocation_run_invalid",
            status_code=400,
        ) from None

    normalized_user_id = str(getattr(authenticated_user, "id", "") or "").strip()
    if not normalized_user_id or not normalized_organization_id:
        raise SearchInvocationValidationError(
            "无法验证 Agent 搜索的用户或组织上下文",
            code="search_invocation_run_forbidden",
            status_code=403,
        )

    from apps.services.agent_engine.models import ExecutionRun

    run = ExecutionRun.objects.filter(run_id=normalized_run_id).first()
    if (
        run is None
        or str(run.user_id or "") != normalized_user_id
        or str(run.organization_id or "") != normalized_organization_id
    ):
        raise SearchInvocationValidationError(
            "无权使用该 Agent Run 进行联网搜索",
            code="search_invocation_run_forbidden",
            status_code=403,
        )

    _validate_run_session_context(
        run=run,
        user_id=normalized_user_id,
        organization_id=normalized_organization_id,
    )
    logical_id = _build_logical_search_invocation_id(
        organization_id=normalized_organization_id,
        execution_run_id=normalized_run_id,
        client_tool_invocation_component=component,
    )
    return VerifiedSearchInvocationIdentity(
        logical_search_invocation_id=logical_id,
        agent_run_id=normalized_run_id,
        _verification_token=_VERIFIED_INVOCATION_TOKEN,
    )


def _validate_run_session_context(*, run, user_id: str, organization_id: str) -> None:
    from apps.chat.conversation.models import ChatSession

    session_id = _normalize_session_id(run.session_id) or _normalize_session_id(run.thread_id)
    if run.session_id and session_id is None:
        _raise_run_forbidden()
    if session_id is None:
        return

    session = (
        ChatSession.objects.select_related("workspace")
        .filter(id=session_id)
        .only(
            "id",
            "user_id",
            "organization_id",
            "thread_id",
            "project_id",
            "workspace_id",
            "workspace__organization_id",
        )
        .first()
    )
    if session is None:
        if run.session_id:
            _raise_run_forbidden()
        return

    run_thread_session_id = _normalize_session_id(run.thread_id)
    workspace_organization_id = (
        str(session.workspace.organization_id)
        if session.workspace_id and session.workspace is not None
        else ""
    )
    if (
        str(session.organization_id) != organization_id
        or (run_thread_session_id and run_thread_session_id != str(session.id))
        or (workspace_organization_id and workspace_organization_id != organization_id)
        or (session.project_id is None and str(session.user_id) != user_id)
    ):
        _raise_run_forbidden()


def _raise_run_forbidden() -> None:
    raise SearchInvocationValidationError(
        "Agent Run 的会话上下文不匹配",
        code="search_invocation_run_forbidden",
        status_code=403,
    )


def _normalize_session_id(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    if candidate.startswith("chat-session-"):
        candidate = candidate[len("chat-session-") :]
    try:
        return str(uuid.UUID(candidate))
    except (TypeError, ValueError):
        return None


def _normalize_domains(value: str) -> list[str]:
    return sorted(
        {
            domain.strip().lower()
            for domain in str(value or "").split(",")
            if domain.strip()
        }
    )


def _canonical_json(value: dict) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )

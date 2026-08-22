"""
Billing Gateway — 计费预检、配额、委托转发、BYOK 豁免。

从 ChatService 提取的 Stage B 计费网关层。
"""

from typing import Dict, Any, NamedTuple, Optional

import logging

from apps.i18n import get_text as _i18n
from apps.services.common.chat_stream_publisher import (
    ChatStreamPublisher as Publisher,
)

logger = logging.getLogger(__name__)


def _model_fields(model_instance) -> Dict[str, Optional[str]]:
    return {
        "model_id": str(model_instance.id) if model_instance else None,
        "model_name": model_instance.model_name if model_instance else None,
    }


class BillingPrecheckResult(NamedTuple):
    passed: bool
    result: Optional[Dict[str, Any]]
    ws_id: str
    uid: str


def run_billing_precheck(
    user, session, model_instance,
    effective_thread_id: str,
    app_context: Optional[Dict[str, Any]],
    client_type: Optional[str],
    execution_profile: Optional[str],
) -> BillingPrecheckResult:
    """配额检查 + 统一计费预检。

    BYOK 豁免自动检测（provider.scope in ('user', 'organization')）。
    Returns BillingPrecheckResult(passed, result_or_none, ws_id, uid)。
    """
    _byok_exempt = False
    if model_instance and getattr(model_instance, "provider", None):
        _provider_scope = getattr(model_instance.provider, "scope", "global")
        _byok_exempt = _provider_scope in ("user", "organization")

    final_model_id = str(model_instance.id) if model_instance else None

    _ws_id = str(session.organization_id or "")
    if _ws_id:
        try:
            from apps.tabtinspace.services.organization_control_guard import (
                OrganizationControlBlockedError,
                assert_organization_ai_allowed,
            )

            assert_organization_ai_allowed(_ws_id)
        except OrganizationControlBlockedError as exc:
            _error_category = "organization_control"
            error_reply = exc.message
            Publisher.publish_stream_done(
                effective_thread_id, error_reply,
                message_id=None,
                metadata={"error_category": _error_category, "error_code": exc.code},
            )
            return BillingPrecheckResult(False, {
                "message_id": None,
                "reply": error_reply,
                **_model_fields(model_instance),
                "trace_id": None,
                "error_category": _error_category,
                "error_code": exc.code,
            }, _ws_id, str(user.id))

        try:
            from apps.users.membership.services.quota_service import QuotaService
            from apps.users.membership.exceptions import QuotaExceededError
            from apps.services.llm.services.billed_call import build_conversation_quota_error

            QuotaService().check_quota(
                quota_type="max_conversations_per_day",
                increment=1,
                organization_id=_ws_id,
                actor=user,
            )
        except QuotaExceededError as qe:
            _error_category = "conversation_quota_exceeded"
            _quota_err = build_conversation_quota_error(
                current=qe.current or 0, limit=qe.limit or 0,
            )
            error_reply = _quota_err["error"]
            logger.info(
                "[billing_gateway] QTA-24 conversation quota exceeded: user=%s ws=%s current=%s limit=%s",
                str(user.id), _ws_id, qe.current, qe.limit,
            )

            Publisher.publish_stream_done(
                effective_thread_id, error_reply,
                message_id=None,
                metadata={"error_category": _error_category},
            )

            return BillingPrecheckResult(False, {
                "message_id": None,
                "reply": error_reply,
                **_model_fields(model_instance),
                "trace_id": None,
                "error_category": _error_category,
            }, _ws_id, str(user.id))
        except Exception as quota_exc:
            logger.warning("[billing_gateway] QTA-24 check exception, D1 pass-through: %s", quota_exc)

    _uid = str(user.id)
    _user_role = None
    _model_cost_tier = None
    try:
        from apps.services.billing.services.member_budget_service import MemberBudgetService

        if _ws_id:
            _user_role = MemberBudgetService.resolve_user_role(_ws_id, _uid)
        if model_instance:
            _model_cost_tier = MemberBudgetService.compute_model_cost_tier(model_instance)
    except Exception as _billing_resolve_exc:
        logger.warning(
            "[billing_gateway] Billing identity resolution failed "
            "(user_role/model_cost_tier will be None, precheck may use defaults): "
            "user=%s ws=%s error=%s",
            _uid, _ws_id, _billing_resolve_exc,
        )

    try:
        from apps.services.billing.services.billing_precheck import (
            LAYER_BALANCE,
            LAYER_BUDGET,
            billing_precheck,
            resolve_billing_precheck_source,
        )

        _precheck_source = resolve_billing_precheck_source(
            app_context=app_context,
            client_type=client_type,
            execution_profile=execution_profile,
        )
        _precheck_kwargs = dict(
            context="chat_send",
            user_role=_user_role,
            model_cost_tier=_model_cost_tier,
            model_instance=model_instance,
            source=_precheck_source,
        )
        if _byok_exempt:
            _precheck_result = billing_precheck(
                _ws_id,
                _uid,
                skip_layers=frozenset({LAYER_BUDGET, LAYER_BALANCE}),
                **_precheck_kwargs,
            )
        else:
            _precheck_result = billing_precheck(_ws_id, _uid, **_precheck_kwargs)

        if _precheck_result.blocked:
            from apps.services.llm.services.billed_call import (
                build_budget_error,
                build_member_budget_error,
                build_precheck_error,
            )
            if _precheck_result.layer == "budget":
                _precheck_err = build_budget_error()
            elif _precheck_result.layer == "member_budget":
                _detail = _precheck_result.get_raw_detail_dict()
                _detail["error_category"] = _precheck_result.error_category
                _detail["error_code"] = _precheck_result.error_code
                _precheck_err = build_member_budget_error(billing_result=_detail)
            else:
                _precheck_err = build_precheck_error(
                    billing_result=_precheck_result.get_raw_detail_dict(),
                )
            _error_category = _precheck_err["error_category"]
            error_reply = _precheck_err["error"]
            # quota_only 点券用尽：把自动补充失败原因塞进 error_extras，
            # 与 Proxy SSE / agent-runtime pickErrorExtras 同口径，供
            # BillingErrorCard 按「原因 × 角色」引导。
            _topup_reason = _precheck_err.get("topup_reason")
            if not _topup_reason:
                _nested = _precheck_err.get("billing_result")
                if isinstance(_nested, dict):
                    _topup_reason = _nested.get("topup_reason")
            _error_extras = (
                {"topup_reason": str(_topup_reason)}
                if _topup_reason
                else None
            )
            _done_metadata: Dict[str, Any] = {"error_category": _error_category}
            if _error_extras:
                _done_metadata["error_extras"] = _error_extras
            logger.info(
                "[billing_gateway] Pre-check blocked: user=%s ws=%s category=%s topup_reason=%s",
                _uid, _ws_id, _error_category, _topup_reason or "none",
            )

            Publisher.publish_stream_done(
                effective_thread_id, error_reply,
                message_id=None,
                metadata=_done_metadata,
            )

            _blocked_result: Dict[str, Any] = {
                "message_id": None,
                "reply": error_reply,
                **_model_fields(model_instance),
                "trace_id": None,
                "error_category": _error_category,
            }
            if _error_extras:
                _blocked_result["error_extras"] = _error_extras
            return BillingPrecheckResult(False, _blocked_result, _ws_id, _uid)
    except Exception as precheck_exc:
        logger.error("[billing_gateway] Pre-check exception (rejecting): %s", precheck_exc, exc_info=True)
        _error_category = "billing_error"
        error_reply = _i18n("agent.billing_precheck_internal_error")

        Publisher.publish_stream_done(
            effective_thread_id, error_reply,
            message_id=None,
            metadata={"error_category": _error_category},
        )

        return BillingPrecheckResult(False, {
            "message_id": None,
            "reply": error_reply,
            **_model_fields(model_instance),
            "trace_id": None,
            "error_category": _error_category,
        }, _ws_id, _uid)

    if _ws_id:
        try:
            from apps.users.membership.services.quota_service import increment_daily_conversation_count
            increment_daily_conversation_count(_ws_id)
        except Exception as incr_exc:
            logger.warning("[billing_gateway] QTA-24 counter increment failed (non-blocking): %s", incr_exc)

    logger.info(
        "[billing_gateway][AUDIT] Precheck passed (no fund lock): user=%s ws=%s model=%s thread=%s byok=%s",
        str(user.id), str(session.organization_id or ""),
        final_model_id, effective_thread_id, _byok_exempt,
    )

    return BillingPrecheckResult(True, None, _ws_id, _uid)


def resolve_billing_identity(
    input_state: Dict[str, Any],
    session,
    user,
) -> None:
    """SpaceShare billing inheritance was retired by SF-1."""
    return None

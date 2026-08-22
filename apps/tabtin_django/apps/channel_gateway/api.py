"""Channel Gateway 管理 API"""

from __future__ import annotations

import logging
import secrets
from typing import Optional
from uuid import UUID

from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, models
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.i18n import get_text
from apps.i18n.response import success_response, error_response_with_status
from apps.users.auth.permissions import JWTAuth
from apps.services.common.permissions import ensure_organization_permission_for_user
from apps.channel_gateway.auth import ChannelGatewayTokenAuth

logger = logging.getLogger(__name__)

from apps.channel_gateway.api_schemas import SENSITIVE_CONFIG_KEYS, is_masked_value
from apps.channel_gateway.api_schemas import (
    ChannelAllowlistCreateRequest,
    ChannelAllowlistSchema,
    ChannelPolicySchema,
    ChannelPolicyUpdateRequest,
    ChannelAccountCreateRequest,
    ChannelAccountSchema,
    ChannelAccountUpdateRequest,
    ChannelRuntimeStatusSchema,
    ChannelOutboundRecordSchema,
    ChannelOutboundRetryRequest,
    ChannelBindingCreateRequest,
    ChannelBindingSchema,
    ChannelBindingUpdateRequest,
    ChannelPairingSchema,
)
from apps.channel_gateway.models import (
    ChannelAllowlistEntry,
    ChannelBinding,
    ChannelPairingRequest,
    ChannelAccount,
    ChannelRuntimeStatus,
    ChannelOutboundMessageRecord,
)
from apps.channel_gateway.services.pairing_service import ChannelPairingService
from apps.channel_gateway.services.binding_service import ChannelBindingService
from apps.channel_gateway.services.identity_context import (
    normalize_channel_context_value,
    resolve_channel_identity_context,
)
from apps.channel_gateway.services.outbound_service import ChannelOutboundService
from apps.channel_gateway.services.policy_service import ChannelPolicyService

router = Router()
jwt_auth = JWTAuth()

_HTTP_CODE_MAP = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    409: "CONFLICT",
}


def _dump(schema_cls, obj):
    return schema_cls.model_validate(obj, from_attributes=True).model_dump(mode="json")


def _dump_list(schema_cls, objs):
    return [_dump(schema_cls, o) for o in objs]


def _merge_config_safe(original: dict, incoming: dict) -> dict:
    """合并 config 时保护敏感字段：若前端回传的值是脱敏结果，保留原始值。

    通过 is_masked_value 对比 incoming 值与 original 值的脱敏结果来判定，
    避免仅靠 '****' 子串匹配导致的误判。
    """
    merged = dict(original)
    for k, v in incoming.items():
        if (
            k in SENSITIVE_CONFIG_KEYS
            and isinstance(v, str)
            and k in original
            and is_masked_value(original[k], v)
        ):
            continue
        merged[k] = v
    return merged


def _ensure_organization_permission(user, organization_id: str, role: str) -> None:
    ensure_organization_permission_for_user(user, organization_id, role)


def _requested_handling_space_id(data) -> str:
    return normalize_channel_context_value(
        getattr(data, "handling_space_id", None) or getattr(data, "space_id", None)
    )


def _requested_execution_agent_id(data) -> str:
    return normalize_channel_context_value(
        getattr(data, "execution_agent_id", None)
    )


def _requested_execution_workspace_id(data) -> str:
    return normalize_channel_context_value(
        getattr(data, "execution_workspace_id", None)
    )


def _resolve_binding_identity_context(*, organization_id: str, request_user, data, binding=None):
    return resolve_channel_identity_context(
        organization_id=organization_id,
        user_id=str(getattr(request_user, "id", "") or ""),
        identity_user_id=(
            getattr(data, "identity_user_id", None)
            or getattr(binding, "identity_user_id", None)
            or ""
        ),
        execution_agent_id=(
            _requested_execution_agent_id(data)
            or getattr(binding, "execution_agent_id", None)
            or ""
        ),
        execution_workspace_id=(
            _requested_execution_workspace_id(data)
            or getattr(binding, "execution_workspace_id", None)
            or ""
        ),
        handling_space_id=(
            _requested_handling_space_id(data)
            or getattr(binding, "handling_space_id", None)
            or getattr(binding, "space_id", None)
            or ""
        ),
    )


def _serialize_policy(
    *,
    organization_id: str,
    channel: str,
    account_id: str,
    config: object,
    updated_at=None,
) -> dict:
    service = ChannelPolicyService()
    policy = service.extract_policy_config(config)
    return ChannelPolicySchema(
        organization_id=organization_id,
        channel=channel,
        account_id=account_id,
        dm_policy=policy["dm_policy"],
        group_policy=policy["group_policy"],
        require_mention=policy["require_mention"],
        group_require_mention=policy["group_require_mention"],
        command_gate_enabled=policy["command_gate_enabled"],
        command_prefixes=policy["command_prefixes"],
        updated_at=updated_at,
    ).model_dump(mode="json")


@router.get("/accounts", auth=jwt_auth, tags=["Channel Gateway"])
def list_accounts(
    request,
    organization_id: str,
    channel: Optional[str] = None,
    enabled: Optional[bool] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        qs = ChannelAccount.objects.filter(organization_id=organization_id)
        if channel:
            qs = qs.filter(channel=channel)
        if enabled is not None:
            qs = qs.filter(enabled=enabled)
        items = list(qs.order_by("channel", "account_id"))
        return success_response(data={"items": _dump_list(ChannelAccountSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_accounts failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/accounts", auth=jwt_auth, tags=["Channel Gateway"])
def create_account(request, data: ChannelAccountCreateRequest):
    try:
        _ensure_organization_permission(request.auth, data.organization_id, "editor")
        config = dict(data.config or {})
        _auto_setup_channel_config(data.channel, config)
        try:
            account = ChannelAccount.objects.create(
                channel=data.channel,
                account_id=(data.account_id or "default").strip() or "default",
                organization_id=data.organization_id,
                name=data.name,
                enabled=bool(data.enabled) if data.enabled is not None else True,
                config=config,
            )
            _post_create_channel_setup(account)
            return success_response(data=_dump(ChannelAccountSchema, account))
        except IntegrityError:
            return error_response_with_status("CONFLICT", message=get_text("channel.account_conflict", default="账号已存在"), status_code=409)
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] create_account failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.patch("/accounts/{account_id}", auth=jwt_auth, tags=["Channel Gateway"])
def update_account(request, account_id: str, data: ChannelAccountUpdateRequest):
    try:
        account = ChannelAccount.objects.filter(id=account_id).first()
        if not account:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.account_not_found", default="账号不存在"), status_code=404)
        _ensure_organization_permission(request.auth, account.organization_id, "editor")
        previous_mode = ((account.config or {}).get("mode") or "polling")
        if data.name is not None:
            account.name = data.name
        if data.enabled is not None:
            account.enabled = data.enabled
        if data.config is not None:
            account.config = _merge_config_safe(account.config or {}, data.config)
        account.save()
        current_mode = ((account.config or {}).get("mode") or "polling")
        if data.config is not None and current_mode != previous_mode:
            _post_create_channel_setup(account)
        return success_response(data=_dump(ChannelAccountSchema, account))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] update_account failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/policy", auth=jwt_auth, tags=["Channel Gateway"])
def get_policy(
    request,
    organization_id: str,
    channel: str,
    account_id: Optional[str] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        normalized_account_id = (account_id or "default").strip() or "default"
        account = ChannelAccount.objects.filter(
            organization_id=organization_id,
            channel=channel,
            account_id=normalized_account_id,
        ).first()
        if not account:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.account_not_found", default="账号不存在"), status_code=404)
        return success_response(data=_serialize_policy(
            organization_id=organization_id,
            channel=channel,
            account_id=normalized_account_id,
            config=account.config,
            updated_at=account.updated_at,
        ))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] get_policy failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.patch("/policy", auth=jwt_auth, tags=["Channel Gateway"])
def update_policy(request, data: ChannelPolicyUpdateRequest):
    try:
        _ensure_organization_permission(request.auth, data.organization_id, "editor")
        normalized_account_id = (data.account_id or "default").strip() or "default"
        account = ChannelAccount.objects.filter(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=normalized_account_id,
        ).first()
        if not account:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.account_not_found", default="账号不存在"), status_code=404)
        service = ChannelPolicyService()
        account.config = service.apply_policy_patch(
            account.config,
            dm_policy=data.dm_policy,
            group_policy=data.group_policy,
            require_mention=data.require_mention,
            group_require_mention=data.group_require_mention,
            command_gate_enabled=data.command_gate_enabled,
            command_prefixes=data.command_prefixes,
            clear_group_overrides=bool(data.clear_group_overrides),
        )
        account.save(update_fields=["config", "updated_at"])
        return success_response(data=_serialize_policy(
            organization_id=data.organization_id,
            channel=data.channel,
            account_id=normalized_account_id,
            config=account.config,
            updated_at=account.updated_at,
        ))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] update_policy failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.delete("/accounts/{account_id}", auth=jwt_auth, tags=["Channel Gateway"])
def delete_account(request, account_id: str):
    try:
        account = ChannelAccount.objects.filter(id=account_id).first()
        if not account:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.account_not_found", default="账号不存在"), status_code=404)
        _ensure_organization_permission(request.auth, account.organization_id, "editor")
        account.delete()
        return success_response(data={"deleted": True})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] delete_account failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/runtime/accounts", auth=ChannelGatewayTokenAuth(), tags=["Channel Gateway"])
def list_runtime_accounts(
    request,
    organization_id: str,
    channel: Optional[str] = None,
):
    try:
        if not request.auth:
            return error_response_with_status("UNAUTHORIZED", message=get_text("auth.invalid_token", default="无效认证"), status_code=401)
        qs = ChannelAccount.objects.filter(organization_id=organization_id, enabled=True)
        if channel:
            qs = qs.filter(channel=channel)
        items = list(qs.order_by("channel", "account_id"))
        return success_response(data={"items": _dump_list(ChannelAccountSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_runtime_accounts failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/runtime/status", auth=jwt_auth, tags=["Channel Gateway"])
def list_runtime_status(
    request,
    organization_id: str,
    channel: Optional[str] = None,
    account_id: Optional[str] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        qs = ChannelRuntimeStatus.objects.filter(organization_id=organization_id)
        if channel:
            qs = qs.filter(channel=channel)
        if account_id:
            qs = qs.filter(account_id=account_id)
        items = list(qs.order_by("channel", "account_id"))
        return success_response(data={"items": _dump_list(ChannelRuntimeStatusSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_runtime_status failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/outbox", auth=jwt_auth, tags=["Channel Gateway"])
def list_outbox(
    request,
    organization_id: str,
    status: Optional[str] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        qs = ChannelOutboundMessageRecord.objects.filter(organization_id=organization_id)
        if status:
            qs = qs.filter(status=status)
        items = list(qs.order_by("-updated_at"))
        return success_response(data={"items": _dump_list(ChannelOutboundRecordSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_outbox failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/outbox/retry", auth=jwt_auth, tags=["Channel Gateway"])
def retry_outbox(request, data: ChannelOutboundRetryRequest):
    try:
        _ensure_organization_permission(request.auth, data.organization_id, "editor")
        count = ChannelOutboundService().retry_pending(organization_id=data.organization_id, limit=data.limit or 50)
        return success_response(data={"retried": count})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] retry_outbox failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/bindings", auth=jwt_auth, tags=["Channel Gateway"])
def list_bindings(
    request,
    organization_id: str,
    channel: Optional[str] = None,
    peer_id: Optional[str] = None,
    handling_space_id: Optional[str] = None,
    identity_user_id: Optional[str] = None,
    execution_agent_id: Optional[str] = None,
    space_id: Optional[str] = None,
    session_id: Optional[str] = None,
    status: Optional[str] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        qs = ChannelBinding.objects.filter(organization_id=organization_id)
        if channel:
            qs = qs.filter(channel=channel)
        if peer_id:
            qs = qs.filter(peer_id=peer_id)
        requested_space_id = normalize_channel_context_value(handling_space_id or space_id)
        if requested_space_id:
            qs = qs.filter(
                models.Q(handling_space_id=requested_space_id)
                | (
                    (models.Q(handling_space_id__isnull=True) | models.Q(handling_space_id=""))
                    & models.Q(space_id=requested_space_id)
                )
            )
        if identity_user_id:
            qs = qs.filter(identity_user_id=identity_user_id)
        requested_execution_agent_id = normalize_channel_context_value(execution_agent_id)
        if requested_execution_agent_id:
            qs = qs.filter(execution_agent_id=requested_execution_agent_id)
        if session_id:
            try:
                session_uuid = UUID(session_id)
            except Exception:
                return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.session_not_found", default="无效的会话ID"), status_code=400)
            qs = qs.filter(session_id=session_uuid)
        if status:
            qs = qs.filter(status=status)
        items = list(qs.order_by("-updated_at"))
        return success_response(data={"items": _dump_list(ChannelBindingSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_bindings failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/bindings", auth=jwt_auth, tags=["Channel Gateway"])
def create_binding(request, data: ChannelBindingCreateRequest):
    try:
        _ensure_organization_permission(request.auth, data.organization_id, "editor")

        service = ChannelBindingService(organization_id=data.organization_id)
        try:
            organization = service.ensure_organization()
        except ValueError:
            return error_response_with_status("NOT_FOUND", message=get_text("organization.not_found", default="组织不存在"), status_code=404)

        identity_context = _resolve_binding_identity_context(
            organization_id=data.organization_id,
            request_user=request.auth,
            data=data,
        )

        space = None
        requested_handling_space_id = identity_context.handling_space_id
        if requested_handling_space_id:
            try:
                space = service.resolve_space(requested_handling_space_id)
            except ValueError:
                return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.organization_mismatch", default="Agent空间与组织不匹配"), status_code=400)

        session = None
        if data.session_id:
            try:
                session = service.ensure_session(UUID(data.session_id))
            except ValueError as exc:
                message = str(exc)
                if message == "session not found":
                    return error_response_with_status("NOT_FOUND", message=get_text("chat.session_not_found", default="会话不存在"), status_code=404)
                return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.organization_mismatch", default="会话与组织不匹配"), status_code=400)

            if space is None:
                space = _resolve_session_space(service, session)
            if (
                identity_context.identity_user_id
                and normalize_channel_context_value(getattr(session, "user_id", "")) != identity_context.identity_user_id
            ):
                return error_response_with_status(
                    "VALIDATION_ERROR",
                    message="session identity mismatch",
                    status_code=400,
                )
        else:
            try:
                identity_user = service.resolve_identity_user(identity_context.identity_user_id)
            except ValueError as exc:
                return error_response_with_status("VALIDATION_ERROR", message=str(exc), status_code=400)
            session = service.create_session(
                organization=organization,
                space=space,
                identity_user=identity_user,
                agent_id=identity_context.execution_agent_id,
                workspace_id=identity_context.execution_workspace_id,
            )

        if session is not None:
            service.sync_session_space(session, space)

        try:
            binding = ChannelBinding.objects.create(
                channel=data.channel,
                account_id=(data.account_id or "default").strip() or "default",
                peer_kind=data.peer_kind,
                peer_id=data.peer_id,
                organization_id=data.organization_id,
                identity_user_id=identity_context.identity_user_id or None,
                execution_agent_id=identity_context.execution_agent_id or None,
                execution_workspace_id=identity_context.execution_workspace_id or None,
                handling_space_id=str(space.id) if space else None,
                space_id=str(space.id) if space else None,
                session_id=session.id if session else None,
                thread_id=session.thread_id if session else None,
                status=data.status or "active",
            )
        except IntegrityError:
            return error_response_with_status("CONFLICT", message=get_text("channel.binding_conflict", default="绑定已存在"), status_code=409)
        return success_response(data=_dump(ChannelBindingSchema, binding))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] create_binding failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.patch("/bindings/{binding_id}", auth=jwt_auth, tags=["Channel Gateway"])
def update_binding(request, binding_id: str, data: ChannelBindingUpdateRequest):
    try:
        binding = ChannelBinding.objects.filter(id=binding_id).first()
        if not binding:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.binding_not_found", default="绑定不存在"), status_code=404)
        _ensure_organization_permission(request.auth, binding.organization_id, "editor")

        fields_set = data.model_fields_set
        service = ChannelBindingService(organization_id=binding.organization_id)
        identity_context = _resolve_binding_identity_context(
            organization_id=binding.organization_id,
            request_user=request.auth,
            data=data,
            binding=binding,
        )

        current_space = None
        current_handling_space_id = binding.handling_space_id or binding.space_id
        if current_handling_space_id:
            try:
                current_space = service.resolve_space(current_handling_space_id)
            except ValueError:
                current_space = None

        target_space = current_space
        if "space_id" in fields_set or "handling_space_id" in fields_set:
            try:
                target_space = service.resolve_space(identity_context.handling_space_id)
            except ValueError:
                return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.organization_mismatch", default="Agent空间与组织不匹配"), status_code=400)

        target_session = None
        if "session_id" in fields_set and data.session_id:
            try:
                target_session = service.ensure_session(UUID(data.session_id))
            except ValueError as exc:
                message = str(exc)
                if message == "session not found":
                    return error_response_with_status("NOT_FOUND", message=get_text("chat.session_not_found", default="会话不存在"), status_code=404)
                return error_response_with_status("VALIDATION_ERROR", message=get_text("chat.organization_mismatch", default="会话与组织不匹配"), status_code=400)

            if "space_id" not in fields_set and "handling_space_id" not in fields_set:
                target_space = _resolve_session_space(service, target_session)
            if (
                identity_context.identity_user_id
                and normalize_channel_context_value(getattr(target_session, "user_id", "")) != identity_context.identity_user_id
            ):
                return error_response_with_status(
                    "VALIDATION_ERROR",
                    message="session identity mismatch",
                    status_code=400,
                )

        identity_changed = (
            "identity_user_id" in fields_set
            and normalize_channel_context_value(binding.identity_user_id) != identity_context.identity_user_id
        )
        space_changed = (
            ("space_id" in fields_set or "handling_space_id" in fields_set)
            and normalize_channel_context_value(current_handling_space_id) != identity_context.handling_space_id
        )

        if (
            "space_id" in fields_set
            or "handling_space_id" in fields_set
            or ("session_id" in fields_set and data.session_id)
            or data.create_new_session
            or identity_changed
            or space_changed
        ):
            if target_session is None:
                try:
                    identity_user = service.resolve_identity_user(identity_context.identity_user_id)
                except ValueError as exc:
                    return error_response_with_status("VALIDATION_ERROR", message=str(exc), status_code=400)
                if data.create_new_session:
                    organization = service.ensure_organization()
                    target_session = service.create_session(organization=organization, space=target_space, identity_user=identity_user)
                elif binding.session_id:
                    try:
                        target_session = service.ensure_session(binding.session_id)
                        if identity_changed and normalize_channel_context_value(getattr(target_session, "user_id", "")) != identity_context.identity_user_id:
                            organization = service.ensure_organization()
                            target_session = service.create_session(organization=organization, space=target_space, identity_user=identity_user)
                    except ValueError:
                        organization = service.ensure_organization()
                        target_session = service.create_session(organization=organization, space=target_space, identity_user=identity_user)
                else:
                    organization = service.ensure_organization()
                    target_session = service.create_session(organization=organization, space=target_space, identity_user=identity_user)

            service.sync_session_space(target_session, target_space)
            binding.handling_space_id = str(target_space.id) if target_space else None
            binding.space_id = str(target_space.id) if target_space else None
            binding.session_id = target_session.id
            binding.thread_id = target_session.thread_id

        if "identity_user_id" in fields_set:
            binding.identity_user_id = identity_context.identity_user_id or None
            binding.execution_agent_id = identity_context.execution_agent_id or None
        if "handling_space_id" in fields_set:
            binding.handling_space_id = identity_context.handling_space_id or None
        if "execution_agent_id" in fields_set:
            binding.execution_agent_id = identity_context.execution_agent_id or None
        if "execution_workspace_id" in fields_set:
            binding.execution_workspace_id = identity_context.execution_workspace_id or None
        if "status" in fields_set and data.status is not None:
            binding.status = data.status
        try:
            binding.save()
        except IntegrityError:
            return error_response_with_status("CONFLICT", message=get_text("channel.binding_conflict", default="绑定已存在"), status_code=409)
        return success_response(data=_dump(ChannelBindingSchema, binding))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] update_binding failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.delete("/bindings/{binding_id}", auth=jwt_auth, tags=["Channel Gateway"])
def delete_binding(request, binding_id: str):
    try:
        binding = ChannelBinding.objects.filter(id=binding_id).first()
        if not binding:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.binding_not_found", default="绑定不存在"), status_code=404)
        _ensure_organization_permission(request.auth, binding.organization_id, "editor")
        binding.delete()
        return success_response(data={"deleted": True})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] delete_binding failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/allowlist", auth=jwt_auth, tags=["Channel Gateway"])
def list_allowlist(
    request,
    organization_id: str,
    channel: Optional[str] = None,
    peer_kind: Optional[str] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        qs = ChannelAllowlistEntry.objects.filter(organization_id=organization_id)
        if channel:
            qs = qs.filter(channel=channel)
        if peer_kind:
            qs = qs.filter(peer_kind=peer_kind)
        items = list(qs.order_by("-updated_at"))
        return success_response(data={"items": _dump_list(ChannelAllowlistSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_allowlist failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/allowlist", auth=jwt_auth, tags=["Channel Gateway"])
def create_allowlist(request, data: ChannelAllowlistCreateRequest):
    try:
        _ensure_organization_permission(request.auth, data.organization_id, "editor")
        entry = ChannelAllowlistEntry.objects.create(
            channel=data.channel,
            account_id=(data.account_id or "default").strip() or "default",
            peer_kind=data.peer_kind,
            peer_id=data.peer_id,
            organization_id=data.organization_id,
            allow=data.allow,
            note=data.note,
        )
        return success_response(data=_dump(ChannelAllowlistSchema, entry))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] create_allowlist failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.delete("/allowlist/{entry_id}", auth=jwt_auth, tags=["Channel Gateway"])
def delete_allowlist(request, entry_id: str):
    try:
        entry = ChannelAllowlistEntry.objects.filter(id=entry_id).first()
        if not entry:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.allowlist_not_found", default="记录不存在"), status_code=404)
        _ensure_organization_permission(request.auth, entry.organization_id, "editor")
        entry.delete()
        return success_response(data={"deleted": True})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] delete_allowlist failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.get("/pairings", auth=jwt_auth, tags=["Channel Gateway"])
def list_pairings(
    request,
    organization_id: str,
    status: Optional[str] = None,
):
    try:
        _ensure_organization_permission(request.auth, organization_id, "viewer")
        qs = ChannelPairingRequest.objects.filter(organization_id=organization_id)
        if status:
            qs = qs.filter(status=status)
        items = list(qs.order_by("-updated_at"))
        return success_response(data={"items": _dump_list(ChannelPairingSchema, items), "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_pairings failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/pairings/{pairing_id}/approve", auth=jwt_auth, tags=["Channel Gateway"])
def approve_pairing(request, pairing_id: str):
    try:
        pairing = ChannelPairingRequest.objects.filter(id=pairing_id).first()
        if not pairing:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.pairing_not_found", default="配对请求不存在"), status_code=404)
        _ensure_organization_permission(request.auth, pairing.organization_id, "editor")
        if pairing.status != "pending":
            return error_response_with_status("VALIDATION_ERROR", message=get_text("channel.pairing_invalid", default="配对请求状态不可处理"), status_code=400)
        if pairing.expires_at and pairing.expires_at < timezone.now():
            pairing.status = "expired"
            pairing.save(update_fields=["status", "updated_at"])
            return error_response_with_status("VALIDATION_ERROR", message=get_text("channel.pairing_expired", default="配对请求已过期"), status_code=400)
        service = ChannelPairingService()
        updated = service.approve(pairing, resolved_by=str(request.auth.id))
        return success_response(data=_dump(ChannelPairingSchema, updated))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] approve_pairing failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/pairings/{pairing_id}/reject", auth=jwt_auth, tags=["Channel Gateway"])
def reject_pairing(request, pairing_id: str):
    try:
        pairing = ChannelPairingRequest.objects.filter(id=pairing_id).first()
        if not pairing:
            return error_response_with_status("NOT_FOUND", message=get_text("channel.pairing_not_found", default="配对请求不存在"), status_code=404)
        _ensure_organization_permission(request.auth, pairing.organization_id, "editor")
        if pairing.status != "pending":
            return error_response_with_status("VALIDATION_ERROR", message=get_text("channel.pairing_invalid", default="配对请求状态不可处理"), status_code=400)
        if pairing.expires_at and pairing.expires_at < timezone.now():
            pairing.status = "expired"
            pairing.save(update_fields=["status", "updated_at"])
            return error_response_with_status("VALIDATION_ERROR", message=get_text("channel.pairing_expired", default="配对请求已过期"), status_code=400)
        service = ChannelPairingService()
        updated = service.reject(pairing, resolved_by=str(request.auth.id))
        return success_response(data=_dump(ChannelPairingSchema, updated))
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] reject_pairing failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


# ---------------------------------------------------------------------------
# Channel setup helpers
# ---------------------------------------------------------------------------


def _auto_setup_channel_config(channel: str, config: dict) -> None:
    """Ensure config has required defaults for the channel."""
    if not config.get("webhook_token"):
        config["webhook_token"] = secrets.token_urlsafe(32)
    if "mode" not in config:
        config["mode"] = "polling"
    if "policy" not in config:
        config["policy"] = {
            "dm_policy": "open",
            "group_policy": "open",
            "require_mention": True,
            "command_gate_enabled": False,
            "command_prefixes": ["/"],
        }


def _post_create_channel_setup(account: ChannelAccount) -> None:
    """Run adapter probe + webhook setup in background after account creation."""
    from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
    from apps.channel_gateway.services.runtime_status_service import ChannelRuntimeStatusService
    from apps.channel_gateway.schemas import ChannelStatusMessage

    adapter = ChannelAdapterRegistry.get(account.channel)
    if not adapter:
        return

    from apps.channel_gateway.compat import run_adapter_coro_required

    try:
        probe = run_adapter_coro_required(adapter.probe(account), timeout=20)
        if probe.ok:
            config = dict(account.config or {})
            if probe.bot_username:
                config["bot_username"] = probe.bot_username
            if probe.display_name:
                config["bot_name"] = probe.display_name
            if not account.name and probe.display_name:
                account.name = probe.display_name
            account.config = config
            account.save(update_fields=["name", "config", "updated_at"])

            mode = (config.get("mode") or "polling")
            initial_status = "running" if mode == "polling" else "stopped"

            if mode == "polling":
                try:
                    run_adapter_coro_required(adapter.remove_webhook(account), timeout=10)
                    logger.info(
                        "[channel_gateway] cleared webhook for polling account %s/%s",
                        account.channel,
                        account.account_id,
                    )
                except Exception:
                    pass

            status_msg = ChannelStatusMessage(
                schema_version=1,
                type="channel.status",
                channel=account.channel,
                account_id=account.account_id,
                organization_id=account.organization_id,
                status=initial_status,
                ts=int(timezone.now().timestamp()),
                details={
                    "probe": probe.raw or {},
                    "bot_username": probe.bot_username,
                    "mode": mode,
                },
            )
            ChannelRuntimeStatusService().upsert_from_status(status_msg)
        else:
            logger.warning(
                "[channel_gateway] probe failed for %s/%s: %s",
                account.channel,
                account.account_id,
                probe.error,
            )
            if account.channel == "weixin_personal":
                from apps.channel_gateway.models import ChannelRuntimeStatus
                ChannelRuntimeStatus.objects.update_or_create(
                    channel=account.channel,
                    account_id=account.account_id,
                    organization_id=account.organization_id,
                    defaults={
                        "status": "waiting_scan",
                        "last_error": None,
                        "qr": None,
                    },
                )
    except Exception as exc:
        logger.warning("[channel_gateway] post-create setup error: %s", exc)


def _resolve_session_space(service: ChannelBindingService, session):
    if session.project_id:
        try:
            return service.resolve_space(str(session.project_id))
        except ValueError:
            pass

    if session.workspace_id:
        try:
            return service.resolve_space(str(session.workspace_id))
        except ValueError:
            pass

    try:
        context = session.context
    except (AttributeError, ObjectDoesNotExist):
        context = None

    context_project_id = getattr(context, "current_project_id", "") or ""
    context_space_id = getattr(context, "current_space_id", "") or ""
    target_id = context_project_id or context_space_id
    if not target_id:
        return None

    try:
        return service.resolve_space(target_id)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# WeChat iLink QR Login
# ---------------------------------------------------------------------------


def _get_user_default_organization_id(user) -> str:
    """查询用户的默认组织 ID（is_default=True 且 owner 为当前用户）。

    Organization 在 PostgreSQL（由 DB Router 路由），调用方后续若写 default 库模型无跨库原子性。
    """
    from apps.tabtinspace.models import Organization
    wt = Organization.objects.filter(owner=user, is_default=True).values_list("id", flat=True).first()
    if not wt:
        raise HttpError(400, get_text("channel.no_default_organization", default="请传入 organization_id 或确保账户已初始化默认组织"))
    return str(wt)


@router.post("/weixin/qr-login/start", auth=jwt_auth, tags=["Channel Gateway"])
def weixin_qr_login_start(request, account_id: str = "default", organization_id: str = ""):
    """Start a WeChat QR code login flow for a weixin_personal account."""
    try:
        organization_id = organization_id or _get_user_default_organization_id(request.auth)
        ensure_organization_permission_for_user(request.auth, organization_id)

        account = ChannelAccount.objects.filter(
            channel="weixin_personal",
            account_id=account_id,
            organization_id=organization_id,
        ).first()
        if not account:
            account = ChannelAccount.objects.create(
                channel="weixin_personal",
                account_id=account_id,
                organization_id=organization_id,
                name="微信",
                config={"base_url": "https://ilinkai.weixin.qq.com"},
            )

        from apps.channel_gateway.services.weixin_auth_service import WeixinAuthService
        from apps.channel_gateway.compat import run_adapter_coro_required

        result = run_adapter_coro_required(WeixinAuthService.start_qr_login(account))
        return success_response(data=result)
    except HttpError as he:
        return error_response_with_status(
            _HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"),
            message=str(he), status_code=he.status_code,
        )
    except Exception as e:
        logger.error("[ChannelGateway] weixin_qr_login_start failed: %s", e, exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/weixin/qr-login/status", auth=jwt_auth, tags=["Channel Gateway"])
def weixin_qr_login_status(request, account_id: str = "default", organization_id: str = ""):
    """Poll WeChat QR scan status."""
    try:
        organization_id = organization_id or _get_user_default_organization_id(request.auth)
        ensure_organization_permission_for_user(request.auth, organization_id)

        account = ChannelAccount.objects.filter(
            channel="weixin_personal",
            account_id=account_id,
            organization_id=organization_id,
        ).first()
        if not account:
            return error_response_with_status("NOT_FOUND", message="Account not found", status_code=404)

        from apps.channel_gateway.services.weixin_auth_service import WeixinAuthService
        from apps.channel_gateway.compat import run_adapter_coro_required

        result = run_adapter_coro_required(WeixinAuthService.poll_qr_status(account))
        safe_result = {k: v for k, v in result.items() if k != "bot_token"}
        return success_response(data=safe_result)
    except HttpError as he:
        return error_response_with_status(
            _HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"),
            message=str(he), status_code=he.status_code,
        )
    except Exception as e:
        logger.error("[ChannelGateway] weixin_qr_login_status failed: %s", e, exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


@router.post("/weixin/qr-login/refresh", auth=jwt_auth, tags=["Channel Gateway"])
def weixin_qr_login_refresh(request, account_id: str = "default", organization_id: str = ""):
    """Refresh an expired QR code."""
    return weixin_qr_login_start(request, account_id=account_id, organization_id=organization_id)


@router.post("/{account_uuid}/relogin", auth=jwt_auth, tags=["Channel Gateway"])
def channel_relogin(request, account_uuid: UUID):
    """Trigger re-login for a channel account (e.g. WeChat QR re-scan)."""
    try:
        account = ChannelAccount.objects.get(id=account_uuid)
        ensure_organization_permission_for_user(request.auth, account.organization_id)

        if account.channel != "weixin_personal":
            return error_response_with_status(
                "VALIDATION_ERROR",
                message="Re-login is only supported for weixin_personal channel",
                status_code=400,
            )

        from apps.channel_gateway.services.weixin_auth_service import WeixinAuthService
        from apps.channel_gateway.compat import run_adapter_coro_required

        result = run_adapter_coro_required(WeixinAuthService.start_qr_login(account))
        return success_response(data=result)
    except ObjectDoesNotExist:
        return error_response_with_status("NOT_FOUND", message="Account not found", status_code=404)
    except HttpError as he:
        return error_response_with_status(
            _HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"),
            message=str(he), status_code=he.status_code,
        )
    except Exception as e:
        logger.error("[ChannelGateway] channel_relogin failed: %s", e, exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)


# ---------------------------------------------------------------------------
# Adapter metadata
# ---------------------------------------------------------------------------


@router.get("/adapters", auth=jwt_auth, tags=["Channel Gateway"])
def list_adapters(request):
    try:
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
        from dataclasses import asdict

        adapters = ChannelAdapterRegistry.list_all()
        items = []
        for a in adapters:
            cap = a.capabilities
            items.append({
                "id": a.id,
                "name": a.name,
                "capabilities": asdict(cap),
                "config_schema": a.get_config_schema(),
            })
        return success_response(data={"items": items, "total": len(items)})
    except HttpError as he:
        return error_response_with_status(_HTTP_CODE_MAP.get(he.status_code, "HTTP_ERROR"), message=str(he), status_code=he.status_code)
    except Exception as e:
        logger.error(f"[ChannelGateway] list_adapters failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)

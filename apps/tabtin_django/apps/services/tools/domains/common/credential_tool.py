"""
Agent 凭据查询工具

提供 credential_lookup 和 credential_retrieve 两个工具：
- credential_lookup: 按域名或 App 包名查询用户存储的凭据（仅返回用户名列表）
- credential_retrieve: 获取指定凭据的明文密码（仅 Agent 内部使用）
"""

import json
import logging
import uuid as _uuid
from typing import Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import json_tool_error, tool_result_success

logger = logging.getLogger(__name__)

_MIN_DOMAIN_SEGMENT_LENGTH = 4


def _is_valid_domain_suffix(service_name: str) -> bool:
    """Reject over-broad service_name values like 'com' or 'co.uk'."""
    return "." in service_name and len(service_name) >= _MIN_DOMAIN_SEGMENT_LENGTH


class CredentialLookupInput(BaseModel):
    domain: str = Field(default="", description="Website domain, e.g. github.com")
    app_package: str = Field(
        default="",
        description="Android app package name, e.g. com.twitter.android",
    )
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="User ID (auto-injected)",
    )


class CredentialRetrieveInput(BaseModel):
    credential_id: str = Field(description="Credential UUID from credential_lookup")
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="User ID (auto-injected)",
    )


class CredentialLookupTool(BaseTool):
    name: str = "credential_lookup"
    description: str = (
        "Query stored credentials by website domain or Android app package name. "
        "Returns matching usernames (without passwords) for auto-login decisions. "
        "Parameters: domain (e.g. 'github.com') and/or app_package (e.g. 'com.twitter.android'). "
        "At least one of domain or app_package is required."
    )
    execution_mode: str = "server"
    risk_level: str = "safe"
    args_schema: type[CredentialLookupInput] = CredentialLookupInput

    def run(
        self,
        domain: str = "",
        app_package: str = "",
        user_id: Optional[str] = None,
        **kwargs,
    ) -> str:
        from apps.credential_vault.models import UserCredential, CredentialCategory

        user_id = user_id or kwargs.get("user_id")
        if not user_id:
            return json_tool_error(
                "Missing user context",
                error_kind="runtime_misconfig",
                hint="Ensure the agent runtime injects user_id, then retry credential_lookup.",
                retryable=False,
            )

        domain = (domain or "").lower().strip().lstrip(".")
        app_package = (app_package or "").lower().strip()

        if not domain and not app_package:
            return json_tool_error(
                "At least one of domain or app_package is required",
                error_kind="missing_required_param",
                hint="Pass domain for a website login or app_package for an app login before calling credential_lookup.",
                retryable=False,
            )

        matched = []

        try:
            if domain:
                parts = domain.rsplit(".", 2)
                domain_tail = ".".join(parts[-2:]) if len(parts) >= 2 else domain
                website_creds = UserCredential.objects.filter(
                    user_id=user_id,
                    is_active=True,
                    category=CredentialCategory.WEBSITE_LOGIN,
                    service_name__icontains=domain_tail,
                )
                for cred in website_creds:
                    svc = cred.service_name.lower()
                    if svc != domain and not (
                        _is_valid_domain_suffix(svc) and domain.endswith(f".{svc}")
                    ):
                        continue
                    data = cred.encrypted_data or {}
                    matched.append({
                        "id": str(cred.id),
                        "category": cred.category,
                        "service": cred.service_name,
                        "url": data.get("url", ""),
                        "username": data.get("username", ""),
                    })

            if app_package:
                app_creds = UserCredential.objects.filter(
                    user_id=user_id,
                    is_active=True,
                    category=CredentialCategory.APP_LOGIN,
                    service_name=app_package,
                )
                for cred in app_creds:
                    data = cred.encrypted_data or {}
                    matched.append({
                        "id": str(cred.id),
                        "category": cred.category,
                        "service": cred.service_name,
                        "username": data.get("username", ""),
                    })
        except Exception as exc:
            logger.error(
                "credential_lookup query failed error_type=%s",
                type(exc).__name__,
            )
            return json_tool_error(
                "Stored credentials could not be queried.",
                error_kind="upstream_error",
                hint="Retry credential_lookup once. If it fails again, ask the user to verify saved credentials in Agent Security settings.",
                retryable=True,
            )

        query_desc = domain or app_package
        if not matched:
            return tool_result_success(
                json.dumps(
                    {
                        "credentials": [],
                        "message": f"No credential found for {query_desc}",
                    },
                    ensure_ascii=False,
                )
            )

        return tool_result_success(
            json.dumps({"credentials": matched}, ensure_ascii=False)
        )


class CredentialRetrieveTool(BaseTool):
    name: str = "credential_retrieve"
    description: str = (
        "获取指定凭据的完整登录信息（含密码），用于自动填充登录表单。"
        "调用前必须先通过 credential_lookup 获取凭据 ID。"
        "返回 url、username、password。"
        "注意：密码不得写入对话记录或展示给用户，仅用于 fill 操作。"
        "在移动设备场景下，优先使用 screen_type_secret（密码完全不经过 AI）。"
    )
    execution_mode: str = "server"
    risk_level: str = "review"
    available_modes: tuple = ("agent",)
    args_schema: type[CredentialRetrieveInput] = CredentialRetrieveInput

    _ALLOWED_CATEGORIES = frozenset({"website_login", "secret", "app_login"})

    def run(
        self,
        credential_id: str,
        user_id: Optional[str] = None,
        **kwargs,
    ) -> str:
        from apps.credential_vault.models import UserCredential
        from django.utils import timezone

        user_id = user_id or kwargs.get("user_id")
        if not user_id:
            return json_tool_error(
                "Missing user context",
                error_kind="runtime_misconfig",
                hint="Ensure the agent runtime injects user_id, then retry credential_retrieve.",
                retryable=False,
            )

        try:
            _uuid.UUID(credential_id)
        except (ValueError, AttributeError):
            return json_tool_error(
                "Invalid credential_id format. Expected a UUID from credential_lookup.",
                error_kind="invalid_param_format",
                hint="Run credential_lookup first, then pass the returned credential_id UUID to credential_retrieve.",
                retryable=False,
                context={"field": "credential_id"},
            )

        try:
            cred = UserCredential.objects.get(
                id=credential_id,
                user_id=user_id,
                is_active=True,
            )
        except UserCredential.DoesNotExist:
            return json_tool_error(
                "Credential not found or no access",
                error_kind="resource_not_found",
                hint="Run credential_lookup again to get a current credential_id before retrying credential_retrieve.",
                retryable=False,
            )
        except Exception as exc:
            logger.warning(
                "credential_retrieve lookup failed error_type=%s",
                type(exc).__name__,
            )
            return json_tool_error(
                "The credential store could not complete the request.",
                error_kind="upstream_error",
                hint="Retry credential_retrieve once. If it fails again, ask the user to verify the credential store is available.",
                retryable=True,
            )

        if cred.expires_at and cred.expires_at < timezone.now():
            return json_tool_error(
                "Credential has expired.",
                error_kind="resource_not_found",
                hint="Ask the user to update the credential in settings, then run credential_lookup again.",
                retryable=False,
            )

        if cred.category not in self._ALLOWED_CATEGORIES:
            return json_tool_error(
                "Credential category is not allowed for direct retrieval.",
                error_kind="permission_denied",
                hint=(
                    "Only website_login, secret, and app_login credentials can be retrieved. "
                    "Use credential_lookup to pick a supported credential."
                ),
                retryable=False,
            )

        data = cred.encrypted_data or {}
        return tool_result_success(
            json.dumps(
                {
                    "url": data.get("url", ""),
                    "username": data.get("username", ""),
                    "password": data.get("password", ""),
                },
                ensure_ascii=False,
            )
        )


def get_credential_tools():
    return [CredentialLookupTool(), CredentialRetrieveTool()]

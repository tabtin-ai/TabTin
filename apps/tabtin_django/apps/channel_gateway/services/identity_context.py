from __future__ import annotations

from dataclasses import dataclass
import uuid

from django.contrib.auth import get_user_model

from apps.tabtinspace.models import Organization, OrganizationMember

User = get_user_model()


def normalize_channel_context_value(value: str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (str, int)):
        return str(value).strip()
    return ""


@dataclass(frozen=True)
class ChannelIdentityContext:
    identity_user_id: str
    execution_agent_id: str
    execution_workspace_id: str
    handling_space_id: str


def resolve_channel_identity_context(
    *,
    organization_id: str,
    user_id: str = "",
    identity_user_id: str = "",
    execution_agent_id: str = "",
    execution_workspace_id: str = "",
    handling_space_id: str = "",
    space_id: str = "",
) -> ChannelIdentityContext:
    resolved_identity_user_id = (
        normalize_channel_context_value(identity_user_id)
        or normalize_channel_context_value(user_id)
    )
    resolved_execution_agent_id = (
        normalize_channel_context_value(execution_agent_id)
    )
    resolved_handling_space_id = (
        normalize_channel_context_value(handling_space_id)
        or normalize_channel_context_value(space_id)
    )

    return ChannelIdentityContext(
        identity_user_id=resolved_identity_user_id,
        execution_agent_id=resolved_execution_agent_id,
        execution_workspace_id=normalize_channel_context_value(
            execution_workspace_id,
        ),
        handling_space_id=resolved_handling_space_id,
    )


def resolve_channel_runtime_identity_context(
    *,
    organization_id: str,
    binding=None,
    account=None,
    session=None,
    fallback_identity_user_id: str = "",
    fallback_handling_space_id: str = "",
) -> ChannelIdentityContext:
    config = getattr(account, "config", None) or {}
    binding_identity_user_id = normalize_channel_context_value(getattr(binding, "identity_user_id", ""))
    binding_execution_agent_id = normalize_channel_context_value(
        getattr(binding, "execution_agent_id", "")
    )
    binding_execution_workspace_id = normalize_channel_context_value(
        getattr(binding, "execution_workspace_id", "")
    )
    binding_handling_space_id = normalize_channel_context_value(
        getattr(binding, "handling_space_id", "")
        or getattr(binding, "space_id", "")
    )

    return resolve_channel_identity_context(
        organization_id=organization_id,
        user_id=(
            binding_identity_user_id
            or normalize_channel_context_value(config.get("identity_user_id") or config.get("user_id"))
            or normalize_channel_context_value(getattr(session, "user_id", ""))
            or normalize_channel_context_value(getattr(getattr(session, "user", None), "id", ""))
            or normalize_channel_context_value(fallback_identity_user_id)
        ),
        execution_agent_id=(
            binding_execution_agent_id
            or normalize_channel_context_value(config.get("execution_agent_id"))
        ),
        execution_workspace_id=(
            binding_execution_workspace_id
            or normalize_channel_context_value(config.get("execution_workspace_id"))
        ),
        handling_space_id=(
            binding_handling_space_id
            or normalize_channel_context_value(fallback_handling_space_id)
        ),
    )


def resolve_channel_identity_user(*, organization_id: str, identity_user_id: str):
    resolved_identity_user_id = normalize_channel_context_value(identity_user_id)
    if not resolved_identity_user_id:
        raise ValueError("identity user required")

    try:
        user = User.objects.filter(id=resolved_identity_user_id).first()
    except Exception as exc:
        raise ValueError("identity user not found") from exc
    if not user:
        raise ValueError("identity user not found")

    try:
        in_organization = (
            OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id=resolved_identity_user_id,
            ).exists()
            or Organization.objects.filter(
                id=organization_id,
                owner_id=resolved_identity_user_id,
            ).exists()
        )
    except Exception as exc:
        raise ValueError("identity user organization mismatch") from exc

    if not in_organization:
        raise ValueError("identity user organization mismatch")

    return user


__all__ = [
    "ChannelIdentityContext",
    "normalize_channel_context_value",
    "resolve_channel_identity_context",
    "resolve_channel_identity_user",
    "resolve_channel_runtime_identity_context",
]

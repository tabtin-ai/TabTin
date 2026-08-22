"""Channel Gateway API schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, List, Optional, Dict, Any
from pydantic import BaseModel, BeforeValidator, Field, ConfigDict, model_validator

StrFromUUID = Annotated[str, BeforeValidator(lambda v: str(v) if v is not None else v)]


VALID_BINDING_STATUS = {"active", "paused", "blocked"}
VALID_DM_POLICY = {"open", "allowlist", "pairing"}
VALID_GROUP_POLICY = {"open", "allowlist"}


class ChannelBindingSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: StrFromUUID
    channel: str
    account_id: str
    peer_kind: str
    peer_id: str
    organization_id: str
    identity_user_id: Optional[str] = None
    execution_agent_id: Optional[str] = None
    execution_workspace_id: Optional[str] = None
    handling_space_id: Optional[str] = None
    space_id: Optional[str] = Field(default=None, validation_alias="space_id")
    session_id: Optional[str] = None
    thread_id: Optional[str] = None
    status: str
    last_message_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def _fill_compat_fields(self):
        if self.handling_space_id is None and self.space_id is not None:
            self.handling_space_id = self.space_id
        return self


class ChannelBindingListResponse(BaseModel):
    items: List[ChannelBindingSchema]
    total: int


class ChannelBindingCreateRequest(BaseModel):
    channel: str = Field(..., min_length=1)
    account_id: Optional[str] = Field(default=None, min_length=1)
    peer_kind: str = Field(..., min_length=1)
    peer_id: str = Field(..., min_length=1)
    organization_id: str = Field(..., min_length=1)
    identity_user_id: Optional[str] = Field(default=None, min_length=1)
    execution_agent_id: Optional[str] = Field(default=None, min_length=1)
    execution_workspace_id: Optional[str] = Field(default=None, min_length=1)
    handling_space_id: Optional[str] = Field(default=None, min_length=1)
    space_id: Optional[str] = Field(default=None, min_length=1)
    session_id: Optional[str] = Field(default=None, min_length=1)
    status: Optional[str] = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _validate_status(self):
        if self.handling_space_id is None and self.space_id is not None:
            self.handling_space_id = self.space_id
        if self.status is not None and self.status not in VALID_BINDING_STATUS:
            raise ValueError("status must be one of: active, paused, blocked")
        return self


class ChannelBindingUpdateRequest(BaseModel):
    identity_user_id: Optional[str] = Field(default=None, min_length=1)
    execution_agent_id: Optional[str] = Field(default=None, min_length=1)
    execution_workspace_id: Optional[str] = Field(default=None, min_length=1)
    handling_space_id: Optional[str] = Field(default=None, min_length=1)
    space_id: Optional[str] = Field(default=None, min_length=1)
    session_id: Optional[str] = Field(default=None, min_length=1)
    create_new_session: Optional[bool] = None
    status: Optional[str] = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _validate_update_constraints(self):
        if self.handling_space_id is None and self.space_id is not None:
            self.handling_space_id = self.space_id
        if self.create_new_session and self.session_id:
            raise ValueError("session_id and create_new_session cannot be used together")
        if self.status is not None and self.status not in VALID_BINDING_STATUS:
            raise ValueError("status must be one of: active, paused, blocked")
        return self


class ChannelAllowlistSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: StrFromUUID
    channel: str
    account_id: str
    peer_kind: str
    peer_id: str
    organization_id: str
    allow: bool
    note: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ChannelAllowlistListResponse(BaseModel):
    items: List[ChannelAllowlistSchema]
    total: int


class ChannelAllowlistCreateRequest(BaseModel):
    channel: str = Field(..., min_length=1)
    account_id: Optional[str] = Field(default=None, min_length=1)
    peer_kind: str = Field(..., min_length=1)
    peer_id: str = Field(..., min_length=1)
    organization_id: str = Field(..., min_length=1)
    allow: bool = True
    note: Optional[str] = Field(default=None, min_length=1)


class ChannelPolicySchema(BaseModel):
    organization_id: str
    channel: str
    account_id: str
    dm_policy: str
    group_policy: str
    require_mention: bool
    group_require_mention: Dict[str, bool]
    command_gate_enabled: bool
    command_prefixes: List[str]
    updated_at: Optional[datetime] = None


class ChannelPolicyUpdateRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    channel: str = Field(..., min_length=1)
    account_id: Optional[str] = Field(default=None, min_length=1)
    dm_policy: Optional[str] = Field(default=None, min_length=1)
    group_policy: Optional[str] = Field(default=None, min_length=1)
    require_mention: Optional[bool] = None
    group_require_mention: Optional[Dict[str, bool]] = None
    command_gate_enabled: Optional[bool] = None
    command_prefixes: Optional[List[str]] = None
    clear_group_overrides: Optional[bool] = False

    @model_validator(mode="after")
    def _validate_policy_update(self):
        if self.dm_policy is not None and self.dm_policy not in VALID_DM_POLICY:
            raise ValueError("dm_policy must be one of: open, allowlist, pairing")
        if self.group_policy is not None and self.group_policy not in VALID_GROUP_POLICY:
            raise ValueError("group_policy must be one of: open, allowlist")
        if self.group_require_mention is not None:
            for key in self.group_require_mention.keys():
                if not isinstance(key, str) or not key.strip():
                    raise ValueError("group_require_mention keys must be non-empty strings")
        if self.command_prefixes is not None:
            normalized_prefixes = []
            for value in self.command_prefixes:
                if not isinstance(value, str) or not value.strip():
                    continue
                normalized_prefixes.append(value.strip())
            if not normalized_prefixes:
                raise ValueError("command_prefixes must contain at least one non-empty string")
            self.command_prefixes = normalized_prefixes

        has_policy_patch = any(
            field in self.model_fields_set
            for field in (
                "dm_policy",
                "group_policy",
                "require_mention",
                "group_require_mention",
                "command_gate_enabled",
                "command_prefixes",
                "clear_group_overrides",
            )
        )
        if not has_policy_patch:
            raise ValueError("at least one policy field must be provided")
        return self


SENSITIVE_CONFIG_KEYS = {
    "bot_token", "webhook_token", "api_key", "secret", "password", "oauth_token",
    "app_secret", "encrypt_key", "verification_token",
    "signing_secret", "access_token", "verify_token",
    "public_key", "channel_access_token", "channel_secret",
}


def mask_sensitive_value(value: str) -> str:
    """对敏感字符串做脱敏：len>8 时保留首尾各 4 字符，中间替换为 ****。"""
    if len(value) > 8:
        return value[:4] + "****" + value[-4:]
    return value


def is_masked_value(original: str, candidate: str) -> bool:
    """判断 candidate 是否是 original 经 mask_sensitive_value 后的结果。"""
    if not isinstance(original, str) or len(original) <= 8:
        return False
    return candidate == mask_sensitive_value(original)


class ChannelAccountSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: StrFromUUID
    channel: str
    account_id: str
    organization_id: str
    name: Optional[str] = None
    enabled: bool
    config: Dict[str, Any]
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def _mask_sensitive_config(self):
        """脱敏 config 中的敏感字段，避免 bot_token 等凭证泄露到前端。"""
        if self.config:
            masked = {}
            for k, v in self.config.items():
                if k in SENSITIVE_CONFIG_KEYS and isinstance(v, str):
                    masked[k] = mask_sensitive_value(v)
                else:
                    masked[k] = v
            self.config = masked
        return self


class ChannelAccountListResponse(BaseModel):
    items: List[ChannelAccountSchema]
    total: int


class ChannelAccountCreateRequest(BaseModel):
    channel: str = Field(..., min_length=1)
    account_id: Optional[str] = Field(default=None, min_length=1)
    organization_id: str = Field(..., min_length=1)
    name: Optional[str] = Field(default=None, min_length=1)
    enabled: Optional[bool] = True
    config: Optional[Dict[str, Any]] = None


class ChannelAccountUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1)
    enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None


class ChannelRuntimeStatusSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: StrFromUUID
    channel: str
    account_id: str
    organization_id: str
    status: str
    last_error: Optional[str] = None
    qr: Optional[str] = None
    details: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


class ChannelRuntimeStatusListResponse(BaseModel):
    items: List[ChannelRuntimeStatusSchema]
    total: int


class ChannelOutboundRecordSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: StrFromUUID
    channel: str
    account_id: str
    organization_id: str
    peer_id: str
    payload: Dict[str, Any]
    idempotency_key: Optional[str] = None
    status: str
    attempts: int
    next_retry_at: Optional[datetime] = None
    last_error: Optional[str] = None
    sent_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class ChannelOutboundRecordListResponse(BaseModel):
    items: List[ChannelOutboundRecordSchema]
    total: int


class ChannelOutboundRetryRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    limit: Optional[int] = Field(default=50, ge=1, le=500)


class ChannelOutboundRetryResponse(BaseModel):
    retried: int


class ChannelPairingSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: StrFromUUID
    channel: str
    account_id: str
    peer_kind: str
    peer_id: str
    organization_id: str
    code: str
    status: str
    expires_at: datetime
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ChannelPairingListResponse(BaseModel):
    items: List[ChannelPairingSchema]
    total: int

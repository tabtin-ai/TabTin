"""Channel protocol schemas for WS payload validation."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

CHANNEL_PROTOCOL_VERSION = 1


class ChannelMedia(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["image", "video", "audio", "file", "sticker", "other"]
    url: Optional[str] = Field(default=None, min_length=1)
    file_id: Optional[str] = Field(default=None, min_length=1)
    mime_type: Optional[str] = Field(default=None, min_length=1)
    filename: Optional[str] = Field(default=None, min_length=1)
    size: Optional[int] = Field(default=None, ge=0)


class ChannelBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[CHANNEL_PROTOCOL_VERSION]
    channel: str = Field(min_length=1)
    account_id: Optional[str] = Field(default=None, min_length=1)
    # Wave 1：organization_id 统一从"兼容可选"提升到"必填"。
    # 所有 adapter / tasks / handler 均已传入 `str(account.organization_id)`，Pydantic
    # 层直接挡住空值能让错误信息更精准（替代 handler 层手写 "missing organization_id"）。
    organization_id: str = Field(min_length=1)
    identity_user_id: Optional[str] = Field(default=None, min_length=1)
    execution_agent_id: Optional[str] = Field(default=None, min_length=1)
    execution_workspace_id: Optional[str] = Field(default=None, min_length=1)
    handling_space_id: Optional[str] = Field(default=None, min_length=1)
    space_id: Optional[str] = Field(default=None, min_length=1)
    session_id: Optional[str] = Field(default=None, min_length=1)
    thread_id: Optional[str] = Field(default=None, min_length=1)
    metadata: Optional[Dict[str, Any]] = None


class ChannelInboundMessage(ChannelBase):
    type: Literal["channel.inbound"]
    peer_kind: Literal["dm", "group", "thread"]
    peer_id: str = Field(min_length=1)
    sender_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    reply_to: Optional[str] = Field(default=None, min_length=1)
    text: Optional[str] = None
    media: Optional[List[ChannelMedia]] = None
    timestamp: int = Field(ge=0)

    @model_validator(mode="after")
    def _ensure_text_or_media(self):
        if (self.text and self.text.strip()) or (self.media and len(self.media) > 0):
            return self
        raise ValueError("channel.inbound requires text or media")


class ChannelOutboundPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Optional[str] = None
    media: Optional[List[ChannelMedia]] = None
    reply_to: Optional[str] = Field(default=None, min_length=1)
    metadata: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def _ensure_text_or_media(self):
        if (self.text and self.text.strip()) or (self.media and len(self.media) > 0):
            return self
        raise ValueError("channel.outbound.payload requires text or media")


class ChannelOutboundMessage(ChannelBase):
    type: Literal["channel.outbound"]
    to: str = Field(min_length=1)
    outbox_id: Optional[str] = Field(default=None, min_length=1)
    message_id: Optional[str] = Field(default=None, min_length=1)
    idempotency_key: Optional[str] = Field(default=None, min_length=1)
    payload: ChannelOutboundPayload


class ChannelOutboundAckMessage(ChannelBase):
    type: Literal["channel.outbound.ack"]
    outbox_id: Optional[str] = Field(default=None, min_length=1)
    message_id: Optional[str] = Field(default=None, min_length=1)
    status: Literal["delivered", "failed"]
    provider_message_id: Optional[str] = Field(default=None, min_length=1)
    error: Optional[str] = None

    @model_validator(mode="after")
    def _ensure_identity(self):
        if (self.outbox_id and self.outbox_id.strip()) or (self.message_id and self.message_id.strip()):
            return self
        raise ValueError("channel.outbound.ack requires outbox_id or message_id")


class ChannelStatusMessage(ChannelBase):
    type: Literal["channel.status"]
    status: Literal[
        "running",
        "stopped",
        "connecting",
        "reconnecting",
        "disconnected",
        "error",
        "waiting_scan",
        "scanned",
        "auth_expired",
    ]
    last_error: Optional[str] = None
    ts: int = Field(ge=0)
    details: Optional[Dict[str, Any]] = None

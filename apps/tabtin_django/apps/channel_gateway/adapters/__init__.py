"""Channel adapters — pluggable transport layer for external messaging platforms."""

from .base import ChannelAdapter, ChannelCapabilities, SendResult, WebhookChallengeResponse
from .registry import ChannelAdapterRegistry

__all__ = [
    "ChannelAdapter",
    "ChannelCapabilities",
    "ChannelAdapterRegistry",
    "SendResult",
    "WebhookChallengeResponse",
]

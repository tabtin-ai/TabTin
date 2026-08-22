"""Singleton registry for channel adapters.

Adapters register themselves at Django ``AppConfig.ready()`` time so the
rest of the gateway can look them up by channel id.

Supports runtime register/unregister for dynamic adapters (e.g. Plugin
Runtime creating PluginBridgeAdapter instances on the fly).
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Dict, List, Optional

from .base import ChannelAdapter

logger = logging.getLogger(__name__)

OnChangeCallback = Callable[[str, str], None]


class ChannelAdapterRegistry:
    """Thread-safe adapter registry with runtime register/unregister."""

    _adapters: Dict[str, ChannelAdapter] = {}
    _lock = threading.Lock()
    _on_change_callbacks: List[OnChangeCallback] = []

    @classmethod
    def register(cls, adapter: ChannelAdapter) -> None:
        channel_id = adapter.id
        with cls._lock:
            is_overwrite = channel_id in cls._adapters
            cls._adapters[channel_id] = adapter

        if is_overwrite:
            logger.warning(
                "[ChannelAdapterRegistry] overwriting adapter for %s",
                channel_id,
            )
        logger.info(
            "[ChannelAdapterRegistry] registered %s (%s)",
            channel_id,
            adapter.name,
        )
        cls._notify("register", channel_id)

    @classmethod
    def unregister(cls, channel_id: str) -> bool:
        """Remove an adapter by channel id. Returns True if it existed."""
        with cls._lock:
            adapter = cls._adapters.pop(channel_id, None)

        if adapter is None:
            return False

        logger.info(
            "[ChannelAdapterRegistry] unregistered %s (%s)",
            channel_id,
            adapter.name,
        )
        cls._notify("unregister", channel_id)
        return True

    @classmethod
    def get(cls, channel_id: str) -> Optional[ChannelAdapter]:
        with cls._lock:
            return cls._adapters.get(channel_id)

    @classmethod
    def list_all(cls) -> List[ChannelAdapter]:
        with cls._lock:
            return list(cls._adapters.values())

    @classmethod
    def list_ids(cls) -> List[str]:
        with cls._lock:
            return list(cls._adapters.keys())

    @classmethod
    def has(cls, channel_id: str) -> bool:
        with cls._lock:
            return channel_id in cls._adapters

    @classmethod
    def on_change(cls, callback: OnChangeCallback) -> None:
        """Register a callback invoked after register/unregister.

        callback(action: "register"|"unregister", channel_id: str)
        """
        with cls._lock:
            cls._on_change_callbacks.append(callback)

    @classmethod
    def _notify(cls, action: str, channel_id: str) -> None:
        with cls._lock:
            callbacks = list(cls._on_change_callbacks)
        for cb in callbacks:
            try:
                cb(action, channel_id)
            except Exception:
                logger.warning(
                    "[ChannelAdapterRegistry] on_change callback error for %s/%s",
                    action, channel_id, exc_info=True,
                )

    @classmethod
    def _reset(cls) -> None:
        """For tests only."""
        with cls._lock:
            cls._adapters = {}
            cls._on_change_callbacks = []

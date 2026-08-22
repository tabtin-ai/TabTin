"""Host 状态失效通知；事件不携带任何配置值。"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from apps.services.common.agent_protocol.namespace import device_action_topic
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

HOST_STATE_INVALIDATED = "host.state.invalidated"


def publish_host_state_invalidated(
    device_fingerprints: Iterable[str], *, reason: str
) -> None:
    """通知 Host 主动重拉；仅含原因，不把后端配置塞入事件。"""
    for fingerprint in sorted({value for value in device_fingerprints if value}):
        envelope = build_envelope(
            HOST_STATE_INVALIDATED,
            new_event_id(),
            {"reason": reason},
        )
        if not publish_ws_event(device_action_topic(fingerprint), envelope):
            logger.info(
                "[HostState] realtime invalidation missed; periodic pull will reconcile: "
                "device=%s reason=%s",
                fingerprint,
                reason,
            )


def publish_user_host_state_invalidated(user_id, *, reason: str) -> None:
    """通知该用户拥有执行上下文的全部 Host。"""
    from apps.tabtinspace.models import Workspace

    fingerprints = Workspace.objects.filter(
        device__user_id=user_id,
    ).values_list("device__fingerprint", flat=True)
    publish_host_state_invalidated(fingerprints, reason=reason)


__all__ = [
    "HOST_STATE_INVALIDATED",
    "publish_host_state_invalidated",
    "publish_user_host_state_invalidated",
]

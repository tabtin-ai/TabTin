"""
Space 列表变更的 WS 推送工具

通过 context.sync.organization.{organization_id} 通道推送 Space 列表变更，
复用现有 ContextSyncValidator 鉴权（零改动 WS 基础设施）。

用法（在 @transaction.atomic 内）:
    from django.db import transaction
    from apps.services.common.db_router import postgres_app_db_alias
    transaction.on_commit(
        lambda: publish_space_list_change(str(organization_id), 'created', str(space.id)),
        using=postgres_app_db_alias(),
    )
"""

import logging

logger = logging.getLogger(__name__)


def publish_space_list_change(
    organization_id: str,
    action: str,
    space_id: str = '',
    extra: dict | None = None,
) -> None:
    """推送 Space 列表变更到 organization 级 context.sync 通道。

    Args:
        organization_id: 组织 ID
        action: 变更类型 — created / updated / archived / restored / trashed / deleted
        space_id: 变更的 Space ID（可选）
        extra: 额外 payload 字段（可选）
    """
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import ContextSyncEvent

        payload = {
            'type': 'space_list_changed',
            'action': action,
            'space_id': space_id,
            'organization_id': organization_id,
        }
        if extra:
            payload.update(extra)

        publish_ws_event(
            topic=f"{ContextSyncEvent.PREFIX}.organization.{organization_id}",
            envelope=payload,
        )
    except Exception as exc:
        logger.warning(
            "[SpaceSync] WS push failed: organization=%s action=%s space=%s: %s",
            organization_id, action, space_id, exc, exc_info=True,
        )

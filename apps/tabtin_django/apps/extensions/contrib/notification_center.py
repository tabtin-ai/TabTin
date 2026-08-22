"""Notification Center Extension

TabTin 内置通知推送中心，作为 EventBus 全局消费者，
将事件按规则匹配转化为用户通知并通过多渠道投递。

is_builtin = True：默认安装、默认启用、不可卸载。
"""

from __future__ import annotations

import fnmatch
import logging
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from apps.extensions.base import (
    BaseExtension,
    ConfigField,
    EventDescriptor,
    ExtensionCapabilities,
    PayloadField,
    ProbeResult,
)
from apps.extensions.constants import ExtensionType

if TYPE_CHECKING:
    from apps.extensions.models import ExtensionConnection

logger = logging.getLogger(__name__)

NOTIFICATION_CHANNELS = [
    {"value": "in_app", "label": "应用内通知"},
    {"value": "desktop", "label": "桌面通知"},
]


class NotificationCenterExtension(BaseExtension):

    @property
    def id(self) -> str:
        return "notification_center"

    @property
    def name(self) -> str:
        return "Notification Center"

    @property
    def description(self) -> str:
        return "TabTin 内置通知推送中心，统一汇聚事件并按规则投递到多渠道"

    @property
    def icon(self) -> str:
        return "🔔"

    @property
    def extension_type(self) -> str:
        return ExtensionType.INTEGRATION

    @property
    def is_builtin(self) -> bool:
        return True

    @property
    def capabilities(self) -> ExtensionCapabilities:
        return ExtensionCapabilities(
            has_tools=True,
            has_events=True,
            has_ui=True,
        )

    def get_config_fields(self) -> List[ConfigField]:
        return [
            ConfigField(
                key="default_channels",
                label="默认投递渠道",
                field_type="select",
                options=NOTIFICATION_CHANNELS,
                default="in_app",
            ),
            ConfigField(
                key="quiet_hours_enabled",
                label="启用免打扰",
                field_type="boolean",
                default=False,
            ),
        ]

    def get_event_types(self) -> List[EventDescriptor]:
        return [
            EventDescriptor(
                event_type="notification.created",
                description="新通知已创建",
                payload_fields=[
                    PayloadField(key="notification_id", label="通知 ID", example="n-abc123"),
                    PayloadField(key="title", label="通知标题", example="新邮件"),
                    PayloadField(key="channels", label="投递渠道", type="list", example='["in_app"]'),
                ],
            ),
            EventDescriptor(
                event_type="notification.delivered",
                description="通知已投递到渠道",
                payload_fields=[
                    PayloadField(key="notification_id", label="通知 ID", example="n-abc123"),
                    PayloadField(key="channel", label="渠道", example="desktop"),
                ],
            ),
        ]

    def get_tools(self, connection: Optional["ExtensionConnection"] = None) -> list:
        return []

    async def probe(self, connection: "ExtensionConnection") -> ProbeResult:
        return ProbeResult(ok=True, display_name="Notification Center")


# ---------------------------------------------------------------------------
# EventBus 消费者：规则匹配 + 通知创建
# ---------------------------------------------------------------------------

def notification_center_consumer(event) -> Any:
    """EventBus 消费者回调，将事件按 NotificationRule 转化为通知。

    每个目标用户的通知创建拆为独立 Celery 子任务，避免 N 个用户串行阻塞。
    """
    from apps.extensions.models import NotificationRule

    try:
        rules = NotificationRule.objects.filter(
            organization_id=event.organization_id,
            enabled=True,
        )

        matched_rules = []
        for rule in rules:
            if not _event_matches_pattern(event.event_type, rule.event_pattern):
                continue
            if rule.source_extension_id and rule.source_extension_id != event.source:
                continue
            if rule.space_id:
                if rule.space_id != event.space_id:
                    continue
            matched_rules.append(rule)

        if not matched_rules:
            return 0

        best_rule = _select_best_rule(matched_rules, event.space_id)
        if not best_rule:
            return 0

        title = _render_template(
            best_rule.title_template or "{event_type}",
            event,
        )
        body = _render_template(best_rule.body_template or "", event)
        payload = event.payload if isinstance(event.payload, dict) else {}
        metadata = {
            "source_event_id": event.event_id,
            "source_extension_id": event.source,
            "event_type": event.event_type,
            "space_id": event.space_id,
            "priority": best_rule.priority,
            "channels": best_rule.channels,
            "category": best_rule.category,
            "message_id": payload.get("message_id"),
            "thread_id": payload.get("thread_id"),
        }

        user_ids = _resolve_target_users(event.organization_id, event.space_id)
        dispatched = 0
        broker_down = False
        for uid in user_ids:
            try:
                from apps.extensions.tasks import deliver_notification_for_user
                deliver_notification_for_user.delay(
                    user_id=uid,
                    title=title,
                    body=body,
                    organization_id=event.organization_id,
                    metadata=metadata,
                )
                dispatched += 1
            except Exception as exc:
                from apps.maintenance.celery_utils import is_broker_connection_error
                if is_broker_connection_error(exc):
                    if not broker_down:
                        logger.warning(
                            "[notification_center] broker 不可达，通知任务未入队: event=%s (%s)",
                            event.event_type, exc,
                        )
                        broker_down = True
                else:
                    logger.error(
                        "[notification_center] 通知子任务提交失败: user=%s", uid, exc_info=True,
                    )

        if dispatched:
            logger.info(
                "[notification_center] 事件 %s 匹配规则 %s → 分发 %d 个通知子任务",
                event.event_type,
                best_rule.id,
                dispatched,
            )
        return dispatched

    except Exception:
        logger.error(
            "[notification_center] 处理事件失败: %s", event.event_type, exc_info=True
        )
        return 0


def _event_matches_pattern(event_type: str, pattern: str) -> bool:
    """使用 fnmatch 通配符匹配事件类型。

    支持: "email.*", "*.failed", "tabdata.record.created" 等。
    """
    return fnmatch.fnmatch(event_type, pattern)


def _select_best_rule(rules, space_id: Optional[str]):
    """选择最匹配的规则：Space 级 > Organization 级，同级按 sort_order 排。"""
    as_rules = [r for r in rules if r.space_id] if space_id else []
    ws_rules = [r for r in rules if not r.space_id]

    candidates = as_rules if as_rules else ws_rules
    if not candidates:
        return None
    return min(candidates, key=lambda r: r.sort_order)


def _render_template(template: str, event) -> str:
    """模板变量替换 — 合并事件基础字段 + payload 全部字段作为上下文。

    模板中可使用 {event_type}、{source} 等基础变量，
    也可使用 {subject}、{from_address} 等来自 event.payload 的业务变量。
    未匹配到的占位符保持原样（safe_format），不会抛异常。
    """
    context: Dict[str, Any] = {}
    if event.payload:
        context.update(event.payload)
    context.update({
        "event_type": event.event_type,
        "source": event.source,
        "organization_id": event.organization_id,
        "space_id": event.space_id or "",
    })

    return _safe_format(template, context)


def _safe_format(template: str, context: Dict[str, Any]) -> str:
    """str.format_map 的安全版本 — 缺失的 key 保留原始占位符。"""
    class _DefaultDict(dict):
        def __missing__(self, key: str) -> str:
            return "{" + key + "}"

    try:
        return template.format_map(_DefaultDict(context))
    except (ValueError, IndexError):
        return template


MAX_NOTIFICATION_TARGETS = 200


def _resolve_target_users(organization_id: str, space_id: Optional[str]) -> List[str]:
    """确定通知目标用户列表。

    当提供 space_id 时，优先使用 SpacePermission 限定的用户范围；
    如无显式权限记录，退化为 organization owner + 有活跃权限的成员子集。
    任何情况下目标用户数不超过 MAX_NOTIFICATION_TARGETS。
    """
    user_ids: List[str] = []
    try:
        from apps.tabtinspace.models import Organization, OrganizationMember

        ws = Organization.objects.filter(id=organization_id).first()
        if not ws:
            return []

        owner_id = str(ws.owner_id)
        user_ids.append(owner_id)

        if space_id:
            try:
                from apps.tabtinspace.models import SpacePermission
                perm_uids = list(
                    SpacePermission.objects.filter(
                        workspace_id=space_id,
                        subject_type="user",
                        is_active=True,
                    ).values_list("subject_id", flat=True)[:MAX_NOTIFICATION_TARGETS]
                )
                for uid in perm_uids:
                    uid_str = str(uid)
                    if uid_str not in user_ids:
                        user_ids.append(uid_str)
            except Exception:
                pass
            # space 级事件：只通知 owner + 有权限的用户，不扩散到全 organization
            return user_ids[:MAX_NOTIFICATION_TARGETS]

        member_uids = OrganizationMember.objects.filter(
            organization_id=organization_id,
        ).values_list("user_id", flat=True)[:MAX_NOTIFICATION_TARGETS]

        for uid in member_uids:
            uid_str = str(uid)
            if uid_str not in user_ids:
                user_ids.append(uid_str)

    except Exception:
        logger.warning("[notification_center] 获取组织成员失败", exc_info=True)

    return user_ids[:MAX_NOTIFICATION_TARGETS]

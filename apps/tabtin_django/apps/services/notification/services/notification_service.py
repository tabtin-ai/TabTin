"""团队通知服务。

负责创建通知记录并通过 WebSocket 实时推送给用户。
"""
import hashlib
import logging
from typing import Optional, Dict, Any, List
from uuid import UUID

from django.utils import timezone
from django.db import IntegrityError, transaction
from django.db.models import Q, QuerySet

from apps.services.notification.models import Notification
from apps.services.notification.services.notification_center_catalog import (
    filter_notification_center_queryset,
    resolve_notification_center_category,
)
from apps.services.notification.services.notification_copy import format_notification_copy
from apps.services.common.agent_protocol.constants import AgentUserEvent
from apps.services.common.agent_protocol.namespace import user_event_type
from apps.services.common.ws.bus import publish_to_user
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

MAX_NOTIFICATION_SOURCE_EVENT_ID_LENGTH = 100

# Agent 任务终态：用户进入会话并完成「已查看最新消息」后应按 session 自动已读。
# 不含 agent.hitl.waiting——HITL 走 interaction 级已读，避免误清仍待处理的审批卡。
AGENT_TASK_TERMINAL_TYPES = (
    'agent.task.completed',
    'agent.task.error',
    'agent.task.interrupted',
)
AGENT_HITL_WAITING_TYPE = 'agent.hitl.waiting'

# IM 未读走侧栏「消息」，不进铃铛 list / unread-count（含历史 im.message 遗留行）。
INBOX_EXCLUDED_TYPE_PREFIXES = ('im.',)
PERSONAL_INVITATION_TYPE_PREFIX = 'organization.invitation'
PERSONAL_ORGANIZATION_LIFECYCLE_TYPES = ('member_added', 'member_removed')


def _inbox_visible_queryset(qs: QuerySet) -> QuerySet:
    for prefix in INBOX_EXCLUDED_TYPE_PREFIXES:
        qs = qs.exclude(type__startswith=prefix)
    return qs


def _organization_inbox_queryset(
    qs: QuerySet,
    organization_id: str | None,
    include_personal_invitations: bool,
) -> QuerySet:
    """保留当前组织收件箱，同时可额外纳入账号级组织邀请。"""
    if not organization_id:
        return qs
    scope = Q(organization_id=organization_id)
    if include_personal_invitations:
        scope |= Q(type__startswith=PERSONAL_INVITATION_TYPE_PREFIX)
        # 被后台直接加入 / 移除组织都是账号生命周期事实，跨当前组织也应对本人可见。
        scope |= Q(type__in=PERSONAL_ORGANIZATION_LIFECYCLE_TYPES)
    return qs.filter(scope)


def compact_notification_source_event_id(source_event_id: Any) -> tuple[str, str]:
    """返回可写入 Notification.source_event_id 的稳定去重 key。

    `Notification.source_event_id` 是 varchar(100)。上游事件 ID 可能由多个
    UUID 拼接而成，因此公共入口统一压缩，避免某个调用方漏做长度保护。
    """
    if source_event_id is None:
        raw = ''
    else:
        raw = str(source_event_id).strip()
    if len(raw) <= MAX_NOTIFICATION_SOURCE_EVENT_ID_LENGTH:
        return raw, raw

    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:24]
    suffix = f':sha256:{digest}'
    prefix_len = MAX_NOTIFICATION_SOURCE_EVENT_ID_LENGTH - len(suffix)
    prefix = raw[:prefix_len].rstrip(':')
    return f'{prefix}{suffix}', raw


class NotificationService:
    """团队通知服务"""

    @staticmethod
    def notify_desktop_only(
        user_id: str,
        type: str,
        title: str,
        body: str = '',
        metadata: Optional[Dict[str, Any]] = None,
        organization_id: str = '',
    ) -> None:
        """实时发送仅桌面展示的通知，不创建通知中心记录。"""
        try:
            raw_source_event_id = (metadata or {}).get('source_event_id')
            source_event_id, _ = compact_notification_source_event_id(
                raw_source_event_id or new_event_id()
            )
            envelope = build_envelope(
                user_event_type(AgentUserEvent.NOTIFICATION_NEW),
                new_event_id(),
                {
                    'id': source_event_id,
                    'type': type,
                    'title': title,
                    'body': body,
                    'metadata': {
                        'desktop_only': True,
                        'source_event_id': source_event_id,
                    },
                    'organization_id': organization_id,
                    'space_id': '',
                    'priority': 'normal',
                    'category': 'general',
                    'source_extension_id': '',
                    'source_event_id': source_event_id,
                    'channels_delivered': [],
                    'is_read': True,
                    'read_at': None,
                    'created_at': None,
                },
            )
            publish_to_user(user_id, envelope)
        except Exception:
            logger.debug(
                '仅桌面通知实时发送失败: user_id=%s type=%s',
                user_id,
                type,
                exc_info=True,
            )

    @staticmethod
    def notify(
        user_id: str,
        type: str,
        title: str,
        body: str = '',
        metadata: Optional[Dict[str, Any]] = None,
        organization_id: str = '',
    ) -> Notification:
        """创建通知并通过 WebSocket 推送。

        如果 metadata 中包含 source_event_id / source_extension_id /
        space_id / priority / category / channels 等键，
        会自动提取写入 Notification 模型的独立列，以支持精确查询和 WS 推送。
        """
        meta = dict(metadata or {})
        title, body = format_notification_copy(type, title, body, meta)
        if type == 'member_added' and 'source_event_id' in meta:
            meta['source_event_id'] = NotificationService._canonical_member_added_event_key(
                meta.get('source_event_id')
            )
        if 'source_event_id' in meta:
            stored_source_event_id, raw_source_event_id = compact_notification_source_event_id(
                meta.get('source_event_id')
            )
            meta['source_event_id'] = stored_source_event_id
            if raw_source_event_id != stored_source_event_id:
                meta['original_source_event_id'] = raw_source_event_id
        # Org-only resources intentionally have no Space. Keep the
        # notification table's empty-string sentinel instead of passing None
        # through to its NOT NULL column.
        space_id = meta.get('space_id') or ''
        business_dedupe_key = meta.pop('dedupe_key', None)
        if type == 'member_added':
            business_dedupe_key = NotificationService._canonical_member_added_event_key(
                business_dedupe_key
            )
        dedupe_key = NotificationService._build_dedupe_key(user_id, business_dedupe_key)
        create_kwargs = {
            'user_id': user_id,
            'organization_id': organization_id,
            'type': type,
            'title': title,
            'body': body,
            'metadata': meta,
            'source_event_id': meta.get('source_event_id', ''),
            'source_extension_id': meta.get('source_extension_id', ''),
            'space_id': space_id,
            'priority': meta.get('priority', 'normal'),
            'category': meta.get('category', 'general'),
            'channels_delivered': meta.get('channels', []),
        }

        if dedupe_key:
            try:
                with transaction.atomic():
                    notif, created = Notification.objects.get_or_create(
                        dedupe_key=dedupe_key,
                        defaults=create_kwargs,
                    )
            except IntegrityError:
                notif = Notification.objects.get(dedupe_key=dedupe_key)
                created = False
            if not created:
                return notif
        else:
            notif = Notification.objects.create(**create_kwargs)

        NotificationService._push_ws(user_id, notif)
        return notif

    @staticmethod
    def _build_dedupe_key(user_id: str, business_key: Any) -> str | None:
        """将业务事实键收敛成数据库唯一键，并固定包含接收人维度。"""
        raw_business_key = str(business_key or '').strip()
        if not raw_business_key:
            return None
        raw = f'{str(user_id).strip()}:{raw_business_key}'
        if len(raw) <= 160:
            return raw
        return f'notification:sha256:{hashlib.sha256(raw.encode("utf-8")).hexdigest()}'

    @staticmethod
    def _canonical_member_added_event_key(event_key: Any) -> str:
        """兼容成员加入事件的两种历史键，统一为成员关系事实键。"""
        raw = str(event_key or '').strip()
        parts = raw.split(':')
        if len(parts) != 4 or parts[0] != 'organization':
            return raw
        if parts[1:3] == ['member', 'added'] or parts[2] == 'member_added':
            return f'organization:member:added:{parts[3]}'
        return raw

    @staticmethod
    def notify_organization_members(
        organization_id: str,
        type: str,
        title: str,
        body: str = '',
        metadata: Optional[Dict[str, Any]] = None,
        exclude_user_id: str = '',
    ):
        """通知工作空间所有成员（排除指定用户）"""
        try:
            from apps.tabtinspace.models import Organization, OrganizationMember
            organization = Organization.objects.get(id=organization_id)

            user_ids = set()
            user_ids.add(str(organization.owner_id))
            for m in OrganizationMember.objects.filter(organization_id=organization_id).values_list('user_id', flat=True):
                user_ids.add(str(m))

            if exclude_user_id:
                user_ids.discard(exclude_user_id)

            for uid in user_ids:
                NotificationService.notify(
                    user_id=uid,
                    type=type,
                    title=title,
                    body=body,
                    metadata=metadata,
                    organization_id=organization_id,
                )
        except Exception as e:
            logger.warning(f"批量通知失败: {e}")

    @staticmethod
    def mark_read(notification_id, user_id: str) -> bool:
        try:
            notif = Notification.objects.get(id=notification_id, user_id=user_id)
            notif.is_read = True
            notif.read_at = timezone.now()
            notif.save(update_fields=['is_read', 'read_at'])
            return True
        except Notification.DoesNotExist:
            return False

    @staticmethod
    def resolve_invitation_notification(
        user_id: str,
        invitation_id: str,
        *,
        type: str,
        title: str,
        body: str = '',
        metadata: Optional[Dict[str, Any]] = None,
        organization_id: str = '',
    ) -> Notification:
        """将待处理的 organization.invitation 原地升级为结果态。

        接受 / 拒绝 / 取消后若再插一条 sync/cancelled，铃铛会出现
        「邀请加入…（仍带查看邀请）」+「邀请已接受」双卡。
        有旧卡则改写 type/title/body 并标已读；没有旧卡再新建。
        """
        inv_id = (invitation_id or '').strip()
        meta = dict(metadata or {})
        if inv_id:
            meta.setdefault('invitation_id', inv_id)
        meta['resolved'] = True
        title, body = format_notification_copy(type, title, body, meta)
        dedupe_key = NotificationService._build_dedupe_key(
            user_id,
            meta.pop('dedupe_key', None),
        )

        candidates: List[Notification] = []
        if inv_id:
            candidates = list(
                Notification.objects.filter(
                    user_id=user_id,
                    type='organization.invitation',
                    metadata__invitation_id=inv_id,
                ).order_by('-created_at')[:5]
            )

        now = timezone.now()
        if candidates:
            primary = candidates[0]
            extras = candidates[1:]
            if extras:
                Notification.objects.filter(id__in=[n.id for n in extras]).delete()

            was_unread = not primary.is_read
            primary.type = type
            primary.title = title
            primary.body = body
            primary.metadata = {**(primary.metadata or {}), **meta}
            if dedupe_key:
                primary.dedupe_key = dedupe_key
            if organization_id:
                primary.organization_id = organization_id
            primary.is_read = True
            primary.read_at = now
            primary.save(
                update_fields=[
                    'type',
                    'title',
                    'body',
                    'metadata',
                    'dedupe_key',
                    'organization_id',
                    'is_read',
                    'read_at',
                ]
            )
            # 结果态由用户自己触发，不抬未读；WS 仍推送以便其他设备刷新。
            NotificationService._push_ws(user_id, primary)
            if was_unread:
                logger.debug(
                    "resolved invitation notification in-place user=%s invitation=%s -> %s",
                    user_id,
                    inv_id,
                    type,
                )
            return primary

        # 自触发结果态：落库即已读，避免角标无意义 +1；不走 notify() 以免先推未读。
        space_id = meta.get('space_id') or ''
        if dedupe_key:
            existing = Notification.objects.filter(dedupe_key=dedupe_key).first()
            if existing:
                return existing
        notif = Notification.objects.create(
            user_id=user_id,
            organization_id=organization_id,
            type=type,
            title=title,
            body=body,
            metadata=meta,
            dedupe_key=dedupe_key,
            source_event_id=meta.get('source_event_id', ''),
            source_extension_id=meta.get('source_extension_id', ''),
            space_id=space_id,
            priority=meta.get('priority', 'normal'),
            category=meta.get('category', 'general'),
            channels_delivered=meta.get('channels', []),
            is_read=True,
            read_at=now,
        )
        NotificationService._push_ws(user_id, notif)
        return notif

    @staticmethod
    def resolve_resource_access_request_notification(
        *,
        user_id: str,
        request_id: str,
        request_status: str,
    ) -> Notification | None:
        """将资源访问申请通知原地收敛为终态并推送到其他设备。"""
        uid = str(user_id or '').strip()
        rid = str(request_id or '').strip()
        status = str(request_status or '').strip().lower()
        if not uid or not rid or status not in {'approved', 'superseded'}:
            return None

        notifications = list(
            Notification.objects.filter(
                user_id=uid,
                type='resource_access_request',
                metadata__request_id=rid,
            ).order_by('-created_at')
        )
        if not notifications:
            return None

        now = timezone.now()
        for notification in notifications:
            notification.metadata = {
                **(notification.metadata or {}),
                'resolved': True,
                'request_status': status,
                'behavior': 'notification_only',
            }
            notification.is_read = True
            notification.read_at = now
            notification.save(update_fields=['metadata', 'is_read', 'read_at'])
            NotificationService._push_ws(uid, notification)
        return notifications[0]

    @staticmethod
    def upsert_conversation_notification(
        user_id: str,
        dedup_key: str,
        *,
        type: str,
        title: str,
        body: str = '',
        metadata: Optional[Dict[str, Any]] = None,
        organization_id: str = '',
    ) -> Notification:
        """会话型通知：同一 ``dedup_key`` 对同一用户合并为一条。

        用于 IM 新消息桥接——群聊/私信一条条推进铃铛会把角标刷爆，且和
        「消息」分段的会话未读重复。这里按 ``(user_id, type, dedup_key)`` 去重：
        已有旧卡则原地更新 title/body(preview)/navigate_to、把 ``created_at``
        冒泡到最新、并重新置未读；没有旧卡再新建。``dedup_key`` 存入
        ``source_event_id``（超长自动压缩）。
        """
        stored_key, raw_key = compact_notification_source_event_id(dedup_key)
        meta = dict(metadata or {})
        meta['source_event_id'] = stored_key
        if raw_key != stored_key:
            meta['original_source_event_id'] = raw_key
        space_id = meta.get('space_id') or ''
        now = timezone.now()

        existing = (
            Notification.objects.filter(
                user_id=user_id,
                type=type,
                source_event_id=stored_key,
            )
            .order_by('-created_at')
            .first()
        )
        if existing is not None:
            existing.title = title
            existing.body = body
            existing.metadata = {**(existing.metadata or {}), **meta}
            if organization_id:
                existing.organization_id = organization_id
            if space_id:
                existing.space_id = space_id
            existing.priority = meta.get('priority', existing.priority)
            existing.category = meta.get('category', existing.category)
            existing.is_read = False
            existing.read_at = None
            # created_at 用 auto_now_add，仅 insert 时自动写；update 时显式赋值
            # 仍会落库（冒泡到收件箱顶部，保证新消息把旧卡顶上来）。
            existing.created_at = now
            existing.save(
                update_fields=[
                    'title',
                    'body',
                    'metadata',
                    'organization_id',
                    'space_id',
                    'priority',
                    'category',
                    'is_read',
                    'read_at',
                    'created_at',
                ]
            )
            NotificationService._push_ws(user_id, existing)
            return existing

        notif = Notification.objects.create(
            user_id=user_id,
            organization_id=organization_id,
            type=type,
            title=title,
            body=body,
            metadata=meta,
            source_event_id=stored_key,
            source_extension_id=meta.get('source_extension_id', ''),
            space_id=space_id,
            priority=meta.get('priority', 'normal'),
            category=meta.get('category', 'general'),
            channels_delivered=meta.get('channels', []),
        )
        NotificationService._push_ws(user_id, notif)
        return notif

    @staticmethod
    def mark_conversation_read(user_id: str, dedup_key: str, *, type: str) -> int:
        """把某会话型通知（``dedup_key``）对某用户的未读卡片标记已读。

        用于「打开会话读消息 → 铃铛里该会话的 IM 通知自动已读」的读态联动，
        避免「消息」分段已读了、铃铛角标却还挂着的双语义打架。
        """
        stored_key, _ = compact_notification_source_event_id(dedup_key)
        qs = Notification.objects.filter(
            user_id=user_id,
            type=type,
            source_event_id=stored_key,
            is_read=False,
        )
        ids = list(qs.values_list('id', flat=True))
        if not ids:
            return 0
        now = timezone.now()
        Notification.objects.filter(id__in=ids).update(is_read=True, read_at=now)
        for notif in Notification.objects.filter(id__in=ids):
            NotificationService._push_ws(user_id, notif)
        return len(ids)

    @staticmethod
    def mark_agent_session_terminal_read(user_id: str, session_id: str) -> int:
        """把某用户在某 Agent 会话上的未读终态通知标已读并推 WS。

        覆盖 ``agent.task.completed/error/interrupted``；不触碰
        ``agent.hitl.waiting``、其它 session 或其它用户。幂等。
        """
        uid = (user_id or '').strip()
        sid = (session_id or '').strip()
        if not uid or not sid:
            return 0
        qs = Notification.objects.filter(
            user_id=uid,
            type__in=AGENT_TASK_TERMINAL_TYPES,
            metadata__session_id=sid,
            is_read=False,
        )
        ids = list(qs.values_list('id', flat=True))
        if not ids:
            return 0
        now = timezone.now()
        Notification.objects.filter(id__in=ids).update(is_read=True, read_at=now)
        for notif in Notification.objects.filter(id__in=ids):
            NotificationService._push_ws(uid, notif)
        return len(ids)

    @staticmethod
    def mark_balance_low_read_for_organization(organization_id: str) -> int:
        """将某组织未读 ``balance_low`` 通知标已读并推 WS。

        点券余额回升到预警阈值以上后调用，避免铃铛角标仍挂「余额警示」。
        覆盖该组织下所有收件人（通常是 Owner）；幂等。
        """
        oid = (organization_id or '').strip()
        if not oid:
            return 0

        rows = list(
            Notification.objects.filter(
                organization_id=oid,
                type__in=('balance_low', 'account.balance_low'),
                is_read=False,
            ).values_list('id', 'user_id')
        )
        if not rows:
            return 0

        ids = [row[0] for row in rows]
        now = timezone.now()
        Notification.objects.filter(id__in=ids).update(is_read=True, read_at=now)
        for notif in Notification.objects.filter(id__in=ids):
            NotificationService._push_ws(str(notif.user_id), notif)
        return len(ids)

    @staticmethod
    def mark_agent_hitl_waiting_read(
        *,
        interaction_id: str = '',
        request_key: str = '',
    ) -> int:
        """把某 HITL 等待通知对所有收件人标已读并推 WS。

        优先按 ``metadata.interaction_id`` 精确匹配；仅当 interaction_id 为空时
        才回退 ``metadata.request_key``。无匹配行时 no-op（presence 抑制场景）。
        """
        iid = (interaction_id or '').strip()
        rkey = (request_key or '').strip()
        if not iid and not rkey:
            return 0

        qs = Notification.objects.filter(
            type=AGENT_HITL_WAITING_TYPE,
            is_read=False,
        )
        if iid:
            qs = qs.filter(metadata__interaction_id=iid)
        else:
            qs = qs.filter(metadata__request_key=rkey)

        rows = list(qs.values_list('id', 'user_id'))
        if not rows:
            return 0

        ids = [row[0] for row in rows]
        now = timezone.now()
        Notification.objects.filter(id__in=ids).update(is_read=True, read_at=now)
        for notif in Notification.objects.filter(id__in=ids):
            NotificationService._push_ws(str(notif.user_id), notif)
        return len(ids)

    @staticmethod
    def mark_all_read(
        user_id: str,
        organization_id: str | None = None,
        include_personal_invitations: bool = False,
        center_only: bool = False,
    ) -> int:
        qs = Notification.objects.filter(user_id=user_id, is_read=False)
        qs = _organization_inbox_queryset(qs, organization_id, include_personal_invitations)
        if center_only:
            qs = filter_notification_center_queryset(qs)
        return qs.update(is_read=True, read_at=timezone.now())

    @staticmethod
    def get_unread_count(
        user_id: str,
        organization_id: str | None = None,
        include_personal_invitations: bool = False,
        center_only: bool = False,
    ) -> int:
        qs = Notification.objects.filter(user_id=user_id, is_read=False)
        qs = _organization_inbox_queryset(qs, organization_id, include_personal_invitations)
        qs = _inbox_visible_queryset(qs)
        if center_only:
            qs = filter_notification_center_queryset(qs)
        return qs.count()

    @staticmethod
    def list_notifications(
        user_id: str,
        organization_id: Optional[str] = None,
        page: int = 1,
        limit: int = 20,
        include_personal_invitations: bool = False,
        unread_only: bool = False,
        category: str = '',
        search: str = '',
        center_only: bool = False,
    ) -> Dict[str, Any]:
        qs = Notification.objects.filter(user_id=user_id)
        qs = _organization_inbox_queryset(qs, organization_id, include_personal_invitations)
        qs = _inbox_visible_queryset(qs)
        if unread_only:
            qs = qs.filter(is_read=False)
        if center_only:
            qs = filter_notification_center_queryset(qs, category)
        elif category:
            qs = qs.filter(category=category)
        if search:
            qs = qs.filter(Q(title__icontains=search) | Q(body__icontains=search))

        total = qs.count()
        offset = (page - 1) * limit
        items = qs[offset:offset + limit]

        data = []
        for n in items:
            display_title, display_body = format_notification_copy(
                n.type,
                n.title,
                n.body,
                n.metadata,
            )
            data.append({
                'id': str(n.id),
                'type': n.type,
                'title': display_title,
                'body': display_body,
                'metadata': n.metadata,
                'organization_id': n.organization_id,
                'space_id': n.space_id or '',
                'priority': n.priority,
                'category': n.category,
                'center_category': resolve_notification_center_category(n.type, n.metadata),
                'source_extension_id': n.source_extension_id,
                'source_event_id': n.source_event_id,
                'channels_delivered': n.channels_delivered,
                'is_read': n.is_read,
                'read_at': n.read_at.isoformat() if n.read_at else None,
                'created_at': n.created_at.isoformat(),
            })

        return {'items': data, 'total': total, 'page': page, 'limit': limit}

    @staticmethod
    def _push_ws(user_id: str, notif: Notification):
        """通过 WebSocket 用户级广播推送通知（``agent.user.notification.new``）。

        投递走 :func:`apps.services.common.ws.bus.publish_to_user`：直接发到
        channel layer group ``user.{user_id}``（前端 auth.ok 时已自动 join），
        无需依赖任何 topic 订阅；``buffer_offline=True`` 让离线/断网设备
        24h 内重连仍能从用户级 inbox 补送（``USER_INBOX_TTL`` 见 ``ws/bus.py``），
        规避旧 ``notifications.{user_id}`` topic 的"伪用户级"误用——后者依赖
        客户端显式 subscribe，离线设备永久丢通知。
        """
        try:
            from apps.services.common.agent_protocol.constants import AgentUserEvent
            from apps.services.common.agent_protocol.namespace import user_event_type
            from apps.services.common.ws.bus import publish_to_user
            from apps.services.common.ws.protocol import build_envelope

            display_title, display_body = format_notification_copy(
                notif.type,
                notif.title,
                notif.body,
                notif.metadata,
            )
            envelope = build_envelope(
                user_event_type(AgentUserEvent.NOTIFICATION_NEW),
                str(notif.id),
                {
                    'id': str(notif.id),
                    'type': notif.type,
                    'title': display_title,
                    'body': display_body,
                    'metadata': notif.metadata,
                    'organization_id': notif.organization_id,
                    'space_id': notif.space_id or '',
                    'priority': notif.priority,
                    'category': notif.category,
                    'center_category': resolve_notification_center_category(
                        notif.type,
                        notif.metadata,
                    ),
                    'source_extension_id': notif.source_extension_id,
                    'source_event_id': notif.source_event_id,
                    'channels_delivered': notif.channels_delivered,
                    'is_read': notif.is_read,
                    'read_at': notif.read_at.isoformat() if notif.read_at else None,
                    'created_at': notif.created_at.isoformat(),
                },
            )
            publish_to_user(user_id, envelope)
        except Exception as e:
            logger.debug(f"WebSocket 推送通知失败（非阻断）: {e}")

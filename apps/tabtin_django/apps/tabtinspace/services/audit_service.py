"""
审计日志服务 + 活动流服务

审计日志面向管理员，记录详细操作细节、请求参数、IP 等。
活动流面向普通成员，展示友好的操作动态。
两者共享统一写入入口。
"""
import json
import logging
from typing import Optional, Dict, Any, List
from uuid import UUID

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import QuerySet

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import SpaceAdminActionLog, OrganizationActivity

logger = logging.getLogger(__name__)


def _json_safe(payload: Optional[Dict]) -> Dict:
    """Normalize UUID/date/Decimal values before writing JSONField payloads."""

    if not payload:
        return {}
    return json.loads(json.dumps(payload, cls=DjangoJSONEncoder))


class AuditService:
    """审计日志 + 活动流统一写入服务"""

    @staticmethod
    def log(
        action_type: str,
        target_type: str,
        target_id: 'UUID | str | None',
        *,
        # ── 审计核心 ──
        organization_id=None,
        space_id=None,
        operator=None,
        operator_id: str = '',
        operator_name: str = '',
        dry_run: bool = False,
        success: bool = True,
        message: str = '',
        error_message: str = '',
        request_payload: Optional[Dict] = None,
        result_payload: Optional[Dict] = None,
        # ── 请求追踪 ──
        ip_address: Optional[str] = None,
        user_agent: str = '',
        trace_id: str = '',
        # ── 活动流（填了才写） ──
        resource_name: str = '',
        activity_action: str = '',
        activity_metadata: Optional[Dict] = None,
    ) -> Optional[SpaceAdminActionLog]:
        """统一记录审计日志和活动流（best-effort，不抛异常）。

        operator: User 对象或字符串 ID。会自动提取 operator_id/operator_name。
                  也可直接传 operator_id/operator_name 字符串（如 signal 中无 User 对象时）。
        activity_action: 活动流动作（如 'created', 'joined'）。为空则不写活动流。
        """
        if operator and not operator_id:
            operator_id = str(getattr(operator, 'id', operator))
        if operator and not operator_name:
            operator_name = getattr(operator, 'get_display_name', lambda: str(operator))()

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                audit = SpaceAdminActionLog.objects.using(postgres_app_db_alias()).create(
                    action_type=action_type,
                    target_type=target_type,
                    target_id=target_id if isinstance(target_id, UUID) else UUID(str(target_id)) if target_id else UUID(int=0),
                    organization_id=UUID(str(organization_id)) if organization_id else None,
                    space_id=UUID(str(space_id)) if space_id else None,
                    operator_id=(operator_id or '')[:64],
                    operator_name=operator_name or '',
                    dry_run=dry_run,
                    success=success,
                    message=message or '',
                    error_message=error_message or '',
                    request_payload=_json_safe(request_payload),
                    result_payload=_json_safe(result_payload),
                    trace_id=(trace_id or '')[:128],
                    ip_address=ip_address,
                    user_agent=user_agent or '',
                )
        except Exception:
            logger.exception("写入审计日志失败")
            return None

        if activity_action and organization_id:
            try:
                with transaction.atomic(using=postgres_app_db_alias()):
                    OrganizationActivity.objects.using(postgres_app_db_alias()).create(
                        organization_id=UUID(str(organization_id)),
                        actor_id=operator_id,
                        actor_name=operator_name,
                        action=activity_action,
                        resource_type=target_type,
                        resource_id=str(target_id) if target_id else '',
                        resource_name=resource_name,
                        metadata=_json_safe(activity_metadata),
                    )
            except Exception as e:
                logger.warning("写入活动流失败: %s", e)

        return audit

    @staticmethod
    def query_audit_logs(
        organization_id: UUID,
        action_type: Optional[str] = None,
        target_type: Optional[str] = None,
        operator_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        page: int = 1,
        limit: int = 50,
    ) -> Dict[str, Any]:
        qs = SpaceAdminActionLog.objects.using(postgres_app_db_alias()).filter(organization_id=organization_id)

        if action_type:
            qs = qs.filter(action_type=action_type)
        if target_type:
            qs = qs.filter(target_type=target_type)
        if operator_id:
            qs = qs.filter(operator_id=operator_id)
        if date_from:
            qs = qs.filter(created_at__gte=date_from)
        if date_to:
            qs = qs.filter(created_at__lte=date_to)

        total = qs.count()
        offset = (page - 1) * limit
        logs = qs[offset:offset + limit]

        items = []
        for log in logs:
            items.append({
                'id': str(log.id),
                'action_type': log.action_type,
                'target_type': log.target_type,
                'target_id': str(log.target_id),
                'operator_id': log.operator_id,
                'operator_name': log.operator_name,
                'success': log.success,
                'message': log.message,
                'request_payload': log.request_payload,
                'result_payload': log.result_payload,
                'created_at': log.created_at.isoformat(),
            })

        return {'items': items, 'total': total, 'page': page, 'limit': limit}

    @staticmethod
    def get_activity_feed(
        organization_id: UUID,
        resource_type: Optional[str] = None,
        page: int = 1,
        limit: int = 30,
    ) -> Dict[str, Any]:
        qs = OrganizationActivity.objects.using(postgres_app_db_alias()).filter(organization_id=organization_id)

        if resource_type:
            qs = qs.filter(resource_type=resource_type)

        total = qs.count()
        offset = (page - 1) * limit
        activities = qs[offset:offset + limit]

        items = []
        for act in activities:
            items.append({
                'id': str(act.id),
                'actor_id': act.actor_id,
                'actor_name': act.actor_name,
                'action': act.action,
                'resource_type': act.resource_type,
                'resource_id': act.resource_id,
                'resource_name': act.resource_name,
                'metadata': act.metadata,
                'created_at': act.created_at.isoformat(),
            })

        return {'items': items, 'total': total, 'page': page, 'limit': limit}

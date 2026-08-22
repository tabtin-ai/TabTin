"""
Webhook 投递服务

负责：
1. 查找匹配事件的 webhook 订阅
2. 构建 payload
3. HTTP POST 投递（含 HMAC 签名、指数退避重试）
4. 更新投递统计
"""
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from django.db.models import F, Q
from django.utils import timezone as dj_timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger(__name__)


class WebhookDeliveryService:
    """Webhook 投递服务"""

    TIMEOUT = 10  # 秒
    USER_AGENT = 'TabTin-Webhook/1.0'

    @staticmethod
    def _resolve_scope(
        *,
        organization_id: Optional[str] = None,
        space_id: Optional[str] = None,
        table_id: Optional[str] = None,
    ) -> tuple[str, Optional[str]]:
        """统一解析 Webhook 订阅范围。

        Webhook 是 Organization 级云资源；space_id 只作为旧入口上下文。
        """
        if organization_id:
            return str(organization_id), str(space_id) if space_id else None

        if table_id:
            from apps.tabdata.models import Table

            table = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id=table_id)
                .only('organization_id', 'space_id')
                .first()
            )
            if table:
                return str(table.organization_id), str(table.space_id) if table.space_id else None

        if space_id:
            from apps.tabtinspace.services.host_resolver import host_organization_id

            org_id = host_organization_id(space_id)
            if org_id:
                return str(org_id), str(space_id)

        raise ValueError('organization_id 不能为空')

    @staticmethod
    def find_matching_webhooks(
        space_id: Optional[str] = None,
        event_type: Optional[str] = None,
        table_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> list:
        """查找匹配指定事件的所有活跃 webhook"""
        from apps.tabdata.models_webhook import TableWebhook

        if not event_type:
            raise ValueError('event_type 不能为空')

        resolved_organization_id, resolved_space_id = WebhookDeliveryService._resolve_scope(
            organization_id=organization_id,
            space_id=space_id,
            table_id=table_id,
        )

        qs = TableWebhook.objects.using(TABDATA_DB_ALIAS).filter(is_active=True).filter(
            Q(organization_id=resolved_organization_id)
            | Q(organization_id__isnull=True, space_id=resolved_space_id)
        )
        if resolved_space_id:
            qs = qs.filter(space_id__in=[resolved_space_id, None])

        matched = []
        for wh in qs:
            if wh.matches_event(event_type, table_id):
                matched.append(wh)

        return matched

    @classmethod
    def build_payload(
        cls,
        event_type: str,
        space_id: Optional[str] = None,
        table_id: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        organization_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """构建标准 webhook payload"""
        resolved_organization_id, resolved_space_id = cls._resolve_scope(
            organization_id=organization_id,
            space_id=space_id,
            table_id=table_id,
        )
        return {
            'event': event_type,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'organization_id': resolved_organization_id,
            'space_id': resolved_space_id,
            'table_id': table_id,
            'data': data or {},
        }

    @classmethod
    def deliver(
        cls,
        webhook_id: str,
        payload: Dict[str, Any],
    ) -> bool:
        """
        向单个 webhook 投递事件。

        包含指数退避重试。成功返回 True，全部重试失败返回 False。
        """
        from apps.tabdata.models_webhook import TableWebhook

        try:
            webhook = TableWebhook.objects.using(TABDATA_DB_ALIAS).get(id=webhook_id, is_active=True)
        except TableWebhook.DoesNotExist:
            logger.warning('Webhook %s 不存在或已禁用，跳过投递', webhook_id)
            return False

        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': cls.USER_AGENT,
            'X-TabTin-Event': payload.get('event', ''),
        }

        # HMAC 签名
        if webhook.secret:
            signature = hmac.new(
                webhook.secret.encode('utf-8'),
                body,
                hashlib.sha256,
            ).hexdigest()
            headers['X-TabTin-Signature'] = f'sha256={signature}'

        from apps.services.common.url_security import ssrf_safe_request

        max_retries = webhook.max_retries or 3
        delivered = False

        for attempt in range(max_retries + 1):
            try:
                resp = ssrf_safe_request(
                    'POST',
                    webhook.url,
                    data=body,
                    headers=headers,
                    timeout=cls.TIMEOUT,
                )
                status_code = resp.status_code

                if 200 <= status_code < 300:
                    delivered = True
                    logger.info(
                        'Webhook %s 投递成功: %s event=%s',
                        webhook.id, webhook.url, payload.get('event'),
                    )
                    break
                else:
                    logger.warning(
                        'Webhook %s 返回非成功状态: %s status=%s',
                        webhook.id, webhook.url, status_code,
                    )
            except ValueError as exc:
                logger.warning(
                    'Webhook %s SSRF 校验失败: url=%s reason=%s',
                    webhook.id, webhook.url, exc,
                )
                return False
            except Exception as exc:
                logger.warning(
                    'Webhook %s 投递异常: %s error=%s',
                    webhook.id, webhook.url, exc,
                )

            if attempt < max_retries:
                time.sleep(min(2 ** attempt, 10))

        # 更新统计
        try:
            TableWebhook.objects.using(TABDATA_DB_ALIAS).filter(id=webhook_id).update(
                total_deliveries=F('total_deliveries') + 1,
                failed_deliveries=F('failed_deliveries') + (0 if delivered else 1),
                last_triggered_at=dj_timezone.now(),
            )
        except Exception:
            pass  # 统计更新失败不影响主流程

        return delivered

    @classmethod
    def dispatch_event(
        cls,
        space_id: Optional[str] = None,
        event_type: Optional[str] = None,
        table_id: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        organization_id: Optional[str] = None,
    ) -> int:
        """
        分发事件到所有匹配的 webhook（同步方式，通常由 Celery task 调用）。

        返回成功投递的 webhook 数量。
        """
        if not event_type:
            raise ValueError('event_type 不能为空')

        resolved_organization_id, resolved_space_id = cls._resolve_scope(
            organization_id=organization_id,
            space_id=space_id,
            table_id=table_id,
        )

        webhooks = cls.find_matching_webhooks(
            organization_id=resolved_organization_id,
            space_id=resolved_space_id,
            event_type=event_type,
            table_id=table_id,
        )
        if not webhooks:
            return 0

        payload = cls.build_payload(
            event_type=event_type,
            organization_id=resolved_organization_id,
            space_id=resolved_space_id,
            table_id=table_id,
            data=data or {},
        )
        success_count = 0

        for wh in webhooks:
            if cls.deliver(str(wh.id), payload):
                success_count += 1

        return success_count

"""
计费 API 公共工具 — 装饰器、辅助函数等。
api.py 和 api_admin.py 共用，避免循环导入。
"""

from __future__ import annotations

import functools
import logging
from decimal import Decimal, InvalidOperation

from ninja.errors import HttpError

from apps.i18n import _

logger = logging.getLogger(__name__)


def safe_decimal(val) -> Decimal:
    """安全地将任意值转为 Decimal，无法转换时返回 0。"""
    if val is None:
        return Decimal("0")
    try:
        return Decimal(str(val))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def usage_event_display_credits(event_or_row) -> Decimal:
    """
    用量页展示口径：钱包扣费 + 套餐额度抵扣。

    BillingUsageEvent.amount 只代表真实钱包扣费；LLM 套餐内抵扣记录在
    metadata.quota_covered_credits。用量概览、成员排行和对账展示都应该看到
    套餐内消耗，否则免费套餐会显示"调用了模型但用量为 0"。
    """
    if isinstance(event_or_row, dict):
        amount = event_or_row.get("amount")
        metadata = event_or_row.get("metadata") or {}
    else:
        amount = getattr(event_or_row, "amount", None)
        metadata = getattr(event_or_row, "metadata", None) or {}

    total = safe_decimal(amount)
    if isinstance(metadata, dict):
        total += safe_decimal(metadata.get("quota_covered_credits"))
    return total


def billing_api_errors(func):
    """统一处理 billing API 端点的异常，避免内部信息泄露。"""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except HttpError:
            raise
        except Exception as e:
            logger.error(f"[Billing] {func.__name__} failed: {e}", exc_info=True)
            raise HttpError(500, _("billing.internal_error")) from e
    return wrapper


def record_billing_audit(request, *, action: str, target_type: str, target_id: str,
                         detail: dict | None = None, organization_id: str = ""):
    """记录 Billing Admin 审计日志。"""
    try:
        from .models import BillingAdminAuditLog

        admin_user_id = str(getattr(request.auth, "id", "")) if request.auth else ""
        ip_address = _get_client_ip(request)

        BillingAdminAuditLog.objects.create(
            admin_user_id=admin_user_id,
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            organization_id=organization_id or "",
            detail=detail or {},
            ip_address=ip_address,
        )
    except Exception as exc:
        logger.warning("[BillingAudit] 审计日志写入失败: %s", exc)


def _get_client_ip(request) -> str:
    from apps.users.auth.utils import get_client_ip
    return get_client_ip(request) or ""


def apply_ordering(qs, order_by: str | None, allowed_fields: frozenset[str], default: str = "-updated_at"):
    """安全排序：仅允许白名单字段，前缀 '-' 降序。"""
    if not order_by:
        return qs.order_by(default)

    desc = order_by.startswith("-")
    field = order_by.lstrip("-")
    if field not in allowed_fields:
        return qs.order_by(default)

    return qs.order_by(f"-{field}" if desc else field)

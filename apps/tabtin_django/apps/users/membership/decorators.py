"""
会员配额与功能装饰器

兼容 Django-Ninja 路由：使用 HttpError 抛出异常而非返回 dict，
让 Ninja 的异常处理器自动生成正确的 HTTP 响应。
"""

import logging
from functools import wraps
from typing import Callable, Optional

from ninja.errors import HttpError

from apps.i18n import _
from .exceptions import (
    MembershipException,
    MembershipExpiredError,
    QuotaExceededError,
    FeatureNotAvailableError,
)
from .services.quota_service import QuotaService

logger = logging.getLogger(__name__)


def _extract_organization_id(request, kwargs: dict) -> Optional[str]:
    """从路由 kwargs 或 request 上下文中提取 organization_id，实现 organization-first 配额策略。"""
    wt_id = kwargs.get("organization_id")
    if wt_id:
        return str(wt_id)
    if hasattr(request, "organization_id") and request.organization_id:
        return str(request.organization_id)
    return None


def require_membership_quota(
    quota_type: str,
    increment: int = 1,
    usage_resolver: Optional[Callable[[object, tuple, dict], int]] = None,
):
    """
    检查会员配额的装饰器。

    Args:
        quota_type: 配额字段名（如 max_tables / max_records_per_table）
        increment: 本次操作需要占用的额度，默认1
        usage_resolver: 可选，提供当前占用量的回调函数，签名为 (request, args, kwargs) -> int

    注意:
        - max_api_calls_per_day / max_crawl_tasks_per_day 为 Legacy 死配额 (D5)，勿使用。
        - 对 max_records_per_table，调用方必须通过 usage_resolver 传入当前记录数，
          否则 QuotaService 无法自动推断 table_id。(QTA-19)
        - bulk_create 等批量路径可能绕过此装饰器，需在 Service 层独立调用
          check_quota。(QTA-20: table create_table 的 5 条默认空行也走 bulk_create)
    """

    def decorator(func):
        @wraps(func)
        def wrapper(request, *args, **kwargs):
            user = getattr(request, "auth", None)
            if not user:
                raise HttpError(401, _("auth.unauthenticated"))

            organization_id = _extract_organization_id(request, kwargs)

            current_usage = None
            if usage_resolver:
                try:
                    current_usage = usage_resolver(request, args, kwargs)
                except Exception as e:
                    logger.warning(f"usage_resolver 计算失败，使用默认值: {e}")

            try:
                QuotaService().check_quota(
                    quota_type=quota_type,
                    increment=increment,
                    current_usage=current_usage,
                    organization_id=organization_id,
                    actor=user,
                )
            except MembershipExpiredError as e:
                raise HttpError(403, str(e))
            except QuotaExceededError as e:
                raise HttpError(403, str(e))
            except MembershipException as e:
                raise HttpError(400, str(e))

            return func(request, *args, **kwargs)

        return wrapper

    return decorator


def require_membership_feature(feature_key: str):
    """
    检查会员功能开关的装饰器。
    """

    def decorator(func):
        @wraps(func)
        def wrapper(request, *args, **kwargs):
            user = getattr(request, "auth", None)
            if not user:
                raise HttpError(401, _("auth.unauthenticated"))

            organization_id = _extract_organization_id(request, kwargs)

            try:
                QuotaService().check_feature(
                    feature_key=feature_key,
                    organization_id=organization_id,
                )
            except FeatureNotAvailableError as e:
                raise HttpError(403, str(e))
            except MembershipExpiredError as e:
                raise HttpError(403, str(e))
            except MembershipException as e:
                raise HttpError(400, str(e))

            return func(request, *args, **kwargs)

        return wrapper

    return decorator

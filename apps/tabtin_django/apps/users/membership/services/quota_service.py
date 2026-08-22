"""
会员配额服务
"""

import json
import logging
from datetime import date, datetime, timezone as dt_timezone
from typing import Dict, Any, Optional, Tuple, Callable
from django.db import transaction
from django.utils import timezone
from dateutil.relativedelta import relativedelta

from ..models import MembershipTier, OrganizationMembership
from ..exceptions import (
    MembershipException,
    QuotaExceededError,
    FeatureNotAvailableError,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 三级降级配置：DB → Redis 缓存 → fail-open
# ---------------------------------------------------------------------------

_FAIL_CLOSE_QUOTA_TYPES = frozenset({
    "max_tables",
    "max_documents",
    "max_groups",
    "max_records_per_table",
    "max_members",
    "max_conversations_per_day",
})

_QUOTA_TYPE_USER_LABELS: Dict[str, str] = {
    "max_tables": "可创建表格数量",
    "max_documents": "可创建文档数量",
    "max_groups": "可创建群组数量",
    "max_records_per_table": "单表可创建记录数量",
    "max_members": "可邀请成员数量",
    "max_conversations_per_day": "每日可发起对话数量",
}

_TIER_CACHE_KEY_PREFIX = "quota:tier"
_TIER_CACHE_TTL = 300  # 5 分钟，覆盖绝大多数 DB 短暂波动

_ADDON_QUOTA_TYPES = frozenset({
    "max_tables",
    "max_documents",
    "max_groups",
    "max_members",
})

# ---------------------------------------------------------------------------
# QTA-24: 每日对话次数 Redis 计数器
# ---------------------------------------------------------------------------

_DAILY_CONV_KEY_PREFIX = "chat:daily_count"
_DAILY_CONV_TTL = 86400 + 3600  # 25h，覆盖时区偏差和 TTL 漂移


def _daily_conv_redis_key(organization_id: str, today: date) -> str:
    return f"{_DAILY_CONV_KEY_PREFIX}:{organization_id}:{today.isoformat()}"


def get_daily_conversation_count(organization_id: str) -> int:
    """获取 organization 当日（UTC）对话计数。优先 Redis，fallback DB。"""
    today = datetime.now(dt_timezone.utc).date()
    count = _get_daily_conv_count_from_redis(organization_id, today)
    if count is not None:
        return count
    return _get_daily_conv_count_from_db(organization_id, today)


def increment_daily_conversation_count(organization_id: str) -> int:
    """原子递增 organization 当日对话计数（Redis INCR）。
    返回递增后的值。Redis 不可用时静默跳过。
    """
    today = datetime.now(dt_timezone.utc).date()
    key = _daily_conv_redis_key(organization_id, today)
    try:
        from django.core.cache import cache
        backend = getattr(cache, 'client', None)
        redis_client = getattr(backend, 'get_client', lambda: None)()
        if redis_client is not None:
            val = redis_client.incr(key)
            redis_client.expire(key, _DAILY_CONV_TTL)
            return val
    except Exception as exc:
        logger.warning("[QTA-24] Redis INCR failed, skipping: %s", exc)
    return 0


_DECR_FLOOR_SCRIPT = """
local v = redis.call('DECR', KEYS[1])
if v < 0 then
    redis.call('SET', KEYS[1], 0)
    return 0
end
return v
"""


def decrement_daily_conversation_count(organization_id: str) -> int:
    """原子递减 organization 当日对话计数（Lua 脚本保证 DECR + floor 原子性），最低归零。
    用于 Agent 执行失败时回退配额，避免用户对话次数被白白消耗。
    返回递减后的值。Redis 不可用时静默跳过。
    """
    today = datetime.now(dt_timezone.utc).date()
    key = _daily_conv_redis_key(organization_id, today)
    try:
        from django.core.cache import cache
        backend = getattr(cache, 'client', None)
        redis_client = getattr(backend, 'get_client', lambda: None)()
        if redis_client is not None:
            val = redis_client.eval(_DECR_FLOOR_SCRIPT, 1, key)
            return int(val)
    except Exception as exc:
        logger.warning("[QTA-24] Redis DECR failed, skipping: %s", exc)
    return 0


def _get_daily_conv_count_from_redis(organization_id: str, today: date) -> Optional[int]:
    """尝试从 Redis 读取当日计数，不可用时返回 None。"""
    try:
        from django.core.cache import cache
        backend = getattr(cache, 'client', None)
        redis_client = getattr(backend, 'get_client', lambda: None)()
        if redis_client is not None:
            key = _daily_conv_redis_key(organization_id, today)
            val = redis_client.get(key)
            if val is not None:
                return int(val)
            return 0
    except Exception as exc:
        logger.warning("[QTA-24] Redis GET failed, fallback to DB: %s", exc)
    return None


def _get_daily_conv_count_from_db(organization_id: str, today: date) -> int:
    """从 BillingUsageEvent 查询当日 LLM 调用次数（fallback）。"""
    try:
        from apps.services.billing.models import BillingUsageEvent
        from django.utils import timezone as tz
        day_start = tz.make_aware(datetime.combine(today, datetime.min.time()))
        return BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            meter_key__startswith="llm:",
            occurred_at__gte=day_start,
        ).count()
    except Exception as exc:
        logger.warning("[QTA-24] DB count query failed, returning 0: %s", exc)
        return 0


# ---------------------------------------------------------------------------
# Tier 缓存辅助（三级降级的第二级）
# ---------------------------------------------------------------------------

_TIER_CACHE_QUOTA_FIELDS = (
    "max_tables",
    "max_documents",
    "max_groups",
    "max_records_per_table",
    "max_members",
    "max_conversations_per_day",
)


def _tier_cache_key(organization_id: str) -> str:
    return f"{_TIER_CACHE_KEY_PREFIX}:{organization_id}"


def _cache_tier_quotas(organization_id: str, tier) -> None:
    """DB 查询成功后将 tier 配额写入 Redis。不影响主流程。"""
    try:
        from django.core.cache import cache

        data = {f: getattr(tier, f, None) for f in _TIER_CACHE_QUOTA_FIELDS}
        data["tier_name"] = getattr(tier, "name", "")
        data["tier_type"] = getattr(tier, "tier_type", "")
        cache.set(_tier_cache_key(organization_id), json.dumps(data), _TIER_CACHE_TTL)
    except Exception as exc:
        logger.debug("tier cache write failed (non-critical): ws=%s err=%s", organization_id, exc)


def _get_cached_tier(organization_id: str) -> Optional[Dict[str, Any]]:
    """尝试从 Redis 读取缓存的 tier 配额数据，不可用时返回 None。"""
    try:
        from django.core.cache import cache

        raw = cache.get(_tier_cache_key(organization_id))
        if raw:
            return json.loads(raw)
    except Exception as exc:
        logger.debug("tier cache read failed: ws=%s err=%s", organization_id, exc)
    return None


def _quota_type_user_label(quota_type: str) -> str:
    return _QUOTA_TYPE_USER_LABELS.get(quota_type, "资源")


def _quota_exceeded_message(
    quota_type: str,
    current: int,
    limit: int,
    *,
    cached: bool = False,
) -> str:
    """构造面向用户的配额错误文案，明确资源所属范围。"""
    suffix = " (cached)" if cached else ""
    label = _quota_type_user_label(quota_type)
    return f"组织{label}已达上限：已用 {current} / 上限 {limit}{suffix}"


def _get_addon_quota(organization_id: Optional[str], quota_type: str) -> int:
    if not organization_id or quota_type not in _ADDON_QUOTA_TYPES:
        return 0
    try:
        from apps.services.billing.services.addon_entitlement_service import AddonEntitlementService

        return AddonEntitlementService.get_addon_quota(organization_id, quota_type)
    except Exception as exc:
        logger.warning(
            "addon quota lookup failed, ignoring addon allowance: ws=%s type=%s err=%s",
            organization_id,
            quota_type,
            exc,
        )
        return 0


def _check_with_cached_tier(
    cached_tier: Dict[str, Any],
    quota_type: str,
    current_usage: Optional[int],
    increment: int,
    organization_id: str,
    actor=None,
) -> bool:
    """使用缓存的 tier 数据做 fail-close 配额检查。

    超限时仍然抛 QuotaExceededError，与正常路径行为一致。
    """
    limit = cached_tier.get(quota_type)
    if limit is None:
        logger.warning(
            "cached tier missing quota field %s, fail-open: ws=%s", quota_type, organization_id,
        )
        return True

    if limit == -1:
        return True
    addon_limit = _get_addon_quota(organization_id, quota_type)
    limit = int(limit or 0) + addon_limit

    current = current_usage
    if current is None:
        try:
            current = QuotaService()._get_current_usage(quota_type, organization_id=organization_id)
        except Exception:
            current = 0

    remaining = limit - current
    if remaining < increment:
        raise QuotaExceededError(
            message=_quota_exceeded_message(quota_type, current, limit, cached=True),
            quota_type=quota_type,
            limit=limit,
            current=current,
        )
    return True

def check_quota_safe(
    quota_type: str,
    increment: int = 1,
    organization_id: Optional[str] = None,
    current_usage: Optional[int] = None,
    actor=None,
) -> bool:
    """配额预检包装：QuotaExceededError 重新抛出，其他异常 warning 放行（D1 策略）。

    Returns:
        True 表示通过（或异常放行），False 不会出现——超限时直接 raise。
    """
    try:
        QuotaService().check_quota(
            quota_type=quota_type,
            increment=increment,
            current_usage=current_usage,
            organization_id=organization_id,
            actor=actor,
        )
        return True
    except QuotaExceededError:
        raise
    except Exception as e:
        if quota_type in _FAIL_CLOSE_QUOTA_TYPES and organization_id:
            cached_tier = _get_cached_tier(organization_id)
            if cached_tier:
                logger.warning(
                    "quota check DB failed, using cached tier: ws=%s type=%s",
                    organization_id, quota_type,
                )
                return _check_with_cached_tier(
                    cached_tier, quota_type, current_usage, increment,
                    organization_id, actor=actor,
                )
            logger.error(
                "quota check DEGRADED fail-open: DB+cache both unavailable: "
                "ws=%s type=%s err=%s",
                organization_id, quota_type, e,
            )
            return True
        logger.warning("配额预检异常，D1 放行: quota_type=%s error=%s", quota_type, e)
        return True


class QuotaService:
    """
    会员配额与功能检查服务

    organization-only 策略 —— 通过 organization_id 获取 OrganizationMembership 的 tier，
    无 organization 或会员过期时回退到 free tier。用户级 UserMembership 已废弃。

    已知缺失配额 (待后续 Wave 补齐):
        - QTA-15: max_organizations — 组织创建无上限
        - TabSlide 创建无数量上限
        - QTA-24: Agent 对话无次数配额（当前仅靠余额/预算预检）
        - QTA-25: Open API 导出 (CSV/Excel/JSON/PDF) 无次数配额
    """

    def get_effective_tier(
        self,
        organization_id: Optional[str] = None,
    ) -> Tuple[Optional[MembershipTier], str]:
        """
        获取有效会员等级（organization-only）。

        所有权益通过 Organization 承载，不再有用户级会员 fallback。

        优先级：
        1. OrganizationMembership (organization_id) → active & 未过期
        2. free tier

        Returns:
            (tier, source)  source: 'organization' | 'free'
        """
        if organization_id:
            try:
                wt_membership = (
                    OrganizationMembership.objects
                    .select_related('tier')
                    .get(organization_id=organization_id)
                )
                if wt_membership.status == 'active':
                    if not wt_membership.is_expired():
                        _cache_tier_quotas(organization_id, wt_membership.tier)
                        return wt_membership.tier, 'organization'
                    wt_membership.check_and_update_status()
            except OrganizationMembership.DoesNotExist:
                pass

        free_tier = self._get_free_tier()
        if free_tier and organization_id:
            _cache_tier_quotas(organization_id, free_tier)
        return free_tier, 'free'

    def _get_free_tier(self) -> Optional[MembershipTier]:
        """获取免费等级，找不到则返回 None"""
        try:
            return MembershipTier.objects.filter(tier_type="free").first()
        except Exception as e:
            logger.error("[QuotaService] 获取免费等级失败: %s", e)
            return None

    def check_quota(
        self,
        quota_type: str,
        increment: int = 1,
        current_usage: Optional[int] = None,
        organization_id: Optional[str] = None,
        actor=None,
    ) -> Dict[str, Any]:
        """
        检查配额是否足够，不足时抛出 QuotaExceededError。

        P2: organization-first — 优先使用 organization_id 获取 tier。

        Args:
            quota_type: 配额字段名
            increment: 本次操作占用量
            current_usage: 当前已用量（可选，未传则尝试自动计算/默认0）
            organization_id: 组织ID（优先）
            actor: 触发本次检查的用户实例，仅用于日志
        """
        tier, source = self.get_effective_tier(organization_id=organization_id)

        if tier is None:
            raise MembershipException("未找到可用的会员等级")

        limit = getattr(tier, quota_type, None)
        if limit is None:
            raise MembershipException(f"未定义的配额类型: {quota_type}")

        # -1 表示无限制
        if limit == -1:
            return {"allowed": True, "limit": -1, "current": 0, "remaining": -1, "source": source, "addon_limit": 0}

        addon_limit = _get_addon_quota(organization_id, quota_type)
        limit = int(limit or 0) + addon_limit

        current = current_usage
        if current is None:
            current = self._get_current_usage(quota_type, organization_id=organization_id)

        remaining = limit - current
        if remaining < increment:
            logger.warning(
                "[QuotaService] 配额超限拒绝: quota_type=%s actor=%s organization=%s "
                "current=%s limit=%s increment=%s tier=%s source=%s",
                quota_type,
                getattr(actor, "id", None) if actor is not None else None,
                organization_id,
                current,
                limit,
                increment,
                getattr(tier, "name", None),
                source,
            )
            raise QuotaExceededError(
                message=_quota_exceeded_message(quota_type, current, limit),
                quota_type=quota_type,
                limit=limit,
                current=current,
            )

        return {
            "allowed": True,
            "limit": limit,
            "current": current,
            "remaining": remaining,
            "source": source,
            "addon_limit": addon_limit,
        }

    def _get_current_usage(self, quota_type: str, organization_id: Optional[str] = None) -> int:
        """
        针对部分配额尝试自动获取当前占用量。
        P2: 优先使用 organization 级数据。
        默认返回0，未覆盖场景可在装饰器传入 current_usage。
        """
        try:
            if quota_type == "max_tables":
                from apps.tabdata.models import Table

                active_filter = dict(is_archived=False, trashed_at__isnull=True)
                if organization_id:
                    return Table.objects.filter(organization_id=organization_id, **active_filter).count()
                return 0

            if quota_type == "max_documents":
                from apps.tabdoc.models import Document

                if organization_id:
                    return Document.objects.filter(
                        organization_id=organization_id,
                        status__in=("active", "archived"),
                        trashed_at__isnull=True,
                    ).count()
                return 0

            if quota_type == "max_groups":
                from apps.tabchat.constants import ConversationType
                from apps.tabchat.models import Conversation

                # 与 list_conversations / 表格配额一致：已归档群组不再占用额度，
                # 否则设置页「已用群组数」会高于用户可见的活跃群组数组长度。
                if organization_id:
                    return Conversation.objects.filter(
                        organization_id=organization_id,
                        type=ConversationType.GROUP,
                        is_archived=False,
                    ).count()
                return 0

            if quota_type == "max_members":
                from apps.tabtinspace.models import OrganizationMember

                if organization_id:
                    return OrganizationMember.objects.filter(organization_id=organization_id).count()
                return 0

            if quota_type == "max_crawl_tasks_per_day":
                # Legacy, not enforced (D5/QTA-13) — ExtractionTask 模型已移除，
                # 始终返回 0，check_quota 永远通过。勿新增引用。
                return 0

            if quota_type == "max_api_calls_per_day":
                # Legacy, not enforced (D5/QTA-12) — 全局无调用点执行此配额，
                # 实际限流由 ApiToken.rate_limit (Redis 滑动窗口, 次/分钟) 控制。
                # 勿新增引用。
                return 0

            if quota_type == "max_conversations_per_day":
                if organization_id:
                    return get_daily_conversation_count(organization_id)
                return 0

            if quota_type == "max_records_per_table":
                # QTA-19: 补充自动用量计算，需要调用方传入 table_id 作为 organization_id 的补充。
                # 当前无法自动推断 table_id，调用方应显式传入 current_usage。
                # 若调用方未传入，返回 0 — 宁可漏限不误阻 (D1)。
                return 0

        except Exception as e:
            logger.warning("[QuotaService] 自动获取配额使用量失败: quota_type=%s err=%s", quota_type, e)
            if quota_type in _FAIL_CLOSE_QUOTA_TYPES and organization_id:
                raise

        return 0

    def check_feature(
        self,
        feature_key: str = '',
        organization_id: Optional[str] = None,
    ) -> bool:
        """
        检查功能开关是否可用。
        P2: organization-first — 优先通过 organization_id 获取 tier 检查 features。
        """
        tier, source = self.get_effective_tier(organization_id=organization_id)

        if tier is None:
            logger.error(
                "check_feature: tier 解析为 None（不应发生），feature_key=%s, source=%s",
                feature_key, source,
            )
            raise FeatureNotAvailableError(
                f"功能不可用: {feature_key}", feature_name=feature_key,
            )

        features = tier.features or {}
        available = bool(features.get(feature_key, False))
        if not available:
            raise FeatureNotAvailableError(
                f"功能不可用，需要更高等级会员: {feature_key}",
                feature_name=feature_key,
            )
        return True

    def get_usage_stats(
        self,
        organization_id: Optional[str] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """
        获取常用配额的占用情况。
        P2: organization-first。
        """
        tier, source = self.get_effective_tier(organization_id=organization_id)
        if tier is None:
            return {}

        return {
            "max_tables": {
                "limit": tier.max_tables,
                "current": self._safe_get(lambda: self._get_current_usage("max_tables", organization_id=organization_id)),
            },
            "max_documents": {
                "limit": tier.max_documents,
                "current": self._safe_get(lambda: self._get_current_usage("max_documents", organization_id=organization_id)),
            },
            "max_groups": {
                "limit": tier.max_groups,
                "current": self._safe_get(lambda: self._get_current_usage("max_groups", organization_id=organization_id)),
            },
            "max_records_per_table": {
                "limit": tier.max_records_per_table,
                "current": None,  # 需要 table_id 才能计算，由调用方按需填充
            },
            "max_members": {
                "limit": tier.max_members,
                "current": None,  # 需跨模块查 tabtinspace，由调用方按需填充
            },
            "max_conversations_per_day": {
                "limit": tier.max_conversations_per_day,
                "current": self._safe_get(lambda: self._get_current_usage("max_conversations_per_day", organization_id=organization_id)),
            },
            # Legacy, not enforced — max_api_calls_per_day / max_crawl_tasks_per_day
            # 已从此返回值中移除 (D5/QTA-12/QTA-13)
            "source": source,
        }

    def _safe_get(self, fn: Callable[[], int]) -> int:
        try:
            return int(fn())
        except Exception:
            return 0

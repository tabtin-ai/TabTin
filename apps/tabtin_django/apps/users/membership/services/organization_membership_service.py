"""
组织会员服务

处理 organization 级别的会员相关业务逻辑，取代用户级 MembershipService 成为计费主体。
"""

import logging
from datetime import timedelta
from typing import Optional, Dict, Any
from decimal import Decimal
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from dateutil.relativedelta import relativedelta

from ..models import MembershipTier, OrganizationMembership
from ..exceptions import (
    MembershipException,
    MembershipTierException,
)
from .membership_state_resolver import MembershipStateResolver

logger = logging.getLogger(__name__)


def _clear_guard_cache_safe(organization_id: str) -> None:
    """事务提交后安全清除 Guard 缓存（供 on_commit 回调使用）。"""
    try:
        from apps.services.billing.services.guard_service import BillingGuardService
        BillingGuardService.clear_guard_cache(organization_id)
    except Exception as exc:
        logger.warning(
            "activate_membership 后清除 Guard 缓存失败（不影响主流程）: organization=%s, error=%s",
            organization_id, exc,
        )


class OrganizationMembershipService:
    """
    组织会员服务

    职责：
    1. 组织会员开通/续费
    2. 自动同步 OrganizationBillingEntitlement
    3. 会员状态查询
    4. 自动续费开关
    """

    @transaction.atomic
    def activate_membership(
        self,
        organization_id: str,
        tier_id: str,
        order_id: str = '',
        is_renewal: bool = False,
        purchased_by: str = '',
        actual_paid_period_price=None,
    ) -> OrganizationMembership:
        """
        为组织开通/续费会员

        Args:
            organization_id: 组织ID
            tier_id: 会员等级ID
            order_id: 订单ID（可选）
            is_renewal: 是否续费
            purchased_by: 购买者用户ID

        Returns:
            组织会员信息
        """
        try:
            tier = MembershipTier.objects.get(id=tier_id, is_active=True)

            wt_membership, created = OrganizationMembership.objects.select_for_update().select_related('tier').get_or_create(
                organization_id=organization_id,
                defaults={
                    'tier': tier,
                    'start_date': timezone.now(),
                    'end_date': self._calculate_end_date(tier),
                    'status': 'active',
                    'purchased_by': purchased_by,
                    'current_actual_paid_period_price': actual_paid_period_price,
                }
            )

            if not created:
                if is_renewal:
                    wt_membership = self._renew_membership(wt_membership, tier)
                else:
                    wt_membership = self._upgrade_membership(wt_membership, tier)

                # MEM-31: 合并 purchased_by + order_id 的额外写库到一次 save，
                # 原来最多 save 3 次（_renew/_upgrade + purchased_by + order_id），
                # 现在在 _renew/_upgrade 已 save 后只再做最多 1 次补充字段更新。
                extra_fields = []
                if purchased_by:
                    wt_membership.purchased_by = purchased_by
                    extra_fields.append('purchased_by')
                if order_id:
                    wt_membership.related_order_id = order_id
                    extra_fields.append('related_order_id')
                if actual_paid_period_price is not None:
                    wt_membership.current_actual_paid_period_price = actual_paid_period_price
                    extra_fields.append('current_actual_paid_period_price')
                if extra_fields:
                    extra_fields.append('updated_at')
                    wt_membership.save(update_fields=extra_fields)
            else:
                # 新建记录：purchased_by 已在 defaults 中写入，仅需处理 order_id
                if order_id:
                    wt_membership.related_order_id = order_id
                    wt_membership.save(update_fields=['related_order_id', 'updated_at'])

            # 自动同步 entitlement
            self._sync_entitlement(organization_id, tier, end_date=wt_membership.end_date)

            logger.info(
                f"组织会员开通成功: organization={organization_id}, "
                f"tier={tier.name}, created={created}, purchased_by={purchased_by}"
            )

            try:
                from django.db import transaction as _tx
                _wt_id = organization_id
                _tier_name = tier.name
                _tier_type = tier.tier_type
                _end_date = wt_membership.end_date.isoformat() if wt_membership.end_date else None
                _is_renewal = is_renewal
                _is_new = created

                def _publish_membership_activated():
                    try:
                        from apps.services.billing.ws_events import publish_billing_event
                        publish_billing_event(_wt_id, "membership_activated", {
                            "tier_name": _tier_name,
                            "tier_type": _tier_type,
                            "end_date": _end_date,
                            "is_renewal": _is_renewal,
                            "is_new": _is_new,
                        })
                    except Exception as exc:
                        logger.warning(
                            "membership_activated WS 推送失败（不影响主流程）: organization=%s, error=%s",
                            _wt_id, exc,
                        )

                _tx.on_commit(_publish_membership_activated)
                _tx.on_commit(lambda: _clear_guard_cache_safe(_wt_id))
            except Exception as exc:
                logger.warning(
                    "activate_membership 注册 on_commit 失败: organization=%s, error=%s",
                    organization_id, exc,
                )

            return wt_membership

        except MembershipTier.DoesNotExist:
            raise MembershipTierException(f"会员等级不存在或已禁用: {tier_id}")
        except Exception as e:
            logger.error(f"组织会员开通失败: {str(e)}")
            raise MembershipException(f"组织会员开通失败: {str(e)}")

    def _calculate_end_date(self, tier: MembershipTier):
        """计算会员过期时间"""
        return timezone.now() + relativedelta(months=tier.duration_months)

    def _renew_membership(
        self, wt_membership: OrganizationMembership, tier: MembershipTier
    ) -> OrganizationMembership:
        """续费会员"""
        if wt_membership.end_date is not None and wt_membership.end_date < timezone.now():
            start_time = timezone.now()
        else:
            start_time = wt_membership.end_date or timezone.now()

        new_end_date = start_time + relativedelta(months=tier.duration_months)

        wt_membership.tier = tier
        wt_membership.end_date = new_end_date
        wt_membership.status = 'active'
        wt_membership.save(update_fields=['tier', 'start_date', 'end_date', 'status', 'updated_at'])

        logger.info(
            f"组织会员续费成功: organization={wt_membership.organization_id}, "
            f"new_end_date={new_end_date}"
        )
        return wt_membership

    def _upgrade_membership(
        self, wt_membership: OrganizationMembership, new_tier: MembershipTier
    ) -> OrganizationMembership:
        """升级或降级会员（基于 tier_level 判断，独立于展示排序 sort_order）。
        - 升级（new_tier.tier_level > 当前 tier_level）：保留旧剩余时间叠加到新等级时长。
        - 降级（new_tier.tier_level <= 当前 tier_level）：直接以当前时间起算，不叠加旧剩余时间。
        """
        now = timezone.now()
        old_end_date = wt_membership.end_date
        if wt_membership.tier_id is None:
            logger.warning(
                "组织会员缺失 tier 关联，视为同级切换: organization=%s",
                wt_membership.organization_id,
            )
            old_level = new_tier.tier_level
        else:
            old_level = wt_membership.tier.tier_level
        is_true_upgrade = new_tier.tier_level > old_level
        is_free_membership = bool(wt_membership.tier and getattr(wt_membership.tier, 'price', 0) == 0)

        # 免费版没有真实计费周期；首次购买付费套餐应从支付成功时间开启完整周期，
        # 不能沿用免费版为兼容字段保留的 end_date。
        if is_free_membership:
            wt_membership.start_date = now
            wt_membership.end_date = self._calculate_end_date(new_tier)
        elif is_true_upgrade and old_end_date is not None and old_end_date > now:
            remaining = old_end_date - now
            wt_membership.end_date = now + remaining + relativedelta(months=new_tier.duration_months)
        else:
            wt_membership.end_date = self._calculate_end_date(new_tier)

        wt_membership.tier = new_tier
        wt_membership.status = 'active'
        wt_membership.save(update_fields=['tier', 'start_date', 'end_date', 'status', 'updated_at'])

        action = "升级" if is_true_upgrade else "降级"
        logger.info(
            f"组织会员{action}成功: organization={wt_membership.organization_id}, "
            f"new_tier={new_tier.name}, new_end_date={wt_membership.end_date}"
        )
        return wt_membership

    def _sync_entitlement(self, organization_id: str, tier: MembershipTier, *, end_date=None):
        """自动同步 OrganizationBillingEntitlement。

        当会员激活/续费/升级时调用，将 tier 的 entitlement 值写入 organization billing。
        首次失败会立即重试，仍失败时按调用上下文决定策略 (NEW-1)：
        - 事务内调用（activate_membership 路径）：通过 on_commit 注册补偿任务，不抛异常
        - 非事务调用（retry_sync_entitlement 路径）：向调用方抛出异常，由 self.retry() 接管

        MEM-27 可观测性注意：
            同步失败时会触发 retry_sync_entitlement 补偿任务，任务中携带当时的 tier_id。
            若激活失败后用户快速升级到更高 tier，补偿任务会检测到 tier 已变更
            （wt_membership.tier_id != task_tier_id）并提前退出（返回 tier_mismatch），
            不会以旧 tier 覆写当前权益——这是正确行为。
            但 BillingAnomalyAlert 中的 metadata 仍记录的是触发时的旧 tier_id，
            运维排查时需结合 OrganizationMembership 的当前 tier 综合判断。
        """
        from django.db import connection

        last_exc = None
        for attempt in range(2):
            try:
                from apps.services.billing.models import OrganizationBillingPolicy
                from apps.services.billing.services import OrganizationEntitlementSyncService
                from apps.services.billing.services.policy_service import OrganizationBillingPolicyService

                OrganizationEntitlementSyncService.sync_organization_entitlement(
                    organization_id=organization_id,
                    metadata_updates={
                        "restored_at": timezone.now().isoformat(),
                        "restored_tier": tier.tier_type,
                    },
                )

                # 计费模式默认值以 OrganizationBillingPolicyService 常量为准（当前
                # llm=quota_only），不要写死——否则 migration 0037 把默认切到
                # quota_only 后，新建组织仍会被这里的硬编码盖回旧的 quota_then_paygo。
                OrganizationBillingPolicy.objects.get_or_create(
                    organization_id=organization_id,
                    defaults={
                        'storage_billing_mode': OrganizationBillingPolicyService.DEFAULT_STORAGE_BILLING_MODE,
                        'llm_billing_mode': OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE,
                        'is_active': True,
                    },
                )

                # 会员购买/开通路径也必须同步当月 AI 预算；此前这里只更新
                # OrganizationBillingEntitlement，导致套餐名称已变更但月度额度仍保留旧值。
                from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
                budget = OrganizationLlmBudgetService.get_or_create_monthly_budget_locked(
                    organization_id,
                    at_time=timezone.now(),
                )
                expected_credits = Decimal(str(tier.included_llm_credits_monthly or 0))
                if budget.included_credits != expected_credits:
                    budget.included_credits = expected_credits
                    budget.updated_from_entitlement_at = timezone.now()
                    budget.save(update_fields=[
                        "included_credits",
                        "updated_from_entitlement_at",
                        "updated_at",
                    ])

                logger.info("组织 entitlement 同步成功: organization=%s", organization_id)
                return
            except Exception as e:
                last_exc = e
                if attempt == 0:
                    logger.warning(
                        "组织 entitlement 同步失败（将重试）: organization=%s, error=%s",
                        organization_id, e,
                    )

        logger.error(
            "组织 entitlement 同步最终失败: organization=%s, error=%s",
            organization_id, last_exc,
        )

        try:
            from apps.services.billing.models import BillingAnomalyAlert
            BillingAnomalyAlert.objects.create(
                alert_type="pattern",
                severity="critical",
                organization_id=organization_id,
                metric_name="entitlement_sync_failure",
                current_value=Decimal("1"),
                message=(
                    f"entitlement 同步失败: {last_exc}"
                    f" (source=_sync_entitlement, tier_id={tier.id})"
                ),
            )
        except Exception as alert_exc:
            logger.error(
                "告警创建失败: organization=%s, error=%s",
                organization_id, alert_exc,
            )

        if connection.in_atomic_block:
            # activate_membership 路径：注册 on_commit 补偿任务，不抛异常以避免回滚主事务
            try:
                from apps.users.membership.tasks import retry_sync_entitlement
                _wt_id = organization_id
                _tier_id = str(tier.id)
                transaction.on_commit(
                    lambda: retry_sync_entitlement.delay(_wt_id, _tier_id)
                )
            except Exception as task_exc:
                logger.error(
                    "补偿任务发送失败: organization=%s, error=%s",
                    organization_id, task_exc,
                )
        else:
            # retry_sync_entitlement 路径：抛出异常让 Celery self.retry() 接管 (NEW-1)
            raise last_exc

    def check_membership_status(self, organization_id: str) -> Dict[str, Any]:
        """
        检查组织会员状态

        Args:
            organization_id: 组织ID

        Returns:
            会员状态信息
        """
        try:
            wt_membership = (
                OrganizationMembership.objects
                .select_related('tier')
                .get(organization_id=organization_id)
            )

            resolved_now = timezone.now()
            resolved_state = MembershipStateResolver.resolve(
                wt_membership,
                now=resolved_now,
            )
            is_expired = resolved_state.is_expired_by_time
            grace_days = getattr(settings, "ENTITLEMENT_GRACE_PERIOD_DAYS", 3)

            # 与 downgrade_expired_entitlements 一致：宽限期内保持 status=active，便于权益与前端展示对齐
            if (
                is_expired
                and wt_membership.status == 'active'
                and not resolved_state.has_effective_membership
            ):
                wt_membership.check_and_update_status()
                wt_membership.refresh_from_db(fields=['status', 'updated_at'])
                resolved_state = MembershipStateResolver.resolve(
                    wt_membership,
                    now=resolved_now,
                )

            tier = wt_membership.tier
            in_grace_period = (
                is_expired
                and wt_membership.status == 'active'
                and resolved_state.has_effective_membership
            )
            grace_period_end = None
            grace_days_remaining = None
            if wt_membership.end_date:
                grace_period_end = wt_membership.end_date + timedelta(days=grace_days)
                if in_grace_period:
                    grace_days_remaining = max(0, (grace_period_end - resolved_now).days)

            quotas = self._build_effective_quotas(tier, organization_id)
            quota_usage = self._build_quota_usage(tier, organization_id, quotas)
            return {
                'organization_id': organization_id,
                'membership_id': str(wt_membership.id),
                'is_member': wt_membership.status == 'active' and not is_expired,
                'tier': {
                    'id': str(tier.id),
                    'name': tier.name,
                    'tier_type': tier.tier_type,
                    'tier_level': tier.tier_level,
                    'display_order': tier.sort_order,
                },
                'lifecycle_state': resolved_state.lifecycle_state,
                'billing_cycle': resolved_state.current_billing_cycle,
                'start_date': wt_membership.start_date,
                'end_date': wt_membership.end_date,
                'grace_period_end': grace_period_end,
                'is_expired': is_expired,
                'in_grace_period': in_grace_period,
                'grace_days_remaining': grace_days_remaining,
                'days_until_expiry': wt_membership.days_until_expiry(),
                'auto_renew': wt_membership.auto_renew,
                'allowed_actions': list(resolved_state.allowed_actions),
                'can_upgrade': 'upgrade' in resolved_state.allowed_actions,
                'can_renew': 'renew' in resolved_state.allowed_actions,
                'can_manage': bool(resolved_state.has_effective_membership),
                'purchased_by': wt_membership.purchased_by or '',
                'quotas': quotas,
                'quota_usage': quota_usage,
                'features': tier.features,
            }

        except OrganizationMembership.DoesNotExist:
            free_tier = MembershipTier.objects.filter(tier_type='free', is_active=True).first()
            quotas = self._build_effective_quotas(free_tier, organization_id) if free_tier else {}
            quota_usage = self._build_quota_usage(free_tier, organization_id, quotas) if free_tier else {}
            return {
                'organization_id': organization_id,
                'membership_id': None,
                'is_member': False,
                'tier': {
                    'id': str(free_tier.id),
                    'name': free_tier.name,
                    'tier_type': free_tier.tier_type,
                    'tier_level': free_tier.tier_level,
                    'display_order': free_tier.sort_order,
                } if free_tier else None,
                'lifecycle_state': 'free',
                'billing_cycle': 'monthly',
                'start_date': None,
                'end_date': None,
                'grace_period_end': None,
                'is_expired': False,
                'in_grace_period': False,
                'grace_days_remaining': None,
                'days_until_expiry': None,
                'auto_renew': False,
                'allowed_actions': ['new'],
                'can_upgrade': False,
                'can_renew': False,
                'can_manage': False,
                'purchased_by': '',
                'quotas': quotas,
                'quota_usage': quota_usage,
                'features': free_tier.features if free_tier else {},
            }

    def _build_effective_quotas(self, tier: MembershipTier, organization_id: str) -> Dict[str, Any]:
        """返回套餐基础额度 + 生效增值包额度，供客户端展示和刷新。"""
        addon_quotas: Dict[str, int] = {}
        try:
            from apps.services.billing.services.addon_entitlement_service import AddonEntitlementService

            addon_quotas = AddonEntitlementService.get_addon_quotas(organization_id)
        except Exception as exc:
            logger.warning(
                "addon quota lookup failed for membership status: organization=%s err=%s",
                organization_id,
                exc,
            )

        def with_addon(key: str, base: int) -> int:
            base_value = int(base or 0)
            if base_value == -1:
                return -1
            return base_value + int(addon_quotas.get(key) or 0)

        included_storage_bytes = int(tier.included_storage_bytes or 0)
        effective_storage_bytes = (
            -1
            if included_storage_bytes == -1
            else included_storage_bytes + int(addon_quotas.get('storage_quota_bytes') or 0)
        )
        return {
            'max_tables': with_addon('max_tables', tier.max_tables),
            'max_documents': with_addon('max_documents', getattr(tier, 'max_documents', -1)),
            'max_groups': with_addon('max_groups', getattr(tier, 'max_groups', -1)),
            'max_records_per_table': tier.max_records_per_table,
            'max_members': with_addon('max_members', tier.max_members),
            'max_conversations_per_day': tier.max_conversations_per_day,
            'included_storage_bytes': effective_storage_bytes,
            'included_llm_credits_monthly': str(tier.included_llm_credits_monthly),
            'base_seats': tier.base_seats,
            'trash_retention_days': tier.trash_retention_days,
            'addon_quotas': addon_quotas,
        }

    def _build_quota_usage(
        self,
        tier: MembershipTier,
        organization_id: str,
        quotas: Dict[str, Any],
    ) -> Dict[str, Any]:
        """返回前端展示用权益使用情况：已用 / 总额度 / 套餐额度 / 扩容额度。"""
        addon_quotas = quotas.get('addon_quotas') or {}

        def plan_limit(key: str, attr: str) -> int:
            return int(getattr(tier, attr, 0) or 0)

        def addon_limit(key: str) -> int:
            return int(addon_quotas.get(key) or 0)

        def total_limit(key: str) -> int:
            return int(quotas.get(key) or 0)

        def current_usage(quota_type: str) -> int:
            try:
                from apps.users.membership.services.quota_service import QuotaService

                return int(QuotaService()._get_current_usage(quota_type, organization_id=organization_id))
            except Exception as exc:
                logger.warning(
                    "membership quota usage lookup failed: organization=%s quota=%s err=%s",
                    organization_id,
                    quota_type,
                    exc,
                )
                return 0

        def storage_used() -> int:
            try:
                from apps.services.billing.models import OrganizationStorageUsage

                usage = OrganizationStorageUsage.objects.filter(organization_id=organization_id).first()
                return int(usage.active_storage_bytes or 0) if usage else 0
            except Exception as exc:
                logger.warning(
                    "membership storage usage lookup failed: organization=%s err=%s",
                    organization_id,
                    exc,
                )
                return 0

        return {
            'max_tables': {
                'used': current_usage('max_tables'),
                'limit': total_limit('max_tables'),
                'plan_limit': plan_limit('max_tables', 'max_tables'),
                'addon_limit': addon_limit('max_tables'),
            },
            'max_documents': {
                'used': current_usage('max_documents'),
                'limit': total_limit('max_documents'),
                'plan_limit': plan_limit('max_documents', 'max_documents'),
                'addon_limit': addon_limit('max_documents'),
            },
            'max_groups': {
                'used': current_usage('max_groups'),
                'limit': total_limit('max_groups'),
                'plan_limit': plan_limit('max_groups', 'max_groups'),
                'addon_limit': addon_limit('max_groups'),
            },
            'max_members': {
                'used': current_usage('max_members'),
                'limit': total_limit('max_members'),
                'plan_limit': plan_limit('max_members', 'max_members'),
                'addon_limit': addon_limit('max_members'),
            },
            'included_storage_bytes': {
                'used': storage_used(),
                'limit': total_limit('included_storage_bytes'),
                'plan_limit': int(tier.included_storage_bytes or 0),
                'addon_limit': addon_limit('storage_quota_bytes'),
            },
        }

    def toggle_auto_renew(self, organization_id: str, enable: bool) -> Dict[str, Any]:
        """
        切换自动续费

        Args:
            organization_id: 组织ID
            enable: 是否开启

        Returns:
            包含 auto_renew / end_date / tier_name 的字典，
            供 API 层直接透传给前端。
        """
        try:
            wt_membership = (
                OrganizationMembership.objects
                .select_related('tier')
                .get(organization_id=organization_id)
            )
            wt_membership.auto_renew = enable
            wt_membership.save(update_fields=['auto_renew', 'updated_at'])
            logger.info(
                "组织自动续费设置更新: organization=%s, auto_renew=%s",
                organization_id, enable,
            )

            end_date = wt_membership.end_date
            result: Dict[str, Any] = {
                'organization_id': organization_id,
                'auto_renew': enable,
                'end_date': end_date.isoformat() if end_date else None,
                'tier_name': wt_membership.tier.name if wt_membership.tier_id else None,
            }

            if not enable:
                try:
                    from apps.services.billing.ws_events import publish_billing_event
                    publish_billing_event(organization_id, "membership_renewal_cancelled", {
                        "end_date": end_date.isoformat() if end_date else None,
                        "tier_name": wt_membership.tier.name if wt_membership.tier_id else None,
                    })
                except Exception as exc:
                    logger.warning(
                        "membership_renewal_cancelled WS 推送失败（不影响主流程）: organization=%s, error=%s",
                        organization_id, exc,
                    )

            return result
        except OrganizationMembership.DoesNotExist:
            raise MembershipException("该组织尚未开通会员")

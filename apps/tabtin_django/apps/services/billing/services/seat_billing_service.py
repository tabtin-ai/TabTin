"""
席位计费服务

提供席位配额检查和计费能力。
"""
import logging
from typing import Dict, Any
from decimal import Decimal

from django.utils import timezone

from ..api_utils import safe_decimal


logger = logging.getLogger(__name__)


class SeatBillingService:
    """席位计费服务"""

    @staticmethod
    def get_seat_info(organization_id: str) -> Dict[str, Any]:
        """获取组织的席位使用信息"""
        from apps.users.membership.models import OrganizationMembership, MembershipTier
        from apps.tabtinspace.models import Organization, OrganizationMember

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            return {'used': 0, 'max': -1, 'base_seats': 1, 'extra_seat_price': Decimal('0')}

        current_members = OrganizationMember.objects.filter(organization_id=organization_id).count()

        now = timezone.now()
        ws_membership = (
            OrganizationMembership.objects.filter(
                organization_id=organization_id,
                status='active',
                end_date__gt=now,
            )
            .select_related('tier')
            .order_by('-end_date')
            .first()
        )

        if ws_membership and ws_membership.tier:
            tier = ws_membership.tier
            max_members = tier.max_members
            base_seats = tier.base_seats
            extra_seat_price = tier.extra_seat_price
        else:
            free_tier = MembershipTier.objects.filter(
                tier_type='free', is_active=True,
            ).first()
            if free_tier:
                max_members = free_tier.max_members
                base_seats = free_tier.base_seats
                extra_seat_price = free_tier.extra_seat_price
            else:
                max_members = -1
                base_seats = 1
                extra_seat_price = Decimal('0')

        max_members = SeatBillingService._apply_member_addon(
            organization_id, max_members,
        )

        return {
            'used': current_members,
            'max': max_members,
            'base_seats': base_seats,
            'extra_seat_price': float(extra_seat_price),
            'extra_seats': max(0, current_members - base_seats),
        }

    @staticmethod
    def _apply_member_addon(organization_id: str, max_members: int) -> int:
        """与 QuotaService / 设置页对齐：套餐席位 + 生效扩容包。"""
        if max_members == -1:
            return -1
        try:
            from apps.services.billing.services.addon_entitlement_service import (
                AddonEntitlementService,
            )

            return int(max_members or 0) + int(
                AddonEntitlementService.get_addon_quota(
                    organization_id, 'max_members',
                ) or 0
            )
        except Exception as exc:
            logger.warning(
                "seat addon quota lookup failed, using plan max only: "
                "organization=%s err=%s",
                organization_id,
                exc,
            )
            return int(max_members or 0)

    @staticmethod
    def check_seat_quota(organization_id: str) -> bool:
        """检查是否还有可用席位，True 表示允许添加"""
        info = SeatBillingService.get_seat_info(organization_id)
        if info['max'] == -1:
            return True
        return info['used'] < info['max']

    @staticmethod
    def calculate_monthly_seat_cost(organization_id: str) -> Decimal:
        """计算当月额外席位费用"""
        info = SeatBillingService.get_seat_info(organization_id)
        extra_seats = info['extra_seats']
        extra_seat_price = safe_decimal(info['extra_seat_price'])
        return extra_seats * extra_seat_price


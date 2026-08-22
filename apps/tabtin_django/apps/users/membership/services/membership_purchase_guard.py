"""兼容购买入口的 PR1 分类接线与灰度保护。"""

from django.conf import settings

from ..exceptions import MembershipLifecycleError
from ..models import OrganizationMembership
from .membership_change_classifier import MembershipChangeClassifier
from .membership_state_resolver import MembershipStateResolver


def classify_organization_membership_change(
    *,
    organization_id: str,
    target_tier,
    target_billing_cycle=None,
    now=None,
):
    current_membership = (
        OrganizationMembership.objects
        .filter(organization_id=organization_id)
        .select_related("tier")
        .first()
    )
    state = MembershipStateResolver.resolve(current_membership, now=now)
    action = MembershipChangeClassifier.classify(
        current_membership=current_membership,
        target_tier=target_tier,
        target_billing_cycle=target_billing_cycle,
        now=now,
    )
    return action, state


def classify_and_guard_legacy_purchase(
    *,
    organization_id: str,
    target_tier,
    target_billing_cycle=None,
):
    """开关关闭时完全保持旧支付路径；开启时阻止错误的即时降级/switch。"""
    if not getattr(settings, "MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED", False):
        return None

    action, _state = classify_organization_membership_change(
        organization_id=organization_id,
        target_tier=target_tier,
        target_billing_cycle=target_billing_cycle,
    )
    if action == "downgrade":
        raise MembershipLifecycleError(
            "当前购买入口暂不支持立即降级",
            "MEMBERSHIP_DOWNGRADE_NOT_AVAILABLE_IN_LEGACY_FLOW",
        )
    if action == "switch":
        raise MembershipLifecycleError(
            "当前购买入口暂不支持立即切换同级套餐或计费周期",
            "MEMBERSHIP_SWITCH_NOT_AVAILABLE_IN_LEGACY_FLOW",
        )
    return action

"""套餐动作的唯一业务分类器。"""

from enum import Enum
from numbers import Integral

from ..exceptions import MembershipLifecycleError
from .membership_state_resolver import MembershipStateResolver


class MembershipChangeAction(str, Enum):
    NEW = "new"
    RENEW = "renew"
    UPGRADE = "upgrade"
    DOWNGRADE = "downgrade"
    SWITCH = "switch"


class MembershipChangeClassifier:
    """只使用 tier_level、tier id、账期和有效状态判断套餐动作。"""

    @staticmethod
    def validate_tier_level(tier, *, target: bool = False) -> int:
        error_code = (
            "MEMBERSHIP_TARGET_TIER_INVALID"
            if target
            else "MEMBERSHIP_TIER_LEVEL_INVALID"
        )
        if (
            tier is None
            or not getattr(tier, "id", None)
            or not hasattr(tier, "tier_level")
        ):
            raise MembershipLifecycleError("会员套餐等级无效", error_code)

        value = tier.tier_level
        # bool 是 int 的子类，但不能作为业务等级。
        if isinstance(value, bool) or not isinstance(value, Integral):
            raise MembershipLifecycleError("会员套餐等级无效", error_code)
        return int(value)

    @classmethod
    def classify(
        cls,
        *,
        current_membership,
        target_tier,
        target_billing_cycle=None,
        now=None,
    ) -> str:
        if (
            target_tier is None
            or not getattr(target_tier, "id", None)
            or getattr(target_tier, "is_active", True) is False
        ):
            raise MembershipLifecycleError(
                "目标会员套餐无效",
                "MEMBERSHIP_TARGET_TIER_INVALID",
            )
        target_level = cls.validate_tier_level(target_tier, target=True)
        target_cycle = MembershipStateResolver.validate_billing_cycle(
            target_billing_cycle or "monthly"
        )
        state = MembershipStateResolver.resolve(current_membership, now=now)

        if not state.has_effective_membership:
            return MembershipChangeAction.NEW.value

        current_tier = state.effective_tier
        current_level = cls.validate_tier_level(current_tier)

        if target_cycle != state.current_billing_cycle:
            return MembershipChangeAction.SWITCH.value
        if str(target_tier.id) == str(current_tier.id):
            return MembershipChangeAction.RENEW.value
        if target_level > current_level:
            return MembershipChangeAction.UPGRADE.value
        if target_level < current_level:
            return MembershipChangeAction.DOWNGRADE.value
        return MembershipChangeAction.SWITCH.value

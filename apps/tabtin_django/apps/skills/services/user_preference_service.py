"""用户级技能库总闸（；默认开见 opt-out）。

``UserSkillPreference`` 是技能库总闸的 SSoT；与 ``AgentSkillLink.enabled``
合成最终注入：``user_enabled AND agent_enabled``。

产品口径（技能库页不再暴露总闸开关）：**无行 = 开（opt-out）**；
仅显式 ``enabled=False`` 为关。
"""

from __future__ import annotations

import logging
from typing import Dict, Iterable, Mapping, Optional
from uuid import UUID

from django.db import transaction

from apps.skills.models import UserSkillPreference
from apps.skills.services.registry_service import CANONICAL_SOURCES

logger = logging.getLogger("skills.user_preference")


class UserSkillPreferenceError(Exception):
    """用户总闸业务错误。"""


class UserSkillPreferenceService:
    """读写用户级技能库总闸。"""

    @staticmethod
    def compose_enablement(
        *,
        agent_enabled: bool,
        user_enabled: bool,
    ) -> Dict[str, bool]:
        """分层字段 + 最终注入（user ∧ agent）。"""
        agent_on = bool(agent_enabled)
        user_on = bool(user_enabled)
        return {
            "agent_enabled": agent_on,
            "user_enabled": user_on,
            "enabled": agent_on and user_on,
        }

    @staticmethod
    def resolve_from_map(
        user_gate: Mapping[str, bool],
        skill_canonical_key: str,
    ) -> bool:
        """从 ``map_for_user`` 结果解析总闸：缺键 = 开；显式 False = 关。"""
        key = (skill_canonical_key or "").strip()
        if not key:
            return False
        if key not in user_gate:
            return True
        return bool(user_gate[key])

    @staticmethod
    def is_enabled(user_id, skill_canonical_key: str) -> bool:
        """无行 = 开（opt-out）；仅显式 ``enabled=False`` 为关。"""
        if not user_id or not skill_canonical_key:
            return False
        row = (
            UserSkillPreference.objects.filter(
                user_id=user_id,
                skill_canonical_key=skill_canonical_key.strip(),
            )
            .only("enabled")
            .first()
        )
        if row is None:
            return True
        return bool(row.enabled)

    @classmethod
    def map_for_user(
        cls,
        user_id,
        skill_canonical_keys: Optional[Iterable[str]] = None,
    ) -> Dict[str, bool]:
        """返回已落库的 ``canonical_key → user_enabled``。

        缺键需配合 ``resolve_from_map`` / ``is_enabled`` 解读为**开**。
        """
        if not user_id:
            return {}
        qs = UserSkillPreference.objects.filter(user_id=user_id)
        if skill_canonical_keys is not None:
            keys = [str(k).strip() for k in skill_canonical_keys if k]
            if not keys:
                return {}
            qs = qs.filter(skill_canonical_key__in=keys)
        return {
            row.skill_canonical_key: bool(row.enabled)
            for row in qs.only("skill_canonical_key", "enabled")
        }

    @classmethod
    def set_enabled(
        cls,
        *,
        user_id: UUID,
        skill_canonical_key: str,
        enabled: bool,
    ) -> UserSkillPreference:
        canonical_key = (skill_canonical_key or "").strip()
        if not user_id or not canonical_key or ":" not in canonical_key:
            raise UserSkillPreferenceError(
                f"无效参数：user_id / skill_canonical_key={canonical_key!r}"
            )
        raw_source = canonical_key.partition(":")[0].strip().lower()
        if raw_source not in CANONICAL_SOURCES:
            raise UserSkillPreferenceError(f"未知 skill source: {canonical_key}")

        with transaction.atomic():
            row, created = UserSkillPreference.objects.get_or_create(
                user_id=user_id,
                skill_canonical_key=canonical_key,
                defaults={"enabled": bool(enabled)},
            )
            if not created and row.enabled != bool(enabled):
                row.enabled = bool(enabled)
                row.save(update_fields=["enabled", "updated_at"])

        logger.info(
            "user_skill_preference.set user=%s skill=%s enabled=%s created=%s",
            user_id,
            canonical_key,
            enabled,
            created,
        )
        return row

    @staticmethod
    def forget(*, user_id: UUID, skill_canonical_key: str) -> bool:
        """删除显式获取记录，让条目退出用户的「我的」货架。"""
        canonical_key = (skill_canonical_key or "").strip()
        if not user_id or not canonical_key:
            return False
        deleted, _ = UserSkillPreference.objects.filter(
            user_id=user_id,
            skill_canonical_key=canonical_key,
        ).delete()
        logger.info(
            "user_skill_preference.forgot user=%s skill=%s deleted=%s",
            user_id,
            canonical_key,
            deleted > 0,
        )
        return deleted > 0


__all__ = [
    "UserSkillPreferenceError",
    "UserSkillPreferenceService",
]

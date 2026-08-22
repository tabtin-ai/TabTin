"""
Skill Eligibility Service

Multi-layer eligibility gating for skills.

Check order:
1. Explicit disable via skill_settings[skill_key].enabled == False
2. OS compatibility via os_filter
3. Always flag → accept immediately
4. Binary requirements (requires.bins — all must exist)
5. Any-binary (requires.any_bins — at least one must exist)
6. Environment variables (requires.env)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Set

logger = logging.getLogger(__name__)


class SkillEligibilityService:
    """Determines whether a skill should be included in the available set."""

    @staticmethod
    def should_include(
        entry: Dict[str, Any],
        *,
        skill_settings: Optional[Dict[str, Any]] = None,
        platform: Optional[str] = None,
        available_bins: Optional[Set[str]] = None,
        available_env: Optional[Set[str]] = None,
        valid_credential_ids: Optional[Set[str]] = None,
    ) -> bool:
        """
        Multi-layer eligibility check for a single skill.

        Args:
            entry: Skill index entry dict.
            skill_settings: Mapping of skill_key -> {enabled, credential_id, env, config}.
            platform: Client platform (e.g. "darwin", "linux", "win32").
            available_bins: Set of binary names available on the client.
            available_env: Set of environment variable names available on the client.
            valid_credential_ids: Pre-resolved set of active api_key credential ids
                belonging to the current user. Used by ``filter_eligible`` to avoid
                N+1 UserCredential queries when checking many skills in one pass.
                When ``None``, eligibility is performed without credential verification
                (backward compat path used by unit tests / callers without DB context).

        Returns:
            True if the skill should be included, False otherwise.
        """
        skill_key = entry.get("skill_key") or entry.get("skill_id") or ""

        # ------------------------------------------------------------------
        # 1. Explicit disable via per-skill config
        # ------------------------------------------------------------------
        if skill_settings and skill_key:
            config = skill_settings.get(skill_key)
            if isinstance(config, dict) and config.get("enabled") is False:
                logger.debug("[Eligibility] %s: EXCLUDED (explicitly disabled)", skill_key)
                return False

        # ------------------------------------------------------------------
        # 2. OS compatibility
        # ------------------------------------------------------------------
        os_filter = entry.get("os_filter")
        if os_filter and isinstance(os_filter, list):
            if platform is not None and platform not in os_filter:
                logger.debug(
                    "[Eligibility] %s: EXCLUDED (os %s not in %s)",
                    skill_key, platform, os_filter,
                )
                return False

        # ------------------------------------------------------------------
        # 3. Always flag — bypass dependency checks
        # ------------------------------------------------------------------
        if entry.get("always"):
            logger.debug("[Eligibility] %s: INCLUDED (always=true)", skill_key)
            return True

        # ------------------------------------------------------------------
        # 4–6. Dependency checks (only if context is provided)
        # ------------------------------------------------------------------
        requires = entry.get("requires")
        if not isinstance(requires, dict):
            return True  # No requirements → eligible

        # 4. Binary requirements — ALL must be present
        required_bins = requires.get("bins") or []
        if required_bins and available_bins is not None:
            missing = [b for b in required_bins if b not in available_bins]
            if missing:
                logger.debug(
                    "[Eligibility] %s: EXCLUDED (missing bins: %s)",
                    skill_key, missing,
                )
                return False

        # 5. Any-binary — at least ONE must be present
        any_bins = requires.get("any_bins") or []
        if any_bins and available_bins is not None:
            if not any(b in available_bins for b in any_bins):
                logger.debug(
                    "[Eligibility] %s: EXCLUDED (no anyBins found from: %s)",
                    skill_key, any_bins,
                )
                return False

        # 6. Environment variables
        required_env = requires.get("env") or []
        if required_env and available_env is not None:
            # Skill 配置中的 credential_id 若有效，则视为提供了 primary_env
            # （真实密钥注入在运行时完成，这里只做"能用"判断）。
            primary_env = entry.get("primary_env")
            has_credential = False
            if skill_settings and skill_key and primary_env:
                config = skill_settings.get(skill_key)
                if isinstance(config, dict):
                    cred_id = config.get("credential_id")
                    if cred_id:
                        if valid_credential_ids is None:
                            # 未预解析凭据集合时保守视为有效——
                            # 避免在无 DB 上下文的调用点（单测 / 纯 registry 调用）
                            # 误判为 needs_config。真实调用走 filter_eligible
                            # 时 valid_credential_ids 必不为 None。
                            has_credential = True
                        else:
                            has_credential = str(cred_id) in valid_credential_ids

            effective_env = set(available_env)
            if has_credential and primary_env:
                effective_env.add(primary_env)

            # Also add env vars from skill config
            if skill_settings and skill_key:
                config = skill_settings.get(skill_key)
                if isinstance(config, dict):
                    config_env = config.get("env")
                    if isinstance(config_env, dict):
                        effective_env.update(config_env.keys())

            missing_env = [e for e in required_env if e not in effective_env]
            if missing_env:
                logger.debug(
                    "[Eligibility] %s: EXCLUDED (missing env: %s)",
                    skill_key, missing_env,
                )
                return False

        return True

    @classmethod
    def filter_eligible(
        cls,
        skills: List[Dict[str, Any]],
        *,
        skill_settings: Optional[Dict[str, Any]] = None,
        platform: Optional[str] = None,
        available_bins: Optional[Set[str]] = None,
        available_env: Optional[Set[str]] = None,
        user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Filter a list of skills by eligibility.

        user_id: 当传入时，会一次性查询该用户所有 active api_key credentials，
        用于批量校验 `skill_configs[*].credential_id` 的有效性——避免 N+1 查询。
        """
        if not skills:
            return []

        # If no context is provided, return all skills (backward compat)
        has_context = any(
            v is not None
            for v in (skill_settings, platform, available_bins, available_env, user_id)
        )
        if not has_context:
            return list(skills)

        valid_credential_ids: Optional[Set[str]] = None
        if user_id and skill_settings:
            referenced = _collect_referenced_credential_ids(skill_settings)
            if referenced:
                valid_credential_ids = _resolve_valid_credential_ids(
                    user_id=user_id,
                    credential_ids=referenced,
                )
            else:
                valid_credential_ids = set()

        eligible = []
        for entry in skills:
            if cls.should_include(
                entry,
                skill_settings=skill_settings,
                platform=platform,
                available_bins=available_bins,
                available_env=available_env,
                valid_credential_ids=valid_credential_ids,
            ):
                eligible.append(entry)

        excluded = len(skills) - len(eligible)
        if excluded > 0:
            logger.debug(
                "[Eligibility] %d/%d skills eligible (%d excluded)",
                len(eligible), len(skills), excluded,
            )

        return eligible


def _collect_referenced_credential_ids(
    skill_settings: Dict[str, Any],
) -> Set[str]:
    """从 skill_settings 中收集所有非空 credential_id。"""
    ids: Set[str] = set()
    for cfg in skill_settings.values():
        if isinstance(cfg, dict):
            cid = cfg.get("credential_id")
            if cid:
                ids.add(str(cid))
    return ids


def _resolve_valid_credential_ids(
    *,
    user_id: str,
    credential_ids: Iterable[str],
) -> Optional[Set[str]]:
    """批量校验 credential_ids 的有效性（存在、用户所有、api_key、激活、未过期）。

    返回值语义（与 ``should_include`` 的 valid_credential_ids 参数一致）：
      - ``set(...)``  → 成功获得 authoritative 结果（可能是空集 → 全部无效）
      - ``None``      → 查询失败（MySQL 抖动等），上游应**保守放行**而非
                        把所有 credential 判为无效——否则 DB 抖一下会让
                        所有用户的 Skill 集体消失（P1-2 回归）。
    """
    try:
        from django.utils import timezone
        from django.db.models import Q
        from apps.credential_vault.models import (
            CredentialCategory, UserCredential,
        )
        qs = UserCredential.objects.filter(
            id__in=list(credential_ids),
            user_id=user_id,
            category=CredentialCategory.API_KEY,
            is_active=True,
        ).filter(
            Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()),
        ).values_list("id", flat=True)
        return {str(cid) for cid in qs}
    except Exception:
        logger.warning(
            "[Eligibility] bulk credential resolution failed user=%s",
            user_id, exc_info=True,
        )
        return None


def _detect_platform() -> Optional[str]:
    """Deprecated: 不应使用服务端平台作为客户端平台的兜底。

    保留函数签名以防外部引用，但返回 None 以避免误判。
    服务端的 sys.platform 与客户端设备平台无关，使用它作为
    os_filter 的匹配值会导致错误的过滤结果（SCR-022）。
    """
    return None


__all__ = ["SkillEligibilityService"]

"""
智能体空间应用设置服务

所有读写都走 tabtinspace.SpaceAppSettings。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Set, Tuple

from django.db import transaction

from apps.tabtinspace.models import SpaceAppSettings

logger = logging.getLogger(__name__)


def _normalize_optional_tool_allowlist(raw: Any) -> Dict[str, Any]:
    """标准化可选工具白名单格式"""
    if not isinstance(raw, dict):
        return {"allow_all": False, "tools": [], "apps": []}
    return {
        "allow_all": bool(raw.get("allow_all", False)),
        "tools": sorted(list(raw.get("tools") or [])),
        "apps": sorted(list(raw.get("apps") or [])),
    }


class AppSettingsService:
    """智能体空间应用设置服务（统一入口）"""

    # ------------------------------------------------------------------
    # disabled_apps
    # ------------------------------------------------------------------

    @staticmethod
    def resolve_disabled_apps(
        user_id: Optional[str],
        space_id: Optional[str],
    ) -> List[str]:
        """获取禁用的 APP 列表。

        ``space_id`` 参数名历史保留，语义为 Workspace.id。
        """
        if not user_id or not space_id:
            return []
        try:
            settings = SpaceAppSettings.objects.filter(
                workspace_id=space_id,
                user_id=user_id,
            ).first()
            if settings:
                return settings.disabled_apps or []
        except Exception:
            pass
        return []

    @staticmethod
    def resolve_enabled_app_ids(
        user_id: Optional[str],
        space_id: Optional[str],
        available_app_ids: Optional[Set[str]] = None,
    ) -> Optional[List[str]]:
        """
        返回启用的 APP 列表。
        - 返回 None: 不做过滤（全部可用）
        - 返回 []: 全部禁用
        """
        if not user_id or not space_id:
            return None

        if available_app_ids is not None and len(available_app_ids) == 0:
            return None

        try:
            disabled_apps = AppSettingsService.resolve_disabled_apps(
                user_id=str(user_id),
                space_id=str(space_id),
            )
        except Exception:
            return None

        if not disabled_apps:
            return sorted(available_app_ids) if available_app_ids is not None else None

        disabled = {
            item.strip()
            for item in disabled_apps
            if isinstance(item, str) and item.strip()
        }
        if available_app_ids is None:
            return None
        return sorted(available_app_ids - disabled)

    # ------------------------------------------------------------------
    # optional_tools_allowlist
    # ------------------------------------------------------------------

    @staticmethod
    def resolve_optional_tool_allowlist(
        user_id: Optional[str],
        space_id: Optional[str],
    ) -> Dict[str, Any]:
        """获取可选工具白名单"""
        if not user_id or not space_id:
            return _normalize_optional_tool_allowlist(None)
        try:
            settings = SpaceAppSettings.objects.filter(
                workspace_id=space_id,
                user_id=user_id,
            ).first()
            if settings and settings.optional_tools_allowlist:
                return _normalize_optional_tool_allowlist(settings.optional_tools_allowlist)
        except Exception:
            pass
        return _normalize_optional_tool_allowlist(None)

    # ------------------------------------------------------------------
    # Skill 配置（ M4.5：AgentSkillLink.config_json）
    # ------------------------------------------------------------------

    @staticmethod
    def get_all_skill_configs(
        user_id: Optional[str],
        space_id: Optional[str],
    ) -> Dict[str, Any]:
        """获取 Space 确定 Agent 的所有 Skill 配置。

        返回 ``{canonical_key: {enabled, credential_id, env, config}}``，
        与原 SpaceAppSettings.skill_configs 形态保持一致。
        """
        if not user_id or not space_id:
            return {}
        from apps.skills.models import AgentSkillLink
        from apps.skills.services.space_context import resolve_skill_space_context

        context = resolve_skill_space_context(space_id)
        result: Dict[str, Any] = {}
        for row in AgentSkillLink.objects.filter(agent_id=context.agent_id):
            cfg = dict(row.config_json or {})
            cfg["enabled"] = bool(row.enabled)
            result[row.skill_canonical_key] = cfg
        return result

    @staticmethod
    def get_skill_config(
        user_id: Optional[str],
        space_id: Optional[str],
        skill_key: str,
    ) -> Optional[Dict[str, Any]]:
        """获取单个 Agent Skill 私有配置。"""
        if not user_id or not space_id or not skill_key:
            return None
        from apps.skills.models import AgentSkillLink
        from apps.skills.services.space_context import resolve_skill_space_context

        context = resolve_skill_space_context(space_id)
        row = AgentSkillLink.objects.filter(
            agent_id=context.agent_id,
            skill_canonical_key=skill_key,
        ).first()
        if not row:
            return None
        cfg = dict(row.config_json or {})
        cfg["enabled"] = bool(row.enabled)
        return cfg

    @staticmethod
    def update_skill_config(
        user_id: Optional[str],
        space_id: Optional[str],
        skill_key: str,
        *,
        enabled: Optional[bool] = None,
        credential_id: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        config: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """更新单个 Agent Skill 私有配置。

        credential_id 语义：
          - ``None``  → 保持原值不变
          - ``""``    → 解绑（清空 credential_id 字段）
          - 非空串     → 绑定到该 UserCredential

        行不存在时拒绝隐式创建：调用方必须先经可见性闸门 attach/enable。
        """
        if not user_id or not space_id or not skill_key:
            return None

        from apps.skills.models import AgentSkillLink
        from apps.skills.services.space_context import resolve_skill_space_context
        context = resolve_skill_space_context(space_id)

        with transaction.atomic():
            row = AgentSkillLink.objects.select_for_update().filter(
                agent_id=context.agent_id,
                skill_canonical_key=skill_key,
            ).first()
            if row is None:
                return None

            current = dict(row.config_json or {})
            changed = False
            enabled_changed = enabled is not None and row.enabled != enabled
            if credential_id is not None:
                normalized = credential_id or None
                if current.get("credential_id") != normalized:
                    if normalized is None:
                        current.pop("credential_id", None)
                    else:
                        current["credential_id"] = normalized
                    changed = True
            if env is not None and current.get("env") != env:
                current["env"] = env
                changed = True
            if config is not None and current.get("config") != config:
                current["config"] = config
                changed = True

            update_fields = []
            if changed:
                row.config_json = current
                update_fields.append("config_json")
            if enabled_changed:
                row.enabled = enabled
                update_fields.append("enabled")
            if update_fields:
                row.save(update_fields=update_fields + ["updated_at"])

            return {**current, "enabled": row.enabled}

    # ------------------------------------------------------------------
    # credential 校验
    # ------------------------------------------------------------------

    # 错误码（供 API 层区分文案 / Agent 自动降级）
    CRED_ERR_FORMAT = "CREDENTIAL_ID_INVALID_FORMAT"
    CRED_ERR_NOT_FOUND = "CREDENTIAL_NOT_FOUND"
    CRED_ERR_WRONG_CATEGORY = "CREDENTIAL_WRONG_CATEGORY"
    CRED_ERR_INACTIVE = "CREDENTIAL_INACTIVE"
    CRED_ERR_EXPIRED = "CREDENTIAL_EXPIRED"
    CRED_ERR_DB_ERROR = "CREDENTIAL_DB_ERROR"

    @staticmethod
    def _validate_api_key_credential(
        *,
        user_id: str,
        credential_id: str,
    ) -> Tuple[bool, str]:
        """校验 credential_id：格式、存在、属于用户、category=api_key、激活、未过期。

        返回 (ok, error_code)。error_code 仅在 ok=False 时有意义，用于 API 层
        区分文案与 Agent 自动降级（P1 Review B-1）。

        注意 user_id 过滤与 id 过滤合并一次查询——若查不到，无法区分
        "凭据不存在" 与 "凭据不属于该用户"；这两种情况统一返回 NOT_FOUND
        （等价于权限隐藏，安全上符合最小披露原则）。
        """
        import uuid as _uuid
        try:
            _uuid.UUID(str(credential_id))
        except (ValueError, AttributeError, TypeError):
            return False, AppSettingsService.CRED_ERR_FORMAT

        try:
            from django.utils import timezone
            from apps.credential_vault.models import (
                CredentialCategory, UserCredential,
            )
            cred = UserCredential.objects.filter(
                id=credential_id, user_id=user_id,
            ).only("category", "is_active", "expires_at").first()
            if cred is None:
                return False, AppSettingsService.CRED_ERR_NOT_FOUND
            if cred.category != CredentialCategory.API_KEY:
                return False, AppSettingsService.CRED_ERR_WRONG_CATEGORY
            if not cred.is_active:
                return False, AppSettingsService.CRED_ERR_INACTIVE
            if cred.expires_at and cred.expires_at < timezone.now():
                return False, AppSettingsService.CRED_ERR_EXPIRED
            return True, ""
        except Exception:
            logger.warning(
                "[SkillConfig] credential DB lookup failed user=%s credential=%s",
                user_id, credential_id, exc_info=True,
            )
            return False, AppSettingsService.CRED_ERR_DB_ERROR

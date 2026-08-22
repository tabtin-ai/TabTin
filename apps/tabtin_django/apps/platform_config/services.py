from __future__ import annotations

import hashlib
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from django.core.cache import cache
from django.db import DatabaseError, transaction

from apps.platform_config.models import PlatformRuntimeConfigItem
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.runtime_build import ClientBuild, get_server_build, is_version_at_least


MAX_ORGANIZATIONS_PER_USER_KEY = "product_limits.max_organizations_per_user"
DEFAULT_MAX_ORGANIZATIONS_PER_USER = 3
CONFIG_CACHE_TTL_SECONDS = 60


class PlatformConfigError(ValueError):
    pass


@dataclass(frozen=True)
class OrganizationCreatePolicy:
    allowed: bool
    current_count: int
    max_allowed: int
    remaining: int
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "current_count": self.current_count,
            "max_allowed": self.max_allowed,
            "remaining": self.remaining,
            "message": self.message,
        }


@dataclass(frozen=True)
class FeatureDecision:
    enabled: bool
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "reason": self.reason}


class PlatformRuntimeConfigService:
    FEATURE_PREFIX = "feature_flags."

    @classmethod
    def _cache_key(cls, key: str) -> str:
        return f"platform_runtime_config:{key}"

    @classmethod
    def serialize_item(cls, item: PlatformRuntimeConfigItem) -> dict[str, Any]:
        return {
            "id": item.id,
            "key": item.key,
            "name": item.name,
            "description": item.description,
            "category": item.category,
            "value_type": item.value_type,
            "value": item.value,
            "default_value": item.default_value,
            "is_active": item.is_active,
            "is_system": item.is_system,
            "sort_order": item.sort_order,
            "extra_schema": item.extra_schema or {},
            "updated_by_id": str(item.updated_by_id) if item.updated_by_id else None,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }

    @classmethod
    def normalize_value(cls, value_type: str, value: Any) -> Any:
        if value_type == PlatformRuntimeConfigItem.ValueType.INTEGER:
            if isinstance(value, bool):
                raise PlatformConfigError("整数配置不能使用布尔值")
            try:
                return int(value)
            except (TypeError, ValueError) as exc:
                raise PlatformConfigError("配置值必须是整数") from exc

        if value_type == PlatformRuntimeConfigItem.ValueType.DECIMAL:
            if isinstance(value, bool):
                raise PlatformConfigError("小数配置不能使用布尔值")
            try:
                return str(Decimal(str(value)))
            except (InvalidOperation, TypeError, ValueError) as exc:
                raise PlatformConfigError("配置值必须是数字") from exc

        if value_type == PlatformRuntimeConfigItem.ValueType.BOOLEAN:
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in {"true", "1", "yes", "on"}:
                    return True
                if lowered in {"false", "0", "no", "off"}:
                    return False
            raise PlatformConfigError("配置值必须是布尔值")

        if value_type == PlatformRuntimeConfigItem.ValueType.STRING:
            if value is None:
                return ""
            return str(value)

        if value_type == PlatformRuntimeConfigItem.ValueType.JSON:
            return value

        raise PlatformConfigError(f"不支持的配置值类型: {value_type}")

    @classmethod
    def list_items(cls, *, category: str | None = None, include_inactive: bool = True) -> list[dict[str, Any]]:
        qs = PlatformRuntimeConfigItem.objects.all()
        if category:
            qs = qs.filter(category=category)
        if not include_inactive:
            qs = qs.filter(is_active=True)
        return [cls.serialize_item(item) for item in qs.order_by("category", "sort_order", "key")]

    @classmethod
    def get_item(cls, key: str) -> PlatformRuntimeConfigItem:
        return PlatformRuntimeConfigItem.objects.get(key=key)

    @classmethod
    def get_effective_value(cls, key: str, default: Any = None) -> Any:
        cache_key = cls._cache_key(key)
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        try:
            item = PlatformRuntimeConfigItem.objects.get(key=key)
        except PlatformRuntimeConfigItem.DoesNotExist:
            return default

        value = item.value if item.is_active else item.default_value
        cache.set(cache_key, value, CONFIG_CACHE_TTL_SECONDS)
        return value

    @classmethod
    def _get_feature_item(cls, feature_key: str) -> PlatformRuntimeConfigItem | None:
        try:
            return PlatformRuntimeConfigItem.objects.get(key=f"{cls.FEATURE_PREFIX}{feature_key}")
        except (PlatformRuntimeConfigItem.DoesNotExist, DatabaseError):
            return None

    @classmethod
    def evaluate_feature(
        cls,
        feature_key: str,
        *,
        client: ClientBuild | None,
        user_id: str | None = None,
        organization_id: str | None = None,
    ) -> FeatureDecision:
        feature_key = str(feature_key or "").strip()
        item = cls._get_feature_item(feature_key) if feature_key else None
        if not item or not item.is_active:
            return FeatureDecision(False, "disabled")

        config = item.value
        if not isinstance(config, dict):
            return FeatureDecision(False, "disabled")
        if config.get("enabled") is not True:
            return FeatureDecision(False, "disabled")
        if config.get("deprecated") is True:
            return FeatureDecision(False, "deprecated")

        minimum_server = str(config.get("min_server_version") or "").strip()
        if minimum_server and not is_version_at_least(
            get_server_build().release_version,
            minimum_server,
            kind="release",
        ):
            return FeatureDecision(False, "server_version_too_low")

        if client is not None:
            minimum_clients = config.get("min_client_versions") or {}
            if not isinstance(minimum_clients, dict):
                return FeatureDecision(False, "disabled")
            if minimum_clients and client.client_type not in minimum_clients:
                return FeatureDecision(False, "client_version_too_low")
            minimum_client = str(minimum_clients.get(client.client_type) or "").strip()
            if minimum_client and not is_version_at_least(
                client.client_version,
                minimum_client,
                kind="client",
            ):
                return FeatureDecision(False, "client_version_too_low")

        if "rollout" not in config:
            return FeatureDecision(True, "enabled")
        rollout = config.get("rollout")
        if not isinstance(rollout, dict):
            return FeatureDecision(False, "disabled")

        normalized_user_id = str(user_id or "")
        normalized_organization_id = str(organization_id or "")
        if normalized_user_id and normalized_user_id in {str(value) for value in rollout.get("allow_user_ids") or []}:
            return FeatureDecision(True, "enabled")
        if normalized_organization_id and normalized_organization_id in {
            str(value) for value in rollout.get("allow_organization_ids") or []
        }:
            return FeatureDecision(True, "enabled")

        unit = str(rollout.get("percentage_unit") or "user").strip().lower()
        if unit == "organization":
            identities = {normalized_organization_id} if normalized_organization_id else set()
        elif unit == "user" and normalized_user_id:
            identities = {normalized_user_id}
        else:
            return FeatureDecision(False, "not_in_rollout")
        try:
            percentage = max(0, min(100, int(rollout.get("percentage") or 0)))
        except (TypeError, ValueError):
            return FeatureDecision(False, "not_in_rollout")
        for identity in identities:
            bucket = int(hashlib.sha256(f"{feature_key}:{unit}:{identity}".encode()).hexdigest()[:8], 16) % 100
            if bucket < percentage:
                return FeatureDecision(True, "enabled")
        return FeatureDecision(False, "not_in_rollout")

    @classmethod
    def list_effective_features(
        cls,
        *,
        client: ClientBuild,
        user_id: str | None = None,
        organization_id: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        try:
            keys = list(
                PlatformRuntimeConfigItem.objects.filter(
                    key__startswith=cls.FEATURE_PREFIX,
                    category="feature_flags",
                ).values_list("key", flat=True)
            )
        except DatabaseError:
            return {}
        return {
            key.removeprefix(cls.FEATURE_PREFIX): cls.evaluate_feature(
                key.removeprefix(cls.FEATURE_PREFIX),
                client=client,
                user_id=user_id,
                organization_id=organization_id,
            ).as_dict()
            for key in keys
        }

    @classmethod
    @transaction.atomic
    def upsert_item(
        cls,
        *,
        key: str,
        name: str,
        description: str = "",
        category: str,
        value_type: str,
        value: Any,
        default_value: Any | None = None,
        is_active: bool = True,
        is_system: bool = False,
        sort_order: int = 0,
        extra_schema: dict[str, Any] | None = None,
        updated_by=None,
    ) -> dict[str, Any]:
        normalized_value = cls.normalize_value(value_type, value)
        normalized_default = cls.normalize_value(
            value_type,
            normalized_value if default_value is None else default_value,
        )

        item, _ = PlatformRuntimeConfigItem.objects.update_or_create(
            key=key.strip(),
            defaults={
                "name": name.strip(),
                "description": description or "",
                "category": category.strip(),
                "value_type": value_type,
                "value": normalized_value,
                "default_value": normalized_default,
                "is_active": is_active,
                "is_system": is_system,
                "sort_order": int(sort_order or 0),
                "extra_schema": extra_schema or {},
                "updated_by": updated_by,
            },
        )
        cache.delete(cls._cache_key(item.key))
        return cls.serialize_item(item)

    @classmethod
    @transaction.atomic
    def update_item(cls, key: str, **updates: Any) -> dict[str, Any]:
        item = PlatformRuntimeConfigItem.objects.select_for_update().get(key=key)
        value_type = updates.get("value_type", item.value_type)

        for attr in ("name", "description", "category"):
            if attr in updates and updates[attr] is not None:
                setattr(item, attr, str(updates[attr]).strip() if attr != "description" else str(updates[attr]))

        if "value_type" in updates and updates["value_type"] is not None:
            item.value_type = value_type
        if "value" in updates:
            item.value = cls.normalize_value(value_type, updates["value"])
        if "default_value" in updates:
            item.default_value = cls.normalize_value(value_type, updates["default_value"])
        if "is_active" in updates and updates["is_active"] is not None:
            item.is_active = bool(updates["is_active"])
        if "sort_order" in updates and updates["sort_order"] is not None:
            item.sort_order = int(updates["sort_order"])
        if "extra_schema" in updates and updates["extra_schema"] is not None:
            item.extra_schema = updates["extra_schema"] or {}
        if "updated_by" in updates:
            item.updated_by = updates["updated_by"]

        item.save()
        cache.delete(cls._cache_key(item.key))
        return cls.serialize_item(item)

    @classmethod
    @transaction.atomic
    def delete_item(cls, key: str) -> None:
        item = PlatformRuntimeConfigItem.objects.select_for_update().get(key=key)
        if item.is_system:
            raise PlatformConfigError("系统内置配置不能删除，可以停用或修改配置值")
        item.delete()
        cache.delete(cls._cache_key(key))

    @classmethod
    def get_max_organizations_per_user(cls) -> int:
        raw_value = cls.get_effective_value(
            MAX_ORGANIZATIONS_PER_USER_KEY,
            DEFAULT_MAX_ORGANIZATIONS_PER_USER,
        )
        try:
            return int(raw_value)
        except (TypeError, ValueError):
            return DEFAULT_MAX_ORGANIZATIONS_PER_USER

    @classmethod
    def count_created_team_organizations(cls, user_id: str) -> int:
        from apps.tabtinspace.models import Organization

        return Organization.objects.using(postgres_app_db_alias()).filter(
            owner_id=user_id,
            type=Organization.OrganizationType.TEAM,
            status=Organization.Status.ACTIVE,
        ).count()

    @classmethod
    def get_organization_create_policy(cls, user) -> OrganizationCreatePolicy:
        max_allowed = cls.get_max_organizations_per_user()
        current_count = cls.count_created_team_organizations(str(user.id))

        if max_allowed < 0:
            return OrganizationCreatePolicy(
                allowed=True,
                current_count=current_count,
                max_allowed=max_allowed,
                remaining=-1,
                message="当前不限制组织创建数量",
            )

        remaining = max(0, max_allowed - current_count)
        allowed = remaining > 0
        message = (
            f"还可创建 {remaining} 个组织"
            if allowed
            else f"每个用户最多可创建 {max_allowed} 个组织，当前已达到上限"
        )
        return OrganizationCreatePolicy(
            allowed=allowed,
            current_count=current_count,
            max_allowed=max_allowed,
            remaining=remaining,
            message=message,
        )

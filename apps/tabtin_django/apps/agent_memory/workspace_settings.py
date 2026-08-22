"""Workspace Memory Settings 的存储、权限与模型资格深模块。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional
from uuid import UUID

from django.core.validators import URLValidator
from django.db import transaction

from apps.agent_memory.models import WorkspaceMemorySettings
from apps.services.llm.models import LLMModel


class WorkspaceMemorySettingsError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        incompatible_scenes: tuple[str, ...] = (),
    ):
        super().__init__(message)
        self.code = code
        self.incompatible_scenes = incompatible_scenes


ACTIVE_WORKSPACE_MEMORY_SCENES = (
    "task_summary",
    "memory_capture",
    "diary_distill",
    "user_portrait_distill",
    "memory_compaction",
)


@dataclass(frozen=True)
class WorkspaceMemoryOwner:
    scope: str
    user_id: str = ""
    organization_id: str = ""

    @classmethod
    def personal(cls, user_id: object) -> "WorkspaceMemoryOwner":
        return cls(
            scope=WorkspaceMemorySettings.Scope.PERSONAL,
            user_id=_uuid_string(user_id, "user_id"),
        )

    @classmethod
    def organization(cls, organization_id: object) -> "WorkspaceMemoryOwner":
        return cls(
            scope=WorkspaceMemorySettings.Scope.ORGANIZATION,
            organization_id=_uuid_string(organization_id, "organization_id"),
        )

    def query(self) -> dict[str, Any]:
        if self.scope == WorkspaceMemorySettings.Scope.PERSONAL and self.user_id:
            return {"scope": self.scope, "user_id": self.user_id}
        if (
            self.scope == WorkspaceMemorySettings.Scope.ORGANIZATION
            and self.organization_id
        ):
            return {"scope": self.scope, "organization_id": self.organization_id}
        raise WorkspaceMemorySettingsError(
            "INVALID_WORKSPACE_MEMORY_SCOPE",
            "Workspace Memory owner scope 不完整",
        )


class WorkspaceMemorySettingsAccessPolicy:
    """无 I/O 的权限判定；Organization role 由调用服务从可信数据库解析。"""

    @staticmethod
    def can_read_personal(actor_user_id: object, owner_user_id: object) -> bool:
        return bool(actor_user_id) and str(actor_user_id) == str(owner_user_id)

    can_update_personal = can_read_personal

    @staticmethod
    def can_read_organization(
        *,
        actor_user_id: object,
        organization_owner_id: object,
        member_role: str,
    ) -> bool:
        return bool(actor_user_id) and (
            str(actor_user_id) == str(organization_owner_id)
            or member_role in {"owner", "admin", "editor", "viewer"}
        )

    @staticmethod
    def can_update_organization(
        *,
        actor_user_id: object,
        organization_owner_id: object,
        member_role: str,
    ) -> bool:
        return bool(actor_user_id) and (
            str(actor_user_id) == str(organization_owner_id)
            or member_role == "owner"
        )


def is_server_async_executable(model: Any) -> bool:
    """判断模型是否能由 Django/Celery 使用服务端凭据执行。

    Electron 动态目录模型没有持久化 UUID，或声明 device/local credential，直接
    返回 False。Provider scope 不参与 local 判定；user/organization BYOK 必须
    另外具备服务端持久化 credential。
    """
    if model is None or not _is_uuid(getattr(model, "pk", None) or getattr(model, "id", None)):
        return False

    capabilities = getattr(model, "capabilities_config", None) or {}
    execution_location = str(
        capabilities.get("execution_location")
        or capabilities.get("runtime_location")
        or ""
    ).lower()
    credential_location = str(capabilities.get("credential_location") or "").lower()
    if execution_location in {"electron", "device", "local", "client"}:
        return False
    if credential_location in {"electron", "device", "local", "client"}:
        return False

    provider = getattr(model, "provider", None)
    if provider is None:
        return False
    if getattr(model, "capability_domain", "") != "chat":
        return False
    if "chat" not in (getattr(provider, "capability_domains", None) or []):
        return False
    if getattr(model, "wave_status", "ready") != "ready":
        return False
    if not getattr(provider, "routing_enabled", False):
        return False
    if getattr(provider, "runtime_status", "unknown") == "unhealthy":
        return False
    try:
        URLValidator(schemes=["http", "https"])(str(getattr(model, "base_url", "") or ""))
    except Exception:
        return False

    try:
        from apps.services.llm.registry import ProviderRegistry

        provider_meta = ProviderRegistry.get(str(getattr(provider, "name", "")))
        if provider_meta is None or "llm" not in provider_meta.capability_domains:
            return False
    except Exception:
        return False

    scope = str(getattr(provider, "scope", "") or "")
    if scope == "global":
        return True
    if scope not in {"user", "organization"}:
        return False
    return _has_server_readable_credential(provider)


def validate_workspace_memory_model(
    owner: WorkspaceMemoryOwner,
    model: Any,
) -> None:
    """校验 explicit Workspace Memory Model 的完整五 Scene 资格。"""
    _validate_workspace_memory_model_base(owner, model)
    incompatible = get_workspace_memory_model_incompatible_scenes(model)
    if incompatible:
        scenes = tuple(incompatible)
        raise WorkspaceMemorySettingsError(
            "MEMORY_MODEL_CAPABILITY_MISMATCH",
            "所选模型不满足全部 Workspace Memory Scene capability",
            incompatible_scenes=scenes,
        )


def validate_workspace_memory_scene_model(
    owner: WorkspaceMemoryOwner,
    model: Any,
    scene_key: str,
) -> None:
    """校验 Runtime snapshot 对当前单个 Workspace Memory Scene 的资格。"""
    if scene_key not in ACTIVE_WORKSPACE_MEMORY_SCENES:
        raise WorkspaceMemorySettingsError(
            "INVALID_WORKSPACE_MEMORY_SCENE",
            f"非 active Workspace Memory Scene: {scene_key}",
        )
    _validate_workspace_memory_model_base(owner, model)
    mismatch = _check_workspace_memory_scene(model, scene_key)
    if mismatch:
        raise WorkspaceMemorySettingsError(
            "MEMORY_MODEL_CAPABILITY_MISMATCH",
            f"所选模型不满足 {scene_key} capability: {mismatch}",
            incompatible_scenes=(scene_key,),
        )


def get_workspace_memory_model_incompatible_scenes(
    model: Any,
) -> dict[str, str]:
    """返回 active Workspace Memory Scenes 的稳定有序 mismatch 详情。"""
    incompatible: dict[str, str] = {}
    for scene_key in ACTIVE_WORKSPACE_MEMORY_SCENES:
        mismatch = _check_workspace_memory_scene(model, scene_key)
        if mismatch:
            incompatible[scene_key] = mismatch
    return incompatible


def _check_workspace_memory_scene(model: Any, scene_key: str) -> Optional[str]:
    from apps.services.llm.scenes.capability_check import (
        check_model_capability_match,
    )
    from apps.services.llm.scenes.policy import ScenePolicyResolver
    from apps.services.llm.scenes.registry import SCENES

    policy = ScenePolicyResolver.resolve(scene_key)
    if not policy.enabled:
        return None
    scene = SCENES[scene_key]
    return check_model_capability_match(
        model=model,
        capability_domain=scene.capability_domain,
        requirements=scene.capability_requirements,
    )


def _validate_workspace_memory_model_base(
    owner: WorkspaceMemoryOwner,
    model: Any,
) -> None:
    """校验精确 UUID、服务端执行能力与 Workspace scope 隔离。"""
    owner.query()
    if not is_server_async_executable(model):
        raise WorkspaceMemorySettingsError(
            "BACKGROUND_MODEL_NOT_SERVER_EXECUTABLE",
            "所选模型不能由服务端后台任务执行",
        )

    provider = model.provider
    provider_scope = str(getattr(provider, "scope", "") or "")
    if provider_scope == "global":
        return

    if owner.scope == WorkspaceMemorySettings.Scope.PERSONAL:
        if (
            provider_scope == "user"
            and str(getattr(provider, "user_id", "") or "") == owner.user_id
        ):
            return
        raise WorkspaceMemorySettingsError(
            "WORKSPACE_MEMORY_MODEL_SCOPE_MISMATCH",
            "Personal Workspace 只能使用 Official 或同一用户 BYOK",
        )

    if (
        provider_scope == "organization"
        and str(getattr(provider, "organization_id", "") or "")
        == owner.organization_id
    ):
        return
    raise WorkspaceMemorySettingsError(
        "WORKSPACE_MEMORY_MODEL_SCOPE_MISMATCH",
        "Organization Workspace 只能使用 Official 或本组织 BYOK",
    )


def list_workspace_memory_model_options(
    owner: WorkspaceMemoryOwner,
) -> tuple[
    list[LLMModel],
    list[tuple[LLMModel, WorkspaceMemorySettingsError]],
]:
    """返回可选模型及“仅能力声明不完整”的安全不可选模型。

    粗筛仅用于减少查询量，最终资格统一复用 ``validate_workspace_memory_model``，
    避免 Catalog 与设置写入形成两套边界。scope 不匹配、local-only、凭据不可供
    服务端读取的模型继续完全隐藏，防止跨 Workspace 信息泄漏。
    """
    owner.query()
    models = LLMModel.objects.select_related("provider").filter(
        capability_domain="chat",
        wave_status="ready",
        provider__routing_enabled=True,
    )
    eligible: list[LLMModel] = []
    unavailable: list[tuple[LLMModel, WorkspaceMemorySettingsError]] = []
    for model in models:
        try:
            validate_workspace_memory_model(owner, model)
        except WorkspaceMemorySettingsError as error:
            if (
                error.code == "MEMORY_MODEL_CAPABILITY_MISMATCH"
                and str(model.provider.scope) in {"user", "organization"}
            ):
                unavailable.append((model, error))
            continue
        eligible.append(model)

    def sort_key(model: LLMModel):
        return (
            {"global": 0, "user": 1, "organization": 2}.get(
                str(model.provider.scope),
                9,
            ),
            str(getattr(model.provider, "display_name", "")).casefold(),
            str(model.display_name).casefold(),
            str(model.id),
        )

    return (
        sorted(eligible, key=sort_key),
        sorted(unavailable, key=lambda item: sort_key(item[0])),
    )


def list_workspace_memory_models(owner: WorkspaceMemoryOwner) -> list[LLMModel]:
    """兼容既有调用方：只返回真正可选择的精确模型。"""
    eligible, _unavailable = list_workspace_memory_model_options(owner)
    return eligible


def serialize_memory_model(model: Any) -> Optional[dict[str, str]]:
    """投影客户端所需的安全字段；不接触 credential。"""
    if model is None:
        return None
    return {
        "id": str(model.id),
        "display_name": str(model.display_name),
        "provider_scope": str(model.provider.scope),
        "provider_display_name": str(model.provider.display_name),
    }


def get_workspace_memory_settings(
    owner: WorkspaceMemoryOwner,
) -> WorkspaceMemorySettings:
    """读取设置；迁移后新增 owner 缺行时按正式产品规则 lazy-create 为 OFF。"""
    query = owner.query()
    settings, _created = WorkspaceMemorySettings.objects.get_or_create(
        **query,
        defaults={
            "auto_memory_enabled": False,
            "memory_model_mode": WorkspaceMemorySettings.ModelMode.OFFICIAL_DEFAULT,
            "memory_model": None,
        },
    )
    return settings


def is_auto_memory_enabled(owner: WorkspaceMemoryOwner) -> bool:
    return bool(get_workspace_memory_settings(owner).auto_memory_enabled)


class WorkspaceMemorySettingsService:
    """面向设置调用方的 owner-aware 读写接口。"""

    def __init__(self, actor):
        actor_id = getattr(actor, "id", None)
        if not actor_id:
            raise WorkspaceMemorySettingsError("UNAUTHORIZED", "请先登录")
        self.actor = actor
        self.actor_id = str(actor_id)

    def get(self, owner: WorkspaceMemoryOwner) -> WorkspaceMemorySettings:
        self._assert_permission(owner, update=False)
        return get_workspace_memory_settings(owner)

    def resolve_owner(self, organization_id: object) -> WorkspaceMemoryOwner:
        """把客户端 Organization 上下文解析成 PR8C 的 Personal/Org owner。"""
        from apps.tabtinspace.models import Organization

        exact_id = _uuid_string(organization_id, "organization_id")
        try:
            organization = Organization.objects.get(
                id=exact_id,
                status=Organization.Status.ACTIVE,
            )
        except Organization.DoesNotExist as exc:
            raise WorkspaceMemorySettingsError(
                "WORKSPACE_NOT_FOUND",
                "Workspace 不存在",
            ) from exc

        if organization.type == Organization.OrganizationType.PERSONAL:
            owner = WorkspaceMemoryOwner.personal(organization.owner_id)
        else:
            owner = WorkspaceMemoryOwner.organization(organization.id)
        self._assert_permission(owner, update=False)
        return owner

    def can_update(self, owner: WorkspaceMemoryOwner) -> bool:
        return self._permission_allowed(owner, update=True)

    def list_model_candidates(self, owner: WorkspaceMemoryOwner) -> list[LLMModel]:
        self._assert_permission(owner, update=False)
        return list_workspace_memory_models(owner)

    def list_model_options(
        self,
        owner: WorkspaceMemoryOwner,
    ) -> tuple[
        list[LLMModel],
        list[tuple[LLMModel, WorkspaceMemorySettingsError]],
    ]:
        self._assert_permission(owner, update=False)
        return list_workspace_memory_model_options(owner)

    @transaction.atomic
    def update(
        self,
        owner: WorkspaceMemoryOwner,
        *,
        auto_memory_enabled: Optional[bool] = None,
        memory_model_mode: Optional[str] = None,
        memory_model_id: Optional[object] = None,
    ) -> WorkspaceMemorySettings:
        self._assert_permission(owner, update=True)
        model_selection_changed = (
            memory_model_mode is not None or memory_model_id is not None
        )
        query = owner.query()
        current = WorkspaceMemorySettings.objects.select_for_update().filter(
            **query
        ).first()
        if current is None:
            current = WorkspaceMemorySettings(
                **query,
                auto_memory_enabled=False,
                memory_model_mode=WorkspaceMemorySettings.ModelMode.OFFICIAL_DEFAULT,
                created_by_id=self.actor_id,
            )

        if auto_memory_enabled is not None:
            current.auto_memory_enabled = bool(auto_memory_enabled)
        if memory_model_mode is not None:
            current.memory_model_mode = memory_model_mode

        if current.memory_model_mode == WorkspaceMemorySettings.ModelMode.OFFICIAL_DEFAULT:
            current.memory_model = None
        elif current.memory_model_mode == WorkspaceMemorySettings.ModelMode.EXPLICIT_MODEL:
            # 纯 ON/OFF 不重选、不清空、也不因原模型后来失效而阻塞关闭。
            # 只有用户明确改 mode / exact UUID 时才重新执行资格校验。
            if model_selection_changed or auto_memory_enabled is True:
                if memory_model_id is None:
                    memory_model_id = current.memory_model_id
                model = self._load_exact_model(memory_model_id)
                validate_workspace_memory_model(owner, model)
                current.memory_model = model
        else:
            raise WorkspaceMemorySettingsError(
                "INVALID_MEMORY_MODEL_MODE",
                "memory_model_mode 非法",
            )

        current.updated_by_id = self.actor_id
        current.clean()
        current.save()
        return current

    @staticmethod
    def _load_exact_model(memory_model_id: Optional[object]):
        model_id = _uuid_string(memory_model_id, "memory_model_id")
        try:
            return LLMModel.objects.select_related("provider").get(id=model_id)
        except LLMModel.DoesNotExist as exc:
            raise WorkspaceMemorySettingsError(
                "WORKSPACE_MEMORY_MODEL_NOT_FOUND",
                "所选精确模型不存在",
            ) from exc

    def _assert_permission(self, owner: WorkspaceMemoryOwner, *, update: bool) -> None:
        if not self._permission_allowed(owner, update=update):
            raise WorkspaceMemorySettingsError(
                "WORKSPACE_MEMORY_PERMISSION_DENIED",
                "无权访问或修改 Workspace Memory Settings",
            )

    def _permission_allowed(
        self,
        owner: WorkspaceMemoryOwner,
        *,
        update: bool,
    ) -> bool:
        owner.query()
        policy = WorkspaceMemorySettingsAccessPolicy
        if owner.scope == WorkspaceMemorySettings.Scope.PERSONAL:
            return (
                policy.can_update_personal(self.actor_id, owner.user_id)
                if update
                else policy.can_read_personal(self.actor_id, owner.user_id)
            )
        organization, member_role = self._organization_access(owner.organization_id)
        method = (
            policy.can_update_organization
            if update
            else policy.can_read_organization
        )
        return method(
            actor_user_id=self.actor_id,
            organization_owner_id=organization.owner_id,
            member_role=member_role,
        )

    def _organization_access(self, organization_id: str):
        from apps.tabtinspace.models import Organization, OrganizationMember

        try:
            organization = Organization.objects.get(
                id=organization_id,
                type=Organization.OrganizationType.TEAM,
                status=Organization.Status.ACTIVE,
            )
        except Organization.DoesNotExist as exc:
            raise WorkspaceMemorySettingsError(
                "ORGANIZATION_WORKSPACE_NOT_FOUND",
                "Organization Workspace 不存在",
            ) from exc
        member_role = (
            OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id=self.actor_id,
            )
            .values_list("role", flat=True)
            .first()
            or ""
        )
        return organization, member_role


def _uuid_string(value: object, field_name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError) as exc:
        raise WorkspaceMemorySettingsError(
            "INVALID_WORKSPACE_MEMORY_ID",
            f"{field_name} 必须是 UUID",
        ) from exc


def _is_uuid(value: object) -> bool:
    try:
        UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


def _has_server_readable_credential(provider: Any) -> bool:
    if str(getattr(provider, "encrypted_api_key", "") or "").strip():
        return True
    keys = getattr(provider, "keys", None)
    if keys is None:
        return False
    if hasattr(keys, "exclude"):
        return keys.exclude(encrypted_api_key="").exists()
    try:
        return any(
            str(getattr(key, "encrypted_api_key", "") or "").strip()
            for key in keys
        )
    except TypeError:
        return False


__all__ = [
    "ACTIVE_WORKSPACE_MEMORY_SCENES",
    "get_workspace_memory_model_incompatible_scenes",
    "WorkspaceMemoryOwner",
    "WorkspaceMemorySettingsAccessPolicy",
    "WorkspaceMemorySettingsError",
    "WorkspaceMemorySettingsService",
    "get_workspace_memory_settings",
    "is_auto_memory_enabled",
    "is_server_async_executable",
    "list_workspace_memory_models",
    "list_workspace_memory_model_options",
    "serialize_memory_model",
    "validate_workspace_memory_model",
    "validate_workspace_memory_scene_model",
]

"""Workspace Memory Model execution policy 的深模块。"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from apps.agent_memory.workspace_settings import (
    ACTIVE_WORKSPACE_MEMORY_SCENES,
    WorkspaceMemoryOwner,
    get_workspace_memory_settings,
    validate_workspace_memory_scene_model,
)


@dataclass(frozen=True)
class WorkspaceMemoryExecution:
    enabled: bool
    selected_model_id: str = ""
    workspace_scope: str = ""
    model_source: str = ""


AGGREGATE_MEMORY_SCENES = frozenset({
    "diary_distill",
    "user_portrait_distill",
    "memory_compaction",
})
WORKSPACE_MEMORY_MODEL_SCENES = frozenset(ACTIVE_WORKSPACE_MEMORY_SCENES)
# Workspace 记忆总开关关闭时，任何记忆场景都不得解析或调用记忆模型。
# 直接复用 active scene 集合，避免新增场景时遗漏门控。
AUTO_MEMORY_GATED_SCENES = WORKSPACE_MEMORY_MODEL_SCENES


def resolve_workspace_memory_dispatch(
    *,
    scene_key: str,
    organization_id: str,
    user_id: str,
) -> WorkspaceMemoryExecution:
    """Producer 读取开关并把 Workspace model 冻结为精确 UUID。"""
    _validate_scene_key(scene_key)
    owner = _resolve_owner(organization_id=organization_id, user_id=user_id)
    settings = get_workspace_memory_settings(owner)
    if _requires_auto_memory(scene_key) and not settings.auto_memory_enabled:
        return WorkspaceMemoryExecution(
            enabled=False,
            workspace_scope=owner.scope,
        )
    if settings.memory_model_mode == "official_default":
        from apps.services.llm.scenes.registry import SCENES
        from apps.services.llm.services._runtime.model_resolver import resolve_model

        scene = SCENES[scene_key]
        from apps.services.llm.scenes.exceptions import (
            CapabilityMismatch,
            SceneOfficialBindingCapabilityMismatch,
        )

        try:
            model, _scope = resolve_model(
                scene_key=scene_key,
                capability_domain=scene.capability_domain,
                capability_requirements=scene.capability_requirements,
            )
        except CapabilityMismatch as exc:
            raise SceneOfficialBindingCapabilityMismatch(
                "Workspace Memory Official Binding 不满足当前 Scene capability",
                scene_key=scene_key,
            ) from exc
        _validate_model(owner, model, scene_key=scene_key)
        execution = WorkspaceMemoryExecution(
            enabled=True,
            selected_model_id=str(model.id),
            workspace_scope=owner.scope,
            model_source="official",
        )
        _record_execution(scene_key, execution)
        return execution
    if settings.memory_model_mode == "explicit_model":
        from apps.services.llm.models import LLMModel
        from apps.services.llm.scenes.exceptions import (
            WorkspaceMemoryModelUnavailable,
        )

        try:
            model = LLMModel.objects.select_related("provider").get(
                id=settings.memory_model_id
            )
        except (LLMModel.DoesNotExist, ValueError, TypeError) as exc:
            raise WorkspaceMemoryModelUnavailable(
                "Workspace Memory 精确模型不存在",
                scene_key=scene_key,
            ) from exc
        _validate_model(owner, model, scene_key=scene_key)
        source = "official" if model.provider.scope == "global" else "byok"
        execution = WorkspaceMemoryExecution(
            enabled=True,
            selected_model_id=str(model.id),
            workspace_scope=owner.scope,
            model_source=source,
        )
        _record_execution(scene_key, execution)
        return execution
    from apps.services.llm.scenes.exceptions import WorkspaceMemoryModelUnavailable

    raise WorkspaceMemoryModelUnavailable(
        "Workspace Memory model mode 不支持",
        scene_key=scene_key,
    )


def resolve_workspace_memory_worker(
    *,
    scene_key: str,
    organization_id: str,
    user_id: str,
    selected_model_id: str,
) -> WorkspaceMemoryExecution:
    """Worker 仅重读适用的开关，并只执行 producer payload 的模型 snapshot。"""
    _validate_scene_key(scene_key)
    owner = _resolve_owner(organization_id=organization_id, user_id=user_id)
    if (
        _requires_auto_memory(scene_key)
        and not get_workspace_memory_settings(owner).auto_memory_enabled
    ):
        return WorkspaceMemoryExecution(
            enabled=False,
            workspace_scope=owner.scope,
        )
    model = _load_snapshot_model(selected_model_id, scene_key=scene_key)
    _validate_model(owner, model, scene_key=scene_key)
    execution = WorkspaceMemoryExecution(
        enabled=True,
        selected_model_id=str(model.id),
        workspace_scope=owner.scope,
        model_source=("official" if model.provider.scope == "global" else "byok"),
    )
    _record_execution(scene_key, execution)
    return execution


def _load_snapshot_model(selected_model_id: str, *, scene_key: str):
    from apps.services.llm.models import LLMModel
    from apps.services.llm.scenes.exceptions import (
        WorkspaceMemoryModelUnavailable,
    )

    try:
        model_id = UUID(str(selected_model_id))
    except (TypeError, ValueError) as exc:
        raise WorkspaceMemoryModelUnavailable(
            "Workspace Memory 任务缺少精确模型 snapshot",
            scene_key=scene_key,
        ) from exc
    try:
        return LLMModel.objects.select_related("provider").get(id=model_id)
    except LLMModel.DoesNotExist as exc:
        raise WorkspaceMemoryModelUnavailable(
            "Workspace Memory 模型 snapshot 已不存在",
            scene_key=scene_key,
        ) from exc


def _validate_scene_key(scene_key: str) -> None:
    if scene_key not in WORKSPACE_MEMORY_MODEL_SCENES:
        raise ValueError(f"非 Workspace Memory Model Scene: {scene_key}")


def _requires_auto_memory(scene_key: str) -> bool:
    return scene_key in AUTO_MEMORY_GATED_SCENES


def _validate_model(owner: WorkspaceMemoryOwner, model, *, scene_key: str) -> None:
    from apps.agent_memory.workspace_settings import WorkspaceMemorySettingsError
    from apps.services.llm.scenes.exceptions import (
        BackgroundModelNotServerExecutable,
        WorkspaceMemoryModelUnavailable,
    )

    try:
        validate_workspace_memory_scene_model(owner, model, scene_key)
    except WorkspaceMemorySettingsError as exc:
        if exc.code == "BACKGROUND_MODEL_NOT_SERVER_EXECUTABLE":
            raise BackgroundModelNotServerExecutable(
                str(exc),
                scene_key=scene_key,
                reason="model_not_server_executable",
                runtime="server_async",
            ) from exc
        raise WorkspaceMemoryModelUnavailable(
            str(exc),
            scene_key=scene_key,
            reason=exc.code.lower(),
        ) from exc


def _record_execution(scene_key: str, execution: WorkspaceMemoryExecution) -> None:
    try:
        from apps.services.llm.services.llm_metrics import (
            ai_workspace_memory_execution_total,
        )

        ai_workspace_memory_execution_total.labels(
            scene=scene_key,
            workspace_scope=execution.workspace_scope,
            model_source=execution.model_source,
            execution="server_async",
        ).inc()
    except Exception:
        pass


def _resolve_owner(*, organization_id: str, user_id: str) -> WorkspaceMemoryOwner:
    from apps.tabtinspace.models import Organization

    organization = Organization.objects.only("type", "owner_id").get(
        id=organization_id
    )
    if organization.type == Organization.OrganizationType.PERSONAL:
        if str(organization.owner_id) != str(user_id):
            raise ValueError("Personal Workspace owner 与执行用户不一致")
        return WorkspaceMemoryOwner.personal(user_id)
    if organization.type == Organization.OrganizationType.TEAM:
        return WorkspaceMemoryOwner.organization(organization_id)
    raise ValueError("不支持的 Workspace Organization 类型")


__all__ = [
    "AGGREGATE_MEMORY_SCENES",
    "AUTO_MEMORY_GATED_SCENES",
    "WORKSPACE_MEMORY_MODEL_SCENES",
    "WorkspaceMemoryExecution",
    "resolve_workspace_memory_dispatch",
    "resolve_workspace_memory_worker",
]

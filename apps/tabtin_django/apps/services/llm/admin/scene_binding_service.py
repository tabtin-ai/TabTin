from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from django.db import transaction

from ..models import LLMAdminAuditLog, LLMModel, LLMSceneBinding
from ..scenes.capability_check import check_model_capability_match
from ..scenes.registry import SCENES
from ..scenes.types import SceneSpec
from ..services.factory import invalidate_scene_cache


class BulkSceneBindingError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


def _get_bindable_scene_specs(scene_keys: Sequence[str]) -> dict[str, SceneSpec]:
    if not scene_keys:
        raise BulkSceneBindingError("EMPTY_BATCH", "请至少选择一个场景")
    if len(scene_keys) != len(set(scene_keys)):
        raise BulkSceneBindingError("DUPLICATE_SCENE", "批量请求包含重复场景")

    specs = {}
    for scene_key in scene_keys:
        spec = SCENES.get(scene_key)
        if spec is None:
            raise BulkSceneBindingError(
                "SCENE_NOT_FOUND",
                f"场景 {scene_key} 不存在",
            )
        if spec.is_system:
            raise BulkSceneBindingError(
                "SYSTEM_SCENE_NOT_BINDABLE",
                f"系统场景 {scene_key} 不支持模型绑定",
            )
        specs[scene_key] = spec
    return specs


def list_compatible_models_by_domain(
    *,
    scene_keys: Sequence[str],
) -> dict[str, object]:
    specs = _get_bindable_scene_specs(scene_keys)
    scene_keys_by_domain: dict[str, list[str]] = {}
    for scene_key in scene_keys:
        domain = specs[scene_key].capability_domain
        scene_keys_by_domain.setdefault(domain, []).append(scene_key)

    models_by_domain: dict[str, list[LLMModel]] = {}
    models = (
        LLMModel.objects.select_related("provider")
        .filter(wave_status="ready", provider__scope="global")
        .order_by("display_name", "model_name")
    )
    for model in models:
        domain_scene_keys = scene_keys_by_domain.get(model.capability_domain)
        if not domain_scene_keys:
            continue
        if all(
            check_model_capability_match(
                model=model,
                requirements=specs[scene_key].capability_requirements,
                capability_domain=specs[scene_key].capability_domain,
            )
            is None
            for scene_key in domain_scene_keys
        ):
            models_by_domain.setdefault(model.capability_domain, []).append(model)

    return {
        "groups": [
            {
                "capability_domain": domain,
                "scene_keys": domain_scene_keys,
                "models": [
                    {
                        "id": str(model.id),
                        "display_name": model.display_name,
                        "model_name": model.model_name,
                    }
                    for model in models_by_domain.get(domain, [])
                ],
            }
            for domain, domain_scene_keys in scene_keys_by_domain.items()
        ]
    }


def bulk_update_primary_models(
    *,
    updates: Sequence[dict[str, str]],
    operator_id: str,
    operator_username: str,
) -> dict[str, object]:
    normalized_updates = []
    for update in updates:
        try:
            model_id = str(UUID(update["primary_model_id"]))
        except (AttributeError, TypeError, ValueError) as exc:
            raise BulkSceneBindingError(
                "INVALID_MODEL_ID",
                f"场景 {update['scene_key']} 的模型 ID 格式无效",
            ) from exc
        normalized_updates.append(
            {"scene_key": update["scene_key"], "primary_model_id": model_id}
        )

    scene_keys = [update["scene_key"] for update in normalized_updates]
    specs = _get_bindable_scene_specs(scene_keys)

    with transaction.atomic():
        requested_model_ids = {
            update["primary_model_id"] for update in normalized_updates
        }
        models = {
            str(model.id): model
            for model in LLMModel.objects.select_for_update()
            .select_related("provider")
            .filter(id__in=requested_model_ids, wave_status="ready")
        }

        for update in normalized_updates:
            scene_key = update["scene_key"]
            model_id = update["primary_model_id"]
            model = models.get(model_id)
            if model is None:
                raise BulkSceneBindingError(
                    "MODEL_NOT_AVAILABLE",
                    f"场景 {scene_key} 选择的模型不存在或未就绪",
                )
            if model.provider.scope != "global":
                raise BulkSceneBindingError(
                    "MODEL_SCOPE_MISMATCH",
                    f"场景 {scene_key} 只能绑定全局渠道模型",
                )

            mismatch = check_model_capability_match(
                model=model,
                requirements=specs[scene_key].capability_requirements,
                capability_domain=specs[scene_key].capability_domain,
            )
            if mismatch:
                raise BulkSceneBindingError(
                    "MODEL_CAPABILITY_MISMATCH",
                    f"场景 {scene_key} 与模型 {model.display_name} 不兼容：{mismatch}",
                )

        existing_bindings = {
            binding.scene_key: binding
            for binding in LLMSceneBinding.objects.select_for_update().filter(
                scene_key__in=scene_keys,
            )
        }

        for update in normalized_updates:
            scene_key = update["scene_key"]
            spec = specs[scene_key]
            model = models[update["primary_model_id"]]
            binding = existing_bindings.get(scene_key)
            created = binding is None
            if binding is None:
                binding = LLMSceneBinding(
                    scene_key=scene_key,
                    display_name=spec.display_name,
                    description=spec.description,
                    capability_domain=spec.capability_domain,
                    capability_requirements=spec.capability_requirements,
                )

            previous_model_id = (
                str(binding.primary_model_id) if binding.primary_model_id else None
            )
            binding.primary_model = model
            if created:
                binding.save()
            else:
                binding.save(update_fields=["primary_model", "updated_at"])

            LLMAdminAuditLog.objects.create(
                operator_id=operator_id,
                operator_username=operator_username,
                action="create" if created else "update",
                target_type="scene_binding",
                target_id=scene_key,
                model_id=str(model.id),
                before_data={"primary_model_id": previous_model_id},
                after_data={"primary_model_id": str(model.id)},
                changed_fields=(
                    ["primary_model_id"]
                    if previous_model_id != str(model.id)
                    else []
                ),
            )

        transaction.on_commit(invalidate_scene_cache)

    return {
        "updated_count": len(normalized_updates),
        "scene_keys": scene_keys,
    }

"""Scene 中心 API — v0.1 AdminDash"""

import logging
from typing import Optional

from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from django.db.models import Max

from apps.i18n.response import success_response
from apps.users.auth.permissions import StaffAuth

from ..models import LLMSceneBinding, LLMModel, LLMUsageFact, LLMAdminAuditLog
from ..scenes.registry import SCENES, get_scene_spec, list_scenes
from .scene_binding_service import (
    BulkSceneBindingError,
    bulk_update_primary_models,
    list_compatible_models_by_domain,
)

logger = logging.getLogger(__name__)

router = Router(tags=["Admin Scenes"], auth=StaffAuth())


class UpdateBindingPayload(Schema):
    primary_model_id: Optional[str] = None
    fallback_models: Optional[list] = None
    default_params: Optional[dict] = None
    timeout_sec: Optional[int] = None


class BulkBindingItem(Schema):
    scene_key: str
    primary_model_id: str


class BulkBindingPayload(Schema):
    bindings: list[BulkBindingItem]


class BulkBindingCandidatesPayload(Schema):
    scene_keys: list[str]


class PromptPreviewPayload(Schema):
    variables: dict = {}
    mode: Optional[str] = None


def _check_capability_match(model_instance: LLMModel, scene_spec) -> dict:
    """校验 model 是否满足 scene 的 capability_requirements。"""
    reqs = scene_spec.capability_requirements or {}
    caps = model_instance.capabilities_config or {}
    issues = []

    if reqs.get("requires_function_calling") and not caps.get("supports_function_calling", False):
        issues.append("requires_function_calling")
    if reqs.get("requires_vision") and not caps.get("supports_vision", False):
        issues.append("requires_vision")
    if reqs.get("requires_json_mode") and not caps.get("supports_json_mode", False):
        issues.append("requires_json_mode")

    min_ctx = reqs.get("min_context_tokens", 0)
    if min_ctx and (model_instance.context_window_tokens or 0) < min_ctx:
        issues.append(f"min_context_tokens ({min_ctx})")

    return {
        "satisfied": len(issues) == 0,
        "issues": issues,
    }


def _serialize_binding(binding: Optional[LLMSceneBinding]) -> Optional[dict]:
    if not binding:
        return None
    return {
        "id": str(binding.id),
        "scene_key": binding.scene_key,
        "primary_model": {
            "id": str(binding.primary_model.id),
            "display_name": binding.primary_model.display_name,
            "model_name": binding.primary_model.model_name,
        } if binding.primary_model else None,
        "fallback_models": binding.fallback_models or [],
        "default_params": binding.default_params or {},
        "timeout_sec": binding.timeout_sec,
        "created_at": binding.created_at.isoformat() if binding.created_at else None,
        "updated_at": binding.updated_at.isoformat() if binding.updated_at else None,
    }


def _get_last_call_at(scene_key: str) -> Optional[str]:
    fact = LLMUsageFact.objects.filter(
        scene_key=scene_key,
    ).order_by('-occurred_at').values('occurred_at').first()
    if fact and fact['occurred_at']:
        return fact['occurred_at'].isoformat()
    return None


@router.get("/admin/scenes")
def list_admin_scenes(
    request,
    domain: Optional[str] = None,
    include_system: bool = False,
    keyword: Optional[str] = None,
):
    specs = list_scenes(capability_domain=domain, include_system=include_system)

    if keyword:
        kw = keyword.lower()
        specs = [s for s in specs if kw in s.scene_key.lower() or kw in s.display_name.lower()]

    bindings = {
        b.scene_key: b
        for b in LLMSceneBinding.objects.select_related('primary_model').all()
    }

    last_calls = dict(
        LLMUsageFact.objects.values('scene_key')
        .annotate(last_call=Max('occurred_at'))
        .values_list('scene_key', 'last_call')
    )

    items = []
    for spec in specs:
        binding = bindings.get(spec.scene_key)
        validation = "satisfied"
        if binding and binding.primary_model:
            result = _check_capability_match(binding.primary_model, spec)
            validation = "satisfied" if result["satisfied"] else "unsatisfied"
        elif not binding:
            validation = "unsatisfied"

        last_call_dt = last_calls.get(spec.scene_key)
        items.append({
            "scene_key": spec.scene_key,
            "display_name": spec.display_name,
            "description": spec.description,
            "capability_domain": spec.capability_domain,
            "capability_requirements": spec.capability_requirements,
            "is_system": spec.is_system,
            "binding": _serialize_binding(binding),
            "capability_validation": validation,
            "last_call_at": last_call_dt.isoformat() if last_call_dt else None,
        })

    return success_response(data={
        "scenes": items,
        "total": len(items),
    })


@router.post("/admin/scenes/bindings/bulk/candidates")
def list_bulk_binding_candidates(request, payload: BulkBindingCandidatesPayload):
    try:
        result = list_compatible_models_by_domain(scene_keys=payload.scene_keys)
    except BulkSceneBindingError as exc:
        raise HttpError(422, f"{exc.code}: {exc.message}") from exc
    return success_response(data=result)


@router.patch("/admin/scenes/bindings/bulk")
def bulk_update_scene_bindings(request, payload: BulkBindingPayload):
    try:
        result = bulk_update_primary_models(
            updates=[binding.model_dump() for binding in payload.bindings],
            operator_id=str(request.auth.id),
            operator_username=getattr(request.auth, "username", ""),
        )
    except BulkSceneBindingError as exc:
        raise HttpError(422, f"{exc.code}: {exc.message}") from exc

    return success_response(
        data=result,
        message=f"已更新 {result['updated_count']} 个场景",
    )


@router.get("/admin/scenes/{scene_key}")
def get_scene_detail(request, scene_key: str):
    spec = get_scene_spec(scene_key)
    binding = LLMSceneBinding.objects.select_related('primary_model').filter(
        scene_key=scene_key,
    ).first()

    recent_usage = {"total_calls_24h": 0, "success_rate": 0.0, "avg_latency_ms": 0, "total_cost_usd": "0.00"}
    cutoff = timezone.now() - timezone.timedelta(hours=24)
    facts_24h = LLMUsageFact.objects.filter(scene_key=scene_key, occurred_at__gte=cutoff)
    total_24h = facts_24h.count()
    if total_24h > 0:
        completed = facts_24h.filter(status='completed').count()
        from django.db.models import Avg, Sum
        agg = facts_24h.aggregate(avg_latency=Avg('latency_ms'), total_cost=Sum('total_cost'))
        recent_usage = {
            "total_calls_24h": total_24h,
            "success_rate": round(completed / total_24h, 4) if total_24h else 0,
            "avg_latency_ms": int(agg['avg_latency'] or 0),
            "total_cost_usd": f"{float(agg['total_cost'] or 0):.4f}",
        }

    recent_audit = list(
        LLMAdminAuditLog.objects.filter(
            target_type='scene_binding', target_id=scene_key,
        ).order_by('-created_at')[:5].values(
            'id', 'action', 'operator_username', 'changed_fields', 'created_at',
        )
    )

    from pathlib import Path
    bundled_dir = Path(__file__).resolve().parent.parent / "scenes" / "bundled" / scene_key
    prompt_bundle = None
    if bundled_dir.is_dir():
        prompt_bundle = {
            "bundle_path": f"scenes/bundled/{scene_key}/",
            "has_system_md": (bundled_dir / "system.md").exists(),
            "has_user_template": (bundled_dir / "user.md").exists(),
        }

    return success_response(data={
        "scene_key": spec.scene_key,
        "spec": {
            "display_name": spec.display_name,
            "description": spec.description,
            "capability_domain": spec.capability_domain,
            "is_system": spec.is_system,
            "capability_requirements": spec.capability_requirements,
            "default_params": spec.default_params,
        },
        "binding": _serialize_binding(binding),
        "prompt_bundle": prompt_bundle,
        "recent_usage": recent_usage,
        "recent_audit": [{
            "id": str(a["id"]),
            "action": a["action"],
            "operator": a["operator_username"],
            "changed_fields": a["changed_fields"],
            "created_at": a["created_at"].isoformat() if a["created_at"] else None,
        } for a in recent_audit],
    })


@router.patch("/admin/scenes/{scene_key}/binding")
def update_scene_binding(request, scene_key: str, payload: UpdateBindingPayload):
    spec = get_scene_spec(scene_key)

    binding, created = LLMSceneBinding.objects.get_or_create(
        scene_key=scene_key,
        defaults={
            "display_name": spec.display_name,
            "description": spec.description,
            "capability_domain": spec.capability_domain,
            "capability_requirements": spec.capability_requirements,
        },
    )

    before = {
        "primary_model_id": str(binding.primary_model_id) if binding.primary_model_id else None,
        "fallback_models": binding.fallback_models,
        "default_params": binding.default_params,
        "timeout_sec": binding.timeout_sec,
    }

    if payload.primary_model_id is not None:
        model = LLMModel.objects.select_related('provider').filter(
            id=payload.primary_model_id, wave_status='ready',
        ).first()
        if not model:
            raise HttpError(404, f"Model {payload.primary_model_id} not found or inactive")
        if model.provider.scope != 'global':
            raise HttpError(
                422,
                f"E14_SCENE_BINDING_VIOLATES_BYOK_BOUNDARY: "
                f"Scene binding 只能使用 scope=global 的渠道，"
                f"当前渠道 scope={model.provider.scope}",
            )
        result = _check_capability_match(model, spec)
        if not result["satisfied"]:
            raise HttpError(422, f"E16_CAPABILITY_MISMATCH: {', '.join(result['issues'])}")
        binding.primary_model = model

    if payload.fallback_models is not None:
        binding.fallback_models = payload.fallback_models
    if payload.default_params is not None:
        binding.default_params = payload.default_params
    if payload.timeout_sec is not None:
        binding.timeout_sec = payload.timeout_sec

    binding.save()

    after = {
        "primary_model_id": str(binding.primary_model_id) if binding.primary_model_id else None,
        "fallback_models": binding.fallback_models,
        "default_params": binding.default_params,
        "timeout_sec": binding.timeout_sec,
    }

    LLMAdminAuditLog.objects.create(
        operator_id=str(request.auth.id),
        operator_username=getattr(request.auth, 'username', ''),
        action="update" if not created else "create",
        target_type="scene_binding",
        target_id=scene_key,
        before_data=before,
        after_data=after,
        changed_fields=list(k for k in after if after[k] != before.get(k)),
    )

    return success_response(data={"binding": _serialize_binding(binding)})


@router.get("/admin/scenes/{scene_key}/prompt")
def get_scene_prompt(request, scene_key: str):
    spec = get_scene_spec(scene_key)

    from pathlib import Path
    bundled_dir = Path(__file__).resolve().parent.parent / "scenes" / "bundled" / scene_key

    frontmatter = {}
    system_md = ""
    user_template = ""

    scene_md = bundled_dir / "SCENE.md"
    if scene_md.exists():
        import yaml
        content = scene_md.read_text(encoding="utf-8")
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                try:
                    frontmatter = yaml.safe_load(parts[1]) or {}
                except Exception:
                    pass

    system_file = bundled_dir / "system.md"
    if system_file.exists():
        system_md = system_file.read_text(encoding="utf-8")

    user_file = bundled_dir / "user.md"
    if user_file.exists():
        user_template = user_file.read_text(encoding="utf-8")

    import re
    variables_detected = re.findall(r'\{\{\s*(\w+)\s*\}\}', user_template)
    variables_detected = list(dict.fromkeys(variables_detected))

    return success_response(data={
        "scene_key": spec.scene_key,
        "frontmatter": frontmatter,
        "system_md": system_md,
        "user_template": user_template,
        "variables_detected": variables_detected,
    })


@router.post("/admin/scenes/{scene_key}/prompt-preview")
def preview_scene_prompt(request, scene_key: str, payload: PromptPreviewPayload):
    get_scene_spec(scene_key)

    from ..prompts.registry import PromptRegistry
    from ..scenes.exceptions import InvalidVariables

    try:
        rendered = PromptRegistry.render(
            scene_key=scene_key,
            variables=payload.variables,
            mode=payload.mode,
        )
        return success_response(data={
            "rendered_system": rendered.system,
            "rendered_user": rendered.user,
            "variables_missing": [],
        })
    except InvalidVariables as exc:
        return success_response(data={
            "rendered_system": "",
            "rendered_user": "",
            "variables_missing": [str(exc)],
        })

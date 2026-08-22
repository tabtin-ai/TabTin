"""统一实体 API — 聚合 App / Channel / Integration / Skill 的只读查询接口。

前端用此 API 获取平台所有可用实体列表，支持按 kind 过滤。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from ninja import Router

from apps.services.common.entity_query_service import EntityQueryService
from apps.users.auth.permissions import JWTAuth

logger = logging.getLogger(__name__)

router = Router(tags=["Entities"])
_jwt_auth = JWTAuth()

_SKILL_PUBLIC_FIELDS = ("id", "name", "kind", "description", "icon", "version")


def _is_authenticated(request) -> bool:
    """检查请求是否已通过 JWT 认证。"""
    if getattr(request, "auth", None) is not None:
        return True
    auth_header = request.META.get("HTTP_AUTHORIZATION", "")
    if not auth_header.startswith("Bearer "):
        return False
    try:
        user = _jwt_auth.authenticate(request, auth_header[7:])
        if user is not None:
            request.auth = user
            return True
    except Exception:
        pass
    return False


def _sanitize_skill_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """P1-18: 未认证请求仅返回 Skill 的公开字段。"""
    return {k: manifest[k] for k in _SKILL_PUBLIC_FIELDS if k in manifest}


@router.get("/", auth=None, summary="列出所有实体")
def list_entities(request, kind: Optional[str] = None) -> Dict[str, Any]:
    """列出所有实体（App + Channel + Integration），可按 kind 过滤。

    kind 可选值：app / channel / integration / extension / skill
    """
    try:
        authenticated = _is_authenticated(request)

        descriptors = EntityQueryService.list_all(kind=kind)
        manifests = [d.to_manifest() for d in descriptors]

        if kind == "skill" or kind is None:
            skill_manifests = _get_skill_manifests()
            if not authenticated:
                skill_manifests = [_sanitize_skill_manifest(m) for m in skill_manifests]
            if kind == "skill":
                manifests = skill_manifests
            else:
                manifests.extend(skill_manifests)

        return {
            "success": True,
            "data": manifests,
            "count": len(manifests),
        }
    except Exception:
        logger.exception("list_entities 失败")
        return {"success": False, "data": [], "count": 0, "message": "查询失败"}


@router.get("/{entity_id}/", auth=None, summary="获取单个实体详情")
def get_entity(request, entity_id: str) -> Dict[str, Any]:
    """获取单个实体详情（先查 EntityQueryService，再按 canonical key 查 Skill）。"""
    descriptor = EntityQueryService.get(entity_id)
    if descriptor is not None:
        return {"success": True, "data": descriptor.to_manifest()}

    skill_manifest = _get_skill_manifest_by_key(entity_id)
    if skill_manifest is not None:
        if not _is_authenticated(request):
            skill_manifest = _sanitize_skill_manifest(skill_manifest)
        return {"success": True, "data": skill_manifest}

    return {"success": False, "message": f"实体 '{entity_id}' 不存在"}


@router.get("/{entity_id}/config-schema/", auth=_jwt_auth, summary="获取实体配置 schema")
def get_entity_config_schema(request, entity_id: str) -> Dict[str, Any]:
    """获取实体的配置 schema（需登录）。"""
    schema = EntityQueryService.get_config_schema(entity_id)
    if schema is not None:
        return {"success": True, "data": schema}

    return {"success": False, "message": f"实体 '{entity_id}' 不存在"}


# ─── 内部辅助 ─────────────────────────────────────────────────


def _skill_to_manifest(skill) -> Dict[str, Any]:
    """把新 ``Skill`` 模型行渲染成 entity manifest 格式（kind: skill）。"""
    return {
        "id": skill.canonical_key,
        "name": skill.name,
        "version": str(skill.latest_version_seq) if skill.latest_version_seq else "0.0.0",
        "kind": "skill",
        "description": skill.description or "",
        "icon": skill.emoji or "",
        "distribution": skill.source or "user",
        "permissions": [],
        "skill": {
            "agents": list(skill.agents_json or []),
            "tags": [],
        },
    }


def _get_skill_manifests() -> List[Dict[str, Any]]:
    """从云端 ``Skill`` 表 + 本地 platform / app 索引获取所有 skill manifest。"""
    manifests: List[Dict[str, Any]] = []
    try:
        from apps.skills.models import Skill
        for skill in Skill.objects.all():
            manifests.append(_skill_to_manifest(skill))
    except Exception:
        logger.debug("获取 user Skill manifests 失败", exc_info=True)
    # platform / app 来源（不进 Skill 表）
    try:
        from apps.skills.services.registry_service import SkillsRegistryService
        for entry in SkillsRegistryService.list_platform_skills():
            manifests.append({
                "id": entry.get("skill_key") or entry.get("skill_id") or "",
                "name": entry.get("name") or entry.get("skill_id") or "",
                "version": entry.get("version") or "",
                "kind": "skill",
                "description": entry.get("description") or "",
                "icon": entry.get("emoji") or "",
                "distribution": "platform",
                "permissions": [],
                "skill": {"agents": [], "tags": entry.get("tags") or []},
            })
        for entry in SkillsRegistryService.list_app_skills():
            manifests.append({
                "id": entry.get("skill_key") or entry.get("skill_id") or "",
                "name": entry.get("name") or entry.get("skill_id") or "",
                "version": entry.get("version") or "",
                "kind": "skill",
                "description": entry.get("description") or "",
                "icon": entry.get("emoji") or "",
                "distribution": "app",
                "permissions": [],
                "skill": {"agents": [], "tags": entry.get("tags") or []},
            })
    except Exception:
        logger.debug("获取 platform / app Skill manifests 失败", exc_info=True)
    return manifests


def _get_skill_manifest_by_key(skill_key: str) -> Optional[Dict[str, Any]]:
    """根据 canonical key 获取单个 skill manifest。"""
    if not skill_key:
        return None
    try:
        from apps.skills.models import Skill
        # canonical key 形态 user:<slug>
        if skill_key.startswith("user:"):
            slug = skill_key.split(":", 1)[1]
            skill = Skill.objects.filter(slug=slug).first()
            if skill:
                return _skill_to_manifest(skill)
    except Exception:
        logger.debug("获取 user Skill manifest 失败 (key=%s)", skill_key, exc_info=True)

    try:
        from apps.skills.services.package_loader import SkillPackageLoader
        package = SkillPackageLoader.load(skill_key)
        if package:
            return {
                "id": skill_key,
                "name": package.name,
                "version": package.version or "",
                "kind": "skill",
                "description": package.description or "",
                "icon": "",
                "distribution": package.source or "platform",
                "permissions": [],
                "skill": {"agents": [], "tags": []},
            }
    except Exception:
        logger.debug("Skill loader 查 manifest 失败 (key=%s)", skill_key, exc_info=True)
    return None

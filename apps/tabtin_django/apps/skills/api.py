"""Skills HTTP API（Wave 1，PRD V3.3；#7118 硬切 organization_id + agent_id）。

#7118：``space_id`` 硬切下线——所有 Skill HTTP 端点以 ``organization_id`` 做
成员鉴权，``agent_id`` 做 Skill 归属身份。sandbox 落盘按 (user[, organization])
两层布局。

端点：
- ``GET  /skills/visible?organization_id=...&agent_id=...`` — 列出可见 skill
- ``POST /skills/create`` — 创建新 user 来源 skill（默认停用）
- ``POST /skills/{skill_canonical_key}/enable`` — 启用 skill
- ``POST /skills/{skill_canonical_key}/disable`` — 禁用 skill
- ``PATCH /skills/{skill_id}/visibility`` — 改可见范围（仅 owner）
- ``DELETE /skills/{skill_id}/draft`` — 丢弃从未发布的草稿

兼容端点：
- ``GET  /skills/index?organization_id=...&agent_id=...`` — Agent runtime 用
- ``GET  /skills/registry?organization_id=...&agent_id=...`` — UI 字段配置面板用
- ``GET  /skills/market`` — Marketplace 浏览
- ``GET  /skills/config?organization_id=...&agent_id=...`` — 列 AgentSkillLink.config_json
- ``PATCH /skills/config/{skill_canonical_key}`` — 更新 AgentSkillLink.config_json
"""

from __future__ import annotations

import logging
import os
from typing import Optional
from uuid import UUID

from ninja import Body
from django.http import HttpRequest

from apps.services.common.api.router_factory import TabTinRouter
from apps.users.auth.permissions import JWTAuth
from apps.i18n.response import (
    success_response,
    permission_denied_response,
    validation_error_response,
    not_found_response,
    error_response_with_status,
)
from apps.skills.schemas import (
    SkillActivateVersionRequest,
    SkillCreateRequest,
    SkillConfigUpdateRequest,
    SkillVisibilityRequest,
    SkillCategoryUpdateRequest,
    SkillQuickUseUpdateRequest,
    SkillPublishRequest,
    SkillUpgradeRequest,
    SkillImportRequest,
)
from apps.skills.services.registry_service import (
    SkillsRegistryService,
    SOURCE_USER,
    normalize_skill_source,
)
from apps.skills.services.skill_service import (
    SANDBOX_SKILLS_SEGMENT,
    SANDBOX_ORGANIZATIONS_SEGMENT,
    SANDBOX_USERS_SEGMENT,
    SANDBOX_ROOT_DEFAULT,
    SANDBOX_ROOT_ENV_VAR,
    SkillService,
    SkillNotFoundError,
    SkillServiceError,
    SkillVersionConflictError,
    SkillPermissionError,
)
from apps.skills.services.stats_service import SkillStatsService
from apps.skills.services.space_context import SkillSpaceContextError

logger = logging.getLogger("skills.api")


MARKET_CATEGORY_TAG_ALIASES = {
    "productivity": {
        "productivity", "document", "knowledge", "search", "memo", "note",
        "mail", "email", "inbox", "task", "tracking", "table", "workspace",
        "file", "management", "layout",
    },
    "ai_media": {
        "ai_media", "media", "video", "creation", "html", "tts", "slide",
        "presentation", "visualization", "svg",
    },
    "developer": {
        "developer", "development", "code", "terminal", "shell", "pty",
        "git", "mcp", "automation", "workspace",
    },
    "lifestyle": {"lifestyle"},
}


def _matches_market_category(entry: dict, category: Optional[str]) -> bool:
    if not category or category == "all":
        return True
    tags = {str(tag).lower() for tag in (entry.get("tags") or [])}
    aliases = MARKET_CATEGORY_TAG_ALIASES.get(category, {category})
    return bool(tags.intersection(aliases))


def _slugify_search_title(value: str) -> str:
    chars = []
    prev_dash = False
    for ch in (value or "").strip().lower():
        if ch.isalnum():
            chars.append(ch)
            prev_dash = False
        elif ch in {" ", "-", "_", "/", "\\"} and not prev_dash:
            chars.append("-")
            prev_dash = True
    return "".join(chars).strip("-") or "skill"


def _slash_title_from_entry(entry: dict) -> str:
    key = str(entry.get("skill_key") or "").strip()
    if key:
        if key.startswith("user:"):
            return f"/{_slugify_search_title(key[len('user:'):])}"
        if ":" in key:
            prefix, path = key.split(":", 1)
            segments = [segment for segment in path.split("/") if segment]
            segment = "-".join(segments) if prefix == "platform" and len(segments) > 1 else (segments[-1] if segments else path)
            return f"/{_slugify_search_title(segment)}"
        return f"/{_slugify_search_title(key)}"
    for field in ("slug", "name", "skill_id"):
        value = str(entry.get(field) or "").strip()
        if value:
            return f"/{_slugify_search_title(value)}"
    return "/skill"


def _matches_market_search(entry: dict, search: str) -> bool:
    if not search:
        return True
    command_query = search.startswith("/")
    command_stem = search[1:] if command_query else search
    title_candidates = (
        _slash_title_from_entry(entry),
        str(entry.get("display_name") or ""),
        str(entry.get("name") or ""),
    )
    if any(
        search in title.lower()
        or (command_query and bool(command_stem) and command_stem in title.lower())
        for title in title_candidates
    ):
        return True
    return search in str(entry.get("description") or "").lower()


def _check_organization_member(user, organization_id: Optional[str]) -> bool:
    """校验用户是否为指定 Organization 的成员（ 唯一鉴权闸门）。"""
    if not user or not organization_id:
        return False
    try:
        from django.db.models import Q
        from apps.tabtinspace.models import Organization
        uid = getattr(user, "id", None)
        if not uid:
            return False
        return Organization.objects.filter(
            Q(id=organization_id, owner_id=uid)
            | Q(id=organization_id, members__user_id=uid),
        ).exists()
    except Exception:
        logger.warning("[Skills] organization member check failed", exc_info=True)
        return False


def _require_organization_member(user, organization_id: Optional[str]):
    """便捷网关：解析成员身份，返回响应体（若拒绝）或 None（若通过）。"""
    if not organization_id:
        return validation_error_response("organization_id is required")
    if not _check_organization_member(user, str(organization_id)):
        return permission_denied_response("Not a member of this organization")
    return None


def _require_visibility_scope_member(user, *, _skill_id: UUID, payload: SkillVisibilityRequest):
    """共享到组织时必须同时满足 owner + organization 成员上下文。

    Service 层负责 owner 校验；API 层只给 organization 共享入口加额外组织闸，
    避免 owner 把 Skill 共享进自己不属于的组织。下架回 private 仍要保留出口：
    owner 离开组织后也应能收回自己的 Skill。
    """
    from apps.skills.models import Skill

    target = (payload.visibility or "").strip().lower()
    if target == Skill.VISIBILITY_ORGANIZATION:
        return _require_organization_member(user, payload.organization_id)
    return None


def _sandbox_path_for_skill(*, owner_user_id: str, organization_id: Optional[str], slug: str) -> str:
    """新建响应里的 sandbox 路径提示（保持 API 契约与 skill_service 落盘一致）。"""
    sandbox_root = os.environ.get(SANDBOX_ROOT_ENV_VAR, SANDBOX_ROOT_DEFAULT)
    segments = [sandbox_root, SANDBOX_USERS_SEGMENT, str(owner_user_id)]
    if organization_id:
        segments += [SANDBOX_ORGANIZATIONS_SEGMENT, str(organization_id)]
    segments += [SANDBOX_SKILLS_SEGMENT, slug]
    return os.path.join(*segments)


router = TabTinRouter(tags=["Skills"])
jwt_auth = JWTAuth()


# ---------------------------------------------------------------------------
# Skill 使用统计 API
# ---------------------------------------------------------------------------


@router.get(
    "/stats/top",
    response={200: dict},
    auth=jwt_auth,
    summary="热门 Skill 排行",
)
def get_top_skills(
    request: HttpRequest,
    organization_id: Optional[str] = None,
    limit: int = 10,
    days: int = 30,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    if organization_id and not _check_organization_member(user, organization_id):
        return permission_denied_response("Not a member of this organization")
    if limit < 1 or limit > 100:
        return validation_error_response("limit must be between 1 and 100")
    if days < 1 or days > 365:
        return validation_error_response("days must be between 1 and 365")

    try:
        skills = SkillStatsService.get_top_skills(
            organization_id=organization_id,
            limit=limit,
            days=days,
        )
    except Exception:
        logger.exception("[Skills] get_top_skills failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="统计数据暂时不可用", status_code=500,
        )

    return success_response({"skills": skills})


@router.get(
    "/stats/team-installs",
    response={200: dict},
    auth=jwt_auth,
    summary="团队安装洞察",
)
def get_team_installs(request: HttpRequest, organization_id: str):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, organization_id)
    if denial is not None:
        return denial

    try:
        installs = SkillStatsService.get_team_installs(organization_id=organization_id)
    except Exception:
        logger.exception("[Skills] get_team_installs failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="统计数据暂时不可用", status_code=500,
        )

    return success_response({"installs": installs})


# ---------------------------------------------------------------------------
# /skills/visible — Wave 1 核心新端点（PRD §9.1）
# ---------------------------------------------------------------------------


@router.get(
    "/visible",
    response={200: dict},
    auth=jwt_auth,
    summary="列出当前 (organization[, agent]) 可见的所有 Skill",
)
def list_visible_skills(
    request: HttpRequest,
    organization_id: str,
    agent_id: Optional[str] = None,
):
    """列出可见 skill 给 UI Skill 面板（含未启用，附带 enabled 标记）。"""
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, organization_id)
    if denial is not None:
        return denial

    try:
        skills = SkillService.list_visible_skills(
            user_id=str(getattr(user, "id", "")),
            organization_id=organization_id,
            agent_id=agent_id,
        )
        # ：本机 platform/app/device catalog 在客户端合并，后端 list 不带这些行；
        # 额外下发 user_gates，供前端把用户总闸盖回本地条目。
        from apps.skills.services.user_preference_service import (
            UserSkillPreferenceService,
        )
        user_gates = UserSkillPreferenceService.map_for_user(getattr(user, "id", None))
    except (SkillServiceError, SkillSpaceContextError) as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] list_visible_skills failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="无法加载 Skill 列表", status_code=500,
        )

    return success_response({"skills": skills, "user_gates": user_gates})


# ---------------------------------------------------------------------------
# 创建 / 启用 / 禁用 / visibility / 丢弃草稿
# ---------------------------------------------------------------------------


@router.post(
    "/create",
    response={200: dict},
    auth=jwt_auth,
    summary="创建新 user 来源 Skill（默认停用）",
)
def create_skill(request: HttpRequest, payload: SkillCreateRequest):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial

    try:
        enable_agent_ids = SkillService._resolve_enable_agent_targets(
            user_id=getattr(user, "id", None),
            enable_agent_ids=getattr(payload, "enable_agent_ids", None),
        )
        skill = SkillService.create_user_skill(
            owner_user_id=getattr(user, "id", None),
            organization_id=payload.organization_id,
            agent_id=payload.agent_id,
            name=payload.name,
            description=payload.description or "",
            slug=payload.slug,
            slug_conflict_policy=payload.slug_conflict_policy,
            emoji=payload.emoji or "",
            category=payload.category or "",
        )
        enabled_ids = SkillService._apply_enable_agent_ids(
            user_id=getattr(user, "id", None),
            skill=skill,
            enable_agent_ids=enable_agent_ids,
        )
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] create_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="创建 Skill 失败", status_code=500,
        )

    entry = skill.to_index_entry()
    entry["installed"] = True
    entry["enabled"] = False
    entry["agent_enabled"] = False
    if enabled_ids:
        entry["enabled_agent_ids"] = enabled_ids
    skeleton = SkillService.generate_skill_skeleton(
        payload.name,
        payload.description or "",
        category=payload.category or "",
        slug=skill.slug,
    )
    entry["skeleton_content"] = skeleton
    entry["normalized_files"] = [{"path": "SKILL.md", "content": skeleton}]
    # 新建 skill 默认 private → 落在个人 sandbox；组织共享由 set_visibility 显式切换。
    entry["sandbox_path"] = _sandbox_path_for_skill(
        owner_user_id=str(getattr(user, "id", "")),
        organization_id=None,
        slug=skill.slug,
    )
    return success_response(entry)


@router.post(
    "/{path:skill_canonical_key}/enable",
    response={200: dict},
    auth=jwt_auth,
    summary="启用 Skill（PRD §6.5 / D3）",
)
def enable_skill(
    request: HttpRequest,
    skill_canonical_key: str,
    payload: dict | None = Body(None),
    organization_id: Optional[str] = None,
):
    """打开用户级技能库总闸；可选传 ``agent_id`` 同时打开子开关。"""
    user = request.auth
    if not user:
        return permission_denied_response("Need login")

    body = payload if isinstance(payload, dict) else {}
    effective_org_id = body.get("organization_id") or organization_id
    denial = _require_organization_member(user, effective_org_id)
    if denial is not None:
        return denial

    body_agent_id = body.get("agent_id")
    body_agents = body.get("agents")

    try:
        row = SkillService.enable_skill(
            user_id=getattr(user, "id", None),
            skill_canonical_key=skill_canonical_key,
            agent_id=body_agent_id,
            organization_id=effective_org_id,
            source_skill_id=body.get("source_skill_id"),
            acquire_as_copy=bool(body.get("acquire_as_copy")),
            device_agents=body_agents if isinstance(body_agents, list) else None,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] enable_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="启用失败", status_code=500,
        )

    package_id = None
    if row.skill_id:
        from apps.skills.models import Skill as SkillModel
        package_id = (
            SkillModel.objects.filter(skill_id=row.skill_id)
            .values_list("package_id", flat=True)
            .first()
        )
    state: dict = {}
    if body_agent_id:
        state = SkillsRegistryService.resolve_agent_skill_state(
            None,
            agent_id=str(body_agent_id),
            user_id=str(getattr(user, "id", "")),
        ).get(row.skill_canonical_key, {})
    return success_response({
        "skill_canonical_key": row.skill_canonical_key,
        "enabled": True,
        "source": row.source or skill_canonical_key.partition(":")[0],
        "package_id": str(package_id) if package_id else None,
        "installed_version_seq": state.get("installed_version_seq"),
        "install_content_hash": state.get("install_content_hash"),
        "installed_on_device": state.get("installed_on_device", False),
        "agents_sync": row.agents_sync,
        # 可加性字段：组织精选接入后返回个人快照，供新客户端按新 key 物化；
        # 旧客户端继续读取上面的既有字段，不受影响。
        "skill": row.skill,
    })


@router.post(
    "/{path:skill_canonical_key}/disable",
    response={200: dict},
    auth=jwt_auth,
    summary="停用 / 卸载 Skill",
)
def disable_skill(
    request: HttpRequest,
    skill_canonical_key: str,
    payload: dict | None = Body(None),
    organization_id: Optional[str] = None,
):
    """关闭用户级总闸；``remove=True`` 时另摘除该用户名下 Agent 携带行。"""
    user = request.auth
    if not user:
        return permission_denied_response("Need login")

    body = payload if isinstance(payload, dict) else {}
    effective_org_id = body.get("organization_id") or organization_id
    denial = _require_organization_member(user, effective_org_id)
    if denial is not None:
        return denial

    remove = bool(body.get("remove"))
    # 只有卸载/删除接入关系时才允许忘记 acquisition；普通停用仍保留「我的」归属。
    forget_acquisition = remove and bool(body.get("forget_acquisition"))

    try:
        ok = SkillService.disable_skill(
            user_id=getattr(user, "id", None),
            skill_canonical_key=skill_canonical_key,
            remove=remove,
            forget_acquisition=forget_acquisition,
        )
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] disable_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="禁用失败", status_code=500,
        )

    return success_response({
        "skill_canonical_key": skill_canonical_key,
        "enabled": False,
        "found": ok,
    })


@router.patch(
    "/{skill_id}/visibility",
    response={200: dict},
    auth=jwt_auth,
    summary="切换 Skill 可见范围（仅 owner，D5 / §6.4）",
)
def update_skill_visibility(
    request: HttpRequest,
    skill_id: UUID,
    payload: SkillVisibilityRequest,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_visibility_scope_member(user, _skill_id=skill_id, payload=payload)
    if denial is not None:
        return denial

    try:
        skill = SkillService.set_visibility(
            skill_id=skill_id,
            owner_user_id=getattr(user, "id", None),
            visibility=payload.visibility,
            organization_id=payload.organization_id,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillServiceError as exc:
        return permission_denied_response(str(exc))
    except Exception:
        logger.exception("[Skills] update_skill_visibility failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="切换可见范围失败", status_code=500,
        )

    return success_response(skill.to_index_entry())


@router.patch(
    "/{skill_id}/category",
    response={200: dict},
    auth=jwt_auth,
    summary="修改 Skill 分类（仅 owner）",
)
def update_skill_category(
    request: HttpRequest,
    skill_id: UUID,
    payload: SkillCategoryUpdateRequest,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial

    try:
        skill = SkillService.set_category(
            skill_id=skill_id,
            owner_user_id=getattr(user, "id", None),
            category=payload.category,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] update_skill_category failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="修改分类失败", status_code=500,
        )

    return success_response(skill.to_index_entry())


@router.patch(
    "/{skill_id}/quick-use",
    response={200: dict},
    auth=jwt_auth,
    summary="更新「快速使用」模板草稿（仅 owner）",
)
def update_skill_quick_use(
    request: HttpRequest,
    skill_id: UUID,
    payload: SkillQuickUseUpdateRequest,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial

    quick_use = (
        [p.dict() for p in payload.quick_use] if payload.quick_use is not None else None
    )
    try:
        skill = SkillService.set_quick_use(
            skill_id=skill_id,
            owner_user_id=getattr(user, "id", None),
            quick_use=quick_use,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] update_skill_quick_use failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="更新快速使用模板失败", status_code=500,
        )

    return success_response(skill.to_index_entry())


@router.post(
    "/{skill_id}/publish",
    response={200: dict},
    auth=jwt_auth,
    summary="发布新版本（仅 owner，PRD §6.3）",
)
def publish_skill(request: HttpRequest, skill_id: UUID, payload: SkillPublishRequest):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial

    quick_use = (
        [p.dict() for p in payload.quick_use] if payload.quick_use is not None else None
    )
    try:
        result = SkillService.publish_skill(
            skill_id=skill_id,
            owner_user_id=getattr(user, "id", None),
            organization_id=payload.organization_id,
            agent_id=payload.agent_id,
            version_label=payload.version_label,
            visibility=payload.visibility,
            change_note=payload.change_note or "",
            files=payload.files,
            quick_use=quick_use,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillVersionConflictError as exc:
        return validation_error_response(str(exc), data=exc.response_data())
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception as exc:
        from apps.skills.services.publish_service import (
            SkillPermissionError as PublishSkillPermissionError,
            SkillPublishError,
        )
        if isinstance(exc, PublishSkillPermissionError):
            return permission_denied_response(str(exc))
        if isinstance(exc, SkillPublishError):
            return validation_error_response(str(exc))
        logger.exception("[Skills] publish_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="发布失败", status_code=500,
        )

    return success_response(result)


@router.delete(
    "/{skill_id}/draft",
    response={200: dict},
    auth=jwt_auth,
    summary="丢弃从未发布过的草稿（D15）",
)
def discard_draft(request: HttpRequest, skill_id: UUID):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")

    try:
        SkillService.discard_draft(
            owner_user_id=getattr(user, "id", None),
            skill_id=skill_id,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] discard_draft failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="丢弃失败", status_code=500,
        )

    return success_response({"skill_id": str(skill_id), "discarded": True})


# ---------------------------------------------------------------------------
# 版本列表 / 升级 / 导入
# ---------------------------------------------------------------------------


@router.get(
    "/{skill_id}/versions",
    response={200: dict},
    auth=jwt_auth,
    summary="已发布版本列表（PRD §9.1）",
)
def list_skill_versions(request: HttpRequest, skill_id: UUID):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    try:
        versions = SkillService.list_versions(
            skill_id=skill_id,
            requesting_user_id=getattr(user, "id", None),
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except Exception:
        logger.exception("[Skills] list_versions failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="获取版本列表失败", status_code=500,
        )
    return success_response({"versions": versions})


@router.post(
    "/{skill_id}/activate-version",
    response={200: dict},
    auth=jwt_auth,
    summary="切换当前 Agent 使用的 Skill 版本（仅 owner，不创建新版本）",
)
def activate_skill_version(
    request: HttpRequest,
    skill_id: UUID,
    payload: SkillActivateVersionRequest,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial
    try:
        result = SkillService.activate_skill_version(
            skill_id=skill_id,
            owner_user_id=getattr(user, "id", None),
            agent_id=payload.agent_id,
            version_seq=payload.version_seq,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] activate_skill_version failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="切换版本失败", status_code=500,
        )
    return success_response(result)


@router.post(
    "/{skill_id}/upgrade",
    response={200: dict},
    auth=jwt_auth,
    summary="触发升级（PRD §6.6 / §6.7 三选一）",
)
def upgrade_skill(request: HttpRequest, skill_id: UUID, payload: SkillUpgradeRequest):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial
    try:
        result = SkillService.upgrade_skill(
            skill_id=skill_id,
            user_id=getattr(user, "id", None),
            agent_id=payload.agent_id,
            resolution=payload.resolution,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] upgrade_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="升级失败", status_code=500,
        )
    return success_response(result)


@router.post(
    "/import",
    response={200: dict},
    auth=jwt_auth,
    summary="导入 Skill（批量 items[]；旧扁平字段兼容）",
)
def import_skill(request: HttpRequest, payload: SkillImportRequest):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial

    items: list = []
    raw_items = getattr(payload, "items", None)
    if raw_items:
        for it in raw_items:
            if hasattr(it, "dict"):
                items.append(it.dict())
            elif isinstance(it, dict):
                items.append(it)
            else:
                items.append({
                    "source_skill_id": getattr(it, "source_skill_id", None),
                    "name": getattr(it, "name", None),
                    "url": getattr(it, "url", None),
                    "files": getattr(it, "files", None),
                    "enable_agent_ids": getattr(it, "enable_agent_ids", None),
                })
    elif payload.files or payload.url or payload.source_skill_id:
        items.append({
            "source_skill_id": payload.source_skill_id,
            "name": payload.name,
            "url": payload.url,
            "files": payload.files,
            "enable_agent_ids": getattr(payload, "enable_agent_ids", None),
        })
    else:
        return validation_error_response(
            "导入请求缺少来源（items 或 source_skill_id / url / files）"
        )

    try:
        batch = SkillService.import_skills_batch(
            user_id=getattr(user, "id", None),
            organization_id=payload.organization_id,
            agent_id=payload.agent_id,
            items=items,
        )
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] import_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="导入失败", status_code=500,
        )

    data: dict = {
        "results": batch["results"],
        "summary": batch["summary"],
    }
    if len(batch["results"]) == 1 and batch["results"][0].get("ok"):
        first = batch["results"][0]
        skill_entry = first.get("skill") or {}
        data.update(skill_entry)
        data["already_exists"] = first.get("already_exists", False)
        if first.get("normalized_files"):
            data["normalized_files"] = first["normalized_files"]
        if first.get("enabled_agent_ids"):
            data["enabled_agent_ids"] = first["enabled_agent_ids"]
    return success_response(data)


@router.get(
    "/{skill_id}/export",
    auth=jwt_auth,
    summary="导出 Skill 为 agentskills.io 标准包（仅 owner）",
)
def export_skill(request: HttpRequest, skill_id: UUID):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    try:
        zip_bytes, filename = SkillService.export_skill(
            skill_id=skill_id,
            requesting_user_id=getattr(user, "id", None),
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] export_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="导出失败", status_code=500,
        )
    from django.http import HttpResponse
    from urllib.parse import quote
    skill_obj = __import__('apps.skills.models', fromlist=['Skill']).Skill.objects.filter(skill_id=skill_id).first()
    display_name = (skill_obj.name if skill_obj else None) or filename.replace('.zip', '')
    encoded_name = quote(f"{display_name}.zip")
    resp = HttpResponse(zip_bytes, content_type="application/zip")
    resp["Content-Disposition"] = (
        f'attachment; filename="{filename}"; '
        f"filename*=UTF-8''{encoded_name}"
    )
    return resp


# ---------------------------------------------------------------------------
# 兼容端点：UI / Agent runtime 现有调用面
# ---------------------------------------------------------------------------


@router.get(
    "/index",
    response={200: dict},
    auth=jwt_auth,
    summary="Get available Skills index (merged, enabled-filtered)",
)
def get_skills_index(
    request: HttpRequest,
    organization_id: str,
    agent_id: Optional[str] = None,
):
    """Agent runtime 用：用户总闸 AND Agent 携带过滤后的 skill 索引。"""
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, organization_id)
    if denial is not None:
        return denial
    try:
        skills = SkillsRegistryService.list_available_skills(
            user_id=str(getattr(user, "id", "")),
            organization_id=str(organization_id),
            agent_id=agent_id,
        )
    except (SkillServiceError, SkillSpaceContextError) as exc:
        return validation_error_response(str(exc))
    return success_response({"skills": skills})


@router.get(
    "/registry",
    response={200: dict},
    auth=jwt_auth,
    summary="List skills from registry (UI 字段配置面板)",
)
def list_skill_registry(
    request: HttpRequest,
    organization_id: Optional[str] = None,
    agent_id: Optional[str] = None,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    if organization_id and not _check_organization_member(user, str(organization_id)):
        return permission_denied_response("Not a member of this organization")

    items: list = []
    seen: set = set()

    if organization_id:
        try:
            indexed = SkillService.list_visible_skills(
                user_id=str(getattr(user, "id", "")),
                organization_id=str(organization_id),
                agent_id=agent_id,
            )
            for skill in indexed:
                skill_id = skill.get("skill_id", "")
                if not skill_id or skill_id in seen:
                    continue
                seen.add(skill_id)
                items.append({
                    "app_id": skill_id,
                    "skill_key": skill.get("skill_key", ""),
                    "name": skill.get("name", skill_id),
                    "description": skill.get("description", ""),
                    "source": normalize_skill_source(skill.get("source", "")),
                    "version": skill.get("version", ""),
                    "emoji": skill.get("emoji", ""),
                })
        except (SkillServiceError, SkillSpaceContextError) as exc:
            return validation_error_response(str(exc))

    return success_response({"items": items})


@router.get(
    "/market",
    response={200: dict},
    auth=jwt_auth,
    summary="Browse skills available to install (visibility=public approved)",
)
def list_market_skills(
    request: HttpRequest,
    q: Optional[str] = None,
    category: Optional[str] = None,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")

    # Skill 市场只展示可安装商品：
    # - distribution=marketplace 的 App Skill Pack
    # - visibility=public 且审核通过的 user skill
    # 内置 platform / 随 App 走的 builtin Operator 不进货架（在已安装面板管理）。
    app_skills = SkillsRegistryService.list_app_skills()

    all_skills: list = []
    seen: set = set()
    for entry in app_skills:
        if entry.get("distribution") != "marketplace":
            continue
        sid = entry.get("skill_id") or entry.get("name") or ""
        if not sid or sid in seen:
            continue
        seen.add(sid)
        entry = dict(entry)
        entry["installed"] = False
        all_skills.append(entry)

    try:
        from apps.skills.models import Skill, SkillPublishedVersion
        from django.db.models import Exists, OuterRef
        approved = SkillPublishedVersion.objects.filter(
            skill=OuterRef("pk"),
            review_status=SkillPublishedVersion.REVIEW_APPROVED,
        )
        public_qs = Skill.objects.filter(
            visibility=Skill.VISIBILITY_PUBLIC,
        ).annotate(has_approved=Exists(approved)).filter(has_approved=True)
        for skill in public_qs:
            entry = skill.to_index_entry()
            sid = entry.get("skill_id") or entry.get("name") or ""
            if sid and sid in seen:
                continue
            if sid:
                seen.add(sid)
            entry["installed"] = False
            all_skills.append(entry)
    except Exception:
        logger.debug("[Skills] public marketplace query failed", exc_info=True)

    search = (q or "").strip().lower()
    if search:
        all_skills = [
            s for s in all_skills
            if _matches_market_search(s, search)
        ]

    if category:
        all_skills = [
            s for s in all_skills
            if _matches_market_category(s, category)
        ]

    return success_response({"skills": all_skills, "total": len(all_skills)})


# ---------------------------------------------------------------------------
# Per-Skill Configuration（AgentSkillLink.config_json）
# ---------------------------------------------------------------------------


@router.get(
    "/config",
    response={200: dict},
    auth=jwt_auth,
    summary="Get all per-skill configs for an agent",
)
def get_skill_configs(request: HttpRequest, organization_id: str, agent_id: str):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, organization_id)
    if denial is not None:
        return denial

    try:
        from apps.skills.models import AgentSkillLink
        rows = AgentSkillLink.objects.filter(agent_id=agent_id)
        configs: dict = {}
        for row in rows:
            cfg = dict(row.config_json or {})
            cfg["enabled"] = bool(row.enabled)
            configs[row.skill_canonical_key] = cfg
        return success_response({"configs": configs})
    except Exception:
        logger.exception("[Skills] get_skill_configs failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="加载配置失败", status_code=500,
        )


@router.patch(
    "/config/{path:skill_canonical_key}",
    response={200: dict},
    auth=jwt_auth,
    summary="Update per-skill config（AgentSkillLink.config_json）",
)
def update_skill_config(
    request: HttpRequest,
    skill_canonical_key: str,
    payload: SkillConfigUpdateRequest,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    denial = _require_organization_member(user, payload.organization_id)
    if denial is not None:
        return denial

    if payload.skill_canonical_key and payload.skill_canonical_key != skill_canonical_key:
        return validation_error_response(
            "payload.skill_canonical_key 与 URL path 中的 skill_canonical_key 不一致"
        )

    try:
        from apps.skills.services.agent_link_writer import (
            AgentSkillLinkCredentialError,
            AgentSkillLinkLockedError,
            AgentSkillLinkWriter,
            AgentSkillLinkWriterError,
            AgentSkillLinkWriterNotFoundError,
            DEFAULT_AGENT_SKILL_LOCKED_CODE,
        )
        from apps.agent.models import Agent as AgentModel
        from apps.tabtinspace.services.app_settings_service import AppSettingsService

        agent = AgentModel.objects.filter(id=payload.agent_id).first()
        if agent is None:
            return validation_error_response(f"Agent 不存在: {payload.agent_id}")
        sync_space_id = AgentSkillLinkWriter.resolve_sync_space_id(agent)
        row = AgentSkillLinkWriter.merge_config(
            agent_id=agent.id,
            skill_canonical_key=skill_canonical_key,
            requesting_user_id=getattr(user, "id", None),
            sync_space_id=sync_space_id,
            enabled=payload.enabled,
            credential_id=payload.credential_id,
            env=payload.env,
            config=payload.config,
        )
        cfg = dict(row.config_json or {})
        return success_response({
            "skill_canonical_key": skill_canonical_key,
            "config": {**cfg, "enabled": row.enabled},
        })
    except AgentSkillLinkWriterNotFoundError as exc:
        return validation_error_response(str(exc))
    except AgentSkillLinkLockedError as exc:
        return error_response_with_status(
            getattr(exc, "code", DEFAULT_AGENT_SKILL_LOCKED_CODE),
            message=str(exc),
            status_code=400,
        )
    except AgentSkillLinkCredentialError as exc:
        if exc.err_code == AppSettingsService.CRED_ERR_DB_ERROR:
            return error_response_with_status(
                exc.err_code, message=str(exc), status_code=503,
            )
        return error_response_with_status(
            exc.err_code, message=str(exc), status_code=400,
        )
    except AgentSkillLinkWriterError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] update_skill_config failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="更新配置失败", status_code=500,
        )


# ---------------------------------------------------------------------------
# Skill content / package（用于 UI 字段配置面板）
# ---------------------------------------------------------------------------


@router.get(
    "/{path:skill_canonical_key}/package",
    response={200: dict},
    auth=jwt_auth,
    summary="获取完整 Skill 包元数据",
)
def get_skill_package(
    request: HttpRequest,
    skill_canonical_key: str,
    organization_id: Optional[str] = None,
    skill_id: Optional[str] = None,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")

    if organization_id and not _check_organization_member(user, str(organization_id)):
        return permission_denied_response("Not a member of this organization")

    from apps.skills.services.package_loader import SkillPackageLoader
    package = SkillPackageLoader.load(
        skill_canonical_key,
        organization_id=organization_id,
        requesting_user_id=str(getattr(user, "id", "")),
        database_skill_id=skill_id,
    )
    if not package:
        return not_found_response(f"Skill not found: {skill_canonical_key}")

    return success_response({
        "skill_id": package.skill_id,
        "name": package.name,
        "description": package.description,
        "version": package.version,
        "source": normalize_skill_source(package.source or ""),
        "main_timeout": package.main_timeout,
        "agent_model": package.agent_model,
        "metadata": package.metadata,
        # 可加字段：旧客户端会忽略；组织精选详情用它读取已发布只读快照。
        "doc_content": package.doc_content or None,
    })


@router.get(
    "/{path:skill_canonical_key}/stats",
    response={200: dict},
    auth=jwt_auth,
    summary="单个 Skill 使用统计",
)
def get_skill_stats(
    request: HttpRequest,
    skill_canonical_key: str,
    organization_id: Optional[str] = None,
    days: int = 30,
):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")
    if organization_id and not _check_organization_member(user, organization_id):
        return permission_denied_response("Not a member of this organization")
    if days < 1 or days > 365:
        return validation_error_response("days must be between 1 and 365")

    try:
        stats = SkillStatsService.get_skill_stats(
            skill_key=skill_canonical_key,
            organization_id=organization_id,
            days=days,
        )
    except Exception:
        logger.exception("[Skills] get_skill_stats failed for %s", skill_canonical_key)
        return error_response_with_status(
            "INTERNAL_ERROR", message="统计数据暂时不可用", status_code=500,
        )

    return success_response(stats)


# 裸 `/{skill_id}` 必须注册在所有字面单段路径（/import /index /registry /market
# /config 等）之后。否则 Ninja 会把这些单段路径当成 skill_id 捕获，导致对应
# 非 DELETE 请求命中本路由的 method table 后返回 405。
@router.delete(
    "/{skill_id}",
    response={200: dict},
    auth=jwt_auth,
    summary="删除 owner 自己的 user skill（含已发布；他人携带不拦截）",
)
def delete_skill(request: HttpRequest, skill_id: UUID):
    user = request.auth
    if not user:
        return permission_denied_response("Need login")

    try:
        SkillService.delete_skill(
            owner_user_id=getattr(user, "id", None),
            skill_id=skill_id,
        )
    except SkillNotFoundError as exc:
        return not_found_response(str(exc))
    except SkillPermissionError as exc:
        return permission_denied_response(str(exc))
    except SkillServiceError as exc:
        return validation_error_response(str(exc))
    except Exception:
        logger.exception("[Skills] delete_skill failed")
        return error_response_with_status(
            "INTERNAL_ERROR", message="删除失败", status_code=500,
        )

    return success_response({"skill_id": str(skill_id), "deleted": True})


__all__ = ["router"]

"""
Capabilities Registry API — 工具中心 + 能力管理

路由前缀：/api/capabilities
"""

import logging
from typing import List, Optional

from django.db import transaction
from django.db.models import Q, Count
from ninja import Router, Schema

from apps.i18n import _
from apps.i18n.response import success_response, error_response
from apps.users.auth.permissions import JWTAuth

from apps.capabilities.constants import CAPABILITIES_DB as DB, MAX_PAGE_SIZE
from apps.capabilities.models import (
    RegisteredTool,
    ToolSkillLink,
    ToolSource,
    ToolStatus,
)
from apps.capabilities.schemas import (
    ToolOut,
    ToolBrief,
    ToolCreateIn,
    ToolUpdateIn,
    ToolSearchIn,
    SyncResult,
    ToolSkillLinkOut,
    ToolSkillLinkIn,
    DiscoverIn,
    CategoryStat,
    ProviderStat,
)

logger = logging.getLogger(__name__)

router = Router(tags=["Capabilities"])

jwt_auth = JWTAuth()


class AdminSensitiveReasonIn(Schema):
    status: str
    reason: str
    ticket_id: str = ""


def _ensure_reason(payload: AdminSensitiveReasonIn) -> str:
    reason = (payload.reason or "").strip()
    if not reason:
        raise ValueError("reason 必填")
    return reason


def _jsonable_snapshot(value: dict) -> dict:
    import json

    return json.loads(json.dumps(value, default=str))


def _record_tool_sensitive_action(
    request,
    *,
    action: str,
    target_id: str,
    permission_code: str,
    reason: str,
    ticket_id: str,
    before_json: dict,
    after_json: dict,
) -> None:
    """Record sensitive tool changes.

    Stacked branches may provide the canonical AdminSensitiveActionLog model.
    This branch falls back to UserActionLog when the common model is not present.
    """
    try:
        from apps.users.auth.admin_audit import record_admin_sensitive_action
    except (ImportError, ModuleNotFoundError):
        record_admin_sensitive_action = None

    if record_admin_sensitive_action is not None:
        record_admin_sensitive_action(
            request,
            permission_code=permission_code,
            action=action,
            target_type="tool",
            target_id=target_id,
            reason=reason,
            ticket_id=(ticket_id or "").strip(),
            before_json=_jsonable_snapshot(before_json),
            after_json=_jsonable_snapshot(after_json),
        )
        return

    from apps.users.auth.models import UserActionLog
    from apps.users.auth.utils import get_client_ip

    UserActionLog.objects.create(
        user=request.auth,
        action_type="profile_update",
        description=(
            f"敏感工具治理：{action} target={target_id} permission={permission_code} "
            f"ticket={(ticket_id or '').strip() or '-'} reason={reason}"
        ),
        ip_address=get_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", ""),
        request_data={
            "before_json": _jsonable_snapshot(before_json),
            "after_json": _jsonable_snapshot(after_json),
        },
        success=True,
    )


# ═══════════════════════════════════════════════════════════
# 工具 CRUD
# ═══════════════════════════════════════════════════════════

@router.get(
    "/tools",
    response={200: dict},
    auth=jwt_auth,
    summary="工具列表",
)
def list_tools(
    request,
    category: Optional[str] = None,
    provider_id: Optional[str] = None,
    domain: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
    tags: Optional[str] = None,
    q: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    page = max(1, page)
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))

    qs = RegisteredTool.objects.using(DB).all()

    if category:
        qs = qs.filter(category=category)
    if provider_id:
        qs = qs.filter(provider_id=provider_id)
    if domain:
        qs = qs.filter(domain=domain)
    if source:
        qs = qs.filter(source=source)
    if status:
        qs = qs.filter(status=status)
    else:
        qs = qs.exclude(status=ToolStatus.DEPRECATED)
    if tags:
        for tag in tags.split(","):
            qs = qs.filter(tags__contains=[tag.strip()])
    if q:
        qs = qs.filter(
            Q(name__icontains=q)
            | Q(display_name__icontains=q)
            | Q(description__icontains=q)
        )

    total = qs.count()
    offset = (page - 1) * page_size
    items = list(qs[offset: offset + page_size])

    return success_response({
        "items": [_tool_to_brief(t) for t in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


# ═══════════════════════════════════════════════════════════
# 字面量子路径（必须在 ``/tools/{tool_name}`` 通配符之前注册）
# ═══════════════════════════════════════════════════════════
# ⚠️ 路由顺序：``/tools/search`` / ``/tools/index`` / ``/tools/sync`` 这种字面量
# 路径必须在 ``/tools/{tool_name}`` 通配符**之前**注册（详见
# tabtinspace/routers/approval_memo.py 的同类注释）。否则 ninja 会把
# ``search`` / ``index`` / ``sync`` 当成 tool_name 字面量进入 GET/PATCH/DELETE
# 通配符路由，POST 永远 405。dogfood 验证铁证：修复前这 3 条 endpoint 全 405。
# 详情接口稍后再注册。

@router.post(
    "/tools/search",
    response={200: dict},
    auth=jwt_auth,
    summary="工具语义检索",
)
def search_tools(request, payload: ToolSearchIn):
    from apps.capabilities.services.tool_embedding import ToolEmbeddingService

    results = ToolEmbeddingService.search(
        query=payload.query,
        top_k=payload.top_k,
        category=payload.category,
        provider_id=payload.provider_id,
        domain=payload.domain,
    )
    return success_response({
        "query": payload.query,
        "results": results,
        "count": len(results),
    })


@router.post(
    "/tools/index",
    response={200: dict, 403: dict},
    auth=jwt_auth,
    summary="全量重建工具向量索引",
)
def index_tools(request):
    if not getattr(request.auth, "is_staff", False):
        return 403, error_response("FORBIDDEN", message=_("capabilities.admin_required"))
    from apps.capabilities.services.tool_embedding import ToolEmbeddingService

    stats = ToolEmbeddingService.index_all()
    return success_response(stats)


@router.post(
    "/tools/sync",
    response={200: dict, 403: dict},
    auth=jwt_auth,
    summary="手动触发工具同步",
)
def sync_tools(request):
    if not getattr(request.auth, "is_staff", False):
        return 403, error_response("FORBIDDEN", message=_("capabilities.admin_required"))
    from apps.services.tools import refresh_manifest_tools
    from apps.capabilities.services.tool_sync import ToolSyncService

    refresh_manifest_tools()
    stats = ToolSyncService.sync_all()
    return success_response(stats)


@router.get(
    "/tools/{tool_name}",
    response={200: dict},
    auth=jwt_auth,
    summary="工具详情",
)
def get_tool(request, tool_name: str):
    tool = RegisteredTool.objects.using(DB).filter(name=tool_name).first()
    if not tool:
        return 404, error_response("NOT_FOUND", message=_("capabilities.tool_not_found", name=tool_name))
    return success_response(_tool_to_detail(tool))


@router.post(
    "/tools",
    response={200: dict, 409: dict},
    auth=jwt_auth,
    summary="注册自定义工具",
)
def create_tool(request, payload: ToolCreateIn):
    if RegisteredTool.objects.using(DB).filter(name=payload.name).exists():
        return 409, error_response("CONFLICT", message=_("capabilities.tool_already_exists", name=payload.name))

    data = payload.dict()
    data["source"] = ToolSource.CUSTOM
    data["source_ref"] = f"api:user:{request.auth.id}"
    tool = RegisteredTool.objects.using(DB).create(**data)
    return success_response(_tool_to_detail(tool))


@router.patch(
    "/tools/{tool_name}",
    response={200: dict, 403: dict, 404: dict},
    auth=jwt_auth,
    summary="更新工具信息",
)
def update_tool(request, tool_name: str, payload: ToolUpdateIn):
    tool = RegisteredTool.objects.using(DB).filter(name=tool_name).first()
    if not tool:
        return 404, error_response("NOT_FOUND", message=_("capabilities.tool_not_found", name=tool_name))

    update_data = payload.dict(exclude_unset=True)
    if not update_data:
        return success_response(_tool_to_detail(tool))

    if tool.source != ToolSource.CUSTOM:
        _EDITABLE_FOR_BUILTIN = {"documentation", "examples", "tags", "optional"}
        forbidden = set(update_data.keys()) - _EDITABLE_FOR_BUILTIN
        if forbidden:
            return 403, error_response(
                "FORBIDDEN",
                message=_("capabilities.builtin_tool_readonly", fields=', '.join(sorted(forbidden))),
            )

    for field, value in update_data.items():
        setattr(tool, field, value)
    tool.save(using=DB)

    return success_response(_tool_to_detail(tool))


@router.delete(
    "/tools/{tool_name}",
    response={200: dict, 400: dict, 404: dict},
    auth=jwt_auth,
    summary="删除自定义工具",
)
def delete_tool(request, tool_name: str):
    tool = RegisteredTool.objects.using(DB).filter(name=tool_name).first()
    if not tool:
        return 404, error_response("NOT_FOUND", message=_("capabilities.tool_not_found", name=tool_name))
    if tool.source != ToolSource.CUSTOM:
        return 400, error_response("FORBIDDEN", message=_("capabilities.custom_tool_delete_only"))

    with transaction.atomic(using=DB):
        ToolSkillLink.objects.using(DB).filter(tool_name=tool_name).delete()
        from apps.capabilities.services.tool_embedding import ToolEmbeddingService
        ToolEmbeddingService.remove_tool(tool_name)
        tool.delete(using=DB)
    return success_response({"deleted": tool_name})


# ═══════════════════════════════════════════════════════════
# 语义检索 / 同步：``/tools/search`` / ``/tools/index`` / ``/tools/sync`` 已上移到
# ``/tools/{tool_name}`` 通配符之前注册（解决 ninja 路由顺序冲突导致 405）。
# ═══════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════
# 统一发现（同时搜索工具和 Skill）
# ═══════════════════════════════════════════════════════════

@router.post(
    "/discover",
    response={200: dict},
    auth=jwt_auth,
    summary="统一发现 — 同时搜索工具和 Skill",
)
def discover(request, payload: DiscoverIn):
    from apps.capabilities.services.discovery import DiscoveryService

    results = DiscoveryService.discover(
        query=payload.query,
        top_k=payload.top_k,
        include_tools=payload.include_tools,
        include_skills=payload.include_skills,
        category=payload.category,
    )
    return success_response(results)


@router.post(
    "/links/sync",
    response={200: dict, 403: dict},
    auth=jwt_auth,
    summary="全量同步 Skill-Tool 关联",
)
def sync_skill_links(request):
    if not getattr(request.auth, "is_staff", False):
        return 403, error_response("FORBIDDEN", message=_("capabilities.admin_required"))
    from apps.capabilities.services.skill_link_sync import SkillLinkSyncService

    SkillLinkSyncService.sync_all_managed_skills()
    SkillLinkSyncService.sync_all_bundled_skills()

    from apps.capabilities.models import ToolSkillLink
    count = ToolSkillLink.objects.using(DB).count()
    return success_response({"total_links": count})


# ═══════════════════════════════════════════════════════════
# 工具-Skill 关联
# ═══════════════════════════════════════════════════════════

@router.get(
    "/tools/{tool_name}/skills",
    response={200: dict},
    auth=jwt_auth,
    summary="获取工具关联的 Skill",
)
def get_tool_skills(request, tool_name: str):
    links = ToolSkillLink.objects.using(DB).filter(tool_name=tool_name)
    return success_response({
        "tool_name": tool_name,
        "skills": [
            {"skill_key": l.skill_key, "relation_type": l.relation_type}
            for l in links
        ],
    })


@router.get(
    "/skills/{skill_key}/tools",
    response={200: dict},
    auth=jwt_auth,
    summary="获取 Skill 关联的工具",
)
def get_skill_tools(request, skill_key: str):
    links = ToolSkillLink.objects.using(DB).filter(skill_key=skill_key)
    return success_response({
        "skill_key": skill_key,
        "tools": [
            {"tool_name": l.tool_name, "relation_type": l.relation_type}
            for l in links
        ],
    })


@router.post(
    "/links",
    response={200: dict, 409: dict},
    auth=jwt_auth,
    summary="创建工具-Skill 关联",
)
def create_link(request, payload: ToolSkillLinkIn):
    if ToolSkillLink.objects.using(DB).filter(
        tool_name=payload.tool_name, skill_key=payload.skill_key,
    ).exists():
        return 409, error_response("CONFLICT", message=_("capabilities.link_already_exists"))

    link = ToolSkillLink.objects.using(DB).create(
        tool_name=payload.tool_name,
        skill_key=payload.skill_key,
        relation_type=payload.relation_type,
    )
    return success_response({
        "tool_name": link.tool_name,
        "skill_key": link.skill_key,
        "relation_type": link.relation_type,
    })


@router.delete(
    "/links/{tool_name}/{skill_key}",
    response={200: dict, 404: dict},
    auth=jwt_auth,
    summary="删除工具-Skill 关联",
)
def delete_link(request, tool_name: str, skill_key: str):
    deleted, _by_label = (
        ToolSkillLink.objects.using(DB)
        .filter(tool_name=tool_name, skill_key=skill_key)
        .delete()
    )
    if not deleted:
        return 404, error_response("NOT_FOUND", message=_("capabilities.link_not_found"))
    return success_response({"deleted": True})


# ═══════════════════════════════════════════════════════════
# 统计
# ═══════════════════════════════════════════════════════════

@router.get(
    "/categories",
    response={200: dict},
    auth=jwt_auth,
    summary="分类统计",
)
def list_categories(request):
    qs = (
        RegisteredTool.objects.using(DB)
        .exclude(status=ToolStatus.DEPRECATED)
        .values("category")
        .annotate(tool_count=Count("id"))
        .order_by("category")
    )
    return success_response({
        "categories": [
            {"category": row["category"], "tool_count": row["tool_count"]}
            for row in qs
        ],
    })


@router.get(
    "/providers",
    response={200: dict},
    auth=jwt_auth,
    summary="提供者列表",
)
def list_providers(request):
    qs = (
        RegisteredTool.objects.using(DB)
        .exclude(status=ToolStatus.DEPRECATED)
        .values("provider_id", "category", "domain")
        .annotate(tool_count=Count("id"))
        .order_by("category", "provider_id")
    )

    providers = {}
    for row in qs:
        pid = row["provider_id"]
        if pid not in providers:
            providers[pid] = {
                "provider_id": pid,
                "category": row["category"],
                "tool_count": 0,
                "domains": [],
            }
        providers[pid]["tool_count"] += row["tool_count"]
        domain = row["domain"]
        if domain not in providers[pid]["domains"]:
            providers[pid]["domains"].append(domain)

    result = []
    for p in providers.values():
        p["domains"] = sorted(p["domains"])
        result.append(p)

    return success_response({"providers": result})


# ═══════════════════════════════════════════════════════════
# Agent 能力解析
# ═══════════════════════════════════════════════════════════

@router.post(
    "/agent/resolve",
    response={200: dict},
    auth=jwt_auth,
    summary="Agent 上下文能力解析",
)
def agent_resolve(request, payload: DiscoverIn):
    """Agent 根据当前上下文解析可用的工具和 Skill。

    与 /discover 不同，这个接口专为 Agent 运行时优化，
    返回简化的工具元数据 + 相关 Skill 推荐。
    """
    from apps.capabilities.services.agent_resolve import AgentResolveService

    tools = AgentResolveService.discover_tools(
        query=payload.query,
        top_k=payload.top_k,
        category=payload.category,
    )

    tool_names = [t["name"] for t in tools]
    related_skills = AgentResolveService.get_related_skills_for_tools(tool_names)

    return success_response({
        "query": payload.query,
        "tools": tools,
        "related_skills": related_skills,
    })


# ═══════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════

def _tool_to_brief(tool: RegisteredTool) -> dict:
    return {
        "id": str(tool.id),
        "name": tool.name,
        "display_name": tool.display_name,
        "description": tool.description,
        "category": tool.category,
        "provider_id": tool.provider_id,
        "domain": tool.domain,
        "tags": tool.tags or [],
        "interface_type": tool.interface_type,
        "execution_target": tool.execution_target,
        "risk_level": tool.risk_level,
        "optional": tool.optional,
        "source": tool.source,
        "status": tool.status,
    }


def _tool_to_detail(tool: RegisteredTool) -> dict:
    data = _tool_to_brief(tool)
    data.update({
        "parameters_schema": tool.parameters_schema or {},
        "return_schema": tool.return_schema or {},
        "permissions": tool.permissions or [],
        "source_ref": tool.source_ref,
        "version": tool.version,
        "documentation": tool.documentation,
        "examples": tool.examples or [],
        "created_at": tool.created_at.isoformat() if tool.created_at else "",
        "updated_at": tool.updated_at.isoformat() if tool.updated_at else "",
    })

    skills = ToolSkillLink.objects.using(DB).filter(tool_name=tool.name)
    data["linked_skills"] = [
        {"skill_key": l.skill_key, "relation_type": l.relation_type}
        for l in skills
    ]

    return data


# ═══════════════════════════════════════════════════════════
# Admin: 审计 API（需 is_staff）
# ═══════════════════════════════════════════════════════════

@router.get(
    "/admin/audit/tools",
    response={200: dict, 403: dict},
    auth=jwt_auth,
    summary="运行工具审计并返回 JSON 结果",
)
def audit_tools_api(
    request,
    domain: Optional[str] = None,
    tool: Optional[str] = None,
    source: Optional[str] = None,
):
    if not getattr(request.auth, "is_staff", False):
        return 403, error_response("FORBIDDEN", message=_("capabilities.admin_required"))

    from apps.capabilities.management.commands.audit_tools import (
        _collect_backend_tools,
        _collect_frontend_tools,
        _scan_all_skills,
        _build_coverage,
        _check_global,
        _check_backend_tool,
        _check_frontend_tool,
        FAIL, WARN, PASS, HINT, SKIP,
    )

    backend = _collect_backend_tools()
    frontend = _collect_frontend_tools()
    all_tools = backend + frontend
    all_names = {t["name"] for t in all_tools}
    skill_map = _scan_all_skills()
    coverage = _build_coverage(skill_map)

    global_checks = _check_global(backend, frontend, all_names, skill_map, coverage)
    global_results = [
        {"dimension": dim, "status": status, "message": msg}
        for dim, status, msg in global_checks
    ]

    filtered = all_tools
    if tool:
        filtered = [t for t in filtered if t["name"] == tool]
    if domain:
        filtered = [t for t in filtered if t.get("domain") == domain]
    if source:
        filtered = [t for t in filtered if t.get("source") == source]

    tool_results = []
    for t in filtered:
        if t["source"] == "backend":
            checks = _check_backend_tool(t)
        else:
            checks = _check_frontend_tool(t)

        sk = coverage.get(t["name"])
        has_skill = bool(sk)

        tool_results.append({
            "name": t["name"],
            "domain": t.get("domain", ""),
            "source": t["source"],
            "risk_level": t.get("risk_level", ""),
            "description": t.get("description", ""),
            "has_skill": has_skill,
            "skill_key": sk if isinstance(sk, str) else (sk[0] if isinstance(sk, list) and sk else ""),
            "checks": [
                {"status": s, "message": m, "category": c if len(entry) > 2 else ""}
                for entry in checks
                for s, m, c in [entry if len(entry) > 2 else (*entry, "")]
            ],
            "pass_count": sum(1 for s, *_ in checks if s == PASS),
            "fail_count": sum(1 for s, *_ in checks if s == FAIL),
            "warn_count": sum(1 for s, *_ in checks if s == WARN),
        })

    summary = {
        "total_tools": len(all_tools),
        "backend_count": len(backend),
        "frontend_count": len(frontend),
        "skill_count": len(skill_map),
        "covered_count": len(coverage),
        "total_pass": sum(t["pass_count"] for t in tool_results),
        "total_fail": sum(t["fail_count"] for t in tool_results),
        "total_warn": sum(t["warn_count"] for t in tool_results),
        "global_fail": sum(1 for r in global_results if r["status"] == FAIL),
        "global_warn": sum(1 for r in global_results if r["status"] == WARN),
    }

    domains = {}
    for t in all_tools:
        d = t.get("domain", "unknown")
        if d not in domains:
            domains[d] = {"domain": d, "source": t["source"][:2].upper(), "count": 0, "covered": 0}
        domains[d]["count"] += 1
        if t["name"] in coverage:
            domains[d]["covered"] += 1

    return success_response({
        "summary": summary,
        "global_checks": global_results,
        "domains": sorted(domains.values(), key=lambda x: x["domain"]),
        "tools": tool_results,
    })


@router.get(
    "/admin/audit/apps",
    response={200: dict, 403: dict, 404: dict},
    auth=jwt_auth,
    summary="运行 App 审计并返回 JSON 结果",
)
def audit_apps_api(request, app_id: Optional[str] = None):
    if not getattr(request.auth, "is_staff", False):
        return 403, error_response("FORBIDDEN", message=_("capabilities.admin_required"))

    from apps.capabilities.management.commands.audit_apps import (
        _LOAD_ERRORS, _audit_single_app, _check_global, _select_apps_for_audit,
        FAIL, WARN, PASS, HINT, SKIP,
    )
    distribution = request.GET.get("distribution") or "builtin"
    if distribution not in {"builtin", "marketplace", "all"}:
        distribution = "builtin"
    selected_apps = _select_apps_for_audit(distribution, app_id)
    if app_id and not selected_apps:
        return 404, error_response("NOT_FOUND", message=f"App '{app_id}' 不存在")
    apps_list = list(selected_apps.items())
    _LOAD_ERRORS.clear()

    results = []
    for aid, adef in apps_list:
        checks = _audit_single_app(aid, adef)
        results.append({
            "app_id": aid,
            "app_name": adef.name,
            "context_type": adef.context_type or "",
            "checks": [
                {"dimension": dim, "status": status, "message": msg}
                for dim, status, msg in checks
            ],
            "pass_count": sum(1 for _, s, _ in checks if s == PASS),
            "fail_count": sum(1 for _, s, _ in checks if s == FAIL),
            "warn_count": sum(1 for _, s, _ in checks if s == WARN),
            "total": len(checks),
        })

    global_checks = []
    if not app_id:
        global_checks = [
            {"dimension": dim, "status": status, "message": msg}
            for dim, status, msg in _check_global(selected_apps)
        ]
        if _LOAD_ERRORS:
            global_checks.extend([
                {"dimension": "全局", "status": FAIL, "message": f"[必填] 审计数据加载异常: {err}"}
                for err in _LOAD_ERRORS
            ])

    summary = {
        "total_apps": len(results),
        "total_pass": sum(r["pass_count"] for r in results),
        "total_fail": sum(r["fail_count"] for r in results),
        "total_warn": sum(r["warn_count"] for r in results),
        "global_fail": sum(1 for item in global_checks if item["status"] == FAIL),
    }

    return success_response({
        "summary": summary,
        "distribution": distribution,
        "global_checks": global_checks,
        "apps": results,
    })


@router.patch(
    "/admin/tools/{tool_name}/status",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=jwt_auth,
    summary="切换工具状态（启用/禁用）",
)
def toggle_tool_status(request, tool_name: str, payload: AdminSensitiveReasonIn):
    if not getattr(request.auth, "is_staff", False):
        return 403, error_response("FORBIDDEN", message=_("capabilities.admin_required"))

    status = (payload.status or "").strip()
    if status not in ("active", "disabled"):
        return 400, error_response("INVALID", message="status 必须为 active 或 disabled")
    try:
        reason = _ensure_reason(payload)
    except ValueError as exc:
        return 400, error_response("REASON_REQUIRED", message=str(exc))

    tool = RegisteredTool.objects.using(DB).filter(name=tool_name).first()
    if not tool:
        return 404, error_response("NOT_FOUND", message=_("capabilities.tool_not_found", name=tool_name))

    before = _tool_to_brief(tool)
    action = "tool.enable" if status == "active" else "tool.disable"
    permission_code = "tool:enable" if status == "active" else "tool:disable"
    with transaction.atomic(using=DB):
        tool.status = status
        tool.save(using=DB, update_fields=["status", "updated_at"])
        after = _tool_to_brief(tool)
        _record_tool_sensitive_action(
            request,
            action=action,
            target_id=tool.name,
            permission_code=permission_code,
            reason=reason,
            ticket_id=payload.ticket_id,
            before_json=before,
            after_json=after,
        )
    return success_response(_tool_to_brief(tool))


__all__ = ["router"]

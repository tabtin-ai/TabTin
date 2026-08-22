"""App 平台治理 Admin API（Wave E — PRD-v3 §5.5 / §6.6）。

提供 AdminDash 治理四页所需的后端查询接口：
- App 安装管理：列出 organization 内全部 App，按 device 钻取安装快照
- CLI 审计查看：按 binary/risk_level/hitl_user_decision 过滤 CliAuditEvent
- 用户应用授权管理：按 Space+User 筛选 SpaceAppSettings
- 授权调整：admin 修改 optional_tools_allowlist

路由挂载到 /api/auth/admin/*（与其他 admin API 一致）。
权限：StaffAuth()（读）/ SuperuserAuth()（写）。
"""

from __future__ import annotations

import csv
import io
import logging
from uuid import UUID

from django.db.models import Count, Q
from django.http import HttpResponse, JsonResponse
from ninja import Router, Schema

from apps.users.auth.permissions import StaffAuth, SuperuserAuth
from apps.services.common.error_codes import err_response

logger = logging.getLogger(__name__)

router = Router(tags=["Admin App Platform"], auth=StaffAuth())


def _try_parse_uuid(raw: str) -> UUID | None:
    v = str(raw).strip()
    if not v:
        return None
    try:
        return UUID(v)
    except (TypeError, ValueError):
        return None


def _build_pagination(total: int, page: int, page_size: int) -> dict:
    total_pages = (total + page_size - 1) // page_size if total else 0
    normalized_page = min(page, total_pages) if total_pages else 1
    return {
        "total": total,
        "page": normalized_page,
        "page_size": page_size,
        "total_pages": total_pages,
        "offset": (normalized_page - 1) * page_size if total else 0,
    }


# ---------------------------------------------------------------------------
# 1. App 安装管理列表
# ---------------------------------------------------------------------------


@router.get(
    "/app-installs",
    auth=StaffAuth(),
    summary="App 安装管理列表",
)
def admin_list_app_installs(
    request,
    organization_id: str = "",
    device_id: str = "",
    app_id: str = "",
    page: int = 1,
    page_size: int = 20,
):
    from apps.tabtinspace.models import (
        Device,
        DeviceAppInstallSnapshot,
        OrganizationAppInstall,
    )

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    wt_uuid = _try_parse_uuid(organization_id)

    installs_qs = OrganizationAppInstall.objects.all()
    if wt_uuid:
        installs_qs = installs_qs.filter(organization_id=wt_uuid)

    normalized_app_id = app_id.strip()
    if normalized_app_id:
        installs_qs = installs_qs.filter(app_id=normalized_app_id)

    installs_qs = installs_qs.order_by("-created_at")
    total = installs_qs.count()
    pagination = _build_pagination(total, page, page_size)
    installs = list(installs_qs[pagination["offset"] : pagination["offset"] + page_size])

    organization_ids = list({str(i.organization_id) for i in installs})

    snapshot_qs = DeviceAppInstallSnapshot.objects.all()
    if wt_uuid:
        snapshot_qs = snapshot_qs.filter(organization_id=wt_uuid)

    dev_uuid = _try_parse_uuid(device_id)
    if dev_uuid:
        snapshot_qs = snapshot_qs.filter(device_id=dev_uuid)

    snapshot_map: dict[str, list[dict]] = {}
    for snap in snapshot_qs.order_by("-last_seen_at"):
        key = f"{snap.organization_id}:{snap.app_id}"
        entry = {
            "id": str(snap.id),
            "device_id": str(snap.device_id),
            "version": snap.version,
            "install_status": snap.install_status,
            "last_seen_at": snap.last_seen_at.isoformat(),
            "extra": snap.extra or {},
        }
        snapshot_map.setdefault(key, []).append(entry)

    device_ids = list({str(s.device_id) for snaps in snapshot_map.values() for s in [] or snaps})
    all_device_ids = set()
    for snaps in snapshot_map.values():
        for s in snaps:
            all_device_ids.add(s["device_id"])

    device_name_map = {}
    if all_device_ids:
        for d in Device.objects.filter(id__in=list(all_device_ids)).only("id", "name"):
            device_name_map[str(d.id)] = d.name

    items = []
    for inst in installs:
        key = f"{inst.organization_id}:{inst.app_id}"
        device_snapshots = snapshot_map.get(key, [])
        for s in device_snapshots:
            s["device_name"] = device_name_map.get(s["device_id"], "")

        items.append({
            "id": str(inst.id),
            "organization_id": str(inst.organization_id),
            "app_id": inst.app_id,
            "app_source": inst.app_source,
            "installed_by": str(inst.installed_by_id) if inst.installed_by_id else None,
            "created_at": inst.created_at.isoformat(),
            "updated_at": inst.updated_at.isoformat(),
            "device_snapshots": device_snapshots,
            "device_count": len(device_snapshots),
        })

    summary_qs = OrganizationAppInstall.objects.all()
    if wt_uuid:
        summary_qs = summary_qs.filter(organization_id=wt_uuid)
    summary = {
        "total_installs": summary_qs.count(),
        "core_count": summary_qs.filter(app_source="core").count(),
        "marketplace_count": summary_qs.filter(app_source="marketplace").count(),
    }

    return {
        "success": True,
        "data": {
            "items": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
            "summary": summary,
        },
    }


# ---------------------------------------------------------------------------
# 2. CLI 审计查看
# ---------------------------------------------------------------------------


@router.get(
    "/cli-audit",
    auth=StaffAuth(),
    summary="CLI 审计事件查询",
)
def admin_list_cli_audit(
    request,
    organization_id: str = "",
    user_id: str = "",
    binary: str = "",
    inner_binary: str = "",
    risk_level: str = "",
    hitl_user_decision: str = "",
    domain: str = "",
    page: int = 1,
    page_size: int = 50,
):
    from apps.services.agent_engine.cli.models import CliAuditEvent

    page = max(page, 1)
    page_size = max(1, min(page_size, 200))

    qs = CliAuditEvent.objects.all()

    wt_uuid = _try_parse_uuid(organization_id)
    if wt_uuid:
        qs = qs.filter(organization_id=wt_uuid)

    user_uuid = _try_parse_uuid(user_id)
    if user_uuid:
        qs = qs.filter(user_id=user_uuid)

    if binary.strip():
        qs = qs.filter(binary=binary.strip())
    if inner_binary.strip():
        qs = qs.filter(inner_binary=inner_binary.strip())
    if risk_level.strip():
        qs = qs.filter(risk_level=risk_level.strip())
    if hitl_user_decision.strip():
        qs = qs.filter(hitl_user_decision=hitl_user_decision.strip())
    if domain.strip():
        qs = qs.filter(domain=domain.strip())

    qs = qs.order_by("-created_at")
    total = qs.count()
    pagination = _build_pagination(total, page, page_size)
    events = list(qs[pagination["offset"] : pagination["offset"] + page_size])

    items = []
    for e in events:
        items.append({
            "id": str(e.id),
            "organization_id": str(e.organization_id) if e.organization_id else None,
            "thread_id": str(e.thread_id) if e.thread_id else None,
            "agent_id": str(e.agent_id) if e.agent_id else None,
            "user_id": str(e.user_id) if e.user_id else None,
            "binary": e.binary,
            "inner_binary": e.inner_binary or None,
            "domain": e.domain,
            "verb": e.verb,
            "risk_level": e.risk_level,
            "rule_decision": e.rule_decision,
            "hitl_required": e.hitl_required,
            "hitl_user_decision": e.hitl_user_decision or None,
            "exit_code": e.exit_code,
            "bypass": e.bypass,
            "created_at": e.created_at.isoformat(),
            "executed_at": e.executed_at.isoformat() if e.executed_at else None,
            "finished_at": e.finished_at.isoformat() if e.finished_at else None,
        })

    return {
        "success": True,
        "data": {
            "items": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
        },
    }


@router.get(
    "/cli-audit/export",
    auth=StaffAuth(),
    summary="CLI 审计事件 CSV 导出",
)
def admin_export_cli_audit(
    request,
    organization_id: str = "",
    user_id: str = "",
    binary: str = "",
    risk_level: str = "",
    hitl_user_decision: str = "",
):
    from apps.services.agent_engine.cli.models import CliAuditEvent

    qs = CliAuditEvent.objects.all()
    wt_uuid = _try_parse_uuid(organization_id)
    if wt_uuid:
        qs = qs.filter(organization_id=wt_uuid)
    user_uuid = _try_parse_uuid(user_id)
    if user_uuid:
        qs = qs.filter(user_id=user_uuid)
    if binary.strip():
        qs = qs.filter(binary=binary.strip())
    if risk_level.strip():
        qs = qs.filter(risk_level=risk_level.strip())
    if hitl_user_decision.strip():
        qs = qs.filter(hitl_user_decision=hitl_user_decision.strip())

    qs = qs.order_by("-created_at")[:5000]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id", "organization_id", "user_id", "binary", "inner_binary",
        "domain", "verb", "risk_level", "rule_decision",
        "hitl_required", "hitl_user_decision", "exit_code",
        "bypass", "created_at",
    ])
    for e in qs:
        writer.writerow([
            str(e.id), str(e.organization_id or ""), str(e.user_id or ""),
            e.binary, e.inner_binary or "",
            e.domain, e.verb, e.risk_level, e.rule_decision,
            e.hitl_required, e.hitl_user_decision or "",
            e.exit_code if e.exit_code is not None else "",
            e.bypass, e.created_at.isoformat(),
        ])

    response = HttpResponse(output.getvalue(), content_type="text/csv")
    response["Content-Disposition"] = 'attachment; filename="cli_audit_export.csv"'
    return response


# ---------------------------------------------------------------------------
# 2b. 审批审计（PermissionAudit）
# ---------------------------------------------------------------------------


@router.get(
    "/permission-audit",
    auth=StaffAuth(),
    summary="审批审计 PermissionAudit 查询",
)
def admin_list_permission_audit(
    request,
    organization_id: str = "",
    agent_id: str = "",
    thread_id: str = "",
    decision: str = "",
    source: str = "",
    page: int = 1,
    page_size: int = 50,
):
    from apps.services.agent_engine.models import PermissionAudit

    page = max(page, 1)
    page_size = max(1, min(page_size, 200))

    qs = PermissionAudit.objects.all()

    wt_uuid = _try_parse_uuid(organization_id)
    if wt_uuid:
        qs = qs.filter(organization_id=wt_uuid)

    agent_uuid = _try_parse_uuid(agent_id)
    if agent_uuid:
        qs = qs.filter(agent_id=agent_uuid)

    if thread_id.strip():
        qs = qs.filter(thread_id=thread_id.strip())

    if decision.strip():
        qs = qs.filter(decision=decision.strip())

    if source.strip():
        qs = qs.filter(source=source.strip())

    qs = qs.order_by("-created_at")
    total = qs.count()
    pagination = _build_pagination(total, page, page_size)
    rows = list(qs[pagination["offset"] : pagination["offset"] + page_size])

    items = []
    for row in rows:
        reason = row.reason if isinstance(row.reason, dict) else {}
        items.append({
            "id": str(row.id),
            "organization_id": str(row.organization_id),
            "agent_id": str(row.agent_id),
            "thread_id": row.thread_id,
            "session_id": str(row.session_id),
            "batch_id": str(row.batch_id) if row.batch_id else None,
            "request_id": str(row.request_id),
            "tool_call_id": row.tool_call_id,
            "tool_name": row.tool_name,
            "tool_namespace": row.tool_namespace or "",
            "tool_input_preview": row.tool_input_preview,
            "decision": row.decision,
            "source": row.source,
            "reason_type": reason.get("type") if isinstance(reason, dict) else None,
            "scope": row.scope or "",
            "runtime_mode": row.runtime_mode,
            "rejection_message": row.rejection_message or "",
            "created_at": row.created_at.isoformat(),
        })

    return {
        "success": True,
        "data": {
            "items": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
        },
    }


# ---------------------------------------------------------------------------
# 3. 用户应用授权管理
# ---------------------------------------------------------------------------


@router.get(
    "/app-authorization",
    auth=StaffAuth(),
    summary="用户应用授权列表（Space+User 维度）",
)
def admin_list_app_authorization(
    request,
    organization_id: str = "",
    space_id: str = "",
    user_id: str = "",
    page: int = 1,
    page_size: int = 20,
):
    from apps.tabtinspace.models import SpaceAppSettings, Workspace

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    qs = SpaceAppSettings.objects.all()

    wt_uuid = _try_parse_uuid(organization_id)
    if wt_uuid:
        workspace_ids_in_wt = list(
            Workspace.objects.filter(organization_id=wt_uuid).values_list("id", flat=True)
        )
        qs = qs.filter(workspace_id__in=workspace_ids_in_wt)

    sp_uuid = _try_parse_uuid(space_id)
    if sp_uuid:
        # API 参数名仍为 space_id（软 host id）；SpaceAppSettings 锚点是 workspace
        qs = qs.filter(workspace_id=sp_uuid)

    u_uuid = _try_parse_uuid(user_id)
    if u_uuid:
        qs = qs.filter(user_id=u_uuid)

    qs = qs.select_related("workspace").order_by("-updated_at")
    total = qs.count()
    pagination = _build_pagination(total, page, page_size)
    settings_list = list(qs[pagination["offset"] : pagination["offset"] + page_size])

    items = []
    for s in settings_list:
        allowlist = s.optional_tools_allowlist or {}
        items.append({
            "id": str(s.id),
            "space_id": str(s.workspace_id),
            "space_name": s.workspace.name if s.workspace else "",
            "user_id": str(s.user_id),
            "allow_all": allowlist.get("allow_all", False),
            "tools": allowlist.get("tools", []),
            "apps": allowlist.get("apps", []),
            "disabled_apps": s.disabled_apps or [],
            "created_at": s.created_at.isoformat(),
            "updated_at": s.updated_at.isoformat(),
        })

    return {
        "success": True,
        "data": {
            "items": items,
            "total": total,
            "pagination": {
                "page": pagination["page"],
                "page_size": page_size,
                "total_pages": pagination["total_pages"],
            },
        },
    }


# ---------------------------------------------------------------------------
# 4. Admin 调整授权
# ---------------------------------------------------------------------------


class UpdateAuthorizationRequest(Schema):
    allow_all: bool | None = None
    tools: list[str] | None = None
    apps: list[str] | None = None


@router.post(
    "/app-authorization/{setting_id}/update",
    auth=SuperuserAuth(),
    summary="Admin 调整用户应用授权",
)
def admin_update_app_authorization(
    request,
    setting_id: UUID,
    data: UpdateAuthorizationRequest,
):
    from apps.tabtinspace.models import SpaceAppSettings

    setting = SpaceAppSettings.objects.filter(id=setting_id).first()
    if not setting:
        return JsonResponse(
            err_response(
                "NOT_FOUND",
                "SpaceAppSettings not found",
                request=request,
                detail={"setting_id": str(setting_id)},
            ),
            status=404,
        )

    current = setting.optional_tools_allowlist or {}
    if data.allow_all is not None:
        current["allow_all"] = data.allow_all
    if data.tools is not None:
        current["tools"] = data.tools
    if data.apps is not None:
        current["apps"] = data.apps

    setting.optional_tools_allowlist = current
    setting.save(update_fields=["optional_tools_allowlist", "updated_at"])

    return {
        "success": True,
        "data": {
            "id": str(setting.id),
            "space_id": str(setting.workspace_id),
            "user_id": str(setting.user_id),
            "allow_all": current.get("allow_all", False),
            "tools": current.get("tools", []),
            "apps": current.get("apps", []),
        },
    }


# ---------------------------------------------------------------------------
# 5. Connect 管理辅助 —— v3.1（2026-04-19）整段删除
#    理由：TabTin 对 Device 级第三方 App 不代管凭据（方向锚 H2）。
#    AdminDash 第②页 ConnectManagementPage 同步删除；用户授权改由 § 3/4
#    基于 SpaceAppSettings.optional_tools_allowlist 展示。
# ---------------------------------------------------------------------------

"""Workspace approval_memo 路由。

REST API（执行现场维度，挂在 /api/context；Agent 身份 CRUD 在 /api/agents）：

* ``GET    /api/context/workspaces/{workspace_id}/approval-memo``                — 全量读 bootstrap
* ``PUT    /api/context/workspaces/{workspace_id}/approval-memo/{entry_key}``    — 单条 upsert（editor 及以上）
* ``DELETE /api/context/workspaces/{workspace_id}/approval-memo/{entry_key}``    — 单条删除（editor 及以上）
* ``POST   /api/context/workspaces/{workspace_id}/approval-memo/_revoke_all``    — 清空全部（editor 及以上）

Optimistic lock（PRD §8.1.2）：写入路径必带 ``If-Match: <generation>`` header，
服务端比对 + PG 行级锁；冲突返回 409 + ``current_generation``。
"""

from .shared import *  # noqa: F401,F403

from apps.tabtinspace.schemas.approval_memo import (
    ApprovalMemoEntryUpdate,
    ApprovalMemoOut,
)
from apps.tabtinspace.services.approval_memo_service import ApprovalMemoService

router = Router(tags=["Tabtin Space"])


def _serialize_view(view) -> dict:
    return {
        "version": view.version,
        "entries": view.entries,
        "generation": view.generation,
    }


def _parse_if_match(request: HttpRequest) -> int:
    """从 If-Match header 解析 last_seen_generation。

    语义（PRD §8.1.2 + Review 一 WARNING #2 文档对齐）：

    * 缺 ``If-Match`` 头：默认按 ``0`` 处理 —— 适配首次写入场景（memo 还没人写过，
      server 端 generation 自然是 0），方便客户端 bootstrap 路径不必额外读 generation。
      后续写入若 server 已 ``> 0``，service 会按 generation 比对返回 409；客户端
      按 409 + ``data.current_generation`` 重读 memo + 重写头后重试。
    * 头部存在但非法整数：返回 ``-1``（必然 generation 冲突，等同于"客户端故意发了
      非法值"），让客户端立即收到 409 而不是静默退化为 0。
    """
    raw = request.headers.get("If-Match", "").strip().strip('"')
    if not raw:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return -1


@router.get(
    "/workspaces/{workspace_id}/approval-memo",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def get_approval_memo(request: HttpRequest, workspace_id: UUID):
    """全量读 + viewer 即可（runtime bootstrap 一次拉）。"""
    service = ApprovalMemoService(user=request.auth)
    try:
        view = service.get_memo(workspace_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)
    return success_response(data=_serialize_view(view))


# ⚠️ 路由注册顺序：``_revoke_all`` 必须在 ``{entry_key}`` 通配符**之前**注册。
# 原因：django-ninja 按注册顺序做路由匹配，``{entry_key}`` 通配符会先于字面前缀
# ``_revoke_all`` 命中——POST /approval-memo/_revoke_all 会落到 PUT/DELETE 那条
# 通配符路由上，由于该路径未声明 POST → 返回 405（Allow: PUT, DELETE），导致
# revoke_all 端点彻底不可用。dogfood 验证铁证：
#   $ curl -i -X POST .../approval-memo/_revoke_all
#   HTTP/1.1 405 Method Not Allowed
#   Allow: PUT, DELETE
# 修复就是把字面量路由提前，让 ninja 先尝试精确匹配。
@router.post(
    "/workspaces/{workspace_id}/approval-memo/_revoke_all",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def revoke_all_approval_memo(request: HttpRequest, workspace_id: UUID):
    """清空全部 always memo（Skill 升级后用户撤销 Agent 内全部）。

    无需 If-Match：这是用户主动一键全清，不存在 race。
    """
    service = ApprovalMemoService(user=request.auth)
    try:
        view = service.revoke_all(workspace_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)

    _audit(
        request,
        action_type="approval_memo_revoke_all",
        target_type="workspace",
        target_id=str(workspace_id),
        message="approval_memo revoke all",
    )
    return success_response(
        data=_serialize_view(view),
        message=_("tabtinspace.approval_memo_revoked"),
    )


@router.put(
    "/workspaces/{workspace_id}/approval-memo/{entry_key}",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def upsert_approval_memo_entry(
    request: HttpRequest,
    workspace_id: UUID,
    entry_key: str,
    data: ApprovalMemoEntryUpdate,
):
    """单条 upsert（editor 及以上 + optimistic lock）。"""
    last_seen = _parse_if_match(request)
    service = ApprovalMemoService(user=request.auth)
    try:
        view = service.upsert_entry(
            workspace_id=workspace_id,
            entry_key=entry_key,
            decision=data.decision,
            reason=data.reason,
            last_seen_generation=last_seen,
            # M4.1 L-W6-24：把业务名透传给 service 写入 memo entry
            scope_description=data.scope_description,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)

    _audit(
        request,
        action_type="approval_memo_upsert",
        target_type="workspace",
        target_id=str(workspace_id),
        message=f"approval_memo upsert {entry_key} -> {data.decision}",
        request_payload={"entry_key": entry_key, "decision": data.decision},
    )
    return success_response(
        data=_serialize_view(view),
        message=_("tabtinspace.approval_memo_updated"),
    )


@router.delete(
    "/workspaces/{workspace_id}/approval-memo/{entry_key}",
    auth=jwt_auth,
    response={200: dict, **RESP_WITH_CONFLICT},
)
def delete_approval_memo_entry(
    request: HttpRequest,
    workspace_id: UUID,
    entry_key: str,
):
    """单条删除（editor 及以上 + optimistic lock）。"""
    last_seen = _parse_if_match(request)
    service = ApprovalMemoService(user=request.auth)
    try:
        view = service.delete_entry(
            workspace_id=workspace_id,
            entry_key=entry_key,
            last_seen_generation=last_seen,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status, data=e.data)

    _audit(
        request,
        action_type="approval_memo_delete",
        target_type="workspace",
        target_id=str(workspace_id),
        message=f"approval_memo delete {entry_key}",
        request_payload={"entry_key": entry_key},
    )
    return success_response(
        data=_serialize_view(view),
        message=_("tabtinspace.approval_memo_deleted"),
    )

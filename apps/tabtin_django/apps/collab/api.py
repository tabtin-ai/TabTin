"""
Collab 统一 API

为所有创作模块提供一致的协作与版本管理 HTTP 接口。
collab-live 和前端都通过此 API 与后端交互。

路由:
    GET  /{resource_type}/{resource_id}/auth         → 协作鉴权
    GET  /{resource_type}/{resource_id}/snapshot      → 全量快照 (collab-live onFetch)
    POST /{resource_type}/{resource_id}/persist       → 持久化变更 (collab-live onStore)
    GET  /{resource_type}/{resource_id}/versions      → 版本列表
    POST /{resource_type}/{resource_id}/versions      → 创建命名版本
    POST /{resource_type}/{resource_id}/restore       → 恢复到指定版本
    GET  /versions/{version_id}/preview               → 版本内容预览
    PATCH /{resource_type}/versions/{version_id}/name → 重命名版本
    PATCH /{resource_type}/versions/{version_id}/pin  → 置顶/取消置顶

公开工具函数:
    record_change()  → DB-first 路径注入 ChangeLog（AP-003/AP-004 修复）
"""
import logging
import time
from uuid import UUID

from django.core.cache import cache

from apps.i18n import get_text as _

from ninja import Router

from apps.collab.services.checkpoint_context import USER_PROMPT_PREVIEW_MAX_LENGTH

from apps.users.auth.permissions import JWTAuth
from ninja.security import HttpBearer
from apps.services.common.public_share import (
    ShareCollabPrincipal,
    resolve_share_collab_auth,
    verify_share_collab_token,
)
from apps.services.common.auth import InternalServiceAuth
from .constants import COLLAB_PERSIST_IDEMPOTENCY_TTL, RESOURCE_TYPES
from .registry import get_adapter_or_raise
from .services.permission import (
    CollabPermissionError,
    error_response_from_exception,
    resolve_collab_permission,
    assert_collab_action_allowed,
)
from .schemas import (
    CollabApplyOpsRequest,
    CollabPersistRequest,
    CreateNamedVersionRequest,
    CreateSpaceCheckpointRequest,
    RenameVersionRequest,
    RestoreVersionRequest,
    TogglePinRequest,
)
from .apply_ops import CollabApplyOpsService
from .service import (
    CREATE_HISTORY_LOCK_TTL,
    HistoryLockContention,
    HistoryServiceUnavailable,
    RestoreError,
    RestoreInProgress,
    VersionHistoryService,
)

logger = logging.getLogger("collab.api")

CONVERSATION_ANCHOR_USER_MSG_LIMIT = 200
# 必须保持 falsey：滚动发布期间，旧实例仍用 ``if cache.get(key)``
# 判断“已提交”。truthy 占位会让旧实例把尚未提交的请求误判为成功。
_COLLAB_PERSIST_INFLIGHT_MARKER = 0

router = Router()

jwt_auth = JWTAuth()


class CollabDualAuth(HttpBearer):
    """协作鉴权双轨：用户 JWT 或 share collab token。"""

    def authenticate(self, request, token: str):
        claims = verify_share_collab_token(token)
        if claims is not None:
            request.share_collab_claims = claims
            return ShareCollabPrincipal(claims=claims)
        return jwt_auth.authenticate(request, token)


collab_dual_auth = CollabDualAuth()


@router.post("/apply-ops", response={200: dict, 400: dict, 403: dict, 404: dict, 500: dict}, auth=InternalServiceAuth())
def collab_apply_ops(request, body: CollabApplyOpsRequest):
    """Internal Y.Doc-first command proxy.

    This endpoint does not fall back to legacy delta behavior. It forwards
    commands to collab-live `/collab/apply-ops`; callers must switch the whole
    resource to legacy mode before using legacy writers.
    """
    if body.resource_type not in RESOURCE_TYPES or body.resource_type == "file":
        return 400, {"status": "error", "code": "invalid_collab_module", "message": f"Unknown resource_type: {body.resource_type}"}
    result = CollabApplyOpsService.apply_ops(
        module=body.resource_type,
        document_name=body.document_name,
        op_id=body.op_id,
        ops=body.ops,
        origin_id=body.origin_id,
        editor_type=body.editor_type,
        editor_id=body.editor_id,
        editor_name=body.editor_name,
        agent_run_id=body.agent_run_id,
        system_policy=body.system_policy,
    )
    if isinstance(result, dict) and (result.get("status") == "error" or "error" in result):
        code = result.get("code")
        if code in {
            "invalid_collab_module",
            "invalid_document_name",
        }:
            return 400, result
        if code in {
            "collab_permission_denied",
            "collab_subject_not_resolved",
            "collab_system_policy_denied",
        }:
            return 403, result
        if code == "resource_not_found":
            return 404, result
        return 500, result
    return result

from apps.services.common.live_api import (
    _get_live_secret,
    _DEFAULT_DEV_SECRET,
)
from apps.services.common.db_router import postgres_app_db_alias

_IS_DEBUG: bool | None = None


def _cached_is_debug() -> bool:
    global _IS_DEBUG
    if _IS_DEBUG is None:
        from django.conf import settings
        _IS_DEBUG = bool(settings.DEBUG)
    return _IS_DEBUG


def _is_live_request(request) -> bool:
    """检查请求是否来自 collab-live（X-Live-Secret 头）。"""
    import hmac

    secret = _get_live_secret()
    header = request.headers.get("X-Live-Secret", "")
    if not secret:
        logger.warning(
            "COLLAB_LIVE_SECRET is empty — all collab-live requests will be rejected. "
            "Set COLLAB_LIVE_SECRET in environment variables."
        )
        return False
    if not header:
        return False
    if secret == _DEFAULT_DEV_SECRET and not _cached_is_debug():
        logger.warning(
            "COLLAB_LIVE_SECRET is set to default dev secret in non-DEBUG mode — "
            "rejecting request. Set a secure random value for COLLAB_LIVE_SECRET."
        )
        return False
    return hmac.compare_digest(header.encode("utf-8"), secret.encode("utf-8"))


def _get_editor_info(request) -> dict:
    """从请求中提取编辑者信息。"""
    if hasattr(request, "auth") and request.auth:
        return {
            "editor_type": "user",
            "editor_id": str(request.auth.id),
            "editor_name": getattr(request.auth, "nickname", "") or str(request.auth.id)[:8],
        }
    return {
        "editor_type": "system",
        "editor_id": "",
        "editor_name": "",
    }


def _validate_resource_type(resource_type: str):
    if resource_type not in RESOURCE_TYPES:
        return {"status": "error", "message": f"Unknown resource_type: {resource_type}"}
    return None


def _resolve_agent_owner(agent_run_id: str, editor_id: str):
    """
    通过 ExecutionRun 溯源到发起操作的用户。
    优先使用 agent_run_id 查 ExecutionRun.user_id，回退到 editor_id 作为 user_id。
    返回 User 实例或 None。
    """
    from django.contrib.auth import get_user_model
    _User = get_user_model()

    user_id = None
    if agent_run_id:
        try:
            from apps.services.agent_engine.models import ExecutionRun
            run = ExecutionRun.objects.filter(run_id=agent_run_id).values_list("user_id", flat=True).first()
            if run:
                user_id = run
        except Exception:
            logger.debug("Failed to look up ExecutionRun %s", agent_run_id, exc_info=True)

    if not user_id and editor_id:
        user_id = editor_id

    if not user_id:
        return None

    try:
        return _User.objects.filter(id=user_id).first()
    except Exception:
        logger.debug("Failed to look up user %s for agent owner resolution", user_id, exc_info=True)
        return None


def _clear_tabdata_undo_redo_stacks(user_id: str, table_id: str) -> None:
    """DV-005: 表格版本恢复后清空 tabdata 的 Redis Undo/Redo 栈。"""
    try:
        from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService
        stack_svc = UndoRedoStackService()
        stack_svc.clear_table_stacks(
            user_id=user_id,
            table_id=table_id,
            all_windows=True,
        )
    except Exception:
        logger.warning(
            "Failed to clear tabdata undo/redo stacks after restore: table=%s user=%s",
            table_id, user_id, exc_info=True,
        )


def _force_close_collab_document(
    resource_type: str,
    resource_id: str,
    *,
    reason: str = "document_restored",
) -> dict:
    """通知 collab-live 强制关闭文档连接，使所有在线客户端重连并拉取最新快照。

    CL-001 fix: 返回结构化结果而非 None，调用方据此决定是否在响应中添加
    collab_sync_warning。重试次数从 1 提升到 3 以提高可靠性。

    VS-013 fix: reason 不再硬编码，由调用方传入语义准确的值。
    - "document_restored"：版本恢复/rollback 场景（CloseCode 4005 → 丢弃本地 Y.Doc 重拉）
    - "version_sync_fallback"：invalidate-version 失败的降级场景（不应丢弃本地编辑）

    Args:
        resource_type: 资源类型
        resource_id: 资源 ID
        reason: 关闭原因，客户端据此决定是否清空本地未保存编辑

    Returns:
        dict: {success: bool, loaded: bool, connections_closed: int}
    """
    from apps.services.common.live_api import call_live_api_safe

    document_id = f"{resource_type}:{resource_id}"
    result = call_live_api_safe(
        "/admin/force-close",
        {"document_id": document_id, "reason": reason},
        timeout=5,
        max_retries=3,
        source="collab.restore",
    )
    if "error" in result:
        logger.warning(
            "Failed to force-close collab connections after restore for %s: %s",
            document_id,
            result["error"],
        )
        return {"success": False, "loaded": False, "connections_closed": 0}

    loaded = result.get("loaded", True)
    connections_closed = result.get("connections_closed", 0)
    if not loaded:
        logger.info(
            "force-close for %s: document not loaded in collab-live memory, "
            "Redis broadcast sent to other nodes",
            document_id,
        )
    return {"success": True, "loaded": loaded, "connections_closed": connections_closed}


def _resync_collab_document(resource_type: str, resource_id: str) -> dict:
    """: 通知 collab-live 对在线文档做服务端「版本还原重同步」。

    相比 force-close（踢下线 → 客户端延迟 650ms 重连 → 重拉全量快照），resync 在服务端
    内存 Y.Doc 上算出「当前内容 → 还原后内容」的 CRDT delta 并经既有协作链路广播，客户端
    无需断线即收敛到还原后的内容，消除断线闪烁与固定重连延迟。

    仅当文档在 collab-live 某节点内存中加载（即有在线客户端）时才能 resync；否则返回
    resynced=False，调用方应回退到 force-close。

    Returns:
        dict: {success: bool, resynced: bool}
              success=False 表示 HTTP 调用失败；resynced=False 表示文档未加载，需回退。
    """
    from apps.services.common.live_api import call_live_api_safe

    document_id = f"{resource_type}:{resource_id}"
    result = call_live_api_safe(
        "/admin/resync-document",
        {"document_id": document_id},
        timeout=5,
        max_retries=2,
        source="collab.restore_resync",
    )
    if "error" in result:
        logger.warning(
            "_resync_collab_document failed for %s: %s",
            document_id, result["error"],
        )
        return {"success": False, "resynced": False}

    data = result.get("data", result)
    resynced = bool(data.get("resynced", False))
    return {"success": True, "resynced": resynced}


# : 仅对前端已适配 resync（收到 sync_mode=resync 时跳过 forceReconnect）的
# 资源类型启用服务端增量重同步；其余类型（slide/canvas/video，前端走 remount）继续走
# force-close，避免做无收益的 resync。
RESYNC_ENABLED_RESOURCE_TYPES = frozenset({"docs", "table"})


def _resync_or_force_close(resource_type: str, resource_id: str) -> dict:
    """: 版本还原后的协作同步统一入口。

    对已适配 resync 的资源类型（见 RESYNC_ENABLED_RESOURCE_TYPES）优先走 resync（Yjs
    增量广播，不断线）；当文档未在 collab-live 内存加载（无在线客户端或跨节点）、resync
    HTTP 失败、或资源类型未启用 resync 时，回退到 force-close（踢下线重连）兜底。

    Returns:
        dict: {success: bool, sync_mode: str, fc: dict | None}
              sync_mode 为 "resync" / "force_close" / "failed"，供前端决定是否需要强制重连。
              fc 为回退 force-close 的结果（resync 成功时为 None），供调用方沿用既有
              collab_sync_warning 语义。
    """
    if resource_type in RESYNC_ENABLED_RESOURCE_TYPES:
        try:
            rs = _resync_collab_document(resource_type, resource_id)
        except Exception:
            logger.warning(
                "_resync_or_force_close: resync raised for %s:%s, falling back to force_close",
                resource_type, resource_id, exc_info=True,
            )
            rs = {"success": False, "resynced": False}

        if rs.get("success") and rs.get("resynced"):
            return {"success": True, "sync_mode": "resync", "fc": None}

    # 文档未加载 / resync 失败 → force-close 兜底
    fc_result = _force_close_collab_document(resource_type, resource_id)
    sync_mode = "force_close" if fc_result.get("success") else "failed"
    return {"success": fc_result.get("success", False), "sync_mode": sync_mode, "fc": fc_result}


def _invalidate_collab_version(resource_type: str, resource_id: str, new_version: int) -> dict:
    """E2E-022: 通知 collab-live 更新内存 Y.Doc 的 version 字段（缓存失效 Write-Through）。

    DB-first Agent 写入后（version=N+1），Y.Doc 仍持有 version=N。
    调用此接口后 collab-live 将 Y.Doc meta.version 更新为 N+1，
    下次 onStore debounce 触发时 base_version 与 DB 一致，不触发 conflict，
    Agent 写入不会被用户编辑覆盖。

    相比 force_close（方案 B），此方案不中断用户编辑，体验更好。

    Args:
        resource_type: 资源类型（canvas/video/docs/slide/design 等）
        resource_id: 资源 ID（str）
        new_version: DB 写入后的最新版本号

    Returns:
        dict: {success: bool, updated: bool}
    """
    from apps.services.common.live_api import call_live_api_safe

    document_name = f"{resource_type}:{resource_id}"
    result = call_live_api_safe(
        "/admin/invalidate-version",
        {"documentName": document_name, "newVersion": new_version},
        timeout=3,
        max_retries=2,
        source="collab.invalidate_version",
    )
    if "error" in result:
        logger.warning(
            "_invalidate_collab_version failed for %s: %s",
            document_name,
            result["error"],
        )
        return {"success": False, "updated": False}

    updated = result.get("updated", False)
    logger.debug(
        "_invalidate_collab_version: %s version=%d updated=%s",
        document_name, new_version, updated,
    )
    return {"success": True, "updated": updated}


def _invalidate_or_force_close(
    resource_type: str,
    resource_id: str,
    new_version: int,
) -> dict:
    """VS-002 fix: invalidate-version 统一降级函数。

    各模块 DB-first 写入后应调用此函数（而非直接调用 _invalidate_collab_version），
    确保 invalidate 失败时自动降级为 force-close。

    降级链路：
    1. 优先调用 invalidate-version（方案 A，不中断用户编辑）
    2. 若 invalidate 失败（success=False）→ 降级 force-close（方案 B）
    3. VS-011 fix: 若 invalidate 返回 success=True 但 updated=False
       （多节点场景无法确认广播是否成功）→ 降级 force-close

    Args:
        resource_type: 资源类型
        resource_id: 资源 ID（str）
        new_version: DB 写入后的最新版本号

    Returns:
        dict: {invalidated: bool, force_closed: bool}
    """
    try:
        iv_result = _invalidate_collab_version(resource_type, resource_id, new_version)
    except Exception:
        logger.warning(
            "_invalidate_or_force_close: _invalidate_collab_version raised for %s:%s, "
            "falling back to force_close",
            resource_type, resource_id, exc_info=True,
        )
        iv_result = {"success": False, "updated": False}

    if iv_result["success"] and iv_result.get("updated"):
        return {"invalidated": True, "force_closed": False}

    # VS-011: updated=False 时无法区分"正常不在内存"和"Redis 广播失败"，
    # 安全起见降级为 force-close 确保所有节点上的 Y.Doc 被卸载重载。
    if iv_result["success"] and not iv_result.get("updated"):
        logger.info(
            "_invalidate_or_force_close: invalidate-version returned updated=false "
            "for %s:%s version=%d (document may not be loaded or Redis broadcast "
            "may have failed), falling back to force_close",
            resource_type, resource_id, new_version,
        )
    else:
        logger.warning(
            "_invalidate_or_force_close: invalidate-version failed for %s:%s "
            "version=%d, falling back to force_close",
            resource_type, resource_id, new_version,
        )

    try:
        fc_result = _force_close_collab_document(
            resource_type, resource_id,
            reason="version_sync_fallback",
        )
        if not fc_result["success"]:
            logger.warning(
                "_invalidate_or_force_close: force_close also failed for %s:%s, "
                "Y.Doc version may be stale",
                resource_type, resource_id,
            )
        return {"invalidated": False, "force_closed": fc_result["success"]}
    except Exception:
        logger.warning(
            "_invalidate_or_force_close: force_close raised for %s:%s",
            resource_type, resource_id, exc_info=True,
        )
        return {"invalidated": False, "force_closed": False}


def _get_resource_version(resource) -> int | None:
    """尝试从资源模型获取当前版本号，用于 force-close 失败时降级到 invalidate-version。

    不同模块使用不同字段名：大部分用 latest_version，Design 用 revn。
    返回 None 表示无法获取（如 Table 模块没有版本号字段）。
    """
    for attr in ("latest_version", "revn"):
        v = getattr(resource, attr, None)
        if v is not None and isinstance(v, int):
            return v
    return None


def _force_close_or_invalidate(
    resource_type: str,
    resource_id: str,
    new_version: int | None = None,
) -> dict:
    """先尝试 force-close，失败时降级调用 invalidate-version（VS-006/VS-007 修复）。

    Returns:
        dict: {success: bool, method: str}
              method 为 "force_close" / "invalidate_version" / "failed"
    """
    fc_result = _force_close_collab_document(resource_type, resource_id)
    if fc_result.get("success"):
        return {"success": True, "method": "force_close"}

    if new_version is not None:
        iv_result = _invalidate_collab_version(resource_type, resource_id, new_version)
        if iv_result.get("success"):
            logger.info(
                "force_close failed for %s:%s, degraded to invalidate_version "
                "(version=%d) successfully",
                resource_type, resource_id, new_version,
            )
            return {"success": True, "method": "invalidate_version"}
        logger.warning(
            "both force_close and invalidate_version failed for %s:%s",
            resource_type, resource_id,
        )
    else:
        logger.warning(
            "force_close failed for %s:%s and no version available for "
            "invalidate_version degradation",
            resource_type, resource_id,
        )

    return {"success": False, "method": "failed"}


def _trash_resource_in_rollback(resource_type: str, resource_id: str, editor_info: dict) -> bool:
    """将 Agent 新建的资源移入回收站，用于 rollback_agent_run 的 create 类型处理。

    复用 chat/conversation/api.py 中的 _trash_resource 逻辑，但通过 collab 的 adapter
    获取模型，避免跨模块导入。
    """
    from apps.chat.conversation.api import _trash_resource
    editor_id = editor_info.get("editor_id", "") or ""
    return _trash_resource(resource_type, resource_id, editor_id=editor_id)


def _mark_agent_sql_record_history_undone(table_id: str, agent_run_id: str) -> None:
    """E2E-027: 将该 agent_run 对应 table 的 RecordHistory 标记为已回滚。

    Agent SQL 写入时，_emit_record_history_for_write 将 window_id 设为
    'agent_sql:{agent_run_id}'（当 agent_run_id 非空时）。
    rollback 成功后调用此函数，将这些记录标记为 is_undone=True，
    使审计视图能正确显示"已回滚"状态，而非仍显示为未撤销的操作。

    非致命：标记失败只记录 warning，不影响 rollback 结果。
    """
    from django.utils import timezone as tz
    try:
        from apps.tabdata.models import RecordHistory
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        window_id = f"agent_sql:{agent_run_id}"
        updated = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record__table_id=table_id,
            window_id=window_id,
            is_undone=False,
        ).update(is_undone=True, undone_at=tz.now())
        if updated > 0:
            logger.info(
                "E2E-027: marked %d RecordHistory as undone for table=%s agent_run_id=%s",
                updated, table_id, agent_run_id,
            )
    except Exception as exc:
        logger.warning(
            "E2E-027: failed to mark RecordHistory as undone for table=%s agent_run_id=%s: %s",
            table_id, agent_run_id, exc,
        )


def revoke_user_collab_access(user_id: str, organization_id: str) -> dict:
    """通知 collab-live 撤销用户的所有协作连接（RB-004 修复）。

    调用 /internal/revoke-user-access（RB-009 新增的批量端点），
    一次 HTTP 调用即可撤销该用户在所有文档上的连接。
    organization_id 在日志中记录用于审计追踪。
    """
    from apps.services.common.live_api import call_live_api_safe

    result = call_live_api_safe(
        "/internal/revoke-user-access",
        {"user_id": user_id},
        timeout=10,
        max_retries=3,
        source=f"collab.revoke_user_access(ws={organization_id})",
    )

    if "error" in result:
        logger.warning(
            "revoke_user_collab_access failed: user=%s organization=%s error=%s",
            user_id, organization_id, result["error"],
        )
        return {"revoked": False, "error": result["error"]}

    # collab-live 返回 connections_affected，兼容旧字段 connections_closed
    affected = result.get("connections_affected", result.get("connections_closed", 0))
    if affected > 0:
        logger.info(
            "revoke_user_collab_access: user=%s organization=%s closed=%d",
            user_id, organization_id, affected,
        )

    return {"revoked": True, "connections_closed": affected}


def revoke_document_collab_access(
    document_name: str, user_id: str, *, read_only: bool = False,
) -> dict:
    """通知 collab-live 撤销/降级用户在单个文档上的连接（RV-015 修复）。

    调用 /internal/revoke-access 实现单文档粒度的权限撤销。
    read_only=True 时降级为只读而非断连（RV-013 配合使用）。
    """
    from apps.services.common.live_api import call_live_api_safe

    result = call_live_api_safe(
        "/internal/revoke-access",
        {"document_name": document_name, "user_id": user_id, "read_only": read_only},
        timeout=5,
        max_retries=2,
        source=f"collab.revoke_document(doc={document_name})",
    )

    if "error" in result:
        logger.warning(
            "revoke_document_collab_access failed: doc=%s user=%s read_only=%s error=%s",
            document_name, user_id, read_only, result["error"],
        )
        return {"revoked": False, "error": result["error"]}

    affected = result.get("connections_affected", 0)
    if affected > 0:
        logger.info(
            "revoke_document_collab_access: doc=%s user=%s read_only=%s affected=%d",
            document_name, user_id, read_only, affected,
        )

    return {"revoked": True, "connections_affected": affected}


def record_change(
    resource_type: str,
    resource_id,
    change_type: str = "update",
    *,
    agent_run_id: str = "",
    session_id: str = "",
    editor_type: str = "agent",
    editor_id: str = "",
    editor_name: str = "",
    summary: str = "",
    changes: dict | None = None,
    version_history=None,
    notify_collab: bool = False,
    notify_collab_version: int | None = None,
):
    """为 DB-first 写路径记录 ChangeLog 条目（AP-003/AP-004 修复）。

    当模块直接写 DB（不经过 collab-live onStore → persist 端点）时，
    调用此函数确保变更被 ChangeLog 记录，使 rollback_agent_run 能追踪到这些操作。

    典型调用方:
      - TabDoc  save_from_agent() / save_content()
      - TabVideo save_timeline()
      - TabWhiteboard save_graph() / _cas_save_graph()
      - TabData  RecordService CRUD

    Args:
        resource_type: 资源类型（docs/table/design/slide/video/canvas 等）
        resource_id: 资源 ID（str 或 UUID）
        change_type: 变更类型（create/update/delete）
        agent_run_id: Agent Run ID；为空时自动从 ContextVar 获取
        session_id: 关联 ChatSession ID；为空时自动从 ContextVar 获取
        editor_type: 编辑者类型（agent/user/system）
        editor_id: 编辑者 ID
        editor_name: 编辑者名称
        summary: 人可读的操作描述
        changes: 结构化变更内容
        version_history: 关联的 VersionHistory 实例（可选）
        notify_collab: E2E-022 — DB-first 写入后是否通知 collab-live 同步 version。
            当 Agent 直接写 DB 更新 version 后，Y.Doc 仍持有旧 version，
            collab-live 后续 onStore 可能因 base_version 过期触发 conflict 覆盖 Agent 写入。
            设为 True 时：
            - 若提供 notify_collab_version，调用 invalidate-version 接口更新 Y.Doc version
              （缓存失效 Write-Through，不中断用户编辑，DECISION-003 方案 A）；
            - 若未提供 notify_collab_version，降级为 force_close（方案 B，中断编辑）。
        notify_collab_version: DB 写入后的最新版本号，配合 notify_collab=True 使用。
            提供后优先调用 invalidate-version；不提供时降级为 force_close。

    Returns:
        ChangeLog 实例
    """
    from .models import ChangeLog

    if not agent_run_id:
        try:
            from apps.services.common.platform_context import get_current_run_id
            agent_run_id = get_current_run_id() or ""
        except Exception:
            logger.debug("record_change: failed to get agent_run_id from ContextVar", exc_info=True)

    if not session_id:
        try:
            from apps.services.common.platform_context import get_current_session_id
            session_id = get_current_session_id() or ""
        except Exception:
            logger.debug("record_change: failed to get session_id from ContextVar", exc_info=True)

    cl = ChangeLog.objects.using(postgres_app_db_alias()).create(
        resource_type=resource_type,
        resource_id=resource_id,
        change_type=change_type,
        summary=summary,
        changes=changes or {},
        editor_type=editor_type,
        editor_id=editor_id,
        editor_name=editor_name,
        agent_run_id=agent_run_id,
        session_id=session_id,
        version_history=version_history,
    )

    # Phase C：产物 ChangeLog 作为强证据升格任务脸（docs/table→doc；file→code）。
    if session_id:
        try:
            from apps.chat.conversation.services.session_surface_policy import (
                promote_session_from_resource_type,
            )
            promote_session_from_resource_type(session_id, resource_type)
        except Exception:
            logger.debug(
                "record_change: primary_surface promote skipped for %s:%s",
                resource_type, resource_id, exc_info=True,
            )

    if notify_collab:
        try:
            if notify_collab_version is not None:
                # DECISION-003 方案 A：更新 Y.Doc version，不中断用户编辑
                iv_result = _invalidate_collab_version(
                    resource_type, str(resource_id), notify_collab_version
                )
                if not iv_result["success"]:
                    logger.warning(
                        "record_change: invalidate_version failed for %s:%s version=%d, "
                        "falling back to force_close",
                        resource_type, resource_id, notify_collab_version,
                    )
                    _force_close_collab_document(resource_type, str(resource_id))
            else:
                # 降级方案 B：force_close（未提供 version 时使用）
                fc_result = _force_close_collab_document(resource_type, str(resource_id))
                if not fc_result["success"]:
                    logger.warning(
                        "record_change: force_close failed for %s:%s after DB-first write",
                        resource_type, resource_id,
                    )
        except Exception:
            logger.warning(
                "record_change: failed to notify collab-live for %s:%s",
                resource_type, resource_id,
                exc_info=True,
            )

    return cl


def downgrade_user_collab_to_readonly(user_id: str, organization_id: str) -> dict:
    """通知 collab-live 将用户的所有连接降级为只读模式（RV-013 修复）。

    viewer 降级场景：用户仍有查看权限，不应断开连接。
    organization_id 在日志中记录用于审计追踪。
    """
    from apps.services.common.live_api import call_live_api_safe

    result = call_live_api_safe(
        "/internal/revoke-user-access",
        {"user_id": user_id, "read_only": True},
        timeout=5,
        max_retries=2,
        source=f"collab.downgrade_to_readonly(ws={organization_id})",
    )

    if "error" in result:
        logger.warning(
            "downgrade_user_collab_to_readonly failed: user=%s organization=%s error=%s",
            user_id, organization_id, result["error"],
        )
        return {"downgraded": False, "error": result["error"]}

    affected = result.get("connections_affected", 0)
    if affected > 0:
        logger.info(
            "downgrade_user_collab_to_readonly: user=%s organization=%s affected=%d",
            user_id, organization_id, affected,
        )

    return {"downgraded": True, "connections_affected": affected}


# ── collab-auth ──────────────────────────────────────

@router.get("/{resource_type}/{resource_id}/auth", auth=collab_dual_auth, response={200: dict, 400: dict, 403: dict, 404: dict})
def collab_auth(request, resource_type: str, resource_id: UUID):
    """协作鉴权：前端连接 collab-live 前调用，检查用户权限。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    if isinstance(request.auth, ShareCollabPrincipal):
        from apps.tabdata.services.share_service import TableShareService
        from apps.tabdoc.services.share_service import DocumentShareService

        service_map = {
            "docs": DocumentShareService,
            "table": TableShareService,
        }
        service_cls = service_map.get(resource_type)
        if service_cls is None:
            return 403, {"status": "error", "message": _("auth.permission_denied")}

        data = resolve_share_collab_auth(
            request.auth.claims,
            resource_type,
            str(resource_id),
            share_service_cls=service_cls,
        )
        if not data:
            return 403, {"status": "error", "message": _("auth.permission_denied")}
        # 字段可见性降级：authorized=false + collab_mode，collab-live 会拒绝进房
        if data.get("authorized") is False:
            return {
                "status": "ok",
                "data": data,
                "code": data.get("reason") or "field_visibility_restricted",
                "message": data.get("reason") or "field_visibility_restricted",
            }
        return {"status": "ok", "data": data}

    try:
        permission = resolve_collab_permission(request.auth, resource_type, str(resource_id))
    except CollabPermissionError as e:
        status, body = error_response_from_exception(e)
        return status, body

    if not permission:
        return 403, {"status": "error", "message": _("auth.permission_denied")}

    # ：JWT 表格协作 — 可见字段非全集时不得进入全量 Y.Doc 房间
    if resource_type == "table":
        from apps.tabdata.services.field_visibility import (
            build_collab_degradation_payload,
            evaluate_collab_access,
        )

        try:
            adapter = get_adapter_or_raise(resource_type)
        except ValueError as e:
            return 400, {"status": "error", "message": str(e)}
        resource = adapter.get_resource(str(resource_id))
        if not resource:
            return 404, {"status": "error", "message": _("resource.not_found")}

        decision = evaluate_collab_access(request.auth, resource)
        if not decision.get("allowed"):
            data = build_collab_degradation_payload(
                decision,
                resource_type=resource_type,
                resource_id=str(resource_id),
                permission=permission,
            )
            data["user_id"] = str(request.auth.id)
            data["user_name"] = getattr(request.auth, "nickname", "") or ""
            return {
                "status": "ok",
                "data": data,
                "code": data.get("reason") or "field_visibility_restricted",
                "message": data.get("reason") or "field_visibility_restricted",
            }

    return {
        "status": "ok",
        "data": {
            "authorized": True,
            "permission": permission,
            "user_id": str(request.auth.id),
            "user_name": getattr(request.auth, "nickname", "") or "",
            "resource_type": resource_type,
            "resource_id": str(resource_id),
            "collab_mode": "full",
            "reason": None,
        },
    }


# ── collab-snapshot ──────────────────────────────────

@router.get("/{resource_type}/{resource_id}/snapshot", response={200: dict, 400: dict, 403: dict, 404: dict, 500: dict}, auth=InternalServiceAuth())
def collab_snapshot(request, resource_type: str, resource_id: UUID):
    """全量快照：collab-live onFetch 调用，获取资源的完整数据。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as e:
        return 400, {"status": "error", "message": str(e)}

    resource = adapter.get_resource(str(resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}

    try:
        snapshot = adapter.build_snapshot(resource)
    except Exception:
        logger.exception("Failed to build snapshot for %s:%s", resource_type, resource_id)
        return 500, {"status": "error", "message": _("collab.snapshot_failed")}

    return {"status": "ok", "data": snapshot}


# ── TD-4 Phase 4b：H-1 / onStore VH 去重标记 ──────────
#
# 路线 A：save_content（H-1）在 DB-first 写入后**同步**写 VersionHistory 为权威。
# 该内容随后经 push_and_update_binary → collab-live → onStore(collab_persist) 回流，
# 若不去重，collab_persist 会对同一次变更再写一条 VH（binary 版本）→ 双写。
#
# 机制：save_content 写完 VH 后用 mark_vh_synced 打一个 Redis 短键；collab_persist
# 写 VH 前用 _consume_vh_synced_marker「同源校验 + 一次性消费」该键，命中则跳过 VH/CL
# （binary 落盘已在 persist_changes 完成，不受影响）。仅作用于 docs：纯人手编辑无标记、
# Agent Y-first（push_from_agent）不打标记，均不受影响。

VH_SYNCED_MARKER_DEFAULT_TTL = 60


def _vh_synced_marker_key(resource_type: str, resource_id) -> str:
    return f"collab:vh_synced:{resource_type}:{resource_id}"


def _vh_synced_marker_ttl() -> int:
    from django.conf import settings
    return int(getattr(settings, "TABDOC_VH_SYNCED_MARKER_TTL", VH_SYNCED_MARKER_DEFAULT_TTL))


def mark_vh_synced(
    resource_type, resource_id, *,
    editor_type: str = "", editor_id: str = "", agent_run_id: str = "", ttl=None,
) -> None:
    """TD-4 4b：标记本资源「本次变更的 VH 已由 DB-first 同步路径（save_content H-1）写过」。

    供 collab_persist(onStore) 去重。best-effort：失败仅记日志、不影响主流程。
    """
    key = _vh_synced_marker_key(resource_type, str(resource_id))
    payload = {
        "editor_type": editor_type or "",
        "editor_id": editor_id or "",
        "agent_run_id": agent_run_id or "",
    }
    try:
        cache.set(key, payload, ttl if ttl is not None else _vh_synced_marker_ttl())
    except Exception:
        logger.warning(
            "TD-4 4b: 设置 vh_synced 标记失败 %s:%s (non-fatal)",
            resource_type, resource_id, exc_info=True,
        )


def _consume_vh_synced_marker(resource_type, resource_id, body) -> bool:
    """TD-4 4b：检测并一次性消费 vh_synced 标记。命中（同源）返回 True，调用方据此跳过 VH/CL。

    同源校验避免误伤并发的他人/人手编辑：
      - 仅 docs 资源参与（其余模块无 DB-first 同步写 VH 的双写问题）；
      - editor_type 必须与标记一致；
      - agent：双方都带 agent_run_id 时必须相等，任一缺失则退回 editor_id 比对；
      - user/system：editor_id 必须一致。
    """
    if resource_type != "docs":
        return False
    key = _vh_synced_marker_key(resource_type, str(resource_id))
    try:
        marker = cache.get(key)
    except Exception:
        return False
    if not isinstance(marker, dict):
        return False

    body_editor_type = getattr(body, "editor_type", "") or ""
    if marker.get("editor_type", "") != body_editor_type:
        return False

    marker_editor_id = marker.get("editor_id", "") or ""
    body_editor_id = getattr(body, "editor_id", "") or ""
    if body_editor_type == "agent":
        marker_run = marker.get("agent_run_id", "") or ""
        body_run = getattr(body, "agent_run_id", "") or ""
        if marker_run and body_run:
            if marker_run != body_run:
                return False
        elif marker_editor_id != body_editor_id:
            return False
    else:
        if marker_editor_id != body_editor_id:
            return False

    # 同源命中：一次性消费，避免后续无关 persist 被误判
    try:
        cache.delete(key)
    except Exception:
        pass
    return True


# ── TD-4 Phase 4e-2：latest_version 双跳去重标记 ──────────
#
# 问题：save_content（DB-first）先 latest_version +1，随后内容经
# push_and_update_binary → collab-live replace → onStore(save_from_hocuspocus)
# 回流时**又 +1**，一次保存版本号跳两档（v17→v18→v19）。
#
# 机制（与 4b 同源标记同思路，但 key / 消费点都独立）：save_content 在 DB-first +1
# 时打一个 `collab:ver_synced` 短键；save_from_hocuspocus(onStore) 落库前用
# _consume_version_synced_marker「同源校验 + 一次性消费」该键，命中则**跳过版本 +1**
# （binary / 格式字段仍正常落库）。纯人手 / Agent Y-first 的 onStore 无标记，照常 +1。
#
# 为何独立于 4b 的 vh_synced：4b 标记在 collab_persist 中、persist_changes 之后才消费；
# 版本 +1 发生在 persist_changes 内部的 save_from_hocuspocus，时序更早。复用同一标记会
# 在 onStore 内提前消费掉，导致 collab_persist 后续的 vh 去重失效（4b 回归双写）。

VER_SYNCED_MARKER_DEFAULT_TTL = 60


def _ver_synced_marker_key(resource_type: str, resource_id) -> str:
    return f"collab:ver_synced:{resource_type}:{resource_id}"


def _ver_synced_marker_ttl() -> int:
    from django.conf import settings
    return int(getattr(settings, "TABDOC_VER_SYNCED_MARKER_TTL", VER_SYNCED_MARKER_DEFAULT_TTL))


def mark_version_synced(
    resource_type, resource_id, *,
    editor_type: str = "", editor_id: str = "", agent_run_id: str = "",
    version=None, ttl=None,
) -> None:
    """TD-4 4e-2：标记本资源「本次变更已由 DB-first（save_content）做过 latest_version +1」。

    供 save_from_hocuspocus(onStore) 去重，避免版本号双跳。best-effort：失败仅记日志。
    """
    key = _ver_synced_marker_key(resource_type, str(resource_id))
    payload = {
        "editor_type": editor_type or "",
        "editor_id": editor_id or "",
        "agent_run_id": agent_run_id or "",
        "version": version,
    }
    try:
        cache.set(key, payload, ttl if ttl is not None else _ver_synced_marker_ttl())
    except Exception:
        logger.warning(
            "TD-4 4e-2: 设置 ver_synced 标记失败 %s:%s (non-fatal)",
            resource_type, resource_id, exc_info=True,
        )


def _consume_version_synced_marker(
    resource_type, resource_id, *,
    editor_type: str = "", editor_id: str = "", agent_run_id: str = "",
) -> bool:
    """TD-4 4e-2：检测并一次性消费 ver_synced 标记。命中（同源）返回 True，调用方据此跳过版本 +1。

    同源校验与 4b 的 _consume_vh_synced_marker 同口径，避免误伤并发的他人/人手编辑：
      - 仅 docs 资源参与；
      - editor_type 必须与标记一致；
      - agent：双方都带 agent_run_id 时必须相等，任一缺失则退回 editor_id 比对；
      - user/system：editor_id 必须一致。
    """
    if resource_type != "docs":
        return False
    key = _ver_synced_marker_key(resource_type, str(resource_id))
    try:
        marker = cache.get(key)
    except Exception:
        return False
    if not isinstance(marker, dict):
        return False

    body_editor_type = editor_type or ""
    if marker.get("editor_type", "") != body_editor_type:
        return False

    marker_editor_id = marker.get("editor_id", "") or ""
    body_editor_id = editor_id or ""
    if body_editor_type == "agent":
        marker_run = marker.get("agent_run_id", "") or ""
        body_run = agent_run_id or ""
        if marker_run and body_run:
            if marker_run != body_run:
                return False
        elif marker_editor_id != body_editor_id:
            return False
    else:
        if marker_editor_id != body_editor_id:
            return False

    # 同源命中：一次性消费，避免后续无关 onStore 被误判
    try:
        cache.delete(key)
    except Exception:
        pass
    return True


def clear_synced_markers(resource_type, resource_id) -> None:
    """TD-4 4b / 4e-2：主动清除 vh_synced + ver_synced 两个去重标记。

    save_content 推送 collab-live 失败（onStore 不会回流，标记不会被消费）时调用，
    避免残留标记在 TTL 内误伤后续无关 onStore 的 VH 写入 / 版本 +1。best-effort。
    """
    for key in (
        _vh_synced_marker_key(resource_type, str(resource_id)),
        _ver_synced_marker_key(resource_type, str(resource_id)),
    ):
        try:
            cache.delete(key)
        except Exception:
            pass


def _organization_resource_write_block_tuple(resource):
    organization_id = str(
        getattr(resource, "organization_id", "")
        or getattr(resource, "team_id", "")
        or getattr(getattr(resource, "organization", None), "id", "")
        or ""
    )
    if not organization_id:
        return None

    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        assert_organization_resource_write_allowed,
    )

    try:
        assert_organization_resource_write_allowed(organization_id)
        return None
    except OrganizationControlBlockedError as exc:
        return 403, {
            "status": "error",
            "code": exc.code,
            "message": exc.message,
            "error_category": "organization_control",
        }


# ── collab-persist ───────────────────────────────────

_RETRYABLE_WRITE_SQLSTATES = {"40001", "40P01", "55P03", "57014"}


def _retryable_write_sqlstate(exc: BaseException) -> str:
    """提取 PostgreSQL 并发/超时错误码；不依赖 psycopg2/psycopg3 具体异常类。"""
    current = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        sqlstate = getattr(current, "sqlstate", None) or getattr(current, "pgcode", None)
        if sqlstate in _RETRYABLE_WRITE_SQLSTATES:
            return str(sqlstate)
        current = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
    return ""


@router.post("/{resource_type}/{resource_id}/persist", response={200: dict, 400: dict, 403: dict, 404: dict, 500: dict, 503: dict}, auth=InternalServiceAuth())
def collab_persist(request, resource_type: str, resource_id: UUID, body: CollabPersistRequest):
    """持久化变更：collab-live onStore 调用，将 Y.Doc 变更写入数据库。"""
    persist_start = time.monotonic()

    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    cache_key = None
    cache_claimed = False

    def _cached_response(cached_result):
        if isinstance(cached_result, dict):
            return {"status": "ok", "data": cached_result}
        if cached_result == _COLLAB_PERSIST_INFLIGHT_MARKER:
            return 503, {
                "status": "error",
                "code": "COLLAB_WRITE_BUSY",
                "message": _("collab.persist_failed"),
                "retryable": True,
                "retry_after_ms": 500,
            }
        if cached_result:
            # Rolling deployment compatibility: older instances wrote a
            # truthy marker before the database transaction committed. Its
            # presence therefore proves neither success nor failure. Fail
            # closed until the short-lived marker expires: replaying could
            # duplicate a committed write, while returning success could lose
            # a write whose transaction actually rolled back.
            return 503, {
                "status": "error",
                "code": "COLLAB_WRITE_BUSY",
                "message": _("collab.persist_failed"),
                "retryable": True,
                "retry_after_ms": 500,
            }
        return None

    def _release_cache_claim() -> None:
        if not cache_key or not cache_claimed:
            return
        try:
            cache.delete(cache_key)
        except Exception:
            logger.warning(
                "Failed to release idempotency claim for %s:%s (op_id=%s); "
                "claim will expire after %ds",
                resource_type, resource_id, body.op_id,
                COLLAB_PERSIST_IDEMPOTENCY_TTL,
                exc_info=True,
            )

    if body.op_id:
        cache_key = f"collab:persist:{resource_type}:{resource_id}:{body.op_id}"
        try:
            cached_response = _cached_response(cache.get(cache_key))
        except Exception:
            logger.warning(
                "Failed to read idempotency cache for %s:%s (op_id=%s), "
                "continuing without Redis deduplication",
                resource_type, resource_id, body.op_id,
                exc_info=True,
            )
            cache_key = None
        else:
            if cached_response is not None:
                return cached_response

    try:
        body_agent_run_id = getattr(body, "agent_run_id", "") or ""
        body_system_policy = getattr(body, "system_policy", "") or ""
        collab_resource = assert_collab_action_allowed(
            resource_type=resource_type,
            resource_id=str(resource_id),
            action="edit",
            editor_type=body.editor_type,
            editor_id=body.editor_id,
            agent_run_id=body_agent_run_id,
            system_policy=body_system_policy,
        )
    except CollabPermissionError as e:
        status, body_payload = error_response_from_exception(e)
        return status, body_payload
    adapter = collab_resource.adapter
    resource = collab_resource.resource
    block_response = _organization_resource_write_block_tuple(resource)
    if block_response is not None:
        return block_response

    if cache_key:
        try:
            cache_claimed = bool(cache.add(
                cache_key,
                _COLLAB_PERSIST_INFLIGHT_MARKER,
                COLLAB_PERSIST_IDEMPOTENCY_TTL,
            ))
        except Exception:
            logger.warning(
                "Failed to claim idempotency key for %s:%s (op_id=%s), "
                "continuing without Redis deduplication",
                resource_type, resource_id, body.op_id,
                exc_info=True,
            )
            cache_key = None
        else:
            if not cache_claimed:
                # Another request may have committed between the initial get
                # and this atomic add. Re-read once; if the value disappeared,
                # fail closed as transient busy so the caller retries instead
                # of executing the same op_id concurrently.
                try:
                    cached_response = _cached_response(cache.get(cache_key))
                except Exception:
                    cached_response = None
                    logger.warning(
                        "Failed to re-read occupied idempotency key for %s:%s "
                        "(op_id=%s); returning retryable busy",
                        resource_type, resource_id, body.op_id,
                        exc_info=True,
                    )
                if cached_response is not None:
                    return cached_response
                return 503, {
                    "status": "error",
                    "code": "COLLAB_WRITE_BUSY",
                    "message": _("collab.persist_failed"),
                    "retryable": True,
                    "retry_after_ms": 500,
                }

    editor_info = {
        "editor_type": body.editor_type,
        "editor_id": body.editor_id,
        "editor_name": body.editor_name,
    }

    # TCV-017 + E2E-020: persist 在外层事务中执行，VH+CL 在事务提交后执行。
    # VH/CL 写入失败时不影响已提交的 persist，避免重试时因并发写入导致
    # base_version 过期 → conflict → VH 永久缺失的问题。
    # VH 写入失败时在 result 中标记 version_history_error，由 collab-live 记录告警。
    #
    # CSC-013: VH 写入移到事务外，并在事务外获取 collab:create_history_lock 锁，
    # 与 DB-first 路径（post_save._write_unified_version_best_effort → svc.create_history()）
    # 共享同一把锁，序列化两条路径对 VersionHistory 的写入，消除 base_history 指向竞争。
    # 这同时解决了 CSC-017（Redis IO 不再在 DB 事务内执行）。
    from django.db import transaction as db_transaction
    from .models import ChangeLog

    result = {}
    try:
        with db_transaction.atomic(using=postgres_app_db_alias()):
            result = adapter.persist_changes(resource, body.changes, editor_info)
    except Exception as exc:
        _release_cache_claim()
        sqlstate = _retryable_write_sqlstate(exc)
        if sqlstate:
            logger.warning(
                "Collab persist write contention for %s:%s (sqlstate=%s)",
                resource_type, resource_id, sqlstate,
            )
            return 503, {
                "status": "error",
                "code": "COLLAB_WRITE_BUSY",
                "message": _("collab.persist_failed"),
                "retryable": True,
                "retry_after_ms": 500,
            }
        logger.exception(
            "Failed to persist changes for %s:%s",
            resource_type, resource_id,
        )
        return 500, {"status": "error", "message": _("collab.persist_failed")}

    if not isinstance(result, dict):
        _release_cache_claim()
        logger.error(
            "Invalid persist result for %s:%s: expected dict, got %s",
            resource_type, resource_id, type(result).__name__,
        )
        return 500, {"status": "error", "message": _("collab.persist_failed")}

    if result.get("error"):
        _release_cache_claim()
        logger.error(
            "Persist returned an error result for %s:%s: %s",
            resource_type, resource_id, result.get("error"),
        )
        return 500, {"status": "error", "message": _("collab.persist_failed")}

    if result.get("conflict"):
        _release_cache_claim()
        return {"status": "ok", "data": result}

    # Redis 仅缓存数据库主事务已经提交的结果。VH/CL 是提交后的 best-effort
    # 副作用，不参与 op_id 的数据持久化成功判定。缓存不可用时不影响已提交写入，
    # 但绝不能在提交前留下会把失败重试误判为成功的标记。
    if cache_key:
        try:
            cache.set(cache_key, result, COLLAB_PERSIST_IDEMPOTENCY_TTL)
        except Exception:
            logger.warning(
                "Failed to set idempotency cache for %s:%s (op_id=%s), "
                "retaining inflight claim for up to %ds to avoid replaying "
                "an already committed write",
                resource_type, resource_id, body.op_id,
                COLLAB_PERSIST_IDEMPOTENCY_TTL,
                exc_info=True,
            )
        else:
            cache_claimed = False

    if not result.get("skipped") and not getattr(body, "skip_version_history", False):
        effective_agent_run_id = body.agent_run_id
        if not effective_agent_run_id and body.editor_type == "agent":
            try:
                from apps.services.common.platform_context import get_current_run_id
                effective_agent_run_id = get_current_run_id() or ""
            except Exception:
                logger.debug("persist: failed to get agent_run_id from ContextVar", exc_info=True)
            if not effective_agent_run_id:
                effective_agent_run_id = body.editor_id

        # QC-05: session_id 与 agent_run_id 对称地从 ContextVar 兜底获取，
        # 使后续直写 ChangeLog 时 session_id 填充率达到 PRD §4.8 的 >99% 目标。
        effective_session_id = ""
        try:
            from apps.services.common.platform_context import get_current_session_id
            effective_session_id = get_current_session_id() or ""
        except Exception:
            logger.debug("persist: failed to get session_id from ContextVar", exc_info=True)

        resource.refresh_from_db()
        version_data = adapter.get_version_data(resource)

        # TD-4 Phase 4b（路线 A）：本次变更若已由 DB-first 的 save_content(H-1) 同步写过 VH，
        # onStore 在此跳过 VH/CL 写入，消除「H-1 + onStore」双写。binary 已在上方
        # persist_changes 内落盘，跳过仅影响版本历史、不影响内容同步；标记同源校验 +
        # 一次性消费，确保不误伤纯人手编辑（无标记）与并发的他人编辑（editor 不匹配）。
        if version_data is not None and _consume_vh_synced_marker(resource_type, resource_id, body):
            logger.info(
                "TD-4 4b: VH already written synchronously by save_content for %s:%s, "
                "skipping onStore VH/CL to avoid double-write",
                resource_type, resource_id,
            )
            result["version_history_skipped_synced"] = True
            version_data = None  # 下方 `if version_data is not None` 据此跳过 _do_create_history + ChangeLog

        # CSC-013: 在事务外获取 collab:create_history_lock，与 DB-first 路径共享锁，
        # 序列化两条路径对 VersionHistory 的写入，消除 base_history 指向竞争。
        # Redis 不可用时跳过锁（与 create_history() 的降级策略一致），记录 warning。
        vh_lock_key = f"collab:create_history_lock:{resource_type}:{resource_id}"
        vh_lock_acquired = False
        lock_start = time.monotonic()
        try:
            vh_lock_acquired = cache.add(vh_lock_key, 1, CREATE_HISTORY_LOCK_TTL)
        except Exception:
            logger.warning(
                "CSC-013: Redis unavailable for VH lock %s:%s in collab_persist, "
                "proceeding without lock (race condition possible)",
                resource_type, resource_id,
            )
            vh_lock_acquired = True  # Redis 不可用时降级为无锁执行
        lock_elapsed = time.monotonic() - lock_start
        if lock_elapsed > 1.0:
            logger.info(
                "collab_persist: lock acquisition took %.1fs for %s:%s",
                lock_elapsed, resource_type, resource_id,
            )

        if not vh_lock_acquired:
            logger.warning(
                "CSC-013: VH lock contention for %s:%s in collab_persist, skipping VH write",
                resource_type, resource_id,
            )
            result["version_history_skipped"] = True
        else:
            try:
                try:
                    with db_transaction.atomic(using=postgres_app_db_alias()):
                        vh = None
                        if version_data is not None:
                            svc = VersionHistoryService(adapter)
                            organization_id = getattr(resource, "organization_id", None) or getattr(resource, "team_id", None)
                            vh = svc._do_create_history(
                                resource_id,
                                version_data,
                                editor_info,
                                organization_id=organization_id,
                                # P1-02 fix: Agent 高频编辑时跳过 5 秒节流，
                                # 防止中间版本 VH 丢失
                                skip_throttle=(body.editor_type == "agent"),
                            )

                        if vh is not None:
                            # CSC-002: 消除 ChangeLog 双写。
                            # save_from_agent 已通过 _write_sync_changelog 写入一条
                            # changes={"sync_changelog": True} 的 ChangeLog（version_history=None）。
                            # 此处检查是否存在同 agent_run_id + resource_id + sync_changelog 的条目，
                            # 若存在则更新（关联 VH），而非新建，避免同一次 Agent 操作产生 2 条 ChangeLog。
                            existing_cl = None
                            if effective_agent_run_id:
                                existing_cl = (
                                    ChangeLog.objects.using(postgres_app_db_alias())
                                    .filter(
                                        resource_type=resource_type,
                                        resource_id=resource_id,
                                        agent_run_id=effective_agent_run_id,
                                        version_history__isnull=True,
                                        changes__sync_changelog=True,
                                    )
                                    .order_by("-created_at")
                                    .first()
                                )

                            if existing_cl is not None:
                                existing_cl.version_history = vh
                                existing_cl.changes = {
                                    **existing_cl.changes,
                                    "persist_result": result,
                                    "sync_changelog_updated": True,
                                }
                                existing_cl.save(
                                    using=postgres_app_db_alias(),
                                    update_fields=["version_history", "changes"],
                                )
                            else:
                                ChangeLog.objects.using(postgres_app_db_alias()).create(
                                    resource_type=resource_type,
                                    resource_id=resource_id,
                                    change_type="update",
                                    summary="",
                                    changes={"persist_result": result},
                                    editor_type=body.editor_type,
                                    editor_id=body.editor_id,
                                    editor_name=body.editor_name,
                                    agent_run_id=effective_agent_run_id,
                                    session_id=effective_session_id,
                                    version_history=vh,
                                )
                except Exception:
                    logger.exception(
                        "VH/CL write failed for %s:%s, persist committed without version history",
                        resource_type, resource_id,
                    )
                    result["version_history_error"] = True
            finally:
                try:
                    cache.delete(vh_lock_key)
                except Exception:
                    logger.warning(
                        "CSC-013: Failed to release VH lock for %s:%s "
                        "(will auto-expire in %ds)",
                        resource_type, resource_id, CREATE_HISTORY_LOCK_TTL,
                    )

    # R-16: collab-live 双写延迟监控 — 帮助识别 onStore→VH 写入链路中的慢操作
    persist_elapsed = time.monotonic() - persist_start
    if persist_elapsed > 5.0:
        logger.warning(
            "collab_persist: request took %.1fs for %s:%s (threshold 5s)",
            persist_elapsed, resource_type, resource_id,
        )
    elif persist_elapsed > 2.0:
        logger.info(
            "collab_persist: request took %.1fs for %s:%s",
            persist_elapsed, resource_type, resource_id,
        )

    return {"status": "ok", "data": result}


# ── 版本列表 ─────────────────────────────────────────

@router.get("/{resource_type}/{resource_id}/versions", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict})
def list_versions(
    request,
    resource_type: str,
    resource_id: UUID,
    limit: int = 50,
    offset: int = 0,
    named_only: bool = False,
):
    """版本历史列表。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as e:
        return 400, {"status": "error", "message": str(e)}

    resource = adapter.get_resource(str(resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}

    if not adapter.check_permission(request.auth, resource, "view"):
        return 403, {"status": "error", "message": _("auth.permission_denied")}

    limit = min(limit, 200)
    svc = VersionHistoryService(adapter)
    versions = svc.list_versions(
        resource_id, limit=limit, offset=offset, named_only=named_only
    )
    total = svc.count_versions(resource_id, named_only=named_only)

    return {"status": "ok", "data": versions, "total": total}


# ── 创建命名版本 ─────────────────────────────────────

@router.post("/{resource_type}/{resource_id}/versions", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict, 409: dict, 500: dict, 503: dict})
def create_named_version(
    request,
    resource_type: str,
    resource_id: UUID,
    body: CreateNamedVersionRequest,
):
    """创建命名版本（全量快照，永不过期）。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as e:
        return 400, {"status": "error", "message": str(e)}

    resource = adapter.get_resource(str(resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}

    if not adapter.check_permission(request.auth, resource, "edit"):
        return 403, {"status": "error", "message": _("auth.permission_denied")}
    block_response = _organization_resource_write_block_tuple(resource)
    if block_response is not None:
        return block_response

    data = adapter.get_version_data(resource)
    editor_info = _get_editor_info(request)
    svc = VersionHistoryService(adapter)
    organization_id = getattr(resource, "organization_id", None) or getattr(resource, "team_id", None)

    try:
        vh = svc.create_named_version(resource_id, body.name, data, editor_info, organization_id=organization_id)
    except HistoryLockContention:
        logger.warning(
            "create_named_version: lock contention for %s:%s, client may retry",
            resource_type, resource_id,
        )
        return 409, {
            "status": "error",
            "message": _("collab.version_lock_contention"),
            "error_type": "lock_contention",
        }
    except HistoryServiceUnavailable:
        logger.error(
            "create_named_version: Redis unavailable for %s:%s",
            resource_type, resource_id,
        )
        return 503, {
            "status": "error",
            "message": _("collab.version_service_unavailable"),
            "error_type": "service_unavailable",
        }
    except RestoreInProgress:
        logger.info(
            "create_named_version: restore in progress for %s:%s, client may retry",
            resource_type, resource_id,
        )
        return 409, {
            "status": "error",
            "message": _("collab.version_restore_in_progress"),
            "error_type": "restore_in_progress",
        }

    if not vh:
        return 500, {"status": "error", "message": _("collab.version_create_failed")}

    return {
        "status": "ok",
        "data": {"id": str(vh.id), "name": vh.name},
    }


# ── 恢复版本 ─────────────────────────────────────────

@router.post("/{resource_type}/{resource_id}/restore", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict, 409: dict})
def restore_version(
    request,
    resource_type: str,
    resource_id: UUID,
    body: RestoreVersionRequest,
):
    """恢复到指定版本。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as e:
        return 400, {"status": "error", "message": str(e)}

    resource = adapter.get_resource(str(resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}

    if not adapter.check_permission(request.auth, resource, "edit"):
        return 403, {"status": "error", "message": _("auth.permission_denied")}
    block_response = _organization_resource_write_block_tuple(resource)
    if block_response is not None:
        return block_response

    editor_info = _get_editor_info(request)
    svc = VersionHistoryService(adapter)

    # : 表格优先走 collab-first 恢复（Y.Doc 先更新 + persist 写 DB）
    if resource_type == "table":
        try:
            cf_vh = svc.try_collab_first_table_restore(
                resource_id,
                body.version_id,
                editor_info,
                resource=resource,
                user=request.auth,
            )
        except RestoreError:
            raise
        if cf_vh is not None:
            _clear_tabdata_undo_redo_stacks(str(request.auth.id), str(resource_id))
            return {
                "status": "ok",
                "data": {
                    "version_id": str(cf_vh.id),
                    "sync_mode": "collab_first",
                },
            }

    # CC-011: 捕获 RestoreError，返回结构化错误而非意外 500
    try:
        vh = svc.restore_to_version(resource_id, body.version_id, editor_info, user=request.auth)
    except RestoreError as e:
        logger.warning(
            "restore_version failed for %s:%s version %s: [%s] %s",
            resource_type, resource_id, body.version_id, e.error_type, e,
        )
        status_map = {
            RestoreError.VERSION_NOT_FOUND: (404, _("collab.version_not_found")),
            RestoreError.RESOURCE_NOT_FOUND: (404, _("resource.not_found")),
            RestoreError.LOCK_CONTENTION: (409, _("collab.restore_busy")),
        }
        http_status, msg = status_map.get(
            e.error_type, (400, _("collab.restore_failed"))
        )
        return http_status, {
            "status": "error",
            "message": msg,
            "error_type": e.error_type,
        }

    if not vh:
        return 400, {"status": "error", "message": _("collab.restore_failed")}

    # DV-005: 表格恢复后清空 Undo/Redo 栈，防止用户 Undo 越过 restore 时间点
    if resource_type == "table":
        _clear_tabdata_undo_redo_stacks(str(request.auth.id), str(resource_id))

    # : 优先走 Yjs 增量重同步（不断线、无 650ms 重连延迟），
    # 文档未加载 / resync 失败时回退 force-close 兜底。
    sync_result = _resync_or_force_close(resource_type, str(resource_id))

    response_data: dict = {
        "version_id": str(vh.id),
        "sync_mode": sync_result["sync_mode"],
    }
    # 回退 force-close 时沿用既有 collab_sync_warning 语义（FAR-009 / CLB-002）
    fc_result = sync_result.get("fc")
    if fc_result is not None:
        if not fc_result["success"]:
            response_data["collab_sync_warning"] = "force_close_failed"
        elif not fc_result["loaded"]:
            response_data["collab_sync_warning"] = "document_not_loaded"

    return {"status": "ok", "data": response_data}


# ── 版本内容预览 ─────────────────────────────────────

@router.get("/versions/{version_id}/preview", auth=jwt_auth, response={200: dict, 404: dict})
def get_version_preview(request, version_id: UUID):
    """返回指定版本的可预览内容摘要。

    根据 resource_type 返回不同格式：
    - docs: markdown 或 plaintext 预览（Y.js binary 格式返回 preview_unavailable）
    - slide: 完整页面数据（含 elements）+ 主题 + 画布尺寸，供前端渲染真实缩略图
    - 其他: preview_unavailable
    """
    from .models import VersionHistory

    vh = (
        VersionHistory.objects.using(postgres_app_db_alias())
        .filter(id=version_id)
        .first()
    )
    if not vh:
        return 404, {"status": "error", "message": _("collab.version_not_found")}

    try:
        adapter = get_adapter_or_raise(vh.resource_type)
    except ValueError:
        return 200, {
            "status": "ok",
            "data": {
                "type": vh.resource_type,
                "preview_unavailable": True,
                "reason": f"unsupported resource_type: {vh.resource_type}",
            },
        }

    resource = adapter.get_resource(str(vh.resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}

    if not adapter.check_permission(request.auth, resource, "view"):
        return 404, {"status": "error", "message": _("resource.not_found")}

    try:
        svc = VersionHistoryService(adapter)
        data = svc.rebuild_data(vh)
    except Exception as exc:
        logger.warning(
            "get_version_preview: rebuild_data failed for VH %s", version_id,
            exc_info=True,
        )
        return 200, {
            "status": "ok",
            "data": {
                "type": vh.resource_type,
                "preview_unavailable": True,
                "reason": f"rebuild_data failed: {exc}",
            },
        }

    if data is None:
        return 200, {
            "status": "ok",
            "data": {
                "type": vh.resource_type,
                "preview_unavailable": True,
                "reason": "rebuild_data returned None (snapshot deserialization failed)",
            },
        }

    if vh.resource_type == "docs":
        result = _build_docs_preview(data, resource=resource)
        # Fetch previous version's markdown for diff rendering
        if not result.get("preview_unavailable"):
            try:
                prev_vh = (
                    VersionHistory.objects.using(postgres_app_db_alias())
                    .filter(
                        resource_type="docs",
                        resource_id=vh.resource_id,
                        created_at__lt=vh.created_at,
                    )
                    .order_by("-created_at")
                    .first()
                )
                if prev_vh:
                    prev_data = svc.rebuild_data(prev_vh)
                    prev_preview = _build_docs_preview(prev_data, resource=None)
                    result["previous_markdown"] = prev_preview.get("markdown", "")
                else:
                    result["previous_markdown"] = ""
            except Exception:
                logger.debug("get_version_preview: failed to fetch previous version for diff", exc_info=True)
        return 200, {"status": "ok", "data": result}
    elif vh.resource_type == "slide":
        return 200, {"status": "ok", "data": _build_slide_preview(data)}
    elif vh.resource_type == "design":
        return 200, {"status": "ok", "data": _build_design_preview(data)}
    else:
        return 200, {
            "status": "ok",
            "data": {
                "type": vh.resource_type,
                "preview_unavailable": True,
                "reason": f"no preview builder for resource_type: {vh.resource_type}",
            },
        }


def _build_docs_preview(data, resource=None) -> dict:
    """从反序列化后的 docs 版本数据构建预览。

    Y.js binary 优先调用 collab-live 转换；失败时从 resource 的 markdown 字段降级。
    """
    if isinstance(data, bytes):
        import base64
        from apps.services.common.live_api import call_live_api

        try:
            b64 = base64.b64encode(data).decode()
            result = call_live_api(
                "/convert/binary-to-formats",
                {"binary_b64": b64},
                timeout=8,
                max_retries=0,
            )
            markdown = (result or {}).get("markdown", "")
            plaintext = (result or {}).get("plaintext", "")
            return {
                "type": "docs",
                "content_type": "ydoc",
                "markdown": markdown or "",
                "plaintext_preview": (plaintext or "")[:200],
            }
        except Exception as exc:
            logger.warning("_build_docs_preview: binary-to-formats conversion failed, trying resource fallback", exc_info=True)
        if resource is not None:
            md = getattr(resource, "description_markdown", "") or ""
            pt = getattr(resource, "description_plaintext", "") or ""
            if md or pt:
                return {
                    "type": "docs",
                    "content_type": "ydoc",
                    "markdown": md,
                    "plaintext_preview": pt[:200],
                }
        return {
            "type": "docs",
            "content_type": "ydoc",
            "preview_unavailable": True,
            "reason": f"binary ({len(data)} bytes) collab-live conversion failed: {exc}; "
                      f"resource fallback also empty (resource={'present' if resource else 'None'})",
        }

    if isinstance(data, dict):
        markdown = data.get("description_markdown", "")
        plaintext = data.get("description_plaintext", "")
        preview = plaintext[:200] if plaintext else ""
        if not markdown and not preview:
            return {
                "type": "docs",
                "preview_unavailable": True,
                "reason": "dict snapshot has empty description_markdown and description_plaintext",
            }
        return {
            "type": "docs",
            "markdown": markdown or "",
            "plaintext_preview": preview,
        }

    return {
        "type": "docs",
        "preview_unavailable": True,
        "reason": f"unexpected data type: {type(data).__name__}",
    }


def _build_design_preview(data) -> dict:
    """从反序列化后的 design 版本数据构建预览。"""
    if not isinstance(data, dict):
        return {"type": "design", "preview_unavailable": True}
    canvas_width = data.get("canvas_width", 0)
    canvas_height = data.get("canvas_height", 0)
    ai_version = data.get("ai_version", 0)
    penpot_data = data.get("data", {})
    components_count = len(penpot_data.get("components", {})) if isinstance(penpot_data, dict) else 0
    return {
        "type": "design",
        "canvas_width": canvas_width,
        "canvas_height": canvas_height,
        "ai_version": ai_version,
        "components_count": components_count,
    }


def _build_slide_preview(data) -> dict:
    """从反序列化后的 slide 版本数据构建预览。

    返回完整页面数据（含 elements）+ 主题 + 画布尺寸，供前端 SlideRenderer
    渲染真实页面缩略图，而非仅页数/标题摘要——TabSlide 的页面模型没有页级
    title 字段（标题是页内文本元素），仅回传摘要会导致历史面板看不到内容。

    base64 内嵌图片在版本快照阶段已转为 OSS URL
    （见 SlideCollabAdapter._strip_base64_images），故此处 payload 受控。
    """
    pages: list = []
    theme = None
    canvas_width = None
    canvas_height = None
    preset = None
    if isinstance(data, list):
        # 旧格式快照：纯 pages 列表，无 deck 级元数据
        pages = data
    elif isinstance(data, dict):
        pages = data.get("pages", []) or []
        theme = data.get("theme")
        canvas_width = data.get("canvas_width")
        canvas_height = data.get("canvas_height")
        preset = data.get("preset")

    normalized_pages = [page for page in pages if isinstance(page, dict)]

    return {
        "type": "slide",
        "page_count": len(normalized_pages),
        "pages": normalized_pages,
        "theme": theme,
        "canvas_width": canvas_width,
        "canvas_height": canvas_height,
        "preset": preset,
    }


# ── 版本管理操作 ─────────────────────────────────────

@router.patch("/{resource_type}/{resource_id}/versions/{version_id}/name", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict})
def rename_version(
    request, resource_type: str, resource_id: UUID, version_id: UUID, body: RenameVersionRequest
):
    """重命名版本。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as e:
        return 400, {"status": "error", "message": str(e)}

    resource = adapter.get_resource(str(resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}
    if not adapter.check_permission(request.auth, resource, "edit"):
        return 403, {"status": "error", "message": _("auth.permission_denied")}

    from .models import VersionHistory

    vh = VersionHistory.objects.using(postgres_app_db_alias()).filter(
        id=version_id, resource_type=resource_type, resource_id=resource_id
    ).first()
    if not vh:
        return 404, {"status": "error", "message": _("collab.version_not_found")}

    vh.name = body.name
    if body.name and not vh.is_named:
        vh.is_named = True
        vh.expired_at = None
    elif not body.name and vh.is_named:
        vh.is_named = False
    vh.save(using=postgres_app_db_alias(), update_fields=["name", "is_named", "expired_at"])
    return {"status": "ok", "data": {"id": str(vh.id), "name": vh.name}}


@router.patch("/{resource_type}/{resource_id}/versions/{version_id}/pin", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict})
def toggle_pin(
    request, resource_type: str, resource_id: UUID, version_id: UUID, body: TogglePinRequest
):
    """置顶/取消置顶版本。"""
    err = _validate_resource_type(resource_type)
    if err:
        return 400, err

    try:
        adapter = get_adapter_or_raise(resource_type)
    except ValueError as e:
        return 400, {"status": "error", "message": str(e)}

    resource = adapter.get_resource(str(resource_id))
    if not resource:
        return 404, {"status": "error", "message": _("resource.not_found")}
    if not adapter.check_permission(request.auth, resource, "edit"):
        return 403, {"status": "error", "message": _("auth.permission_denied")}

    from .models import VersionHistory

    vh = VersionHistory.objects.using(postgres_app_db_alias()).filter(
        id=version_id, resource_type=resource_type, resource_id=resource_id
    ).first()
    if not vh:
        return 404, {"status": "error", "message": _("collab.version_not_found")}

    svc = VersionHistoryService(adapter)
    svc.toggle_pin(version_id, body.pinned)
    vh.refresh_from_db(using=postgres_app_db_alias())
    return {"status": "ok", "data": {"id": str(vh.id), "pinned": vh.pinned}}


# ── Agent Run 批量回滚 ───────────────────────────────


def _resolve_cascading_run_ids(
    parent_run_id: str, *, max_depth: int = 5,
) -> list[str]:
    """解析父 Agent run_id 关联的所有子 Agent run_id（多层），返回完整集合。

    使用 BFS 逐层展开 SubtaskRun 父子关系，支持任意深度嵌套：
    parent_run_id → ExecutionRun.thread_id → SubtaskRun.parent_thread_id
    → child_thread_id → 子 ExecutionRun.run_id → 继续展开…

    max_depth 防止无限循环，默认最多追踪 5 层。
    """
    seen_run_ids: set[str] = {parent_run_id}
    result = [parent_run_id]

    try:
        from apps.services.agent_engine.models import ExecutionRun, SubtaskRun

        # BFS 队列：每个元素是待展开的 run_id
        queue = [parent_run_id]
        depth = 0

        while queue and depth < max_depth:
            depth += 1

            parent_runs = list(
                ExecutionRun.objects.filter(run_id__in=queue)
                .values("run_id", "thread_id", "started_at", "ended_at")
            )
            if not parent_runs:
                break

            # 批量查询本层所有 parent_thread_id 对应的子 Agent，避免 N+1
            all_child_thread_ids = []
            all_parent_thread_ids = [pr["thread_id"] for pr in parent_runs]
            all_children = list(
                SubtaskRun.objects.filter(
                    parent_thread_id__in=all_parent_thread_ids
                ).values("parent_thread_id", "child_thread_id", "created_at")
            )

            pr_map = {pr["thread_id"]: pr for pr in parent_runs}
            for child in all_children:
                pr = pr_map.get(child["parent_thread_id"])
                if not pr:
                    continue
                if pr["started_at"] and child["created_at"] < pr["started_at"]:
                    continue
                if pr["ended_at"] and child["created_at"] > pr["ended_at"]:
                    continue
                all_child_thread_ids.append(child["child_thread_id"])

            if not all_child_thread_ids:
                break

            # R-02: thread_id 可能在不同时间段被复用，限定时间下界避免误纳入无关 run
            child_runs_qs = ExecutionRun.objects.filter(
                thread_id__in=all_child_thread_ids
            )
            earliest_parent_start = min(
                (pr["started_at"] for pr in parent_runs if pr.get("started_at")),
                default=None,
            )
            if earliest_parent_start is not None:
                child_runs_qs = child_runs_qs.filter(
                    started_at__gte=earliest_parent_start
                )

            child_runs = list(
                child_runs_qs.values_list("run_id", flat=True).distinct()
            )

            next_queue = []
            for rid in child_runs:
                rid_str = str(rid)
                if rid_str not in seen_run_ids:
                    seen_run_ids.add(rid_str)
                    result.append(rid_str)
                    next_queue.append(rid_str)

            logger.debug(
                "BFS 第 %d 层：发现 %d 个新子 Agent run_id",
                depth, len(next_queue),
            )
            queue = next_queue

        if len(result) > 1:
            logger.info(
                "Cascading rollback: parent=%s includes %d child run(s), depth=%d",
                parent_run_id[:8], len(result) - 1, depth,
            )
    except Exception:
        logger.debug(
            "_resolve_cascading_run_ids failed, returning %d collected run_id(s)",
            len(result), exc_info=True,
        )

    return result


def _find_agent_run_pre_change_version(
    *,
    all_run_ids: list[str],
    resource_type: str,
    resource_id: str,
    organization_id=None,
):
    """Return the last resource version that predates an Agent run.

    Agent writes can be followed by a collab ``persist`` carrying user editor
    metadata and no ``agent_run_id``.  Merely excluding run-linked versions
    would treat that post-run persist as the rollback baseline.  The earliest
    run-linked VersionHistory is the temporal boundary; versions at or after
    that boundary are never eligible as the pre-change version.

    ``run_vh_ids`` is returned so callers can protect those histories from
    expiry after a successful rollback.
    """
    from .models import ChangeLog, VersionHistory

    db_alias = postgres_app_db_alias()
    run_vh_ids = list(
        ChangeLog.objects.using(db_alias)
        .filter(
            agent_run_id__in=all_run_ids,
            resource_type=resource_type,
            resource_id=resource_id,
            version_history__isnull=False,
        )
        .values_list("version_history_id", flat=True)
    )

    vh_filter: dict = {
        "resource_type": resource_type,
        "resource_id": resource_id,
    }
    if organization_id is not None:
        vh_filter["organization_id"] = organization_id

    if run_vh_ids:
        first_run_version_at = (
            VersionHistory.objects.using(db_alias)
            .filter(id__in=run_vh_ids)
            .order_by("created_at")
            .values_list("created_at", flat=True)
            .first()
        )
        if first_run_version_at is not None:
            vh_filter["created_at__lt"] = first_run_version_at

    pre_change_version = (
        VersionHistory.objects.using(db_alias)
        .filter(**vh_filter)
        .exclude(id__in=run_vh_ids)
        .order_by("-created_at")
        .first()
    )
    return pre_change_version, run_vh_ids


@router.post("/agent-run/{agent_run_id}/rollback", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict})
def rollback_agent_run(request, agent_run_id: str):
    """
    按 agent_run_id 批量回滚 AI 的一轮操作涉及的所有资源变更。

    自动包含子 Agent（SubtaskRun）的变更，实现级联回退。
    使用事务保护确保全部回滚或全部不回滚。
    新建资源（无 pre_change_version）会被跳过而非导致整体失败。
    """
    # AP-013: 拦截空 agent_run_id，防止命中所有 agent_run_id="" 的 ChangeLog 记录
    if not agent_run_id or not agent_run_id.strip():
        return 400, {"status": "error", "message": _("collab.invalid_agent_run_id")}

    from django.db import transaction as db_transaction

    from .models import ChangeLog, VersionHistory

    all_run_ids = _resolve_cascading_run_ids(agent_run_id)

    changes = (
        ChangeLog.objects.using(postgres_app_db_alias())
        .filter(agent_run_id__in=all_run_ids)
        .order_by("created_at")
    )

    # SDI-013: 先收集资源组，再预检权限，防止存在性泄漏
    resource_groups: dict[tuple, ChangeLog] = {}
    for cl in changes:
        key = (cl.resource_type, str(cl.resource_id))
        if key not in resource_groups:
            resource_groups[key] = cl

    # FIX: agent_run_id 无任何 ChangeLog 记录时（如纯对话场景），
    # 返回 200 + all_skipped 而非 404，让前端正常提示"无可回滚变更"。
    if not resource_groups:
        return {"status": "ok", "data": {
            "agent_run_id": agent_run_id,
            "rollback_results": [],
            "cascaded_run_count": len(all_run_ids) - 1,
            "all_skipped": True,
        }}

    results = []
    permitted_groups: dict[tuple, tuple] = {}
    has_inaccessible_supported_resource = False
    for (res_type, res_id), first_change in resource_groups.items():
        try:
            adapter = get_adapter_or_raise(res_type)
        except ValueError:
            # ``file`` 等虚拟审计资源会参与 Agent run 变更记录，但没有独立的
            # CollabAdapter，不能把它们误判成用户无权限或资源不存在。
            results.append({
                "resource_type": res_type,
                "resource_id": res_id,
                "resource_name": first_change.summary or "",
                "status": "skipped",
                "reason": "unsupported_resource_type",
            })
            continue
        # AP-010: 使用 get_resource_for_rollback 包含已删除/归档资源，
        # 否则 Agent run 中删除的资源会被静默跳过无法回滚
        resource = adapter.get_resource_for_rollback(res_id)
        if resource and adapter.check_permission(request.auth, resource, "edit"):
            permitted_groups[(res_type, res_id)] = (first_change, adapter, resource)
        else:
            has_inaccessible_supported_resource = True

    if not permitted_groups:
        if results and not has_inaccessible_supported_resource:
            return {"status": "ok", "data": {
                "agent_run_id": agent_run_id,
                "rollback_results": results,
                "cascaded_run_count": len(all_run_ids) - 1,
                "all_skipped": True,
            }}
        return 404, {"status": "error", "message": _("resource.not_found")}

    editor_info = _get_editor_info(request)

    from .constants import CHANGE_TYPE_CREATE

    # E2E-009: 在 DB 事务外预先查询 pre_change_version 并申请 Redis 恢复锁，
    # 防止 Redis 不可用时整个批量事务回滚。
    restore_plan: list[tuple] = []  # (res_type, res_id, adapter, resource, pre_change_version, resource_name)
    trash_items: list[tuple] = []   # (res_type, res_id, resource_name) 需要在事务内 trash
    # RB-VH-001: 收集所有被回退的 VH ID，事务成功后保护其 expired_at
    all_rollback_vh_ids: list[UUID] = []

    for (res_type, res_id), (first_change, adapter, resource) in permitted_groups.items():
        # CC-024: 加 organization_id 过滤，防止跨团队数据隔离不完整。
        # resource 对象已通过权限校验，从其上获取 organization_id 作为隔离条件。
        resource_organization_id = getattr(resource, "organization_id", None) or getattr(resource, "team_id", None)
        pre_change_version, run_vh_ids = _find_agent_run_pre_change_version(
            all_run_ids=all_run_ids,
            resource_type=res_type,
            resource_id=res_id,
            organization_id=resource_organization_id,
        )
        # RB-VH-001: 收集被回退的 VH ID，后续统一保护 expired_at
        all_rollback_vh_ids.extend(run_vh_ids)

        # E2E-035: 获取资源名称，方便调试和前端展示
        resource_name = (
            getattr(resource, "name", None) or getattr(resource, "title", "") or ""
        )

        # E2E-015/016: 当 pre_change_version 为 None 时，检查该资源在本次 run 中
        # 是否有 change_type=create 的 ChangeLog。若有，说明资源是 Agent 本次新建的
        # （包括先 create 后 update 的混合场景），应将其移入回收站而非跳过。
        # 只有确认无 create 记录时，才真正 skip（VH 丢失等异常情况）。
        if not pre_change_version:
            has_create = ChangeLog.objects.using(postgres_app_db_alias()).filter(
                agent_run_id__in=all_run_ids,
                resource_type=res_type,
                resource_id=res_id,
                change_type=CHANGE_TYPE_CREATE,
            ).exists()

            if has_create:
                trash_items.append((res_type, res_id, resource_name))
            else:
                # FAR-008 / CSC-016: 区分"真正的新建资源"和"Redis 故障导致 VH 缺失"两种情况。
                has_vh_missing_changelog = (
                    ChangeLog.objects.using(postgres_app_db_alias())
                    .filter(
                        agent_run_id__in=all_run_ids,
                        resource_type=res_type,
                        resource_id=res_id,
                        version_history__isnull=True,
                    )
                    .exists()
                )
                if has_vh_missing_changelog:
                    logger.warning(
                        "rollback_agent_run: skipping %s:%s (%s) — ChangeLog exists but "
                        "version_history is NULL (likely Redis failure during VH write). "
                        "Rollback cannot proceed without a pre-change snapshot.",
                        res_type, res_id, resource_name,
                    )
                    results.append({
                        "resource_type": res_type,
                        "resource_id": res_id,
                        "resource_name": resource_name,
                        "status": "skipped",
                        "reason": "no_version_history",
                        "detail": (
                            "VersionHistory was not written (likely Redis unavailable). "
                            "Cannot roll back without a pre-change snapshot."
                        ),
                    })
                else:
                    logger.info(
                        "rollback_agent_run: skipping %s:%s (%s) — no version exists before "
                        "agent run and no create changelog found",
                        res_type, res_id, resource_name,
                    )
                    results.append({
                        "resource_type": res_type,
                        "resource_id": res_id,
                        "resource_name": resource_name,
                        "status": "skipped",
                        "reason": "no_pre_version",
                    })
            continue

        restore_plan.append((res_type, res_id, adapter, resource, pre_change_version, resource_name))

    # E2E-009: 在事务外逐一申请 Redis 锁；申请失败的资源记录错误并跳过，
    # 不影响其他资源的回滚。
    locked_svcs: dict[tuple, VersionHistoryService] = {}
    lock_errors: list[dict] = []
    for (res_type, res_id, adapter, _res, pre_ver, resource_name) in restore_plan:
        svc = VersionHistoryService(adapter)
        try:
            svc.acquire_restore_lock(UUID(res_id), pre_ver.id)
            locked_svcs[(res_type, res_id)] = svc
        except RestoreError as lock_err:
            logger.warning(
                "rollback_agent_run: failed to acquire restore lock for %s:%s — %s",
                res_type, res_id, lock_err,
            )
            lock_errors.append({
                "resource_type": res_type,
                "resource_id": res_id,
                "resource_name": resource_name,
                "status": "error",
                "reason": "lock_contention",
                "detail": str(lock_err),
            })

    results.extend(lock_errors)

    if restore_plan and not locked_svcs and not trash_items:
        # 所有需要恢复的资源锁都申请失败，直接返回错误
        return 400, {
            "status": "error",
            "message": _("collab.restore_failed"),
            "detail": "All restore locks failed (Redis unavailable or concurrent restore)",
            "rollback_results": results,
        }

    # SR-013: 批量回滚必须全部成功或全部回滚，部分失败时抛异常触发事务回滚
    try:
        with db_transaction.atomic(using=postgres_app_db_alias()):
            # 处理需要 trash 的新建资源
            for (res_type, res_id, resource_name) in trash_items:
                trashed = _trash_resource_in_rollback(res_type, res_id, editor_info)
                if trashed:
                    logger.info(
                        "rollback_agent_run: trashed newly-created %s:%s (%s)",
                        res_type, res_id, resource_name,
                    )
                    results.append({
                        "resource_type": res_type,
                        "resource_id": res_id,
                        "resource_name": resource_name,
                        "status": "trashed",
                        "reason": "new_resource_trashed",
                    })
                else:
                    logger.warning(
                        "rollback_agent_run: failed to trash %s:%s (%s), skipping",
                        res_type, res_id, resource_name,
                    )
                    results.append({
                        "resource_type": res_type,
                        "resource_id": res_id,
                        "resource_name": resource_name,
                        "status": "skipped",
                        "reason": "trash_failed",
                    })

            # 处理需要版本恢复的资源
            for (res_type, res_id, _adapter, resource, pre_change_version, resource_name) in restore_plan:
                if (res_type, res_id) not in locked_svcs:
                    # 该资源锁申请失败，已记录在 lock_errors，跳过
                    continue

                svc = locked_svcs[(res_type, res_id)]
                # E2E-009: 使用 restore_to_version_with_lock_held，跳过事务内 Redis IO
                vh = svc.restore_to_version_with_lock_held(
                    UUID(res_id),
                    pre_change_version.id,
                    editor_info,
                    resource=resource,
                    user=request.auth,
                )

                if not vh:
                    raise RuntimeError(
                        f"Restore failed for {res_type}:{res_id} "
                        f"(target version: {pre_change_version.id})"
                    )

                # E2E-027: 将该 agent_run 对应该 table 的 RecordHistory 标记为已回滚，
                # 使审计视图不再显示"已回滚"的 Agent SQL 操作为未撤销状态。
                # window_id 格式为 agent_sql:{agent_run_id}（由 _emit_record_history_for_write 写入）。
                if res_type == "table":
                    for rid in all_run_ids:
                        _mark_agent_sql_record_history_undone(res_id, rid)

                results.append({
                    "resource_type": res_type,
                    "resource_id": res_id,
                    "resource_name": resource_name,
                    "status": "restored",
                    "restored_to": str(pre_change_version.id),
                    "new_version": str(vh.id),
                })
    except Exception as exc:
        # AP-014: 保留失败的资源和原因详情，便于客户端调试
        logger.exception("rollback_agent_run aborted for agent_run_id=%s", agent_run_id)
        return 400, {
            "status": "error",
            "message": _("collab.restore_failed"),
            "detail": str(exc),
            "rollback_results": results,
        }
    finally:
        # E2E-009: 无论事务成功还是失败，都在事务外释放所有已申请的 Redis 锁
        for (res_type, res_id), svc in locked_svcs.items():
            svc.release_restore_lock(UUID(res_id))

    # RB-VH-001: 保护被回退的 VH 版本，延长 expired_at 至少 90 天，
    # 而非设为 NULL（永不过期）。90 天是 team 套餐的最大 TTL，
    # 足够用户在此期间查看被回退前的内容或创建命名版本永久保留。
    # 与 CC-005（检查点保护）不同，rollback 没有对应的"撤销回退保护"操作，
    # 因此使用有限 TTL 而非 NULL，避免长期存储膨胀。
    if all_rollback_vh_ids:
        try:
            from django.utils import timezone as tz
            from datetime import timedelta

            ROLLBACK_PROTECTION_DAYS = 90
            protection_deadline = tz.now() + timedelta(days=ROLLBACK_PROTECTION_DAYS)

            vhs_to_protect = list(
                VersionHistory.objects.using(postgres_app_db_alias())
                .filter(id__in=all_rollback_vh_ids, expired_at__isnull=False)
                .values_list("id", "expired_at")
            )
            if vhs_to_protect:
                from django.db.models import Case, When, Value, DateTimeField

                cases = []
                for vh_id, current_expired_at in vhs_to_protect:
                    new_expired_at = max(current_expired_at, protection_deadline)
                    cases.append(When(id=vh_id, then=Value(new_expired_at)))
                VersionHistory.objects.using(postgres_app_db_alias()).filter(
                    id__in=[vh_id for vh_id, _ in vhs_to_protect]
                ).update(
                    expired_at=Case(*cases, output_field=DateTimeField())
                )
            protected_count = len(vhs_to_protect)

            if protected_count > 0:
                logger.info(
                    "rollback_agent_run: extended expired_at for %d VH records "
                    "to at least %s (agent_run_id=%s)",
                    protected_count, protection_deadline.date(), agent_run_id,
                )
        except Exception:
            logger.warning(
                "rollback_agent_run: failed to protect VH expired_at for "
                "agent_run_id=%s, versions may be cleaned up by TTL",
                agent_run_id, exc_info=True,
            )

    # VS-006/VS-009: 事务提交后收集各资源的新版本号，
    # 用于 force-close 失败时降级调用 invalidate-version
    version_map: dict[tuple, int] = {}
    for (res_type, res_id, _adapter, resource, _pre_ver, _name) in restore_plan:
        if (res_type, res_id) not in locked_svcs:
            continue
        try:
            resource.refresh_from_db()
            ver = _get_resource_version(resource)
            if ver is not None:
                version_map[(res_type, res_id)] = ver
        except Exception:
            logger.debug(
                "rollback_agent_run: failed to get version for %s:%s after restore",
                res_type, res_id, exc_info=True,
            )

    # E2E-008: 并发调用 force_close，避免串行超时（最坏情况 75s → ~15s）
    import concurrent.futures

    action_items = [item for item in results if item.get("status") in ("restored", "trashed")]

    def _process_action_item(item):
        item_warnings = []
        # DV-005: rollback 恢复 table 资源后清空 Undo/Redo 栈
        if item.get("status") == "restored" and item["resource_type"] == "table":
            _clear_tabdata_undo_redo_stacks(str(request.auth.id), item["resource_id"])
        # VS-006: 先 force-close，失败时降级 invalidate-version
        key = (item["resource_type"], item["resource_id"])
        ver = version_map.get(key)
        sync_result = _force_close_or_invalidate(
            item["resource_type"], item["resource_id"], new_version=ver,
        )
        # E2E-026: loaded=False 表示文档不在 collab-live 内存中（正常状态），不应视为警告
        if not sync_result["success"]:
            item_warnings.append({
                "resource": f"{item['resource_type']}:{item['resource_id']}",
                "warning": "force_close_failed",
            })
        elif sync_result["method"] == "invalidate_version":
            item_warnings.append({
                "resource": f"{item['resource_type']}:{item['resource_id']}",
                "warning": "force_close_failed_invalidate_version_ok",
            })
        return item_warnings

    fc_warnings = []
    if action_items:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(len(action_items), 10)
        ) as executor:
            future_map = {
                executor.submit(_process_action_item, item): item
                for item in action_items
            }
            for future in concurrent.futures.as_completed(future_map):
                try:
                    fc_warnings.extend(future.result())
                except Exception as exc:
                    item = future_map[future]
                    logger.warning(
                        "rollback_agent_run: force_close raised for %s:%s — %s",
                        item["resource_type"], item["resource_id"], exc,
                    )
                    fc_warnings.append({
                        "resource": f"{item['resource_type']}:{item['resource_id']}",
                        "warning": "force_close_failed",
                    })

    # E2E-017: 全部资源均被 skip（无任何 restored/trashed）时，明确标记 all_skipped，
    # 使客户端能区分"无法通过版本回滚撤销"与"成功回滚"两种状态。
    all_skipped = bool(results) and all(r.get("status") == "skipped" for r in results)

    cascaded_run_count = len(all_run_ids) - 1
    response_data: dict = {
        "agent_run_id": agent_run_id,
        "rollback_results": results,
        "cascaded_run_count": cascaded_run_count,
    }
    if all_skipped:
        response_data["all_skipped"] = True
    if fc_warnings:
        response_data["collab_sync_warnings"] = fc_warnings

    return {"status": "ok", "data": response_data}


# ── Agent Run 变更查询 ───────────────────────────────

@router.get("/agent-run/{agent_run_id}/changes", auth=jwt_auth)
def get_agent_run_changes(request, agent_run_id: str):
    """查询某次 Agent Run 涉及的所有跨模块变更（含子 Agent 变更）。"""
    # AP-013: 拦截空 agent_run_id，与 rollback 端点保持一致
    if not agent_run_id or not agent_run_id.strip():
        return 400, {"status": "error", "message": _("collab.invalid_agent_run_id")}

    from .models import ChangeLog

    all_run_ids = _resolve_cascading_run_ids(agent_run_id)

    raw_changes = list(
        ChangeLog.objects.using(postgres_app_db_alias())
        .filter(agent_run_id__in=all_run_ids)
        .order_by("created_at")
        .values(
            "id", "resource_type", "resource_id", "change_type",
            "summary", "editor_type", "editor_name", "created_at",
        )
    )

    visible = []
    checked_resources: dict[tuple, bool] = {}
    for cl in raw_changes:
        key = (cl["resource_type"], str(cl["resource_id"]))
        if key not in checked_resources:
            try:
                adapter = get_adapter_or_raise(cl["resource_type"])
                resource = adapter.get_resource(str(cl["resource_id"]))
                checked_resources[key] = bool(
                    resource and adapter.check_permission(request.auth, resource, "view")
                )
            except ValueError:
                checked_resources[key] = False
        if checked_resources[key]:
            visible.append(cl)

    return {
        "status": "ok",
        "data": visible,
        "total": len(visible),
    }


def _resolve_reverted_out_conversation_anchor(session_id: str | None, message_id: str | None) -> tuple[bool, str | None]:
    """Return whether a conversation anchor is hidden by the session's current revert."""
    if not session_id or not message_id:
        return False, None

    try:
        from apps.chat.conversation.api._common import _visible_messages_queryset
        from apps.chat.conversation.models import ChatMessage, ChatSession

        session = ChatSession.objects.filter(id=session_id).only("id", "revert_message_id").first()
        if not session or not session.revert_message_id:
            return False, None

        if _visible_messages_queryset(session).filter(id=message_id).exists():
            return False, str(session.revert_message_id)

        exists_in_session = ChatMessage.objects.filter(id=message_id, session_id=session.id).exists()
        return bool(exists_in_session), str(session.revert_message_id)
    except Exception:
        logger.debug("get_agent_run_conversation: revert visibility lookup failed", exc_info=True)
        return False, None


@router.get("/agent-run/{agent_run_id}/conversation", auth=jwt_auth, response={200: dict, 400: dict, 404: dict})
def get_agent_run_conversation(request, agent_run_id: str):
    """反查某次 Agent Run 关联的对话 session 和消息，支持从版本历史跳转到对话。"""
    if not agent_run_id or not agent_run_id.strip():
        return 400, {"status": "error", "message": _("collab.invalid_agent_run_id")}

    result = {
        "session_id": None,
        "user_message_id": None,
        "assistant_message_id": None,
        "user_prompt": None,
        "created_at": None,
        "space_id": None,
        "organization_id": None,
        "is_reverted_out": False,
        "revert_message_id": None,
    }

    # 优先从 SpaceCheckpoint.metadata.checkpoint_context 读取（已固化，不依赖 ChatMessage 是否存在）
    from .models import SpaceCheckpoint
    sp = (
        SpaceCheckpoint.objects.using(postgres_app_db_alias())
        .filter(agent_run_id=agent_run_id)
        .order_by("-created_at")
        .values("metadata", "space_id", "organization_id", "anchor_session_id", "anchor_message_id")
        .first()
    )
    if sp:
        ctx = (sp.get("metadata") or {}).get("checkpoint_context") or {}
        result["session_id"] = sp.get("anchor_session_id") or ctx.get("session_id")
        result["assistant_message_id"] = sp.get("anchor_message_id") or ctx.get("assistant_message_id")
        result["user_prompt"] = ctx.get("user_prompt")
        result["space_id"] = str(sp["space_id"]) if sp.get("space_id") else None
        result["organization_id"] = str(sp["organization_id"]) if sp.get("organization_id") else None

    # fallback：通过 ChatMessage.agent_run_id 反查
    if not result["session_id"]:
        try:
            from apps.chat.conversation.models import ChatMessage, ChatSession
            assistant_msg = (
                ChatMessage.objects
                .filter(agent_run_id=agent_run_id, role='assistant')
                .order_by('-created_at')
                .values('id', 'session_id', 'created_at')
                .first()
            )
            if assistant_msg:
                result["session_id"] = str(assistant_msg["session_id"])
                result["assistant_message_id"] = str(assistant_msg["id"])
                result["created_at"] = assistant_msg["created_at"].isoformat() if assistant_msg["created_at"] else None
                session = (
                    ChatSession.objects
                    .filter(id=assistant_msg["session_id"])
                    .values("workspace_id", "organization_id")
                    .first()
                )
                if session:
                    result["space_id"] = str(session["workspace_id"]) if session.get("workspace_id") else None
                    result["organization_id"] = str(session["organization_id"]) if session.get("organization_id") else None

                user_msg = (
                    ChatMessage.objects
                    .filter(
                        session_id=assistant_msg["session_id"],
                        role='user',
                        created_at__lt=assistant_msg["created_at"],
                    )
                    .order_by('-created_at')
                    .values('id', 'text_summary')  # W3 §3.3.1：content → text_summary
                    .first()
                )
                if user_msg:
                    result["user_message_id"] = str(user_msg["id"])
                    result["user_prompt"] = (user_msg.get("text_summary") or "")[:USER_PROMPT_PREVIEW_MAX_LENGTH]
        except Exception:
            logger.debug("get_agent_run_conversation: ChatMessage lookup failed", exc_info=True)

    # SpaceCheckpoint 旧记录可能缺锚点字段；只要拿到 session_id，就用 ChatSession 补齐导航契约。
    if result["session_id"] and not result["space_id"]:
        try:
            from apps.chat.conversation.models import ChatSession
            session = (
                ChatSession.objects
                .filter(id=result["session_id"])
                .values("workspace_id", "organization_id")
                .first()
            )
            if session:
                result["space_id"] = str(session["workspace_id"]) if session.get("workspace_id") else None
                result["organization_id"] = str(session["organization_id"]) if session.get("organization_id") else None
        except Exception:
            logger.debug("get_agent_run_conversation: ChatSession lookup failed", exc_info=True)

    if not result["session_id"]:
        return 404, {"status": "error", "message": "No conversation found for this agent run."}

    try:
        from apps.chat.conversation.models import ChatSession
        from apps.tabtinspace.services.base import BaseService

        if result["space_id"]:
            svc = BaseService(user=request.auth)
            if not svc.check_space_permission(str(result["space_id"]), required_role="viewer"):
                return 403, {"status": "error", "message": _("auth.permission_denied")}
        else:
            owns_session = ChatSession.objects.filter(
                id=result["session_id"],
                user_id=request.auth.id,
            ).exists()
            if not owns_session:
                return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        logger.warning("get_agent_run_conversation: permission check failed", exc_info=True)
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    anchor_message_id = result["assistant_message_id"] or result["user_message_id"]
    is_reverted_out, revert_message_id = _resolve_reverted_out_conversation_anchor(
        result["session_id"],
        anchor_message_id,
    )
    result["is_reverted_out"] = is_reverted_out
    result["revert_message_id"] = revert_message_id

    return 200, {"status": "ok", "data": result}


# ══════════════════════════════════════════════════════
# 资源对话锚点查询
# ══════════════════════════════════════════════════════

@router.get(
    "/resource/{resource_type}/{resource_id}/conversation-anchors",
    auth=jwt_auth,
    response={200: dict, 400: dict, 403: dict, 404: dict},
)
def get_resource_conversation_anchors(
    request,
    resource_type: str,
    resource_id: str,
    limit: int = 20,
    before: str = "",
    include_sub_conversations: bool = False,
):
    """查询某个资源的所有变更记录及关联的对话上下文。

    按 resource_type + resource_id 过滤 ChangeLog，倒序分页返回。
    每条 ChangeLog 附带对话上下文（session_id、消息 ID、user_prompt）。

    性能设计：
    - session_id 优先读 ChangeLog.session_id 新字段（快速路径）
    - fallback 到 ExecutionRun.session_id（同库 PG 单次批量查询，避免 N+1）
    - 对话详情通过批量 ChatMessage 查询构建
    - sub_conversations 默认不返回，仅给 has_sub_conversations 布尔标记
    """
    from django.utils.dateparse import parse_datetime

    from .models import ChangeLog
    from .schemas import (
        ConversationAnchorContext,
        ConversationAnchorItem,
        ConversationAnchorsResponse,
    )

    if resource_type not in RESOURCE_TYPES:
        return 400, {"status": "error", "message": f"Invalid resource_type: {resource_type}"}

    # ── 0. 权限校验 ──
    #
    # QC-04 / Wave 15: `resource_type='file'` 是 TabCode 代码文件的虚拟资源类型，
    # `resource_id` 为 UUID5(path) 计算而来，没有对应的 Collab Adapter（文件不是
    # 独立注册的协作资源）。走「session_id 必须属于登录用户」的权限收敛——
    # 查询结果只包含用户自己会话产生的 ChangeLog，保证跨用户数据不泄露。
    restrict_to_user_sessions = False
    if resource_type == "file":
        restrict_to_user_sessions = True
    else:
        try:
            adapter = get_adapter_or_raise(resource_type)
        except ValueError as e:
            return 400, {"status": "error", "message": str(e)}

        resource = adapter.get_resource(str(resource_id))
        if not resource:
            return 404, {"status": "error", "message": _("resource.not_found")}
        if not adapter.check_permission(request.auth, resource, "view"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}

    limit = min(max(1, limit), 50)

    # ── 1. 查询 ChangeLog（PG），倒序分页 ──
    qs = (
        ChangeLog.objects.using(postgres_app_db_alias())
        .filter(resource_type=resource_type, resource_id=resource_id)
        .order_by("-created_at")
    )

    # QC-04 权限收敛：file 类型限制只返回「当前用户 ChatSession 产生的 ChangeLog」。
    # MySQL 的 ChatSession 不能跨库 JOIN，因此先查当前用户的 session_id 集合，
    # 再用 session_id__in 过滤（PG 侧只按字符串匹配，利用 session_id 索引）。
    if restrict_to_user_sessions:
        try:
            from apps.chat.conversation.models import ChatSession
            user_session_ids = list(
                ChatSession.objects
                .filter(user_id=request.auth.id)
                .values_list("id", flat=True)[:10000]
            )
            # 转成 str，因 ChangeLog.session_id 是 CharField
            user_session_ids = [str(sid) for sid in user_session_ids]
            qs = qs.filter(session_id__in=user_session_ids)
        except Exception:
            logger.warning(
                "conversation-anchors[file]: user session lookup failed, "
                "returning empty result", exc_info=True,
            )
            return 200, {
                "status": "ok",
                "data": ConversationAnchorsResponse(items=[], has_more=False).dict(),
            }

    if before:
        before_dt = parse_datetime(before)
        if not before_dt:
            return 400, {"status": "error", "message": "Invalid 'before' datetime format"}
        qs = qs.filter(created_at__lt=before_dt)

    changelogs = list(
        qs.values(
            "id", "change_type", "summary", "created_at",
            "editor_type", "editor_name", "agent_run_id", "session_id",
            "changes",
        )[: limit + 1]
    )

    has_more = len(changelogs) > limit
    changelogs = changelogs[:limit]

    if not changelogs:
        return 200, {
            "status": "ok",
            "data": ConversationAnchorsResponse(items=[], has_more=False).dict(),
        }

    # ── 2. 批量解析 session_id（快速路径 + fallback） ──
    need_fallback_run_ids: list[str] = []
    for cl in changelogs:
        if not cl["session_id"] and cl["agent_run_id"]:
            need_fallback_run_ids.append(cl["agent_run_id"])

    fallback_session_map: dict[str, str] = {}
    if need_fallback_run_ids:
        try:
            from apps.services.agent_engine.models import ExecutionRun
            for er in (
                ExecutionRun.objects.using(postgres_app_db_alias())
                .filter(run_id__in=need_fallback_run_ids)
                .values("run_id", "session_id")
            ):
                if er.get("session_id"):
                    fallback_session_map[str(er["run_id"])] = er["session_id"]
        except Exception:
            logger.warning("conversation-anchors: ExecutionRun fallback failed", exc_info=True)

    # ── 3. 批量查对话上下文 ──
    session_run_pairs: list[tuple[str, str, str]] = []  # (session_id, agent_run_id, cl_id)
    cl_session_map: dict[str, str] = {}  # cl_id -> session_id
    run_to_cl_ids: dict[str, list[str]] = {}  # run_id -> [cl_id] 预建映射

    for cl in changelogs:
        cl_id = str(cl["id"])
        sid = cl["session_id"] or fallback_session_map.get(cl["agent_run_id"], "")
        cl_session_map[cl_id] = sid
        if sid and cl["agent_run_id"]:
            session_run_pairs.append((sid, cl["agent_run_id"], cl_id))
            run_to_cl_ids.setdefault(cl["agent_run_id"], []).append(cl_id)

    context_map: dict[str, dict] = {}  # cl_id -> context dict
    if session_run_pairs:
        try:
            from apps.chat.conversation.models import ChatMessage

            run_ids = list({p[1] for p in session_run_pairs})
            assistant_msgs = {}
            for msg in (
                ChatMessage.objects
                .filter(agent_run_id__in=run_ids, role="assistant")
                .order_by("-created_at")
                .values("id", "agent_run_id", "session_id", "created_at")
            ):
                assistant_msgs.setdefault(msg["agent_run_id"], msg)

            user_query_targets: list[tuple[str, object, str]] = []  # (session_id, before_created_at, run_id)
            for sid, run_id, cl_id in session_run_pairs:
                amsg = assistant_msgs.get(run_id)
                if amsg:
                    context_map[cl_id] = {
                        "assistant_message_id": str(amsg["id"]),
                        "session_id": sid,
                        "created_at": amsg["created_at"],
                    }
                    user_query_targets.append((str(amsg["session_id"]), amsg["created_at"], run_id))
                else:
                    context_map[cl_id] = {"session_id": sid}

            user_msgs_by_session: dict[str, list] = {}
            if user_query_targets:
                session_ids = list({t[0] for t in user_query_targets})
                # W3 §3.3.1：content → text_summary 字段重命名
                for msg in (
                    ChatMessage.objects
                    .filter(session_id__in=session_ids, role="user")
                    .order_by("-created_at")
                    .values("id", "session_id", "text_summary", "created_at")[:CONVERSATION_ANCHOR_USER_MSG_LIMIT]
                ):
                    user_msgs_by_session.setdefault(str(msg["session_id"]), []).append(msg)

            for sid, before_dt, run_id in user_query_targets:
                user_msgs = user_msgs_by_session.get(sid, [])
                matched_user = None
                for umsg in user_msgs:  # 已按 -created_at 排序
                    if umsg["created_at"] < before_dt:
                        matched_user = umsg
                        break
                if matched_user:
                    for cid in run_to_cl_ids.get(run_id, []):
                        if cid in context_map:
                            context_map[cid]["user_message_id"] = str(matched_user["id"])
                            # W3 §3.3.1：content → text_summary 字段重命名
                            context_map[cid]["user_prompt"] = (matched_user.get("text_summary") or "")[:USER_PROMPT_PREVIEW_MAX_LENGTH]

        except Exception:
            logger.warning("conversation-anchors: ChatMessage batch lookup failed", exc_info=True)

    # ── 4. has_sub_conversations 标记 ──
    has_sub_map: dict[str, bool] = {}
    agent_run_ids_with_session = [
        cl["agent_run_id"]
        for cl in changelogs
        if cl["agent_run_id"] and cl_session_map.get(str(cl["id"]))
    ]
    if agent_run_ids_with_session:
        try:
            from apps.services.agent_engine.models import ExecutionRun, SubtaskRun

            # 单次查询，缓存复用
            er_rows = list(
                ExecutionRun.objects.using(postgres_app_db_alias())
                .filter(run_id__in=agent_run_ids_with_session)
                .values("run_id", "thread_id")
            )
            thread_to_run: dict[str, str] = {}
            parent_thread_ids: list[str] = []
            for er in er_rows:
                rid = str(er["run_id"])
                tid = er.get("thread_id") or ""
                has_sub_map[rid] = False
                if tid:
                    thread_to_run[tid] = rid
                    parent_thread_ids.append(tid)

            if parent_thread_ids:
                sub_parents = set(
                    SubtaskRun.objects.using(postgres_app_db_alias()).filter(
                        parent_thread_id__in=parent_thread_ids
                    ).values_list("parent_thread_id", flat=True).distinct()
                )
                for tid in sub_parents:
                    rid = thread_to_run.get(tid)
                    if rid:
                        has_sub_map[rid] = True
        except Exception:
            logger.warning("conversation-anchors: has_sub check failed", exc_info=True)

    # ── 4.5 批量展开 sub_conversations（仅 include_sub_conversations=true）──
    # 性能关键（PRD §4.3.1）：收集本页所有含子 Agent 的 agent_run_id，
    # 一次性调用批量 BFS；绝不逐条循环 _build_sub_conversations。
    sub_convs_by_run: dict[str, list[dict]] = {}
    sub_convs_batch_ok = True  # 批量展开整体是否成功（外层异常走 False 降级路径）
    if include_sub_conversations:
        parents_with_sub = [rid for rid, has in has_sub_map.items() if has]
        if parents_with_sub:
            try:
                from apps.collab.services.checkpoint_context import (
                    _build_sub_conversations_batch,
                )

                # 取每个 parent 首条可见的 assistant_message_id 作为 parent_message_id
                parent_message_id_by_run: dict[str, str] = {}
                for cl in changelogs:
                    rid = cl["agent_run_id"] or ""
                    if rid not in parents_with_sub or rid in parent_message_id_by_run:
                        continue
                    ctx_row = context_map.get(str(cl["id"])) or {}
                    amsg_id = ctx_row.get("assistant_message_id")
                    if amsg_id:
                        parent_message_id_by_run[rid] = str(amsg_id)

                sub_convs_by_run = _build_sub_conversations_batch(
                    agent_run_ids=parents_with_sub,
                    parent_message_id_by_run=parent_message_id_by_run,
                )
            except Exception:
                logger.warning(
                    "conversation-anchors: batch sub_conversations failed",
                    exc_info=True,
                )
                sub_convs_batch_ok = False

    # ── 5. 组装响应 ──
    # Wave 12 (H1-01) has_sub_conversations 与 sub_conversations 的语义约定：
    # - include_sub_conversations=false：sub_conversations=None；has_sub_conversations 保持真实状态
    # - include_sub_conversations=true 且批量展开成功：sub_conversations=[...]（可能为空列表），
    #   此时 has_sub_conversations 必然与列表状态一致（empty ↔ false）
    # - include_sub_conversations=true 但整体批量展开失败（DB 异常等）：
    #   sub_conversations=None 表示"详情不可用"，保留 has_sub_conversations=true 作为"存在性探测"诚实标签，
    #   前端据此可展示"子任务详情暂不可用"降级 UI，避免用户误解为"无子任务"。
    items = []
    for cl in changelogs:
        cl_id = str(cl["id"])
        ctx_data = context_map.get(cl_id, {})
        sid = cl_session_map.get(cl_id, "")
        run_id = cl["agent_run_id"] or ""
        changes = cl.get("changes") if isinstance(cl.get("changes"), dict) else {}
        checkpoint_commit_hash = changes.get("checkpoint_commit_hash") or None

        context = None
        if sid:
            raw_has_sub = has_sub_map.get(run_id, False)
            if include_sub_conversations and sub_convs_batch_ok:
                sub_convs = sub_convs_by_run.get(run_id, []) if raw_has_sub else []
                # 展开成功路径：has_sub 严格与列表非空一致，消除 true vs [] 的歧义
                has_sub_out = bool(sub_convs)
                sub_convs_out = sub_convs if raw_has_sub else None
            else:
                # 未展开 / 展开整体失败：保留 has_sub 探测结果，详情置 None
                has_sub_out = raw_has_sub
                sub_convs_out = None

            context = ConversationAnchorContext(
                session_id=sid,
                assistant_message_id=ctx_data.get("assistant_message_id"),
                user_message_id=ctx_data.get("user_message_id"),
                user_prompt=ctx_data.get("user_prompt"),
                intent_summary=ctx_data.get("intent_summary"),
                has_sub_conversations=has_sub_out,
                sub_conversations=sub_convs_out,
            )

        items.append(ConversationAnchorItem(
            changelog_id=cl_id,
            checkpoint_commit_hash=checkpoint_commit_hash,
            change_type=cl["change_type"],
            summary=cl["summary"] or "",
            created_at=cl["created_at"],
            editor_type=cl["editor_type"] or "",
            editor_name=cl["editor_name"] or "",
            agent_run_id=run_id,
            context=context,
        ))

    next_before = None
    if has_more and changelogs:
        last_dt = changelogs[-1]["created_at"]
        if last_dt:
            next_before = last_dt.isoformat()

    return 200, {
        "status": "ok",
        "data": ConversationAnchorsResponse(
            items=items,
            has_more=has_more,
            next_before=next_before,
        ).dict(),
    }


# ══════════════════════════════════════════════════════
# 空间级检查点
# ══════════════════════════════════════════════════════

@router.post("/space-checkpoint", auth=jwt_auth, response={200: dict, 400: dict, 403: dict, 404: dict})
def create_space_checkpoint(request, body: CreateSpaceCheckpointRequest):
    """
    创建空间级检查点。

    对 Agent Space 下所有资源的当前版本做快照。
    """
    from .models import SpaceCheckpoint, VersionHistory, ChangeLog
    from apps.tabtinspace.services.host_resolver import resolve_host

    space = resolve_host(body.space_id)
    if not space:
        return 404, {"status": "error", "message": _("resource.space_not_found")}

    try:
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=request.auth)
        if not svc.check_space_permission(str(body.space_id), required_role="editor"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    # A-3: agent_run_id 幂等——同一 space + agent_run_id 不重复创建
    if body.agent_run_id:
        existing = SpaceCheckpoint.objects.using(postgres_app_db_alias()).filter(
            space_id=body.space_id, agent_run_id=body.agent_run_id,
        ).first()
        if existing:
            return 200, {
                "status": "ok",
                "data": {
                    "id": str(existing.id),
                    "name": existing.name,
                    "resource_count": len(existing.version_refs or {}),
                    "created_at": existing.created_at.isoformat() if existing.created_at else None,
                    "idempotent": True,
                },
            }

    organization_id = space.organization_id

    # CC-003 + CC-014 fix: 改用 ContextItem 精确获取 Space 下资源 ID 白名单，
    # 取代 organization_id 聚合，同时解决 organization_id=NULL 漏收和跨 Space 混入
    from apps.tabtinspace.models import ContextItem

    from apps.tabtinspace.services.asset_host import asset_host_q

    resource_id_strs = list(
        ContextItem.objects.using(postgres_app_db_alias())
        .filter(asset_host_q(body.space_id), trashed_at__isnull=True)
        .exclude(resource_id="")
        .values_list("resource_id", flat=True)
        .distinct()
    )

    space_resource_ids = []
    for rid in resource_id_strs:
        try:
            space_resource_ids.append(UUID(rid))
        except (ValueError, TypeError):
            # E2E-014 fix: 非 UUID resource_id 不应静默跳过，记录警告便于排查数据问题
            logger.warning(
                "create_space_checkpoint: skipping non-UUID resource_id %r "
                "in space %s (will not be included in checkpoint)",
                rid, body.space_id,
            )
            continue

    editor_info = _get_editor_info(request)

    # E2E-010 fix: checkpoint 创建与 VH 保护必须在同一事务中，
    # 防止 VH update 失败时 checkpoint 已创建但 VH 未被保护，
    # 导致 cleanup_expired 删除被引用的 VH。
    # CC-026 fix: 将最新版本查询也移入同一事务，消除 TOCTOU 窗口——
    # 查询 version_refs 与写入 SpaceCheckpoint 在同一 atomic 块内，
    # 防止两步之间 collab_persist 写入新版本导致 version_refs 不是精确同时刻快照。
    # ── W3.0 / D27：spin-wait pending ChangeLog Celery 任务 ──────────
    # 在 enrich_checkpoint_for_creation 与 collect_contributed_resources
    # 两次 ChangeLog 反查 **之前** 同步等待，避免漏收 version_refs / impact.tabdata。
    # 与 daemon 路径 ``_create_space_checkpoint`` 对称。
    if body.agent_run_id:
        try:
            from apps.tabdata.services.async_changelog import (
                wait_for_pending_changelogs,
            )
            wait_for_pending_changelogs(body.agent_run_id)
        except Exception:
            logger.debug(
                "create_space_checkpoint: wait_for_pending_changelogs raised "
                "(non-blocking): agent_run=%s",
                body.agent_run_id, exc_info=True,
            )

    # 预计算 checkpoint_context（在事务外执行，避免 MySQL 查询延长 PG 事务持有时间）
    pre_checkpoint_context = None
    pre_anchor_session_id = ""
    pre_anchor_message_id = ""
    try:
        if body.user_prompt or body.agent_run_id:
            from apps.collab.services.checkpoint_context import enrich_checkpoint_for_creation

            # QC-08 / Wave 15：HTTP 路径也透传 body.diff_summary（由 Electron 端
            # 从 Daemon/主进程 checkpoint 流程拿到后一并 POST 过来），
            # 使 `insertions + deletions >= 30` 的 LLM 增强触发条件与 Daemon 路径一致。
            enriched = enrich_checkpoint_for_creation(
                agent_run_id=body.agent_run_id or '',
                space_resource_ids=space_resource_ids or None,
                diff_summary=body.diff_summary,
                user_prompt_override=body.user_prompt[:USER_PROMPT_PREVIEW_MAX_LENGTH] if body.user_prompt else '',
                include_sub_conversations=bool(body.agent_run_id),
            )

            pre_anchor_session_id = enriched.get('anchor_session_id', '')
            pre_anchor_message_id = enriched.get('anchor_message_id', '')
            pre_checkpoint_context = enriched.get('checkpoint_context')
    except Exception:
        logger.warning(
            "create_space_checkpoint: 提取 checkpoint_context 失败: space=%s agent_run=%s",
            body.space_id, body.agent_run_id, exc_info=True,
        )

    # ：客户端显式锚点补齐 enrich 未覆盖的路径（如 trigger=manual）。
    # 仅在 enrich 结果为空时填入，避免覆盖 agent_run 路径已解析的真实消息锚点。
    raw_client_session = getattr(body, "anchor_session_id", None)
    raw_client_message = getattr(body, "anchor_message_id", None)
    client_anchor_session_id = (
        raw_client_session.strip() if isinstance(raw_client_session, str) else ""
    )
    client_anchor_message_id = (
        raw_client_message.strip() if isinstance(raw_client_message, str) else ""
    )
    if client_anchor_session_id and not pre_anchor_session_id:
        pre_anchor_session_id = client_anchor_session_id
    if client_anchor_message_id and not pre_anchor_message_id:
        pre_anchor_message_id = client_anchor_message_id

    # ── W0-1 CC-2：HTTP 路径在 atomic 块前预计算 contributor 资源 ──────────
    # 与 daemon 路径对称——避免 Wave 1 接入 TableResourceContributor 后同 Space
    # 在 Daemon / HTTP 两条入口下 SpaceCheckpoint.version_refs 不一致。
    # contributor 内部可能查 ChangeLog 等慢路径，必须放在 atomic 块外。
    contributed_refs: list = []
    if body.agent_run_id:
        try:
            from apps.collab.services.contributors import (
                collect_contributed_resources,
                expand_agent_run_ids,
            )
            all_run_ids = expand_agent_run_ids(body.agent_run_id)
            contributed_refs = collect_contributed_resources(all_run_ids)
        except Exception:
            logger.warning(
                "create_space_checkpoint: collect_contributed_resources failed "
                "(non-blocking): space=%s agent_run=%s",
                body.space_id, body.agent_run_id, exc_info=True,
            )

    from django.db import transaction as db_transaction

    with db_transaction.atomic(using=postgres_app_db_alias()):
        version_refs = {}
        if space_resource_ids:
            latest_vhs = (
                VersionHistory.objects.using(postgres_app_db_alias())
                .filter(resource_id__in=space_resource_ids)
                .order_by("resource_type", "resource_id", "-created_at")
                .distinct("resource_type", "resource_id")
                .values_list("resource_type", "resource_id", "id")
            )
            for rt, rid, vid in latest_vhs:
                version_refs[f"{rt}:{rid}"] = str(vid)

        # 合并 contributor 贡献（contributor 优先，与 daemon 路径同语义）。
        # 必须在 early return 检查**之前**——contributor 可能贡献 ContextItem 路径
        # 漏掉的资源（例如 Agent 创建后还未 attach 到 Space），不应让 checkpoint
        # 因"看不见"这些资源而被拒绝创建。
        for ref in contributed_refs:
            key = f"{ref['resource_type']}:{ref['resource_id']}"
            version_refs[key] = ref["version_history_id"]

        if not version_refs and not body.file_checkpoint_hash:
            return 400, {"status": "error", "message": _("collab.checkpoint_no_versioned_resources")}

        # W0-1: 与 daemon 路径对齐——contributor 写入的 VH id 可能不是合法 UUID
        # （contributor bug），用 try/except 跳过避免 vh_ids 整段失败导致
        # checkpoint 不能创建。原 ContextItem 路径的 VH id 来自 PG 查询本身可信，
        # 此处放宽不会引入新的"应失败但被吞"风险——失败会通过 logger.debug 留痕。
        vh_ids = []
        for vid in version_refs.values():
            try:
                vh_ids.append(UUID(vid))
            except (ValueError, TypeError):
                logger.debug(
                    "create_space_checkpoint: skip invalid VH id in "
                    "version_refs: %r",
                    vid,
                )
        original_expired_at = {}
        if vh_ids:
            for vid, exp_at in (
                VersionHistory.objects.using(postgres_app_db_alias())
                .filter(id__in=vh_ids, expired_at__isnull=False)
                .values_list("id", "expired_at")
            ):
                original_expired_at[str(vid)] = exp_at.isoformat()

        metadata = {"original_expired_at": original_expired_at} if original_expired_at else {}
        if body.checkpoint_policy:
            metadata["checkpoint_policy"] = body.checkpoint_policy
        if pre_checkpoint_context:
            metadata["checkpoint_context"] = pre_checkpoint_context

        cp = SpaceCheckpoint.objects.using(postgres_app_db_alias()).create(
            organization_id=organization_id,
            space_id=body.space_id,
            name=body.name,
            version_refs=version_refs,
            file_checkpoint_hash=body.file_checkpoint_hash,
            agent_run_id=body.agent_run_id,
            trigger=body.trigger,
            metadata=metadata,
            anchor_session_id=pre_anchor_session_id,
            anchor_message_id=pre_anchor_message_id,
            **editor_info,
        )

        if vh_ids:
            VersionHistory.objects.using(postgres_app_db_alias()).filter(
                id__in=vh_ids,
                expired_at__isnull=False,
            ).update(expired_at=None)

    # 异步生成 intent_summary + decision_summary（best-effort）
    try:
        from apps.services.agent_engine.tasks.checkpoint_summary import maybe_dispatch_checkpoint_summaries
        # QC-08：向触发判断也传入 body.diff_summary，使 HTTP 路径能命中
        # `insertions + deletions >= 30` 条件（否则只能靠 impact.resources/files）。
        maybe_dispatch_checkpoint_summaries(
            str(cp.id), pre_checkpoint_context, body.diff_summary,
            log_prefix="create_space_checkpoint: ",
        )
    except Exception:
        logger.debug("create_space_checkpoint: Failed to dispatch summary tasks", exc_info=True)

    return {
        "status": "ok",
        "data": {
            "id": str(cp.id),
            "name": cp.name,
            "resource_count": len(version_refs),
            "created_at": cp.created_at.isoformat() if cp.created_at else None,
        },
    }


@router.get(
    "/space-checkpoint/{checkpoint_id}/decision-context",
    auth=jwt_auth,
    response={200: dict, 403: dict, 404: dict},
)
def get_space_checkpoint_decision_context(request, checkpoint_id: UUID):  # noqa: C901
    # NOTE(Wave 13): 保留 response=dict 而非 DecisionContextResponse 的原因：
    # 外层需要 {"status": "ok", "data": {...}} 包裹（与 create/list/restore 其他
    # space-checkpoint 路由一致）。改用 schema 会破坏这个统一 envelope 约定。
    # 字段契约通过 schemas.DecisionContextResponse 作为文档 + 前端 TS 类型双向锚定。
    """Checkpoint 决策上下文查询（PRD §4.3.3）。

    返回 SpaceCheckpoint 的一等 anchor 字段 + metadata.checkpoint_context 完整快照
    + version_refs，供前端 CheckpointContextCard 展开时兜底拉取（覆盖 WS 丢包）。

    响应契约（Wave 13 PRD §4.3.3）：
    {
      "checkpoint_id": "uuid",
      "anchor_session_id": "uuid",
      "anchor_message_id": "uuid",
      "context": {
        "user_prompt", "user_message_id", "assistant_message_id",
        "agent_run_id", "intent_summary",
        "decision_summary": {...},
        "sub_conversations": [...],
        "impact": {...}
      },
      "version_refs": {...}
    }

    权限：Space 成员（viewer 及以上，与 list_space_checkpoints 对齐）。
    """
    from .models import SpaceCheckpoint

    cp = (
        SpaceCheckpoint.objects.using(postgres_app_db_alias())
        .filter(id=checkpoint_id)
        .first()
    )
    if not cp:
        return 404, {"status": "error", "message": _("collab.checkpoint_not_found")}

    try:
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=request.auth)
        if not svc.check_space_permission(str(cp.space_id), required_role="viewer"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    metadata = cp.metadata or {}
    ctx_raw = metadata.get("checkpoint_context") or {}

    # 构造响应 context：优先使用 metadata 中已固化字段，保证 Session 被归档
    # 或 ChatMessage 被删除后仍可展示（PRD §3.5 / §3.6 归档降级一致）。
    impact_raw = ctx_raw.get("impact") or {}
    impact_payload = None
    if impact_raw:
        impact_payload = {
            "files": impact_raw.get("files"),
            "files_truncated": bool(impact_raw.get("files_truncated", False)),
            "files_total_count": int(impact_raw.get("files_total_count", 0) or 0),
            "resources": impact_raw.get("resources"),
            "resources_truncated": bool(impact_raw.get("resources_truncated", False)),
            "resources_total_count": int(impact_raw.get("resources_total_count", 0) or 0),
        }

    decision_summary_raw = ctx_raw.get("decision_summary")
    sub_conversations_raw = ctx_raw.get("sub_conversations")

    context_payload = {
        "user_prompt": ctx_raw.get("user_prompt") or None,
        "user_message_id": ctx_raw.get("user_message_id") or None,
        "assistant_message_id": ctx_raw.get("assistant_message_id") or None,
        "agent_run_id": ctx_raw.get("agent_run_id") or cp.agent_run_id or None,
        "intent_summary": ctx_raw.get("intent_summary") or None,
        "decision_summary": decision_summary_raw if isinstance(decision_summary_raw, dict) else None,
        "sub_conversations": sub_conversations_raw if isinstance(sub_conversations_raw, list) else None,
        "impact": impact_payload,
    }

    return 200, {
        "status": "ok",
        "data": {
            "checkpoint_id": str(cp.id),
            # 优先使用一等字段（索引友好且单一真源），
            # metadata 中的 session_id / assistant_message_id 留作容灾 fallback。
            "anchor_session_id": cp.anchor_session_id or ctx_raw.get("session_id") or None,
            "anchor_message_id": cp.anchor_message_id or ctx_raw.get("assistant_message_id") or None,
            "context": context_payload,
            "version_refs": cp.version_refs or {},
        },
    }


@router.get("/space-checkpoint/{space_id}/list", auth=jwt_auth, response={200: dict, 403: dict, 404: dict})
def list_space_checkpoints(
    request,
    space_id: UUID,
    limit: int = 20,
    offset: int = 0,
):
    """列出 Space 的所有检查点。"""
    from apps.tabtinspace.services.host_resolver import host_exists

    if not host_exists(space_id):
        return 404, {"status": "error", "message": _("resource.space_not_found")}

    try:
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=request.auth)
        if not svc.check_space_permission(str(space_id), required_role="viewer"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    from .models import SpaceCheckpoint

    qs = (
        SpaceCheckpoint.objects.using(postgres_app_db_alias())
        .filter(space_id=space_id)
        .order_by("-created_at")
    )
    total = qs.count()
    checkpoints = qs[offset : offset + limit]

    data = [
        {
            "id": str(cp.id),
            "name": cp.name,
            "trigger": cp.trigger,
            "resource_count": len(cp.version_refs),
            "file_checkpoint_hash": cp.file_checkpoint_hash,
            "agent_run_id": cp.agent_run_id,
            "anchor_session_id": cp.anchor_session_id or "",
            "anchor_message_id": cp.anchor_message_id or "",
            "editor_type": cp.editor_type,
            "editor_name": cp.editor_name,
            "created_at": cp.created_at.isoformat(),
        }
        for cp in checkpoints
    ]

    return {"status": "ok", "data": data, "total": total}


@router.delete("/space-checkpoint/{checkpoint_id}", auth=jwt_auth, response={200: dict, 403: dict, 404: dict})
def delete_space_checkpoint(request, checkpoint_id: UUID):
    """
    删除空间检查点。

    CC-005 残留修复: 删除检查点时恢复被保护的 VH 记录的 expired_at，
    防止长期存储膨胀。仅恢复不被其他检查点引用且未被命名/置顶的 VH。
    """
    from django.db import transaction as db_transaction
    from django.utils.dateparse import parse_datetime

    from .models import SpaceCheckpoint, VersionHistory

    cp = (
        SpaceCheckpoint.objects.using(postgres_app_db_alias())
        .filter(id=checkpoint_id)
        .first()
    )
    if not cp:
        return 404, {"status": "error", "message": _("collab.checkpoint_not_found")}

    try:
        from apps.tabtinspace.services.base import BaseService
        svc_perm = BaseService(user=request.auth)
        if not svc_perm.check_space_permission(str(cp.space_id), required_role="editor"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    original_expired_at = (cp.metadata or {}).get("original_expired_at", {})

    other_referenced_vh_ids: set[UUID] = set()
    if original_expired_at:
        other_checkpoints = (
            SpaceCheckpoint.objects.using(postgres_app_db_alias())
            .filter(space_id=cp.space_id)
            .exclude(id=checkpoint_id)
            .values_list("version_refs", flat=True)
        )
        for refs in other_checkpoints:
            if refs:
                for vid_str in refs.values():
                    try:
                        other_referenced_vh_ids.add(UUID(vid_str))
                    except (ValueError, TypeError):
                        pass

    with db_transaction.atomic(using=postgres_app_db_alias()):
        for vh_id_str, exp_at_str in original_expired_at.items():
            try:
                vh_id = UUID(vh_id_str)
            except (ValueError, TypeError):
                continue

            if vh_id in other_referenced_vh_ids:
                continue

            exp_at = parse_datetime(exp_at_str)
            if not exp_at:
                continue

            VersionHistory.objects.using(postgres_app_db_alias()).filter(
                id=vh_id,
                is_named=False,
                pinned=False,
                expired_at__isnull=True,
            ).update(expired_at=exp_at)

        cp.delete()

    return {"status": "ok", "data": {"checkpoint_id": str(checkpoint_id), "deleted": True}}


@router.post("/space-checkpoint/{checkpoint_id}/restore", auth=jwt_auth, response={200: dict, 403: dict, 404: dict, 500: dict, 503: dict})
def restore_space_checkpoint(request, checkpoint_id: UUID):
    """
    恢复到空间检查点。

    遍历 version_refs，对每个资源调用 adapter.restore() 回到对应版本。

    CC-004: 所有资源恢复包裹在全局事务中，任一失败则全部回滚。
    CC-022: 根据恢复结果返回不同 HTTP 状态码。
    CC-028/CC-029: 批量预查询 VersionHistory，减少 N+1 查询。
    """
    from django.db import transaction as db_transaction

    from .models import SpaceCheckpoint, VersionHistory

    cp = (
        SpaceCheckpoint.objects.using(postgres_app_db_alias())
        .filter(id=checkpoint_id)
        .first()
    )
    if not cp:
        return 404, {"status": "error", "message": _("collab.checkpoint_not_found")}

    try:
        from apps.tabtinspace.services.base import BaseService
        svc_perm = BaseService(user=request.auth)
        if not svc_perm.check_space_permission(str(cp.space_id), required_role="editor"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    if not cp.version_refs:
        return 200, {
            "status": "ok",
            "data": {
                "checkpoint_id": str(checkpoint_id),
                "checkpoint_name": cp.name,
                "results": [],
                "file_checkpoint_hash": cp.file_checkpoint_hash,
            },
        }

    editor_info = _get_editor_info(request)

    # C5 / Wave 2: 回滚前发射 before_checkpoint_rollback 信号
    # tabdata 等模块订阅此信号，暂停相关 Outbox 任务（Wave 3 D1 启用）
    try:
        from apps.collab.checkpoint_signals import before_checkpoint_rollback
        before_checkpoint_rollback.send_robust(
            sender=restore_space_checkpoint,
            checkpoint_id=checkpoint_id,
            space_id=cp.space_id,
            version_refs=cp.version_refs or {},
            initiator_user_id=str(request.auth.id),
            initiator_editor_type=getattr(request.auth, 'editor_type', 'user'),
        )
    except Exception:
        logger.warning(
            "restore_space_checkpoint: failed to send before_checkpoint_rollback signal",
            exc_info=True,
        )

    # CC-029: 批量预查询所有目标 VersionHistory，消除 N+1 查询
    target_version_ids = []
    for vid_str in cp.version_refs.values():
        try:
            target_version_ids.append(UUID(vid_str))
        except (ValueError, TypeError):
            pass

    prefetched_versions = {
        vh.id: vh
        for vh in VersionHistory.objects.using(postgres_app_db_alias()).filter(
            id__in=target_version_ids
        )
    }

    # 预校验阶段：解析 ref_key、获取 adapter/resource、检查权限、匹配预取版本
    pre_errors = []
    restore_items = []

    # DEF-006: 批量查询当前仍在该 space 中的资源 ID，
    # 防止资源从 space A 移到 space B 后恢复 space A 的 checkpoint 影响 space B
    from apps.tabtinspace.models import ContextItem

    from apps.tabtinspace.services.asset_host import asset_host_q

    current_space_resource_ids = set(
        ContextItem.objects.using(postgres_app_db_alias())
        .filter(asset_host_q(cp.space_id), trashed_at__isnull=True)
        .exclude(resource_id="")
        .values_list("resource_id", flat=True)
        .distinct()
    )

    for ref_key, version_id_str in cp.version_refs.items():
        parts = ref_key.split(":", 1)
        if len(parts) != 2:
            pre_errors.append({"resource": ref_key, "error": "Invalid ref_key format", "restored": False})
            continue
        res_type, res_id = parts

        # DEF-006: 检查资源是否仍在该 space 中，
        # 兼容 ContextItem 机制和模型上的 space_id / space 字段
        if res_id not in current_space_resource_ids:
            logger.warning(
                "restore_space_checkpoint: resource %s no longer belongs to "
                "space %s (moved or removed), skipping to prevent cross-space impact",
                ref_key, cp.space_id,
            )
            pre_errors.append({
                "resource": ref_key,
                "error": "Resource no longer in this space",
                "restored": False,
            })
            continue

        try:
            adapter = get_adapter_or_raise(res_type)
        except ValueError:
            pre_errors.append({"resource": ref_key, "error": "No adapter", "restored": False})
            continue

        # E2E-011 fix: 使用 get_resource_for_rollback 而非 get_resource，
        # 确保检查点创建后被删除/归档的资源也能被恢复，
        # 避免 get_resource 返回 None 导致整个检查点恢复失败。
        resource = adapter.get_resource_for_rollback(res_id)
        if not resource:
            pre_errors.append({"resource": ref_key, "error": _("resource.not_found"), "restored": False})
            continue

        # DEF-006: 备用校验——检查模型上的 space_id / space 字段
        resource_space_id = getattr(resource, "space_id", None) or getattr(resource, "space", None)
        if resource_space_id is not None:
            if str(resource_space_id) != str(cp.space_id):
                logger.warning(
                    "restore_space_checkpoint: resource %s model.space_id=%s != "
                    "checkpoint.space_id=%s, skipping to prevent cross-space impact",
                    ref_key, resource_space_id, cp.space_id,
                )
                pre_errors.append({
                    "resource": ref_key,
                    "error": "Resource model space_id mismatch",
                    "restored": False,
                })
                continue

        if not adapter.check_permission(request.auth, resource, "edit"):
            pre_errors.append({"resource": ref_key, "error": _("auth.permission_denied"), "restored": False})
            continue

        block_response = _organization_resource_write_block_tuple(resource)
        if block_response is not None:
            _, body = block_response
            pre_errors.append({
                "resource": ref_key,
                "error": body.get("message") or "Organization resource write blocked",
                "code": body.get("code"),
                "restored": False,
            })
            continue

        try:
            vid = UUID(version_id_str)
        except (ValueError, TypeError):
            pre_errors.append({"resource": ref_key, "error": "Invalid version_id format", "restored": False})
            continue

        target_vh = prefetched_versions.get(vid)
        if not target_vh:
            pre_errors.append({"resource": ref_key, "error": _("collab.version_not_found"), "restored": False})
            continue

        restore_items.append({
            "ref_key": ref_key,
            "res_type": res_type,
            "res_id": res_id,
            "adapter": adapter,
            "resource": resource,
            "version_id": vid,
            "target": target_vh,
        })

    # CC-022: 无可恢复资源时返回 500
    if not restore_items:
        return 500, {
            "status": "error",
            "message": _("collab.restore_failed"),
            "data": {
                "checkpoint_id": str(checkpoint_id),
                "errors": pre_errors,
            },
        }

    # CC-022: 存在预校验错误（部分资源不可恢复）时拒绝整体恢复，
    # 保证全有全无语义，避免部分成功的不一致状态
    if pre_errors:
        return 500, {
            "status": "error",
            "message": _("collab.restore_failed"),
            "data": {
                "checkpoint_id": str(checkpoint_id),
                "errors": pre_errors,
            },
        }

    # E2E-013 fix: 在 DB 事务外预先申请所有资源的 Redis 锁，
    # 避免 Redis IO 在 DB 事务内执行（Redis 不可用时不会回滚已提交的 DB 操作）。
    # E2E-031 fix: 锁在事务外申请，事务回滚后可立即主动释放，
    # 不再依赖 TTL 自动过期（120s）。
    acquired_locks: list[tuple] = []  # [(svc, resource_id), ...]
    lock_error = None
    for item in restore_items:
        svc = VersionHistoryService(item["adapter"])
        try:
            svc.acquire_restore_lock(UUID(item["res_id"]), item["version_id"])
            acquired_locks.append((svc, UUID(item["res_id"])))
        except RestoreError as e:
            lock_error = e
            break

    if lock_error is not None:
        # 释放已申请的锁
        for svc, rid in acquired_locks:
            svc.release_restore_lock(rid)
        # E2E-012 fix: LOCK_CONTENTION 返回 503（可重试），其他错误返回 500
        if lock_error.error_type == RestoreError.LOCK_CONTENTION:
            logger.warning(
                "restore_space_checkpoint: lock contention for checkpoint %s, "
                "caller may retry",
                checkpoint_id,
            )
            return 503, {
                "status": "error",
                "error_type": RestoreError.LOCK_CONTENTION,
                "message": _("collab.restore_lock_contention"),
                "data": {"checkpoint_id": str(checkpoint_id)},
            }
        return 500, {
            "status": "error",
            "error_type": lock_error.error_type,
            "message": _("collab.restore_failed"),
            "data": {"checkpoint_id": str(checkpoint_id)},
        }

    # CC-004: 全局事务包裹所有资源恢复，任一失败则全部回滚。
    # E2E-013 fix: 事务内使用 restore_to_version_with_lock_held（跳过锁申请），
    # 所有 Redis IO 已在事务外完成。
    results = []
    restore_exc: Exception | None = None
    try:
        with db_transaction.atomic(using=postgres_app_db_alias()):
            for item in restore_items:
                svc = VersionHistoryService(item["adapter"])
                vh = svc.restore_to_version_with_lock_held(
                    UUID(item["res_id"]),
                    item["version_id"],
                    editor_info,
                    resource=item["resource"],
                    target=item["target"],
                )

                if not vh:
                    raise RuntimeError(
                        f"Restore failed for {item['ref_key']} "
                        f"(target version: {item['version_id']})"
                    )

                results.append({
                    "resource": item["ref_key"],
                    "restored": True,
                    "new_version": str(vh.id),
                })
    except Exception as exc:
        restore_exc = exc
    finally:
        # E2E-031 fix: 无论事务成功还是回滚，立即主动释放所有 Redis 锁，
        # 不等待 TTL 自动过期（120s），让其他恢复请求可以立即重试。
        for svc, rid in acquired_locks:
            svc.release_restore_lock(rid)

    if restore_exc is not None:
        logger.exception(
            "restore_space_checkpoint aborted for checkpoint %s, "
            "all changes rolled back",
            checkpoint_id,
            exc_info=restore_exc,
        )
        # E2E-012 fix: 区分 RestoreError 类型，LOCK_CONTENTION 返回 503（可重试），
        # REBUILD_FAILED 等不可重试错误返回 500。
        if isinstance(restore_exc, RestoreError):
            if restore_exc.error_type == RestoreError.LOCK_CONTENTION:
                return 503, {
                    "status": "error",
                    "error_type": RestoreError.LOCK_CONTENTION,
                    "message": _("collab.restore_lock_contention"),
                    "data": {"checkpoint_id": str(checkpoint_id)},
                }
            return 500, {
                "status": "error",
                "error_type": restore_exc.error_type,
                "message": _("collab.restore_failed"),
                "data": {"checkpoint_id": str(checkpoint_id)},
            }
        return 500, {
            "status": "error",
            "message": _("collab.restore_failed"),
            "data": {"checkpoint_id": str(checkpoint_id)},
        }

    # CC-015: 检查点包含文件系统快照时，异步通知 daemon 恢复 TabCode 文件。
    # DB 事务已提交后才触发异步任务，避免任务读到未提交数据。
    file_restore_dispatched = False
    if cp.file_checkpoint_hash:
        try:
            from .tasks import async_restore_file_checkpoint
            async_restore_file_checkpoint.delay(
                thread_id=cp.agent_run_id or str(cp.space_id),
                file_checkpoint_hash=cp.file_checkpoint_hash,
                space_id=str(cp.space_id),
            )
            file_restore_dispatched = True
        except Exception:
            logger.warning(
                "Failed to dispatch async_restore_file_checkpoint for "
                "checkpoint %s (hash=%s)",
                checkpoint_id, cp.file_checkpoint_hash,
                exc_info=True,
            )

    # VS-007: 事务提交后收集各资源的新版本号，
    # 用于 force-close 失败时降级调用 invalidate-version
    version_map: dict[str, int] = {}
    for item in restore_items:
        try:
            item["resource"].refresh_from_db()
            ver = _get_resource_version(item["resource"])
            if ver is not None:
                version_map[item["ref_key"]] = ver
        except Exception:
            logger.debug(
                "restore_space_checkpoint: failed to get version for %s",
                item["ref_key"], exc_info=True,
            )

    fc_warnings = []
    for item in results:
        parts = item["resource"].split(":", 1)
        if len(parts) == 2:
            # DV-005: checkpoint 恢复 table 资源后清空 Undo/Redo 栈
            if parts[0] == "table":
                _clear_tabdata_undo_redo_stacks(str(request.auth.id), parts[1])
            # VS-007: 先 force-close，失败时降级 invalidate-version
            ver = version_map.get(item["resource"])
            sync_result = _force_close_or_invalidate(parts[0], parts[1], new_version=ver)
            if not sync_result["success"]:
                fc_warnings.append({"resource": item["resource"], "warning": "force_close_failed"})
            elif sync_result["method"] == "invalidate_version":
                fc_warnings.append({
                    "resource": item["resource"],
                    "warning": "force_close_failed_invalidate_version_ok",
                })
            # VS-016: loaded=False 是正常状态（文档不在内存，Redis 广播已发出），不应视为警告

    response_data: dict = {
        "checkpoint_id": str(checkpoint_id),
        "checkpoint_name": cp.name,
        "results": results,
        "file_checkpoint_hash": cp.file_checkpoint_hash,
        "file_restore_dispatched": file_restore_dispatched,
    }
    if fc_warnings:
        response_data["collab_sync_warnings"] = fc_warnings

    return {"status": "ok", "data": response_data}


@router.get("/space-timeline/{space_id}", auth=jwt_auth, response={200: dict, 403: dict})
def space_timeline(
    request,
    space_id: UUID,
    limit: int = 50,
    offset: int = 0,
):
    """
    空间时间线：聚合所有模块的 ChangeLog，按时间排列。

    需要用户对该 Space 有 viewer 权限。
    """
    from .models import ChangeLog

    try:
        from apps.tabtinspace.services.base import BaseService
        svc = BaseService(user=request.auth)
        if not svc.check_space_permission(str(space_id), required_role="viewer"):
            return 403, {"status": "error", "message": _("auth.permission_denied")}
    except Exception:
        return 403, {"status": "error", "message": _("auth.permission_check_failed")}

    limit = min(limit, 200)

    # CO-5: 通过 ContextItem 获取当前 Space 的资源 ID，而非 organization 级别，
    # 避免同一 organization 下其他 space 的文档编辑历史泄漏。
    from apps.tabtinspace.models import ContextItem

    from apps.tabtinspace.services.asset_host import asset_host_q

    resource_id_strs = list(
        ContextItem.objects.using(postgres_app_db_alias())
        .filter(asset_host_q(space_id), trashed_at__isnull=True)
        .exclude(resource_id="")
        .values_list("resource_id", flat=True)
        .distinct()
    )

    if not resource_id_strs:
        return {"status": "ok", "data": []}

    space_resource_ids = []
    for rid in resource_id_strs:
        try:
            space_resource_ids.append(UUID(rid))
        except (ValueError, TypeError):
            continue

    if not space_resource_ids:
        return {"status": "ok", "data": []}

    changes = (
        ChangeLog.objects.using(postgres_app_db_alias())
        .filter(resource_id__in=space_resource_ids)
        .order_by("-created_at")
        [offset : offset + limit]
        .values(
            "id", "resource_type", "resource_id", "change_type",
            "summary", "editor_type", "editor_id", "editor_name",
            "agent_run_id", "created_at",
        )
    )

    return {"status": "ok", "data": list(changes)}

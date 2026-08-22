"""共享任务 API（ 共享 Agent 任务，文档协同式）。

产品口径：被授权人（grantee）进入 owner 的**同一个会话**——查看走主鉴权
``_get_session_with_shared_access`` 第三分支（读端点 + WS 实时流全量透明，
见 api/_common.py），本模块只保留「叠加权限位」端点：

- ``POST /sessions/{session_id}/shared-fork``  接收人把会话快照（正文 +
  工具名 + 附件引用）抄成自己的 Agent × Workspace 新会话（需 active share
  且 can_fork）。
- ``GET  /sessions/{session_id}/shared-execution-status``  can_chat 发送前
  只读预检：owner 执行机是否可达（与 PromptForward 投递成功条件同源）。
- ``POST /sessions/{session_id}/shared-chat``  发言驱动（需 active share 且
  can_chat）：权限门 + 审计后进入 **ChatService** 与用户自有会话同一发送
  流水线——执行身份 = owner（Agent / 设备 / 费用），发言归属 = grantee
  （``app_context._shared_chat_by``）；审批仍只弹 owner 设备。

共享卡的业务编排也在本模块：授权事实仍由 conversation 维护，完整展示投影
通过 Django MessageService 写入消息，并由 Outbox/Centrifugo 投递实时更新。
"""

from uuid import UUID

from django.contrib.auth import get_user_model
from django.utils import timezone
from ninja import Body, Schema

from apps.i18n.response import success_response, error_response_with_status
from ..models import ChatSession
from ..schemas import SharedChatRequest, SharedFilePreviewRequest, SharedForkRequest
from ._common import (
    router, jwt_auth, logger,
    _session_to_schema,
    _visible_message_count,
)
from ..services import session_share_service
from ..services import session_share_card_service
from ..services.share_fork_turns import collect_share_turns

# 防探测统一口径：不区分「会话不存在」「无共享」「已撤销」。
_SHARED_ACCESS_DENIED = "共享会话不存在或无权查看"

# shared-chat 透传给前端的 ChatService 结果字段（与自有会话 send_message_sync
# 同构；device_offline / model_not_found 等 error_category 如实透传）。
_SHARED_CHAT_RESULT_FIELDS = (
    "message_id", "reply", "content", "model_id", "model_name",
    "trace_id", "error_category", "error_message", "error_code",
)


class CreateSessionShareCardRequest(Schema):
    session_id: str
    grantee_user_id: str
    can_fork: bool = False
    can_chat: bool = False
    conversation_id: str | None = None
    client_request_id: str | None = None
    restore_share_id: str | None = None
    card_contract: str = "session_share"
    access_mode: str | None = None


class BatchSessionShareDetailRequest(Schema):
    object_ids: list[str]


class UpdateSessionShareAccessRequest(Schema):
    access_mode: str


class RevokeSessionShareCardRequest(Schema):
    # 兼容旧客户端：未声明能力时继续保留投影刷新失败的 503 契约。
    accept_committed_revoke: bool = False


def _denied_403():
    return error_response_with_status(
        "FORBIDDEN", message=_SHARED_ACCESS_DENIED, status_code=403,
    )


def _get_active_share_or_none(session_id: str, user, share_id: str | None = None):
    """解析指定卡片的 active share；旧客户端回退最新授权。"""
    try:
        UUID(str(session_id))
    except (ValueError, TypeError, AttributeError):
        return None
    if share_id is not None:
        share = session_share_service.get_active_share_by_id_for_user(
            share_id=share_id,
            session_id=session_id,
            user=user,
        )
    else:
        share = session_share_service.get_active_share(session_id=session_id, user=user)
    if share is None:
        return None

    from apps.tabtinspace.models import OrganizationMember

    member_ids = set(
        OrganizationMember.objects.filter(
            organization_id=share.organization_id,
            user_id__in=[share.owner_user_id, share.grantee_user_id],
        ).values_list("user_id", flat=True),
    )
    if {str(share.owner_user_id), str(share.grantee_user_id)} != {
        str(member_id) for member_id in member_ids
    }:
        return None
    return share


@router.post("/sessions/{session_id}/shared-fork", auth=jwt_auth, tags=["会话共享"])
def shared_fork(request, session_id: str, data: SharedForkRequest = Body(...)):
    """接收人 fork 共享任务：快照 → turns → 物化到自己的 Agent × Workspace。

    - 鉴权 = 该用户的 active share 且 ``can_fork``；
    - agent / workspace 归属校验统一走 ``resolve_execution_target``
      （与接力 take-over 同口径，详见 services/execution_target.py）；
    - 每次显式 fork 都物化新会话；``forked_session_id`` 只记最新一份，
      旧副本保留不覆盖。网络连点靠前端向导提交态防抖，不用单槽位冒充幂等。
    """
    share = _get_active_share_or_none(session_id, request.auth, data.share_id)
    if share is None:
        return _denied_403()
    if not share.can_fork:
        return error_response_with_status(
            "FORBIDDEN", message="该共享未开放 fork 权限", status_code=403,
        )
    source_session = share.session

    # ── Agent × Workspace 归属校验（与接力 take-over 共用公共 helper）──
    from ..services.execution_target import (
        ExecutionTargetError,
        resolve_execution_target,
    )

    try:
        agent, host = resolve_execution_target(
            user=request.auth,
            agent_id=data.agent_id,
            workspace_id=data.workspace_id,
            organization_id=source_session.organization_id,
        )
    except ExecutionTargetError as e:
        return error_response_with_status(
            e.code, message=str(e), status_code=e.status_code,
        )

    # ── 快照 → turns → 物化 ────────────────────────────────────────────
    turns, truncated = collect_share_turns(source_session)
    if not turns:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="共享会话没有可复制的内容",
            status_code=400,
        )

    source_title = source_session.title or "未命名会话"
    owner_display = share.owner_user_id
    try:
        owner = get_user_model().objects.filter(id=share.owner_user_id).first()
        if owner is not None:
            owner_display = owner.get_display_name() or owner_display
    except Exception:
        logger.debug("[session-share] resolve owner display failed", exc_info=True)

    truncated_note = "（超长会话，快照已截断）" if truncated else ""
    briefing_text = (
        "本会话由共享任务副本创建。\n"
        f"- 来源：{owner_display} 共享的会话《{source_title}》\n"
        f"- 以下 {len(turns)} 条消息为会话快照{truncated_note}："
        "保留双方文字内容、工具调用名称与附件引用；思考过程与工具执行细节均已剔除\n"
        "- 附件行保留 file_id，可用 parse_document 等能力按引用读取全文\n"
        "- 原会话的执行现场（设备 / 目录 / 文件产物）不随共享转移；"
        "如需相关文件请在本会话中让用户重新提供\n"
        "接下来可以基于以上内容继续这项任务。"
    )
    contract_payload = {
        "type": "session-share-fork",
        "share_id": str(share.id),
        "source_session_id": str(source_session.id),
        "source_session_title": source_session.title or "",
        "source_owner_user_id": share.owner_user_id,
        "organization_id": share.organization_id,
        "snapshot_turn_count": len(turns),
        "snapshot_truncated": truncated,
        "forked_at": timezone.now().isoformat(),
        "notes": (
            "快照保留正文、工具调用名称与附件引用，无思考过程与工具执行细节。"
            "不要臆测被剔除的内容，需要时向用户确认；附件可按 file_id 读取全文。"
        ),
    }
    source_meta = {
        "source_type": "session_share",
        "source_id": str(share.id),
        "source_session_id": str(source_session.id),
    }

    from ..services.session_materializer import materialize_session_from_turns

    new_session = materialize_session_from_turns(
        user=request.auth,
        organization_id=source_session.organization_id,
        agent=agent,
        workspace=host,
        title=f"{source_title}（共享副本）",
        turns=turns,
        briefing_text=briefing_text,
        contract_payload=contract_payload,
        source_meta=source_meta,
    )

    share = session_share_service.mark_share_forked(
        share,
        request.auth,
        new_session,
    )
    session_share_card_service.refresh_after_fork(share)
    logger.info(
        "[session-share] forked: share=%s source=%s new=%s user=%s",
        share.id, source_session.id, new_session.id, request.auth.id,
    )

    return success_response(data=_session_to_schema(
        new_session,
        message_count=_visible_message_count(new_session),
    ).model_dump(mode="json"))


@router.get(
    "/sessions/{session_id}/shared-execution-status",
    auth=jwt_auth,
    tags=["会话共享"],
)
def shared_execution_status(
    request,
    session_id: str,
    share_id: str | None = None,
):
    """can_chat 发送前只读预检：owner 执行机是否可达。

    - 鉴权 = active share 且 ``can_chat``（与 shared-chat 同门）；
    - 判定复用 ``PromptForwardService.probe_execution_device_reachable``
      （DB status + user 归属 + WS ready），**无** ingest / 审计 / 计费副作用；
    - 响应：``{reachable, error_category, runtime}``——``reachable=false`` 时
      ``error_category`` 多为 ``device_offline``。
    """
    share = _get_active_share_or_none(session_id, request.auth, share_id)
    if share is None:
        return _denied_403()
    if not share.can_chat:
        return error_response_with_status(
            "FORBIDDEN", message="该共享未开放对话权限", status_code=403,
        )

    session = (
        ChatSession.objects.select_related("workspace")
        .filter(id=share.session_id)
        .first()
    )
    if session is None:
        return _denied_403()

    from apps.services.agent_engine.services.prompt_forward_service import (
        PromptForwardService,
    )

    agent_id = str(session.agent_id) if session.agent_id else None
    # 共享发言执行身份 = owner（与 shared-chat / ChatService user=owner 对齐）
    probe = PromptForwardService.probe_execution_device_reachable(
        session.workspace,
        agent_id=agent_id,
        execution_owner_user_id=str(share.owner_user_id),
        allow_busy=True,
    )
    logger.info(
        "[session-share] shared-execution-status: share=%s session=%s "
        "reachable=%s runtime=%s",
        share.id, share.session_id, probe.get("reachable"), probe.get("runtime"),
    )
    return success_response(data=probe)


@router.post("/sessions/{session_id}/shared-chat", auth=jwt_auth, tags=["会话共享"])
def shared_chat(request, session_id: str, data: SharedChatRequest = Body(...)):
    """grantee 发言驱动共享会话（can_chat 档）。

    执行语义（产品定案，勿偏离；#7879 与自有会话统一流水线）：
    - 本端点只做权限门（active share + can_chat）与 ``chatted`` 审计；
    - 发送进入 **ChatService.send_message_sync**（prepare→ingest→contextualize→route），
      与用户自有会话同一路径——模型 resolve、计费预检、排队、设备路由不再另开分叉；
    - 执行身份 = **owner**（``user=owner`` 加载会话 / Agent / 设备 / 费用）；
    - 发言归属 = **grantee**（``app_context._shared_chat_by`` →
      ``resolve_sender_attribution``）；
    - 设备离线等错误：如实透传 ChatService 的 ``error_category``，不造假状态。

    响应（前端契约）：``{message_id, reply, content, model_id, model_name,
    trace_id, error_category, error_message[, error_code]}`` —— 与
    ChatService.send_message_sync 兼容字典同构。
    """
    share = _get_active_share_or_none(session_id, request.auth, data.share_id)
    if share is None:
        return _denied_403()
    if not share.can_chat:
        return error_response_with_status(
            "FORBIDDEN", message="该共享未开放对话权限", status_code=403,
        )

    text = (data.text or "").strip()
    if not text:
        return error_response_with_status(
            "VALIDATION_ERROR", message="发言内容不能为空", status_code=400,
        )

    client_message_id = None
    if data.client_message_id:
        try:
            client_message_id = str(UUID(data.client_message_id.strip()))
        except (ValueError, TypeError, AttributeError):
            return error_response_with_status(
                "VALIDATION_ERROR",
                message="client_message_id 必须是 UUID",
                status_code=400,
            )

    # 执行身份 = owner：ChatService 按 user 过滤会话；grantee 直呼已被
    # include_session_share=False 拦截，必须在此换成 owner。
    owner = get_user_model().objects.filter(id=share.owner_user_id).first()
    if owner is None:
        # owner 已注销等极端情况，按防探测口径收口。
        logger.warning(
            "[session-share] shared-chat owner missing: share=%s owner=%s",
            share.id, share.owner_user_id,
        )
        return _denied_403()

    grantee_id = str(request.auth.id)

    from apps.services.agent_execution.chat_service import ChatService

    result = ChatService.send_message_sync(
        session_id=str(share.session_id),
        user=owner,
        message=text,
        client_type="server",
        execution_profile="conversational",
        client_message_id=client_message_id,
        app_context={
            "_invoked_from": "session_share_chat",
            "_shared_chat_by": grantee_id,
            "share_id": str(share.id),
        },
    )

    # 审计在 ChatService 返回后落账：异常中断不记；device_offline 等
    # 结构化失败仍记「谁发起过驱动」（正文若未落库则只有审计行）。
    session_share_service.mark_share_chatted(
        share,
        request.auth,
        text,
        client_message_id=client_message_id,
    )

    logger.info(
        "[session-share] shared-chat via ChatService: share=%s session=%s "
        "grantee=%s error_category=%s",
        share.id, share.session_id, grantee_id, result.get("error_category"),
    )

    data_out = {
        key: result.get(key)
        for key in _SHARED_CHAT_RESULT_FIELDS
        if key != "error_code" or result.get("error_code") is not None
    }
    return success_response(data=data_out)


@router.post(
    "/sessions/{session_id}/shared-file-preview",
    auth=jwt_auth,
    tags=["会话共享"],
)
def shared_file_preview(
    request,
    session_id: str,
    data: SharedFilePreviewRequest = Body(...),
):
    """共享会话本地文件按需预览。

    - 鉴权 = session owner 或 active SessionShare grantee；
    - 仅允许会话写时索引中的结构化相对路径；
    - 文本/小图走设备 ``fs.read_file_preview``；其余格式走单文件临时物化 +
      短期 signed URL（不暴露本机绝对路径，不开放 list_dir）。
    """
    from ..services.workspace_file import WorkspaceFilePreviewService

    result = WorkspaceFilePreviewService(request.auth, request=request).preview(
        session_id=session_id,
        relative_path=data.path,
        timeout_seconds=data.timeout_seconds,
        share_id=data.share_id,
    )
    if not result.get("success"):
        return error_response_with_status(
            str(result.get("error_code") or "PREVIEW_FAILED"),
            message=result.get("error") or "文件预览失败",
            status_code=int(result.get("http_status") or 409),
        )
    # 不把内部 error/http 字段回给客户端
    payload = {
        key: value
        for key, value in result.items()
        if key not in {"success", "error", "error_code", "http_status"}
    }
    return success_response(data=payload)


@router.post("/session-shares", auth=jwt_auth, tags=["会话共享"])
def create_session_share_card(
    request,
    data: CreateSessionShareCardRequest = Body(...),
):
    """创建共享授权并通过 Django IM 发送结构化共享卡。"""
    try:
        can_chat = data.can_chat
        can_fork = data.can_fork
        if data.access_mode is not None:
            if data.access_mode not in {"view", "fork", "collaborate"}:
                raise ValueError("access_mode 必须是 view、fork 或 collaborate")
            can_chat = data.access_mode == "collaborate"
            can_fork = data.access_mode == "fork"
        result = session_share_card_service.share_and_send_card(
            actor_user=request.auth,
            session_id=data.session_id,
            grantee_user_id=data.grantee_user_id,
            can_fork=can_fork,
            can_chat=can_chat,
            authorization_header=str(
                getattr(request, "headers", {}).get("Authorization", "") or "",
            ),
            conversation_id_hint=data.conversation_id,
            client_request_id=data.client_request_id,
            restore_share_id=data.restore_share_id,
            card_contract=data.card_contract,
        )
        return success_response(data=result)
    except session_share_card_service.SessionShareDeliveryUnconfirmed as exc:
        return error_response_with_status(
            "IM_DELIVERY_UNCONFIRMED",
            message=str(exc),
            status_code=503,
            data=exc.result,
        )
    except session_share_card_service.SessionShareDeliveryRejected as exc:
        return error_response_with_status(
            "IM_DELIVERY_REJECTED",
            message=str(exc),
            status_code=502,
            data=exc.result,
        )
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )
    except Exception:
        logger.exception("[session-share] failed to create IM card")
        return error_response_with_status(
            "INTERNAL_ERROR", message="任务共享失败", status_code=500,
        )


@router.post("/session-shares/batch-get", auth=jwt_auth, tags=["会话共享"])
def batch_get_session_share_cards(
    request,
    data: BatchSessionShareDetailRequest = Body(...),
):
    try:
        return success_response(data={"items": session_share_card_service.batch_get_share_details(
            viewer_user=request.auth,
            object_ids=data.object_ids,
        )})
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )


@router.get("/session-shares", auth=jwt_auth, tags=["会话共享"])
def list_session_share_cards(
    request,
    peer_user_id: str | None = None,
    session_id: str | None = None,
    organization_id: str | None = None,
    direction: str | None = None,
):
    try:
        if direction == "incoming":
            if not organization_id or peer_user_id or session_id:
                raise ValueError("incoming 查询只接受 organization_id")
            shares = session_share_card_service.list_incoming_shares(
                viewer_user=request.auth,
                organization_id=organization_id,
            )
        elif direction is not None:
            raise ValueError("direction 仅支持 incoming")
        elif bool(peer_user_id) == bool(session_id):
            raise ValueError("peer_user_id 与 session_id 必须且只能传一个")
        elif session_id:
            shares = session_share_card_service.list_shares_for_session(
                owner_user=request.auth,
                session_id=session_id,
            )
        else:
            shares = session_share_card_service.list_shares_with_peer(
                viewer_user=request.auth,
                peer_user_id=peer_user_id or "",
                organization_id=organization_id,
            )
        return success_response(data={"shares": shares})
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )


@router.get("/session-shares/{share_id}", auth=jwt_auth, tags=["会话共享"])
def get_session_share_card(request, share_id: str):
    try:
        return success_response(data=session_share_card_service.get_share_detail(
            viewer_user=request.auth,
            share_id=share_id,
        ))
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )


@router.post(
    "/session-shares/{share_id}/accept",
    auth=jwt_auth,
    tags=["会话共享"],
)
def accept_session_share_card(request, share_id: str):
    try:
        return success_response(data=session_share_card_service.accept_and_refresh_card(
            actor_user=request.auth,
            share_id=share_id,
        ))
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )


@router.patch(
    "/session-shares/{share_id}/access",
    auth=jwt_auth,
    tags=["会话共享"],
)
def update_session_share_access(
    request,
    share_id: str,
    data: UpdateSessionShareAccessRequest = Body(...),
):
    try:
        if data.access_mode not in {"view", "fork", "collaborate"}:
            raise ValueError("access_mode 必须是 view、fork 或 collaborate")
        return success_response(data=session_share_card_service.update_access_and_refresh_card(
            actor_user=request.auth,
            share_id=share_id,
            can_chat=data.access_mode == "collaborate",
            can_fork=data.access_mode == "fork",
        ))
    except session_share_card_service.SessionShareRefreshUnconfirmed as exc:
        return error_response_with_status(
            "IM_REFRESH_UNCONFIRMED",
            message=str(exc),
            status_code=503,
            data=exc.result,
        )
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )


@router.post(
    "/session-shares/{share_id}/restore",
    auth=jwt_auth,
    tags=["会话共享"],
)
def restore_session_share_card(request, share_id: str):
    try:
        return success_response(data=session_share_card_service.restore_and_refresh_card(
            actor_user=request.auth,
            share_id=share_id,
        ))
    except session_share_card_service.SessionShareRefreshUnconfirmed as exc:
        return error_response_with_status(
            "IM_REFRESH_UNCONFIRMED",
            message=str(exc),
            status_code=503,
            data=exc.result,
        )
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )


@router.post(
    "/session-shares/{share_id}/delivery/retry",
    auth=jwt_auth,
    tags=["会话共享"],
)
def retry_session_share_delivery(request, share_id: str):
    try:
        return success_response(data=session_share_card_service.retry_share_delivery(
            actor_user=request.auth,
            share_id=share_id,
            authorization_header=str(
                getattr(request, "headers", {}).get("Authorization", "") or "",
            ),
        ))
    except session_share_card_service.SessionShareDeliveryUnconfirmed as exc:
        return error_response_with_status(
            "IM_DELIVERY_UNCONFIRMED",
            message=str(exc),
            status_code=503,
            data=exc.result,
        )
    except session_share_card_service.SessionShareDeliveryRejected as exc:
        return error_response_with_status(
            "IM_DELIVERY_REJECTED",
            message=str(exc),
            status_code=502,
            data=exc.result,
        )
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR", message=str(exc), status_code=400,
        )


@router.post(
    "/session-shares/{share_id}/revoke",
    auth=jwt_auth,
    tags=["会话共享"],
)
def revoke_session_share_card(
    request,
    share_id: str,
    data: RevokeSessionShareCardRequest | None = Body(None),
):
    try:
        return success_response(data=session_share_card_service.revoke_and_refresh_card(
            actor_user=request.auth,
            share_id=share_id,
        ))
    except session_share_card_service.SessionShareResourceRevokeError as exc:
        return error_response_with_status(
            "RESOURCE_REVOKE_FAILED", message=str(exc), status_code=500,
        )
    except session_share_card_service.SessionShareRefreshUnconfirmed as exc:
        if data and data.accept_committed_revoke:
            return success_response(data={
                **exc.result,
                "card_refresh_status": "unconfirmed",
            })
        return error_response_with_status(
            "IM_REFRESH_UNCONFIRMED",
            message=str(exc),
            status_code=503,
            data=exc.result,
        )
    except PermissionError as exc:
        return error_response_with_status(
            "FORBIDDEN", message=str(exc), status_code=403,
        )
    except Exception:
        logger.exception("[session-share] failed to refresh revoked IM card")
        return error_response_with_status(
            "INTERNAL_ERROR", message="停止共享失败", status_code=500,
        )

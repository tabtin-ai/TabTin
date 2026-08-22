"""会话共享授权服务（ 共享 Agent 任务）。

领域规则（对齐产品决策，勿偏离）：
- 一条 ChatSession 只有一个 owner；共享 = grantee 进入 owner 的**同一个会话**
  （文档协同式，组织内全量透明），不共享执行现场。
- grantee 必须是 session 所属 Organization 的成员，且不能是 owner 自己。
- 权限位：查看 = 授权即有（主鉴权第三分支放行读 + 流）；can_fork 叠加位；
  can_chat 叠加位 = 发言驱动（shared-chat 端点，执行身份 owner、逐条审计）。
- 防探测口径对齐 tabchat handoff：「不存在」与「无权」统一报
  「不存在或无权查看」，不区分泄露存在性。
- 所有状态变化写 SessionShareEvent（append-only 审计）。
- **本服务不 import tabchat**——IM 卡片由本领域生成完整投影，具体消息写入由
  session_share_card_service 负责；card_* 字段保存稳定卡片锚点。
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.db import models, transaction
from django.utils import timezone

from ..models import ChatSession, SessionShare, SessionShareEvent

logger = logging.getLogger(__name__)


class SessionShareAccessError(PermissionError):
    """目标共享/会话不存在或操作者无权访问（防探测统一口径）。"""


_ACCESS_DENIED_MESSAGE = "共享不存在或无权查看"


def _as_uuid_or_none(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


_SHARE_CREATE_STATUSES = frozenset({"pending", "active"})


def create_or_update_share(
    *,
    session_id,
    owner_user,
    grantee_user_id: str,
    can_fork: bool = False,
    can_chat: bool = False,
    card_contract: str = "session_share",
    status: str | None = None,
) -> SessionShare:
    """owner 把会话以一份新的独立授权分享给同 org 用户。

    - session 必须存在且 ``owner_user`` 是 ``session.user``，否则按防探测口径报
      :class:`SessionShareAccessError`。
    - grantee 必须是 session.organization_id 的 OrganizationMember 且 ≠ owner。
    - 每次调用都新建一行，使每张 IM 共享卡的权限互不覆盖。
    - 默认 ``status=active``，保持既有调用方语义。IM 发卡编排显式传
      ``status="pending"``，并在 IM 确认后调用 :func:`activate_share`。
    - 恢复已停止的卡片必须走 :func:`restore_share` 并指定 share_id。
    - 审计：新建写 created 事件。
    """
    status = status or (
        "pending" if card_contract == "session_share_v2" else "active"
    )
    if status not in _SHARE_CREATE_STATUSES:
        raise ValueError("status 仅支持 pending 或 active")

    session_uuid = _as_uuid_or_none(session_id)
    session = (
        ChatSession.objects.filter(id=session_uuid).first() if session_uuid else None
    )
    if session is None or str(session.user_id) != str(owner_user.id):
        raise SessionShareAccessError(_ACCESS_DENIED_MESSAGE)

    grantee_user_id = str(grantee_user_id or "").strip()
    if not grantee_user_id:
        raise ValueError("接收人不能为空")
    if grantee_user_id == str(owner_user.id):
        raise ValueError("不能把会话共享给自己")
    if not session.organization_id:
        raise ValueError("会话缺少组织归属，无法共享")

    from apps.tabtinspace.models import OrganizationMember

    is_org_member = OrganizationMember.objects.filter(
        organization_id=session.organization_id,
        user_id=grantee_user_id,
    ).exists()
    if not is_org_member:
        raise ValueError("接收人不是该组织成员")

    if card_contract not in {"session_share", "session_share_v2"}:
        raise ValueError("不支持的共享卡片契约")
    actor_id = str(owner_user.id)
    with transaction.atomic():
        share = SessionShare.objects.create(
            session=session,
            grantee_user_id=grantee_user_id,
            organization_id=str(session.organization_id),
            owner_user_id=actor_id,
            can_fork=bool(can_fork),
            can_chat=bool(can_chat),
            status=status,
            card_contract=card_contract,
            delivery_status=(
                "pending" if card_contract == "session_share_v2" else "confirmed"
            ),
        )
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=actor_id,
            event_type="created",
            payload_json={
                "can_fork": share.can_fork,
                "can_chat": share.can_chat,
                "status": share.status,
            },
        )
    return share


def activate_share(*, share: SessionShare, actor_user) -> SessionShare:
    """将 pending 授权提升为 active（幂等）。已撤销的行必须走 :func:`restore_share`。"""
    with transaction.atomic():
        share = SessionShare.objects.select_for_update().select_related("session").get(
            id=share.id,
        )
        if share.status == "active":
            return share
        if share.status == "revoked":
            raise ValueError("已撤销的共享不能直接激活，请走 restore_share")
        if share.status != "pending":
            raise ValueError(f"不支持从 {share.status} 激活共享")
        share.status = "active"
        share.revoked_at = None
        update_fields = ["status", "revoked_at"]
        if share.card_contract == "session_share_v2":
            share.version += 1
            update_fields.extend(["version", "updated_at"])
        share.save(update_fields=update_fields)
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(actor_user.id),
            event_type="updated",
            payload_json={
                "can_fork": share.can_fork,
                "can_chat": share.can_chat,
                "activated": True,
            },
        )
    return share


def restore_share(*, share_id, owner_user, status: str = "active") -> SessionShare:
    """恢复一张指定共享卡的原授权，不改变其权限位。"""
    if status not in _SHARE_CREATE_STATUSES:
        raise ValueError("status 仅支持 pending 或 active")
    share_uuid = _as_uuid_or_none(share_id)
    with transaction.atomic():
        share = (
            SessionShare.objects.select_for_update().select_related("session")
            .filter(id=share_uuid).first()
            if share_uuid else None
        )
        if share is None or share.owner_user_id != str(owner_user.id):
            raise SessionShareAccessError(_ACCESS_DENIED_MESSAGE)
        if share.status == "active" or share.status == status:
            return share
        share.status = status
        share.revoked_at = None
        update_fields = ["status", "revoked_at"]
        if share.card_contract == "session_share_v2":
            share.version += 1
            share.access_epoch += 1
            update_fields.extend(["version", "access_epoch", "updated_at"])
        share.save(update_fields=update_fields)
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(owner_user.id),
            event_type="updated",
            payload_json={
                "can_fork": share.can_fork,
                "can_chat": share.can_chat,
                "reactivated": status == "active",
                "pending_delivery": status == "pending",
            },
        )
    return share


def revoke_share(*, share_id, actor_user) -> SessionShare:
    """owner 撤销共享（幂等；pending / active 均可停）。

    非 owner（含 grantee / 陌生人）与不存在的 share 统一报防探测口径。
    """
    share_uuid = _as_uuid_or_none(share_id)
    with transaction.atomic():
        share = (
            SessionShare.objects.select_for_update().select_related("session")
            .filter(id=share_uuid).first()
            if share_uuid
            else None
        )
        if share is None or share.owner_user_id != str(actor_user.id):
            raise SessionShareAccessError(_ACCESS_DENIED_MESSAGE)
        if share.status == "revoked":
            return share
        share.status = "revoked"
        share.revoked_at = timezone.now()
        update_fields = ["status", "revoked_at"]
        if share.card_contract == "session_share_v2":
            share.version += 1
            share.access_epoch += 1
            update_fields.extend(["version", "access_epoch", "updated_at"])
        share.save(update_fields=update_fields)
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(actor_user.id),
            event_type="revoked",
        )
    return share


def get_share_for_user(*, share_id, user) -> SessionShare:
    """按 id 取共享；仅 owner 或 grantee 可见，否则按防探测口径报错。"""
    share_uuid = _as_uuid_or_none(share_id)
    share = (
        SessionShare.objects.select_related("session").filter(id=share_uuid).first()
        if share_uuid
        else None
    )
    user_id = str(user.id) if user is not None else ""
    if share is None or user_id not in (share.owner_user_id, share.grantee_user_id):
        raise SessionShareAccessError(_ACCESS_DENIED_MESSAGE)
    return share


def get_active_share(*, session_id, user) -> SessionShare | None:
    """返回该用户最新一条已确认授权；最新授权非 active 时返回 None。"""
    if user is None:
        return None
    session_uuid = _as_uuid_or_none(session_id)
    if session_uuid is None:
        return None
    latest = (
        SessionShare.objects.select_related("session")
        .filter(
            session_id=session_uuid,
            grantee_user_id=str(user.id),
        )
        .exclude(status="pending")
        .order_by("-created_at", "-id")
        .first()
    )
    if (
        latest is None
        or latest.status != "active"
        or latest.eligibility_status != "eligible"
    ):
        return None
    from apps.tabtinspace.models import OrganizationMember

    return latest if OrganizationMember.objects.filter(
        organization_id=latest.organization_id,
        user_id=user.id,
    ).exists() else None


def get_active_share_by_id_for_user(*, share_id, session_id, user) -> SessionShare | None:
    """仅当指定授权是该用户最新的已确认 active 授权时返回。"""
    if user is None:
        return None
    share_uuid = _as_uuid_or_none(share_id)
    session_uuid = _as_uuid_or_none(session_id)
    if share_uuid is None or session_uuid is None:
        return None
    user_id = str(user.id)
    requested = (
        SessionShare.objects.select_related("session")
        .filter(
            id=share_uuid,
            session_id=session_uuid,
            status="active",
            eligibility_status="eligible",
        )
        .filter(
            models.Q(owner_user_id=user_id) | models.Q(grantee_user_id=user_id)
        )
        .first()
    )
    if requested is None:
        return None
    latest = (
        SessionShare.objects.filter(
            session_id=session_uuid,
            grantee_user_id=requested.grantee_user_id,
        )
        .exclude(status="pending")
        .order_by("-created_at", "-id")
        .first()
    )
    if latest is None or latest.id != requested.id:
        return None
    if requested.owner_user_id == user_id:
        return requested
    from apps.tabtinspace.models import OrganizationMember

    return requested if OrganizationMember.objects.filter(
        organization_id=requested.organization_id,
        user_id=user.id,
    ).exists() else None


def list_shares_between(*, user_id, peer_user_id, organization_id=None):
    """列出两个用户之间每个原任务的最新共享状态。

    历史卡片仍保留独立授权审计，但「共享对话」只投影同一 ChatSession 的
    最新可见授权。任务交接使用 SessionContinuation，不经过此查询。
    """
    user_id = str(user_id)
    peer_user_id = str(peer_user_id or "").strip()
    if not peer_user_id:
        return SessionShare.objects.none()
    between = (
        models.Q(owner_user_id=user_id, grantee_user_id=peer_user_id)
        | models.Q(owner_user_id=peer_user_id, grantee_user_id=user_id)
    )
    latest = (
        SessionShare.objects.filter(between, session_id=models.OuterRef("session_id"))
        .exclude(status="pending", grantee_user_id=user_id)
    )
    if organization_id:
        latest = latest.filter(organization_id=str(organization_id))
    latest_id = latest.order_by("-created_at", "-id").values("id")[:1]
    return (
        SessionShare.objects.select_related("session", "session__workspace")
        .filter(between, id=models.Subquery(latest_id))
        .order_by("-created_at", "-id")
    )


def list_latest_incoming_shares(*, user_id, organization_id):
    """列出组织内每个会话最新且仍有效的一条接收授权。"""
    latest_share_id = (
        SessionShare.objects.filter(
            organization_id=str(organization_id),
            grantee_user_id=str(user_id),
            session_id=models.OuterRef("session_id"),
        )
        .exclude(status="pending")
        .order_by("-created_at", "-id")
        .values("id")[:1]
    )
    return (
        SessionShare.objects.select_related("session", "session__workspace")
        .filter(
            id=models.Subquery(latest_share_id),
            organization_id=str(organization_id),
            grantee_user_id=str(user_id),
            status="active",
        )
        .order_by("-created_at", "-id")
    )


def list_shares_for_session(*, session_id, owner_user):
    """owner 列出某会话的全部共享行（头部协作区 / 管理面数据源，含 revoked）。

    非 owner（含 grantee）一律按防探测口径报错——头部协作区只出现在
    自己的会话里，grantee 侧的可见面走 list_shares_between。
    """
    session_uuid = _as_uuid_or_none(session_id)
    session = (
        ChatSession.objects.filter(id=session_uuid).first() if session_uuid else None
    )
    if session is None or str(session.user_id) != str(owner_user.id):
        raise SessionShareAccessError(_ACCESS_DENIED_MESSAGE)
    return (
        SessionShare.objects.select_related("session", "session__workspace")
        .filter(session=session)
        .order_by("-created_at")
    )


def mark_share_viewed(share: SessionShare, actor_user) -> None:
    """grantee 首次查看写 viewed 事件（每 share 只记一次，幂等）。"""
    actor_id = str(actor_user.id)
    if actor_id != share.grantee_user_id:
        return
    if share.events.filter(event_type="viewed", actor_user_id=actor_id).exists():
        return
    SessionShareEvent.objects.create(
        share=share,
        actor_user_id=actor_id,
        event_type="viewed",
    )


def mark_share_chatted(
    share: SessionShare,
    actor_user,
    text: str,
    *,
    client_message_id: str | None = None,
) -> None:
    """grantee 发言驱动审计（ can_chat）：每次发言记一条 chatted 事件。

    payload 只留规模与摘要（长度 + 前 80 字），不整段复制正文——正文本身
    已作为 user 消息落在会话里（sender = grantee），审计行回答「谁何时驱动
    过」即可。
    """
    text = text or ""
    event = {
        "actor_user_id": str(actor_user.id),
        "event_type": "chatted",
        "payload_json": {"text_len": len(text), "preview": text[:80]},
    }
    if client_message_id:
        SessionShareEvent.objects.get_or_create(
            share=share,
            client_message_id=client_message_id,
            defaults=event,
        )
        return
    SessionShareEvent.objects.create(share=share, **event)


def mark_share_forked(
    share: SessionShare,
    actor_user,
    forked_session,
) -> SessionShare:
    """回填最新 fork 结果 + 写 forked 审计事件。

    ``forked_session_id`` 只作 latest 指针；每次显式 fork 都新建会话，
    历史副本靠事件流水追溯，不在此覆盖删除。
    """
    with transaction.atomic():
        share = SessionShare.objects.select_for_update().get(id=share.id)
        share.forked_session_id = forked_session.id
        update_fields = ["forked_session_id"]
        if share.card_contract == "session_share_v2":
            # v2 详情以 object_id + version 为双端缓存键。fork 指针变化也属于
            # 对外详情变化，必须递增版本，后续编辑原卡才能驱动客户端补拉。
            share.version += 1
            update_fields.extend(["version", "updated_at"])
        share.save(update_fields=update_fields)
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(actor_user.id),
            event_type="forked",
            payload_json={"forked_session_id": str(forked_session.id)},
        )
    return share


def attach_card_anchor(
    share: SessionShare,
    conversation_id: str,
    message_ref: str,
    message_sequence: int | None = None,
) -> None:
    """回填 Django IM 卡片的稳定会话与消息锚点。"""
    share.card_conversation_id = str(conversation_id)
    share.card_message_ref = message_ref
    share.card_message_id = message_sequence
    share.save(update_fields=[
        "card_conversation_id",
        "card_message_ref",
        "card_message_id",
    ])


def confirm_share_delivery(
    *,
    share: SessionShare,
    conversation_id: str,
    message_ref: str,
    message_sequence: int | None,
) -> SessionShare:
    """确认 v2 卡已投递；接收方加入前保持 pending，不开放授权。"""
    with transaction.atomic():
        locked = SessionShare.objects.select_for_update().get(id=share.id)
        locked.card_conversation_id = str(conversation_id)
        locked.card_message_ref = message_ref
        locked.card_message_id = message_sequence
        update_fields = [
            "card_conversation_id",
            "card_message_ref",
            "card_message_id",
        ]
        if locked.card_contract == "session_share_v2":
            locked.delivery_status = "confirmed"
            locked.version += 1
            update_fields.extend(["delivery_status", "version", "updated_at"])
        locked.save(update_fields=update_fields)
    return locked


def update_share_access(
    *, share_id, owner_user, can_chat: bool, can_fork: bool,
) -> SessionShare:
    """更新 v2 卡访问权限档，不另发新卡。"""
    share_uuid = _as_uuid_or_none(share_id)
    with transaction.atomic():
        share = (
            SessionShare.objects.select_for_update().filter(id=share_uuid).first()
            if share_uuid
            else None
        )
        if share is None or share.owner_user_id != str(owner_user.id):
            raise SessionShareAccessError(_ACCESS_DENIED_MESSAGE)
        if share.card_contract != "session_share_v2":
            raise ValueError("历史共享卡不支持原地修改权限")
        if share.status != "active":
            raise ValueError("仅生效中的共享可修改权限")
        if share.can_chat == bool(can_chat) and share.can_fork == bool(can_fork):
            return share
        share.can_chat = bool(can_chat)
        share.can_fork = bool(can_fork)
        share.version += 1
        share.save(update_fields=["can_chat", "can_fork", "version", "updated_at"])
        SessionShareEvent.objects.create(
            share=share,
            actor_user_id=str(owner_user.id),
            event_type="updated",
            payload_json={"can_chat": share.can_chat, "can_fork": share.can_fork},
        )
    return share


def set_share_delivery_status(share: SessionShare, status: str) -> SessionShare:
    if status not in {"pending", "confirmed", "unconfirmed", "rejected"}:
        raise ValueError("不支持的投递状态")
    with transaction.atomic():
        locked = SessionShare.objects.select_for_update().get(id=share.id)
        if locked.card_contract != "session_share_v2" or locked.delivery_status == status:
            return locked
        locked.delivery_status = status
        locked.version += 1
        locked.save(update_fields=["delivery_status", "version", "updated_at"])
    return locked


def serialize_share(share: SessionShare) -> dict:
    """共享行的对外序列化（IM 卡片 / 管理面共用）。"""
    workspace = share.session.workspace
    return {
        "id": str(share.id),
        "session_id": str(share.session_id),
        "session_title": share.session.title or "",
        "workspace_id": str(workspace.id) if workspace else None,
        "workspace_name": workspace.name if workspace else "",
        "owner_user_id": share.owner_user_id,
        "grantee_user_id": share.grantee_user_id,
        "can_fork": share.can_fork,
        "can_chat": share.can_chat,
        "status": share.status,
        "card_refresh_status": getattr(share, "card_refresh_status", "confirmed"),
        "card_contract": getattr(share, "card_contract", "session_share"),
        "card_schema_version": getattr(share, "card_schema_version", 1),
        "version": getattr(share, "version", 1),
        "access_epoch": getattr(share, "access_epoch", 1),
        "delivery_status": getattr(share, "delivery_status", "confirmed"),
        "eligibility_status": getattr(share, "eligibility_status", "eligible"),
        "ineligibility_reason": getattr(share, "ineligibility_reason", ""),
        "forked_session_id": (
            str(share.forked_session_id) if share.forked_session_id else None
        ),
        "created_at": share.created_at.isoformat() if share.created_at else None,
        "revoked_at": share.revoked_at.isoformat() if share.revoked_at else None,
    }

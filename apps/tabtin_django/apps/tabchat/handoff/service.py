"""IM 上下文交接包服务：状态机 + 审计事件 + 实时通知。

核心口径：
- 交接包是独立领域对象，卡片消息只是展示面（metadata.card 只带 handoff_id + 快照）。
- 材料是受控引用：创建时校验发起人权限并回填快照；查看时按查看者权限实时
  校验，无权返回结构化 access_denied（不静默消失）。
- 包状态机：draft → sent → revoked；接收者逐人状态机：
  sent → viewed → acknowledged / taking_over / rejected（acknowledged 可升级为
  taking_over）。
- 所有状态变化写 HandoffEvent（append-only）并广播 im.handoff.update。
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabchat.constants import IMEventType
from apps.tabchat.handoff.models import (
    HandoffEvent,
    HandoffPackage,
    HandoffRecipient,
    HandoffReference,
)
from apps.tabchat.models import Conversation, Message
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.im_outbox_service import IMOutboxService

logger = logging.getLogger(__name__)

GOAL_MAX_LEN = 500
LIST_ITEM_MAX_LEN = 500
MAX_LIST_ITEMS = 50
MAX_RECIPIENTS = 20
MAX_REFERENCES = 20
NOTE_MAX_LEN = 500

# 接收者动作 → 接收者状态 / 审计事件类型
_RECIPIENT_ACTIONS: dict[str, tuple[str, str]] = {
    "acknowledge": (HandoffRecipient.State.ACKNOWLEDGED, HandoffEvent.EventType.ACKNOWLEDGED),
    "take_over": (HandoffRecipient.State.TAKING_OVER, HandoffEvent.EventType.TAKEN_OVER),
    "reject": (HandoffRecipient.State.REJECTED, HandoffEvent.EventType.REJECTED),
}

# 接收者状态机允许的迁移（不含幂等自迁移）
_RECIPIENT_TRANSITIONS: dict[str, set[str]] = {
    HandoffRecipient.State.SENT: {
        HandoffRecipient.State.VIEWED,
        HandoffRecipient.State.ACKNOWLEDGED,
        HandoffRecipient.State.TAKING_OVER,
        HandoffRecipient.State.REJECTED,
    },
    HandoffRecipient.State.VIEWED: {
        HandoffRecipient.State.ACKNOWLEDGED,
        HandoffRecipient.State.TAKING_OVER,
        HandoffRecipient.State.REJECTED,
    },
    # 「已了解」之后仍可以改主意接手
    HandoffRecipient.State.ACKNOWLEDGED: {HandoffRecipient.State.TAKING_OVER},
    HandoffRecipient.State.TAKING_OVER: set(),
    HandoffRecipient.State.DELEGATED_TO_AGENT: set(),
    HandoffRecipient.State.REJECTED: set(),
}


def _clean_text_items(items: Any, *, field: str, extra_keys: tuple[str, ...] = ()) -> list[dict]:
    """规范化四区块的条目数组：[{text, ...}]，去空、限长。"""
    if items is None:
        return []
    if not isinstance(items, list):
        raise ValueError(f"{field} 必须是数组")
    if len(items) > MAX_LIST_ITEMS:
        raise ValueError(f"{field} 条目过多（上限 {MAX_LIST_ITEMS}）")
    cleaned: list[dict] = []
    for item in items:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            raise ValueError(f"{field} 条目格式不正确")
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        entry: dict[str, Any] = {"text": text[:LIST_ITEM_MAX_LEN]}
        for key in extra_keys:
            entry[key] = bool(item.get(key))
        cleaned.append(entry)
    return cleaned


class HandoffService:
    """交接包全生命周期。所有写路径以 user 或 agent 身份二选一。"""

    # ── 创建 ──

    @staticmethod
    def create_package(
        *,
        conversation_id: str,
        actor_user_id: str | None = None,
        actor_agent_id: str | None = None,
        goal: str,
        progress: list | None = None,
        next_steps: list | None = None,
        risks: list | None = None,
        scope: str = HandoffPackage.Scope.CONTINUABLE,
        recipients: list[str] | None = None,
        references: list[dict] | None = None,
        authorization_header: str = "",
    ) -> HandoffPackage:
        """创建草稿交接包（含接收者与材料引用），不发送。"""
        if bool(actor_user_id) == bool(actor_agent_id):
            raise ValueError("发起人必须是 user 或 agent 二选一")

        goal = (goal or "").strip()
        if not goal:
            raise ValueError("工作目标不能为空")
        if len(goal) > GOAL_MAX_LEN:
            raise ValueError(f"工作目标过长（上限 {GOAL_MAX_LEN} 字符）")
        if scope not in HandoffPackage.Scope.values:
            raise ValueError("scope 不合法")

        conv = Conversation.objects.filter(pk=conversation_id).first()
        if actor_user_id:
            if (
                conv is None
                or not ConversationAccessResolver.resolve(conv, actor_user_id).can_send
            ):
                raise PermissionError("不是该会话的成员")
        else:
            if conv is None:
                raise ValueError("会话不存在")
            if not ConversationAccessResolver.can_agent_send(conv, actor_agent_id):
                raise PermissionError("Agent 不在该会话中")

        recipient_ids = HandoffService._validate_recipients(
            conv, recipients or [], actor_user_id,
        )
        progress_items = _clean_text_items(progress, field="progress")
        next_step_items = _clean_text_items(
            next_steps,
            field="next_steps",
            extra_keys=("checked",),
        )
        risk_items = _clean_text_items(
            risks,
            field="risks",
            extra_keys=("high_risk",),
        )
        ref_specs = HandoffService._validate_references(
            conv, references or [], actor_user_id,
        )

        with transaction.atomic(using=postgres_app_db_alias()):
            package = HandoffPackage.objects.create(
                conversation=conv,
                conversation_ref=str(conversation_id),
                organization_id=str(conv.organization_id),
                initiator_user_id=actor_user_id,
                initiator_agent_id=actor_agent_id,
                goal=goal,
                progress_json=progress_items,
                next_steps_json=next_step_items,
                risks_json=risk_items,
                scope=scope,
                status=HandoffPackage.Status.DRAFT,
            )
            for user_id in recipient_ids:
                HandoffRecipient.objects.create(package=package, user_id=user_id)
            for spec in ref_specs:
                HandoffReference.objects.create(package=package, version=1, **spec)
            HandoffEvent.objects.create(
                package=package,
                actor_user_id=actor_user_id,
                actor_agent_id=actor_agent_id,
                event_type=HandoffEvent.EventType.CREATED,
            )
        return package

    @staticmethod
    def _validate_recipients(
        conv: Conversation | None,
        recipients: list[str],
        actor_user_id: str | None,
        detail: dict | None = None,
    ) -> list[str]:
        """接收者必须是会话内真人成员，且不含发起人自己。"""
        ids = sorted({str(r) for r in recipients if r})
        if not ids:
            raise ValueError("至少选择一个接收者")
        if len(ids) > MAX_RECIPIENTS:
            raise ValueError(f"接收者过多（上限 {MAX_RECIPIENTS}）")
        if actor_user_id and str(actor_user_id) in ids:
            raise ValueError("不能把交接发给自己")
        member_ids = (
            {
                str(member.get("user_id"))
                for member in detail.get("members", [])
                if isinstance(member, dict)
                and member.get("member_type") == "user"
                and member.get("user_id")
            }
            if detail is not None
            else set(ConversationAccessResolver.human_user_ids(conv))
        )
        outside = [r for r in ids if r not in member_ids]
        if outside:
            raise ValueError("接收者必须是会话成员")
        return ids

    @staticmethod
    def _validate_references(
        conv: Conversation | None, references: list[dict], actor_user_id: str | None,
    ) -> list[dict]:
        """校验材料引用存在性与发起人权限，回填快照与回链。"""
        if len(references) > MAX_REFERENCES:
            raise ValueError(f"材料引用过多（上限 {MAX_REFERENCES}）")

        User = get_user_model()
        actor = User.objects.filter(id=actor_user_id).first() if actor_user_id else None

        specs: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for ref in references:
            if not isinstance(ref, dict):
                raise ValueError("材料引用格式不正确")
            ref_type = str(ref.get("ref_type") or "")
            resource_id = str(ref.get("resource_id") or "")
            if ref_type not in HandoffReference.RefType.values:
                raise ValueError(f"不支持的材料类型: {ref_type}")
            if not resource_id:
                raise ValueError("材料引用缺少 resource_id")
            key = (ref_type, resource_id)
            if key in seen:
                continue
            seen.add(key)

            if ref_type == HandoffReference.RefType.IM_MESSAGE:
                if conv is not None:
                    msg = Message.objects.filter(
                        pk=resource_id,
                        conversation=conv,
                        is_deleted=False,
                    ).first()
                    if msg is None:
                        raise ValueError("引用的消息不存在或已撤回")
                    specs.append({
                        "ref_type": ref_type,
                        "resource_id": str(msg.id),
                        "title_snapshot": "",
                        "summary_snapshot": (msg.content or "")[:500],
                        "source_link": {
                            "conversation_id": str(conv.id),
                            "message_id": msg.id,
                            "seq": msg.seq,
                        },
                    })
                else:
                    try:
                        UUID(resource_id)
                    except (ValueError, TypeError):
                        raise ValueError("消息引用不是合法 UUID")
                    source_link = ref.get("source_link") or {}
                    if not isinstance(source_link, dict):
                        raise ValueError("消息回链格式不正确")
                    specs.append({
                        "ref_type": ref_type,
                        "resource_id": resource_id,
                        "title_snapshot": str(ref.get("title_snapshot") or "")[:300],
                        "summary_snapshot": str(ref.get("summary_snapshot") or "")[:500],
                        "source_link": source_link,
                    })
            elif ref_type in (HandoffReference.RefType.DOCUMENT, HandoffReference.RefType.TABLE):
                from apps.tabchat.services.message_service import _load_card_resource

                try:
                    UUID(resource_id)
                except (ValueError, TypeError):
                    raise ValueError("resource_id 不是合法 UUID")
                if actor is None:
                    raise ValueError("Agent 发起暂不支持引用文档/表格材料")
                # 发起人自己都无权查看的资源不能塞进交接包
                _resource, space_id, organization_id, name = _load_card_resource(
                    ref_type, resource_id, actor,
                )
                specs.append({
                    "ref_type": ref_type,
                    "resource_id": resource_id,
                    "title_snapshot": name[:300],
                    "summary_snapshot": "",
                    "source_link": {
                        "space_id": space_id,
                        "organization_id": organization_id,
                    },
                })
            elif ref_type == HandoffReference.RefType.CHAT_SESSION:
                # 快照型材料：源是发起人个人 Agent 会话，接收人无法回源读取。
                # 创建时以发起人权限读取并冻结清洗版快照（见方案「快照冻结」决策）。
                if actor is None:
                    raise ValueError("Agent 发起暂不支持转发会话材料")
                from apps.chat.conversation.services.transcript_snapshot import (
                    SnapshotAccessError,
                    build_readable_transcript,
                )

                try:
                    snapshot = build_readable_transcript(resource_id, actor)
                except SnapshotAccessError:
                    raise ValueError("无权转发该会话或会话不存在")
                specs.append({
                    "ref_type": ref_type,
                    "resource_id": resource_id,
                    "title_snapshot": snapshot["title"][:300],
                    "summary_snapshot": f"Agent 会话 · {snapshot['message_count']} 条",
                    "source_link": {"session_id": resource_id},
                    "frozen_snapshot_json": snapshot,
                })
            else:
                raise ValueError(f"暂不支持的材料类型: {ref_type}")
        return specs

    # ── 发送 ──

    @staticmethod
    def send_package(
        *,
        package_id: str,
        actor_user_id: str | None = None,
        actor_agent_id: str | None = None,
    ) -> HandoffPackage:
        """发送草稿：落卡片消息 + 接收者置 sent + 审计 + 实时事件。"""
        package = HandoffService._get_owned_package(
            package_id, actor_user_id, actor_agent_id,
        )
        if package.status == HandoffPackage.Status.SENT:
            return package  # 幂等
        if package.status != HandoffPackage.Status.DRAFT:
            raise ValueError("只有草稿状态的交接包可以发送")
        if not package.recipients.exists():
            raise ValueError("至少选择一个接收者")

        from apps.tabchat.constants import MessageType, SenderType
        from apps.tabchat.services.message_service import (
            MessageService,
            _soft_delete_message,
            grant_resource_viewer_access_to_users,
            rollback_resource_permission_changes,
        )
        from apps.chat.conversation.services.im_business_projection_service import (
            send_user_business_projection,
        )

        if not actor_user_id and package.conversation is None:
            raise ValueError("Agent 发起交接暂不支持 IM 消息投递")

        message_ref = str(package.card_message_ref or package.id)
        legacy_message = None
        permission_changes: list[dict] = []
        try:
            recipient_user_ids = [
                str(recipient.user_id)
                for recipient in package.recipients.all()
                if recipient.user_id
            ]
            for ref in package.references.all():
                if ref.ref_type not in (
                    HandoffReference.RefType.DOCUMENT,
                    HandoffReference.RefType.TABLE,
                ):
                    continue
                permission_changes.extend(
                    grant_resource_viewer_access_to_users(
                        resource_type=ref.ref_type,
                        resource_id=str(ref.resource_id),
                        recipient_ids=recipient_user_ids,
                        granted_by=str(actor_user_id or actor_agent_id or ""),
                    )
                )

            if package.conversation is not None:
                legacy_message = MessageService.send_message(
                    conversation_id=str(package.conversation_id),
                    sender_id=actor_user_id or actor_agent_id,
                    content=f"[交接] {package.goal}",
                    message_type=MessageType.TEXT,
                    metadata={"card": HandoffService._build_card_snapshot(package)},
                    sender_type=SenderType.AGENT if actor_agent_id else SenderType.USER,
                    client_request_id=f"handoff-send-{package.id}",
                )
                receipt = {"id": legacy_message.id}
            else:
                receipt = send_user_business_projection(
                    organization_id=str(package.organization_id),
                    conversation_id=HandoffService._conversation_ref(package),
                    message_ref=message_ref,
                    client_request_id=message_ref,
                    user_id=str(actor_user_id),
                    content=f"[交接] {package.goal}",
                    message_type=MessageType.TEXT,
                    metadata={"card": HandoffService._build_card_snapshot(package)},
                )

            with transaction.atomic(using=postgres_app_db_alias()):
                package.status = HandoffPackage.Status.SENT
                package.card_message = legacy_message
                package.card_message_ref = None if legacy_message else message_ref
                package.card_message_sequence = (
                    None
                    if legacy_message
                    else int(receipt.get("seq") or receipt.get("id") or 0) or None
                )
                package.save(update_fields=[
                    "status", "card_message", "card_message_ref",
                    "card_message_sequence", "updated_at",
                ])
                HandoffEvent.objects.create(
                    package=package,
                    actor_user_id=actor_user_id,
                    actor_agent_id=actor_agent_id,
                    event_type=HandoffEvent.EventType.SENT,
                )
                HandoffService._broadcast_update(package)
        except Exception:
            rollback_resource_permission_changes(permission_changes)
            if legacy_message is not None:
                _soft_delete_message(
                    legacy_message,
                    actor_id=str(actor_user_id or actor_agent_id or legacy_message.sender_id),
                    clear_client_request_id=True,
                )
            raise
        return package

    @staticmethod
    def _build_card_snapshot(package: HandoffPackage) -> dict:
        """卡片 metadata 快照：仅用于列表预览，详情以 API 实时数据为准。"""
        return {
            "type": "handoff",
            "handoff_id": str(package.id),
            "goal": package.goal,
            "scope": package.scope,
            "initiator_type": package.initiator_type,
            "initiator_id": package.initiator_user_id or package.initiator_agent_id,
            "recipient_count": package.recipients.count(),
        }

    # ── 查看 ──

    @staticmethod
    def get_package(*, package_id: str, viewer_user_id: str) -> dict:
        """查看交接包详情（会话成员均可看），并记录接收者 viewed 状态。

        材料引用逐条按查看者实时鉴权，无权返回 access_denied 占位。
        """
        package = HandoffService._get_visible_package(package_id, viewer_user_id)
        HandoffService._mark_viewed(package, viewer_user_id)
        return HandoffService.serialize_package(package, viewer_user_id=viewer_user_id)

    @staticmethod
    def list_packages(
        *,
        conversation_id: str,
        viewer_user_id: str,
        authorization_header: str = "",
    ) -> list[dict]:
        """会话内交接包列表（不含材料鉴权明细，轻量）。"""
        conv = Conversation.objects.filter(pk=conversation_id).first()
        if conv is None or not ConversationAccessResolver.resolve(conv, viewer_user_id).can_view:
            raise PermissionError("不是该会话的成员")
        packages = (
            HandoffPackage.objects.filter(conversation_ref=conversation_id)
            .exclude(status=HandoffPackage.Status.DRAFT)
            .prefetch_related("recipients")
            .order_by("-created_at")[:100]
        )
        return [
            HandoffService.serialize_package(p, viewer_user_id=viewer_user_id, with_references=False)
            for p in packages
        ]

    # 单次 transcript 最多为多少个附件回填解析内容 / 单附件内容字符上限。
    # 交接是「发起人主动授权」场景，内容随交接包走，但要防超大会话把响应撑爆。
    _TRANSCRIPT_ATTACHMENT_LIMIT = 10
    _TRANSCRIPT_ATTACHMENT_CONTENT_CHARS = 8000

    @staticmethod
    def get_full_transcript(*, package_id: str, viewer_user_id: str) -> dict:
        """返回交接包中 chat_session 材料的完整冻结快照（不截断）。

        供 Agent runtime 在 prompt 注入时拉取完整对话历史，绕过前端
        消息长度截断限制。返回 frozen_snapshot_json 原始结构。

        附件内容回填：冻结快照里只存文件引用（file_id/url/filename），这里对
        file/document 类附件顺手带上 DocParse 解析文本（``parsed_content``）。
        鉴权以交接包可见性为准——发起人发起交接即视为把材料内容授权给会话成员，
        不要求查看者对 FileRecord 本身有归属权（被交接人通常没有）。
        """
        package = HandoffService._get_visible_package(package_id, viewer_user_id)
        ref = package.references.filter(
            ref_type=HandoffReference.RefType.CHAT_SESSION,
        ).first()
        if ref is None:
            return {"title": "", "message_count": 0, "truncated": False, "turns": []}
        snapshot = ref.frozen_snapshot_json or {}
        turns = HandoffService._enrich_turns_with_attachment_content(
            snapshot.get("turns", []),
        )
        return {
            "title": snapshot.get("title", ""),
            "message_count": snapshot.get("message_count", 0),
            "truncated": snapshot.get("truncated", False),
            "turns": turns,
        }

    @staticmethod
    def _enrich_turns_with_attachment_content(turns: list) -> list:
        """对结构化附件回填 DocParse 解析文本（不修改存储的快照，返回副本）。

        - 只处理 dict 形态且带 file_id 的 file/document 附件；image 与旧字符串
          占位（``[图片]`` 等）原样透传。
        - 解析未就绪（parsing / 未触发）时 ``parsed_content`` 为空串，并由
          get_summary 顺手触发异步解析，Agent 稍后重问可能就有了。
        """
        if not isinstance(turns, list):
            return []

        from apps.services.docparse.service import DocParseService

        enriched_count = 0
        result_turns: list = []
        for turn in turns:
            if not isinstance(turn, dict) or not turn.get("attachments"):
                result_turns.append(turn)
                continue
            attachments = []
            for att in turn["attachments"]:
                if (
                    not isinstance(att, dict)
                    or att.get("type") not in ("file", "document")
                    or not att.get("file_id")
                    or enriched_count >= HandoffService._TRANSCRIPT_ATTACHMENT_LIMIT
                ):
                    attachments.append(att)
                    continue
                enriched_count += 1
                content = ""
                try:
                    content = DocParseService.get_summary(str(att["file_id"])) or ""
                except Exception:
                    logger.warning(
                        "handoff transcript: 附件解析内容读取失败 file_id=%s",
                        att.get("file_id"), exc_info=True,
                    )
                limit = HandoffService._TRANSCRIPT_ATTACHMENT_CONTENT_CHARS
                if len(content) > limit:
                    content = content[:limit] + "…（已截断）"
                attachments.append({**att, "parsed_content": content})
            result_turns.append({**turn, "attachments": attachments})
        return result_turns

    @staticmethod
    def _mark_viewed(package: HandoffPackage, viewer_user_id: str) -> None:
        """接收者首次打开详情：sent → viewed（非接收者查看不记状态）。"""
        recipient = package.recipients.filter(user_id=viewer_user_id).first()
        if recipient is None or recipient.state != HandoffRecipient.State.SENT:
            return
        if package.status != HandoffPackage.Status.SENT:
            return
        with transaction.atomic(using=postgres_app_db_alias()):
            updated = HandoffRecipient.objects.filter(
                id=recipient.id, state=HandoffRecipient.State.SENT,
            ).update(
                state=HandoffRecipient.State.VIEWED,
                state_changed_at=timezone.now(),
            )
            if not updated:
                return
            HandoffEvent.objects.create(
                package=package,
                actor_user_id=viewer_user_id,
                event_type=HandoffEvent.EventType.VIEWED,
            )
            HandoffService._broadcast_update(package)

    # ── 接收者动作 / 撤销 ──

    @staticmethod
    def act(
        *,
        package_id: str,
        actor_user_id: str,
        action: str,
        note: str = "",
    ) -> dict:
        """接收者动作：acknowledge / take_over / reject。返回最新详情。"""
        if action not in _RECIPIENT_ACTIONS:
            raise ValueError(f"不支持的动作: {action}")
        note = (note or "").strip()[:NOTE_MAX_LEN]

        package = HandoffService._get_visible_package(package_id, actor_user_id)
        if package.status == HandoffPackage.Status.REVOKED:
            raise ValueError("交接包已撤销")
        if package.status != HandoffPackage.Status.SENT:
            raise ValueError("交接包尚未发送")
        # scope 强制：仅查看的交接不开放「由我继续」（acknowledge / reject 不受限）
        if action == "take_over" and package.scope == HandoffPackage.Scope.VIEW_ONLY:
            raise ValueError("该交接为仅查看，无法接手")

        recipient = HandoffService._resolve_acting_recipient(package, actor_user_id)

        target_state, event_type = _RECIPIENT_ACTIONS[action]
        if recipient.state == target_state:
            return HandoffService.serialize_package(package, viewer_user_id=actor_user_id)  # 幂等
        if target_state not in _RECIPIENT_TRANSITIONS.get(recipient.state, set()):
            raise ValueError(
                f"当前状态（{recipient.get_state_display()}）不允许该操作"
            )

        with transaction.atomic(using=postgres_app_db_alias()):
            recipient.state = target_state
            recipient.note = note
            recipient.state_changed_at = timezone.now()
            recipient.save(update_fields=["state", "note", "state_changed_at"])
            HandoffEvent.objects.create(
                package=package,
                actor_user_id=actor_user_id,
                event_type=event_type,
                payload_json={"note": note} if note else {},
            )
            HandoffService._broadcast_update(package)
        return HandoffService.serialize_package(package, viewer_user_id=actor_user_id)

    @staticmethod
    def take_over_session(
        *,
        package_id: str,
        actor_user_id: str,
        agent_id: str,
        workspace_id: str,
    ):
        """「由我继续」升级版：把交接包冻结的会话快照物化成接收人自己的
        Agent × Workspace 新会话，并回填 ``linked_session_id``。

        与 ``act('take_over')`` 的关系：老按钮只改接收者状态（保持不变）；
        本方法在同一状态迁移上叠加「建会话 + 回填」，状态从 sent / viewed /
        acknowledged / taking_over 均可达（taking_over 幂等重入，兼容先按过
        老按钮的接收者），rejected 后不可。

        幂等口径：``linked_session_id`` 已指向本人仍存在的会话时直接返回该
        会话，不重复建；会话被删则允许重建并回填新 id。

        Returns:
            新建（或幂等复用）的 ChatSession；序列化交给 API 层。
        """
        package = HandoffService._get_visible_package(package_id, actor_user_id)
        if package.status == HandoffPackage.Status.REVOKED:
            raise ValueError("交接包已撤销")
        if package.status == HandoffPackage.Status.SUPERSEDED:
            raise ValueError("交接包已被新版本取代")
        if package.status != HandoffPackage.Status.SENT:
            raise ValueError("交接包尚未发送")
        if package.scope == HandoffPackage.Scope.VIEW_ONLY:
            raise ValueError("该交接为仅查看，无法接手")

        recipient = HandoffService._resolve_acting_recipient(package, actor_user_id)
        target_state = HandoffRecipient.State.TAKING_OVER
        if (
            recipient.state != target_state
            and target_state not in _RECIPIENT_TRANSITIONS.get(recipient.state, set())
        ):
            raise ValueError(
                f"当前状态（{recipient.get_state_display()}）不允许该操作"
            )

        from apps.chat.conversation.models import ChatSession

        # ── 幂等：已建过且会话仍在、归本人 → 直接返回，不重复建 ────────
        if recipient.linked_session_id:
            try:
                existing = ChatSession.objects.filter(
                    id=recipient.linked_session_id, user_id=actor_user_id,
                ).first()
            except (ValueError, TypeError):
                existing = None  # 历史脏数据（非 UUID）按不存在处理，允许重建
            if existing is not None:
                return existing

        # ── 冻结快照 → 物化 turns ──────────────────────────────────────
        ref = package.references.filter(
            ref_type=HandoffReference.RefType.CHAT_SESSION,
        ).first()
        snapshot = (ref.frozen_snapshot_json or {}) if ref is not None else {}
        turns = HandoffService._compose_take_over_turns(snapshot.get("turns") or [])
        if not turns:
            raise ValueError("该交接没有可接手的会话快照")

        # ── 接收人执行目标校验（与 shared-fork 共用公共 helper）────────
        User = get_user_model()
        actor = User.objects.filter(pk=actor_user_id).first()
        if actor is None:
            raise PermissionError("用户不存在")

        from apps.chat.conversation.services.execution_target import (
            resolve_execution_target,
        )

        agent, workspace = resolve_execution_target(
            user=actor,
            agent_id=agent_id,
            workspace_id=workspace_id,
            organization_id=package.organization_id,
        )

        # ── briefing（人可读）+ 契约（给 LLM）────────────────────────
        initiator_display = HandoffService._initiator_display(package)
        truncated = bool(snapshot.get("truncated"))
        truncated_note = "（超长会话，快照已截断）" if truncated else ""
        source_title = str(snapshot.get("title") or "").strip()

        briefing_text = (
            "本会话由 IM 交接「由我继续」创建。\n"
            f"- 来源：{initiator_display} 的交接《{package.goal}》\n"
            f"- 以下 {len(turns)} 条消息为交接时冻结的会话快照{truncated_note}："
            "保留双方文字内容、工具调用名称与附件引用；思考过程与工具执行细节均已剔除\n"
            "- 附件行保留 file_id，可用 parse_document 等能力按引用读取全文\n"
            "- 原会话的执行现场（设备 / 目录 / 文件产物）不随交接转移\n"
            "接下来请基于以上内容继续这项工作。"
        )
        contract_payload = {
            "type": "handoff-take-over",
            "handoff_id": str(package.id),
            "goal": package.goal,
            "initiator_type": package.initiator_type,
            "initiator_id": package.initiator_user_id or package.initiator_agent_id,
            "initiator_display": initiator_display,
            "source_session_title": source_title,
            "snapshot_turn_count": len(turns),
            "snapshot_truncated": truncated,
            "taken_over_at": timezone.now().isoformat(),
            "notes": (
                "快照为交接时冻结的清洗版：保留正文、工具调用名称与附件引用，"
                "无思考过程与工具执行细节。不要臆测被剔除的内容，需要时向用户"
                "确认；附件可按 file_id 读取全文。"
            ),
        }
        source_meta = {"source_type": "handoff", "source_id": str(package.id)}

        from apps.chat.conversation.services.session_materializer import (
            materialize_session_from_turns,
        )

        new_session = materialize_session_from_turns(
            user=actor,
            organization_id=package.organization_id,
            agent=agent,
            workspace=workspace,
            title=f"[接力] {package.goal or source_title or '未命名会话'}",
            turns=turns,
            briefing_text=briefing_text,
            contract_payload=contract_payload,
            source_meta=source_meta,
            contract_wrapper_type="handoff-take-over",
        )

        with transaction.atomic(using=postgres_app_db_alias()):
            recipient.state = HandoffRecipient.State.TAKING_OVER
            recipient.linked_session_id = str(new_session.id)
            recipient.state_changed_at = timezone.now()
            recipient.save(
                update_fields=["state", "linked_session_id", "state_changed_at"],
            )
            HandoffEvent.objects.create(
                package=package,
                actor_user_id=actor_user_id,
                event_type=HandoffEvent.EventType.TAKEN_OVER,
                payload_json={
                    "linked_session_id": str(new_session.id),
                    "agent_id": str(agent.id),
                    "workspace_id": str(workspace.id),
                },
            )
            HandoffService._broadcast_update(package)
        return new_session

    @staticmethod
    def _compose_take_over_turns(raw_turns: list) -> list[dict]:
        """冻结快照 turns → 物化 turns（[{role, text, blocks}]）。

        新冻结快照优先携带已清洗的 ``blocks``，可直接复用原始消息结构；
        老冻结包没有 ``blocks`` 时，再按 text/tools/attachments 兼容转换。
        """
        turns: list[dict] = []
        for turn in raw_turns or []:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role")
            if role not in ("user", "assistant"):
                continue
            text = str(turn.get("text") or "").strip()
            raw_blocks = turn.get("blocks")
            blocks = [
                dict(block) for block in raw_blocks
                if isinstance(block, dict)
            ] if isinstance(raw_blocks, list) else []
            if not blocks:
                blocks = HandoffService._legacy_take_over_blocks(turn, text)

            if not blocks:
                continue
            turns.append({"role": role, "text": text, "blocks": blocks})
        return turns

    @staticmethod
    def _legacy_take_over_blocks(turn: dict, text: str) -> list[dict]:
        """兼容旧冻结包：text/tools/attachments → 可渲染 blocks。"""
        from apps.chat.conversation.services.transcript_snapshot import (
            clean_snapshot_blocks,
        )

        raw_blocks: list[dict] = []
        if text:
            raw_blocks.append({"type": "text", "text": text})
        for tool in turn.get("tools") or []:
            if isinstance(tool, dict):
                name = str(tool.get("name") or "").strip()
                label = str(tool.get("label") or "").strip()
            else:
                name = str(tool).strip()
                label = ""
            if not name:
                continue
            block = {"type": "tool_use", "name": name, "input": {}}
            if label:
                block["label"] = label
            raw_blocks.append(block)
        for att in turn.get("attachments") or []:
            if isinstance(att, dict):
                raw_blocks.append(dict(att))
            elif isinstance(att, str) and att.strip():
                raw_blocks.append({"type": "text", "text": att.strip()})
        _text, blocks = clean_snapshot_blocks(raw_blocks)
        return blocks

    @staticmethod
    def _initiator_display(package: HandoffPackage) -> str:
        """发起人展示名：user 取昵称，agent 取名称；查不到退回原始 id。"""
        fallback = package.initiator_user_id or package.initiator_agent_id or "用户"
        try:
            if package.initiator_user_id:
                User = get_user_model()
                user = User.objects.filter(pk=package.initiator_user_id).first()
                if user is not None:
                    return user.get_display_name() or fallback
            elif package.initiator_agent_id:
                from apps.agent.models import Agent

                agent = Agent.objects.filter(pk=package.initiator_agent_id).first()
                if agent is not None:
                    return agent.name or fallback
        except Exception:
            logger.debug(
                "handoff take-over: resolve initiator display failed", exc_info=True,
            )
        return fallback

    @staticmethod
    def revoke(
        *,
        package_id: str,
        actor_user_id: str | None = None,
        actor_agent_id: str | None = None,
    ) -> HandoffPackage:
        """发起人撤销：卡片保留但材料入口失效（查看时按状态拦截）。"""
        package = HandoffService._get_owned_package(
            package_id, actor_user_id, actor_agent_id,
        )
        if package.status == HandoffPackage.Status.REVOKED:
            return package  # 幂等
        if package.status not in (HandoffPackage.Status.DRAFT, HandoffPackage.Status.SENT):
            raise ValueError("当前状态不允许撤销")

        with transaction.atomic(using=postgres_app_db_alias()):
            package.status = HandoffPackage.Status.REVOKED
            package.save(update_fields=["status", "updated_at"])
            HandoffEvent.objects.create(
                package=package,
                actor_user_id=actor_user_id,
                actor_agent_id=actor_agent_id,
                event_type=HandoffEvent.EventType.REVOKED,
            )
            HandoffService._broadcast_update(package)
        return package

    # ── 内部 ──

    @staticmethod
    def _get_owned_package(
        package_id: str,
        actor_user_id: str | None,
        actor_agent_id: str | None,
    ) -> HandoffPackage:
        if bool(actor_user_id) == bool(actor_agent_id):
            raise ValueError("操作者必须是 user 或 agent 二选一")
        package = HandoffPackage.objects.filter(pk=package_id).first()
        if package is None:
            raise ValueError("交接包不存在")
        if actor_user_id and package.initiator_user_id != str(actor_user_id):
            raise PermissionError("只有发起人可以操作该交接包")
        if actor_agent_id and package.initiator_agent_id != str(actor_agent_id):
            raise PermissionError("只有发起 Agent 可以操作该交接包")
        return package

    @staticmethod
    def _resolve_acting_recipient(
        package: HandoffPackage, actor_user_id: str,
    ) -> HandoffRecipient:
        """定位操作者的接收者行（act / take_over_session 共用口径）。

        不在接收者列表时按转发场景处理：同 org 用户可自行加入独立操作。
        """
        recipient = package.recipients.filter(user_id=actor_user_id).first()
        if recipient is not None:
            return recipient
        User = get_user_model()
        # 同 _get_visible_package：OrganizationMember 无 is_active 字段，存在行即在组织内。
        is_same_org = User.objects.filter(
            pk=actor_user_id,
            organization_memberships__organization_id=package.organization_id,
        ).exists()
        if not is_same_org:
            raise PermissionError("你不是该交接包的接收者")
        return HandoffRecipient.objects.create(
            package=package,
            user_id=actor_user_id,
            state=HandoffRecipient.State.VIEWED,
            state_changed_at=timezone.now(),
        )

    @staticmethod
    def _get_visible_package(package_id: str, viewer_user_id: str) -> HandoffPackage:
        package = (
            HandoffPackage.objects.filter(pk=package_id)
            .select_related("conversation")
            .first()
        )
        if package is None:
            raise ValueError("交接包不存在")
        can_view_legacy = bool(
            package.conversation
            and ConversationAccessResolver.resolve(package.conversation, viewer_user_id).can_view
        )
        is_initiator = package.initiator_user_id == str(viewer_user_id)
        if package.status == HandoffPackage.Status.DRAFT and not is_initiator:
            raise PermissionError("交接包尚未发送")
        # 同 organization 的用户均可查看（覆盖转发到其他会话的场景）
        is_same_org = False
        if not can_view_legacy and not is_initiator:
            # OrganizationMember 没有 is_active 停用位——成员被移除即删行，
            # 存在成员行 = 在组织内（此前误加 __is_active 过滤会抛 FieldError）。
            User = get_user_model()
            is_same_org = User.objects.filter(
                pk=viewer_user_id,
                organization_memberships__organization_id=package.organization_id,
            ).exists()
            if not is_same_org:
                raise PermissionError("无权查看该交接包")
        return package

    @staticmethod
    def _broadcast_update(package: HandoffPackage) -> None:
        """状态变化后广播 im.handoff.update，前端按 handoff_id 重拉详情。"""
        if package.conversation is None:
            return
        IMOutboxService.enqueue(
            organization_id=str(package.organization_id),
            event_type=IMEventType.HANDOFF_UPDATE,
            target_channels=[f"chat:{package.conversation_id}"],
            data={
                "handoff_id": str(package.id),
                "conversation_id": str(package.conversation_id),
                "status": package.status,
                "message_id": package.card_message_id,
            },
            conversation=package.conversation,
        )

    # ── 序列化 ──

    @staticmethod
    def serialize_package(
        package: HandoffPackage,
        *,
        viewer_user_id: str | None = None,
        with_references: bool = True,
    ) -> dict:
        recipients = [
            {
                "user_id": r.user_id,
                "agent_id": r.agent_id,
                "state": r.state,
                "note": r.note,
                "state_changed_at": r.state_changed_at.isoformat() if r.state_changed_at else None,
            }
            for r in package.recipients.all()
        ]
        data = {
            "id": str(package.id),
            "conversation_id": HandoffService._conversation_ref(package),
            "organization_id": package.organization_id,
            "initiator_type": package.initiator_type,
            "initiator_user_id": package.initiator_user_id,
            "initiator_agent_id": package.initiator_agent_id,
            "goal": package.goal,
            "progress": package.progress_json,
            "next_steps": package.next_steps_json,
            "risks": package.risks_json,
            "scope": package.scope,
            "status": package.status,
            "version": package.version,
            "card_message_id": package.card_message_id,
            "card_message_ref": (
                str(package.card_message_ref) if package.card_message_ref else None
            ),
            "card_message_sequence": package.card_message_sequence,
            "recipients": recipients,
            "created_at": package.created_at.isoformat(),
            "updated_at": package.updated_at.isoformat(),
        }
        if with_references:
            data["references"] = HandoffService._serialize_references(
                package, viewer_user_id,
            )
        return data

    @staticmethod
    def _serialize_references(
        package: HandoffPackage, viewer_user_id: str | None,
    ) -> list[dict]:
        """材料引用：查看时逐条实时鉴权，无权/失效给结构化占位。"""
        User = get_user_model()
        viewer = User.objects.filter(id=viewer_user_id).first() if viewer_user_id else None
        revoked = package.status == HandoffPackage.Status.REVOKED

        result: list[dict] = []
        for ref in package.references.all().order_by("created_at"):
            entry = {
                "id": str(ref.id),
                "ref_type": ref.ref_type,
                "resource_id": ref.resource_id,
                "title": ref.title_snapshot,
                "summary": ref.summary_snapshot,
                "source_link": ref.source_link,
                "accessible": False,
                "denied_reason": None,
            }
            if revoked:
                entry["denied_reason"] = "revoked"
                result.append(entry)
                continue
            if ref.ref_type == HandoffReference.RefType.CHAT_SESSION:
                # 快照型材料：直接读冻结快照，不回源、不逐条鉴权
                # （权限边界由所属交接包成员资格保证）。
                entry["accessible"] = True
                entry["frozen_snapshot"] = ref.frozen_snapshot_json or {}
                result.append(entry)
                continue
            if ref.ref_type == HandoffReference.RefType.IM_MESSAGE:
                if package.conversation is None:
                    entry["accessible"] = True
                else:
                    entry["accessible"] = Message.objects.filter(
                        pk=ref.resource_id,
                        conversation=package.conversation,
                        is_deleted=False,
                    ).exists()
                    if not entry["accessible"]:
                        entry["denied_reason"] = "deleted"
            elif viewer is not None:
                from apps.tabchat.services.message_service import _load_card_resource

                try:
                    _load_card_resource(ref.ref_type, ref.resource_id, viewer)
                    entry["accessible"] = True
                except PermissionError:
                    entry["denied_reason"] = "access_denied"
                except ValueError:
                    entry["denied_reason"] = "deleted"
                except Exception:
                    logger.exception(
                        "[handoff] reference access check failed ref=%s", ref.id,
                    )
                    entry["denied_reason"] = "error"
            else:
                entry["denied_reason"] = "access_denied"
            result.append(entry)
        return result

    @staticmethod
    def _conversation_ref(package: HandoffPackage) -> str:
        return package.conversation_ref or str(package.conversation_id or "")

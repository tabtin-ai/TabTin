"""消息服务。

职责：发消息、消息历史（cursor 分页）、会话水位已读与未读计数。
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any
from uuid import UUID

from django.db import IntegrityError, connections, transaction
from django.db.models import BigIntegerField, Count, F, Max, OuterRef, Q, Subquery, Value, Window
from django.db.models.functions import Coalesce, RowNumber
from django.utils import timezone

from django.contrib.auth import get_user_model

from apps.tabchat.constants import (
    AGENT_MENTION_ACK_EMOJI,
    ConversationType,
    IMEventType,
    MemberRole,
    MessageType,
    SenderType,
)
from apps.tabchat.models import (
    AgentMentionJob,
    Conversation,
    ConversationMember,
    ConversationUserState,
    Message,
    MessageMention,
    MessageUserState,
)
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.external_group_errors import ExternalGroupCapabilityError
from apps.tabchat.services.mention_markdown import format_mention_display_text
from apps.tabchat.services.im_outbox_service import IMOutboxService
from apps.tabchat.services.message_visibility import apply_user_message_visibility
from apps.tabchat.utils import (
    get_conversation_team_space,
    get_team_space_conversation_user_ids,
    get_team_space_execution_agent_id,
    is_conversation_user_active,
    is_team_space_conversation_user_active,
)
from apps.services.common.db_router import postgres_app_db_alias

User = get_user_model()

logger = logging.getLogger(__name__)


RECALL_TIMEOUT_SECONDS = 120  # 撤回时限：2 分钟

ALLOWED_SEND_TYPES = {MessageType.TEXT, MessageType.FILE, MessageType.IMAGE}

MAX_METADATA_SIZE = 5000  # metadata JSON 字符数上限
# 指令卡专用 metadata 预算：prompt_text 上限 8000 字符，JSON 转义（换行/引号）
# 最坏情况下体积翻倍，通用 5000 上限装不下，单独放宽。
MAX_PROMPT_METADATA_SIZE = 20_000
MAX_FILE_SIZE = 200 * 1024 * 1024  # 200 MB
MAX_CONTENT_LENGTH = 10_000  # 与 Schema 层 SendMessageRequest.content.max_length 对齐


_MAX_PREVIEW_LEN = 200  # 与 Conversation.last_message_preview CharField(max_length=200) 对齐
_CARD_DESCRIPTION_MAX_LEN = 600  # 资源卡 metadata.card.description 摘要上限（飞书式内容预览）
_NAME_BUDGET = 18       # 群聊 preview 中昵称前缀最大占用字符


def _enqueue_personal_unread_updates(
    *,
    conversation: Conversation,
    message: Message,
    domain_event_id,
    recipient_ids: list[str],
    data: dict[str, Any],
    mention: bool,
) -> None:
    """投递带接收者目录作用域的未读事件。

    内部会话继续合并广播；外部会话按 participant organization 分组，避免接收方
    因 payload 只带托管 organization 而把合法实时未读当成跨组织脏事件丢弃。
    """
    normalized_recipient_ids = list(
        dict.fromkeys(str(user_id) for user_id in recipient_ids if user_id)
    )
    if not normalized_recipient_ids:
        return
    if not conversation.is_external:
        IMOutboxService.enqueue(
            organization_id=str(conversation.organization_id),
            event_type=IMEventType.UNREAD_UPDATE,
            target_channels=[f"personal:{user_id}" for user_id in normalized_recipient_ids],
            data={**data, "mention": mention},
            conversation=conversation,
            message=message,
            domain_event_id=domain_event_id,
        )
        return

    participant_scope_by_user = {
        str(user_id): str(participant_organization_id or conversation.organization_id)
        for user_id, participant_organization_id in ConversationMember.objects.filter(
            conversation=conversation,
            user_id__in=normalized_recipient_ids,
            status=ConversationMember.Status.ACTIVE,
        ).values_list("user_id", "participant_organization_id")
    }
    users_by_scope: dict[str, list[str]] = {}
    for user_id in normalized_recipient_ids:
        scope_id = participant_scope_by_user.get(user_id, str(conversation.organization_id))
        users_by_scope.setdefault(scope_id, []).append(user_id)
    for scope_id, scoped_user_ids in users_by_scope.items():
        IMOutboxService.enqueue(
            organization_id=str(conversation.organization_id),
            event_type=IMEventType.UNREAD_UPDATE,
            target_channels=[f"personal:{user_id}" for user_id in scoped_user_ids],
            data={
                **data,
                "participant_organization_id": scope_id,
                "directory_scope_id": scope_id,
                "mention": mention,
            },
            conversation=conversation,
            message=message,
            domain_event_id=domain_event_id,
        )


def _enqueue_personal_preview_update(
    *,
    conversation: Conversation,
    message: Message,
    domain_event_id,
    preview: str,
    recipient_ids: list[str] | None = None,
) -> None:
    """把最后消息预览同步到指定成员（默认全部）目录，但不改变未读数。"""
    recipients = sorted(
        dict.fromkeys(
            str(user_id)
            for user_id in (
                recipient_ids
                if recipient_ids is not None
                else ConversationAccessResolver.human_user_ids(conversation)
            )
            if user_id
        )
    )
    if not recipients:
        return

    participant_scope_by_user = {
        str(user_id): str(participant_organization_id or conversation.organization_id)
        for user_id, participant_organization_id in ConversationMember.objects.filter(
            conversation=conversation,
            user_id__in=recipients,
            status=ConversationMember.Status.ACTIVE,
        ).values_list("user_id", "participant_organization_id")
    }
    users_by_scope: dict[str, list[str]] = {}
    for user_id in recipients:
        scope_id = participant_scope_by_user.get(
            user_id,
            str(conversation.organization_id),
        )
        users_by_scope.setdefault(scope_id, []).append(user_id)

    for scope_id, scoped_user_ids in users_by_scope.items():
        IMOutboxService.enqueue(
            organization_id=str(conversation.organization_id),
            event_type=IMEventType.CONVERSATION_PREVIEW_UPDATED,
            target_channels=[f"personal:{user_id}" for user_id in scoped_user_ids],
            data={
                "conversation_id": str(conversation.id),
                "organization_id": str(conversation.organization_id),
                "participant_organization_id": scope_id,
                "directory_scope_id": scope_id,
                "message_id": message.id,
                "message_seq": message.seq,
                "preview": preview,
                "last_message_at": message.created_at.isoformat(),
            },
            conversation=conversation,
            message=message,
            domain_event_id=domain_event_id,
        )


def _mobile_push_recipients(
    *,
    conversation: Conversation,
    recipient_ids: list[str],
    mentioned_recipient_ids: list[str],
) -> list[dict[str, object]]:
    """构造移动推送接收人，并为外部群写入接收者自己的目录组织。"""
    mentioned = set(mentioned_recipient_ids)
    scope_by_user: dict[str, str] = {}
    if conversation.is_external and recipient_ids:
        scope_by_user = {
            str(user_id): str(participant_organization_id or conversation.organization_id)
            for user_id, participant_organization_id in ConversationMember.objects.filter(
                conversation=conversation,
                user_id__in=recipient_ids,
                status=ConversationMember.Status.ACTIVE,
            ).values_list("user_id", "participant_organization_id")
        }
    default_scope = str(conversation.organization_id)
    return [
        {
            "user_id": user_id,
            "mention": user_id in mentioned,
            "organization_id": scope_by_user.get(user_id, default_scope),
        }
        for user_id in recipient_ids
    ]


def _allocate_message_seq(conversation_id: str) -> int:
    """原子递增并返回会话消息序号；调用方必须处于主事务中。"""
    alias = postgres_app_db_alias()
    table_name = connections[alias].ops.quote_name(Conversation._meta.db_table)
    with connections[alias].cursor() as cursor:
        cursor.execute(
            f"""
            UPDATE {table_name}
            SET latest_message_seq = latest_message_seq + 1
            WHERE id = %s
            RETURNING latest_message_seq
            """,
            [conversation_id],
        )
        row = cursor.fetchone()
    if row is None:
        raise ValueError("会话不存在")
    return int(row[0])


def _build_preview(
    message_type: int,
    content: str,
    metadata: dict | None,
    *,
    conv_type: int | None = None,
    sender_name: str = "",
) -> str:
    """统一生成会话 last_message_preview。

    send_message / delete_message 共用，保证存储和实时 preview 一致。
    输出保证不超过 _MAX_PREVIEW_LEN，防止 CharField(max_length=200) 溢出。
    """
    if message_type == MessageType.FILE:
        card = (metadata or {}).get("card")
        if (
            isinstance(card, dict)
            and card.get("type") == _CARD_CODEX_SESSION_TYPE
            and type(card.get("schema_version")) is int
            and card.get("schema_version") == 1
            and isinstance(card.get("codex_session_id"), str)
            and bool(card["codex_session_id"].strip())
            and isinstance(card.get("codex_session_name"), str)
            and bool(card["codex_session_name"].strip())
        ):
            session_name = card["codex_session_name"].strip()
            preview = f"[Codex 会话] {session_name}" if session_name else "[Codex 会话]"
        else:
            file_name = (metadata or {}).get("file_name", "")
            preview = f"[文件] {file_name}" if file_name else "[文件]"
    elif message_type == MessageType.IMAGE:
        preview = "[图片]"
    else:
        card = (metadata or {}).get("card")
        if isinstance(card, dict) and card.get("type") in _CARD_RESOURCE_TYPES:
            label = "表格" if card["type"] == "table" else "文档"
            preview = f"[{label}] {card.get('name', '')}".strip()
        elif isinstance(card, dict) and card.get("type") == _CARD_CONTACT_TYPE:
            preview = f"[名片] {card.get('name', '')}".strip()
        else:
            preview = format_mention_display_text(content or "")[:_MAX_PREVIEW_LEN]

    if conv_type == ConversationType.GROUP and sender_name:
        name_part = sender_name[:_NAME_BUDGET]
        prefix_len = len(name_part) + 2  # ": " 占 2 字符
        preview = f"{name_part}: {preview[:_MAX_PREVIEW_LEN - prefix_len]}"

    return preview[:_MAX_PREVIEW_LEN]


def _looks_like_html(text: str) -> bool:
    """TabDoc 协作保存后 description_markdown 常为 HTML，非 Markdown。"""
    stripped = text.lstrip()
    return bool(stripped) and stripped.startswith("<") and bool(re.search(r"<\w+", stripped))


def _resolve_resource_card_description(resource, card_type: str) -> str:
    """从资源模型读取摘要供卡片预览。

    文档优先返回 markdown（前端做轻量 block 级渲染：标题/列表/引用）；若
    description_markdown 已是 HTML（协作 store 后常见），回退 plaintext，
    再回退 get_context_preview；表格走 get_context_preview。
    """
    if card_type == "document":
        markdown = (getattr(resource, "description_markdown", None) or "").strip()
        if markdown and not _looks_like_html(markdown):
            text = markdown
        else:
            text = (getattr(resource, "description_plaintext", None) or "").strip()
        if not text:
            text = (resource.get_context_preview() or "").strip()
    else:
        text = (resource.get_context_preview() or "").strip()
    return text[:_CARD_DESCRIPTION_MAX_LEN]


def _external_directory_members(organization_id: str, user_id: str):
    """返回用户在指定组织目录中可见的外部群成员关系。

    旧数据没有 participant_organization_id，只能按会话所属组织回退；新数据必须
    严格按成员进入会话时的组织目录过滤，避免用户加入其他组织后串出外部群。
    """
    return ConversationMember.objects.filter(
        user_id=user_id,
        conversation__is_external=True,
        visibility_windows__isnull=False,
    ).filter(
        Q(participant_organization_id=organization_id)
        | Q(
            participant_organization_id="",
            conversation__organization_id=organization_id,
        )
    ).distinct()


def _format_table_cell_preview(value, *, max_len: int = 28) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        for key in ("name", "title", "text", "label"):
            nested = value.get(key)
            if isinstance(nested, str) and nested.strip():
                value = nested
                break
        else:
            return "…"
    text = str(value).strip().replace("\n", " ")
    if len(text) > max_len:
        return f"{text[: max_len - 1]}…"
    return text


def _build_table_card_preview_snapshot(table, *, max_cols: int = 4, max_rows: int = 4) -> dict | None:
    """构造表格卡的「表头 + 采样行」快照。

    复用 `tabdata.admin_api._safe_build_record_preview`——它同时覆盖 native storage
    主路径与 ORM 回退（TabData 单元格数据存在 native 层，不在 TableRecord.data，
    直接 ORM 读会丢数据）。失败时该 helper 已兜底返回空结构。
    """
    from apps.tabdata.admin_api import _safe_build_record_preview

    preview = _safe_build_record_preview(table.id, limit=max_rows, max_fields=max_cols)
    if not preview.fields:
        return None

    columns = [{"key": field.field_id, "label": field.field_name} for field in preview.fields]
    rows: list[dict[str, str]] = []
    for record in preview.rows:
        values = record.values if isinstance(record.values, dict) else {}
        rows.append(
            {field.field_id: _format_table_cell_preview(values.get(field.field_id)) for field in preview.fields}
        )

    return {
        "columns": columns,
        "rows": rows,
        "total_rows": int(getattr(preview, "total_rows", 0) or 0),
    }


def _load_card_resource(card_type: str, resource_id, user):
    """按 card_type 查资源并校验 user 的 viewer 权限（发送侧 / 只读预览侧共用）。

    返回 (resource, space_id, organization_id, name)。
    资源不存在 / 在回收站 → ValueError；user 无 viewer 权限 → PermissionError。
    """
    if card_type == "table":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table
        from apps.tabdata.services import TableService

        table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=resource_id, trashed_at__isnull=True)
            .first()
        )
        if not table:
            raise ValueError("表格不存在或已在回收站")
        if not TableService(user=user).check_table_permission(str(table.id), "viewer"):
            raise PermissionError("无权访问该表格")
        return (
            table,
            str(table.space_id) if table.space_id else None,
            str(table.organization_id),
            table.name,
        )

    from apps.tabdoc.models import Document
    from apps.tabdoc.services.document_service import DocumentService

    doc = Document.objects.filter(id=resource_id, trashed_at__isnull=True).first()
    if not doc:
        raise ValueError("文档不存在或已在回收站")
    if not DocumentService(user=user).check_document_permission(doc, required_role="viewer"):
        raise PermissionError("无权访问该文档")
    return (
        doc,
        str(doc.space_id) if doc.space_id else None,
        str(doc.organization_id),
        doc.title or "未命名文档",
    )


def resolve_resource_card_preview(card_type: str, resource_id, user) -> dict:
    """按需读取资源卡的最新预览及当前用户的资源级权限。

    用于前端渲染存量资源卡时拉取真实内容，绕开可能 stale 的 ContextItem.preview
    快照。校验 user 对资源有 viewer 权限（无权抛 PermissionError，不暴露内容）。
    DM 发送资源卡时会对端静默补 viewer；GROUP / 存量 / 外部卡片仍以实际
    资源权限为准。card_type ∈ {document, table}。
    """
    from uuid import UUID

    if card_type not in _CARD_RESOURCE_TYPES:
        raise ValueError("不支持的资源类型")
    try:
        UUID(str(resource_id))
    except (ValueError, TypeError):
        raise ValueError("resource_id 不是合法 UUID")

    resource, space_id, organization_id, name = _load_card_resource(card_type, resource_id, user)
    if card_type == "table":
        from apps.tabdata.services.base import BaseService

        current_user_role = BaseService(user=user).get_table_role(str(resource.id))
    else:
        from apps.tabdoc.services.document_service import DocumentService

        current_user_role = DocumentService(user=user).compute_user_document_role(resource)

    return {
        "name": name,
        "space_id": space_id,
        "organization_id": organization_id,
        "current_user_role": current_user_role,
        "description": _resolve_resource_card_description(resource, card_type),
        "preview_table": (
            _build_table_card_preview_snapshot(resource) if card_type == "table" else None
        ),
    }


_ATTACHMENT_METADATA_FIELDS = {
    "file_id", "file_name", "file_size", "file_type",
    "mentioned_user_ids", "mentioned_agent_ids", "mention_all",
    "client_request_id", "message_ref", "forwarded_from",
    # 内置贴纸语义：气泡按贴纸尺寸渲染，不可当普通图片缩放
    "sticker",
}

_TABTIN_ROBOT_PACK_ID = "tabtin-robot"
_TABTIN_ROBOT_STICKER_IDS = frozenset({"neutral", "happy", "sad", "surprise", "cool"})


def _sanitize_sticker_metadata(sticker: object) -> dict | None:
    """只保留已知包/id；非法结构丢弃，避免脏字段进库。"""
    if not isinstance(sticker, dict):
        return None
    pack = sticker.get("pack")
    sticker_id = sticker.get("id")
    if pack == _TABTIN_ROBOT_PACK_ID and sticker_id in _TABTIN_ROBOT_STICKER_IDS:
        return {"pack": pack, "id": sticker_id}
    return None


def _sanitize_attachment_metadata(metadata: dict, message_type: int) -> dict:
    """只保留附件身份、展示快照与消息语义，拒绝持久化任何交付 URL。"""
    if message_type not in (MessageType.FILE, MessageType.IMAGE):
        return metadata

    raw_card = metadata.get("card")
    sanitized = {key: value for key, value in metadata.items() if key in _ATTACHMENT_METADATA_FIELDS}
    if isinstance(raw_card, dict) and raw_card.get("type") == _CARD_CODEX_SESSION_TYPE:
        # Codex 会话本质是 ZIP 附件，但 card 才承载会话身份。这里只保留这一种
        # 文件卡进入后续严格校验；其它卡片仍不能借附件 metadata 夹带。
        sanitized["card"] = dict(raw_card)
    forwarded_from = sanitized.get("forwarded_from")
    if isinstance(forwarded_from, dict):
        sanitized["forwarded_from"] = {
            key: forwarded_from[key]
            for key in ("original_message_id", "original_conversation_id")
            if key in forwarded_from
        }
    else:
        sanitized.pop("forwarded_from", None)

    # 贴纸仅属于 IMAGE；FILE 或非法 sticker 一律剥离
    if message_type != MessageType.IMAGE or "sticker" not in sanitized:
        sanitized.pop("sticker", None)
    else:
        cleaned_sticker = _sanitize_sticker_metadata(sanitized.get("sticker"))
        if cleaned_sticker is None:
            sanitized.pop("sticker", None)
        else:
            sanitized["sticker"] = cleaned_sticker
    return sanitized


def _validate_attachment_metadata(metadata: dict, message_type: int) -> None:
    """校验附件消息的长期 metadata 合法性。"""
    import json

    # 指令卡（prompt）正文可达 8000 字符，走专用预算；其余消息维持通用上限。
    card = metadata.get("card")
    if (
        isinstance(card, dict)
        and card.get("type") == _CARD_CODEX_SESSION_TYPE
        and type(card.get("schema_version")) is int
        and card.get("schema_version") == 1
        and message_type != MessageType.FILE
    ):
        raise ValueError("Codex 会话卡只能用于文件消息")
    size_limit = (
        MAX_PROMPT_METADATA_SIZE
        if isinstance(card, dict) and card.get("type") == _CARD_PROMPT_TYPE
        else MAX_METADATA_SIZE
    )
    if len(json.dumps(metadata, ensure_ascii=False)) > size_limit:
        raise ValueError("metadata 过大")

    if message_type not in (MessageType.FILE, MessageType.IMAGE):
        return

    file_id = metadata.get("file_id")
    if not isinstance(file_id, str) or not file_id.strip():
        raise ValueError("附件消息缺少 file_id")

    file_size = metadata.get("file_size")
    if file_size is not None and (
        isinstance(file_size, bool)
        or not isinstance(file_size, int)
        or file_size < 0
        or file_size > MAX_FILE_SIZE
    ):
        raise ValueError("文件大小超限")

    if "sticker" in metadata:
        if message_type != MessageType.IMAGE:
            raise ValueError("仅图片消息可携带 sticker")
        if _sanitize_sticker_metadata(metadata.get("sticker")) is None:
            raise ValueError("sticker 不合法")


def _sender_has_tabfiles_viewer_acl(file_record_id, organization_id: str, sender_id: str) -> bool:
    """发送者对未回收 TabFiles ContextItem 是否具备 viewer+（复用云盘 ACL）。

    FileRecord 已在调用方按会话 organization + completed 校验；此处只认
    「未进回收站的 tabfiles ContextItem + check_item_resource_permission」。
    """
    from apps.tabtinspace.models import ContextItem
    from apps.tabtinspace.services.cloud_resource_acl import check_item_resource_permission

    # 与 tabfiles_share_service._get_file_item 同口径：未回收才可引用。
    item = (
        ContextItem.objects.filter(
            item_type="tabfiles",
            resource_id=str(file_record_id),
            trashed_at__isnull=True,
        )
        .exclude(status="trashed")
        .first()
    )
    if item is None:
        return False

    # org-only 条目须与会话组织一致；workspace/project 宿主条目以 FileRecord.organization_id 为准。
    item_org_id = getattr(item, "organization_id", None)
    if item_org_id is not None and str(item_org_id) != str(organization_id):
        return False

    sender = User.objects.filter(id=sender_id).first()
    if sender is None:
        return False
    return check_item_resource_permission(sender, item, "viewer")


def _validate_attachment_file_record(
    file_id: str,
    organization_id: str,
    sender_id: str,
    source_message: Message | None = None,
) -> None:
    """确认发送者有权将文件引用到当前消息，且文件属于当前组织。

    放行路径（转发除外）：
    - 上传者本人；
    - 对该 FileRecord 仍有 active FileUsage；
    - 或对未回收 TabFiles ContextItem 具备 viewer+ ACL（云盘分享协作场景）。
    """
    from uuid import UUID
    from apps.services.oss.models import FileRecord, FileUsage

    try:
        parsed_file_id = UUID(file_id)
    except (TypeError, ValueError):
        raise ValueError("file_id 格式不合法")

    record = FileRecord.objects.filter(
        id=parsed_file_id,
        organization_id=organization_id,
        status="completed",
    ).first()
    if not record:
        raise ValueError("附件不存在或不属于当前组织")

    if getattr(record, "file_size", None) is not None:
        try:
            size = int(record.file_size)
        except (TypeError, ValueError):
            size = -1
        if size < 0 or size > MAX_FILE_SIZE:
            raise ValueError("文件大小超限")

    if source_message is not None:
        if str((source_message.metadata or {}).get("file_id") or "") != file_id:
            raise PermissionError("转发附件与原消息不一致")
        source_usage_exists = FileUsage.objects.filter(
            file_record=record,
            module="tabchat",
            context_type="im_message",
            context_id=str(source_message.id),
            is_active=True,
        ).exists()
        if not source_usage_exists:
            raise PermissionError("原附件不可转发")
        return

    is_uploader = str(record.upload_user) == sender_id
    has_existing_access = FileUsage.objects.filter(
        file_record=record,
        user_id=sender_id,
        is_active=True,
    ).exists()
    if is_uploader or has_existing_access:
        return
    if _sender_has_tabfiles_viewer_acl(record.id, organization_id, sender_id):
        return
    raise PermissionError("无权引用该附件")


def _resolve_forwarded_source(metadata: dict, target_conversation: Conversation, sender_id: str) -> Message | None:
    """校验转发来源并以服务端快照覆盖客户端声明。"""
    forwarded_from = metadata.get("forwarded_from")
    if not forwarded_from:
        return None
    if not isinstance(forwarded_from, dict):
        raise ValueError("forwarded_from 格式不合法")

    source_message_id = forwarded_from.get("original_message_id")
    source_conversation_id = forwarded_from.get("original_conversation_id")
    if not isinstance(source_message_id, int) or not isinstance(source_conversation_id, str):
        raise ValueError("forwarded_from 信息不完整")

    source_message = Message.objects.select_related("conversation").filter(
        id=source_message_id,
        conversation_id=source_conversation_id,
        is_deleted=False,
    ).first()
    if not source_message or str(source_message.conversation.organization_id) != str(target_conversation.organization_id):
        raise PermissionError("无权转发该消息")
    if not ConversationAccessResolver.resolve(source_message.conversation, sender_id).can_view:
        raise PermissionError("无权转发该消息")
    if not apply_user_message_visibility(
        Message.objects.filter(pk=source_message.pk),
        user_id=sender_id,
        history_cleared_seq=0,
        conversation_ids=[str(source_message.conversation_id)],
    ).exists():
        raise PermissionError("无权转发该消息")

    metadata["forwarded_from"] = {
        "original_message_id": source_message.id,
        "original_conversation_id": str(source_message.conversation_id),
        "original_conversation_name": source_message.conversation.name or "",
        "original_sender_id": source_message.sender_id,
        "original_sender_name": MessageService._resolve_user_sender_name(source_message.sender_id),
    }
    return source_message


# TC-5 资源卡：卡片 type 用 table/document（对齐 ResourcePointer），
# carrier app hint 供前端 ResourceRouter 打开资源时定位承载 App。
# 权限口径：卡片仍是指针；仅 DM 发送时静默补对方 viewer，
# GROUP 不授权（收卡 ≠ 获访问权，无权成员走申请）。
_CARD_RESOURCE_TYPES = {"table", "document"}
_CARD_HINT_BY_TYPE = {"table": "tabdata", "document": "tabdoc"}

# 个人名片卡：把某个 organization 成员作为一条消息发进会话，
# 对方点开看资料 / 一键发起 DM。后端以 DB 真实昵称/头像回填，防伪造。
_CARD_CONTACT_TYPE = "contact"

# 指令卡：把一段可复用的 AI 指令（prompt）作为消息发进会话，对方一键带入
# 自己的 Agent 会话执行。卡片自包含正文，服务端只做限长 + 白名单裁剪。
_CARD_PROMPT_TYPE = "prompt"
PROMPT_CARD_TEXT_MAX_LEN = 8000
PROMPT_CARD_TITLE_MAX_LEN = 200

# 任务共享卡：会话共享授权（chat.conversation SessionShare）的展示面。
# 卡片只带 share_id，正文（session_title / 权限位 / 状态）以 DB 共享行回填。
_CARD_SESSION_SHARE_TYPE = "session_share"
_CARD_SESSION_SHARE_V2_TYPE = "session_share_v2"
_CARD_SESSION_CONTINUATION_TYPE = "session_continuation"

# Codex 会话归档卡：文件引用仍走统一附件权限，card 只保存版本化会话身份。
_CARD_CODEX_SESSION_TYPE = "codex_session"
CODEX_SESSION_ID_MAX_LEN = 200
CODEX_SESSION_NAME_MAX_LEN = 500
CODEX_WORKING_DIRECTORY_MAX_LEN = 4096

# 需要后端校验回填的全部卡片类型（资源卡 + 名片卡 + 指令卡 + 任务共享卡）。
_CARD_VALIDATED_TYPES = _CARD_RESOURCE_TYPES | {
    _CARD_CONTACT_TYPE,
    _CARD_PROMPT_TYPE,
    _CARD_SESSION_SHARE_TYPE,
    _CARD_SESSION_SHARE_V2_TYPE,
    _CARD_SESSION_CONTINUATION_TYPE,
    _CARD_CODEX_SESSION_TYPE,
}

# 交接卡：交接包（handoff 子域）的展示面。卡片只带 handoff_id，正文（goal 等）
# 以 DB 为准，防止客户端直接发消息伪造他人交接 / 篡改标题。
_CARD_HANDOFF_TYPE = "handoff"


def _validate_handoff_card(metadata: dict, sender_id: str) -> dict:
    """交接卡防伪造：仅发起人可发、仅草稿态可发，正文以 DB 快照回填。

    交接卡是 handoff 子域领域对象的展示面。正常发送走
    ``HandoffService.send_package``（草稿态调本函数所在的 send_message）；
    但任何人都能直接调发消息接口塞一张 ``card.type=handoff``，因此这里：
    - 校验 handoff_id 指向的交接包存在；
    - 校验发送者确为发起人（user 或 agent），否则 PermissionError；
    - 校验交接包仍为草稿态，否则 ValueError（防重发 / 伪造已发交接）；
    - 用 DB 真实快照覆盖客户端传入的 card，丢弃伪造字段（如 goal）。
    失败由上层映射 400 / 403。
    """
    card = metadata.get("card")
    if not isinstance(card, dict) or card.get("type") != _CARD_HANDOFF_TYPE:
        return metadata

    from apps.tabchat.handoff.models import HandoffPackage
    from apps.tabchat.handoff.service import HandoffService

    handoff_id = card.get("handoff_id")
    if not handoff_id:
        raise ValueError("交接卡缺少 handoff_id")
    package = HandoffPackage.objects.filter(pk=handoff_id).first()
    if package is None:
        raise ValueError("交接包不存在")
    is_initiator = (
        (package.initiator_user_id and str(package.initiator_user_id) == str(sender_id))
        or (package.initiator_agent_id and str(package.initiator_agent_id) == str(sender_id))
    )
    if not is_initiator:
        raise PermissionError("只有发起人可以发送该交接卡片")
    if package.status != HandoffPackage.Status.DRAFT:
        raise ValueError("交接包已发送，不能重复发送卡片")
    return {**metadata, "card": HandoffService._build_card_snapshot(package)}

# 会话标题栏历史聚合筛选。message 表示完整消息流；document/file 为聚合视图。
_HISTORY_CONTENT_FILTERS = {"message", "document", "file"}


def _apply_history_content_filter(qs, content_filter: str | None):
    normalized = content_filter.strip().lower() if isinstance(content_filter, str) else content_filter
    if normalized in (None, "", "message"):
        return qs
    if normalized not in _HISTORY_CONTENT_FILTERS:
        raise ValueError("不支持的历史内容类型")
    if normalized == "document":
        return qs.filter(
            is_deleted=False,
            message_type=MessageType.TEXT,
            metadata__card__type__in=("document", "table"),
        )
    if normalized == "file":
        return qs.filter(
            is_deleted=False,
            message_type__in=(MessageType.FILE, MessageType.IMAGE),
        )
    return qs


def _validate_contact_card(metadata: dict, card: dict, conv_organization_id: str) -> dict:
    """校验名片卡并以 DB 真实身份回填。

    名片把某个 organization 成员作为消息发出。校验目标用户存在且确为会话所属 organization
    成员（含 owner），回填真实 `name`/`avatar`/`username`，覆盖客户端传值防伪造。
    失败抛 ValueError（缺字段/用户不存在）或 PermissionError（非本团队成员）。
    """
    from uuid import UUID
    from django.contrib.auth import get_user_model

    from apps.tabchat.utils import is_organization_member

    target_user_id = card.get("user_id")
    if not target_user_id:
        raise ValueError("名片缺少 user_id")
    try:
        UUID(str(target_user_id))
    except (ValueError, TypeError):
        raise ValueError("user_id 不是合法 UUID")

    User = get_user_model()
    target = (
        User.objects.filter(id=target_user_id)
        .values("id", "nickname", "username", "avatar")
        .first()
    )
    if not target:
        raise ValueError("名片用户不存在")

    if not is_organization_member(str(conv_organization_id), str(target_user_id)):
        raise PermissionError("名片用户不属于当前会话组织")

    resolved_name = target.get("nickname") or target.get("username") or "用户"
    new_card = {
        **card,
        "type": _CARD_CONTACT_TYPE,
        "user_id": str(target_user_id),
        "name": resolved_name,
        "username": target.get("username") or "",
        "avatar": target.get("avatar") or "",
    }
    return {**metadata, "card": new_card}


def _validate_prompt_card(metadata: dict, card: dict) -> dict:
    """校验指令卡并白名单重建，防夹带未知字段。

    指令卡自包含 prompt 正文，不指向任何后端资源，因此只做输入治理：
    - ``prompt_text`` 必填（str，strip 后 1..8000 字符）；
    - ``title`` 可选（≤200 字符）；
    - ``prompt_version`` 服务端强制为 1，忽略客户端传值；
    - 卡片按白名单重建，其余未知字段一律丢弃（防夹带脏数据进库）。
    失败抛 ValueError，由 api 层映射 400。
    """
    prompt_text = card.get("prompt_text")
    if not isinstance(prompt_text, str) or not prompt_text.strip():
        raise ValueError("指令卡缺少 prompt_text")
    prompt_text = prompt_text.strip()
    if len(prompt_text) > PROMPT_CARD_TEXT_MAX_LEN:
        raise ValueError(f"指令内容过长（上限 {PROMPT_CARD_TEXT_MAX_LEN} 字符）")

    title = card.get("title")
    if title is None:
        title = ""
    if not isinstance(title, str):
        raise ValueError("指令卡 title 必须是字符串")
    title = title.strip()
    if len(title) > PROMPT_CARD_TITLE_MAX_LEN:
        raise ValueError(f"指令标题过长（上限 {PROMPT_CARD_TITLE_MAX_LEN} 字符）")

    new_card = {
        "type": _CARD_PROMPT_TYPE,
        "prompt_text": prompt_text,
        "prompt_version": 1,
    }
    if title:
        new_card["title"] = title
    return {**metadata, "card": new_card}


def _validate_session_share_card(metadata: dict, card: dict, sender_id: str) -> dict:
    """校验任务共享卡并以共享行真实值权威回填，防伪造。

    任务共享卡是会话共享授权（chat.conversation SessionShare）的展示面，
    对齐 `_validate_handoff_card` 用 DB 快照覆盖客户端字段的做法：
    - ``share_id`` 必填，指向的共享行必须存在且发送者可见；
    - **发送者必须是 share 的 owner**（grantee 转发场景本期不放开，
      非 owner 一律拒绝发卡）；
    - 用 ``serialize_share`` 的真实值覆盖 ``session_id`` / ``session_title`` /
      ``can_fork`` / ``can_chat`` / ``status``，卡片按白名单重建，丢弃客户端
      传的同名字段与未知字段。
    失败抛 ValueError（缺 share_id）或 PermissionError（不存在/无权/非 owner），
    由 api 层映射 400 / 403。
    """
    from django.contrib.auth import get_user_model

    from apps.chat.conversation.services import session_share_service

    share_id = card.get("share_id")
    if not share_id:
        raise ValueError("任务共享卡缺少 share_id")

    User = get_user_model()
    sender = User.objects.filter(id=sender_id).first()
    if sender is None:
        raise PermissionError("发送者不存在")

    # 不存在 / 非 owner 非 grantee → SessionShareAccessError（PermissionError 子类）
    share = session_share_service.get_share_for_user(share_id=share_id, user=sender)
    if share.owner_user_id != str(sender_id):
        raise PermissionError("只有共享发起人可以发送该任务共享卡")

    snapshot = session_share_service.serialize_share(share)
    new_card = {
        "type": _CARD_SESSION_SHARE_TYPE,
        "share_id": snapshot["id"],
        "session_id": snapshot["session_id"],
        "session_title": snapshot["session_title"],
        "can_fork": snapshot["can_fork"],
        "can_chat": snapshot["can_chat"],
        "status": snapshot["status"],
    }
    return {**metadata, "card": new_card}


def _validate_session_share_v2_card(metadata: dict, card: dict, sender_id: str) -> dict:
    """校验 v2 任务共享卡，只保留稳定对象引用。"""
    from django.contrib.auth import get_user_model

    from apps.chat.conversation.services import session_share_service

    object_id = card.get("object_id")
    if not object_id:
        raise ValueError("任务共享卡缺少 object_id")

    User = get_user_model()
    sender = User.objects.filter(id=sender_id).first()
    if sender is None:
        raise PermissionError("发送者不存在")

    share = session_share_service.get_share_for_user(share_id=object_id, user=sender)
    if share.owner_user_id != str(sender_id):
        raise PermissionError("只有共享发起人可以发送该任务共享卡")

    title = (share.session.title or "").strip() or "未命名任务"
    new_card = {
        "type": _CARD_SESSION_SHARE_V2_TYPE,
        "schema_version": int(getattr(share, "card_schema_version", 1) or 1),
        "object_id": str(share.id),
        "version": int(getattr(share, "version", 1) or 1),
        "title_snapshot": title,
        "sender_id": str(share.owner_user_id),
        "recipient_id": str(share.grantee_user_id),
    }
    return {**metadata, "card": new_card}


def _validate_session_continuation_card(
    metadata: dict,
    card: dict,
    sender_id: str,
    conv_organization_id: str,
    conversation_id: str | None,
) -> dict:
    """校验任务续接卡，并用冻结包重建不可伪造的对象引用。"""
    from apps.chat.conversation.models import SessionContinuation

    object_id = card.get("object_id")
    if not object_id:
        raise ValueError("任务续接卡缺少 object_id")
    continuation = SessionContinuation.objects.filter(id=object_id).first()
    if continuation is None:
        raise ValueError("任务续接卡不存在")
    if continuation.sender_user_id != str(sender_id):
        raise PermissionError("只有续接发起人可以发送该任务续接卡")
    if continuation.organization_id != str(conv_organization_id):
        raise PermissionError("任务续接卡不属于当前会话组织")
    expected_dm_hash = Conversation.compute_dm_hash(
        str(sender_id),
        str(continuation.recipient_user_id),
    )
    if not conversation_id or not Conversation.objects.filter(
        id=conversation_id,
        organization_id=str(conv_organization_id),
        type=ConversationType.DM,
        dm_hash=expected_dm_hash,
    ).exists():
        raise PermissionError("任务续接卡只能发送到指定接收人的私聊")
    return {
        **metadata,
        "card": {
            "type": _CARD_SESSION_CONTINUATION_TYPE,
            "schema_version": 1,
            "object_id": str(continuation.id),
            "version": int(continuation.version),
            "title_snapshot": continuation.title_snapshot or "未命名任务",
            "sender_id": continuation.sender_user_id,
            "recipient_id": continuation.recipient_user_id,
        },
    }


def _validate_codex_session_card(metadata: dict, card: dict) -> dict:
    """严格重建已知 v1；未知或损坏版本原样保留给客户端安全降级。"""
    schema_version = card.get("schema_version")
    if type(schema_version) is not int or schema_version != 1:
        return metadata

    session_id = card.get("codex_session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        return metadata
    session_id = session_id.strip()
    if len(session_id) > CODEX_SESSION_ID_MAX_LEN:
        return metadata

    session_name = card.get("codex_session_name")
    if not isinstance(session_name, str) or not session_name.strip():
        return metadata
    session_name = session_name.strip()
    if len(session_name) > CODEX_SESSION_NAME_MAX_LEN:
        return metadata

    working_directory = card.get("suggested_working_directory")
    if working_directory is None:
        working_directory = ""
    if not isinstance(working_directory, str):
        working_directory = ""
    working_directory = working_directory.strip()[:CODEX_WORKING_DIRECTORY_MAX_LEN]

    normalized_card = {
        "type": _CARD_CODEX_SESSION_TYPE,
        "schema_version": 1,
        "codex_session_id": session_id,
        "codex_session_name": session_name,
    }
    if working_directory:
        normalized_card["suggested_working_directory"] = working_directory
    return {**metadata, "card": normalized_card}


def _validate_card_metadata(
    metadata: dict,
    sender_id: str,
    conv_organization_id: str,
    conversation_id: str | None = None,
) -> dict:
    """校验卡片消息 metadata 并以 DB 真实值回填。

    处理资源、名片、指令、任务共享与 Codex 会话卡；
    现有 space/agent_space 卡不在此校验范围。
    - 资源卡（table/document）：① 资源存在且未在回收站 ② 发送者对资源有 viewer+
      权限（不能分享自己都看不到的）。回填 `name`/`space_id`/`organization_id`/
      `hint_carrier_app_id`，防止客户端伪造标题。**不**校验资源/会话 organization 一致
      （TC-23：卡片是指针，跨团队分享允许，访问控制收口到接收方点开时）。
    - 名片卡（contact）：① 目标用户存在 ② 目标用户是会话所属 organization 成员（杜绝把
      外团队的人甩进来）。回填 `name`/`avatar`/`username`，防伪造身份。
    - 指令卡（prompt）：自包含正文，只做限长 + 白名单裁剪（见 `_validate_prompt_card`）。
    - 任务共享卡（session_share / session_share_v2）：仅 share owner 可发，
      正文以共享行回填（见 `_validate_session_share_card`）。
    失败抛 ValueError（不存在/非法）或 PermissionError（越权/跨团队），由 api 层映射
    400 / 403。返回回填后的新 metadata（不就地改）。
    """
    from uuid import UUID
    from django.contrib.auth import get_user_model

    card = metadata.get("card")
    if not isinstance(card, dict) or card.get("type") not in _CARD_VALIDATED_TYPES:
        return metadata

    if card.get("type") == _CARD_PROMPT_TYPE:
        return _validate_prompt_card(metadata, card)

    if card.get("type") == _CARD_SESSION_SHARE_TYPE:
        return _validate_session_share_card(metadata, card, sender_id)

    if card.get("type") == _CARD_SESSION_SHARE_V2_TYPE:
        return _validate_session_share_v2_card(metadata, card, sender_id)

    if card.get("type") == _CARD_SESSION_CONTINUATION_TYPE:
        return _validate_session_continuation_card(
            metadata,
            card,
            sender_id,
            conv_organization_id,
            conversation_id,
        )

    if card.get("type") == _CARD_CODEX_SESSION_TYPE:
        return _validate_codex_session_card(metadata, card)

    if card.get("type") == _CARD_CONTACT_TYPE:
        return _validate_contact_card(metadata, card, conv_organization_id)

    card_type = card["type"]
    resource_id = card.get("resource_id")
    if not resource_id:
        raise ValueError("资源卡缺少 resource_id")
    try:
        UUID(str(resource_id))
    except (ValueError, TypeError):
        raise ValueError("resource_id 不是合法 UUID")

    User = get_user_model()
    sender = User.objects.filter(id=sender_id).first()
    if not sender:
        raise PermissionError("发送者不存在")

    # TC-23：不再在发送时强制「资源 organization == 会话 organization」。
    # 发送侧校验「发送者本人对资源有 viewer+ 权限」（不能分享自己都看不到的东西）
    # 并以 DB 真实值回填 name/space_id/organization_id。
    # /#7987：落库后仅 DM 静默补对方 viewer；GROUP 不授权（指针语义）。
    resource, resolved_space_id, resolved_organization_id, resolved_name = _load_card_resource(
        card_type, resource_id, sender,
    )
    resolved_description = _resolve_resource_card_description(resource, card_type)
    resolved_preview_table = (
        _build_table_card_preview_snapshot(resource) if card_type == "table" else None
    )

    new_card = {
        **card,
        "type": card_type,
        "resource_id": str(resource_id),
        "space_id": resolved_space_id,
        "organization_id": resolved_organization_id,
        "name": resolved_name,
        "description": resolved_description,
        "hint_carrier_app_id": _CARD_HINT_BY_TYPE[card_type],
    }
    if resolved_preview_table:
        new_card["preview_table"] = resolved_preview_table
    return {**metadata, "card": new_card}


def _resource_card_recipient_user_ids(conv: Conversation, sender_id: str) -> list[str]:
    """真人收件人列表；供 DM 资源卡静默补 viewer 时枚举对端用户。"""
    sender = str(sender_id)
    return sorted(
        {
            str(user_id)
            for user_id in ConversationAccessResolver.human_user_ids(conv)
            if str(user_id) != sender
        }
    )


def grant_resource_viewer_access_to_users(
    *,
    resource_type: str,
    resource_id: str,
    recipient_ids: list[str],
    granted_by: str,
    session_share=None,
) -> list[dict]:
    """把指定文档/表格资源静默授权给一组真人用户。

    供 handoff / session share 等交接链路复用：把关键产出物授权给接收者。

    普通 IM 资源卡必须按发送者是否具备协作者管理权决定是否授权，并且
    inactive 历史权限重新发送时统一恢复为 viewer，因此由
    ``_grant_resource_card_viewer_access`` 走正式 Share Service，不复用本 helper。

    ：create / 重新激活权限时发 ``resource_shared(invited)``，
    避免客户端被历史 removed 通知粘住「你已被移出」遮罩。
    """
    normalized_recipient_ids = sorted({str(user_id) for user_id in recipient_ids if user_id})
    if resource_type not in _CARD_RESOURCE_TYPES or not normalized_recipient_ids:
        return []

    changes: list[dict] = []

    if resource_type == "table":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table, TablePermission

        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=resource_id).first()
        if not table:
            return []
        try:
            for user_id in normalized_recipient_ids:
                change = _upsert_resource_permission(
                    TablePermission,
                    "table",
                    table,
                    user_id,
                    str(granted_by),
                )
                if change:
                    changes.append(change)
        except Exception:
            rollback_resource_permission_changes(changes)
            raise
        _notify_im_viewer_grant_changes(
            resource_kind="table",
            resource=table,
            granted_by=str(granted_by),
            changes=changes,
        )
        if session_share is None:
            from apps.chat.conversation.services.session_share_resource_permission_service import (
                mark_resource_access_independently_granted,
            )

            mark_resource_access_independently_granted(
                resource_type="table",
                resource_id=str(table.id),
                user_ids=normalized_recipient_ids,
                permission="viewer",
            )
        return changes

    from apps.tabdoc.models import Document, DocumentPermission

    document = Document.objects.using(postgres_app_db_alias()).filter(id=resource_id).first()
    if not document:
        return []
    try:
        for user_id in normalized_recipient_ids:
            change = _upsert_resource_permission(
                DocumentPermission,
                "document",
                document,
                user_id,
                str(granted_by),
            )
            if change:
                changes.append(change)
    except Exception:
        rollback_resource_permission_changes(changes)
        raise
    _notify_im_viewer_grant_changes(
        resource_kind="document",
        resource=document,
        granted_by=str(granted_by),
        changes=changes,
    )
    if session_share is None:
        from apps.chat.conversation.services.session_share_resource_permission_service import (
            mark_resource_access_independently_granted,
        )

        mark_resource_access_independently_granted(
            resource_type="document",
            resource_id=str(document.id),
            user_ids=normalized_recipient_ids,
            permission="viewer",
        )
    return changes


def _im_grant_should_notify(change: dict) -> bool:
    """新建或从失活重新激活时需要发 invited 补偿通知。"""
    return bool(change.get("created")) or change.get("previous_is_active") is False


def _schedule_im_viewer_invited_notify(
    *,
    resource_kind: str,
    resource,
    user_id: str,
    granted_by: str,
    permission_to: str,
) -> None:
    """事务提交后发 resource_shared(invited)；失败不阻断发卡。"""
    from django.contrib.auth import get_user_model

    User = get_user_model()
    inviter = User.objects.filter(id=granted_by).first()
    if inviter is None:
        inviter = type("InviterStub", (), {"id": granted_by})()

    try:
        if resource_kind == "table":
            from apps.tabdata.services.share_service import (
                _build_metadata,
                _schedule_notify,
            )
        else:
            from apps.tabdoc.services.share_service import (
                _build_metadata,
                _schedule_notify,
            )

        metadata = _build_metadata(
            resource,
            "invited",
            inviter,
            permission_from=None,
            permission_to=permission_to or "viewer",
        )
        _schedule_notify(str(user_id), "invited", metadata)
    except Exception:
        logger.warning(
            "[MessageService]  IM grant invited notify failed kind=%s resource=%s user=%s",
            resource_kind,
            getattr(resource, "id", None),
            user_id,
            exc_info=True,
        )


def _notify_im_viewer_grant_changes(
    *,
    resource_kind: str,
    resource,
    granted_by: str,
    changes: list[dict],
) -> None:
    """对 create / 重新激活的收件人发 invited，并推 access_granted 可见性事件。"""
    notify_targets = [c for c in changes if _im_grant_should_notify(c)]
    if not notify_targets:
        return

    newly_granted: list[str] = []
    for change in notify_targets:
        subject_id = str(change.get("subject_id") or "")
        if not subject_id:
            continue
        newly_granted.append(subject_id)
        _schedule_im_viewer_invited_notify(
            resource_kind=resource_kind,
            resource=resource,
            user_id=subject_id,
            granted_by=granted_by,
            permission_to=str(change.get("permission_to") or "viewer"),
        )

    if not newly_granted:
        return

    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_granted,
        )

        if resource_kind == "table":
            notify_cloud_resource_access_granted(
                resource_type="tabdata",
                resource_id=str(resource.id),
                organization_id=(
                    str(resource.organization_id) if getattr(resource, "organization_id", None) else None
                ),
                user_ids=newly_granted,
                actor_user_id=granted_by,
                title=getattr(resource, "name", None),
                space_id=str(resource.space_id) if getattr(resource, "space_id", None) else None,
            )
        else:
            notify_cloud_resource_access_granted(
                resource_type="tabdoc",
                resource_id=str(resource.id),
                organization_id=(
                    str(resource.organization_id) if getattr(resource, "organization_id", None) else None
                ),
                user_ids=newly_granted,
                actor_user_id=granted_by,
                title=getattr(resource, "title", None),
                space_id=str(resource.space_id) if getattr(resource, "space_id", None) else None,
            )
    except Exception:
        logger.warning(
            "[MessageService]  IM grant access_granted publish failed kind=%s resource=%s",
            resource_kind,
            getattr(resource, "id", None),
            exc_info=True,
        )


def _upsert_resource_permission(permission_model, resource_field: str, resource, user_id: str, granted_by: str) -> dict | None:
    alias = postgres_app_db_alias()
    existing = (
        permission_model.objects.using(alias)
        .filter(**{
            resource_field: resource,
            "subject_type": "user",
            "subject_id": user_id,
        })
        .order_by("-is_active", "-updated_at")
        .first()
    )
    if existing:
        changed_fields: list[str] = []
        previous_permission = existing.permission
        previous_is_active = existing.is_active
        if not existing.is_active:
            existing.is_active = True
            changed_fields.append("is_active")
            # 重新激活旧权限时保留原有 editor/admin/owner 强度，只在异常值时兜底成 viewer。
            if existing.permission not in ("viewer", "editor", "admin", "owner"):
                existing.permission = "viewer"
                changed_fields.append("permission")
        # IM 分享只保证可读，不降低已有 editor/admin/owner 权限。
        elif existing.permission not in ("viewer", "editor", "admin", "owner"):
            existing.permission = "viewer"
            changed_fields.append("permission")
        if changed_fields:
            changed_fields.append("updated_at")
            existing.save(using=alias, update_fields=changed_fields)
            return {
                "permission_model": permission_model,
                "permission_id": existing.pk,
                "created": False,
                "previous_permission": previous_permission,
                "previous_is_active": previous_is_active,
                "subject_id": str(user_id),
                "permission_to": existing.permission,
            }
        return None

    create_kwargs = {
        resource_field: resource,
        "subject_type": "user",
        "subject_id": user_id,
        "permission": "viewer",
        "is_active": True,
        "granted_by": granted_by,
    }
    if hasattr(permission_model, "created_by_id"):
        create_kwargs["created_by_id"] = granted_by
    try:
        with transaction.atomic(using=alias):
            created = permission_model.objects.using(alias).create(**create_kwargs)
        return {
            "permission_model": permission_model,
            "permission_id": created.pk,
            "created": True,
            "subject_id": str(user_id),
            "permission_to": "viewer",
        }
    except IntegrityError:
        # 并发分享同一资源给同一用户时，另一事务可能已插入权限；重读并按同一规则收敛。
        return _upsert_resource_permission(permission_model, resource_field, resource, user_id, granted_by)


def rollback_resource_permission_changes(changes: list[dict]) -> None:
    if not changes:
        return
    alias = postgres_app_db_alias()
    for change in reversed(changes):
        permission_model = change["permission_model"]
        permission = permission_model.objects.using(alias).filter(pk=change["permission_id"]).first()
        if permission is None:
            continue
        if change.get("created"):
            permission.delete(using=alias)
            continue
        permission.permission = change["previous_permission"]
        permission.is_active = change["previous_is_active"]
        permission.save(using=alias, update_fields=["permission", "is_active", "updated_at"])


def _soft_delete_message(
    msg: Message,
    *,
    actor_id: str,
    clear_client_request_id: bool = False,
) -> bool:
    if msg.is_deleted:
        return True

    was_pinned = msg.is_pinned
    with transaction.atomic(using=postgres_app_db_alias()):
        msg.is_deleted = True
        msg.deleted_at = timezone.now()
        update_fields = ["is_deleted", "deleted_at"]
        if clear_client_request_id and msg.client_request_id is not None:
            msg.client_request_id = None
            update_fields.append("client_request_id")
        if was_pinned:
            msg.is_pinned = False
            msg.pinned_at = None
            msg.pinned_by = ""
            update_fields += ["is_pinned", "pinned_at", "pinned_by"]
        msg.save(update_fields=update_fields)

        if msg.has_attachment and msg.metadata:
            _msg = msg
            _uid = actor_id
            transaction.on_commit(
                lambda: _deactivate_message_file_usages(_msg, _uid),
                using=postgres_app_db_alias(),
            )

        latest_preview_changed = False
        conversation_for_preview = None
        try:
            conv = Conversation.objects.select_for_update().get(pk=msg.conversation_id)
            if conv.latest_message_id == msg.id:
                latest_preview_changed = True
                conversation_for_preview = conv
                conv.last_message_preview = "消息已撤回"
                conv.last_message_at = msg.created_at
                conv.latest_message = msg
                conv.save(
                    update_fields=[
                        "latest_message",
                        "last_message_preview",
                        "last_message_at",
                        "updated_at",
                    ]
                )
        except Conversation.DoesNotExist:
            pass

        domain_event_id = uuid.uuid4()
        IMOutboxService.enqueue(
            organization_id=str(msg.conversation.organization_id),
            event_type=IMEventType.MESSAGE_DELETED,
            target_channels=[f"chat:{msg.conversation_id}"],
            data={
                "message_id": msg.id,
                "conversation_id": str(msg.conversation_id),
                "sender_id": actor_id,
            },
            conversation=msg.conversation,
            message=msg,
            domain_event_id=domain_event_id,
        )

        if latest_preview_changed and conversation_for_preview is not None:
            _enqueue_personal_preview_update(
                conversation=conversation_for_preview,
                message=msg,
                domain_event_id=domain_event_id,
                preview="消息已撤回",
            )

        if was_pinned:
            IMOutboxService.enqueue(
                organization_id=str(msg.conversation.organization_id),
                event_type=IMEventType.MESSAGE_UNPINNED,
                target_channels=[f"chat:{msg.conversation_id}"],
                data={
                    "message_id": msg.id,
                    "conversation_id": str(msg.conversation_id),
                },
                conversation=msg.conversation,
                message=msg,
                domain_event_id=domain_event_id,
            )
    return True


def _grant_resource_card_viewer_access(metadata: dict, conv: Conversation, sender_id: str) -> None:
    """发送 IM 资源卡时，仅由资源管理员在 DM 内授予对方 viewer。

    产品口径：
    - DM + owner/admin：仅从未获得过资源 ACL 的收件人自动授予 viewer；
      已被移除的协作者保留失效 ACL，必须经显式邀请才可恢复访问；
    - DM + 已有 active viewer/editor/admin：保持原权限，不降级；
    - DM + 非管理员：只发送卡片，不修改资源权限；
    - GROUP：卡片是指针，不修改资源权限；无权成员走申请 viewer，不静默 grant。
    """
    if conv.type != ConversationType.DM:
        return

    card = (metadata or {}).get("card")
    if not isinstance(card, dict) or card.get("type") not in _CARD_RESOURCE_TYPES:
        return

    recipient_ids = _resource_card_recipient_user_ids(conv, sender_id)
    if not recipient_ids:
        return

    sender = User.objects.filter(id=sender_id).first()
    if sender is None:
        return

    resource_type = str(card.get("type") or "")
    resource_id = str(card.get("resource_id") or "")
    active_roles = ("viewer", "editor", "admin", "owner")

    if resource_type == "document":
        from apps.tabdoc.models import Document, DocumentPermission
        from apps.tabdoc.services.document_service import DocumentService
        from apps.tabdoc.services.share_service import invite_collaborators

        document = Document.objects.filter(id=resource_id).first()
        if (
            document is None
            or not DocumentService(user=sender).check_document_permission(
                document,
                required_role="admin",
            )
        ):
            return

        active_user_ids = {
            str(user_id)
            for user_id in DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id__in=recipient_ids,
                is_active=True,
                permission__in=active_roles,
            ).values_list("subject_id", flat=True)
        }
        removed_user_ids = {
            str(user_id)
            for user_id in DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id__in=recipient_ids,
                is_active=False,
            ).values_list("subject_id", flat=True)
        }
        targets = [
            user_id
            for user_id in recipient_ids
            if user_id not in active_user_ids and user_id not in removed_user_ids
        ]
        if targets:
            invite_collaborators(
                document.id,
                targets,
                "viewer",
                sender,
                reactivate_inactive=False,
            )
        return

    if resource_type == "table":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table, TablePermission
        from apps.tabdata.services.base import BaseService
        from apps.tabdata.services.share_service import invite_collaborators

        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=resource_id).first()
        if (
            table is None
            or not BaseService(user=sender).check_table_permission(
                str(table.id),
                required_role="admin",
            )
        ):
            return

        active_user_ids = {
            str(user_id)
            for user_id in TablePermission.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table=table,
                subject_type="user",
                subject_id__in=recipient_ids,
                is_active=True,
                permission__in=active_roles,
            )
            .values_list("subject_id", flat=True)
        }
        removed_user_ids = {
            str(user_id)
            for user_id in TablePermission.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table=table,
                subject_type="user",
                subject_id__in=recipient_ids,
                is_active=False,
            )
            .values_list("subject_id", flat=True)
        }
        targets = [
            user_id
            for user_id in recipient_ids
            if user_id not in active_user_ids and user_id not in removed_user_ids
        ]
        if targets:
            invite_collaborators(
                table.id,
                targets,
                "viewer",
                sender,
                reactivate_inactive=False,
            )


class MessageService:
    """消息服务。

    TCHAT-3 架构约束: TabChat 采用软删除（is_deleted=True），Django pre_delete signal
    不会触发。所有涉及 FileUsage 释放的路径必须在 service 层显式调用
    _deactivate_message_file_usages，不能依赖 Django 信号机制。
    任何新增的删除/清理路径都必须遵守此约定。
    """

    @staticmethod
    def get_visible_conversation_summaries(
        user_id: str,
        conversation_ids: list[str],
    ) -> dict[str, dict[str, Any]]:
        """返回各会话对指定用户可见的最后一条消息摘要。"""
        if not conversation_ids:
            return {}
        visible_messages = apply_user_message_visibility(
            Message.objects.filter(conversation_id__in=conversation_ids),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=conversation_ids,
        )
        latest_messages = list(
            visible_messages.annotate(
                _conversation_rank=Window(
                    expression=RowNumber(),
                    partition_by=[F("conversation_id")],
                    order_by=F("seq").desc(),
                ),
            ).filter(_conversation_rank=1)
        )
        sender_user_ids = {
            message.sender_id
            for message in latest_messages
            if message.sender_type == SenderType.USER and message.sender_id
        }
        sender_names = {
            str(user["id"]): user["nickname"] or user["username"] or ""
            for user in User.objects.filter(id__in=sender_user_ids).values(
                "id",
                "nickname",
                "username",
            )
        }
        return {
            str(message.conversation_id): {
                "last_message_id": message.id,
                "last_message_seq": message.seq,
                "last_message_at": message.created_at,
                "last_message_preview": (
                    "消息已撤回"
                    if message.is_deleted
                    else _build_preview(
                        message.message_type,
                        message.content,
                        message.metadata,
                        conv_type=ConversationType.GROUP,
                        sender_name=sender_names.get(str(message.sender_id), ""),
                    )
                ),
            }
            for message in latest_messages
        }

    @staticmethod
    def delete_message(conversation_id: str, message_id: int, user_id: str) -> bool:
        """撤回消息（软删除）。

        限制：仅发送者可操作，且需在发送后 2 分钟内。
        撤回后通过 Centrifugo 广播通知所有会话成员，
        并在被撤回消息是最新消息时更新会话 last_message_preview。
        """
        try:
            msg = Message.objects.get(pk=message_id, conversation_id=conversation_id)
        except Message.DoesNotExist:
            return False

        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_send:
            raise PermissionError("无权访问该组织")

        if msg.sender_id != user_id:
            raise PermissionError("只能撤回自己发送的消息")

        if msg.is_deleted:
            return True

        elapsed = (timezone.now() - msg.created_at).total_seconds()
        if elapsed > RECALL_TIMEOUT_SECONDS:
            raise ValueError("超过撤回时限（2分钟）")

        return _soft_delete_message(msg, actor_id=str(user_id))

    @staticmethod
    def _require_pin_permission(conversation_id: str, user_id: str) -> Conversation:
        """置顶/取消置顶权限校验：群聊仅 admin+，私聊任意成员。返回会话。"""
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            raise ValueError("会话不存在")
        access = ConversationAccessResolver.resolve(conv, user_id)
        if not access.can_view:
            raise PermissionError("不是该会话的成员")
        if conv.type == ConversationType.GROUP:
            if not access.can_manage:
                raise PermissionError("只有群主或管理员可以置顶消息")
        return conv

    @staticmethod
    def pin_message(conversation_id: str, message_id: int, user_id: str) -> dict[str, Any]:
        """置顶一条消息（会话级共享）。返回置顶后的序列化消息。"""
        conv = MessageService._require_pin_permission(conversation_id, user_id)
        try:
            msg = Message.objects.get(pk=message_id, conversation_id=conversation_id)
        except Message.DoesNotExist:
            raise ValueError("消息不存在")
        if msg.is_deleted:
            raise ValueError("已撤回的消息无法置顶")
        if msg.message_type == MessageType.SYSTEM:
            raise ValueError("系统消息无法置顶")
        if not apply_user_message_visibility(
            Message.objects.filter(pk=msg.pk),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")

        with transaction.atomic(using=postgres_app_db_alias()):
            if not msg.is_pinned:
                msg.is_pinned = True
                msg.pinned_at = timezone.now()
                msg.pinned_by = user_id
                msg.save(update_fields=["is_pinned", "pinned_at", "pinned_by"])

            payload = MessageService._serialize_pinned(msg, conv)
            IMOutboxService.enqueue(
                organization_id=str(conv.organization_id),
                event_type=IMEventType.MESSAGE_PINNED,
                target_channels=[f"chat:{conversation_id}"],
                data=payload,
                conversation=conv,
                message=msg,
            )
        return payload

    @staticmethod
    def unpin_message(conversation_id: str, message_id: int, user_id: str) -> bool:
        """取消置顶。"""
        MessageService._require_pin_permission(conversation_id, user_id)
        try:
            msg = Message.objects.get(pk=message_id, conversation_id=conversation_id)
        except Message.DoesNotExist:
            raise ValueError("消息不存在")
        if not apply_user_message_visibility(
            Message.objects.filter(pk=msg.pk),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")
        with transaction.atomic(using=postgres_app_db_alias()):
            if msg.is_pinned:
                msg.is_pinned = False
                msg.pinned_at = None
                msg.pinned_by = ""
                msg.save(update_fields=["is_pinned", "pinned_at", "pinned_by"])

            IMOutboxService.enqueue(
                organization_id=str(msg.conversation.organization_id),
                event_type=IMEventType.MESSAGE_UNPINNED,
                target_channels=[f"chat:{conversation_id}"],
                data={
                    "message_id": message_id,
                    "conversation_id": conversation_id,
                },
                conversation=msg.conversation,
                message=msg,
            )
        return True

    @staticmethod
    def list_pinned_messages(conversation_id: str, user_id: str) -> list[dict[str, Any]]:
        """列出会话内的置顶消息（最近置顶在前）。"""
        if not is_conversation_user_active(conversation_id, user_id):
            raise PermissionError("不是该会话的成员")
        conv = Conversation.objects.filter(pk=conversation_id).first()
        if not conv:
            raise ValueError("会话不存在")
        pinned_queryset = apply_user_message_visibility(
            Message.objects.filter(
                conversation_id=conversation_id, is_pinned=True, is_deleted=False
            ),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        )
        pinned = list(
            pinned_queryset.order_by("-pinned_at", "-id")[:100]
        )
        return [MessageService._serialize_pinned(m, conv) for m in pinned]

    @staticmethod
    def _serialize_pinned(msg: Message, conv: Conversation) -> dict[str, Any]:
        """置顶条/事件用的消息序列化（含发送者显示名）。"""
        sender_name = ""
        if (getattr(msg, "sender_type", SenderType.USER) or SenderType.USER) == SenderType.AGENT:
            from apps.tabtinspace.models import Agent
            agent = Agent.objects.filter(id=msg.sender_id).values("name").first()
            sender_name = (agent or {}).get("name") or ""
        else:
            su = User.objects.filter(id=msg.sender_id).values("nickname", "username").first()
            if su:
                sender_name = su.get("nickname") or su.get("username") or ""
        return _serialize_message(msg, sender_name=sender_name)

    @staticmethod
    def edit_message(
        conversation_id: str,
        message_id: int,
        user_id: str,
        content: str,
        metadata: dict | None = None,
    ) -> dict[str, Any]:
        """编辑一条已发送的文本消息（仅本人、无时限，打「已编辑」标记）。

        仅支持纯文本消息（非文件/图片/卡片/系统消息）。重新校验 @ 提及，
        但不重新发送提及通知、不触发 @AI。返回编辑后的序列化消息。
        """
        content = content or ""
        if not content.strip():
            raise ValueError("消息内容不能为空")
        if len(content) > MAX_CONTENT_LENGTH:
            raise ValueError(f"消息内容过长（上限 {MAX_CONTENT_LENGTH} 字符）")
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_send:
            raise PermissionError("无权访问该组织")
        try:
            msg = Message.objects.get(pk=message_id, conversation_id=conversation_id)
        except Message.DoesNotExist:
            raise ValueError("消息不存在")
        if msg.is_deleted:
            raise ValueError("已撤回的消息无法编辑")
        if msg.sender_id != user_id or (getattr(msg, "sender_type", SenderType.USER) or SenderType.USER) != SenderType.USER:
            raise PermissionError("只能编辑自己发送的消息")
        if msg.message_type != MessageType.TEXT:
            raise ValueError("只能编辑文本消息")
        if isinstance(msg.metadata, dict) and msg.metadata.get("card"):
            raise ValueError("卡片消息无法编辑")

        # 重新校验 @ 提及（仅保留仍在会话内的人类成员），保留其它已有 metadata 字段。
        new_meta = dict(msg.metadata or {})
        if metadata is not None and "mentioned_user_ids" in metadata:
            member_ids = set(
                ConversationAccessResolver.human_user_ids(conversation)
            )
            raw = metadata.get("mentioned_user_ids") or []
            valid = sorted({str(uid) for uid in raw if str(uid) in member_ids})
            if valid:
                new_meta["mentioned_user_ids"] = valid
            else:
                new_meta.pop("mentioned_user_ids", None)
        mention_all = msg.mention_all
        if metadata is not None and "mention_all" in metadata:
            mention_all = bool(metadata.get("mention_all"))
            new_meta["mention_all"] = mention_all

        with transaction.atomic(using=postgres_app_db_alias()):
            msg.content = content
            msg.metadata = new_meta
            msg.mention_all = mention_all
            msg.edited_at = timezone.now()
            # TC-36：编辑后重算 search_text
            msg.search_text = _compute_search_text(content, new_meta)
            msg.save(
                update_fields=[
                    "content",
                    "metadata",
                    "mention_all",
                    "edited_at",
                    "search_text",
                ]
            )

            if metadata is not None and "mentioned_user_ids" in metadata:
                MessageMention.objects.filter(
                    message=msg,
                    user_id__isnull=False,
                ).delete()
                MessageMention.objects.bulk_create(
                    [
                        MessageMention(
                            message=msg,
                            conversation=conversation,
                            user_id=mentioned_user_id,
                            mention_type=MessageMention.MentionType.USER,
                        )
                        for mentioned_user_id in new_meta.get("mentioned_user_ids", [])
                    ]
                )

            # TC-36：重算 tsvector（仅 PG）
            try:
                from django.db import connections
                if connections[postgres_app_db_alias()].vendor == 'postgresql':
                    from django.contrib.postgres.search import SearchVector
                    Message.objects.filter(pk=msg.pk).update(
                        search_tsvector=SearchVector("search_text", config="simple")
                    )
            except Exception:
                pass

            # 若编辑的是会话当前最新消息，刷新会话 preview。
            updated_preview = None
            conversation_for_preview = None
            try:
                conv = Conversation.objects.select_for_update().get(pk=conversation_id)
                if conv.latest_message_id == msg.id:
                    sender_name = ""
                    if conv.type == ConversationType.GROUP:
                        su = User.objects.filter(id=user_id).values("nickname", "username").first()
                        if su:
                            sender_name = su.get("nickname") or su.get("username") or ""
                    updated_preview = _build_preview(
                        msg.message_type, content, new_meta,
                        conv_type=conv.type, sender_name=sender_name,
                    )
                    conv.last_message_preview = updated_preview
                    conv.save(update_fields=["last_message_preview", "updated_at"])
                    conversation_for_preview = conv
            except Conversation.DoesNotExist:
                pass

            payload = _serialize_message(msg, sender_name=MessageService._resolve_user_sender_name(user_id))
            IMOutboxService.enqueue(
                organization_id=str(msg.conversation.organization_id),
                event_type=IMEventType.MESSAGE_EDITED,
                target_channels=[f"chat:{conversation_id}"],
                data=payload,
                conversation=msg.conversation,
                message=msg,
            )
            if updated_preview is not None and conversation_for_preview is not None:
                _enqueue_personal_preview_update(
                    conversation=conversation_for_preview,
                    message=msg,
                    domain_event_id=uuid.uuid4(),
                    preview=updated_preview,
                )

        return payload

    @staticmethod
    def _resolve_user_sender_name(user_id: str) -> str:
        su = User.objects.filter(id=user_id).values("nickname", "username").first()
        if su:
            return su.get("nickname") or su.get("username") or ""
        return ""

    @staticmethod
    def send_message(
        conversation_id: str,
        sender_id: str,
        content: str,
        message_type: int = MessageType.TEXT,
        reply_to_id: int | None = None,
        metadata: dict | None = None,
        sender_type: str = SenderType.USER,
        client_request_id: str | None = None,
        dispatch_legacy_delivery_side_effects: bool = True,
    ) -> Message:
        """发送消息。

        会话行锁内分配 seq、落消息/Mention/Outbox；重复 client_request_id
        直接返回已有 Message，不产生新序号、事件或 Agent 任务。

        ``dispatch_legacy_delivery_side_effects=False`` 仅用于另有权威
        运输的编排链路：保留本地 Message 与搜索/文件索引，跳过
        Centrifugo outbox、未读、Agent 任务、领域事件和铃铛通知。
        """
        is_agent_sender = sender_type == SenderType.AGENT
        is_system_sender = sender_type == "system"
        request_id = (
            str(client_request_id or (metadata or {}).get("client_request_id") or "").strip()
            or None
        )
        if request_id and len(request_id) > 100:
            raise ValueError("client_request_id 过长")

        if message_type not in ALLOWED_SEND_TYPES and not (
            is_system_sender and message_type == MessageType.SYSTEM
        ):
            raise ValueError(f"不允许发送此消息类型: {message_type}")

        raw_metadata = metadata or {}
        has_external_restricted_payload = bool(
            not is_system_sender
            and (
                is_agent_sender
                or message_type != MessageType.TEXT
                or raw_metadata.get("card")
                or raw_metadata.get("mentioned_agent_ids")
            )
        )
        if has_external_restricted_payload and Conversation.objects.filter(
            pk=conversation_id,
            is_external=True,
        ).exists():
            raise ExternalGroupCapabilityError("外部群仅支持普通消息")

        if len(content) > MAX_CONTENT_LENGTH:
            raise ValueError(f"消息内容过长（上限 {MAX_CONTENT_LENGTH} 字符）")

        metadata = _sanitize_attachment_metadata(metadata or {}, message_type)
        _validate_attachment_metadata(metadata, message_type)

        # 卡片消息校验（资源卡 / 名片卡，事务外做，避免持有会话行锁时跨服务查权限）：
        # 需会话 organization 做跨团队校验，轻量预取一次。
        if (
            metadata
            and isinstance(metadata.get("card"), dict)
            and metadata["card"].get("type") in _CARD_VALIDATED_TYPES
        ):
            _conv_wt = (
                Conversation.objects.filter(pk=conversation_id)
                .values_list("organization_id", flat=True)
                .first()
            )
            if _conv_wt is None:
                raise ValueError("会话不存在")
            metadata = _validate_card_metadata(
                metadata,
                sender_id,
                str(_conv_wt),
                str(conversation_id),
            )

        # 交接卡防伪造：正文以 DB 快照为准（事务外做，避免持锁跨服务查）。
        # 转发消息（带 forwarded_from）跳过校验——转发是原样传递，不是发起新交接。
        if (
            metadata
            and isinstance(metadata.get("card"), dict)
            and metadata["card"].get("type") == _CARD_HANDOFF_TYPE
            and not metadata.get("forwarded_from")
        ):
            metadata = _validate_handoff_card(metadata, sender_id)

        # LIKE 搜索依赖的纯文本可在事务外完成；PostgreSQL tsvector 仍在提交后计算，
        # 避免把搜索计算放进持有 Conversation 行锁的主事务。
        initial_search_text = _compute_search_text(content, metadata)

        # 事务外预取：发送者昵称（跨库查询不阻塞 PG 行锁）
        sender_name = ""
        try:
            if is_agent_sender:
                from apps.tabtinspace.models import Agent
                sender_name = (
                    Agent.objects.filter(id=sender_id).values_list("name", flat=True).first() or ""
                )
            else:
                sender_user = User.objects.filter(id=sender_id).values("nickname", "username").first()
                if sender_user:
                    sender_name = sender_user.get("nickname") or sender_user.get("username") or ""
        except Exception:
            pass

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                try:
                    conv = Conversation.objects.select_for_update().get(pk=conversation_id)
                except Conversation.DoesNotExist:
                    raise ValueError("会话不存在")

                if conv.is_external and not is_system_sender:
                    has_rich_payload = bool(
                        message_type != MessageType.TEXT
                        or (metadata or {}).get("card")
                        or (metadata or {}).get("mentioned_agent_ids")
                    )
                    if is_agent_sender or has_rich_payload:
                        raise ExternalGroupCapabilityError("外部群仅支持普通消息")

                access = None
                if is_system_sender:
                    pass
                elif is_agent_sender:
                    if not ConversationAccessResolver.can_agent_send(conv, sender_id):
                        raise PermissionError("不是该会话的成员")
                else:
                    access = ConversationAccessResolver.resolve(conv, sender_id)
                    if not access.can_send:
                        raise PermissionError("不是该会话的成员")

                source_message = _resolve_forwarded_source(metadata, conv, sender_id)
                if message_type in (MessageType.FILE, MessageType.IMAGE):
                    _validate_attachment_file_record(
                        metadata["file_id"],
                        str(conv.organization_id),
                        sender_id,
                        source_message,
                    )

                if request_id:
                    existing = Message.objects.filter(
                        conversation=conv,
                        sender_type=sender_type,
                        sender_id=sender_id,
                        client_request_id=request_id,
                    ).first()
                    if existing is not None:
                        return existing

                if reply_to_id is not None:
                    reply_queryset = Message.objects.filter(
                        id=reply_to_id,
                        conversation=conv,
                    )
                    if conv.is_external and not is_system_sender:
                        reply_queryset = apply_user_message_visibility(
                            reply_queryset,
                            user_id=sender_id,
                            history_cleared_seq=0,
                            conversation_ids=[str(conv.id)],
                        )
                    if not reply_queryset.exists():
                        raise ValueError("被回复消息不存在、不属于当前会话或当前成员不可见")

                member_ids = ConversationAccessResolver.human_user_ids(conv)
                team_space = get_conversation_team_space(conv)
                execution_agent_id = (
                    get_team_space_execution_agent_id(team_space)
                    if team_space is not None
                    else ""
                )
                if team_space is not None:
                    # Team Space 的 Agent 权限以实时 execution binding 为准；
                    # ConversationMember 中的历史物化行不能继续成为 @AI 候选。
                    agent_member_ids = (
                        {execution_agent_id} if execution_agent_id else set()
                    )
                else:
                    agent_member_ids = {
                        str(agent_id)
                        for agent_id in ConversationMember.objects.filter(
                            conversation=conv,
                            agent_id__isnull=False,
                        ).values_list("agent_id", flat=True)
                    }

                raw_mentioned = (metadata or {}).get("mentioned_user_ids") or []
                member_id_set = set(member_ids)
                valid_mentioned_ids = sorted(
                    {
                        str(user_id)
                        for user_id in raw_mentioned
                        if str(user_id) in member_id_set
                    }
                )

                raw_mentioned_agents = (metadata or {}).get("mentioned_agent_ids") or []
                candidate_agent_ids = {
                    str(agent_id)
                    for agent_id in raw_mentioned_agents
                    if str(agent_id) in agent_member_ids
                }
                valid_mentioned_agent_ids: list[str] = []
                if candidate_agent_ids and not is_agent_sender:
                    from apps.tabtinspace.models import Agent

                    # 已进群的 Agent 可被任意群成员 @；执行现场仍落在派驻
                    # Workspace，不要求 @ 的人是 Agent 主人。
                    invocable_agent_ids = {
                        str(agent_id)
                        for agent_id in Agent.objects.filter(
                            id__in=candidate_agent_ids,
                            organization_id=conv.organization_id,
                            type="bot",
                            is_active=True,
                        )
                        .values_list("id", flat=True)
                    }
                    if (
                        access is not None
                        and access.space_membership is not None
                        and execution_agent_id in candidate_agent_ids
                    ):
                        invocable_agent_ids.add(execution_agent_id)
                    valid_mentioned_agent_ids = sorted(
                        candidate_agent_ids & invocable_agent_ids
                    )

                normalized_metadata = {
                    **(metadata or {}),
                    "mentioned_user_ids": valid_mentioned_ids,
                    "mentioned_agent_ids": valid_mentioned_agent_ids,
                }
                if request_id:
                    normalized_metadata["client_request_id"] = request_id
                mention_all = bool(normalized_metadata.get("mention_all"))

                conv.latest_message_seq = _allocate_message_seq(str(conv.id))
                msg = Message.objects.create(
                    conversation=conv,
                    seq=conv.latest_message_seq,
                    client_request_id=request_id,
                    sender_id=sender_id,
                    sender_type=sender_type,
                    content=content,
                    message_type=message_type,
                    reply_to_id=reply_to_id,
                    metadata=normalized_metadata,
                    search_text=initial_search_text,
                    has_attachment=message_type in (MessageType.FILE, MessageType.IMAGE),
                    counts_as_unread=message_type != MessageType.SYSTEM,
                    mention_all=mention_all,
                )
                _grant_resource_card_viewer_access(normalized_metadata, conv, sender_id)

                mentions = [
                    MessageMention(
                        message=msg,
                        conversation=conv,
                        user_id=user_id,
                        mention_type=MessageMention.MentionType.USER,
                    )
                    for user_id in valid_mentioned_ids
                ]
                mentions.extend(
                    MessageMention(
                        message=msg,
                        conversation=conv,
                        agent_id=agent_id,
                        mention_type=MessageMention.MentionType.AGENT,
                    )
                    for agent_id in valid_mentioned_agent_ids
                )
                if mentions:
                    MessageMention.objects.bulk_create(mentions)

                preview = _build_preview(
                    message_type,
                    content,
                    normalized_metadata,
                    conv_type=conv.type,
                    sender_name=sender_name,
                )
                conv.latest_message = msg
                conv.last_message_at = msg.created_at
                conv.last_message_preview = preview
                conv.save(
                    update_fields=[
                        "latest_message_seq",
                        "latest_message",
                        "last_message_at",
                        "last_message_preview",
                        "updated_at",
                    ]
                )

                # ``chat:{conversation}`` 是所有成员共用的实时通道，不能在这里携带
                # 被引用消息的原文：每个接收者的清空/隐藏状态不同。历史接口会按
                # 当前接收者的可见性补回安全的预览。
                reply_map = (
                    {reply_to_id: _build_unavailable_reply_preview()}
                    if reply_to_id
                    else {}
                )
                message_data = _serialize_message(
                    msg,
                    sender_name=sender_name,
                    reply_map=reply_map,
                )

                import uuid

                domain_event_id = uuid.uuid4()
                if dispatch_legacy_delivery_side_effects:
                    IMOutboxService.enqueue(
                        organization_id=str(conv.organization_id),
                        event_type=IMEventType.MESSAGE,
                        target_channels=[f"chat:{conv.id}"],
                        data=message_data,
                        conversation=conv,
                        message=msg,
                        domain_event_id=domain_event_id,
                    )

                other_ids = [user_id for user_id in member_ids if user_id != sender_id]
                mentioned_recipients = [
                    user_id
                    for user_id in other_ids
                    if mention_all or user_id in valid_mentioned_ids
                ]
                normal_recipients = [
                    user_id
                    for user_id in other_ids
                    if not mention_all and user_id not in valid_mentioned_ids
                ]
                personal_base = {
                    "conversation_id": str(conv.id),
                    "organization_id": str(conv.organization_id),
                    "message_id": msg.id,
                    "message_seq": msg.seq,
                    "last_message_at": msg.created_at.isoformat(),
                    "sender_id": sender_id,
                    "sender_name": sender_name,
                    "preview": preview,
                }
                if dispatch_legacy_delivery_side_effects and normal_recipients:
                    _enqueue_personal_unread_updates(
                        conversation=conv,
                        message=msg,
                        domain_event_id=domain_event_id,
                        recipient_ids=normal_recipients,
                        data=personal_base,
                        mention=False,
                    )
                if dispatch_legacy_delivery_side_effects and mentioned_recipients:
                    _enqueue_personal_unread_updates(
                        conversation=conv,
                        message=msg,
                        domain_event_id=domain_event_id,
                        recipient_ids=mentioned_recipients,
                        data=personal_base,
                        mention=True,
                    )
                if dispatch_legacy_delivery_side_effects:
                    # unread 事件只发给其他成员；发送者自己的所有在线设备也必须推进
                    # 会话目录摘要，但不能给自己增加未读。
                    _enqueue_personal_preview_update(
                        conversation=conv,
                        message=msg,
                        domain_event_id=domain_event_id,
                        preview=preview,
                        recipient_ids=[sender_id],
                    )

                if (
                    dispatch_legacy_delivery_side_effects
                    and message_type != MessageType.SYSTEM
                    and other_ids
                ):
                    push_payload = {
                        "organization_id": str(conv.organization_id),
                        "conversation_id": str(conv.id),
                        "message_id": str(msg.id),
                        "sender_id": sender_id,
                        "sender_name": sender_name,
                        "preview": preview,
                        "recipients": _mobile_push_recipients(
                            conversation=conv,
                            recipient_ids=other_ids,
                            mentioned_recipient_ids=mentioned_recipients,
                        ),
                    }
                    transaction.on_commit(
                        lambda payload=push_payload: _safe_enqueue_im_message_push(payload),
                        using=postgres_app_db_alias(),
                        robust=True,
                    )

                agent_jobs: list[AgentMentionJob] = []
                for agent_id in (
                    valid_mentioned_agent_ids
                    if dispatch_legacy_delivery_side_effects
                    else []
                ):
                    job, _ = AgentMentionJob.objects.get_or_create(
                        source_message=msg,
                        agent_id=agent_id,
                        defaults={
                            "organization_id": str(conv.organization_id),
                            "conversation": conv,
                            "billing_idempotency_key": (
                                f"tabchat-agent-mention:{msg.id}:{agent_id}"
                            ),
                        },
                    )
                    agent_jobs.append(job)
                    try:
                        MessageService.add_agent_reaction(
                            str(conv.id),
                            msg.id,
                            agent_id,
                            AGENT_MENTION_ACK_EMOJI,
                        )
                    except Exception:
                        logger.exception(
                            "[tabchat.ai] mention ack reaction failed conv=%s agent=%s",
                            conv.id,
                            agent_id,
                        )

                for job in agent_jobs:
                    transaction.on_commit(
                        lambda job_id=str(job.id): _enqueue_agent_mention_job(job_id),
                        using=postgres_app_db_alias(),
                    )

                if msg.has_attachment:
                    _register_message_file_usages_by_id(
                        msg.id,
                        sender_id,
                        normalized_metadata,
                    )
                transaction.on_commit(
                    lambda message_id=msg.id: _refresh_message_search_vector(message_id),
                    using=postgres_app_db_alias(),
                )
                if dispatch_legacy_delivery_side_effects:
                    transaction.on_commit(
                        lambda: _safe_dispatch_message_created(msg, conv, sender_id),
                        using=postgres_app_db_alias(),
                    )

                # IM → 通知中心桥接（铃铛）。口径：私信全量 + 群聊 @我 进铃铛；
                # 群聊日常消息只在「消息」分段红点，不进铃铛（见 im_notification_bridge）。
                if (
                    dispatch_legacy_delivery_side_effects
                    and message_type != MessageType.SYSTEM
                ):
                    from apps.tabchat.services.im_notification_bridge import (
                        compute_bell_recipients,
                    )

                    bell_recipients = compute_bell_recipients(
                        conversation_type=conv.type,
                        other_ids=other_ids,
                        mentioned_recipients=mentioned_recipients,
                    )
                    if bell_recipients:
                        bridge_payload = {
                            "conversation_id": str(conv.id),
                            "organization_id": str(conv.organization_id),
                            "conversation_type": conv.type,
                            "conversation_name": conv.name or "",
                            "message_id": msg.id,
                            "sender_name": sender_name,
                            "preview": preview,
                            "recipients": bell_recipients,
                        }
                        transaction.on_commit(
                            lambda payload=bridge_payload: _safe_bridge_im_notifications(
                                payload
                            ),
                            using=postgres_app_db_alias(),
                        )
                return msg
        except IntegrityError:
            if request_id:
                existing = Message.objects.filter(
                    conversation_id=conversation_id,
                    sender_type=sender_type,
                    sender_id=sender_id,
                    client_request_id=request_id,
                ).first()
                if existing is not None:
                    return existing
            raise

    @staticmethod
    def get_messages(
        conversation_id: str,
        user_id: str,
        before_id: int | None = None,
        limit: int = 50,
        content_filter: str | None = None,
    ) -> list[dict[str, Any]]:
        """获取消息历史（cursor 分页，按 id 降序）。

        content_filter:
        - None/"message": 完整消息流；
        - "document": 当前会话内分享过的 TabDoc/TabData 在线资源卡片；
        - "file": 当前会话内文件与图片附件。
        包含被回复消息的摘要（reply_to_preview）。
        """
        if not is_conversation_user_active(conversation_id, user_id):
            raise PermissionError("不是该会话的成员")

        qs = Message.objects.filter(conversation_id=conversation_id)
        qs = _apply_history_content_filter(qs, content_filter)
        if before_id is not None:
            qs = qs.filter(id__lt=before_id)

        state = (
            ConversationUserState.objects.filter(
                conversation_id=conversation_id,
                user_id=user_id,
            )
            .values("history_cleared_seq")
            .first()
        )
        history_cleared_seq = state["history_cleared_seq"] if state else 0
        qs = apply_user_message_visibility(
            qs,
            user_id=user_id,
            history_cleared_seq=history_cleared_seq,
            conversation_ids=[conversation_id],
        )

        messages = list(qs.order_by("-id")[:limit])
        messages.reverse()

        reply_ids = {m.reply_to_id for m in messages if m.reply_to_id}
        # 先让所有引用都有不可用预览。这样源消息因个人清空/隐藏而不可见时，
        # 仍会明确告知客户端内容不可用，而不是回退到未经授权的原文。
        reply_map = {
            reply_id: _build_unavailable_reply_preview()
            for reply_id in reply_ids
        }
        if reply_ids:
            replied_msgs = apply_user_message_visibility(
                Message.objects.filter(
                    id__in=reply_ids,
                    conversation_id=conversation_id,
                ),
                user_id=user_id,
                history_cleared_seq=history_cleared_seq,
                conversation_ids=[conversation_id],
            ).only(
                "id", "content", "sender_id", "is_deleted", "message_type", "has_attachment", "metadata"
            )
            for rm in replied_msgs:
                reply_map[rm.id] = _build_reply_preview(rm)

        # sender 显示名批量查询（避免 N+1）。Agent 不是 User，历史回放必须按
        # sender_type 分桶，否则刷新后 AI 气泡会退化成前端兜底名。
        user_sender_ids = {
            m.sender_id
            for m in messages
            if (getattr(m, "sender_type", SenderType.USER) or SenderType.USER) != SenderType.AGENT
        }
        agent_sender_ids = {
            m.sender_id
            for m in messages
            if (getattr(m, "sender_type", SenderType.USER) or SenderType.USER) == SenderType.AGENT
        }
        sender_name_map: dict[str, str] = {}
        if user_sender_ids:
            for u in User.objects.filter(id__in=user_sender_ids).values("id", "nickname", "username"):
                sender_name_map[str(u["id"])] = u.get("nickname") or u.get("username") or ""
        if agent_sender_ids:
            from apps.tabtinspace.models import Agent

            conversation_organization_id = (
                Conversation.objects
                .filter(id=conversation_id)
                .values_list("organization_id", flat=True)
                .first()
            )
            agent_qs = Agent.objects.filter(id__in=agent_sender_ids)
            if conversation_organization_id:
                agent_qs = agent_qs.filter(organization_id=conversation_organization_id)
            for a in agent_qs.values("id", "name"):
                sender_name_map[str(a["id"])] = a.get("name") or ""

        # reaction 聚合（避免 N+1）
        from apps.tabchat.models import MessageReaction
        from collections import defaultdict

        msg_ids = [m.id for m in messages]
        reactions_qs = MessageReaction.objects.filter(message_id__in=msg_ids)
        reaction_map: dict[int, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        for r in reactions_qs:
            reaction_map[r.message_id][r.emoji].append(r.user_id)

        results = [
            _serialize_message(
                m,
                sender_name=sender_name_map.get(m.sender_id, ""),
                reply_map=reply_map,
                reaction_map=reaction_map,
            )
            for m in messages
        ]

        # 已读进度只随「本人发出的消息」下发；一次批量取全体收件人的水位，避免
        # 前端为每条消息单独请求。群聊可据此画进度环，点击仍走详情接口拿名单。
        conversation = Conversation.objects.filter(pk=conversation_id).only("id").first()
        if conversation:
            recipient_ids = [
                str(member_id)
                for member_id in ConversationAccessResolver.human_user_ids(conversation)
                if str(member_id) != str(user_id)
            ]
            read_seq_by_user = {
                str(state.user_id): state.last_read_seq
                for state in ConversationUserState.objects.filter(
                    conversation=conversation, user_id__in=recipient_ids,
                ).only("user_id", "last_read_seq")
            }
            for message, payload in zip(messages, results):
                if message.sender_type == SenderType.USER and str(message.sender_id) == str(user_id):
                    payload["read_receipt"] = {
                        "read_count": sum(
                            1 for recipient_id in recipient_ids
                            if read_seq_by_user.get(recipient_id, 0) >= message.seq
                        ),
                        "recipient_count": len(recipient_ids),
                    }
        return results

    @staticmethod
    def resolve_message_references(
        *,
        conversation_id: str,
        user_id: str,
        message_ids: list[str],
    ) -> list[dict[str, Any]]:
        """按请求顺序解析最多 50 个十进制字符串消息引用。"""
        if not is_conversation_user_active(conversation_id, user_id):
            raise PermissionError("不是该会话的成员")
        if not message_ids:
            raise ValueError("message_ids 不能为空")
        if len(message_ids) > 50:
            raise ValueError("message_ids 最多 50 条")

        normalized_ids: list[str] = []
        seen_ids: set[str] = set()
        for raw_id in message_ids:
            value = raw_id if isinstance(raw_id, str) else ""
            if not re.fullmatch(r"[1-9][0-9]*", value):
                raise ValueError("message_ids 必须是正十进制字符串")
            if int(value) > 9_223_372_036_854_775_807:
                raise ValueError("message_ids 超出支持范围")
            if value not in seen_ids:
                normalized_ids.append(value)
                seen_ids.add(value)

        messages = list(
            Message.objects.filter(id__in=normalized_ids).only(
                "id",
                "conversation_id",
                "sender_id",
                "sender_type",
                "content",
                "message_type",
                "metadata",
                "client_request_id",
                "created_at",
                "is_deleted",
                "seq",
            )
        )
        by_id = {str(message.id): message for message in messages}
        if len(by_id) != len(normalized_ids) or any(
            str(by_id[message_id].conversation_id) != str(conversation_id)
            for message_id in normalized_ids
            if message_id in by_id
        ):
            raise ValueError("消息不存在或不属于该会话")

        state = (
            ConversationUserState.objects.filter(
                conversation_id=conversation_id,
                user_id=user_id,
            )
            .values("history_cleared_seq")
            .first()
        )
        history_cleared_seq = state["history_cleared_seq"] if state else 0
        visible_ids = {
            str(message_id)
            for message_id in apply_user_message_visibility(
                Message.objects.filter(
                    id__in=normalized_ids,
                    conversation_id=conversation_id,
                ),
                user_id=user_id,
                history_cleared_seq=history_cleared_seq,
                conversation_ids=[conversation_id],
            ).values_list("id", flat=True)
        }

        user_ids = {
            message.sender_id
            for message in messages
            if message.sender_type != SenderType.AGENT
        }
        agent_ids = {
            message.sender_id
            for message in messages
            if message.sender_type == SenderType.AGENT
        }
        sender_names: dict[str, str] = {}
        if user_ids:
            for user in User.objects.filter(id__in=user_ids).values(
                "id", "nickname", "username"
            ):
                sender_names[str(user["id"])] = (
                    user.get("nickname") or user.get("username") or ""
                )
        if agent_ids:
            from apps.agent.display_name import resolve_agent_display_name
            from apps.agent.models import Agent

            organization_id = (
                Conversation.objects.filter(id=conversation_id)
                .values_list("organization_id", flat=True)
                .first()
            )
            for agent in Agent.objects.filter(
                id__in=agent_ids,
                organization_id=organization_id,
            ).select_related("owner_user", "organization__owner"):
                sender_names[str(agent.id)] = resolve_agent_display_name(agent)

        items: list[dict[str, Any]] = []
        for message_id in normalized_ids:
            if message_id not in visible_ids:
                continue
            message = by_id[message_id]
            metadata = dict(message.metadata or {})
            message_ref = metadata.get("message_ref")
            try:
                parsed_message_ref = UUID(message_ref)
            except (TypeError, ValueError, AttributeError):
                raise ValueError("消息缺少有效的 message_ref")
            if str(parsed_message_ref) != message_ref:
                raise ValueError("消息缺少有效的 message_ref")
            metadata["message_ref"] = message_ref
            metadata["kind"] = "tabtin_ref"
            metadata["tabtin_message_id"] = message_id
            if "source_message_id" in metadata:
                metadata["source_message_id"] = str(metadata["source_message_id"])
            if not message.is_deleted and message.client_request_id:
                metadata["client_request_id"] = str(message.client_request_id)
            items.append(
                {
                    "id": message_id,
                    "content": "" if message.is_deleted else message.content,
                    "type": int(message.message_type),
                    "sender": {
                        "id": str(message.sender_id),
                        "type": message.sender_type or SenderType.USER,
                        "name": sender_names.get(str(message.sender_id), ""),
                    },
                    "metadata": metadata,
                    "created_at": (
                        message.created_at.isoformat()
                        if message.created_at
                        else None
                    ),
                }
            )
        return items

    @staticmethod
    def get_attachment_download_url(
        conversation_id: str,
        message_id: int,
        user_id: str,
    ) -> dict[str, Any]:
        """为会话成员生成 IM 附件的临时下载 URL（TC-13）。

        校验：会话成员 + 消息未删 + 含 file_id + 该消息仍有 active FileUsage。
        转发消息各自注册独立 FileUsage，故接收方可凭 message_id 换链。
        """
        if not is_conversation_user_active(conversation_id, user_id):
            raise PermissionError("不是该会话的成员")

        msg = Message.objects.filter(
            id=message_id,
            conversation_id=conversation_id,
            is_deleted=False,
        ).first()
        if not msg:
            raise ValueError("消息不存在")
        if not apply_user_message_visibility(
            Message.objects.filter(pk=msg.pk),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")
        if msg.message_type not in (MessageType.FILE, MessageType.IMAGE):
            raise ValueError("该消息不含附件")

        metadata = msg.metadata or {}
        file_id = str(metadata.get("file_id") or "").strip()
        if not file_id:
            raise ValueError("附件信息不完整")

        from apps.services.oss.models import FileRecord, FileUsage
        from apps.services.oss.services.factory import get_oss_service
        from apps.services.common.exceptions import OSSServiceException

        record = FileRecord.objects.filter(
            id=file_id,
            organization_id=str(msg.conversation.organization_id),
            status="completed",
        ).first()
        if not record:
            raise PermissionError("文件不存在或已失效")

        has_active_usage = FileUsage.objects.filter(
            file_record=record,
            module="tabchat",
            context_type="im_message",
            context_id=str(msg.id),
            is_active=True,
        ).exists()
        if not has_active_usage:
            raise PermissionError("文件不存在或已失效")

        expiration = 3600
        try:
            download_url = get_oss_service().generate_presigned_url(
                record.file_key,
                expiration=expiration,
            )
        except OSSServiceException as exc:
            logger.error(
                "TabChat attachment presign failed: message_id=%s file_id=%s error=%s",
                message_id,
                file_id,
                exc,
            )
            raise ValueError("无法获取下载链接") from exc

        return {
            "download_url": download_url,
            "file_name": metadata.get("file_name") or record.file_name or "",
            "expires_in": expiration,
        }

    @staticmethod
    def mark_as_read(
        conversation_id: str,
        user_id: str,
        last_message_id: int | None = None,
    ) -> int:
        """把会话已读水位单调推进到指定消息。"""
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_view:
            raise PermissionError("不是该会话的成员")

        visible_messages = apply_user_message_visibility(
            Message.objects.filter(conversation=conversation),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        )
        max_visible_seq = visible_messages.aggregate(max_seq=Max("seq"))["max_seq"] or 0
        requested_seq = max_visible_seq
        if last_message_id is not None:
            resolved_seq = (
                visible_messages.filter(
                    id=last_message_id,
                )
                .values_list("seq", flat=True)
                .first()
            )
            if resolved_seq is None:
                raise ValueError("消息不存在或不属于当前会话")
            requested_seq = resolved_seq
        requested_seq = min(max(0, requested_seq), max_visible_seq)
        read_receipt_message_id = last_message_id
        if read_receipt_message_id is None and requested_seq > 0:
            read_receipt_message_id = (
                Message.objects.filter(
                    conversation=conversation,
                    seq__lte=requested_seq,
                )
                .order_by("-seq")
                .values_list("id", flat=True)
                .first()
            )

        with transaction.atomic(using=postgres_app_db_alias()):
            state, _ = ConversationUserState.objects.select_for_update().get_or_create(
                conversation=conversation,
                user_id=user_id,
            )
            if requested_seq <= state.last_read_seq:
                return 0

            previous_last_read_seq = state.last_read_seq
            marked_messages = Message.objects.filter(
                conversation=conversation,
                seq__gt=previous_last_read_seq,
                seq__lte=requested_seq,
                counts_as_unread=True,
            ).exclude(sender_id=user_id, sender_type=SenderType.USER)
            marked_count = apply_user_message_visibility(
                marked_messages,
                user_id=user_id,
                history_cleared_seq=0,
                conversation_ids=[conversation_id],
            ).count()
            state.last_read_seq = requested_seq
            state.save(update_fields=["last_read_seq", "updated_at"])

            import uuid

            domain_event_id = uuid.uuid4()
            IMOutboxService.enqueue(
                organization_id=str(conversation.organization_id),
                event_type=IMEventType.UNREAD_UPDATE,
                target_channels=[f"personal:{user_id}"],
                data={
                    "conversation_id": conversation_id,
                    "marked_read": marked_count,
                    "last_read_seq": requested_seq,
                },
                conversation=conversation,
                domain_event_id=domain_event_id,
            )
            if conversation.type in (ConversationType.DM, ConversationType.GROUP):
                IMOutboxService.enqueue(
                    organization_id=str(conversation.organization_id),
                    event_type=IMEventType.READ_RECEIPT,
                    target_channels=[f"chat:{conversation_id}"],
                    data={
                        "conversation_id": conversation_id,
                        "user_id": user_id,
                        "last_read_message_id": read_receipt_message_id,
                        "last_read_seq": requested_seq,
                        "previous_last_read_seq": previous_last_read_seq,
                    },
                    conversation=conversation,
                    domain_event_id=domain_event_id,
                )

            # 读态单向联动：读会话后把铃铛里该会话的 IM 通知标已读，避免
            # 「消息」分段已读、铃铛角标仍挂着的双语义打架。
            transaction.on_commit(
                lambda: _safe_mark_im_conversation_read(user_id, conversation_id),
                using=postgres_app_db_alias(),
            )

        return marked_count

    @staticmethod
    def get_message_read_receipts(
        conversation_id: str,
        message_id: int,
        viewer_id: str,
    ) -> dict[str, Any]:
        """返回群消息的已读/未读成员；仅发送者可查看，避免泄露他人阅读状态。"""
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, viewer_id).can_view:
            raise PermissionError("不是该会话的成员")
        message = Message.objects.filter(pk=message_id, conversation=conversation).first()
        if message is None:
            raise ValueError("消息不存在或不属于当前会话")
        if not apply_user_message_visibility(
            Message.objects.filter(pk=message.pk),
            user_id=viewer_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")
        if message.sender_type != SenderType.USER or str(message.sender_id) != str(viewer_id):
            raise PermissionError("仅消息发送者可查看已读详情")

        recipient_ids = sorted(
            str(user_id)
            for user_id in ConversationAccessResolver.human_user_ids(conversation)
            if str(user_id) != str(viewer_id)
        )
        states = {
            str(state.user_id): state.last_read_seq
            for state in ConversationUserState.objects.filter(
                conversation=conversation, user_id__in=recipient_ids,
            ).only("user_id", "last_read_seq")
        }
        users = {
            str(user.id): user
            for user in User.objects.filter(id__in=recipient_ids).only(
                "id", "nickname", "username", "avatar",
            )
        }

        def serialize(user_id: str) -> dict[str, str]:
            user = users.get(user_id)
            return {
                "user_id": user_id,
                "name": (user.nickname or user.username or user_id) if user else user_id,
                "username": user.username if user else "",
                "avatar": user.avatar if user else "",
            }

        readers = [user_id for user_id in recipient_ids if states.get(user_id, 0) >= message.seq]
        unreaders = [user_id for user_id in recipient_ids if user_id not in readers]
        return {
            "message_id": message.id,
            "readers": [serialize(user_id) for user_id in readers],
            "unreaders": [serialize(user_id) for user_id in unreaders],
        }

    @staticmethod
    def set_message_starred(
        conversation_id: str,
        message_id: int,
        user_id: str,
        starred: bool,
    ) -> bool:
        return MessageService._set_message_user_state(
            conversation_id,
            message_id,
            user_id,
            starred=starred,
        )

    @staticmethod
    def set_message_hidden(
        conversation_id: str,
        message_id: int,
        user_id: str,
        hidden: bool,
    ) -> bool:
        return MessageService._set_message_user_state(
            conversation_id,
            message_id,
            user_id,
            hidden=hidden,
        )

    @staticmethod
    def _set_message_user_state(
        conversation_id: str,
        message_id: int,
        user_id: str,
        *,
        starred: bool | None = None,
        hidden: bool | None = None,
    ) -> bool:
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_view:
            raise PermissionError("不是该会话的成员")
        if not Message.objects.filter(
            id=message_id,
            conversation=conversation,
        ).exists():
            raise ValueError("消息不存在")
        if not apply_user_message_visibility(
            Message.objects.filter(id=message_id, conversation=conversation),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")

        with transaction.atomic(using=postgres_app_db_alias()):
            state, _ = MessageUserState.objects.select_for_update().get_or_create(
                message_id=message_id,
                user_id=user_id,
            )
            update_fields = ["updated_at"]
            if starred is not None:
                state.starred = starred
                update_fields.append("starred")
            if hidden is not None:
                state.hidden = hidden
                update_fields.append("hidden")
            if not state.starred and not state.hidden:
                state.delete()
            else:
                state.save(update_fields=update_fields)
        return bool(starred if starred is not None else hidden)

    @staticmethod
    def _unread_visible_conv_ids(organization_id: str, user_id: str) -> set[str]:
        """未读统计口径下用户在该 organization 可见的会话 id 集合（DM/私聊 + 可见 team space 频道）。"""
        from apps.tabtinspace.models import Project

        team_space_ids = list(Project.objects.filter(
            organization_id=organization_id,
        ).values_list("id", flat=True))
        member_conv_ids = set(ConversationMember.objects.filter(
            user_id=user_id,
            conversation__organization_id=organization_id,
            conversation__is_external=False,
            conversation__is_archived=False,
        ).values_list("conversation_id", flat=True))
        member_conv_ids.difference_update(
            Conversation.objects.filter(
                organization_id=organization_id,
                space_id__in=team_space_ids,
            ).values_list("id", flat=True)
        )

        user = User.objects.filter(id=user_id).first()
        if user:
            from apps.tabtinspace.services.space_visibility import get_accessible_space_ids

            accessible_space_ids = get_accessible_space_ids(user, organization_id=organization_id)
            team_space_ids = Project.objects.filter(
                id__in=accessible_space_ids,
                organization_id=organization_id,
                is_archived=False,
                trashed_at__isnull=True,
            ).values_list("id", flat=True)
            member_conv_ids.update(
                Conversation.objects.filter(
                    organization_id=organization_id,
                    space_id__in=list(team_space_ids),
                    is_archived=False,
                ).values_list("id", flat=True)
            )
        member_conv_ids.update(
            _external_directory_members(organization_id, user_id).filter(
                status=ConversationMember.Status.ACTIVE,
                conversation__is_archived=False,
            ).values_list("conversation_id", flat=True)
        )
        return {str(cid) for cid in member_conv_ids}

    @staticmethod
    def get_unread_counts(organization_id: str, user_id: str) -> dict[str, int]:
        """获取用户在该 organization 中各会话的未读数。"""
        from apps.tabchat.utils import is_organization_member

        if not is_organization_member(organization_id, user_id):
            return {}

        member_conv_ids = MessageService._unread_visible_conv_ids(organization_id, user_id)

        state_qs = ConversationUserState.objects.filter(
            conversation_id=OuterRef("conversation_id"),
            user_id=user_id,
        )
        count_queryset = (
            Message.objects.filter(
                conversation_id__in=list(member_conv_ids),
                counts_as_unread=True,
                is_deleted=False,
            )
            .exclude(sender_id=user_id, sender_type=SenderType.USER)
            .annotate(
                _last_read_seq=Coalesce(
                    Subquery(state_qs.values("last_read_seq")[:1]),
                    Value(0),
                    output_field=BigIntegerField(),
                ),
                _history_cleared_seq=Coalesce(
                    Subquery(state_qs.values("history_cleared_seq")[:1]),
                    Value(0),
                    output_field=BigIntegerField(),
                ),
            )
            .filter(
                Q(seq__gt=F("_last_read_seq"))
                & Q(seq__gt=F("_history_cleared_seq"))
            )
        )
        count_queryset = apply_user_message_visibility(
            count_queryset,
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=member_conv_ids,
        )
        counts = (
            count_queryset
            .values("conversation_id")
            .annotate(count=Count("id"))
        )

        return {
            str(item["conversation_id"]): item["count"]
            for item in counts
        }

    @staticmethod
    def get_unread_snapshots(organization_id: str, user_id: str) -> dict[str, tuple[int, int]]:
        """获取用户各会话的 **一致快照未读**：返回 {conversation_id: (unread_count, last_message_seq)}。

        `last_message_seq` 是「统计该 unread_count 时会话已见的最高消息 seq」水位，供移动端在
        列表加载在途做 baseline/delta 合并：加载窗口内到达的 realtime 未读，只有 `seq > 水位`
        （快照未包含）才计入净增量，`seq <= 水位`（快照已含）不重复计数。

        一致性由**构造**保证而非依赖事务隔离：先取每会话当前最高 seq 作水位 W，再把未读计数
        限制为 `seq <= W` 的消息——即便两条查询之间有新消息落库（seq 必然 > W）也被计数排除，
        故 unread_count 与 W 永远对应同一水位，不受 READ COMMITTED 下的跨查询快照漂移影响。
        """
        from apps.tabchat.utils import is_organization_member

        if not is_organization_member(organization_id, user_id):
            return {}

        member_conv_ids = MessageService._unread_visible_conv_ids(organization_id, user_id)
        if not member_conv_ids:
            return {}
        conv_id_list = list(member_conv_ids)

        # 1) 每会话当前最高 seq 作水位（含已读/已删，代表快照「已见」的最高消息）。
        max_queryset = apply_user_message_visibility(
            Message.objects.filter(conversation_id__in=conv_id_list),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=conv_id_list,
        )
        max_rows = (
            max_queryset
            .values("conversation_id")
            .annotate(w=Max("seq"))
        )
        waterline_map = {str(r["conversation_id"]): int(r["w"] or 0) for r in max_rows}
        if not waterline_map:
            return {}

        # 2) 未读计数限制为 seq <= 该会话水位：构造性对齐水位，排除水位取定后落库的新消息。
        seq_bound = Q()
        for cid, w in waterline_map.items():
            seq_bound |= Q(conversation_id=cid, seq__lte=w)

        state_qs = ConversationUserState.objects.filter(
            conversation_id=OuterRef("conversation_id"),
            user_id=user_id,
        )
        count_queryset = (
            Message.objects.filter(
                conversation_id__in=conv_id_list,
                counts_as_unread=True,
                is_deleted=False,
            )
            .exclude(sender_id=user_id, sender_type=SenderType.USER)
            .annotate(
                _last_read_seq=Coalesce(
                    Subquery(state_qs.values("last_read_seq")[:1]),
                    Value(0),
                    output_field=BigIntegerField(),
                ),
                _history_cleared_seq=Coalesce(
                    Subquery(state_qs.values("history_cleared_seq")[:1]),
                    Value(0),
                    output_field=BigIntegerField(),
                ),
            )
            .filter(
                Q(seq__gt=F("_last_read_seq"))
                & Q(seq__gt=F("_history_cleared_seq"))
            )
            .filter(seq_bound)
        )
        count_queryset = apply_user_message_visibility(
            count_queryset,
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=conv_id_list,
        )
        counts = (
            count_queryset
            .values("conversation_id")
            .annotate(count=Count("id"))
        )
        count_map = {str(item["conversation_id"]): item["count"] for item in counts}

        return {
            cid: (count_map.get(cid, 0), w)
            for cid, w in waterline_map.items()
        }


    @staticmethod
    def add_agent_reaction(
        conversation_id: str,
        message_id: int,
        agent_id: str,
        emoji: str,
    ) -> bool:
        """用已入群 Agent 身份给消息加表情。user_id 字段存 agent_id，兼容现有反应契约。"""
        from apps.tabchat.models import MessageReaction

        message = (
            Message.objects.select_related("conversation")
            .filter(pk=message_id, conversation_id=conversation_id, is_deleted=False)
            .first()
        )
        if message is None:
            raise ValueError("消息不存在或已被撤回")
        if not ConversationAccessResolver.can_agent_send(message.conversation, str(agent_id)):
            raise PermissionError("Agent 不是该会话的成员")

        with transaction.atomic(using=postgres_app_db_alias()):
            _, created = MessageReaction.objects.get_or_create(
                message_id=message_id,
                user_id=str(agent_id),
                emoji=emoji,
            )
            if created:
                IMOutboxService.enqueue(
                    organization_id=str(message.conversation.organization_id),
                    event_type=IMEventType.REACTION_ADDED,
                    target_channels=[f"chat:{conversation_id}"],
                    data={
                        "message_id": message_id,
                        "message_ref": str((message.metadata or {}).get("message_ref") or message.id),
                        "conversation_id": conversation_id,
                        "user_id": str(agent_id),
                        "sender_type": SenderType.AGENT,
                        "emoji": emoji,
                    },
                    conversation=message.conversation,
                    message=message,
                )
        return created

    @staticmethod
    def resolve_visible_message_id(conversation_id: str, message_key: int | str) -> int:
        """Resolve a reaction target to Message.pk.

        HTTP clients may send the integer id or metadata.message_ref (UUID).
        """
        key = str(message_key).strip()
        if not key:
            raise ValueError("消息不存在或已被撤回")

        queryset = Message.objects.filter(
            conversation_id=conversation_id,
            is_deleted=False,
        )
        if key.isdigit():
            message = queryset.filter(pk=int(key)).only("id").first()
        else:
            message = queryset.filter(metadata__message_ref=key).only("id").first()
        if message is None:
            raise ValueError("消息不存在或已被撤回")
        return message.id

    @staticmethod
    def add_reaction(conversation_id: str, message_id: int, user_id: str, emoji: str) -> bool:
        """为消息添加 emoji 反应。"""
        from apps.tabchat.models import MessageReaction

        if not Message.objects.filter(pk=message_id, conversation_id=conversation_id, is_deleted=False).exists():
            raise ValueError("消息不存在或已被撤回")
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None or not ConversationAccessResolver.resolve(
            conversation, user_id,
        ).can_send:
            raise PermissionError("不是该会话的成员")
        if not apply_user_message_visibility(
            Message.objects.filter(pk=message_id, conversation=conversation),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")

        with transaction.atomic(using=postgres_app_db_alias()):
            _, created = MessageReaction.objects.get_or_create(
                message_id=message_id,
                user_id=user_id,
                emoji=emoji,
            )

            if created:
                message = Message.objects.select_related("conversation").get(pk=message_id)
                IMOutboxService.enqueue(
                    organization_id=str(message.conversation.organization_id),
                    event_type=IMEventType.REACTION_ADDED,
                    target_channels=[f"chat:{conversation_id}"],
                    data={
                        "message_id": message_id,
                        "message_ref": str((message.metadata or {}).get("message_ref") or message.id),
                        "conversation_id": conversation_id,
                        "user_id": user_id,
                        "emoji": emoji,
                    },
                    conversation=message.conversation,
                    message=message,
                )
        return created

    @staticmethod
    def remove_reaction(conversation_id: str, message_id: int, user_id: str, emoji: str) -> bool:
        """移除 emoji 反应。"""
        from apps.tabchat.models import MessageReaction

        message = Message.objects.select_related("conversation").filter(
            pk=message_id,
            conversation_id=conversation_id,
            is_deleted=False,
        ).first()
        if message is None:
            raise ValueError("消息不存在或已被撤回")
        if not ConversationAccessResolver.resolve(message.conversation, user_id).can_send:
            raise PermissionError("不是该会话的成员")
        if not apply_user_message_visibility(
            Message.objects.filter(pk=message_id, conversation=message.conversation),
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=[conversation_id],
        ).exists():
            raise ValueError("消息不存在或当前成员不可见")

        with transaction.atomic(using=postgres_app_db_alias()):
            deleted, _ = MessageReaction.objects.filter(
                message_id=message_id,
                user_id=user_id,
                emoji=emoji,
            ).delete()

            if deleted > 0:
                IMOutboxService.enqueue(
                    organization_id=str(message.conversation.organization_id),
                    event_type=IMEventType.REACTION_REMOVED,
                    target_channels=[f"chat:{conversation_id}"],
                    data={
                        "message_id": message_id,
                        "message_ref": str((message.metadata or {}).get("message_ref") or message.id),
                        "conversation_id": conversation_id,
                        "user_id": user_id,
                        "emoji": emoji,
                    },
                    conversation=message.conversation,
                    message=message,
                )
        return deleted > 0

    @staticmethod
    def search_messages(
        organization_id: str,
        user_id: str,
        query: str,
        conversation_id: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """全文搜索消息。

        仅搜索用户参与的会话中的消息。
        CJK 字符使用 LIKE 子串匹配，Latin/数字使用 tsvector 排序检索。
        返回结果包含会话名称和高亮片段，方便前端定位。
        """
        from apps.tabchat.utils import is_organization_member

        if not is_organization_member(organization_id, user_id):
            return []

        from apps.tabtinspace.models import Project

        team_space_ids = list(Project.objects.filter(
            organization_id=organization_id,
        ).values_list("id", flat=True))
        member_conv_ids = set(ConversationMember.objects.filter(
            user_id=user_id,
            conversation__organization_id=organization_id,
            conversation__is_external=False,
            conversation__is_archived=False,
        ).values_list("conversation_id", flat=True))
        member_conv_ids.difference_update(
            Conversation.objects.filter(
                organization_id=organization_id,
                space_id__in=team_space_ids,
            ).values_list("id", flat=True)
        )

        user = User.objects.filter(id=user_id).first()
        if user:
            from apps.tabtinspace.services.space_visibility import get_accessible_space_ids

            accessible_space_ids = get_accessible_space_ids(user, organization_id=organization_id)
            team_space_ids = Project.objects.filter(
                id__in=accessible_space_ids,
                organization_id=organization_id,
                is_archived=False,
                trashed_at__isnull=True,
            ).values_list("id", flat=True)
            member_conv_ids.update(
                Conversation.objects.filter(
                    organization_id=organization_id,
                    space_id__in=list(team_space_ids),
                    is_archived=False,
                ).values_list("id", flat=True)
            )
        member_conv_ids.update(
            _external_directory_members(organization_id, user_id).filter(
                conversation__is_archived=False,
            ).values_list("conversation_id", flat=True)
        )

        if conversation_id:
            conversation = Conversation.objects.filter(pk=conversation_id).first()
            if conversation is None or not ConversationAccessResolver.resolve(
                conversation, user_id,
            ).can_view_history:
                raise PermissionError("不是该会话的成员")
            conv_ids = [conversation_id]
        else:
            conv_ids = list(member_conv_ids)

        if not conv_ids:
            return []

        use_like = _contains_cjk(query)

        state_qs = ConversationUserState.objects.filter(
            conversation_id=OuterRef("conversation_id"),
            user_id=user_id,
        )
        base_qs = (
            Message.objects
            .filter(conversation_id__in=conv_ids, is_deleted=False)
            .exclude(user_states__user_id=user_id, user_states__hidden=True)
            .annotate(
                _history_cleared_seq=Coalesce(
                    Subquery(state_qs.values("history_cleared_seq")[:1]),
                    Value(0),
                    output_field=BigIntegerField(),
                ),
            )
            .filter(seq__gt=F("_history_cleared_seq"))
        )
        base_qs = apply_user_message_visibility(
            base_qs,
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=conv_ids,
        )

        from django.db import connections
        _is_pg = connections[postgres_app_db_alias()].vendor == 'postgresql'

        # TC-36：LIKE 路径搜 search_text（聚合 content + file_name + card title/desc）。
        # tsvector 路径同样基于 search_text 生成的索引。
        if use_like or not _is_pg:
            qs = (
                base_qs.filter(search_text__icontains=query)
                .order_by("-id")
                .select_related("conversation")[offset:offset + limit]
            )
        else:
            from django.contrib.postgres.search import SearchQuery, SearchRank
            search_query = SearchQuery(query, config="simple")
            qs = (
                base_qs.filter(search_tsvector__isnull=False)
                .filter(search_tsvector=search_query)
                .annotate(rank=SearchRank(F("search_tsvector"), search_query))
                .order_by("-rank", "-id")
                .select_related("conversation")[offset:offset + limit]
            )

        results = []
        lower_query = query.lower()
        for msg in qs:
            # TC-36：判定命中的字段（LIKE 路径精确到字段；tsvector 路径保守标 content）
            match_types: list[str] = []
            if use_like or not _is_pg:
                if (msg.content or "").lower().find(lower_query) >= 0:
                    match_types.append("content")
                meta = msg.metadata or {}
                if isinstance(meta, dict):
                    if (meta.get("file_name") or "").lower().find(lower_query) >= 0:
                        match_types.append("file_name")
                    card = meta.get("card")
                    if isinstance(card, dict):
                        if (card.get("title") or "").lower().find(lower_query) >= 0:
                            match_types.append("card_title")
                        if (card.get("description") or "").lower().find(lower_query) >= 0:
                            match_types.append("card_description")
                if not match_types:
                    match_types = ["content"]  # 兜底
            else:
                match_types = ["content"]  # tsvector 路径无法精确到字段

            # highlight 优先取命中的字段片段
            highlight = msg.content or ""
            meta = msg.metadata or {}
            if isinstance(meta, dict):
                # 若正文没命中但文件名/卡标题命中，highlight 用命中的字段
                if "content" not in match_types:
                    if "file_name" in match_types:
                        highlight = meta.get("file_name") or highlight
                    elif "card_title" in match_types:
                        highlight = (meta.get("card") or {}).get("title") or highlight
                    elif "card_description" in match_types:
                        highlight = (meta.get("card") or {}).get("description") or highlight
            if len(highlight) > 200:
                pos = highlight.lower().find(lower_query)
                if pos >= 0:
                    start = max(0, pos - 60)
                    end = min(len(highlight), pos + len(query) + 60)
                    highlight = ("…" if start > 0 else "") + highlight[start:end] + ("…" if end < len(highlight) else "")
                else:
                    highlight = highlight[:200] + "…"

            results.append({
                "id": msg.id,
                "conversation_id": str(msg.conversation_id),
                "conversation_name": msg.conversation.name or "",
                "conversation_type": msg.conversation.type,
                "conversation_avatar_url": msg.conversation.avatar_url or "",
                "sender_id": msg.sender_id,
                "sender_type": getattr(msg, "sender_type", "user") or "user",
                "content": msg.content,
                "message_type": msg.message_type,
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
                "highlight": highlight,
                "match_types": match_types,
            })

        return results

    @staticmethod
    def search_message_groups(
        organization_id: str,
        user_id: str,
        query: str,
        *,
        group_offset: int = 0,
        group_limit: int = 8,
        per_group_limit: int = 3,
    ) -> dict[str, Any]:
        """按会话聚合搜索结果，并独立分页聚合组与组内消息。

        聚合组按最近一条命中消息排序。私聊会话对应用户，群聊会话对应群组；
        组内更多结果继续复用 ``search_messages`` 的 offset 分页。
        """
        from apps.tabchat.utils import is_organization_member

        if not is_organization_member(organization_id, user_id):
            return {
                "groups": [],
                "has_more": False,
                "next_group_offset": group_offset,
            }

        from apps.tabtinspace.models import Project

        team_space_ids = list(Project.objects.filter(
            organization_id=organization_id,
        ).values_list("id", flat=True))
        member_conv_ids = set(ConversationMember.objects.filter(
            user_id=user_id,
            conversation__organization_id=organization_id,
            conversation__is_external=False,
            conversation__is_archived=False,
        ).values_list("conversation_id", flat=True))
        member_conv_ids.difference_update(
            Conversation.objects.filter(
                organization_id=organization_id,
                space_id__in=team_space_ids,
            ).values_list("id", flat=True)
        )

        user = User.objects.filter(id=user_id).first()
        if user:
            from apps.tabtinspace.services.space_visibility import get_accessible_space_ids

            accessible_space_ids = get_accessible_space_ids(user, organization_id=organization_id)
            accessible_team_space_ids = Project.objects.filter(
                id__in=accessible_space_ids,
                organization_id=organization_id,
                is_archived=False,
                trashed_at__isnull=True,
            ).values_list("id", flat=True)
            member_conv_ids.update(
                Conversation.objects.filter(
                    organization_id=organization_id,
                    space_id__in=list(accessible_team_space_ids),
                    is_archived=False,
                ).values_list("id", flat=True)
            )
        member_conv_ids.update(
            _external_directory_members(organization_id, user_id).filter(
                conversation__is_archived=False,
            ).values_list("conversation_id", flat=True)
        )

        conv_ids = list(member_conv_ids)
        if not conv_ids:
            return {
                "groups": [],
                "has_more": False,
                "next_group_offset": group_offset,
            }

        state_qs = ConversationUserState.objects.filter(
            conversation_id=OuterRef("conversation_id"),
            user_id=user_id,
        )
        matches = (
            Message.objects
            .filter(conversation_id__in=conv_ids, is_deleted=False)
            .exclude(user_states__user_id=user_id, user_states__hidden=True)
            .annotate(
                _history_cleared_seq=Coalesce(
                    Subquery(state_qs.values("history_cleared_seq")[:1]),
                    Value(0),
                    output_field=BigIntegerField(),
                ),
            )
            .filter(seq__gt=F("_history_cleared_seq"))
        )
        matches = apply_user_message_visibility(
            matches,
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=conv_ids,
        )

        is_pg = connections[postgres_app_db_alias()].vendor == "postgresql"
        if _contains_cjk(query) or not is_pg:
            matches = matches.filter(search_text__icontains=query)
        else:
            from django.contrib.postgres.search import SearchQuery

            matches = matches.filter(
                search_tsvector=SearchQuery(query, config="simple"),
            )

        rows = list(
            matches.values("conversation_id")
            .annotate(
                match_count=Count("id"),
                latest_match_at=Max("created_at"),
            )
            .order_by("-latest_match_at", "-conversation_id")[
                group_offset:group_offset + group_limit + 1
            ]
        )
        has_more = len(rows) > group_limit
        visible_rows = rows[:group_limit]
        visible_conv_ids = [row["conversation_id"] for row in visible_rows]
        conversation_map = {
            conversation.id: conversation
            for conversation in Conversation.objects.filter(id__in=visible_conv_ids)
        }

        groups = []
        for row in visible_rows:
            conversation_id = str(row["conversation_id"])
            conversation = conversation_map.get(row["conversation_id"])
            messages = MessageService.search_messages(
                organization_id=organization_id,
                user_id=user_id,
                query=query,
                conversation_id=conversation_id,
                limit=per_group_limit,
                offset=0,
            )
            match_count = int(row["match_count"])
            groups.append({
                "conversation_id": conversation_id,
                "conversation_name": conversation.name if conversation else "",
                "conversation_type": conversation.type if conversation else ConversationType.DM,
                "conversation_avatar_url": conversation.avatar_url if conversation else "",
                "match_count": match_count,
                "latest_match_at": row["latest_match_at"].isoformat() if row["latest_match_at"] else None,
                "messages": messages,
                "messages_has_more": match_count > len(messages),
                "next_message_offset": len(messages),
            })

        return {
            "groups": groups,
            "has_more": has_more,
            "next_group_offset": group_offset + len(visible_rows),
        }


_CJK_RANGES = re.compile(
    '[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f'
    '\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]'
)


def _compute_search_text(content: str, metadata: dict | None) -> str:
    """TC-36：计算搜索聚合文本 = content + file_name + card 文本字段。

    让文件名、资源卡标题/描述、指令卡标题正文（title/prompt_text）、
    任务共享卡会话标题（session_title）可被全文搜索命中。
    """
    parts = [content or ""]
    if not isinstance(metadata, dict):
        return parts[0]
    file_name = metadata.get("file_name") or ""
    if file_name:
        parts.append(file_name)
    card = metadata.get("card")
    if isinstance(card, dict):
        card_title = card.get("title") or ""
        card_desc = card.get("description") or ""
        if card_title:
            parts.append(card_title)
        if card_desc:
            parts.append(card_desc)
        # 指令卡正文 / 任务共享卡会话标题进搜索聚合
        prompt_text = card.get("prompt_text") or ""
        if prompt_text:
            parts.append(prompt_text)
        session_title = card.get("session_title") or ""
        if session_title:
            parts.append(session_title)
    return "\n".join(p for p in parts if p)


def _refresh_message_search_vector(message_id: int) -> None:
    """提交后更新搜索字段，避免在会话行锁事务中计算 tsvector。"""
    try:
        from django.contrib.postgres.search import SearchVector
        from django.db import connections

        if connections[postgres_app_db_alias()].vendor != "postgresql":
            return
        message = Message.objects.filter(pk=message_id).only(
            "id",
            "content",
            "metadata",
        ).first()
        if message is None:
            return
        search_text = _compute_search_text(message.content, message.metadata)
        Message.objects.filter(pk=message_id).update(
            search_text=search_text,
            search_tsvector=SearchVector("search_text", config="simple"),
        )
    except Exception:
        logger.exception(
            "[tabchat] message search vector refresh failed: message=%s",
            message_id,
        )


def _contains_cjk(text: str) -> bool:
    """检测文本是否包含 CJK（中日韩）字符。"""
    return bool(_CJK_RANGES.search(text))


def _build_unavailable_reply_preview() -> dict[str, Any]:
    """为无法按接收者确认可见性的引用构造无内容预览。"""
    return {
        "content": "消息内容不可用",
        "sender_id": "",
        "is_unavailable": True,
        "message_type": MessageType.TEXT,
        "has_attachment": False,
        "file_name": "",
    }


def _build_reply_preview(msg: Message) -> dict[str, Any]:
    """构造稳定的引用预览快照。

    被引用消息撤回后不能泄露原文；同时用 ``is_unavailable`` 区分于真正的图片/文件
    消息，避免客户端把撤回消息错误展示为「附件消息」。
    """
    metadata = {} if msg.is_deleted else (msg.metadata or {})
    return {
        "content": "消息内容不可用" if msg.is_deleted else (msg.content or "")[:100],
        "sender_id": msg.sender_id,
        "is_unavailable": bool(msg.is_deleted),
        "message_type": msg.message_type,
        "has_attachment": False if msg.is_deleted else bool(msg.has_attachment),
        "file_name": str(metadata.get("file_name") or ""),
    }


def _serialize_message(
    msg: Message,
    *,
    sender_name: str = "",
    reply_map: dict[int, dict[str, Any]] | None = None,
    reaction_map: dict[int, dict[str, list[str]]] | None = None,
) -> dict[str, Any]:
    """将 Message 序列化为前端可用的字典。

    reply_map: {msg_id: ReplyToPreview} 用于填充 reply_to_preview。
    reaction_map: {msg_id: {emoji: [user_id, ...]}} 用于填充 reactions。
    """
    data: dict[str, Any] = {
        "id": msg.id,
        "seq": msg.seq,
        "conversation_id": str(msg.conversation_id),
        "sender_id": msg.sender_id,
        "sender_type": getattr(msg, "sender_type", "user") or "user",
        "content": "" if msg.is_deleted else msg.content,
        "message_type": msg.message_type,
        "reply_to_id": msg.reply_to_id,
        "has_attachment": msg.has_attachment,
        "metadata": (
            {}
            if msg.is_deleted
            else {
                **(msg.metadata or {}),
                **(
                    {"client_request_id": msg.client_request_id}
                    if msg.client_request_id
                    else {}
                ),
            }
        ),
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
        "is_deleted": msg.is_deleted,
        "is_pinned": bool(getattr(msg, "is_pinned", False)),
        "pinned_at": msg.pinned_at.isoformat() if getattr(msg, "pinned_at", None) else None,
        "edited_at": msg.edited_at.isoformat() if getattr(msg, "edited_at", None) else None,
    }
    data["sender_name"] = sender_name

    if msg.reply_to_id and reply_map:
        data["reply_to_preview"] = reply_map.get(msg.reply_to_id)
    else:
        data["reply_to_preview"] = None

    data["reactions"] = dict(reaction_map.get(msg.id, {})) if reaction_map else {}

    return data


def _register_message_file_usages_by_id(msg_id: int, sender_id: str, metadata: dict) -> None:
    """在消息事务内注册 FileUsage；失败必须回滚消息，不能留下不可访问附件。"""
    from apps.services.oss.models import FileRecord, FileUsage

    file_id = metadata.get("file_id", "")
    record = FileRecord.objects.filter(id=file_id, status="completed").first()
    if not record:
        raise ValueError("附件不存在或已失效")

    FileUsage.add_usage(
        file_record=record,
        user_id=str(sender_id),
        module="tabchat",
        context_type="im_message",
        context_id=str(msg_id),
    )
    logger.info("TabChat 注册 FileUsage: message_id=%s, file_id=%s", msg_id, file_id)

def _safe_dispatch_message_created(msg: Message, conv: Conversation, sender_id: str) -> None:
    """on_commit 回调：发射通用 message_created signal。

    所有异常被吞掉——signal 是观察者模式增强点，绝不能反推影响消息发送主路径。
    """
    try:
        from apps.tabchat.signals import message_created

        message_created.send(
            sender=Message,
            message=msg,
            conversation=conv,
            sender_id=sender_id,
        )
    except Exception:
        logger.exception(
            "[tabchat] message_created signal dispatch failed: msg=%s", msg.id,
        )


def _safe_bridge_im_notifications(payload: dict) -> None:
    """on_commit 回调：把 IM 新消息桥接进通知中心。异常内部吞掉，不反推主链路。"""
    from apps.tabchat.services.im_notification_bridge import (
        bridge_message_notifications,
    )

    bridge_message_notifications(payload)


def _safe_enqueue_im_message_push(payload: dict) -> None:
    """on_commit 回调：由 Django IM 直接触发移动推送，不影响消息主链路。"""
    from django.conf import settings

    if getattr(settings, "RUNNING_TESTS", False):
        return
    try:
        from apps.services.notification.tasks import push_im_message

        push_im_message.delay(payload)
    except Exception:
        logger.exception(
            "[tabchat] IM mobile push enqueue failed: message=%s",
            payload.get("message_id"),
        )


def _safe_mark_im_conversation_read(user_id: str, conversation_id: str) -> None:
    """on_commit 回调：读会话后把铃铛里该会话的 IM 通知标已读。异常内部吞掉。"""
    from apps.tabchat.services.im_notification_bridge import (
        mark_im_conversation_read,
    )

    mark_im_conversation_read(user_id, conversation_id)


def _deactivate_message_file_usages(msg: Message, user_id: str) -> None:
    """软删除消息时 deactivate FileUsage（TCHAT-1 修复）。"""
    file_id = (msg.metadata or {}).get("file_id", "")
    if not file_id:
        return
    try:
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage

        organization_id = ""
        try:
            conv = Conversation.objects.get(pk=msg.conversation_id)
            organization_id = conv.organization_id or ""
        except Conversation.DoesNotExist:
            pass

        count = deactivate_file_usages_and_release_storage(
            module='tabchat',
            context_filter={
                'context_type': 'im_message',
                'context_id': str(msg.id),
            },
            organization_id=organization_id,
            user_id=str(user_id),
            biz_type='im_message_delete',
            biz_id=str(msg.id),
            log_prefix='[TabChat]',
        )
        if count:
            logger.info("TabChat 消息删除清理: message_id=%s, deactivated %d FileUsage(s)", msg.id, count)
    except Exception as e:
        logger.error("TabChat FileUsage deactivate 失败: message_id=%s, error=%s", msg.id, e, exc_info=True)


def _enqueue_agent_mention_job(job_id: str) -> None:
    from django.conf import settings

    if getattr(settings, "RUNNING_TESTS", False):
        return

    from apps.tabchat.tasks import dispatch_agent_mention

    try:
        dispatch_agent_mention.apply_async(
            args=[job_id],
            queue="tracker_agent",
        )
    except Exception:
        logger.exception(
            "[tabchat.ai] immediate enqueue failed; sweep will retry job=%s",
            job_id,
        )

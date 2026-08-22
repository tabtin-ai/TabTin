"""TC-37：会话 label 服务。

职责：label 库 CRUD + 给会话贴/撕 label + 序列化注入（含系统 label @me）。

label 是 per-(user, organization) 的会话标记，表达工作状态（项目 / 客户 / 待跟进 /
有 Agent 任务等）。其他成员看不到我的 label。系统 label @me 不入库，按
MessageMention / mention_all 与 ConversationUserState 水位动态注入。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from django.db import transaction
from django.db.models import BigIntegerField, Count, F, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce

from apps.tabchat.models import (
    Conversation,
    ConversationLabel,
    ConversationMember,
    ConversationUserState,
    Message,
)
from apps.tabchat.services.im_outbox_service import IMOutboxService
from apps.tabchat.services.message_visibility import apply_user_message_visibility
from apps.tabchat.utils import is_conversation_user_active, is_organization_member
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

# 系统 label 固定 id（不入库，序列化时动态注入）
SYSTEM_LABEL_MENTION = "sys:mention"

# label 名校验：1-32 字符，不允许首尾空白
_LABEL_NAME_RE = re.compile(r"^\S.{0,30}\S$|^\S$")
# hex 颜色校验：#RRGGBB
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _validate_label_name(name: str) -> str:
    """校验并归一化 label 名。"""
    name = (name or "").strip()
    if not name or len(name) > 32:
        raise ValueError("label 名长度需在 1-32 字符之间")
    return name


def _validate_color(color: str) -> str:
    """校验 hex 颜色，不合法则回退默认灰。"""
    color = (color or "").strip()
    if not color or not _COLOR_RE.match(color):
        return "#6b7280"
    return color.lower()


def _serialize_label(label: ConversationLabel, *, conversation_count: int = 0) -> dict[str, Any]:
    return {
        "id": str(label.id),
        "name": label.name,
        "color": label.color,
        "conversation_count": conversation_count,
        "is_system": False,
    }


def _system_mention_label() -> dict[str, Any]:
    return {
        "id": SYSTEM_LABEL_MENTION,
        "name": "@me",
        "color": "#ef4444",
        "conversation_count": 0,  # 系统 label 不统计
        "is_system": True,
    }


class LabelService:
    """会话 label 服务。"""

    # ── label 库 CRUD ──

    @staticmethod
    def list_labels(organization_id: str, user_id: str) -> list[dict[str, Any]]:
        """列出当前用户在当前 organization 的 label 库（含每个 label 的会话数）。

        会话数只统计当前用户仍是成员的会话（避免删成员后计数残留）。
        """
        if not is_organization_member(organization_id, user_id):
            raise PermissionError("无权访问该组织")

        # 用户的 label 库
        labels = list(
            ConversationLabel.objects.filter(
                user_id=user_id, organization_id=organization_id
            ).order_by("name")
        )
        if not labels:
            return []

        # 用户仍是成员的会话 id 集
        member_conv_ids = set(
            ConversationMember.objects.filter(
                user_id=user_id,
                conversation__organization_id=organization_id,
            ).values_list("conversation_id", flat=True)
        )

        # 每个 label 关联的成员里，属于上述会话集的计数
        label_ids = [l.id for l in labels]
        counts: dict[str, int] = {}
        for row in (
            ConversationMember.labels.through.objects.filter(
                conversationlabel_id__in=label_ids,
                conversationmember__user_id=user_id,
                conversationmember__conversation_id__in=member_conv_ids,
            )
            .values("conversationlabel_id")
            .annotate(cnt=Count("id"))
        ):
            counts[str(row["conversationlabel_id"])] = row["cnt"]

        return [
            _serialize_label(l, conversation_count=counts.get(str(l.id), 0))
            for l in labels
        ]

    @staticmethod
    def create_label(
        organization_id: str, user_id: str, name: str, color: str = "#6b7280"
    ) -> dict[str, Any]:
        """创建 label。重名抛 ValueError。"""
        if not is_organization_member(organization_id, user_id):
            raise PermissionError("无权访问该组织")

        name = _validate_label_name(name)
        color = _validate_color(color)

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                label = ConversationLabel.objects.create(
                    user_id=user_id,
                    organization_id=organization_id,
                    name=name,
                    color=color,
                )
        except Exception:
            # 唯一约束冲突
            if ConversationLabel.objects.filter(
                user_id=user_id, organization_id=organization_id, name=name
            ).exists():
                raise ValueError(f"label「{name}」已存在")
            raise

        return _serialize_label(label, conversation_count=0)

    @staticmethod
    def update_label(
        label_id: str, user_id: str, *, name: str | None = None, color: str | None = None
    ) -> dict[str, Any]:
        """改名 / 改色。"""
        try:
            label = ConversationLabel.objects.get(pk=label_id, user_id=user_id)
        except ConversationLabel.DoesNotExist:
            raise ValueError("label 不存在")

        updates: dict[str, Any] = {}
        if name is not None:
            updates["name"] = _validate_label_name(name)
        if color is not None:
            updates["color"] = _validate_color(color)

        if not updates:
            return _serialize_label(label, conversation_count=0)

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                for field, value in updates.items():
                    setattr(label, field, value)
                label.save(update_fields=list(updates.keys()))
        except Exception:
            if "name" in updates and ConversationLabel.objects.filter(
                user_id=user_id, organization_id=label.organization_id, name=updates["name"]
            ).exclude(pk=label.pk).exists():
                raise ValueError(f"label「{updates['name']}」已存在")
            raise

        return _serialize_label(label, conversation_count=0)

    @staticmethod
    def delete_label(label_id: str, user_id: str) -> int:
        """删除 label。返回被撕掉的会话数。M2M 关系随 label 删除自动清理。"""
        try:
            label = ConversationLabel.objects.get(pk=label_id, user_id=user_id)
        except ConversationLabel.DoesNotExist:
            raise ValueError("label 不存在")

        affected = label.conversation_members.count()
        with transaction.atomic(using=postgres_app_db_alias()):
            label.delete()
        return affected

    # ── 会话打标 ──

    @staticmethod
    def add_labels_to_conversation(
        conversation_id: str, user_id: str, label_ids: list[str]
    ) -> dict[str, Any]:
        """给会话追加 label。返回当前会话所有 label（含系统 @me）。"""
        if not is_conversation_user_active(conversation_id, user_id):
            raise PermissionError("无权操作该会话")

        member = ConversationMember.objects.filter(
            conversation_id=conversation_id, user_id=user_id
        ).first()
        if not member:
            raise PermissionError("不是该会话的成员")

        # 校验所有 label 属于该用户（organization 隐含 = 会话 organization）
        conv = Conversation.objects.get(pk=conversation_id)
        valid_labels = ConversationLabel.objects.filter(
            pk__in=label_ids, user_id=user_id, organization_id=conv.organization_id
        )
        if len(valid_labels) != len(set(label_ids)):
            raise ValueError("部分 label 不存在或不属于当前组织")

        with transaction.atomic(using=postgres_app_db_alias()):
            member.labels.add(*valid_labels)

            # 含系统 @me：用 compute_labels_for_conversations 而非 get_conversation_labels_raw，
            # 避免前端整表替换时把仍存在的未读 @ 标记清掉（bugbot high）。
            labels_payload = LabelService.compute_labels_for_conversations(
                conv.organization_id, user_id, [conversation_id]
            ).get(conversation_id, [])
            IMOutboxService.enqueue(
                organization_id=str(conv.organization_id),
                event_type="im.conversation.labels.updated",
                target_channels=[f"personal:{user_id}"],
                data={
                    "conversation_id": conversation_id,
                    "labels": labels_payload,
                },
                conversation=conv,
            )

        return {"conversation_id": conversation_id, "labels": labels_payload}

    @staticmethod
    def remove_label_from_conversation(
        conversation_id: str, user_id: str, label_id: str
    ) -> dict[str, Any]:
        """撕掉单个 label。返回当前会话所有 label（含系统 @me）。"""
        if not is_conversation_user_active(conversation_id, user_id):
            raise PermissionError("无权操作该会话")

        member = ConversationMember.objects.filter(
            conversation_id=conversation_id, user_id=user_id
        ).first()
        if not member:
            raise PermissionError("不是该会话的成员")

        conv = Conversation.objects.get(pk=conversation_id)
        with transaction.atomic(using=postgres_app_db_alias()):
            member.labels.remove(label_id)

            # 含系统 @me（同 add_labels_to_conversation）。
            labels_payload = LabelService.compute_labels_for_conversations(
                conv.organization_id, user_id, [conversation_id]
            ).get(conversation_id, [])
            IMOutboxService.enqueue(
                organization_id=str(conv.organization_id),
                event_type="im.conversation.labels.updated",
                target_channels=[f"personal:{user_id}"],
                data={
                    "conversation_id": conversation_id,
                    "labels": labels_payload,
                },
                conversation=conv,
            )

        return {"conversation_id": conversation_id, "labels": labels_payload}

    @staticmethod
    def get_conversation_labels_raw(
        conversation_id: str, user_id: str
    ) -> list[dict[str, Any]]:
        """获取会话当前 label（原始格式，不含系统 label）。"""
        try:
            member = ConversationMember.objects.get(
                conversation_id=conversation_id, user_id=user_id
            )
        except ConversationMember.DoesNotExist:
            return []
        labels = list(member.labels.all().order_by("name"))
        return [
            {
                "id": str(l.id),
                "name": l.name,
                "color": l.color,
                "is_system": False,
            }
            for l in labels
        ]

    # ── 序列化注入（供 conversation_service 调用） ──

    @staticmethod
    def compute_labels_for_conversations(
        organization_id: str, user_id: str, conversation_ids: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        """批量计算多个会话的 label（含系统 @me）。

        返回 {conversation_id: [label_dict, ...]}。
        """
        result: dict[str, list[dict[str, Any]]] = {
            str(cid): [] for cid in conversation_ids
        }
        if not conversation_ids:
            return result

        # 1. 自定义 label（M2M）
        members = (
            ConversationMember.objects.filter(
                user_id=user_id,
                conversation_id__in=conversation_ids,
            )
            .prefetch_related("labels")
        )
        for m in members:
            cid = str(m.conversation_id)
            for l in m.labels.all():
                result[cid].append({
                    "id": str(l.id),
                    "name": l.name,
                    "color": l.color,
                    "is_system": False,
                })

        # 2. 系统 label @me：该会话有未读且被 @ 的消息
        unread_mention_conv_ids = LabelService._unread_mention_conversation_ids(
            user_id,
            conversation_ids,
        )
        sys_label = _system_mention_label()
        for cid in unread_mention_conv_ids:
            result[str(cid)].append(sys_label)

        return result

    @staticmethod
    def has_unread_mention(conversation_id: str, user_id: str) -> bool:
        """单会话是否有未读 @me（用于详情接口）。"""
        return bool(
            LabelService._unread_mention_conversation_ids(
                user_id,
                [conversation_id],
            )
        )

    @staticmethod
    def _unread_mention_conversation_ids(
        user_id: str,
        conversation_ids: list[str],
    ) -> set[str]:
        if not conversation_ids:
            return set()
        state_qs = ConversationUserState.objects.filter(
            conversation_id=OuterRef("conversation_id"),
            user_id=user_id,
        )
        queryset = (
            Message.objects
            .filter(
                conversation_id__in=conversation_ids,
                counts_as_unread=True,
                is_deleted=False,
            )
            .exclude(sender_id=user_id, sender_type="user")
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
            .filter(Q(mentions__user_id=user_id) | Q(mention_all=True))
        )
        queryset = apply_user_message_visibility(
            queryset,
            user_id=user_id,
            history_cleared_seq=0,
            conversation_ids=conversation_ids,
        )
        queryset = queryset.values_list("conversation_id", flat=True).distinct()
        return {str(conversation_id) for conversation_id in queryset}

    # ── 筛选 ──

    @staticmethod
    def filter_conversation_ids_by_labels(
        organization_id: str,
        user_id: str,
        conversation_ids: list[str],
        label_ids: list[str],
    ) -> list[str]:
        """按 label AND 筛选会话 id。

        系统 label sys:mention 特判：筛有未读 @me 的会话。
        自定义 label：会话必须带所有指定 label（AND）。
        """
        if not label_ids or not conversation_ids:
            return conversation_ids

        result_ids = set(conversation_ids)
        custom_label_ids: list[str] = []
        mention_filter = False

        for lid in label_ids:
            if lid == SYSTEM_LABEL_MENTION:
                mention_filter = True
            else:
                custom_label_ids.append(lid)

        # 自定义 label AND 筛选
        if custom_label_ids:
            for lid in custom_label_ids:
                convs_with_label = {
                    str(cid) for cid in ConversationMember.objects.filter(
                        user_id=user_id,
                        conversation_id__in=list(result_ids),
                        labels__id=lid,
                    ).values_list("conversation_id", flat=True)
                }
                result_ids &= convs_with_label

        # 系统 @me 筛选
        if mention_filter:
            mention_conv_ids = LabelService._unread_mention_conversation_ids(
                user_id,
                list(result_ids),
            )
            result_ids &= mention_conv_ids

        return [str(cid) for cid in result_ids]

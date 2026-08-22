"""记录详情内部评论服务。

评论写入只使用认证 User 作为授权主体。展示 actor 可来自服务端进程内的
``current execution agent`` 上下文，或由归属同一用户、组织和会话的可信执行记录
反查得到；客户端透传值不得直接参与权限判断或 Agent 身份判定。
"""

from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.services.common.platform_context import (
    get_current_run_id,
    get_current_session_id,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import (
    RecordComment,
    Table,
    TableField,
    TableRecord,
    TableView,
)
from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
from apps.tabdata.native.query_builder import NativeQueryBuilder, merge_where
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.services.base import BaseService
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.rls_service import build_rls_select_where
from apps.tabdata.services.view_filter_service import resolve_effective_filter
from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)


logger = logging.getLogger(__name__)


MAX_COMMENT_LENGTH = 2000
MAX_CLIENT_REQUEST_ID_LENGTH = 100
MAX_MENTION_USERS = 50
MAX_MENTION_CANDIDATES = 200
MAX_COUNT_RECORDS = 100
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


@dataclass(frozen=True)
class CommentActor:
    type: str
    id: str
    name: str


@dataclass(frozen=True)
class CommentAttribution:
    actor: CommentActor
    agent_run_id: str = ""
    session_id: str = ""


class RecordCommentService(BaseService):
    """记录评论的权限、幂等、分页和身份快照边界。"""

    def list_comments(
        self,
        record_id: UUID,
        *,
        status: str | None = None,
        before: str | None = None,
        cursor: str | None = None,
        anchor: UUID | None = None,
        limit: int = DEFAULT_PAGE_SIZE,
        include_audit: bool = False,
        rls_context=None,
        share_grant=None,
    ) -> dict:
        record = self._get_visible_record(
            record_id,
            rls_context=rls_context,
            share_grant=share_grant,
        )
        page_size = self._normalize_limit(limit)
        status_filter = self._normalize_status_filter(status)

        base_comments = RecordComment.objects.using(TABDATA_DB_ALIAS).filter(
            record_id=record.id,
        )
        roots = base_comments.filter(parent__isnull=True)
        open_thread_total = roots.filter(
            is_deleted=False,
            status=RecordComment.Status.OPEN,
        ).count()

        if status_filter is None:
            # 兼容旧客户端：不传 status 时保持“全部未删除消息”的原有平铺语义。
            comments = base_comments.filter(is_deleted=False)
            thread_total = roots.filter(is_deleted=False).count()
        else:
            selected_roots = roots
            if status_filter != "all":
                selected_roots = selected_roots.filter(
                    is_deleted=False,
                    status=status_filter,
                )
            thread_total = selected_roots.count()
            all_root_ids = list(selected_roots.values_list("id", flat=True))
            all_comment_ids = self._thread_comment_ids(record.id, all_root_ids)
            all_comments = base_comments.filter(id__in=all_comment_ids)
            if status_filter != "all":
                all_comments = all_comments.filter(is_deleted=False)
            total = all_comments.count()

            if anchor is not None and (before or cursor):
                raise ValueError("anchor 不能与 before/cursor 同时使用")
            if anchor is not None:
                anchor_comment = all_comments.select_related(
                    "parent", "parent__parent"
                ).filter(id=anchor).first()
                if anchor_comment is None:
                    raise RecordComment.DoesNotExist("评论不存在")
                anchor_root = self._get_thread_root(anchor_comment)
                selected_roots = selected_roots.filter(
                    Q(created_at__lt=anchor_root.created_at)
                    | Q(created_at=anchor_root.created_at, id__lte=anchor_root.id)
                )
            elif boundary := before or cursor:
                cursor_at, cursor_id = self._decode_cursor(boundary, record.id)
                selected_roots = selected_roots.filter(
                    Q(created_at__lt=cursor_at)
                    | Q(created_at=cursor_at, id__lt=cursor_id)
                )

            root_rows = list(
                selected_roots.select_related("resolved_by")
                .order_by("-created_at", "-id")[: page_size + 1]
            )
            has_more = len(root_rows) > page_size
            page_roots = list(reversed(root_rows[:page_size]))
            page_root_ids = [root.id for root in page_roots]
            page_comment_ids = self._thread_comment_ids(record.id, page_root_ids)
            comments = base_comments.filter(id__in=page_comment_ids)
            if status_filter != "all":
                comments = comments.filter(is_deleted=False)
            comments = list(
                comments.select_related(
                    "parent",
                    "parent__parent",
                    "resolved_by",
                    "parent__resolved_by",
                    "parent__parent__resolved_by",
                ).order_by("created_at", "id")
            )
            roots_by_id = {root.id: root for root in page_roots}
            next_cursor = None
            if has_more and page_roots:
                oldest = page_roots[0]
                next_cursor = self._encode_cursor(
                    record.id, oldest.created_at, oldest.id
                )
            return {
                "comments": [
                    self.serialize_comment(
                        comment,
                        include_audit=include_audit,
                        table_id=record.table_id,
                        thread_root=roots_by_id.get(self._get_thread_root(comment).id),
                        redact_deleted=True,
                    )
                    for comment in comments
                ],
                "total": total,
                "thread_total": thread_total,
                "open_thread_total": open_thread_total,
                "has_more": has_more,
                "next_cursor": next_cursor,
            }

        comments = comments.select_related(
            "parent",
            "parent__parent",
            "resolved_by",
            "parent__resolved_by",
            "parent__parent__resolved_by",
        )
        total = comments.count()

        if anchor is not None and (before or cursor):
            raise ValueError("anchor 不能与 before/cursor 同时使用")

        if anchor is not None:
            anchor_comment = comments.filter(id=anchor).first()
            if anchor_comment is None:
                raise RecordComment.DoesNotExist("评论不存在")
            comments = comments.filter(
                Q(created_at__lt=anchor_comment.created_at)
                | Q(created_at=anchor_comment.created_at, id__lte=anchor_comment.id)
            )
        elif boundary := before or cursor:
            cursor_at, cursor_id = self._decode_cursor(boundary, record.id)
            comments = comments.filter(
                Q(created_at__lt=cursor_at)
                | Q(created_at=cursor_at, id__lt=cursor_id)
            )

        rows = list(comments.order_by("-created_at", "-id")[: page_size + 1])
        has_more = len(rows) > page_size
        page = list(reversed(rows[:page_size]))
        next_cursor = None
        if has_more and page:
            oldest = page[0]
            next_cursor = self._encode_cursor(record.id, oldest.created_at, oldest.id)

        return {
            "comments": [
                self.serialize_comment(
                    comment,
                    include_audit=include_audit,
                    table_id=record.table_id,
                    thread_root=self._get_thread_root(comment),
                )
                for comment in page
            ],
            "total": total,
            "thread_total": thread_total,
            "open_thread_total": open_thread_total,
            "has_more": has_more,
            "next_cursor": next_cursor,
        }

    def list_mention_candidates(
        self,
        record_id: UUID,
        *,
        query: str = "",
        limit: int = DEFAULT_PAGE_SIZE,
        rls_context=None,
        share_grant=None,
    ) -> list[dict]:
        """返回同一组织中可在当前记录评论里 @ 的规范化成员候选。"""
        record = self._get_visible_record(
            record_id,
            rls_context=rls_context,
            share_grant=share_grant,
        )
        page_size = self._normalize_candidate_limit(limit)
        normalized_query = str(query or "").strip().lower()

        from apps.tabtinspace.models import OrganizationMember

        member_queryset = OrganizationMember.objects.using(TABDATA_DB_ALIAS).filter(
            organization_id=record.table.organization_id
        )
        if normalized_query:
            member_queryset = member_queryset.filter(
                Q(user__nickname__icontains=normalized_query)
                | Q(user__username__icontains=normalized_query)
                | Q(user__email__icontains=normalized_query)
            )
        member_user_ids = list(
            member_queryset
            .order_by("joined_at")
            .values_list("user_id", flat=True)[:MAX_MENTION_CANDIDATES]
        )
        user_ids = {str(user_id) for user_id in member_user_ids if user_id}
        owner_id = str(record.table.owner_id or "")
        if owner_id:
            user_ids.add(owner_id)
        if not user_ids:
            return []

        User = get_user_model()
        users = User.objects.using("default").filter(id__in=user_ids)
        candidates: list[dict] = []
        for member in users:
            nickname = str(getattr(member, "nickname", "") or "").strip()
            account_name = str(getattr(member, "username", "") or "").strip()
            email = str(getattr(member, "email", "") or "").strip()
            display_name = nickname or account_name or str(member.id)[:8]
            if normalized_query and normalized_query not in " ".join(
                (display_name, account_name, email)
            ).lower():
                continue

            from apps.services.oss.services.public_assets import build_public_asset_url

            candidates.append(
                {
                    "user_id": str(member.id),
                    "display_name": display_name,
                    "account_name": account_name or None,
                    "avatar": build_public_asset_url(
                        getattr(member, "avatar", "") or ""
                    )
                    or None,
                    "email": self._mask_email(email),
                }
            )

        candidates.sort(key=lambda item: (item["display_name"].lower(), item["user_id"]))
        return candidates[:page_size]

    def count_comments(
        self,
        table_id: UUID,
        *,
        record_ids: Iterable[object],
        status: str | None = None,
        rls_context=None,
    ) -> dict:
        """按记录返回活跃评论数；不可见记录从结果中省略。"""
        if not self.user or not getattr(self.user, "id", None):
            raise PermissionError("用户未登录")

        table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=table_id, trashed_at__isnull=True)
            .first()
        )
        if table is None or not self.check_table_permission(str(table.id), "viewer"):
            raise Table.DoesNotExist("表格不存在")

        normalized_ids = self._normalize_record_ids(record_ids)
        active_orm_ids = set(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table_id=table.id,
                id__in=normalized_ids,
                is_deleted=False,
            )
            .values_list("id", flat=True)
        )
        if not active_orm_ids:
            return {"counts": {}}

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id,
                is_deleted=False,
            )
        )
        partition_id = resolve_schema_partition_id(table)
        query_builder = NativeQueryBuilder(partition_id, table.id, fields)
        id_where = query_builder.build_where_clause(
            {
                "conjunction": "and",
                "filterSet": [
                    {
                        "field_id": "__id",
                        "operator": "in",
                        "value": [str(record_id) for record_id in active_orm_ids],
                    }
                ],
            }
        )
        where = build_rls_select_where(
            table,
            rls_context,
            query_builder,
            id_where,
        )
        rows, _ = NativeRecordIO(
            partition_id,
            table.id,
            db_alias=TABDATA_DB_ALIAS,
        ).read_records(
            query_builder,
            where=where,
            limit=len(active_orm_ids),
            field_ids=[],
            include_count=False,
        )
        native_visible_ids = {
            UUID(str(row["__id"])) for row in rows if row.get("__id")
        }
        visible_ids = [
            record_id
            for record_id in normalized_ids
            if record_id in active_orm_ids and record_id in native_visible_ids
        ]

        if not visible_ids:
            return {"counts": {}}

        aggregate = {
            str(row["record_id"]): int(row["count"])
            for row in (
                RecordComment.objects.using(TABDATA_DB_ALIAS)
                .filter(record_id__in=visible_ids, is_deleted=False)
                .values("record_id")
                .annotate(count=Count("id"))
            )
        }
        result = {
            "counts": {
                str(record_id): aggregate.get(str(record_id), 0)
                for record_id in visible_ids
            }
        }
        status_filter = self._normalize_status_filter(status)
        if status_filter is None:
            return result

        rows = list(
            RecordComment.objects.using(TABDATA_DB_ALIAS)
            .filter(record_id__in=visible_ids)
            .values("id", "record_id", "parent_id", "status", "is_deleted")
        )
        by_id = {row["id"]: row for row in rows}

        def root_for(row):
            seen = set()
            current = row
            while current["parent_id"] is not None and current["parent_id"] not in seen:
                seen.add(current["id"])
                parent = by_id.get(current["parent_id"])
                if parent is None:
                    break
                current = parent
            return current

        selected_roots = {}
        for row in rows:
            if row["parent_id"] is not None:
                continue
            selected = status_filter == "all" or (
                not row["is_deleted"] and row["status"] == status_filter
            )
            if selected:
                selected_roots[row["id"]] = row

        filtered_counts = {str(record_id): 0 for record_id in visible_ids}
        thread_counts = {str(record_id): 0 for record_id in visible_ids}
        for root in selected_roots.values():
            thread_counts[str(root["record_id"])] += 1
        for row in rows:
            root = root_for(row)
            if root["id"] not in selected_roots:
                continue
            if status_filter != "all" and row["is_deleted"]:
                continue
            filtered_counts[str(row["record_id"])] += 1

        return {
            "counts": filtered_counts,
            "thread_counts": thread_counts,
        }

    def create_comment(
        self,
        record_id: UUID,
        *,
        content: str,
        client_request_id: str | None = None,
        mentions: Iterable[object] | None = None,
        reply_to_comment_id: UUID | None = None,
        rls_context=None,
        share_grant=None,
    ) -> tuple[RecordComment, bool]:
        record = self._get_visible_record(
            record_id,
            rls_context=rls_context,
            share_grant=share_grant,
        )
        normalized_content = self._normalize_content(content)
        normalized_request_id = self._normalize_client_request_id(client_request_id)

        if normalized_request_id:
            existing = self._idempotent_comment(record.id, normalized_request_id)
            if existing is not None:
                return existing, False

        reply_to_comment = None
        if reply_to_comment_id is not None:
            reply_to_comment = (
                RecordComment.objects.using(TABDATA_DB_ALIAS)
                .filter(id=reply_to_comment_id, record_id=record.id, is_deleted=False)
                .first()
            )
            if reply_to_comment is None:
                raise RecordComment.DoesNotExist("回复的评论不存在")

        assert_organization_resource_write_allowed_optional(record.table.organization_id)
        author_name = self._user_display_name(self.user)
        attribution = self._resolve_comment_attribution(record)
        actor = attribution.actor
        normalized_mentions = self._normalize_mentions(
            mentions,
            record=record,
        )

        values = {
            "record_id": record.id,
            "content": normalized_content,
            "mentions": normalized_mentions,
            "author_id": self.user.id,
            "author_name": author_name,
            "actor_type": actor.type,
            "actor_id": actor.id,
            "actor_name": actor.name,
            "client_request_id": normalized_request_id,
            "agent_run_id": attribution.agent_run_id,
            "session_id": attribution.session_id,
            "parent_id": reply_to_comment.id if reply_to_comment else None,
        }

        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                comment = RecordComment.objects.using(TABDATA_DB_ALIAS).create(**values)
        except IntegrityError:
            if not normalized_request_id:
                raise
            comment = self._idempotent_comment(record.id, normalized_request_id)
            if comment is None:
                raise
            return comment, False

        self._schedule_created_side_effects(comment, record)
        return comment, True

    def delete_comment(
        self,
        record_id: UUID,
        comment_id: UUID,
        *,
        rls_context=None,
        share_grant=None,
    ) -> RecordComment:
        record = self._get_visible_record(
            record_id,
            rls_context=rls_context,
            share_grant=share_grant,
        )
        comment = (
            RecordComment.objects.using(TABDATA_DB_ALIAS)
            .filter(id=comment_id, record_id=record.id)
            .first()
        )
        if comment is None:
            raise RecordComment.DoesNotExist("评论不存在")
        if str(comment.author_id or "") != str(getattr(self.user, "id", "")):
            raise PermissionError("只能删除自己发布的评论")
        if comment.is_deleted:
            return comment

        assert_organization_resource_write_allowed_optional(record.table.organization_id)
        deleted_at = timezone.now()
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            updated = RecordComment.objects.using(TABDATA_DB_ALIAS).filter(
                id=comment.id,
                author_id=self.user.id,
                is_deleted=False,
            ).update(
                is_deleted=True,
                deleted_at=deleted_at,
                updated_at=deleted_at,
            )
            if updated:
                self._schedule_comment_invalidation(
                    table_id=record.table_id,
                    comment_id=comment.id,
                )
        if not updated:
            comment.refresh_from_db(using=TABDATA_DB_ALIAS)
            return comment
        comment.is_deleted = True
        comment.deleted_at = deleted_at
        comment.updated_at = deleted_at
        return comment

    def update_thread_status(
        self,
        record_id: UUID,
        thread_id: UUID,
        *,
        status: str,
        rls_context=None,
        share_grant=None,
    ) -> RecordComment:
        record = self._get_visible_record(
            record_id,
            rls_context=rls_context,
            share_grant=share_grant,
        )
        requested_status = self._normalize_thread_status(status)
        comment = (
            RecordComment.objects.using(TABDATA_DB_ALIAS)
            .filter(id=thread_id, record_id=record.id)
            .select_related("parent", "parent__parent", "resolved_by")
            .first()
        )
        if comment is None:
            raise RecordComment.DoesNotExist("评论线程不存在")
        root = self._get_thread_root(comment)
        if root.is_deleted:
            raise RecordComment.DoesNotExist("评论线程不存在")
        if root.status == requested_status:
            return root

        assert_organization_resource_write_allowed_optional(record.table.organization_id)
        changed_at = timezone.now()
        values = {
            "status": requested_status,
            "resolved_by_id": self.user.id
            if requested_status == RecordComment.Status.RESOLVED
            else None,
            "resolved_at": changed_at
            if requested_status == RecordComment.Status.RESOLVED
            else None,
            "updated_at": changed_at,
        }
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            RecordComment.objects.using(TABDATA_DB_ALIAS).filter(id=root.id).update(**values)
            self._schedule_comment_invalidation(
                table_id=record.table_id,
                comment_id=root.id,
            )
        root.status = requested_status
        root.resolved_by = (
            self.user if requested_status == RecordComment.Status.RESOLVED else None
        )
        root.resolved_at = values["resolved_at"]
        root.updated_at = changed_at
        return root

    def serialize_comment(
        self,
        comment: RecordComment,
        *,
        include_audit: bool = False,
        table_id: UUID | None = None,
        thread_root: RecordComment | None = None,
        redact_deleted: bool = False,
    ) -> dict:
        root = thread_root or self._get_thread_root(comment)
        subject_id = str(comment.author_id) if comment.author_id else ""
        subject_name = comment.author_name or "未知用户"
        actor_type = (
            comment.actor_type
            if comment.actor_type in {
                RecordComment.ACTOR_TYPE_HUMAN,
                RecordComment.ACTOR_TYPE_AGENT,
            }
            else RecordComment.ACTOR_TYPE_HUMAN
        )
        actor_id = comment.actor_id or subject_id
        actor_name = comment.actor_name or subject_name
        can_delete = bool(
            not comment.is_deleted
            and subject_id
            and subject_id == str(getattr(self.user, "id", ""))
        )
        payload = {
            "id": str(comment.id),
            "record_id": str(comment.record_id),
            "content": ""
            if comment.is_deleted and redact_deleted
            else comment.content,
            "mentions": []
            if comment.is_deleted and redact_deleted
            else list(comment.mentions or []),
            "actor": {
                "type": actor_type,
                "id": actor_id,
                "name": actor_name,
            },
            "authorization_subject": {
                "type": "user",
                "id": subject_id,
                "name": subject_name,
            },
            "client_request_id": comment.client_request_id,
            "reply_to": self._serialize_reply_target(comment),
            "is_deleted": bool(comment.is_deleted),
            "created_at": comment.created_at.isoformat(),
            "updated_at": comment.updated_at.isoformat(),
            "deleted_at": comment.deleted_at.isoformat() if comment.deleted_at else None,
            "capabilities": {"can_delete": can_delete},
            "thread": self.serialize_thread(root),
        }
        if include_audit and self._can_view_comment_audit(
            comment,
            table_id=table_id,
        ):
            payload["audit"] = {
                "agent_run_id": comment.agent_run_id or None,
                "session_id": comment.session_id or None,
            }
        return payload

    def serialize_thread(self, root: RecordComment) -> dict:
        can_change_status = bool(
            not root.is_deleted
            and getattr(self.user, "id", None)
        )
        return {
            "id": str(root.id),
            "status": root.status
            if root.status in RecordComment.Status.values
            else RecordComment.Status.OPEN,
            "resolved_by_user_id": (
                str(root.resolved_by_id) if root.resolved_by_id else None
            ),
            "resolved_by_name": (
                self._user_display_name(root.resolved_by)
                if root.resolved_by_id and root.resolved_by
                else None
            ),
            "resolved_at": root.resolved_at.isoformat() if root.resolved_at else None,
            "capabilities": {
                "can_resolve": can_change_status
                and root.status == RecordComment.Status.OPEN,
                "can_reopen": can_change_status
                and root.status == RecordComment.Status.RESOLVED,
            },
        }

    @staticmethod
    def _serialize_reply_target(comment: RecordComment) -> dict | None:
        if not comment.parent_id:
            return None
        parent = comment.parent
        return {
            "id": str(parent.id),
            "author_name": parent.actor_name or parent.author_name or "未知用户",
            "content": "" if parent.is_deleted else parent.content,
            "is_deleted": bool(parent.is_deleted),
        }

    def _can_view_comment_audit(
        self,
        comment: RecordComment,
        *,
        table_id: UUID | None = None,
    ) -> bool:
        user_id = str(getattr(self.user, "id", "") or "")
        if not user_id:
            return False
        if str(comment.author_id or "") == user_id:
            return True
        resolved_table_id = table_id
        if resolved_table_id is None:
            resolved_table_id = (
                TableRecord.objects.using(TABDATA_DB_ALIAS)
                .filter(id=comment.record_id)
                .values_list("table_id", flat=True)
                .first()
            )
        return bool(
            resolved_table_id
            and self.check_table_permission(str(resolved_table_id), "admin")
        )

    def _get_visible_record(
        self,
        record_id: UUID,
        *,
        rls_context=None,
        share_grant=None,
    ) -> TableRecord:
        if not self.user or not getattr(self.user, "id", None):
            raise PermissionError("用户未登录")

        if share_grant is not None:
            return self._get_shared_visible_record(
                record_id,
                share_grant=share_grant,
                rls_context=rls_context,
            )

        visible = RecordService(user=self.user).get_record_data(
            record_id,
            rls_context=rls_context,
        )
        if not visible:
            raise TableRecord.DoesNotExist("记录不存在")

        record = (
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .select_related("table")
            .filter(id=record_id, is_deleted=False)
            .first()
        )
        if record is None:
            raise TableRecord.DoesNotExist("记录不存在")
        return record

    @staticmethod
    def _thread_comment_ids(record_id: UUID, root_ids: list[UUID]) -> set[UUID]:
        """返回根评论及全部后代 ID；兼容首期曾允许回复回复的存量数据。"""
        selected = set(root_ids)
        frontier = set(root_ids)
        while frontier:
            children = set(
                RecordComment.objects.using(TABDATA_DB_ALIAS)
                .filter(record_id=record_id, parent_id__in=frontier)
                .values_list("id", flat=True)
            )
            children -= selected
            if not children:
                break
            selected.update(children)
            frontier = children
        return selected

    @staticmethod
    def _get_thread_root(comment: RecordComment) -> RecordComment:
        current = comment
        seen: set[UUID] = set()
        while current.parent_id and current.id not in seen:
            seen.add(current.id)
            current = current.parent
        return current

    def _get_shared_visible_record(
        self,
        record_id: UUID,
        *,
        share_grant,
        rls_context=None,
    ) -> TableRecord:
        """验证记录同时命中分享表、分享视图与 RLS，失败统一按不存在处理。"""
        if getattr(share_grant, "permission", None) not in {"comment", "edit"}:
            raise PermissionError("分享链接不允许评论")
        if getattr(share_grant, "share_type", None) == "form":
            raise PermissionError("分享链接不允许评论")
        if share_grant.is_expired():
            raise TableRecord.DoesNotExist("记录不存在")

        record = (
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .select_related("table", "table__default_view")
            .filter(
                id=record_id,
                table_id=share_grant.table_id,
                is_deleted=False,
                table__trashed_at__isnull=True,
            )
            .first()
        )
        if record is None:
            raise TableRecord.DoesNotExist("记录不存在")

        view = share_grant.view if getattr(share_grant, "view_id", None) else None
        if view is None:
            view = record.table.default_view
        if view is None:
            view = (
                TableView.objects.using(TABDATA_DB_ALIAS)
                .filter(table_id=record.table_id)
                .order_by("order", "created_at")
                .first()
            )
        if view is None or str(view.table_id) != str(record.table_id):
            raise TableRecord.DoesNotExist("记录不存在")

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=record.table_id,
                is_deleted=False,
            )
        )
        partition_id = resolve_schema_partition_id(record.table)
        query_builder = NativeQueryBuilder(partition_id, record.table_id, fields)
        view_where = query_builder.build_where_clause(
            resolve_effective_filter(view, None, None)
        )
        record_where = ('"__id" = %s', [str(record.id)])
        where = merge_where(view_where, record_where)
        where = build_rls_select_where(
            record.table,
            rls_context,
            query_builder,
            where,
        )
        visible_count = NativeRecordIO(
            partition_id,
            record.table_id,
            db_alias=TABDATA_DB_ALIAS,
        ).count_records(where=where)
        if visible_count != 1:
            raise TableRecord.DoesNotExist("记录不存在")
        return record

    @staticmethod
    def _schedule_created_side_effects(
        comment: RecordComment,
        record: TableRecord,
    ) -> None:
        """仅在首次插入提交后广播失效，并给有效 mentions 发通知。"""
        table_id = str(record.table_id)
        organization_id = str(record.table.organization_id)
        space_id = str(record.table.space_id or "")
        table_name = str(record.table.name or "")
        record_id = str(record.id)
        comment_id = str(comment.id)
        actor_name = str(comment.actor_name or comment.author_name or "成员")
        body = " ".join(str(comment.content or "").split())[:120]
        mention_user_ids = tuple(str(user_id) for user_id in (comment.mentions or []))

        RecordCommentService._schedule_comment_invalidation(
            table_id=table_id,
            comment_id=comment_id,
        )
        if not mention_user_ids:
            return

        def _after_commit() -> None:
            from apps.services.notification.services.notification_service import (
                NotificationService,
            )

            for mentioned_user_id in mention_user_ids:
                try:
                    source_event_id = (
                        f"tabdata.comment:{comment_id}:mention:{mentioned_user_id}"
                    )
                    NotificationService.notify(
                        user_id=mentioned_user_id,
                        type="tabdata.comment.mention",
                        title=f"{actor_name} 在「{table_name}」中提及了你",
                        body=body,
                        organization_id=organization_id,
                        metadata={
                            "source_event_id": source_event_id,
                            "resource_type": "table",
                            "resource_id": table_id,
                            "resource_title": table_name,
                            "table_id": table_id,
                            "record_id": record_id,
                            "comment_id": comment_id,
                            "space_id": space_id,
                            "category": "collaboration",
                            "action": "mentioned",
                            "behavior": "view_context",
                        },
                    )
                except Exception:
                    logger.warning(
                        "评论提及通知发送失败: comment_id=%s user_id=%s",
                        comment_id,
                        mentioned_user_id,
                        exc_info=True,
                    )

        transaction.on_commit(_after_commit, using=TABDATA_DB_ALIAS)

    @staticmethod
    def _schedule_comment_invalidation(*, table_id: object, comment_id: object) -> None:
        """提交后发送表级泛化失效；RLS topic 不包含记录或评论标识。"""
        normalized_table_id = str(table_id)
        normalized_comment_id = str(comment_id)

        def _after_commit() -> None:
            try:
                from apps.tabdata.services.table_event_service import (
                    table_event_service,
                )

                table_event_service.publish_comment_change(normalized_table_id)
            except Exception:
                logger.warning(
                    "评论失效事件发送失败: table_id=%s comment_id=%s",
                    normalized_table_id,
                    normalized_comment_id,
                    exc_info=True,
                )

        transaction.on_commit(_after_commit, using=TABDATA_DB_ALIAS)

    def _idempotent_comment(
        self,
        record_id: UUID,
        client_request_id: str,
    ) -> RecordComment | None:
        return (
            RecordComment.objects.using(TABDATA_DB_ALIAS)
            .filter(
                record_id=record_id,
                author_id=self.user.id,
                client_request_id=client_request_id,
            )
            .first()
        )

    def _resolve_comment_attribution(self, record: TableRecord) -> CommentAttribution:
        """解析可信展示 actor 和审计锚点；授权主体始终是认证用户。"""
        try:
            from apps.services.common.thread_context import (
                get_current_execution_agent_id,
            )

            execution_agent_id = get_current_execution_agent_id()
        except Exception:
            execution_agent_id = None

        audit_run_id = ""
        audit_session_id = ""
        if execution_agent_id:
            audit_run_id, audit_session_id = self._normalized_context_audit_pair()
        else:
            verified = self._resolve_agent_from_run_context(record)
            if verified is not None:
                execution_agent_id, audit_run_id, audit_session_id = verified

        if execution_agent_id:
            try:
                from apps.agent.models import Agent

                agent = (
                    Agent.objects.using(TABDATA_DB_ALIAS)
                    .filter(
                        id=execution_agent_id,
                        organization_id=record.table.organization_id,
                        is_active=True,
                    )
                    .only("id", "name")
                    .first()
                )
            except (TypeError, ValueError):
                agent = None
            if agent is not None:
                return CommentAttribution(
                    actor=CommentActor(
                        type=RecordComment.ACTOR_TYPE_AGENT,
                        id=str(agent.id),
                        name=(agent.name or str(agent.id))[:255],
                    ),
                    agent_run_id=audit_run_id,
                    session_id=audit_session_id,
                )

        return CommentAttribution(
            actor=CommentActor(
                type=RecordComment.ACTOR_TYPE_HUMAN,
                id=str(self.user.id),
                name=self._user_display_name(self.user),
            )
        )

    def _resolve_display_actor(self, record: TableRecord) -> CommentActor:
        """兼容只需要展示 actor 的内部调用。"""
        return self._resolve_comment_attribution(record).actor

    @staticmethod
    def _normalized_context_audit_pair() -> tuple[str, str]:
        run_id = str(get_current_run_id() or "").strip()
        session_id = str(get_current_session_id() or "").strip()
        if not run_id or not session_id:
            return "", ""

        try:
            normalized_run_id = UUID(run_id)
            normalized_session_id = UUID(session_id)
        except (TypeError, ValueError):
            return "", ""
        return str(normalized_run_id), str(normalized_session_id)

    def _resolve_agent_from_run_context(
        self,
        record: TableRecord,
    ) -> tuple[str, str, str] | None:
        normalized_run_id_raw, normalized_session_id_raw = (
            self._normalized_context_audit_pair()
        )
        if not normalized_run_id_raw or not normalized_session_id_raw:
            return None
        normalized_run_id = UUID(normalized_run_id_raw)
        normalized_session_id = UUID(normalized_session_id_raw)

        organization_id = str(record.table.organization_id)
        user_id = str(getattr(self.user, "id", "") or "")
        if not user_id:
            return None

        from apps.services.agent_engine.models import ExecutionRun, SessionRunProjection

        run_exists = ExecutionRun.objects.filter(
            run_id=normalized_run_id,
            user_id=user_id,
            organization_id=organization_id,
            session_id=str(normalized_session_id),
            status=ExecutionRun.Status.RUNNING,
        ).exists()
        if not run_exists:
            return None

        projection_is_current = SessionRunProjection.objects.filter(
            session_id=normalized_session_id,
            current_run_id=normalized_run_id,
        ).exists()
        if not projection_is_current:
            return None

        from apps.chat.conversation.models import ChatSession

        agent_id = (
            ChatSession.objects.filter(
                id=normalized_session_id,
                user_id=self.user.id,
                organization_id=organization_id,
                agent_id__isnull=False,
            )
            .values_list("agent_id", flat=True)
            .first()
        )
        if not agent_id:
            return None
        return (
            str(agent_id),
            str(normalized_run_id),
            str(normalized_session_id),
        )

    def _normalize_mentions(
        self,
        mentions: Iterable[object] | None,
        *,
        record: TableRecord,
    ) -> list[str]:
        if not mentions:
            return []

        author_id = str(self.user.id)
        candidates: list[str] = []
        seen: set[str] = set()
        for raw_id in mentions:
            raw = str(raw_id or "").strip()
            if not raw or raw == author_id or raw in seen:
                continue
            try:
                normalized = str(UUID(raw))
            except (TypeError, ValueError):
                continue
            if normalized == author_id or normalized in seen:
                continue
            seen.add(normalized)
            candidates.append(normalized)
            if len(candidates) >= MAX_MENTION_USERS:
                break

        if not candidates:
            return []

        from apps.tabtinspace.models import OrganizationMember

        valid_ids = {
            str(user_id)
            for user_id in (
                OrganizationMember.objects.using(TABDATA_DB_ALIAS)
                .filter(
                    organization_id=record.table.organization_id,
                    user_id__in=candidates,
                )
                .values_list("user_id", flat=True)
            )
        }
        owner_id_str = str(record.table.owner_id or "")
        if owner_id_str in candidates:
            valid_ids.add(owner_id_str)

        return [user_id for user_id in candidates if user_id in valid_ids]

    @staticmethod
    def _normalize_content(content: str) -> str:
        normalized = str(content or "").strip()
        if not normalized:
            raise ValueError("评论内容不能为空")
        if len(normalized) > MAX_COMMENT_LENGTH:
            raise ValueError(f"评论内容不能超过 {MAX_COMMENT_LENGTH} 个字符")
        return normalized

    @staticmethod
    def _normalize_client_request_id(client_request_id: str | None) -> str | None:
        normalized = str(client_request_id or "").strip()
        if not normalized:
            return None
        if len(normalized) > MAX_CLIENT_REQUEST_ID_LENGTH:
            raise ValueError(
                f"client_request_id 不能超过 {MAX_CLIENT_REQUEST_ID_LENGTH} 个字符"
            )
        return normalized

    @staticmethod
    def _normalize_status_filter(status: str | None) -> str | None:
        if status is None or str(status).strip() == "":
            return None
        normalized = str(status).strip().lower()
        if normalized not in {
            RecordComment.Status.OPEN,
            RecordComment.Status.RESOLVED,
            "all",
        }:
            raise ValueError("status 必须是 open、resolved 或 all")
        return normalized

    @staticmethod
    def _normalize_thread_status(status: str) -> str:
        normalized = str(status or "").strip().lower()
        if normalized not in RecordComment.Status.values:
            raise ValueError("status 必须是 open 或 resolved")
        return normalized

    @staticmethod
    def _normalize_limit(limit: int) -> int:
        try:
            normalized = int(limit)
        except (TypeError, ValueError) as exc:
            raise ValueError("limit 必须是整数") from exc
        if normalized < 1 or normalized > MAX_PAGE_SIZE:
            raise ValueError(f"limit 必须在 1 到 {MAX_PAGE_SIZE} 之间")
        return normalized

    @staticmethod
    def _normalize_candidate_limit(limit: int) -> int:
        try:
            normalized = int(limit)
        except (TypeError, ValueError) as exc:
            raise ValueError("limit 必须是整数") from exc
        if normalized < 1 or normalized > MAX_MENTION_CANDIDATES:
            raise ValueError(f"limit 必须在 1 到 {MAX_MENTION_CANDIDATES} 之间")
        return normalized

    @staticmethod
    def _normalize_record_ids(record_ids: Iterable[object]) -> list[UUID]:
        normalized: list[UUID] = []
        seen: set[UUID] = set()
        for raw_id in record_ids:
            try:
                record_id = UUID(str(raw_id).strip())
            except (TypeError, ValueError) as exc:
                raise ValueError("record_ids 必须是逗号分隔的 UUID") from exc
            if record_id in seen:
                continue
            seen.add(record_id)
            normalized.append(record_id)
            if len(normalized) > MAX_COUNT_RECORDS:
                raise ValueError(f"record_ids 最多允许 {MAX_COUNT_RECORDS} 条")
        if not normalized:
            raise ValueError("record_ids 不能为空")
        return normalized

    @staticmethod
    def _mask_email(email: str) -> str:
        if not email or "@" not in email:
            return ""
        local, domain = email.split("@", 1)
        if not local:
            return ""
        if len(local) <= 2:
            masked = local[0] + "***"
        else:
            masked = local[0] + "***" + local[-1]
        return f"{masked}@{domain}"

    @staticmethod
    def _user_display_name(user) -> str:
        if hasattr(user, "get_display_name"):
            name = str(user.get_display_name() or "").strip()
        else:
            name = ""
        return (name or str(user.id))[:255]

    @staticmethod
    def _encode_cursor(record_id: UUID, created_at: datetime, comment_id: UUID) -> str:
        payload = json.dumps(
            {
                "record_id": str(record_id),
                "created_at": created_at.isoformat(),
                "id": str(comment_id),
            },
            separators=(",", ":"),
        ).encode("utf-8")
        return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")

    @staticmethod
    def _decode_cursor(cursor: str, record_id: UUID) -> tuple[datetime, UUID]:
        try:
            padding = "=" * (-len(cursor) % 4)
            raw = base64.b64decode(
                f"{cursor}{padding}",
                altchars=b"-_",
                validate=True,
            ).decode("utf-8")
            payload = json.loads(raw)
            if str(payload["record_id"]) != str(record_id):
                raise ValueError("游标不属于当前记录")
            created_at = parse_datetime(str(payload["created_at"]))
            comment_id = UUID(str(payload["id"]))
            if created_at is None:
                raise ValueError("游标时间无效")
            if timezone.is_naive(created_at):
                created_at = timezone.make_aware(created_at)
            return created_at, comment_id
        except ValueError:
            raise
        except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("无效的评论分页游标") from exc

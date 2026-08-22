"""TabDoc 评论线程领域模块与旧评论兼容投影。"""

from __future__ import annotations

import logging
import uuid
from typing import Iterable, Optional

from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Prefetch
from django.utils import timezone

from apps.services.oss.models import FileRecord
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.tabdoc.models import (
    CommentAttachment,
    CommentMessage,
    CommentThread,
    Document,
    DocumentShare,
    DocumentShareComment,
)

COMMENT_THREADS_CAPABILITY = "comment_threads_v1"
MAX_COMMENT_BODY_LENGTH = 2000
MAX_COMMENT_SELECTED_TEXT_LENGTH = 500
MAX_COMMENT_MENTION_USERS = 50
MAX_COMMENT_ATTACHMENTS = 9
DEFAULT_COMMENT_AUTHOR_NAME = "匿名访客"
_ATTACHMENT_METADATA_KEYS = frozenset(
    {"file_name", "file_size", "mime_type", "width", "height"}
)

logger = logging.getLogger("tabdoc.comments")


class DocumentCommentService:
    """把线程状态、兼容双写、通知与事件隐藏在一个领域 interface 后。"""

    @classmethod
    def list_threads(
        cls,
        document: Document,
        *,
        preview_share: Optional[DocumentShare] = None,
    ) -> list[dict]:
        messages = (
            CommentMessage.objects.select_related("author", "share")
            .prefetch_related("attachments__file_record")
            .order_by("created_at", "id")
        )
        threads = (
            CommentThread.objects.filter(
                document=document,
                organization_id=document.organization_id,
            )
            .select_related("created_by", "resolved_by")
            .prefetch_related(Prefetch("messages", queryset=messages))
            .order_by("created_at", "id")
        )
        return [
            cls.serialize_thread(thread, preview_share=preview_share)
            for thread in threads
        ]

    @classmethod
    def list_legacy_comments(cls, document: Document) -> list[dict]:
        comments = (
            DocumentShareComment.objects.filter(document=document, is_deleted=False)
            .select_related("author", "share")
            .order_by("created_at")
        )
        return [cls.serialize_legacy_comment(comment) for comment in comments]

    @classmethod
    @transaction.atomic
    def create_thread(
        cls,
        document: Document,
        *,
        user,
        body: str,
        scope: str = CommentThread.Scope.DOCUMENT,
        anchor: Optional[dict] = None,
        selected_text: str = "",
        author_name: str = "",
        mention_user_ids: Optional[list[str]] = None,
        attachment_ids: Optional[list[str]] = None,
        client_request_id: Optional[str] = None,
        share: Optional[DocumentShare] = None,
    ) -> CommentThread:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        cls._validate_share_document(share=share, document=document)

        normalized_body, normalized_attachment_ids = cls._normalize_content(
            body,
            attachment_ids,
        )
        normalized_client_request_id = cls._normalize_client_request_id(client_request_id)
        existing = cls._idempotent_message(
            user=user,
            client_request_id=normalized_client_request_id,
        )
        if existing is not None:
            if (
                existing.kind == CommentMessage.Kind.ROOT
                and str(existing.thread.document_id) == str(document.id)
                and str(existing.thread.organization_id) == str(document.organization_id)
            ):
                return existing.thread
            raise ValueError("client_request_id 已被其他评论使用")
        normalized_scope, normalized_anchor, anchor_status = cls._normalize_anchor(
            scope,
            anchor,
            selected_text=selected_text,
        )
        projection_selected_text = str(
            selected_text or normalized_anchor.get("selected_text") or ""
        ).strip()[:MAX_COMMENT_SELECTED_TEXT_LENGTH]
        display_name = cls._author_name(user=user, fallback=author_name)
        mentions = cls._normalize_mention_user_ids(
            mention_user_ids,
            document=document,
            actor_id=user.id,
        )
        try:
            # 内层 savepoint 让唯一约束竞争只回滚本次尝试；随后可在外层事务中
            # 读取已经提交的赢家，而不会留下半成品 thread/projection。
            with transaction.atomic():
                root_id = uuid.uuid4()
                thread = CommentThread.objects.create(
                    document=document,
                    organization_id=document.organization_id,
                    scope=normalized_scope,
                    status=CommentThread.Status.OPEN,
                    anchor=normalized_anchor,
                    anchor_status=anchor_status,
                    created_by=user,
                )
                root = CommentMessage.objects.create(
                    id=root_id,
                    thread=thread,
                    kind=CommentMessage.Kind.ROOT,
                    author=user,
                    share=share,
                    author_name=display_name,
                    body=normalized_body,
                    mention_user_ids=mentions,
                    client_request_id=normalized_client_request_id,
                )
                projection = DocumentShareComment.objects.create(
                    id=root_id,
                    document=document,
                    share=share,
                    author=user,
                    author_name=display_name,
                    selected_text=projection_selected_text,
                    body=normalized_body,
                    mention_user_ids=mentions,
                )
                cls._bind_attachments(
                    message=root,
                    document=document,
                    attachment_ids=normalized_attachment_ids,
                    user=user,
                )
                cls._schedule_root_created(thread, root, projection)
                return thread
        except IntegrityError:
            recovered = cls._idempotent_message(
                user=user,
                client_request_id=normalized_client_request_id,
            )
            if (
                recovered is not None
                and recovered.kind == CommentMessage.Kind.ROOT
                and str(recovered.thread.document_id) == str(document.id)
                and str(recovered.thread.organization_id) == str(document.organization_id)
            ):
                return recovered.thread
            raise

    @classmethod
    @transaction.atomic
    def reply(
        cls,
        document: Document,
        thread_id: str,
        *,
        user,
        body: str,
        author_name: str = "",
        mention_user_ids: Optional[list[str]] = None,
        attachment_ids: Optional[list[str]] = None,
        client_request_id: Optional[str] = None,
        share: Optional[DocumentShare] = None,
    ) -> CommentMessage:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        cls._validate_share_document(share=share, document=document)
        thread = cls._get_thread(document, thread_id)
        normalized_body, normalized_attachment_ids = cls._normalize_content(
            body,
            attachment_ids,
        )
        normalized_client_request_id = cls._normalize_client_request_id(client_request_id)
        existing = cls._idempotent_message(
            user=user,
            client_request_id=normalized_client_request_id,
        )
        if existing is not None:
            if (
                existing.kind == CommentMessage.Kind.REPLY
                and str(existing.thread_id) == str(thread.id)
            ):
                return existing
            raise ValueError("client_request_id 已被其他评论使用")
        try:
            with transaction.atomic():
                message = CommentMessage.objects.create(
                    thread=thread,
                    kind=CommentMessage.Kind.REPLY,
                    author=user,
                    share=share,
                    author_name=cls._author_name(user=user, fallback=author_name),
                    body=normalized_body,
                    mention_user_ids=cls._normalize_mention_user_ids(
                        mention_user_ids,
                        document=document,
                        actor_id=user.id,
                    ),
                    client_request_id=normalized_client_request_id,
                )
                cls._bind_attachments(
                    message=message,
                    document=document,
                    attachment_ids=normalized_attachment_ids,
                    user=user,
                )
                recipient_ids = cls._reply_recipient_ids(message=message, actor_id=user.id)
                cls._schedule_message_created(message, recipient_ids=recipient_ids)
                return message
        except IntegrityError:
            recovered = cls._idempotent_message(
                user=user,
                client_request_id=normalized_client_request_id,
            )
            if (
                recovered is not None
                and recovered.kind == CommentMessage.Kind.REPLY
                and str(recovered.thread_id) == str(thread.id)
            ):
                return recovered
            raise

    @classmethod
    def update_status(
        cls,
        document: Document,
        thread_id: str,
        *,
        user,
        status: str,
    ) -> CommentThread:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        if status not in CommentThread.Status.values:
            raise ValueError("不支持的评论线程状态")
        thread = cls._get_thread(document, thread_id)
        thread.status = status
        if status == CommentThread.Status.RESOLVED:
            thread.resolved_by = user
            thread.resolved_at = timezone.now()
        else:
            thread.resolved_by = None
            thread.resolved_at = None
        thread.save(update_fields=["status", "resolved_by", "resolved_at", "updated_at"])
        cls._schedule_thread_changed(thread, action="status_changed", actor_id=user.id)
        return thread

    @classmethod
    def reanchor(
        cls,
        document: Document,
        thread_id: str,
        *,
        user,
        scope: str,
        anchor: dict,
    ) -> CommentThread:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        if scope == CommentThread.Scope.DOCUMENT:
            raise ValueError("全文评论无需重新关联")
        normalized_scope, normalized_anchor, anchor_status = cls._normalize_anchor(
            scope,
            anchor,
        )
        thread = cls._get_thread(document, thread_id)
        thread.scope = normalized_scope
        thread.anchor = normalized_anchor
        thread.anchor_status = anchor_status
        thread.save(update_fields=["scope", "anchor", "anchor_status", "updated_at"])
        cls._schedule_thread_changed(thread, action="anchor_changed", actor_id=user.id)
        return thread

    @classmethod
    @transaction.atomic
    def delete_message(
        cls,
        document: Document,
        thread_id: str,
        message_id: str,
        *,
        user,
    ) -> CommentMessage:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        thread = cls._get_thread(document, thread_id)
        try:
            message = CommentMessage.objects.filter(
                id=message_id,
                thread=thread,
                is_deleted=False,
            ).first()
        except (ValueError, ValidationError):
            message = None
        if message is None:
            raise ValueError("评论消息不存在")
        if str(message.author_id or "") != str(user.id):
            raise PermissionError("只能删除自己发布的评论")
        message.is_deleted = True
        message.save(update_fields=["is_deleted", "updated_at"])
        if message.kind == CommentMessage.Kind.ROOT:
            DocumentShareComment.objects.filter(
                id=message.id,
                document=document,
            ).update(is_deleted=True)
        cls._schedule_message_deleted(message, document=document)
        return message

    @classmethod
    @transaction.atomic
    def delete_thread(
        cls,
        document: Document,
        thread_id: str,
        *,
        user,
    ) -> str:
        """删除锚点消失后的整条评论线程及兼容投影。"""
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        try:
            thread = (
                CommentThread.objects.select_for_update()
                .filter(
                    id=thread_id,
                    document=document,
                    organization_id=document.organization_id,
                )
                .first()
            )
        except (ValueError, ValidationError):
            thread = None
        if thread is None:
            raise ValueError("评论线程不存在")

        root_messages = list(
            thread.messages.filter(kind=CommentMessage.Kind.ROOT)
            .select_related("share")
        )
        root_ids = [message.id for message in root_messages]
        if root_ids:
            DocumentShareComment.objects.filter(
                id__in=root_ids,
                document=document,
                is_deleted=False,
            ).update(is_deleted=True)

        deleted_thread_id = str(thread.id)
        cls._schedule_thread_deleted(
            thread=thread,
            root_messages=root_messages,
            actor_id=user.id,
        )
        thread.delete()
        return deleted_thread_id

    @classmethod
    @transaction.atomic
    def delete_legacy_comment(
        cls,
        document: Document,
        comment_id: str,
        *,
        user,
    ) -> DocumentShareComment:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")
        try:
            comment = DocumentShareComment.objects.filter(
                id=comment_id,
                document=document,
                is_deleted=False,
            ).select_related("share").first()
        except (ValueError, ValidationError):
            comment = None
        if comment is None:
            raise ValueError("评论不存在")
        if str(comment.author_id or "") != str(user.id):
            raise PermissionError("只能删除自己发布的评论")

        root = CommentMessage.objects.filter(
            id=comment.id,
            thread__document=document,
            thread__organization_id=document.organization_id,
            kind=CommentMessage.Kind.ROOT,
            is_deleted=False,
        ).select_related("thread").first()
        if root is not None:
            cls.delete_message(
                document,
                str(root.thread_id),
                str(root.id),
                user=user,
            )
        else:
            comment.is_deleted = True
            comment.save(update_fields=["is_deleted", "updated_at"])
            cls._schedule_legacy_projection_deleted(comment=comment, document=document)
        comment.refresh_from_db()
        return comment

    @classmethod
    def serialize_thread(cls, thread: CommentThread, *, preview_share: Optional[DocumentShare] = None) -> dict:
        messages = list(thread.messages.all())
        return {
            "id": str(thread.id),
            "document_id": str(thread.document_id),
            "scope": thread.scope,
            "status": thread.status,
            "anchor": dict(thread.anchor or {}),
            "anchor_status": thread.anchor_status,
            "created_by_user_id": str(thread.created_by_id) if thread.created_by_id else None,
            "resolved_by_user_id": str(thread.resolved_by_id) if thread.resolved_by_id else None,
            "resolved_at": thread.resolved_at.isoformat() if thread.resolved_at else None,
            "created_at": thread.created_at.isoformat() if thread.created_at else None,
            "updated_at": thread.updated_at.isoformat() if thread.updated_at else None,
            "messages": [
                cls.serialize_message(message, preview_share=preview_share)
                for message in messages
            ],
        }

    @staticmethod
    def serialize_message(
        message: CommentMessage,
        *,
        preview_share: Optional[DocumentShare] = None,
    ) -> dict:
        author = None
        if message.author_id:
            try:
                author = message.author
            except ObjectDoesNotExist:
                author = None
        attachments = []
        if not message.is_deleted:
            for attachment in message.attachments.all():
                attachments.append(
                    {
                        "id": str(attachment.id),
                        "type": attachment.attachment_type,
                        "file_id": str(attachment.file_record_id),
                        "metadata": DocumentCommentService._safe_attachment_metadata(
                            attachment.metadata
                        ),
                        "preview_url": DocumentCommentService._attachment_preview_url(
                            message=message,
                            file_id=str(attachment.file_record_id),
                            preview_share=preview_share,
                        ),
                    }
                )
        return {
            "id": str(message.id),
            "thread_id": str(message.thread_id),
            "kind": message.kind,
            "author_name": message.author_name or DEFAULT_COMMENT_AUTHOR_NAME,
            "author_user_id": str(author.id) if author else None,
            "author_avatar": build_public_asset_url(getattr(author, "avatar", "") or "") or None,
            "author_account_name": getattr(author, "username", "") or "",
            "body": "" if message.is_deleted else message.body,
            "mention_user_ids": [] if message.is_deleted else list(message.mention_user_ids or []),
            "client_request_id": message.client_request_id,
            "is_deleted": message.is_deleted,
            "attachments": attachments,
            "created_at": message.created_at.isoformat() if message.created_at else None,
            "updated_at": message.updated_at.isoformat() if message.updated_at else None,
        }

    @staticmethod
    def _attachment_preview_url(
        *,
        message: CommentMessage,
        file_id: str,
        preview_share: Optional[DocumentShare],
    ) -> str:
        from apps.tabdoc.services.comment_attachment_service import CommentAttachmentService

        return CommentAttachmentService.preview_path(
            document_id=str(message.thread.document_id),
            file_id=file_id,
            share_id=str(preview_share.share_id) if preview_share else "",
        )

    @staticmethod
    def serialize_legacy_comment(comment: DocumentShareComment) -> dict:
        author = None
        if comment.author_id:
            try:
                author = comment.author
            except ObjectDoesNotExist:
                author = None
        return {
            "id": str(comment.id),
            "author_name": comment.author_name or DEFAULT_COMMENT_AUTHOR_NAME,
            "author_user_id": str(author.id) if author else None,
            "author_avatar": build_public_asset_url(getattr(author, "avatar", "") or "") or None,
            "author_account_name": getattr(author, "username", "") or "",
            "selected_text": comment.selected_text or "",
            "body": comment.body,
            "mention_user_ids": list(comment.mention_user_ids or []),
            "created_at": comment.created_at.isoformat() if comment.created_at else None,
        }

    @classmethod
    def _normalize_content(
        cls,
        body: str,
        attachment_ids: Optional[Iterable[object]],
    ) -> tuple[str, list[uuid.UUID]]:
        normalized_body = (body or "").strip()
        if len(normalized_body) > MAX_COMMENT_BODY_LENGTH:
            raise ValueError(f"评论内容不能超过 {MAX_COMMENT_BODY_LENGTH} 个字符")

        raw_attachment_ids = list(attachment_ids or [])
        if len(raw_attachment_ids) > MAX_COMMENT_ATTACHMENTS:
            raise ValueError(f"评论附件不能超过 {MAX_COMMENT_ATTACHMENTS} 个")

        normalized_attachment_ids: list[uuid.UUID] = []
        seen: set[uuid.UUID] = set()
        for raw_attachment_id in raw_attachment_ids:
            try:
                attachment_id = uuid.UUID(str(raw_attachment_id))
            except (AttributeError, TypeError, ValueError):
                raise ValueError("评论附件无效") from None
            if attachment_id in seen:
                raise ValueError("评论附件不能重复")
            seen.add(attachment_id)
            normalized_attachment_ids.append(attachment_id)

        if not normalized_body and not normalized_attachment_ids:
            raise ValueError("评论内容和附件不能同时为空")
        return normalized_body, normalized_attachment_ids

    @staticmethod
    def _normalize_client_request_id(value: Optional[object]) -> Optional[str]:
        normalized = str(value or "").strip()
        if not normalized:
            return None
        if len(normalized) > 100:
            raise ValueError("client_request_id 不能超过 100 个字符")
        return normalized

    @staticmethod
    def _idempotent_message(*, user, client_request_id: Optional[str]) -> Optional[CommentMessage]:
        if not client_request_id:
            return None
        return (
            CommentMessage.objects.filter(
                author=user,
                client_request_id=client_request_id,
            )
            .select_related("thread")
            .first()
        )

    @classmethod
    def _bind_attachments(
        cls,
        *,
        message: CommentMessage,
        document: Document,
        attachment_ids: list[uuid.UUID],
        user,
    ) -> None:
        """只在评论事务内把已完成的组织私有文件绑定为附件。"""
        if not attachment_ids:
            return

        # 按主键排序加锁，避免并发绑定不同附件集合时交叉等待死锁
        ordered_ids = sorted(attachment_ids, key=str)
        records = {
            record.id: record
            for record in FileRecord.objects.select_for_update().filter(
                id__in=ordered_ids
            ).order_by("id")
        }
        if len(records) != len(attachment_ids):
            raise ValueError("评论附件无效")
        if CommentAttachment.objects.filter(
            file_record_id__in=attachment_ids,
        ).exists():
            raise ValueError("评论附件已绑定到其他消息")

        attachments: list[CommentAttachment] = []
        for attachment_id in attachment_ids:
            record = records[attachment_id]
            from apps.tabdoc.services.comment_attachment_service import CommentAttachmentService

            CommentAttachmentService.validate_bindable_file(
                record,
                document=document,
                user=user,
            )
            attachments.append(
                CommentAttachment(
                    message=message,
                    file_record=record,
                    organization_id=document.organization_id,
                    attachment_type=(
                        CommentAttachment.AttachmentType.IMAGE
                        if record.file_type == "image"
                        else CommentAttachment.AttachmentType.FILE
                    ),
                    metadata=cls._file_record_attachment_metadata(record),
                    created_by=user,
                )
            )
        try:
            CommentAttachment.objects.bulk_create(attachments)
        except IntegrityError as exc:
            raise ValueError("评论附件已绑定到其他消息") from exc

    @staticmethod
    def _file_record_attachment_metadata(file_record: FileRecord) -> dict:
        metadata = {
            "file_name": file_record.file_name,
            "file_size": file_record.file_size,
            "mime_type": file_record.mime_type,
        }
        source_metadata = file_record.metadata or {}
        for key in ("width", "height"):
            value = source_metadata.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                metadata[key] = value
        return metadata

    @staticmethod
    def _safe_attachment_metadata(metadata: object) -> dict:
        if not isinstance(metadata, dict):
            return {}
        return {
            key: value
            for key, value in metadata.items()
            if key in _ATTACHMENT_METADATA_KEYS
        }

    @staticmethod
    def _normalize_anchor(
        scope: str,
        anchor: Optional[dict],
        *,
        selected_text: str = "",
    ) -> tuple[str, dict, str]:
        if scope not in CommentThread.Scope.values:
            raise ValueError("不支持的评论范围")
        if anchor is not None and not isinstance(anchor, dict):
            raise ValueError("评论锚点必须是 JSON 对象")
        normalized = dict(anchor or {})
        version = normalized.get("version", 1)
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ValueError("评论锚点 version 必须是正整数")
        normalized["version"] = version
        if selected_text and "selected_text" not in normalized:
            normalized["selected_text"] = selected_text[:MAX_COMMENT_SELECTED_TEXT_LENGTH]
        anchor_status = (
            CommentThread.AnchorStatus.NONE
            if scope == CommentThread.Scope.DOCUMENT
            else CommentThread.AnchorStatus.ATTACHED
        )
        return scope, normalized, anchor_status

    @staticmethod
    def _author_name(*, user, fallback: str = "") -> str:
        if user and getattr(user, "id", None):
            return (
                getattr(user, "nickname", "")
                or getattr(user, "username", "")
                or getattr(user, "email", "")
                or str(user.id)
            )[:80]
        cleaned = (fallback or "").strip()
        return (cleaned or DEFAULT_COMMENT_AUTHOR_NAME)[:80]

    @staticmethod
    def _normalize_mention_user_ids(
        user_ids: Optional[Iterable[object]],
        *,
        document: Document,
        actor_id,
    ) -> list[str]:
        if not user_ids:
            return []
        from apps.tabtinspace.models import OrganizationMember

        actor_id_str = str(actor_id or "")
        candidates: list[str] = []
        seen: set[str] = set()
        for raw_user_id in user_ids:
            user_id = str(raw_user_id or "").strip()
            if not user_id or user_id == actor_id_str or user_id in seen:
                continue
            seen.add(user_id)
            candidates.append(user_id)
            if len(candidates) >= MAX_COMMENT_MENTION_USERS:
                break
        if not candidates:
            return []
        valid_ids = {
            str(user_id)
            for user_id in OrganizationMember.objects.filter(
                organization_id=document.organization_id,
                user_id__in=candidates,
            ).values_list("user_id", flat=True)
        }
        owner_id = str(getattr(document, "owner_id", "") or "")
        if owner_id in candidates:
            valid_ids.add(owner_id)
        return [user_id for user_id in candidates if user_id in valid_ids]

    @staticmethod
    def _get_thread(document: Document, thread_id: str) -> CommentThread:
        try:
            thread = CommentThread.objects.filter(
                id=thread_id,
                document=document,
                organization_id=document.organization_id,
            ).first()
        except (ValueError, ValidationError):
            thread = None
        if thread is None:
            raise ValueError("评论线程不存在")
        return thread

    @staticmethod
    def _validate_share_document(*, share: Optional[DocumentShare], document: Document) -> None:
        if share is None:
            return
        if (
            str(share.document_id) != str(document.id)
            or str(share.document.organization_id) != str(document.organization_id)
        ):
            raise PermissionError("评论分享不属于当前文档")

    @staticmethod
    def _schedule_root_created(
        thread: CommentThread,
        root: CommentMessage,
        projection: DocumentShareComment,
    ) -> None:
        document = thread.document
        actor_id = str(root.author_id or "")
        mention_user_ids = list(root.mention_user_ids or [])
        share_id = projection.share.share_id if projection.share_id else ""

        def publish() -> None:
            from apps.tabdoc.services.doc_event_service import doc_event_service

            doc_event_service.publish_comment_thread_change(
                str(document.id),
                action="created",
                thread_id=str(thread.id),
                actor_id=actor_id,
                status=thread.status,
                scope=thread.scope,
                anchor_status=thread.anchor_status,
            )
            doc_event_service.publish_comment_message_change(
                str(document.id),
                action="created",
                thread_id=str(thread.id),
                message_id=str(root.id),
                actor_id=actor_id,
                message_kind=root.kind,
            )
            doc_event_service.publish_comment_change(
                str(document.id),
                action="created",
                comment_id=str(root.id),
                comment_author_id=actor_id,
                mention_user_ids=mention_user_ids,
                share_id=str(share_id or ""),
                document=document,
            )
            DocumentCommentService._notify_root_mentions(
                document=document,
                message=root,
                mention_user_ids=mention_user_ids,
            )

        transaction.on_commit(publish)

    @staticmethod
    def _schedule_message_created(
        message: CommentMessage,
        *,
        recipient_ids: Optional[list[str]] = None,
    ) -> None:
        document = message.thread.document

        def publish() -> None:
            from apps.tabdoc.services.doc_event_service import doc_event_service

            doc_event_service.publish_comment_message_change(
                str(document.id),
                action="created",
                thread_id=str(message.thread_id),
                message_id=str(message.id),
                actor_id=str(message.author_id or ""),
                message_kind=message.kind,
            )
            if recipient_ids:
                DocumentCommentService._notify_reply_recipients(
                    document=document,
                    message=message,
                    recipient_ids=recipient_ids,
                )

        transaction.on_commit(publish)

    @staticmethod
    def _reply_recipient_ids(*, message: CommentMessage, actor_id) -> list[str]:
        """参与者和本次提及者各通知一次，且永不通知回复者自己。"""
        actor_id = str(actor_id)
        candidates = list(
            CommentMessage.objects.filter(thread_id=message.thread_id)
            .exclude(author_id__isnull=True)
            .order_by("created_at", "id")
            .values_list("author_id", flat=True)
        )
        candidates.extend(message.mention_user_ids or [])

        recipient_ids: list[str] = []
        seen = {actor_id}
        for candidate in candidates:
            candidate_id = str(candidate)
            if candidate_id in seen:
                continue
            seen.add(candidate_id)
            recipient_ids.append(candidate_id)
        return recipient_ids

    @staticmethod
    def _schedule_thread_changed(
        thread: CommentThread,
        *,
        action: str,
        actor_id,
    ) -> None:
        document = thread.document

        def publish() -> None:
            from apps.tabdoc.services.doc_event_service import doc_event_service

            doc_event_service.publish_comment_thread_change(
                str(document.id),
                action=action,
                thread_id=str(thread.id),
                actor_id=str(actor_id or ""),
                status=thread.status,
                scope=thread.scope,
                anchor_status=thread.anchor_status,
            )

        transaction.on_commit(publish)

    @staticmethod
    def _schedule_thread_deleted(
        *,
        thread: CommentThread,
        root_messages: list[CommentMessage],
        actor_id,
    ) -> None:
        document = thread.document
        thread_id = str(thread.id)
        status = thread.status
        scope = thread.scope
        anchor_status = thread.anchor_status
        roots = [
            {
                "id": str(message.id),
                "author_id": str(message.author_id or ""),
                "share_id": str(message.share.share_id if message.share_id else ""),
            }
            for message in root_messages
        ]

        def publish() -> None:
            from apps.tabdoc.services.doc_event_service import doc_event_service

            doc_event_service.publish_comment_thread_change(
                str(document.id),
                action="deleted",
                thread_id=thread_id,
                actor_id=str(actor_id or ""),
                status=status,
                scope=scope,
                anchor_status=anchor_status,
            )
            for root in roots:
                doc_event_service.publish_comment_change(
                    str(document.id),
                    action="deleted",
                    comment_id=root["id"],
                    comment_author_id=root["author_id"],
                    mention_user_ids=[],
                    share_id=root["share_id"],
                    document=document,
                )

        transaction.on_commit(publish)

    @staticmethod
    def _schedule_message_deleted(message: CommentMessage, *, document: Document) -> None:
        def publish() -> None:
            from apps.tabdoc.services.doc_event_service import doc_event_service

            doc_event_service.publish_comment_message_change(
                str(document.id),
                action="deleted",
                thread_id=str(message.thread_id),
                message_id=str(message.id),
                actor_id=str(message.author_id or ""),
                message_kind=message.kind,
            )
            if message.kind == CommentMessage.Kind.ROOT:
                doc_event_service.publish_comment_change(
                    str(document.id),
                    action="deleted",
                    comment_id=str(message.id),
                    comment_author_id=str(message.author_id or ""),
                    mention_user_ids=[],
                    share_id=str(message.share.share_id if message.share_id else ""),
                    document=document,
                )

        transaction.on_commit(publish)

    @staticmethod
    def _schedule_legacy_projection_deleted(
        *,
        comment: DocumentShareComment,
        document: Document,
    ) -> None:
        """兼容尚未经过回填的旧行，避免旧 DELETE 丢失实时事件。"""
        def publish() -> None:
            from apps.tabdoc.services.doc_event_service import doc_event_service

            doc_event_service.publish_comment_change(
                str(document.id),
                action="deleted",
                comment_id=str(comment.id),
                comment_author_id=str(comment.author_id or ""),
                mention_user_ids=[],
                share_id=str(comment.share.share_id if comment.share_id else ""),
                document=document,
            )

        transaction.on_commit(publish)

    @staticmethod
    def _notify_root_mentions(
        *,
        document: Document,
        message: CommentMessage,
        mention_user_ids: list[str],
    ) -> None:
        if not mention_user_ids:
            return
        try:
            from apps.services.notification.services.notification_service import NotificationService
        except Exception:
            logger.warning("评论通知服务不可用: doc=%s", document.id, exc_info=True)
            return
        author_name = message.author_name or DEFAULT_COMMENT_AUTHOR_NAME
        metadata = {
            "resource_type": "doc",
            "resource_id": str(document.id),
            "resource_title": document.title or "",
            "action": "mentioned",
            "comment_id": str(message.id),
            "thread_id": str(message.thread_id),
            "comment_author_id": str(message.author_id or ""),
            "mention_user_ids": mention_user_ids,
            "organization_id": str(document.organization_id),
            "space_id": str(document.space_id) if document.space_id else "",
            "source_event_key": "tabdoc.document.commented",
            "category": "collaboration",
            "behavior": "view_context",
        }
        for user_id in mention_user_ids:
            try:
                NotificationService.notify(
                    user_id=user_id,
                    type="tabdoc.comment.mention",
                    title=f"{author_name} 在《{document.title or '未命名文档'}》中提到了你",
                    body=" ".join((message.body or "").split())[:120],
                    metadata=metadata,
                    organization_id=str(document.organization_id),
                )
            except Exception:
                logger.warning(
                    "评论通知失败: doc=%s user=%s", document.id, user_id, exc_info=True
                )

    @staticmethod
    def _notify_reply_recipients(
        *,
        document: Document,
        message: CommentMessage,
        recipient_ids: list[str],
    ) -> None:
        try:
            from apps.services.notification.services.notification_service import NotificationService
        except Exception:
            logger.warning("评论回复通知服务不可用: doc=%s", document.id, exc_info=True)
            return

        author_name = message.author_name or DEFAULT_COMMENT_AUTHOR_NAME
        metadata = {
            "resource_type": "doc",
            "resource_id": str(document.id),
            "resource_title": document.title or "",
            "comment_id": str(message.id),
            "message_id": str(message.id),
            "thread_id": str(message.thread_id),
            "comment_author_id": str(message.author_id or ""),
            "mention_user_ids": list(message.mention_user_ids or []),
            "organization_id": str(document.organization_id),
            "space_id": str(document.space_id) if document.space_id else "",
            "source_event_key": "tabdoc.comment.replied",
            "category": "collaboration",
        }
        mentioned_user_ids = {str(user_id) for user_id in (message.mention_user_ids or [])}
        for user_id in recipient_ids:
            try:
                was_mentioned = str(user_id) in mentioned_user_ids
                NotificationService.notify(
                    user_id=user_id,
                    type="tabdoc.comment.mention" if was_mentioned else "tabdoc.comment.reply",
                    title=(
                        f"{author_name} 在《{document.title or '未命名文档'}》中提到了你"
                        if was_mentioned
                        else f"{author_name} 回复了《{document.title or '未命名文档'}》中的评论"
                    ),
                    body=" ".join((message.body or "").split())[:120],
                    metadata={
                        **metadata,
                        "action": "mentioned" if was_mentioned else "replied",
                    },
                    organization_id=str(document.organization_id),
                )
            except Exception:
                logger.warning(
                    "评论回复通知失败: doc=%s user=%s", document.id, user_id, exc_info=True
                )


__all__ = ["COMMENT_THREADS_CAPABILITY", "DocumentCommentService"]

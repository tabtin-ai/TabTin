"""TabDoc 私有评论图片附件上传、确认、预览与回收模块。"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from apps.services.oss.constants import DANGEROUS_WEB_CONTENT_MIMES
from apps.services.oss.models import FileRecord
from apps.services.oss.services.factory import get_oss_service
from apps.services.oss.services.file_registry import FileRegistryService
from apps.tabdoc.models import CommentAttachment, Document


COMMENT_ATTACHMENT_CONTEXT_TYPE = "comment_attachment"
COMMENT_ATTACHMENT_TOKEN_MAX_AGE = 15 * 60
COMMENT_ATTACHMENT_PREVIEW_TTL = 5 * 60
_COMMENT_ATTACHMENT_TOKEN_SALT = "tabdoc.comment-attachment-upload.v1"

logger = logging.getLogger("tabdoc.comment_attachments")


class CommentAttachmentService:
    """把私有直传细节隐藏在一个小 interface 后。"""

    @classmethod
    def issue_upload(
        cls,
        document: Document,
        *,
        user,
        file_name: str,
        content_type: str,
        file_size: int,
    ) -> dict[str, Any]:
        cls._require_user(user)
        normalized_content_type = cls._validate_image(
            file_name=file_name,
            content_type=content_type,
            file_size=file_size,
        )
        from apps.tabtinspace.services.organization_control_guard import (
            assert_organization_resource_write_allowed,
        )

        assert_organization_resource_write_allowed(str(document.organization_id))

        # 复用 OSS direct-upload 的同一签名和文件名/扩展名校验实现；TabDoc
        # 自己只增加图片 preset、文档归属和 private-only 语义。
        from apps.services.oss.api import _generate_presign_item

        oss_service = get_oss_service()
        target = _generate_presign_item(
            oss_service,
            filename=file_name,
            folder=(
                f"tabdoc/comment-attachments/{document.organization_id}/{document.id}"
            ),
            content_type=normalized_content_type,
            file_size=file_size,
            user_id=str(user.id),
            module="tabdoc",
            context_type=COMMENT_ATTACHMENT_CONTEXT_TYPE,
            is_public=False,
        )
        token = signing.dumps(
            {
                "v": 1,
                "document_id": str(document.id),
                "organization_id": str(document.organization_id),
                "user_id": str(user.id),
                "object_key": target["object_key"],
                "file_name": file_name,
                "content_type": normalized_content_type,
                "file_size": int(file_size),
            },
            salt=_COMMENT_ATTACHMENT_TOKEN_SALT,
            compress=True,
        )
        return {
            "upload_url": target["presigned_url"],
            "upload_token": token,
            "method": "PUT",
            "headers": {"Content-Type": normalized_content_type},
            "expires_in": int(target["expires_in"]),
        }

    @classmethod
    def confirm_upload(
        cls,
        document: Document,
        *,
        user,
        upload_token: str,
    ) -> FileRecord:
        cls._require_user(user)
        payload = cls._load_upload_token(upload_token)
        expected_scope = (
            str(document.id),
            str(document.organization_id),
            str(user.id),
        )
        token_scope = (
            str(payload.get("document_id") or ""),
            str(payload.get("organization_id") or ""),
            str(payload.get("user_id") or ""),
        )
        if token_scope != expected_scope:
            raise ValueError("评论附件上传凭证无效")

        object_key = str(payload.get("object_key") or "")
        if not object_key:
            raise ValueError("评论附件上传凭证无效")

        oss_service = get_oss_service()
        if not oss_service.file_exists(object_key):
            raise ValueError("评论附件尚未上传完成")
        oss_info = oss_service.get_file_info(object_key)
        info_data = oss_info.get("data") if isinstance(oss_info, dict) else None
        if not oss_info.get("success") or not isinstance(info_data, dict):
            raise ValueError("无法核验评论附件")

        try:
            try:
                actual_size = int(info_data.get("content_length"))
            except (TypeError, ValueError):
                raise ValueError("评论附件大小无效") from None
            from apps.services.oss.api import _resolve_confirmed_content_type

            actual_content_type = cls._validate_image(
                file_name=str(payload.get("file_name") or ""),
                content_type=_resolve_confirmed_content_type(
                    str(payload.get("content_type") or ""),
                    oss_info,
                ),
                file_size=actual_size,
            )
            if actual_size != int(payload.get("file_size") or 0):
                raise ValueError("评论附件实际大小与上传凭证不一致")
        except ValueError:
            cls._delete_unregistered_object(oss_service, object_key)
            raise

        if not oss_service.set_object_private(object_key):
            try:
                oss_service.delete_file(object_key)
            except Exception:
                logger.exception("评论附件 private ACL 失败后删除对象失败: %s", object_key)
            raise ValueError("评论附件私有权限设置失败")

        try:
            return FileRegistryService.register_uploaded_file(
                object_key=object_key,
                file_name=str(payload["file_name"]),
                file_size=actual_size,
                content_type=actual_content_type,
                module="tabdoc",
                user_id=str(user.id),
                organization_id=str(document.organization_id),
                context_type=COMMENT_ATTACHMENT_CONTEXT_TYPE,
                context_id=str(document.id),
                upload_source="tabdoc_comment_direct_upload",
                metadata={"comment_attachment": True},
                enforce_storage_quota=True,
                is_public=False,
            )
        except Exception:
            # FileRecord 没建成时不能留下无记录对象；删除失败仍有 OSS 侧日志可追。
            cls._delete_unregistered_object(oss_service, object_key)
            raise

    @classmethod
    def preview(cls, document: Document, *, file_id: str) -> dict[str, Any]:
        attachment = (
            CommentAttachment.objects.filter(
                file_record_id=file_id,
                organization_id=document.organization_id,
                message__thread__document=document,
                message__thread__organization_id=document.organization_id,
                message__is_deleted=False,
                file_record__status="completed",
                file_record__is_public=False,
            )
            .select_related("file_record")
            .first()
        )
        if attachment is None:
            raise ValueError("评论附件不存在")
        preview_url = get_oss_service().generate_presigned_url(
            attachment.file_record.file_key,
            expiration=COMMENT_ATTACHMENT_PREVIEW_TTL,
            method="GET",
        )
        return {
            "preview_url": preview_url,
            "expires_in": COMMENT_ATTACHMENT_PREVIEW_TTL,
        }

    @classmethod
    def validate_bindable_file(
        cls,
        file_record: FileRecord,
        *,
        document: Document,
        user,
    ) -> None:
        metadata = file_record.metadata if isinstance(file_record.metadata, dict) else {}
        if (
            str(file_record.organization_id) != str(document.organization_id)
            or file_record.is_public
            or file_record.status != "completed"
            or str(file_record.upload_user or "") != str(user.id)
            or metadata.get("comment_attachment") is not True
            or metadata.get("module") != "tabdoc"
            or metadata.get("context_type") != COMMENT_ATTACHMENT_CONTEXT_TYPE
            or str(metadata.get("context_id") or "") != str(document.id)
        ):
            raise ValueError("评论附件无效")
        cls._validate_image(
            file_name=file_record.file_name,
            content_type=file_record.mime_type,
            file_size=int(file_record.file_size),
        )

    @staticmethod
    def preview_path(*, document_id: str, file_id: str, share_id: str = "") -> str:
        if share_id:
            return f"/api/tabdoc/shared/{share_id}/comment-attachments/{file_id}/preview"
        return f"/api/tabdoc/documents/{document_id}/comment-attachments/{file_id}/preview"

    @classmethod
    def serialize_confirmed(
        cls,
        file_record: FileRecord,
        *,
        document: Document,
        share_id: str = "",
    ) -> dict[str, Any]:
        return {
            "file_id": str(file_record.id),
            "type": "image",
            "metadata": {
                "file_name": file_record.file_name,
                "file_size": int(file_record.file_size),
                "mime_type": file_record.mime_type,
            },
            "preview_url": cls.preview_path(
                document_id=str(document.id),
                file_id=str(file_record.id),
                share_id=share_id,
            ),
        }

    @classmethod
    def cleanup_orphans(cls, *, older_than=None, limit: int = 200) -> dict[str, int]:
        """删除超过 24 小时仍未绑定消息的已确认评论上传。"""
        cutoff = older_than or (timezone.now() - timedelta(hours=24))
        candidate_ids = list(
            FileRecord.objects.filter(
                status="completed",
                is_public=False,
                created_at__lt=cutoff,
                metadata__comment_attachment=True,
                metadata__module="tabdoc",
                metadata__context_type=COMMENT_ATTACHMENT_CONTEXT_TYPE,
                tabdoc_comment_attachments__isnull=True,
            )
            .order_by("created_at", "id")
            .values_list("id", flat=True)[: max(1, min(int(limit), 1000))]
        )
        deleted_count = 0
        skipped_count = 0
        oss_service = get_oss_service()
        for file_id in candidate_ids:
            with transaction.atomic():
                record = (
                    FileRecord.objects.select_for_update()
                    .filter(
                        id=file_id,
                        status="completed",
                        is_public=False,
                        created_at__lt=cutoff,
                    )
                    .first()
                )
                if record is None or record.tabdoc_comment_attachments.exists():
                    skipped_count += 1
                    continue
                delete_result = oss_service.delete_file(record.file_key)
                if not isinstance(delete_result, dict) or not delete_result.get("success"):
                    logger.warning(
                        "评论附件孤儿物理删除失败，保留记录重试: file_id=%s key=%s",
                        record.id,
                        record.file_key,
                    )
                    skipped_count += 1
                    continue

                from apps.services.oss.services.deactivate_utils import (
                    deactivate_file_usages_and_release_storage,
                )

                deactivate_file_usages_and_release_storage(
                    module="tabdoc",
                    context_filter={
                        "file_record_id": record.id,
                        "context_type": COMMENT_ATTACHMENT_CONTEXT_TYPE,
                    },
                    organization_id=str(record.organization_id or ""),
                    user_id=str(record.upload_user or ""),
                    biz_type="tabdoc_comment_attachment_orphan_cleanup",
                    biz_id=str(record.id),
                    log_prefix="TabDoc 评论附件孤儿清理",
                )
                record.soft_delete()
                deleted_count += 1
        return {
            "deleted_count": deleted_count,
            "skipped_count": skipped_count,
        }

    @staticmethod
    def _require_user(user) -> None:
        if not user or not getattr(user, "id", None):
            raise PermissionError("Need login")

    @staticmethod
    def _delete_unregistered_object(oss_service, object_key: str) -> None:
        try:
            oss_service.delete_file(object_key)
        except Exception:
            logger.exception("评论附件确认失败后删除孤儿对象失败: %s", object_key)

    @staticmethod
    def _load_upload_token(upload_token: str) -> dict[str, Any]:
        try:
            payload = signing.loads(
                upload_token,
                salt=_COMMENT_ATTACHMENT_TOKEN_SALT,
                max_age=COMMENT_ATTACHMENT_TOKEN_MAX_AGE,
            )
        except (signing.BadSignature, signing.SignatureExpired):
            raise ValueError("评论附件上传凭证无效或已过期") from None
        if not isinstance(payload, dict) or payload.get("v") != 1:
            raise ValueError("评论附件上传凭证无效")
        return payload

    @staticmethod
    def _validate_image(*, file_name: str, content_type: str, file_size: int) -> str:
        normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
        image_preset = (getattr(settings, "OSS_UPLOAD_PRESETS", {}) or {}).get("IMAGE") or {}
        allowed_mimes = {
            str(value).lower()
            for value in (image_preset.get("accept") or [])
            if str(value).lower() not in DANGEROUS_WEB_CONTENT_MIMES
        }
        max_size = int(image_preset.get("maxSize") or settings.OSS_MAX_FILE_SIZE)
        if normalized_content_type not in allowed_mimes:
            raise ValueError("评论附件仅支持安全图片格式")
        if isinstance(file_size, bool) or file_size <= 0 or file_size > max_size:
            raise ValueError(f"评论附件大小必须在 1 到 {max_size} 字节之间")

        from apps.services.common.exceptions import ValidationException
        from apps.services.oss.api import _validate_upload_params

        try:
            _validate_upload_params(
                file_name,
                file_size,
                normalized_content_type,
                module="tabdoc",
                context_type=COMMENT_ATTACHMENT_CONTEXT_TYPE,
                is_public=False,
            )
        except ValidationException as exc:
            raise ValueError(str(exc)) from None
        return normalized_content_type

"""
通用 OSS 文件注册服务

封装 "已上传到 OSS 的文件 → FileRecord + FileUsage + apply_storage_delta" 的完整流程，
供各业务模块（TabVideo / TabSlide / TabMail 等）在服务端生成文件后统一调用。
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Optional

from django.db import IntegrityError, transaction

from apps.services.oss.models import FileRecord, FileUsage
from apps.services.common.utils import get_file_type_from_extension

SYSTEM_USER_UUID = "00000000-0000-0000-0000-000000000000"

logger = logging.getLogger(__name__)


class FileRegistryService:
    """通用 OSS 文件注册服务"""

    @staticmethod
    @transaction.atomic
    def register_uploaded_file(
        *,
        object_key: str,
        file_name: str,
        file_size: int,
        content_type: str,
        module: str,
        user_id: str,
        organization_id: str = "",
        context_type: str = "",
        context_id: str = "",
        upload_source: str = "server_generated",
        file_hash: str = "",
        hash_algorithm: str = "",
        upload_ip: str = "",
        metadata: dict | None = None,
        enforce_storage_quota: bool = False,
        is_public: bool = False,
    ) -> FileRecord:
        """
        为已上传到 OSS 的文件创建 FileRecord + FileUsage + 存储计费。

        Args:
            object_key: OSS 对象键 (e.g. "tabvideo/ws123/tts/abc.wav")
            file_name: 原始文件名 (e.g. "abc.wav")
            file_size: 文件大小 (bytes)
            content_type: MIME 类型
            module: 业务模块 ("tabvideo" / "tabslide" 等)
            user_id: 上传用户 ID
            organization_id: 组织 ID（为空时不触发存储计费）
            context_type: 引用上下文类型 ("tts_audio" / "bgm" / "html_render" 等)
            context_id: 引用上下文 ID (project_id / clip_id)
            upload_source: 上传来源标识
            file_hash: 文件 MD5 hash（可选，为空则跳过）
            metadata: 附加元数据
            enforce_storage_quota: 为 True 时在创建记录前校验存储配额

        Returns:
            FileRecord: 已创建并标记为 completed 的文件记录

        Raises:
            ValueError: enforce_storage_quota=True 且配额不足时抛出
        """
        if organization_id:
            from apps.tabtinspace.services.organization_control_guard import assert_organization_resource_write_allowed

            assert_organization_resource_write_allowed(organization_id)

        if enforce_storage_quota and organization_id and file_size > 0:
            from apps.services.billing.services import OrganizationStorageBillingService
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=organization_id,
                incoming_bytes=file_size,
            )

        from apps.services.oss.services.factory import get_oss_service

        oss_service = get_oss_service()

        original_extension = os.path.splitext(file_name)[1].lower().lstrip(".")
        file_extension = original_extension if len(original_extension) <= 10 else "bin"
        file_path = os.path.dirname(object_key)
        file_type = get_file_type_from_extension(file_extension)

        access_url = oss_service.build_access_url(object_key)
        cdn_url = oss_service.build_cdn_url(object_key)

        record_metadata = {
            "upload_method": "server_generated",
            "module": module,
            "context_type": context_type,
            "context_id": context_id,
            "original_extension": original_extension,
        }
        if metadata:
            record_metadata.update(metadata)

        file_key_hash = FileRecord._calc_file_key_hash(object_key)

        existing = FileRecord.objects.filter(file_key_hash=file_key_hash).first()
        if existing:
            logger.info(
                "FileRegistry 幂等命中: object_key=%s, file_id=%s, status=%s",
                object_key, existing.id, existing.status,
            )
            if existing.status != "completed":
                existing.mark_as_completed(access_url=access_url, cdn_url=cdn_url)
            return existing

        create_kwargs = dict(
            file_name=file_name,
            file_key=object_key,
            file_path=file_path,
            file_size=file_size,
            file_type=file_type,
            mime_type=content_type,
            file_extension=file_extension,
            file_hash=file_hash,
            hash_algorithm=hash_algorithm,
            bucket_name=oss_service.config.get("bucket_name", ""),
            access_url=access_url,
            cdn_url=cdn_url,
            is_public=is_public,
            upload_user=user_id,
            upload_source=upload_source,
            organization_id=organization_id,
            tags=[],
            metadata=record_metadata,
        )
        if upload_ip:
            create_kwargs["upload_ip"] = upload_ip

        try:
            file_record = FileRecord.objects.create(**create_kwargs)
        except IntegrityError:
            file_record = FileRecord.objects.get(file_key_hash=file_key_hash)
            logger.info(
                "FileRegistry IntegrityError 降级幂等: object_key=%s, file_id=%s",
                object_key, file_record.id,
            )
            if file_record.status != "completed":
                file_record.mark_as_completed(access_url=access_url, cdn_url=cdn_url)
            return file_record

        file_record.mark_as_completed(access_url=access_url, cdn_url=cdn_url)

        effective_user_id = user_id if user_id else SYSTEM_USER_UUID

        FileUsage.add_usage(
            file_record=file_record,
            user_id=effective_user_id,
            module=module,
            context_type=context_type,
            context_id=context_id,
        )

        if organization_id and file_size > 0:
            try:
                from apps.services.billing.services import OrganizationStorageBillingService

                OrganizationStorageBillingService.apply_storage_delta(
                    organization_id=organization_id,
                    file_id=str(file_record.id),
                    delta_bytes=int(file_size),
                    user_id=effective_user_id,
                    biz_type=f"{module}_server_upload",
                    biz_id=str(file_record.id),
                    metadata={
                        "module": module,
                        "context_type": context_type,
                    },
                )
            except Exception as billing_exc:
                logger.warning(
                    "OSS 存储计量失败（不影响文件注册）: module=%s, file=%s, err=%s",
                    module, file_record.id, billing_exc,
                )
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(meter_key="storage.register", organization_id=organization_id, biz_type=f"{module}_server_upload", error=str(billing_exc))
                except Exception:
                    pass

        logger.info(
            "FileRegistry 注册成功: module=%s, context=%s/%s, file_id=%s, size=%d",
            module, context_type, context_id, file_record.id, file_size,
        )

        return file_record

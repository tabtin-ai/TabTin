from __future__ import annotations

import hashlib
import logging
import mimetypes
import posixpath
import uuid
from copy import deepcopy
from typing import Any
from urllib.parse import quote, urlparse

from apps.chat.conversation.services.workspace_file.constants import (
    MAX_MATERIALIZE_BYTES,
    SIGNED_URL_TTL_SECONDS,
)
from apps.chat.conversation.services.workspace_file.path import (
    basename_of,
    canonicalize_artifact_relative_path,
    is_deliverable_relative_path,
)
from apps.services.agent_engine.services.device_runtime_query_service import (
    DeviceRuntimeQueryService,
)
from apps.services.oss.services.factory import get_oss_service
from apps.services.oss.services.file_registry import FileRegistryService

_LOCAL_FILE_KIND = "local_file"
_OSS_FILE_KIND = "oss_file"
_RESTORE_ROOT = "artifacts/continuations"
_UPLOAD_SOURCE = "session_continuation"
_CONTEXT_TYPE = "session_continuation_local_file"

logger = logging.getLogger(__name__)


class ContinuationLocalFileHandoffError(ValueError):
    pass


class ContinuationLocalFileTooLargeError(ContinuationLocalFileHandoffError):
    def __init__(self, *, filename: str, size_bytes: int):
        super().__init__("分享会话文件超过50MB")
        self.filename = filename
        self.size_bytes = size_bytes
        self.limit_bytes = MAX_MATERIALIZE_BYTES


def prepare_local_file_handoffs(
    *,
    continuation_id: str,
    organization_id: str,
    source_session_id: str,
    source,
    sender_user,
    turns: list[dict],
    include_context: bool = True,
) -> tuple[list[dict], list[dict]]:
    """Upload source-session local files to OSS and annotate frozen turns.

    The returned turns still contain ``artifact_kind=local_file`` because the
    recipient should open the restored workspace path. The stable FileRecord ID
    is stored in metadata so ``create_task`` can restore the bytes later.
    """
    if not include_context:
        return _dialogue_only_turns(turns), []

    handoffs: list[dict] = []
    replacements: dict[str, dict] = {}
    refs = _collect_local_file_refs(turns)
    if not refs:
        return turns, handoffs
    workspace = getattr(source, "workspace", None)
    if workspace is None:
        raise ContinuationLocalFileHandoffError("来源 Workspace 不存在，无法交接本地文件")

    device_query = DeviceRuntimeQueryService(user=sender_user)
    uploaded_records: list[dict] = []
    try:
        for relative_path, ref in refs.items():
            restored_path = _target_relative_path(
                continuation_id=continuation_id,
                relative_path=relative_path,
            )
            uploaded = _upload_source_file(
                continuation_id=continuation_id,
                organization_id=organization_id,
                source_session_id=source_session_id,
                workspace=workspace,
                owner_user_id=str(sender_user.id),
                relative_path=relative_path,
                filename=ref["filename"],
                mime_type=ref["mime_type"],
                device_query=device_query,
            )
            uploaded_records.append(uploaded)
            handoff = {
                "kind": _LOCAL_FILE_KIND,
                "id": str(uploaded["file_id"]),
                "label": ref["filename"],
                "source_relative_path": relative_path,
                "target_relative_path": restored_path,
                "filename": ref["filename"],
                "mime_type": uploaded["mime_type"],
                "file_size": uploaded["file_size"],
                "content_version": uploaded["content_version"],
                "unavailable": True,
                "reason": "等待接收方恢复本地文件",
            }
            handoffs.append(handoff)
            replacements[relative_path] = handoff
    except Exception:
        _cleanup_uploaded_local_files(uploaded_records)
        raise

    return _rewrite_turn_local_file_payloads(turns, replacements), handoffs


def restore_local_file_handoffs(
    *,
    continuation,
    recipient_user,
    workspace,
    turns: list[dict],
) -> tuple[list[dict], list[dict]]:
    handoffs = [
        resource
        for resource in continuation.resources_json
        if isinstance(resource, dict) and resource.get("kind") == _LOCAL_FILE_KIND
    ]
    if not handoffs:
        return turns, list(continuation.resources_json or [])
    device_query = DeviceRuntimeQueryService(user=recipient_user)
    updated_resources: list[dict] = []
    restored_by_source: dict[str, dict] = {}
    for resource in continuation.resources_json or []:
        if not isinstance(resource, dict) or resource.get("kind") != _LOCAL_FILE_KIND:
            updated_resources.append(resource)
            continue
        restored = _restore_one_file(
            continuation=continuation,
            resource=resource,
            workspace=workspace,
            recipient_user=recipient_user,
            device_query=device_query,
        )
        updated_resources.append(restored)
        if not restored.get("unavailable"):
            source_path = str(restored.get("source_relative_path") or "")
            if source_path:
                restored_by_source[source_path] = restored

    return _rewrite_turn_local_file_payloads(turns, restored_by_source), updated_resources


def _collect_local_file_refs(turns: list[dict]) -> dict[str, dict]:
    refs: dict[str, dict] = {}
    for turn in turns or []:
        blocks = turn.get("blocks") if isinstance(turn, dict) else None
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            payload = _file_payload(block)
            if payload is None:
                continue
            relative_path = (
                payload.get("relative_path")
                if payload.get("artifact_kind") == _LOCAL_FILE_KIND
                else payload.get("source_relative_path")
            )
            canonical = canonicalize_artifact_relative_path(
                str(relative_path or "")
            )
            if not canonical or not is_deliverable_relative_path(canonical):
                continue
            refs.setdefault(canonical, {
                "filename": str(payload.get("filename") or basename_of(canonical) or ""),
                "mime_type": str(
                    payload.get("mime_type")
                    or mimetypes.guess_type(canonical)[0]
                    or "application/octet-stream"
                ),
            })
    return refs


def _local_file_payload(block: Any) -> dict | None:
    payload = _file_payload(block)
    if payload is not None and payload.get("artifact_kind") == _LOCAL_FILE_KIND:
        return payload
    return None


def _file_payload(block: Any) -> dict | None:
    if not isinstance(block, dict):
        return None
    payload = block.get("payload")
    if (
        block.get("type") == "tabtin_rich_content"
        and block.get("kind") == "file"
        and isinstance(payload, dict)
    ):
        return payload
    return None


def _upload_source_file(
    *,
    continuation_id: str,
    organization_id: str,
    source_session_id: str,
    workspace,
    owner_user_id: str,
    relative_path: str,
    filename: str,
    mime_type: str,
    device_query: DeviceRuntimeQueryService,
) -> dict:
    probe = device_query.dispatch_owner_workspace_fs_action(
        workspace=workspace,
        action="fs.materialize_file_ref",
        params={"relative_path": relative_path, "phase": "probe"},
        execution_owner_user_id=owner_user_id,
        timeout_seconds=20,
    )
    if not probe.get("success"):
        raise ContinuationLocalFileHandoffError(
            str(probe.get("error") or "本地文件探测失败")
        )
    data = probe.get("data") or {}
    content_version = str(data.get("content_version") or "")
    size_bytes = data.get("size_bytes")
    if not content_version:
        raise ContinuationLocalFileHandoffError("设备未返回本地文件内容版本")
    if isinstance(size_bytes, int) and size_bytes > MAX_MATERIALIZE_BYTES:
        raise ContinuationLocalFileTooLargeError(
            filename=filename,
            size_bytes=size_bytes,
        )

    content_type = str(data.get("mime_type") or mime_type or "application/octet-stream")
    object_key = _object_key(
        organization_id=organization_id,
        continuation_id=continuation_id,
        relative_path=relative_path,
    )
    oss = get_oss_service()
    upload_url = oss.generate_presigned_url(
        object_key,
        expiration=SIGNED_URL_TTL_SECONDS,
        method="PUT",
        content_type=content_type,
    )
    upload_host = (urlparse(str(upload_url or "")).hostname or "").lower()
    if not upload_host:
        raise ContinuationLocalFileHandoffError("本地文件上传地址无效")
    upload = device_query.dispatch_owner_workspace_fs_action(
        workspace=workspace,
        action="fs.materialize_file_ref",
        params={
            "relative_path": relative_path,
            "phase": "upload",
            "content_version": content_version,
            "presign": {
                "object_key": object_key,
                "upload_url": upload_url,
                "content_type": content_type,
                "max_bytes": MAX_MATERIALIZE_BYTES,
                "allowed_hosts": [upload_host],
            },
        },
        execution_owner_user_id=owner_user_id,
        timeout_seconds=60,
    )
    if not upload.get("success"):
        raise ContinuationLocalFileHandoffError(
            str(upload.get("error") or "本地文件上传失败")
        )
    upload_data = upload.get("data") or {}
    final_size = (
        upload_data.get("size_bytes")
        if isinstance(upload_data.get("size_bytes"), int)
        else size_bytes
    )
    file_record = FileRegistryService.register_uploaded_file(
        object_key=object_key,
        file_name=filename,
        file_size=int(final_size or 0),
        content_type=str(upload_data.get("mime_type") or content_type),
        module="chat",
        user_id=owner_user_id,
        organization_id=organization_id,
        context_type=_CONTEXT_TYPE,
        context_id=continuation_id,
        upload_source=_UPLOAD_SOURCE,
        metadata={
            "source_session_id": source_session_id,
            "source_relative_path": relative_path,
            "content_version": content_version,
        },
    )
    return {
        "file_id": str(file_record.id),
        "object_key": object_key,
        "file_size": int(final_size or file_record.file_size or 0),
        "mime_type": file_record.mime_type or content_type,
        "content_version": content_version,
    }


def _restore_one_file(
    *,
    continuation,
    resource: dict,
    workspace,
    recipient_user,
    device_query: DeviceRuntimeQueryService,
) -> dict:
    file_id = str(resource.get("id") or "")
    target_path = str(resource.get("target_relative_path") or "")
    if not file_id or not target_path:
        raise ContinuationLocalFileHandoffError("本地文件交接记录不完整")
    from apps.services.oss.models import FileRecord

    file_record = FileRecord.objects.filter(
        id=file_id,
        organization_id=str(getattr(workspace, "organization_id", "") or ""),
        status="completed",
    ).first()
    if file_record is None:
        raise ContinuationLocalFileHandoffError("云端文件不存在")
    _grant_local_file_viewer(
        file_id=file_id,
        sender_user_id=str(continuation.sender_user_id),
        recipient_user=recipient_user,
    )
    oss = get_oss_service()
    download_url = oss.generate_presigned_url(
        file_record.file_key,
        expiration=SIGNED_URL_TTL_SECONDS,
        method="GET",
    )
    download_host = (urlparse(str(download_url or "")).hostname or "").lower()
    if not download_host:
        raise ContinuationLocalFileHandoffError("云端下载地址无效")
    result = device_query.dispatch_owner_workspace_fs_action(
        workspace=workspace,
        action="fs.restore_file_from_url",
        params={
            "target_relative_path": target_path,
            "download_url": download_url,
            "expected_size_bytes": file_record.file_size,
            "allowed_hosts": [download_host],
        },
        execution_owner_user_id=str(recipient_user.id),
        timeout_seconds=60,
    )
    if not result.get("success"):
        raise ContinuationLocalFileHandoffError(
            str(result.get("error") or "接收方文件恢复失败")
        )
    return {
        **resource,
        "unavailable": False,
        "reason": "",
        "restored": True,
    }


def _grant_local_file_viewer(*, file_id: str, sender_user_id: str, recipient_user) -> None:
    from apps.tabtinspace.models import FilePermission
    from apps.tabtinspace.services.cloud_resource_acl import (
        TABFILES_SHARED_PERMISSION,
        role_at_least,
    )

    permission = FilePermission.objects.filter(
        file_record_id=file_id,
        subject_type="user",
        subject_id=str(recipient_user.id),
    ).first()
    if permission is not None and permission.is_active and role_at_least(
        permission.permission,
        TABFILES_SHARED_PERMISSION,
    ):
        return
    if permission is None:
        FilePermission.objects.create(
            file_record_id=file_id,
            subject_type="user",
            subject_id=str(recipient_user.id),
            permission=TABFILES_SHARED_PERMISSION,
            is_active=True,
            granted_by=sender_user_id,
        )
        return
    permission.permission = TABFILES_SHARED_PERMISSION
    permission.is_active = True
    permission.granted_by = sender_user_id
    permission.save(update_fields=["permission", "is_active", "granted_by", "updated_at"])


def _rewrite_turn_local_file_payloads(
    turns: list[dict],
    replacements: dict[str, dict],
) -> list[dict]:
    if not replacements:
        return turns
    rewritten = deepcopy(turns)
    for turn in rewritten:
        blocks = turn.get("blocks") if isinstance(turn, dict) else None
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            payload = _file_payload(block)
            if payload is None:
                continue
            artifact_kind = str(payload.get("artifact_kind") or "")
            source_path = (
                payload.get("relative_path")
                if artifact_kind == _LOCAL_FILE_KIND
                else payload.get("source_relative_path")
            )
            canonical = canonicalize_artifact_relative_path(str(source_path or ""))
            replacement = replacements.get(str(canonical or ""))
            if replacement is None and artifact_kind == _OSS_FILE_KIND:
                replacement = _legacy_oss_replacement(payload, replacements)
            if replacement is None:
                continue
            replacement_source_path = str(
                replacement.get("source_relative_path") or canonical or ""
            )
            target_path = str(
                replacement.get("target_relative_path") or replacement_source_path
            )
            file_id = str(replacement.get("id") or payload.get("handoff_file_id") or "")
            source_file_id = str(payload.get("file_id") or payload.get("source_file_id") or "")
            payload["artifact_kind"] = _LOCAL_FILE_KIND
            payload["relative_path"] = target_path
            payload["url"] = (
                "tabtin://resource/file/"
                f"{quote(target_path, safe='')}?hint=tabfiles"
            )
            payload["handoff_file_id"] = file_id
            payload["source_relative_path"] = replacement_source_path
            if source_file_id:
                payload["source_file_id"] = source_file_id
            payload.pop("file_id", None)
            payload.pop("access_url", None)
            if replacement.get("file_size") is not None:
                payload["file_size"] = replacement.get("file_size")
            if replacement.get("mime_type"):
                payload["mime_type"] = replacement.get("mime_type")
    return rewritten


def _legacy_oss_replacement(payload: dict, replacements: dict[str, dict]) -> dict | None:
    """兼容尚未携带 source_relative_path 的 runtime 产物卡。

    仅自动注册的 OSS 卡，且文件名与大小都唯一匹配时才回绑，避免把用户单独上传的
    同名云文件误认为本地产物。
    """
    if payload.get("auto_register") is not True:
        return None
    filename = str(payload.get("filename") or "")
    file_size = payload.get("file_size")
    if not filename or not isinstance(file_size, int):
        return None
    matches = [
        replacement
        for replacement in replacements.values()
        if str(replacement.get("filename") or "") == filename
        and replacement.get("file_size") == file_size
    ]
    return matches[0] if len(matches) == 1 else None


def _dialogue_only_turns(turns: list[dict]) -> list[dict]:
    """复制纯对话快照并移除文件/资源上下文；源会话消息绝不原地改写。"""
    rewritten = deepcopy(turns)
    kept_turns: list[dict] = []
    for turn in rewritten:
        if not isinstance(turn, dict):
            continue
        blocks = turn.get("blocks")
        if isinstance(blocks, list):
            turn["blocks"] = [
                block
                for block in blocks
                if not _is_context_artifact_block(block)
            ]
        if turn.get("blocks") or str(turn.get("text") or "").strip():
            kept_turns.append(turn)
    return kept_turns


def _is_context_artifact_block(block: Any) -> bool:
    if not isinstance(block, dict):
        return False
    if block.get("type") in {"file", "image", "document"}:
        return True
    return (
        block.get("type") == "tabtin_rich_content"
        and block.get("kind") in {
            "file",
            "image",
            "document",
            "resource_ref",
            "platform_resource",
            "widget",
        }
    )


def _target_relative_path(*, continuation_id: str, relative_path: str) -> str:
    filename = basename_of(relative_path) or "file"
    source_hash = hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:12]
    return posixpath.join(
        _RESTORE_ROOT,
        continuation_id.replace("-", "")[:12],
        f"{source_hash}-{filename}",
    )


def _object_key(*, organization_id: str, continuation_id: str, relative_path: str) -> str:
    filename = basename_of(relative_path) or "file"
    safe_name = filename.replace("/", "_").replace("\\", "_")
    return posixpath.join(
        "session-continuation",
        organization_id,
        continuation_id,
        uuid.uuid4().hex,
        safe_name,
    )


def _cleanup_uploaded_local_files(uploaded_records: list[dict]) -> None:
    if not uploaded_records:
        return
    from apps.services.oss.models import FileRecord, FileUsage

    try:
        oss = get_oss_service()
    except Exception:
        logger.warning(
            "[session-continuation] cleanup uploaded local file objects disabled",
            exc_info=True,
        )
        oss = None
    for uploaded in uploaded_records:
        file_id = str(uploaded.get("file_id") or "")
        object_key = str(uploaded.get("object_key") or "")
        record = FileRecord.objects.filter(
            id=file_id,
            upload_source=_UPLOAD_SOURCE,
        ).first()
        if record is not None:
            for usage in FileUsage.objects.filter(file_record=record, is_active=True):
                usage.deactivate()
            record.soft_delete()
        if oss is None or not object_key:
            continue
        try:
            oss.delete_file(object_key)
        except Exception:
            logger.warning(
                "[session-continuation] cleanup uploaded local file object failed key=%s",
                object_key,
                exc_info=True,
            )

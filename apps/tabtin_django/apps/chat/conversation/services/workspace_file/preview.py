"""SessionShare 会话本地文件按需预览编排。"""

from __future__ import annotations

import logging
import mimetypes
import os
from typing import Any, Optional
from urllib.parse import urlparse
from uuid import UUID

from django.utils import timezone

from apps.chat.conversation.models import (
    ChatSession,
    SessionWorkspaceFileReference,
    SessionWorkspaceFileSnapshot,
)
from apps.chat.conversation.services import session_share_service
from apps.chat.conversation.services.workspace_file.constants import (
    DEVICE_HARD_ERROR_CODES,
    INLINE_IMAGE_EXTENSIONS,
    INLINE_PREVIEW_KINDS,
    MAX_MATERIALIZE_BYTES,
    OFFICE_EXTENSIONS,
    PREVIEW_KIND_AUDIO,
    PREVIEW_KIND_BINARY,
    PREVIEW_KIND_IMAGE,
    PREVIEW_KIND_PDF,
    PREVIEW_KIND_TEXT,
    PREVIEW_KIND_VIDEO,
    SHARED_PREVIEW_DENIED,
    SHARED_PREVIEW_INVALID_PATH,
    SHARED_PREVIEW_NOT_INDEXED,
    SHARED_PREVIEW_TOO_LARGE,
    SIGNED_URL_TTL_SECONDS,
    SNAPSHOT_TTL,
    TEXT_EXTENSIONS,
    VIDEO_EXTENSIONS,
    AUDIO_EXTENSIONS,
)
from apps.chat.conversation.services.workspace_file.path import (
    canonicalize_artifact_relative_path,
)
from apps.chat.conversation.services.workspace_file.reference import (
    ensure_workspace_file_refs_indexed,
    force_refresh_workspace_file_refs_index,
    get_active_workspace_file_ref,
)
from apps.services.agent_engine.services.device_runtime_query_service import (
    DeviceRuntimeQueryService,
)
from apps.services.oss.services.client_reachable_url import (
    rewrite_loopback_absolute_url_for_request,
)
from apps.services.oss.services.factory import get_oss_service

logger = logging.getLogger(__name__)


def guess_preview_kind(relative_path: str) -> str:
    ext = os.path.splitext(relative_path)[1].lower()
    if ext == ".pdf":
        return PREVIEW_KIND_PDF
    if ext in OFFICE_EXTENSIONS:
        return OFFICE_EXTENSIONS[ext]
    if ext in INLINE_IMAGE_EXTENSIONS:
        return PREVIEW_KIND_IMAGE
    if ext in VIDEO_EXTENSIONS:
        return PREVIEW_KIND_VIDEO
    if ext in AUDIO_EXTENSIONS:
        return PREVIEW_KIND_AUDIO
    if ext in TEXT_EXTENSIONS:
        return PREVIEW_KIND_TEXT
    return PREVIEW_KIND_BINARY


def prefers_inline_preview(kind: str) -> bool:
    return kind in INLINE_PREVIEW_KINDS


def resolve_shared_preview_access(
    *,
    session_id: str,
    user,
    share_id: str | None = None,
) -> tuple[Optional[ChatSession], Optional[str], Optional[str]]:
    """返回 (session, owner_user_id, error_code)。

    owner 本人或 active SessionShare grantee 可访问；携带 share_id 时只认当前卡。
    """
    try:
        UUID(str(session_id))
    except (TypeError, ValueError, AttributeError):
        return None, None, "FORBIDDEN"

    session = (
        ChatSession.objects.select_related("workspace")
        .filter(id=session_id)
        .first()
    )
    if session is None:
        return None, None, "FORBIDDEN"

    user_id = str(getattr(user, "id", "") or "")
    if share_id is not None:
        share = session_share_service.get_active_share_by_id_for_user(
            share_id=share_id,
            session_id=session_id,
            user=user,
        )
        if share is None:
            return None, None, "FORBIDDEN"
        return session, str(share.owner_user_id), None

    if str(session.user_id) == user_id:
        return session, user_id, None

    share = session_share_service.get_active_share(session_id=session_id, user=user)
    if share is None:
        return None, None, "FORBIDDEN"
    return session, str(share.owner_user_id), None


def build_object_key(*, organization_id: str, session_id: str, ref_id: str, content_version: str) -> str:
    safe_version = content_version.replace("/", "_")[:120]
    return (
        f"session-share/{organization_id}/{session_id}/"
        f"{ref_id}/{safe_version}"
    )


class WorkspaceFilePreviewService:
    def __init__(self, user, request=None):
        self.user = user
        # 用于把 Local OSS 环回 signed_url 改写成客户端可达 Host（ 方案 A）
        self.request = request
        self._device_query = DeviceRuntimeQueryService(user=user)

    def preview(
        self,
        *,
        session_id: str,
        relative_path: str,
        timeout_seconds: int = 25,
        share_id: str | None = None,
    ) -> dict[str, Any]:
        session, owner_user_id, denied = resolve_shared_preview_access(
            session_id=session_id,
            user=self.user,
            share_id=share_id,
        )
        if denied or session is None or owner_user_id is None:
            return self._error("FORBIDDEN", SHARED_PREVIEW_DENIED, 403)

        canonical = canonicalize_artifact_relative_path(relative_path)
        if not canonical:
            return self._error("INVALID_PATH", SHARED_PREVIEW_INVALID_PATH, 400)

        ref = get_active_workspace_file_ref(
            session_id=session.id,
            relative_path=canonical,
        )
        if ref is None:
            # 未命中时最多全量回填一次（缓存短路），兼容历史消息。
            ensure_workspace_file_refs_indexed(session)
            ref = get_active_workspace_file_ref(
                session_id=session.id,
                relative_path=canonical,
            )
        if ref is None:
            # 解析修复前漏索引的 shell 产物：强制重扫一次后再判定。
            if force_refresh_workspace_file_refs_index(session):
                ref = get_active_workspace_file_ref(
                    session_id=session.id,
                    relative_path=canonical,
                )
        if ref is None:
            return self._error("FILE_NOT_INDEXED", SHARED_PREVIEW_NOT_INDEXED, 404)

        workspace = session.workspace
        if workspace is None:
            return self._error(
                "WORKING_DIR_NOT_SET",
                "该 Workspace 尚未设置工作目录，无法预览设备文件",
                409,
            )

        # 索引已带体积时，inline / 物化前统一拒绝超限（含 .txt）。
        too_large = self._reject_if_known_too_large(ref)
        if too_large is not None:
            return too_large

        kind = guess_preview_kind(ref.relative_path)
        if prefers_inline_preview(kind):
            inline = self._preview_inline(
                workspace=workspace,
                owner_user_id=owner_user_id,
                relative_path=ref.relative_path,
                timeout_seconds=timeout_seconds,
                expected_kind=kind,
            )
            if inline.get("success"):
                inline_data = inline["data"]
                inline_size = inline_data.get("size")
                if (
                    isinstance(inline_size, int)
                    and inline_size > MAX_MATERIALIZE_BYTES
                ):
                    return self._error(
                        "FILE_TOO_LARGE",
                        SHARED_PREVIEW_TOO_LARGE,
                        413,
                    )
                return {
                    "success": True,
                    "ref_id": str(ref.id),
                    "filename": ref.filename or os.path.basename(ref.relative_path),
                    "relative_path": ref.relative_path,
                    "preview_kind": inline_data.get("kind") or kind,
                    "transport": {
                        "mode": "inline",
                        "data": inline_data,
                    },
                }
            # 设备硬故障直接返回；图片过大等改走物化。
            if inline.get("error_code") in DEVICE_HARD_ERROR_CODES:
                return inline

        if kind == PREVIEW_KIND_BINARY:
            return self._error(
                "PREVIEW_UNSUPPORTED",
                "该类型暂不支持预览",
                422,
            )

        return self._preview_materialized(
            session=session,
            ref=ref,
            workspace=workspace,
            owner_user_id=owner_user_id,
            timeout_seconds=timeout_seconds,
            preview_kind=kind,
        )

    def _reject_if_known_too_large(
        self,
        ref: SessionWorkspaceFileReference,
    ) -> Optional[dict[str, Any]]:
        size = ref.file_size
        if isinstance(size, int) and size > MAX_MATERIALIZE_BYTES:
            return self._error(
                "FILE_TOO_LARGE",
                SHARED_PREVIEW_TOO_LARGE,
                413,
            )
        return None

    def _preview_inline(
        self,
        *,
        workspace,
        owner_user_id: str,
        relative_path: str,
        timeout_seconds: int,
        expected_kind: str,
    ) -> dict[str, Any]:
        result = self._device_query.dispatch_owner_workspace_fs_action(
            workspace=workspace,
            action="fs.read_file_preview",
            params={"path": relative_path},
            execution_owner_user_id=owner_user_id,
            timeout_seconds=timeout_seconds,
        )
        if not result.get("success"):
            return result
        data = result.get("data") or {}
        kind = data.get("kind")
        if kind not in INLINE_PREVIEW_KINDS:
            return self._error(
                "PREVIEW_REQUIRES_MATERIALIZE",
                "该文件需要物化后预览",
                409,
            )
        if (
            expected_kind == PREVIEW_KIND_IMAGE
            and kind == PREVIEW_KIND_BINARY
            and data.get("truncated")
        ):
            return self._error(
                "PREVIEW_REQUIRES_MATERIALIZE",
                "图片过大，改走物化预览",
                409,
            )
        # 剥掉任何可能残留的 path
        safe = {
            k: v
            for k, v in data.items()
            if k in {"kind", "content", "size", "truncated", "mime"}
        }
        return {"success": True, "data": safe}

    def _preview_materialized(
        self,
        *,
        session: ChatSession,
        ref: SessionWorkspaceFileReference,
        workspace,
        owner_user_id: str,
        timeout_seconds: int,
        preview_kind: str,
    ) -> dict[str, Any]:
        mime_type = (
            ref.mime_type
            or mimetypes.guess_type(ref.relative_path)[0]
            or "application/octet-stream"
        )
        # 各阶段各自遵守 API timeout_seconds；不再强制把 upload 抬到 60s。
        probe_timeout = max(5, min(timeout_seconds, 20))
        upload_timeout = max(5, timeout_seconds)
        probe = self._device_query.dispatch_owner_workspace_fs_action(
            workspace=workspace,
            action="fs.materialize_file_ref",
            params={
                "relative_path": ref.relative_path,
                "phase": "probe",
            },
            execution_owner_user_id=owner_user_id,
            timeout_seconds=probe_timeout,
        )
        if not probe.get("success"):
            return probe
        probe_data = probe.get("data") or {}
        content_version = str(probe_data.get("content_version") or "")
        size_bytes = probe_data.get("size_bytes")
        if not content_version:
            return self._error("PREVIEW_FAILED", "设备未返回内容版本", 502)
        if isinstance(size_bytes, int) and size_bytes > MAX_MATERIALIZE_BYTES:
            return self._error(
                "FILE_TOO_LARGE",
                SHARED_PREVIEW_TOO_LARGE,
                413,
            )

        existing = (
            SessionWorkspaceFileSnapshot.objects.filter(
                reference=ref,
                content_version=content_version,
                status="ready",
            )
            .order_by("-ready_at")
            .first()
        )
        now = timezone.now()
        if (
            existing is not None
            and existing.expires_at
            and existing.expires_at > now
            and existing.object_key
        ):
            return self._signed_response(ref, existing, preview_kind)

        object_key = build_object_key(
            organization_id=str(session.organization_id),
            session_id=str(session.id),
            ref_id=str(ref.id),
            content_version=content_version,
        )
        oss = get_oss_service()
        upload_url = oss.generate_presigned_url(
            object_key,
            expiration=SIGNED_URL_TTL_SECONDS,
            method="PUT",
            content_type=mime_type,
        )
        upload_host = (urlparse(str(upload_url or "")).hostname or "").lower()
        if not upload_host:
            return self._error("PREVIEW_FAILED", "物化上传地址无效", 502)

        snapshot, _created = SessionWorkspaceFileSnapshot.objects.update_or_create(
            reference=ref,
            content_version=content_version,
            defaults={
                "session": session,
                "object_key": object_key,
                "size_bytes": size_bytes if isinstance(size_bytes, int) else None,
                "mime_type": mime_type,
                "preview_kind": preview_kind,
                "status": "pending",
                "error_code": "",
                "error_message": "",
                "expires_at": now + SNAPSHOT_TTL,
            },
        )

        upload_result = self._device_query.dispatch_owner_workspace_fs_action(
            workspace=workspace,
            action="fs.materialize_file_ref",
            params={
                "relative_path": ref.relative_path,
                "phase": "upload",
                "content_version": content_version,
                "presign": {
                    "object_key": object_key,
                    "upload_url": upload_url,
                    "content_type": mime_type,
                    "max_bytes": MAX_MATERIALIZE_BYTES,
                    # 设备侧 fail-closed：只允许 PUT 到本次签出的 host。
                    "allowed_hosts": [upload_host],
                },
            },
            execution_owner_user_id=owner_user_id,
            timeout_seconds=upload_timeout,
        )
        if not upload_result.get("success"):
            snapshot.status = "failed"
            snapshot.error_code = str(upload_result.get("error_code") or "PREVIEW_FAILED")
            snapshot.error_message = str(upload_result.get("error") or "materialize failed")[:512]
            snapshot.save(
                update_fields=["status", "error_code", "error_message", "updated_at"],
            )
            return upload_result

        upload_data = upload_result.get("data") or {}
        snapshot.status = "ready"
        snapshot.ready_at = timezone.now()
        snapshot.size_bytes = (
            upload_data.get("size_bytes")
            if isinstance(upload_data.get("size_bytes"), int)
            else snapshot.size_bytes
        )
        snapshot.mime_type = str(upload_data.get("mime_type") or mime_type)
        snapshot.preview_kind = str(upload_data.get("preview_kind") or preview_kind)
        snapshot.expires_at = timezone.now() + SNAPSHOT_TTL
        snapshot.error_code = ""
        snapshot.error_message = ""
        snapshot.save(
            update_fields=[
                "status",
                "ready_at",
                "size_bytes",
                "mime_type",
                "preview_kind",
                "expires_at",
                "error_code",
                "error_message",
                "updated_at",
            ],
        )
        return self._signed_response(ref, snapshot, snapshot.preview_kind or preview_kind)

    def _signed_response(
        self,
        ref: SessionWorkspaceFileReference,
        snapshot: SessionWorkspaceFileSnapshot,
        preview_kind: str,
    ) -> dict[str, Any]:
        oss = get_oss_service()
        url = oss.generate_presigned_url(
            snapshot.object_key,
            expiration=SIGNED_URL_TTL_SECONDS,
            method="GET",
        )
        # GET 给远端客户端用：环回 base 对 LAN grantee 不可达，按请求 Host 改写。
        # PUT（设备物化上传）仍用配置的 upload_base（Owner 本机 127.0.0.1 可达）。
        url = rewrite_loopback_absolute_url_for_request(url, self.request)
        return {
            "success": True,
            "ref_id": str(ref.id),
            "filename": ref.filename or os.path.basename(ref.relative_path),
            "relative_path": ref.relative_path,
            "preview_kind": preview_kind,
            "content_version": snapshot.content_version,
            "size_bytes": snapshot.size_bytes,
            "mime_type": snapshot.mime_type,
            "transport": {
                "mode": "signed_url",
                "url": url,
                "expires_in": SIGNED_URL_TTL_SECONDS,
                "accept_ranges": True,
            },
        }

    @staticmethod
    def _error(code: str, message: str, http_status: int) -> dict[str, Any]:
        return {
            "success": False,
            "error": message,
            "error_code": code,
            "http_status": http_status,
        }


def revoke_session_workspace_file_snapshots(*, session: ChatSession) -> int:
    """共享撤销后：标记快照 revoked，并尽力删除 OSS 对象。"""
    qs = SessionWorkspaceFileSnapshot.objects.filter(
        session=session,
        status__in=["pending", "ready"],
    )
    count = 0
    oss = None
    for snapshot in qs.iterator(chunk_size=50):
        snapshot.status = "revoked"
        snapshot.save(update_fields=["status", "updated_at"])
        count += 1
        if not snapshot.object_key:
            continue
        try:
            if oss is None:
                oss = get_oss_service()
            oss.delete_file(snapshot.object_key)
        except Exception:
            logger.warning(
                "[WorkspaceFilePreview] delete snapshot object failed key=%s",
                snapshot.object_key,
                exc_info=True,
            )
    return count

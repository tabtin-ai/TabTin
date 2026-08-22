"""TabDoc HTML artifact 受控读取（继承文档权限，）。

产品口径：
- HTML 块不再有独立分享（HtmlArtifactShare）；浏览身份 = documentId + blockId
- 双通道鉴权：
  1. 登录用户有文档 viewer → 可打开（即使文档未分享）
  2. 否则须带有效 DocumentShare shareId，且属于该文档，走
     DocumentShareService.verify_share_access（public/org/password/expire/close/refresh）
- 关闭/轮换文档分享后旧外链失效；有文档权限的登录成员仍可开
- 服务端按 blockId 解析当前 fileId；块删除 fail-closed
- 协作未落库时可用 client_file_id + FileUsage 兜底（ACL 与已校验 DocumentShare，）

登录嵌入态仍走 load_for_document_member(fileId)；文档分享页内嵌仍走 load_for_share。
"""

from __future__ import annotations

import logging
import mimetypes
from dataclasses import dataclass
from typing import Any, Optional
from uuid import UUID

from django.conf import settings
from django.http import HttpResponse

from apps.services.common.public_share.exceptions import ShareNotFoundError
from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.services.factory import get_oss_service
from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.share_service import DocumentShareService

logger = logging.getLogger("tabdoc.html_artifact")

TABDOC_DB = (
    "default"
    if getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False)
    else "postgresql"
)
_HTML_EMBED_KEY_PREFIX = "tabdoc/html/"

_HTML_ARTIFACT_CSP = (
    "sandbox allow-scripts allow-popups; "
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; "
    "script-src * 'unsafe-inline' 'unsafe-eval'; "
    "style-src * 'unsafe-inline'; "
    "img-src * data: blob:; "
    "font-src * data:; "
    "connect-src 'none'; "
    "media-src * blob:; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'"
)


class HtmlArtifactAccessError(Exception):
    """受控 HTML 读取失败；对外统一映射为 404，避免探测文件是否存在。"""

    def __init__(self, reason: str = "not_found"):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class HtmlArtifactPayload:
    content: bytes
    content_type: str
    file_id: str
    file_name: str


def _is_html_content_type(content_type: str) -> bool:
    return content_type.split(";")[0].strip().lower() in {
        "text/html",
        "application/xhtml+xml",
    }


def _normalize_block_id(value: str | None) -> str:
    return (value or "").strip()


def _is_stable_block_id(block_id: str) -> bool:
    """浏览身份拒绝空 / 位置别名 ``auto_{index}`` ids。"""
    return bool(block_id) and not block_id.startswith("auto_")


def collect_html_block_file_ids(pm_json: Any) -> dict[str, str]:
    """Return ``{stable_block_id: file_id}`` for unique top-level htmlBlock nodes.

    Missing ids and ``auto_*`` position aliases are skipped (never browse identities).
    Duplicate stable blockIds are excluded so callers fail-closed instead of
    guessing which sibling block a link should bind to.
    """
    if not isinstance(pm_json, dict):
        return {}
    content = pm_json.get("content")
    if not isinstance(content, list):
        return {}
    mapping: dict[str, str] = {}
    ambiguous: set[str] = set()
    for node in content:
        if not isinstance(node, dict) or node.get("type") != "htmlBlock":
            continue
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        block_id = _normalize_block_id(attrs.get("blockId"))
        if not _is_stable_block_id(block_id):
            continue
        file_id = _normalize_block_id(attrs.get("fileId"))
        if not file_id:
            continue
        if block_id in mapping or block_id in ambiguous:
            mapping.pop(block_id, None)
            ambiguous.add(block_id)
            continue
        mapping[block_id] = file_id
    return mapping


def resolve_html_block_file_id(document: Document, block_id: str) -> UUID:
    """Resolve the current HTML fileId for a stable block identity."""
    normalized = _normalize_block_id(block_id)
    if not _is_stable_block_id(normalized):
        raise HtmlArtifactAccessError("block_missing")
    mapping = collect_html_block_file_ids(getattr(document, "description_json", None) or {})
    file_id = mapping.get(normalized)
    if not file_id:
        raise HtmlArtifactAccessError("block_missing")
    try:
        return UUID(str(file_id))
    except (TypeError, ValueError) as exc:
        raise HtmlArtifactAccessError("invalid_file_id") from exc


def resolve_html_block_file_id_with_hint(
    document: Document,
    block_id: str,
    *,
    client_file_id: str | None = None,
    allow_client_hint: bool = False,
) -> UUID:
    """Resolve block→fileId；允许 client_file_id 兜底协作未落库。

    刚插入的 htmlBlock 常只在 Yjs 内存里，``description_json`` 尚未经 onStore
    回流。此时「在浏览器打开」若只查库会误报 block_missing。

    ``allow_client_hint=True`` 时用编辑器侧 fileId + FileUsage 绑定做短期兜底
    （成员 ACL 或已通过 DocumentShare 校验的外链均可）。无 Usage 绑定的
    随机 UUID 仍 fail-closed 为 block_missing，避免凭 share 猜测任意文件。
    """
    try:
        return resolve_html_block_file_id(document, block_id)
    except HtmlArtifactAccessError as exc:
        if exc.reason != "block_missing" or not allow_client_hint:
            raise
    hint = _normalize_block_id(client_file_id)
    if not hint:
        raise HtmlArtifactAccessError("block_missing")
    try:
        file_uuid = UUID(hint)
    except (TypeError, ValueError) as exc:
        raise HtmlArtifactAccessError("invalid_file_id") from exc
    # 校验归属 / 命名空间；失败统一 block_missing，避免泄露文件是否存在
    try:
        _load_bound_artifact(document, file_uuid)
    except HtmlArtifactAccessError as exc:
        if exc.reason in {"file_missing", "usage_mismatch", "not_html_namespace", "org_mismatch", "not_html_mime"}:
            raise HtmlArtifactAccessError("block_missing") from exc
        raise
    return file_uuid


def _load_bound_artifact(document: Document, file_id: UUID) -> FileRecord:
    try:
        file_record = FileRecord.objects.get(id=file_id, status="completed")
    except FileRecord.DoesNotExist as exc:
        raise HtmlArtifactAccessError("file_missing") from exc

    key = (file_record.file_key or "").lstrip("/")
    if not key.startswith(_HTML_EMBED_KEY_PREFIX):
        raise HtmlArtifactAccessError("not_html_namespace")

    mime = (file_record.mime_type or "").strip()
    if mime and not _is_html_content_type(mime):
        # Allow empty mime for local/legacy records; still require .html key suffix.
        if not key.lower().endswith((".html", ".htm")):
            raise HtmlArtifactAccessError("not_html_mime")

    usage_exists = FileUsage.objects.filter(
        file_record=file_record,
        module="tabdoc",
        context_type="document",
        context_id=str(document.id),
        is_active=True,
    ).exists()
    if not usage_exists:
        raise HtmlArtifactAccessError("usage_mismatch")

    file_org = str(getattr(file_record, "organization_id", "") or "")
    doc_org = str(getattr(document, "organization_id", "") or "")
    if file_org and doc_org and file_org != doc_org:
        raise HtmlArtifactAccessError("org_mismatch")

    return file_record


def _download_payload(file_record: FileRecord) -> HtmlArtifactPayload:
    oss_service = get_oss_service()
    result = oss_service.download_file(file_record.file_key)
    if not result.get("success") or not result.get("data"):
        logger.warning(
            "html artifact download failed file_id=%s key=%s",
            file_record.id,
            file_record.file_key,
        )
        raise HtmlArtifactAccessError("download_failed")

    data = result["data"]
    content = data.get("content")
    if content is None:
        raise HtmlArtifactAccessError("empty_content")
    if isinstance(content, str):
        content = content.encode("utf-8")
    if not isinstance(content, (bytes, bytearray)):
        raise HtmlArtifactAccessError("invalid_content")

    content_type = (
        data.get("content_type")
        or file_record.mime_type
        or mimetypes.guess_type(file_record.file_key)[0]
        or "text/html"
    )
    if not _is_html_content_type(content_type) and not (file_record.file_key or "").lower().endswith(
        (".html", ".htm")
    ):
        raise HtmlArtifactAccessError("not_html_body")

    return HtmlArtifactPayload(
        content=bytes(content),
        content_type="text/html; charset=utf-8",
        file_id=str(file_record.id),
        file_name=file_record.file_name or "artifact.html",
    )


def build_html_artifact_response(payload: HtmlArtifactPayload) -> HttpResponse:
    response = HttpResponse(payload.content, content_type=payload.content_type)
    response["Cache-Control"] = "private, no-store"
    response["Pragma"] = "no-cache"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = _HTML_ARTIFACT_CSP
    response.xframe_options_exempt = True
    response.csp_override = True
    return response


def _assert_document_readable(document: Document) -> None:
    if getattr(document, "status", None) == "archived":
        raise HtmlArtifactAccessError("document_archived")
    if getattr(document, "is_trashed", False) or getattr(document, "trashed_at", None):
        raise HtmlArtifactAccessError("document_trashed")


class HtmlArtifactService:
    @classmethod
    def load_for_document_member(
        cls,
        *,
        document_id: UUID,
        file_id: UUID,
        user,
    ) -> HtmlArtifactPayload:
        """嵌入态：登录成员按文档 viewer + fileId 读取私有 HTML 字节。"""
        if not user or not getattr(user, "id", None):
            raise HtmlArtifactAccessError("unauthenticated")

        try:
            document = Document.objects.using(TABDOC_DB).get(id=document_id)
        except Document.DoesNotExist as exc:
            raise HtmlArtifactAccessError("document_missing") from exc

        svc = DocumentService(user=user)
        if not svc.check_document_permission(document, required_role="viewer"):
            raise HtmlArtifactAccessError("permission_denied")

        file_record = _load_bound_artifact(document, file_id)
        return _download_payload(file_record)

    @classmethod
    def load_for_share(
        cls,
        *,
        share_id: str,
        file_id: UUID,
        user=None,
        password: str = "",
    ) -> HtmlArtifactPayload:
        """文档分享页内嵌：复用 DocumentShare 鉴权后按 fileId 读取。"""
        share = DocumentShareService.get_share_by_id(share_id)
        DocumentShareService.verify_share_access(share, password=password, user=user)
        document = share.document
        file_record = _load_bound_artifact(document, file_id)
        return _download_payload(file_record)

    @classmethod
    def load_for_browser_open(
        cls,
        *,
        document_id: UUID,
        block_id: str,
        user=None,
        share_id: Optional[str] = None,
        password: str = "",
        client_file_id: Optional[str] = None,
    ) -> HtmlArtifactPayload:
        """「在浏览器打开」统一入口：documentId + blockId，可选文档 shareId。

        优先文档 viewer ACL；否则走 DocumentShare（须属于该文档）。
        成员带失效旧 share_id 时仍因 ACL 优先而放行。
        成员 ACL / 已校验 DocumentShare 均可在 FileUsage 绑定下用
        client_file_id 兜底协作未落库的新块。
        """
        try:
            document = Document.objects.using(TABDOC_DB).get(id=document_id)
        except Document.DoesNotExist as exc:
            raise HtmlArtifactAccessError("document_missing") from exc

        _assert_document_readable(document)

        has_acl = False
        if user and getattr(user, "id", None):
            svc = DocumentService(user=user)
            has_acl = bool(svc.check_document_permission(document, required_role="viewer"))

        if has_acl:
            file_id = resolve_html_block_file_id_with_hint(
                document,
                block_id,
                client_file_id=client_file_id,
                allow_client_hint=True,
            )
            return _download_payload(_load_bound_artifact(document, file_id))

        normalized_share_id = (share_id or "").strip()
        if normalized_share_id:
            share = DocumentShareService.get_share_by_id(normalized_share_id)
            if str(share.document_id) != str(document.id):
                # 跨文档 shareId：不泄露「分享存在但绑错文档」
                raise ShareNotFoundError("share does not belong to document")
            DocumentShareService.verify_share_access(
                share,
                password=password or "",
                user=user,
            )
            # 外链优先正文 blockId；协作未落库时允许已绑定该文档的 file_id 兜底
            # （：无 FileUsage 的随机 UUID 仍 block_missing）
            file_id = resolve_html_block_file_id_with_hint(
                document,
                block_id,
                client_file_id=client_file_id,
                allow_client_hint=True,
            )
            return _download_payload(_load_bound_artifact(document, file_id))

        raise HtmlArtifactAccessError("permission_denied")

    @classmethod
    def get_browser_link_context(
        cls,
        *,
        document_id: UUID,
        block_id: str,
        user,
        client_file_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """登录 viewer 获取浏览链接上下文（不授予分享管理权）。

        share_id 为当前 effective DocumentShare（可空）；块不存在 → block_missing。
        协作未落库时可用 client_file_id 校验绑定后仍签发链接。
        """
        if not user or not getattr(user, "id", None):
            raise HtmlArtifactAccessError("unauthenticated")

        try:
            document = Document.objects.using(TABDOC_DB).get(id=document_id)
        except Document.DoesNotExist as exc:
            raise HtmlArtifactAccessError("document_missing") from exc

        _assert_document_readable(document)
        svc = DocumentService(user=user)
        if not svc.check_document_permission(document, required_role="viewer"):
            raise HtmlArtifactAccessError("permission_denied")

        resolve_html_block_file_id_with_hint(
            document,
            block_id,
            client_file_id=client_file_id,
            allow_client_hint=True,
        )
        effective = DocumentShareService.get_effective_active_share(document)
        return {
            "document_id": str(document.id),
            "block_id": _normalize_block_id(block_id),
            "share_id": effective.share_id if effective else None,
            # 协作未落库时回传 hint，供稳定页 POST 继续用 fileId 兜底
            "file_id_hint": _normalize_block_id(client_file_id) or None,
        }

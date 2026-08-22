"""TabDoc image assets inherit document/member/share authorization."""

from __future__ import annotations

import mimetypes
from collections import Counter
from uuid import UUID
from urllib.parse import parse_qs, unquote, urlparse

from django.conf import settings
from django.db import transaction

from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.services.file_access import AccessibleFile, resolve_authorized_file
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.share_service import DocumentShareService


TABDOC_DB = (
    "default"
    if getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False)
    else "postgresql"
)


class ImageAssetAccessError(Exception):
    """Fail-closed image access error; API maps every instance to not found."""


def _load_bound_image(document: Document, file_id: UUID) -> FileRecord:
    try:
        file_record = FileRecord.objects.get(id=file_id, status="completed")
    except FileRecord.DoesNotExist as exc:
        raise ImageAssetAccessError("file_missing") from exc

    effective_mime = (file_record.mime_type or "").lower()
    if not effective_mime.startswith("image/"):
        guessed_mime, _ = mimetypes.guess_type(file_record.file_name or file_record.file_key)
        effective_mime = (guessed_mime or "").lower()
    if not effective_mime.startswith("image/"):
        raise ImageAssetAccessError("not_image")

    if not FileUsage.objects.filter(
        file_record=file_record,
        module="tabdoc",
        context_type="document",
        context_id=str(document.id),
        is_active=True,
    ).exists():
        raise ImageAssetAccessError("usage_mismatch")

    file_org = str(file_record.organization_id or "")
    document_org = str(document.organization_id or "")
    if not file_record.is_public and (
        not file_org or not document_org or file_org != document_org
    ):
        raise ImageAssetAccessError("organization_mismatch")
    return file_record


def _walk_image_nodes(value):
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if current.get("type") == "image":
                yield current
            children = current.get("content")
            if isinstance(children, list):
                stack.extend(reversed(children))
        elif isinstance(current, list):
            stack.extend(reversed(current))


def _clone_json_tree(value):
    """Iteratively clone JSON containers so future deep nodes cannot exhaust recursion."""
    if isinstance(value, dict):
        cloned = {}
    elif isinstance(value, list):
        cloned = []
    else:
        return value

    stack = [(value, cloned)]
    while stack:
        source, target = stack.pop()
        if isinstance(source, dict):
            for key, child in source.items():
                if isinstance(child, dict):
                    child_clone = {}
                    target[key] = child_clone
                    stack.append((child, child_clone))
                elif isinstance(child, list):
                    child_clone = []
                    target[key] = child_clone
                    stack.append((child, child_clone))
                else:
                    target[key] = child
        else:
            for child in source:
                if isinstance(child, dict):
                    child_clone = {}
                    target.append(child_clone)
                    stack.append((child, child_clone))
                elif isinstance(child, list):
                    child_clone = []
                    target.append(child_clone)
                    stack.append((child, child_clone))
                else:
                    target.append(child)
    return cloned


def _stable_file_id_from_src(src: str) -> UUID | None:
    prefix = "tabtin-file://asset/"
    normalized = (src or "").strip()
    if not normalized.startswith(prefix):
        return None
    try:
        return UUID(normalized[len(prefix):])
    except ValueError:
        return None


def _canonical_file_id(value) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    try:
        return str(UUID(normalized))
    except ValueError:
        # 历史正文可能含非 UUID 的旧标识；仍统一空白，避免扩大兼容例外。
        return normalized


def _src_matches_file_record(src: str, file_record: FileRecord) -> bool:
    normalized = (src or "").strip()
    if not normalized:
        return False
    parsed = urlparse(normalized)
    query_key = unquote((parse_qs(parsed.query).get("object_key") or [""])[0])
    if query_key and query_key.lstrip("/") == (file_record.file_key or "").lstrip("/"):
        return True
    without_query = normalized.split("?", 1)[0].rstrip("/")
    known_urls = {
        str(file_record.access_url or "").split("?", 1)[0].rstrip("/"),
        str(file_record.cdn_url or "").split("?", 1)[0].rstrip("/"),
    }
    if without_query and without_query in known_urls:
        return True
    path = unquote(parsed.path or "").lstrip("/")
    file_key = (file_record.file_key or "").lstrip("/")
    return bool(file_key and (path == file_key or path.endswith(f"/{file_key}")))


class ImageAssetService:
    @classmethod
    @transaction.atomic
    def adopt_document_import_job_images(
        cls,
        document: Document,
        pm_json: dict,
        *,
        user_id: UUID | str | None,
    ) -> set[str]:
        """Move private image usages from a completed import job to a document.

        The stable ``fileId`` carried by the import draft lets existing clients
        create the document without a new request field. Only assets staged by
        a completed job for the same organization and requester are eligible.
        """
        candidate_ids: set[UUID] = set()
        for node in _walk_image_nodes(pm_json if isinstance(pm_json, dict) else {}):
            attrs = node.get("attrs")
            if not isinstance(attrs, dict):
                continue
            raw_file_id = attrs.get("fileId") or _stable_file_id_from_src(
                str(attrs.get("src") or "")
            )
            if not raw_file_id:
                continue
            try:
                candidate_ids.add(UUID(str(raw_file_id)))
            except ValueError:
                continue
        if not candidate_ids:
            return set()

        staged_usages = list(
            FileUsage.objects.select_for_update()
            .select_related("file_record")
            .filter(
                file_record_id__in=candidate_ids,
                module="tabdoc",
                context_type="document_import_job",
                is_active=True,
            )
        )
        if not staged_usages:
            return set()

        from apps.services.docparse.models import DocumentImportJob

        normalized_user_id = str(user_id or "")
        job_ids = {usage.context_id for usage in staged_usages}
        jobs = {
            str(job.id): job
            for job in DocumentImportJob.objects.select_for_update().filter(id__in=job_ids)
        }
        adopted: set[str] = set()
        for usage in staged_usages:
            file_record = usage.file_record
            job = jobs.get(usage.context_id)
            if (
                job is None
                or job.status not in (
                    DocumentImportJob.Status.READY,
                    DocumentImportJob.Status.PARTIAL_READY,
                )
                or str(job.organization_id or "") != str(document.organization_id)
                or str(file_record.organization_id or "") != str(document.organization_id)
                or file_record.is_public
                or file_record.status != "completed"
                or not normalized_user_id
                or str(job.requested_by_id or "") != normalized_user_id
            ):
                raise ValueError("导入图片暂存引用与目标文档不匹配")

            FileUsage.add_usage(
                file_record,
                user_id,
                module="tabdoc",
                context_type="document",
                context_id=str(document.id),
            )
            usage.deactivate()
            adopted.add(str(file_record.id))
        return adopted

    @staticmethod
    def pm_json_contains_file_assets(pm_json: dict) -> bool:
        return any(
            str((node.get("attrs") or {}).get("fileId") or "").strip()
            or _stable_file_id_from_src(
                str((node.get("attrs") or {}).get("src") or "")
            )
            for node in _walk_image_nodes(pm_json)
            if isinstance(node.get("attrs"), dict)
        )

    @classmethod
    def normalize_pm_json_for_storage(
        cls,
        document: Document,
        pm_json: dict,
        *,
        existing_pm_json: dict | None = None,
    ) -> dict:
        """Persist stable file identity and scrub response-time signed URLs.

        A historical body can contain file identities that predate FileUsage
        binding. Whole-document saves may preserve that exact inventory, but
        they must not introduce or duplicate an unbound identity.
        """
        normalized = _clone_json_tree(pm_json) if isinstance(pm_json, dict) else {}
        existing_file_ids: Counter[str] = Counter()
        for existing_node in _walk_image_nodes(existing_pm_json or {}):
            existing_attrs = existing_node.get("attrs")
            if not isinstance(existing_attrs, dict):
                continue
            existing_file_id = existing_attrs.get("fileId") or _stable_file_id_from_src(
                str(existing_attrs.get("src") or "")
            )
            if existing_file_id:
                existing_file_ids[_canonical_file_id(existing_file_id)] += 1
        bound_records = {
            record.id: record
            for record in FileRecord.objects.filter(
                usages__module="tabdoc",
                usages__context_type="document",
                usages__context_id=str(document.id),
                usages__is_active=True,
                status="completed",
            ).distinct()
        }
        for node in _walk_image_nodes(normalized):
            attrs = node.setdefault("attrs", {})
            if not isinstance(attrs, dict):
                continue
            raw_file_id = attrs.get("fileId") or _stable_file_id_from_src(str(attrs.get("src") or ""))
            file_id = None
            if raw_file_id:
                existing_key = _canonical_file_id(raw_file_id)
                try:
                    file_id = UUID(existing_key)
                    _load_bound_image(document, file_id)
                except (ValueError, ImageAssetAccessError) as exc:
                    if existing_file_ids[existing_key] > 0:
                        existing_file_ids[existing_key] -= 1
                        attrs["fileId"] = str(file_id) if file_id else existing_key
                        attrs["src"] = ""
                        continue
                    raise ValueError("图片资产未绑定当前文档") from exc
            elif attrs.get("src"):
                file_id = next(
                    (
                        candidate_id
                        for candidate_id, record in bound_records.items()
                        if _src_matches_file_record(str(attrs.get("src") or ""), record)
                    ),
                    None,
                )
                if file_id:
                    try:
                        _load_bound_image(document, file_id)
                    except ImageAssetAccessError:
                        file_id = None
            if file_id:
                attrs["fileId"] = str(file_id)
                attrs["src"] = ""
        return normalized

    @classmethod
    def materialize_pm_json(
        cls,
        document: Document,
        pm_json: dict,
        *,
        expiration: int = 3600,
    ) -> dict:
        """Return an authorized response/export copy with current image URLs."""
        materialized = _clone_json_tree(pm_json) if isinstance(pm_json, dict) else {}
        for node in _walk_image_nodes(materialized):
            attrs = node.get("attrs")
            if not isinstance(attrs, dict):
                continue
            raw_file_id = attrs.get("fileId") or _stable_file_id_from_src(str(attrs.get("src") or ""))
            if not raw_file_id:
                continue
            try:
                file_record = _load_bound_image(document, UUID(str(raw_file_id)))
                attrs["fileId"] = str(file_record.id)
                attrs["src"] = resolve_authorized_file(
                    file_record,
                    expiration=expiration,
                ).url
            except (ValueError, ImageAssetAccessError):
                attrs["src"] = ""
        return materialized

    @classmethod
    def resolve_cover_url(cls, document: Document, *, expiration: int = 3600) -> str:
        """Resolve cover from stable FileRecord id; preserve legacy public covers."""
        properties = document.properties if isinstance(document.properties, dict) else {}
        file_id = str(properties.get("cover_image_file_id") or "").strip()
        if file_id:
            try:
                return resolve_authorized_file(
                    _load_bound_image(document, UUID(file_id)),
                    expiration=expiration,
                ).url
            except (ValueError, ImageAssetAccessError):
                return ""
        return build_public_asset_url(document.cover_image or "")

    @classmethod
    def resolve_for_document_member(
        cls,
        *,
        document_id: UUID,
        file_id: UUID,
        user,
        expiration: int = 3600,
    ) -> AccessibleFile:
        if not user or not getattr(user, "id", None):
            raise ImageAssetAccessError("unauthenticated")
        try:
            document = Document.objects.using(TABDOC_DB).get(id=document_id)
        except Document.DoesNotExist as exc:
            raise ImageAssetAccessError("document_missing") from exc
        if not DocumentService(user=user).check_document_permission(
            document,
            required_role="viewer",
        ):
            raise ImageAssetAccessError("permission_denied")
        return resolve_authorized_file(
            _load_bound_image(document, file_id),
            expiration=expiration,
        )

    @classmethod
    def resolve_for_share(
        cls,
        *,
        share_id: str,
        file_id: UUID,
        user=None,
        password: str = "",
        expiration: int = 3600,
    ) -> AccessibleFile:
        share = DocumentShareService.get_share_by_id(share_id)
        DocumentShareService.verify_share_access(
            share,
            password=password,
            user=user,
        )
        return resolve_authorized_file(
            _load_bound_image(share.document, file_id),
            expiration=expiration,
        )

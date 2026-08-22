"""Filesystem-backed OSS provider for a single-server TabTin deployment."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import posixpath
import shutil
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO, Dict, List
from urllib.parse import urlencode

from django.core.signing import TimestampSigner

from apps.i18n import _
from apps.services.common.exceptions import OSSServiceException
from apps.services.common.utils import generate_request_id

from .base import OSSServiceBase


class LocalFileOSSService(OSSServiceBase):
    """Single-server OSS provider backed by a shared persistent directory."""

    _COPY_CHUNK_SIZE = 1024 * 1024

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.bucket_name = config["bucket_name"]
        self.root_path = Path(config["root_path"]).expanduser().resolve()
        self.max_file_size = int(config.get("max_file_size") or 200 * 1024 * 1024)
        self.root_path.mkdir(parents=True, exist_ok=True)
        self._assert_storage_ready()

    def _assert_storage_ready(self) -> None:
        """Verify the configured volume with a real write/read/delete probe."""
        probe_dir = self.root_path / ".health"
        probe_path = probe_dir / f"{uuid.uuid4().hex}.probe"
        try:
            probe_dir.mkdir(parents=True, exist_ok=True)
            payload = os.urandom(32)
            with probe_path.open("wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            if probe_path.read_bytes() != payload:
                raise OSError("health probe read mismatch")
        except Exception as exc:
            raise OSSServiceException("本地对象存储目录不可读写") from exc
        finally:
            try:
                probe_path.unlink(missing_ok=True)
            except Exception:
                pass

    def _safe_key(self, object_key: str) -> str:
        key = posixpath.normpath((object_key or "").replace("\\", "/")).lstrip("/")
        if not key or key == "." or key.startswith("../") or "/../" in f"/{key}/":
            raise OSSServiceException(f"非法 object_key: {object_key}")
        return key

    def _path(self, object_key: str) -> Path:
        key = self._safe_key(object_key)
        path = (self.root_path / key).resolve()
        try:
            path.relative_to(self.root_path)
        except ValueError as exc:
            raise OSSServiceException(f"object_key 越界: {object_key}") from exc
        return path

    def _meta_path(self, object_key: str) -> Path:
        return self._path(f".metadata/{self._safe_key(object_key)}.json")

    def _write_meta(self, object_key: str, *, content_type: str, etag: str, file_size: int) -> None:
        path = self._meta_path(object_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "content_type": content_type or "application/octet-stream",
                    "etag": etag,
                    "file_size": file_size,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def _read_meta(self, object_key: str) -> dict[str, Any]:
        path = self._meta_path(object_key)
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    @staticmethod
    def _rewind_if_possible(file_obj: BinaryIO) -> None:
        try:
            file_obj.seek(0)
        except (AttributeError, OSError):
            pass

    def _stream_to_object(
        self,
        file_obj: BinaryIO,
        object_key: str,
        *,
        content_type: str,
    ) -> tuple[int, str]:
        key = self._safe_key(object_key)
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_dir = self.root_path / ".uploads"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_path = temp_dir / f"{uuid.uuid4().hex}.tmp"
        digest = hashlib.md5()  # noqa: S324 - matches existing FileRecord hash usage
        total = 0
        self._rewind_if_possible(file_obj)
        try:
            with temp_path.open("wb") as output:
                while True:
                    chunk = file_obj.read(self._COPY_CHUNK_SIZE)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > self.max_file_size:
                        raise OSSServiceException(
                            f"文件大小超过限制 {self.max_file_size} bytes"
                        )
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, target)
            etag = digest.hexdigest()
            self._write_meta(
                key,
                content_type=content_type,
                etag=etag,
                file_size=total,
            )
            return total, etag
        finally:
            temp_path.unlink(missing_ok=True)
            self._rewind_if_possible(file_obj)

    def upload_file(self, file_obj: BinaryIO, object_key: str, **kwargs) -> Dict[str, Any]:
        try:
            key = self._safe_key(object_key)
            content_type = kwargs.get("content_type") or mimetypes.guess_type(key)[0] or "application/octet-stream"
            file_size, etag = self._stream_to_object(
                file_obj,
                key,
                content_type=content_type,
            )
            return self.format_response(True, _("oss_service.file_upload_success"), {
                "object_key": key,
                "file_size": file_size,
                "file_hash": kwargs.get("file_hash") or etag,
                "etag": etag,
                "request_id": generate_request_id(),
                "access_url": self.build_access_url(key),
                "cdn_url": self.build_cdn_url(key),
            })
        except Exception as exc:
            return self._handle_exception("upload_file", exc)

    def upload_bytes(self, data: bytes, object_key: str, *, content_type: str = "application/octet-stream") -> str:
        result = self.upload_file(BytesIO(data), object_key, content_type=content_type)
        if result.get("success") and result.get("data"):
            return result["data"]["access_url"]
        raise OSSServiceException(result.get("message", "local upload failed"))

    def upload_file_from_path(self, file_path: str, object_key: str, **kwargs) -> Dict[str, Any]:
        with open(file_path, "rb") as handle:
            return self.upload_file(handle, object_key, **kwargs)

    def download_file(self, object_key: str, local_path: str = None) -> Dict[str, Any]:
        try:
            key = self._safe_key(object_key)
            source = self._path(key)
            if not source.is_file():
                raise OSSServiceException(f"文件不存在: {key}")
            if local_path:
                shutil.copyfile(source, local_path)
                data = {"object_key": key, "local_path": local_path, "file_size": source.stat().st_size}
            else:
                meta = self._read_meta(key)
                data = {
                    "object_key": key,
                    "content": source.read_bytes(),
                    "file_size": source.stat().st_size,
                    "content_type": meta.get("content_type") or mimetypes.guess_type(key)[0] or "application/octet-stream",
                }
            data["request_id"] = generate_request_id()
            return self.format_response(True, _("oss_service.file_download_success"), data)
        except Exception as exc:
            return self._handle_exception("download_file", exc)

    def delete_file(self, object_key: str) -> Dict[str, Any]:
        try:
            key = self._safe_key(object_key)
            path = self._path(key)
            if path.exists():
                path.unlink()
            meta = self._meta_path(key)
            if meta.exists():
                meta.unlink()
            return self.format_response(True, _("oss_service.file_delete_success"), {
                "object_key": key,
                "request_id": generate_request_id(),
            })
        except Exception as exc:
            return self._handle_exception("delete_file", exc)

    def delete_files(self, object_keys: List[str]) -> Dict[str, Any]:
        deleted: list[str] = []
        for object_key in object_keys:
            result = self.delete_file(object_key)
            if result.get("success"):
                deleted.append(self._safe_key(object_key))
        return self.format_response(True, _("oss_service.batch_delete_success", count=len(deleted)), {
            "deleted_keys": deleted,
            "delete_count": len(deleted),
            "request_id": generate_request_id(),
        })

    def copy_file(self, source_key: str, target_key: str, **kwargs) -> Dict[str, Any]:
        try:
            source = self._path(source_key)
            target = self._path(target_key)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            meta = self._read_meta(source_key)
            self._write_meta(
                target_key,
                content_type=meta.get("content_type") or "application/octet-stream",
                etag=meta.get("etag") or hashlib.md5(target.read_bytes()).hexdigest(),  # noqa: S324
                file_size=target.stat().st_size,
            )
            return self.format_response(True, _("oss_service.file_copy_success"), {
                "source_key": self._safe_key(source_key),
                "target_key": self._safe_key(target_key),
                "request_id": generate_request_id(),
                "access_url": self.build_access_url(target_key),
            })
        except Exception as exc:
            return self._handle_exception("copy_file", exc)

    def move_file(self, source_key: str, target_key: str, **kwargs) -> Dict[str, Any]:
        result = self.copy_file(source_key, target_key, **kwargs)
        if result.get("success"):
            self.delete_file(source_key)
        return result

    def list_files(self, prefix: str = "", max_keys: int = 100, **kwargs) -> Dict[str, Any]:
        safe_prefix = "" if not prefix else self._safe_key(prefix)
        files: list[dict[str, Any]] = []
        for path in sorted(self.root_path.rglob("*")):
            if not path.is_file():
                continue
            key = path.relative_to(self.root_path).as_posix()
            if key.startswith(".metadata/") or key.startswith(".multipart/"):
                continue
            if safe_prefix and not key.startswith(safe_prefix):
                continue
            meta = self._read_meta(key)
            files.append({
                "key": key,
                "size": path.stat().st_size,
                "etag": meta.get("etag", ""),
                "type": "Normal",
                "storage_class": "Local",
                "last_modified": path.stat().st_mtime,
                "access_url": self.build_access_url(key),
            })
            if len(files) >= max_keys:
                break
        return self.format_response(True, _("oss_service.file_list_success", count=len(files)), {
            "files": files,
            "file_count": len(files),
            "is_truncated": False,
            "next_marker": "",
            "prefix": prefix,
            "request_id": generate_request_id(),
        })

    def file_exists(self, object_key: str) -> bool:
        return self._path(object_key).is_file()

    def get_file_info(self, object_key: str) -> Dict[str, Any]:
        try:
            key = self._safe_key(object_key)
            path = self._path(key)
            if not path.is_file():
                raise OSSServiceException(f"文件不存在: {key}")
            meta = self._read_meta(key)
            return self.format_response(True, _("oss_service.file_info_success"), {
                "object_key": key,
                "content_length": path.stat().st_size,
                "content_type": meta.get("content_type") or mimetypes.guess_type(key)[0] or "application/octet-stream",
                "etag": meta.get("etag", ""),
                "last_modified": path.stat().st_mtime,
                "storage_class": "Local",
                "metadata": meta,
                "access_url": self.build_access_url(key),
                "request_id": generate_request_id(),
            })
        except Exception as exc:
            return self._handle_exception("get_file_info", exc)

    def generate_presigned_url(
        self,
        object_key: str,
        expiration: int = 3600,
        method: str = "GET",
        content_type: str | None = None,
        response_content_disposition: str | None = None,
    ) -> str:
        key = self._safe_key(object_key)
        method = method.upper()
        if method not in {"GET", "PUT"}:
            raise OSSServiceException(f"Local OSS does not support presigned {method}")
        base = self.config["upload_base_url"] if method == "PUT" else self.config["public_base_url"]
        ttl = max(1, min(int(expiration), 86400))
        signature = TimestampSigner().sign(f"{method}:{key}:{ttl}")
        query = {
            'object_key': key,
            'method': method,
            'expires': ttl,
            'content_type': content_type or '',
            # Ninja 的 bool query 不接受空字符串；显式传 0，避免图片预览 URL
            # 在进入 local_object 前被 schema 校验成 400。
            'download': '1' if response_content_disposition else '0',
            'signature': signature,
        }
        return f"{base}?{urlencode(query)}"

    def generate_bounded_upload(
        self,
        object_key: str,
        *,
        expiration: int,
        content_type: str,
        content_length: int,
    ) -> Dict[str, Any]:
        key = self._safe_key(object_key)
        ttl = max(1, min(int(expiration), 86400))
        signature = TimestampSigner().sign(f"PUT:{key}:{ttl}:{content_length}")
        query = urlencode({
            "object_key": key,
            "method": "PUT",
            "expires": ttl,
            "content_type": content_type,
            "content_length": content_length,
            "signature": signature,
        })
        return {"method": "PUT", "url": f"{self.config['upload_base_url']}?{query}", "fields": {}}

    def get_accessible_url(self, object_key: str, expiration: int = 3600) -> str:
        """Return a gated URL; signed GET also works for public local objects."""
        return self.generate_presigned_url(
            object_key,
            expiration=expiration,
            method="GET",
        )

    def init_multipart_upload(self, object_key: str, **kwargs) -> Dict[str, Any]:
        upload_id = uuid.uuid4().hex
        multipart_dir = self._path(f".multipart/{upload_id}")
        multipart_dir.mkdir(parents=True, exist_ok=False)
        (multipart_dir / "manifest.json").write_text(
            json.dumps({
                "object_key": self._safe_key(object_key),
                "content_type": kwargs.get("content_type") or "application/octet-stream",
            }),
            encoding="utf-8",
        )
        return self.format_response(True, _("oss_service.multipart_init_success"), {
            "upload_id": upload_id,
            "object_key": self._safe_key(object_key),
        })

    def upload_part(self, object_key: str, upload_id: str, part_number: int, data: bytes) -> Dict[str, Any]:
        part_path = self._path(f".multipart/{upload_id}/{part_number:08d}.part")
        part_path.parent.mkdir(parents=True, exist_ok=True)
        part_path.write_bytes(data)
        return self.format_response(True, _("oss_service.part_upload_success"), {
            "etag": hashlib.md5(data).hexdigest(),  # noqa: S324
            "part_number": part_number,
        })

    def complete_multipart_upload(self, object_key: str, upload_id: str, parts: List[Dict]) -> Dict[str, Any]:
        multipart_dir = self._path(f".multipart/{upload_id}")
        try:
            manifest = json.loads((multipart_dir / "manifest.json").read_text(encoding="utf-8"))
            key = self._safe_key(object_key)
            if manifest.get("object_key") != key:
                raise OSSServiceException("分片上传 object_key 不匹配")

            target = self._path(key)
            target.parent.mkdir(parents=True, exist_ok=True)
            temp_path = multipart_dir / "merged.tmp"
            digest = hashlib.md5()  # noqa: S324 - matches existing FileRecord hash usage
            total = 0
            with temp_path.open("wb") as output:
                for part in sorted(parts, key=lambda item: int(item["part_number"])):
                    part_path = multipart_dir / f"{int(part['part_number']):08d}.part"
                    with part_path.open("rb") as source:
                        while True:
                            chunk = source.read(self._COPY_CHUNK_SIZE)
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > self.max_file_size:
                                raise OSSServiceException(
                                    f"文件大小超过限制 {self.max_file_size} bytes"
                                )
                            digest.update(chunk)
                            output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, target)
            self._write_meta(
                key,
                content_type=manifest.get("content_type") or "application/octet-stream",
                etag=digest.hexdigest(),
                file_size=total,
            )
            shutil.rmtree(multipart_dir, ignore_errors=True)
            return self.format_response(True, _("oss_service.multipart_complete_success"), {
                "object_key": key,
                "access_url": self.build_access_url(key),
            })
        except Exception as exc:
            return self._handle_exception("complete_multipart_upload", exc)

    def abort_multipart_upload(self, object_key: str, upload_id: str) -> Dict[str, Any]:
        shutil.rmtree(self._path(f".multipart/{upload_id}"), ignore_errors=True)
        return self.format_response(True, _("oss_service.multipart_abort_success"), {
            "object_key": self._safe_key(object_key),
            "upload_id": upload_id,
        })

    def get_bucket_info(self) -> Dict[str, Any]:
        try:
            self._assert_storage_ready()
            return self.format_response(True, _("oss_service.bucket_info_success"), {
                "bucket_name": self.bucket_name,
                "region": "local",
                "endpoint": self.config["public_base_url"],
                "storage_class": "Local",
            })
        except Exception as exc:
            return self._handle_exception("get_bucket_info", exc)

    def validate_config(self) -> bool:
        try:
            self._assert_storage_ready()
            return True
        except OSSServiceException:
            return False

    def set_object_public_read(self, object_key: str) -> bool:
        return True

    def set_object_private(self, object_key: str) -> bool:
        # Local disk has no object ACL; privacy is enforced by local-object auth gates.
        return True

    def build_access_url(self, object_key: str) -> str:
        return f"{self.config['public_base_url']}?{urlencode({'object_key': self._safe_key(object_key)})}"

    def build_cdn_url(self, object_key: str) -> str:
        return ""

"""
桌面更新资产托管服务。

提供 updater 专用的：
1. 确定性对象键生成
2. 安装包直传确认与 Release 自动回填
3. Manifest 一键生成 / 覆盖上传
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal
from urllib.parse import SplitResult, urlsplit, urlunsplit

import yaml
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

from apps.services.common.utils import get_file_type_from_extension
from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.services.factory import get_updater_oss_service

from ..models import AppRelease

ReleaseAssetType = Literal["package", "manifest", "blockmap", "website_installer"]

_DEFAULT_UPLOAD_EXPIRATION_SECONDS = 15 * 60
_DEFAULT_MAX_ASSET_SIZE = 2 * 1024 * 1024 * 1024
_SYSTEM_USER_UUID = "00000000-0000-0000-0000-000000000000"
_PACKAGE_EXTENSIONS = {
    "zip",
    "dmg",
    "exe",
    "msi",
    "pkg",
    "appimage",
    "deb",
    "rpm",
    "nupkg",
}
_UPDATER_PACKAGE_EXTENSIONS_BY_PLATFORM = {
    "mac": {"zip"},
    "win": {"exe"},
    "linux": {"appimage"},
}
_UPDATER_PACKAGE_EXTENSION_LABELS = {
    "mac": ".zip",
    "win": ".exe",
    "linux": ".AppImage",
}
_WEBSITE_INSTALLER_EXTENSIONS_BY_PLATFORM = {
    "mac": {"dmg"},
    "win": {"exe"},
    "linux": {"appimage", "deb", "rpm"},
}
_WEBSITE_INSTALLER_EXTENSION_LABELS = {
    "mac": ".dmg",
    "win": ".exe",
    "linux": ".AppImage / .deb / .rpm",
}
_MANIFEST_EXTENSIONS = {"yml", "yaml"}
_SAFE_FILENAME_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")
_REPEATED_DASH_PATTERN = re.compile(r"-{2,}")


@dataclass(slots=True)
class ReleaseAssetUploadIntent:
    asset_type: ReleaseAssetType
    file_name: str
    expected_file_name: str
    object_key: str
    presigned_url: str
    access_url: str
    cdn_url: str
    public_url: str
    content_type: str
    expires_in: int


@dataclass(slots=True)
class ReleaseAssetUploadResult:
    asset_type: ReleaseAssetType
    file_record_id: str
    file_name: str
    object_key: str
    public_url: str
    access_url: str
    cdn_url: str
    file_size: int
    checksum_sha256: str = ""
    checksum_sha512: str = ""
    manifest_generated: bool = False
    manifest_url: str = ""
    manifest_file: str = ""
    manifest_generation_error: str = ""


@dataclass(slots=True)
class ReleaseManifestPreviewResult:
    can_generate: bool
    manifest_file: str
    manifest_url: str
    content: str = ""
    issues: list[str] | None = None


class ReleaseAssetService:
    """Release 资产托管服务。"""

    def __init__(
        self,
        *,
        upload_expiration_seconds: int = _DEFAULT_UPLOAD_EXPIRATION_SECONDS,
        max_asset_size: int | None = None,
    ):
        self.upload_expiration_seconds = upload_expiration_seconds
        self.max_asset_size = max_asset_size or int(
            getattr(settings, "UPDATER_MAX_ASSET_SIZE", _DEFAULT_MAX_ASSET_SIZE)
        )

    def create_upload_intent(
        self,
        release: AppRelease,
        *,
        asset_type: str,
        file_name: str,
        file_size: int,
        content_type: str = "",
    ) -> ReleaseAssetUploadIntent:
        normalized_asset_type = self._normalize_asset_type(asset_type)
        expected_file_name = self._resolve_expected_file_name(release, normalized_asset_type, file_name)
        self._validate_upload_request(
            release=release,
            asset_type=normalized_asset_type,
            file_name=expected_file_name,
            file_size=file_size,
        )

        oss_service = get_updater_oss_service()
        public_url = self._ensure_public_url_for_object(
            oss_service,
            self._build_object_key(release, expected_file_name),
        )
        object_key = self._build_object_key(release, expected_file_name)
        access_url = oss_service.build_access_url(object_key)
        cdn_url = oss_service.build_cdn_url(object_key)
        resolved_content_type = self._resolve_content_type(normalized_asset_type, content_type)
        presigned_url = oss_service.generate_presigned_url(
            object_key,
            expiration=self.upload_expiration_seconds,
            method="PUT",
            content_type=resolved_content_type or "application/octet-stream",
        )

        return ReleaseAssetUploadIntent(
            asset_type=normalized_asset_type,
            file_name=expected_file_name,
            expected_file_name=expected_file_name,
            object_key=object_key,
            presigned_url=presigned_url,
            access_url=access_url,
            cdn_url=cdn_url,
            public_url=public_url,
            content_type=resolved_content_type,
            expires_in=self.upload_expiration_seconds,
        )

    def complete_upload(
        self,
        release: AppRelease,
        *,
        asset_type: str,
        object_key: str,
        file_name: str,
        file_size: int,
        content_type: str,
        checksum_sha256: str = "",
        checksum_sha512: str = "",
        user_id=None,
        upload_ip: str = "",
        auto_generate_manifest: bool = False,
    ) -> ReleaseAssetUploadResult:
        normalized_asset_type = self._normalize_asset_type(asset_type)
        expected_file_name = self._resolve_expected_file_name(release, normalized_asset_type, file_name)
        expected_object_key = self._build_object_key(release, expected_file_name)
        if object_key != expected_object_key:
            raise ValueError("上传对象路径与当前版本规划目录不一致，请重新获取上传意图。")

        self._validate_upload_request(
            release=release,
            asset_type=normalized_asset_type,
            file_name=expected_file_name,
            file_size=file_size,
        )

        oss_service = get_updater_oss_service()
        public_url = self._ensure_public_url_for_object(oss_service, object_key)

        if not oss_service.file_exists(object_key):
            raise ValueError("上传文件尚未落到 OSS，请确认直传完成后重试。")

        oss_info = oss_service.get_file_info(object_key)
        actual_size = int(file_size)
        if oss_info.get("success") and oss_info.get("data"):
            actual_size = int(oss_info["data"].get("content_length") or file_size)

        file_record = self._upsert_file_record(
            release=release,
            asset_type=normalized_asset_type,
            object_key=object_key,
            file_name=expected_file_name,
            file_size=actual_size,
            content_type=self._resolve_content_type(normalized_asset_type, content_type),
            user_id=user_id,
            upload_ip=upload_ip,
            upload_source="updater_direct_upload",
            metadata={
                "release_id": release.id,
                "version": release.version,
                "platform": release.platform,
                "arch": release.arch,
                "channel": release.channel,
                "asset_type": normalized_asset_type,
            },
        )

        manifest_generation_error = ""
        manifest_generated = False
        manifest_url = ""
        manifest_file = ""

        if normalized_asset_type == "package":
            checksum_sha256 = checksum_sha256.strip()
            checksum_sha512 = checksum_sha512.strip()

            if checksum_sha256 and not re.fullmatch(r"[A-Fa-f0-9]{64}", checksum_sha256):
                raise ValueError("SHA256 必须是 64 位十六进制字符串。")
            if checksum_sha512 and len(checksum_sha512) < 80:
                raise ValueError("SHA512 必须是 base64 字符串。")

            release.file_url = public_url
            release.file_size = actual_size
            release.checksum_sha256 = checksum_sha256
            release.checksum_sha512 = checksum_sha512
            release.feed_url = self._derive_feed_url(public_url)
            release.save(
                update_fields=[
                    "file_url",
                    "file_size",
                    "checksum_sha256",
                    "checksum_sha512",
                    "feed_url",
                    "updated_at",
                ]
            )

            if auto_generate_manifest:
                if not release.checksum_sha512:
                    raise ValueError("自动生成 Manifest 需要先提供 SHA512。")
                try:
                    manifest_result = self.generate_manifest(
                        release,
                        user_id=user_id,
                        upload_ip=upload_ip,
                    )
                    manifest_generated = True
                    manifest_url = manifest_result.public_url
                    manifest_file = manifest_result.file_name
                except Exception as exc:  # pragma: no cover - 通过 admin api 行为覆盖
                    manifest_generation_error = str(exc)
        elif normalized_asset_type == "website_installer":
            release.website_file_url = public_url
            release.save(update_fields=["website_file_url", "updated_at"])
        elif normalized_asset_type == "manifest":
            release.feed_url = self._derive_feed_url(public_url)
            release.save(update_fields=["feed_url", "updated_at"])
        # blockmap 与安装包同目录，不回填 release 字段，仅登记 FileRecord

        return ReleaseAssetUploadResult(
            asset_type=normalized_asset_type,
            file_record_id=str(file_record.id),
            file_name=expected_file_name,
            object_key=object_key,
            public_url=public_url,
            access_url=oss_service.build_access_url(object_key),
            cdn_url=oss_service.build_cdn_url(object_key),
            file_size=actual_size,
            checksum_sha256=checksum_sha256.strip(),
            checksum_sha512=checksum_sha512.strip(),
            manifest_generated=manifest_generated,
            manifest_url=manifest_url,
            manifest_file=manifest_file,
            manifest_generation_error=manifest_generation_error,
        )

    def generate_manifest(
        self,
        release: AppRelease,
        *,
        user_id=None,
        upload_ip: str = "",
    ) -> ReleaseAssetUploadResult:
        preview = self.preview_manifest(release)
        if not preview.can_generate:
            raise ValueError("；".join(preview.issues or ["当前版本暂时无法生成 Manifest。"]))

        object_key = self._build_object_key(release, release.get_manifest_file())
        oss_service = get_updater_oss_service()
        public_url = self._ensure_public_url_for_object(oss_service, object_key)
        manifest_bytes = preview.content.encode("utf-8")

        oss_service.upload_bytes(
            manifest_bytes,
            object_key,
            content_type="text/yaml; charset=utf-8",
        )
        file_record = self._upsert_file_record(
            release=release,
            asset_type="manifest",
            object_key=object_key,
            file_name=release.get_manifest_file(),
            file_size=len(manifest_bytes),
            content_type="text/yaml",
            user_id=user_id,
            upload_ip=upload_ip,
            upload_source="updater_manifest_generated",
            file_hash=hashlib.md5(manifest_bytes).hexdigest(),
            metadata={
                "release_id": release.id,
                "version": release.version,
                "platform": release.platform,
                "arch": release.arch,
                "channel": release.channel,
                "asset_type": "manifest",
                "generated_by": "release_asset_service",
            },
        )

        release.feed_url = self._derive_feed_url(public_url)
        release.save(update_fields=["feed_url", "updated_at"])

        return ReleaseAssetUploadResult(
            asset_type="manifest",
            file_record_id=str(file_record.id),
            file_name=release.get_manifest_file(),
            object_key=object_key,
            public_url=public_url,
            access_url=oss_service.build_access_url(object_key),
            cdn_url=oss_service.build_cdn_url(object_key),
            file_size=len(manifest_bytes),
            manifest_url=public_url,
            manifest_file=release.get_manifest_file(),
        )

    def preview_manifest(self, release: AppRelease) -> ReleaseManifestPreviewResult:
        issues = self._get_manifest_generation_issues(release)
        content = ""
        if not issues:
            content = self._render_manifest_text(release)
        return ReleaseManifestPreviewResult(
            can_generate=not issues,
            manifest_file=release.get_manifest_file(),
            manifest_url=release.get_manifest_url(),
            content=content,
            issues=issues,
        )

    def _normalize_asset_type(self, asset_type: str) -> ReleaseAssetType:
        normalized = (asset_type or "").strip().lower()
        if normalized not in {"package", "manifest", "blockmap", "website_installer"}:
            raise ValueError("资产类型仅支持 package、manifest、blockmap 或 website_installer。")
        return normalized  # type: ignore[return-value]

    def _resolve_expected_file_name(
        self,
        release: AppRelease,
        asset_type: ReleaseAssetType,
        file_name: str,
    ) -> str:
        if asset_type == "manifest":
            return release.get_manifest_file()

        if asset_type == "blockmap":
            # electron-updater 差分下载按「安装包 URL + .blockmap」取文件，
            # 文件名必须与已登记安装包严格对应，不接受任意命名。
            asset_name = release.get_asset_name()
            if not asset_name:
                raise ValueError("请先上传安装包，再上传 blockmap。")
            return f"{asset_name}.blockmap"

        normalized = PurePosixPath((file_name or "").strip()).name
        if not normalized:
            if asset_type == "website_installer":
                raise ValueError("请先选择官网安装包文件。")
            raise ValueError("请先选择安装包文件。")

        # 托管上传统一写成短文件名：只保留产品名 + 版本 + 平台/架构。
        # 渠道信息已在 object key 目录里（desktop-updates/{channel}/...），不必再塞进文件名。
        # 不要在 OSS 控制台事后「重命名」——那是复制+删除，且会与已生成的 manifest 脱节。
        canonical = self._build_canonical_asset_file_name(
            release,
            asset_type=asset_type,
            source_file_name=normalized,
        )
        if canonical:
            return canonical

        stem, extension = os.path.splitext(normalized)
        safe_stem = _SAFE_FILENAME_PATTERN.sub("-", stem).strip("-.")
        safe_stem = _REPEATED_DASH_PATTERN.sub("-", safe_stem)
        safe_extension = extension.strip()
        if not safe_stem:
            safe_stem = "desktop-website-installer" if asset_type == "website_installer" else "desktop-installer"
        return f"{safe_stem}{safe_extension}"

    def _build_canonical_asset_file_name(
        self,
        release: AppRelease,
        *,
        asset_type: ReleaseAssetType,
        source_file_name: str,
    ) -> str:
        if asset_type not in {"package", "website_installer"}:
            return ""

        version = _SAFE_FILENAME_PATTERN.sub("-", str(release.version or "").strip()).strip("-.")
        version = _REPEATED_DASH_PATTERN.sub("-", version)
        if not version:
            return ""

        extension = os.path.splitext(source_file_name)[1].lower()
        if not extension:
            return ""

        platform = str(release.platform or "").strip().lower()
        arch = str(release.arch or "").strip().lower()

        if platform == "win":
            # 例：TabTin-1.0.0-windows.exe
            return f"TabTin-{version}-windows{extension}"

        if platform == "mac":
            if not arch:
                return ""
            if asset_type == "website_installer":
                # 例：TabTin-1.0.0-arm64.dmg / TabTin-1.0.0-x64.dmg
                return f"TabTin-{version}-{arch}{extension}"
            # 自动更新 zip：保留 -mac 后缀，便于和官网 dmg 区分
            # 例：TabTin-1.0.0-arm64-mac.zip
            if extension == ".zip":
                return f"TabTin-{version}-{arch}-mac.zip"
            return f"TabTin-{version}-{arch}{extension}"

        if platform == "linux":
            if not arch:
                return ""
            return f"TabTin-{version}-{arch}{extension}"

        return ""

    def _validate_upload_request(
        self,
        *,
        release: AppRelease,
        asset_type: ReleaseAssetType,
        file_name: str,
        file_size: int,
    ) -> None:
        if file_size <= 0:
            raise ValueError("上传文件大小必须大于 0。")
        if file_size > self.max_asset_size:
            raise ValueError(f"上传文件超过限制，当前最大支持 {self.max_asset_size} 字节。")

        extension = os.path.splitext(file_name)[1].lower().lstrip(".")
        if not extension:
            raise ValueError("文件名缺少扩展名。")

        if asset_type == "package" and extension not in _PACKAGE_EXTENSIONS:
            raise ValueError(
                "当前仅支持 zip / dmg / exe / msi / pkg / AppImage / deb / rpm / nupkg 安装包。"
            )
        if asset_type == "package":
            allowed_extensions = _UPDATER_PACKAGE_EXTENSIONS_BY_PLATFORM.get(release.platform)
            if allowed_extensions and extension not in allowed_extensions:
                expected = _UPDATER_PACKAGE_EXTENSION_LABELS.get(release.platform, "")
                raise ValueError(
                    f"{release.get_platform_display()} 自动更新安装包请上传 {expected} 文件；"
                    "dmg/msi/pkg 等安装器仅适合手动下载，不应用于生成 electron-updater manifest。"
                )
        if asset_type == "website_installer":
            allowed_extensions = _WEBSITE_INSTALLER_EXTENSIONS_BY_PLATFORM.get(release.platform)
            if allowed_extensions and extension not in allowed_extensions:
                expected = _WEBSITE_INSTALLER_EXTENSION_LABELS.get(release.platform, "")
                raise ValueError(
                    f"{release.get_platform_display()} 官网安装包请上传 {expected} 文件。"
                )
        if asset_type == "manifest" and extension not in _MANIFEST_EXTENSIONS:
            raise ValueError("Manifest 仅支持 .yml 或 .yaml 文件。")
        # blockmap 的目标文件名由 _resolve_expected_file_name 按已登记安装包
        # 强制推导（必然以 .blockmap 结尾），无需再校验扩展名。

    def _resolve_content_type(self, asset_type: ReleaseAssetType, content_type: str) -> str:
        normalized = (content_type or "").strip()
        if normalized:
            return normalized
        if asset_type == "manifest":
            return "text/yaml"
        return "application/octet-stream"

    def _build_object_key(self, release: AppRelease, file_name: str) -> str:
        return f"{release.get_storage_prefix()}{file_name}"

    def _ensure_public_url_for_object(self, oss_service, object_key: str) -> str:
        cdn_url = oss_service.build_cdn_url(object_key)
        if cdn_url:
            return cdn_url

        if oss_service.config.get("access_mode") in {"public-read", "public-read-write"}:
            logger.warning(
                "updater: CDN 域名未配置，降级使用 OSS 直连 URL（access_mode=%s）。"
                "建议配置 UPDATER_OSS_CDN_DOMAIN 以保障更新通道稳定性。",
                oss_service.config.get("access_mode"),
            )
            return oss_service.build_access_url(object_key)

        logger.critical(
            "updater: OSS 为 private bucket 且无 CDN 域名，桌面更新通道完全不可用！"
            "请立即配置 UPDATER_OSS_CDN_DOMAIN 或将 bucket 切换为 public-read。"
        )
        raise ValueError("当前 OSS 未配置长期可访问域名，无法作为桌面更新源。")

    def _derive_feed_url(self, public_url: str) -> str:
        parsed = urlsplit(public_url)
        directory = parsed.path.rsplit("/", 1)[0] if "/" in parsed.path else ""
        return urlunsplit(
            SplitResult(
                scheme=parsed.scheme,
                netloc=parsed.netloc,
                path=f"{directory}/" if directory else "/",
                query="",
                fragment="",
            )
        )

    def _build_manifest_payload(self, release: AppRelease) -> dict:
        release_date = (release.published_at or timezone.now()).astimezone(
            timezone.get_current_timezone()
        )
        return {
            "version": release.version,
            "files": [
                {
                    "url": release.get_asset_name(),
                    "sha512": release.checksum_sha512,
                    "size": release.file_size,
                }
            ],
            "path": release.get_asset_name(),
            "sha512": release.checksum_sha512,
            "releaseDate": release_date.isoformat(),
            "releaseNotes": release.release_notes or "",
        }

    def _render_manifest_text(self, release: AppRelease) -> str:
        manifest_payload = self._build_manifest_payload(release)
        return yaml.safe_dump(
            manifest_payload,
            allow_unicode=True,
            sort_keys=False,
        )

    def _get_manifest_generation_issues(self, release: AppRelease) -> list[str]:
        issues: list[str] = []
        asset_name = release.get_asset_name()
        if not asset_name:
            issues.append("请先上传安装包，再生成 Manifest。")
        if release.file_size <= 0:
            issues.append("安装包大小缺失，无法生成 Manifest。")
        if not (release.checksum_sha512 or "").strip():
            issues.append("安装包 SHA512 缺失，无法生成 Manifest。")
        if not (release.file_url or "").strip():
            issues.append("安装包下载地址缺失，无法生成 Manifest。")
        if not release.release_notes.strip():
            issues.append("更新日志为空，建议补齐后再生成 Manifest。")
        return issues

    def _upsert_file_record(
        self,
        *,
        release: AppRelease,
        asset_type: ReleaseAssetType,
        object_key: str,
        file_name: str,
        file_size: int,
        content_type: str,
        user_id,
        upload_ip: str,
        upload_source: str,
        metadata: dict,
        file_hash: str = "",
    ) -> FileRecord:
        oss_service = get_updater_oss_service()
        access_url = oss_service.build_access_url(object_key)
        cdn_url = oss_service.build_cdn_url(object_key)
        file_extension = os.path.splitext(file_name)[1].lower().lstrip(".")
        file_type = get_file_type_from_extension(file_extension)
        effective_user_id = user_id or _SYSTEM_USER_UUID

        record = FileRecord.objects.filter(file_key=object_key).first()
        if record is None:
            record = FileRecord.objects.create(
                file_name=file_name,
                file_key=object_key,
                file_path=str(PurePosixPath(object_key).parent),
                file_size=file_size,
                file_type=file_type,
                mime_type=content_type,
                file_extension=file_extension,
                file_hash=file_hash,
                bucket_name=oss_service.config.get("bucket_name", ""),
                access_url=access_url,
                cdn_url=cdn_url,
                is_public=True,
                upload_user=str(effective_user_id),
                upload_source=upload_source,
                upload_ip=upload_ip or None,
                tags=[],
                metadata=metadata,
            )
            # UPDTR-2: 通过 mark_as_completed 保持与平台 confirm 流程一致
            record.mark_as_completed(access_url=access_url, cdn_url=cdn_url)
        else:
            merged_metadata = dict(record.metadata or {})
            merged_metadata.update(metadata)
            record.file_name = file_name
            record.file_path = str(PurePosixPath(object_key).parent)
            record.file_size = file_size
            record.file_type = file_type
            record.mime_type = content_type
            record.file_extension = file_extension
            if file_hash:
                record.file_hash = file_hash
            record.bucket_name = oss_service.config.get("bucket_name", "")
            record.access_url = access_url
            record.cdn_url = cdn_url
            record.is_public = True
            record.upload_user = str(effective_user_id)
            record.upload_source = upload_source
            record.upload_ip = upload_ip or None
            record.tags = []
            record.metadata = merged_metadata
            record.status = "completed"
            record.deleted_at = None
            record.save()

        FileUsage.add_usage(
            file_record=record,
            user_id=effective_user_id,
            module="updater",
            context_type=f"desktop_update_{asset_type}",
            context_id=str(release.id),
        )
        return record

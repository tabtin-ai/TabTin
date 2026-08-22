"""
桌面更新发布就绪检查服务。

负责拉取远端 manifest，校验版本、安装包指向和基础可达性，
为 Admin API 和发布动作提供统一的发布前门禁。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Literal
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit, urlunsplit

import requests
import yaml
from django.utils import timezone

from ..models import AppRelease

logger = logging.getLogger(__name__)

ReadinessSeverity = Literal["error", "warning", "info"]
ReadinessStatus = Literal["ready", "warning", "blocked"]

_DEFAULT_TIMEOUT_SECONDS = 10
_MAX_MANIFEST_BYTES = 512 * 1024
_DEFAULT_HEADERS = {
    "User-Agent": "TabTinUpdaterReadiness/1.0",
    "Accept": "application/x-yaml, text/yaml, text/plain, */*",
}
_RANGE_PROBE_HEADERS = {
    **_DEFAULT_HEADERS,
    "Accept": "*/*",
    "Range": "bytes=0-0",
}


@dataclass(slots=True)
class ReleaseReadinessIssue:
    code: str
    severity: ReadinessSeverity
    message: str
    expected: str = ""
    actual: str = ""


@dataclass(slots=True)
class ReleaseReadinessAsset:
    raw_url: str = ""
    resolved_url: str = ""
    sha512: str = ""
    size: int | None = None
    http_status: int | None = None


@dataclass(slots=True)
class ReleaseReadinessResult:
    manifest_url: str
    manifest_file: str
    checked_at: timezone.datetime = field(default_factory=timezone.now)
    status: ReadinessStatus = "ready"
    manifest_http_status: int | None = None
    manifest_version: str = ""
    manifest_release_date: str = ""
    staging_percentage: int | None = None
    asset: ReleaseReadinessAsset = field(default_factory=ReleaseReadinessAsset)
    issues: list[ReleaseReadinessIssue] = field(default_factory=list)

    @property
    def blocking_issue_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "error")

    @property
    def warning_issue_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "warning")

    @property
    def info_issue_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "info")

    @property
    def blocking_messages(self) -> list[str]:
        return [issue.message for issue in self.issues if issue.severity == "error"]

    def finalize(self) -> "ReleaseReadinessResult":
        if self.blocking_issue_count > 0:
            self.status = "blocked"
        elif self.warning_issue_count > 0:
            self.status = "warning"
        else:
            self.status = "ready"
        return self


class ReleaseReadinessService:
    """发布就绪检查服务。"""

    def __init__(self, timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS):
        self.timeout_seconds = timeout_seconds

    def check_release(self, release: AppRelease) -> ReleaseReadinessResult:
        result = ReleaseReadinessResult(
            manifest_url=release.get_manifest_url(),
            manifest_file=release.get_manifest_file(),
        )

        manifest_url = result.manifest_url
        manifest_parts = urlsplit(manifest_url)
        if manifest_parts.scheme not in {"http", "https"}:
            self._issue(
                result,
                code="manifest_url_invalid",
                severity="error",
                message="Manifest 地址必须使用 http 或 https。",
                actual=manifest_url,
            )
            return result.finalize()

        if urlsplit(release.file_url).scheme not in {"http", "https"}:
            self._issue(
                result,
                code="file_url_invalid",
                severity="error",
                message="安装包地址必须使用 http 或 https。",
                actual=release.file_url,
            )
            return result.finalize()

        website_file_url = (release.website_file_url or "").strip()
        if release.platform == "mac" and release.channel == "stable":
            if not website_file_url:
                self._issue(
                    result,
                    code="website_file_url_missing",
                    severity="error",
                    message="正式版 macOS 必须托管官网 .dmg，才能发布。",
                )
            elif urlsplit(website_file_url).scheme not in {"http", "https"}:
                self._issue(
                    result,
                    code="website_file_url_invalid",
                    severity="error",
                    message="官网安装包地址必须使用 http 或 https。",
                    actual=website_file_url,
                )
            elif not website_file_url.lower().endswith(".dmg"):
                self._issue(
                    result,
                    code="website_file_url_not_dmg",
                    severity="error",
                    message="正式版 macOS 官网安装包必须是 .dmg。",
                    actual=website_file_url,
                )

        self._check_feed_url_client_whitelist(release, result)
        download_url = release.get_download_file_url()
        if download_url != release.get_effective_feed_url():
            self._check_stable_distribution_url(release, download_url, result)

        manifest_data = self._fetch_manifest(result)
        if manifest_data is None:
            return result.finalize()

        manifest_version = str(manifest_data.get("version") or "").strip()
        result.manifest_version = manifest_version
        if not manifest_version:
            self._issue(
                result,
                code="manifest_version_missing",
                severity="error",
                message="Manifest 缺少 version 字段，客户端无法确认目标版本。",
            )
        elif manifest_version != release.version:
            self._issue(
                result,
                code="manifest_version_mismatch",
                severity="error",
                message="Manifest version 与后台配置版本不一致。",
                expected=release.version,
                actual=manifest_version,
            )

        result.manifest_release_date = str(manifest_data.get("releaseDate") or "").strip()
        result.staging_percentage = self._coerce_int(manifest_data.get("stagingPercentage"))
        if result.staging_percentage is not None and result.staging_percentage < 100:
            self._issue(
                result,
                code="manifest_staging_percentage_enabled",
                severity="warning",
                message="Manifest 含 stagingPercentage，会与后端灰度策略叠加，可能导致可见范围缩小。",
                actual=str(result.staging_percentage),
            )

        asset_info = self._extract_asset_info(release, manifest_data, result)
        if asset_info is None:
            return result.finalize()

        result.asset = asset_info

        if not asset_info.raw_url:
            self._issue(
                result,
                code="manifest_asset_missing",
                severity="error",
                message="Manifest 未提供可下载的安装包地址。",
            )
            return result.finalize()

        if not asset_info.sha512:
            self._issue(
                result,
                code="manifest_sha512_missing",
                severity="error",
                message="Manifest 缺少 sha512，electron-updater 无法完成完整性校验。",
            )

        if asset_info.size is None:
            self._issue(
                result,
                code="manifest_asset_size_missing",
                severity="warning",
                message="Manifest 未声明安装包大小，下载进度与预估体验可能不准确。",
            )
        elif asset_info.size != release.file_size:
            self._issue(
                result,
                code="manifest_asset_size_mismatch",
                severity="warning",
                message="Manifest 中的安装包大小与后台配置不一致。",
                expected=str(release.file_size),
                actual=str(asset_info.size),
            )

        if self._normalize_url_for_compare(asset_info.resolved_url) != self._normalize_url_for_compare(release.file_url):
            self._issue(
                result,
                code="manifest_asset_url_mismatch",
                severity="error",
                message="Manifest 指向的安装包地址与后台配置不一致，客户端可能下载到错误资源。",
                expected=release.file_url,
                actual=asset_info.resolved_url,
            )

        self._probe_asset(asset_info, release, result)
        self._probe_blockmap(release, result)
        return result.finalize()

    def _check_feed_url_client_whitelist(
        self,
        release: AppRelease,
        result: ReleaseReadinessResult,
    ) -> None:
        """与桌面端 `UpdateManager.isAllowedFeedUrl` 口径对齐的发布前门禁。

        客户端只接受 https + example.com / *.example.com 的更新源，其余一律
        回落默认 feed——若后端下发的 feed 不满足白名单（最常见根因：未配置
        ``UPDATER_OSS_CDN_DOMAIN``，feed 落在 OSS 直连域名上），自动更新
        在客户端会静默失效。这里在发布阶段就把问题拦下来。
        """
        feed_url = release.get_effective_feed_url()
        parts = urlsplit(feed_url)
        host = (parts.hostname or "").lower()
        allowed = parts.scheme == "https" and (
            host == "example.com" or host.endswith(".example.com")
        )
        if not allowed:
            self._issue(
                result,
                code="feed_url_rejected_by_client",
                severity="error",
                message=(
                    "更新源域名不满足桌面端白名单（https 且 *.example.com），"
                    "客户端会拒绝该 feed 并回落默认源，自动更新将失败。"
                    "常见根因：未配置 UPDATER_OSS_CDN_DOMAIN，更新源落在 OSS 直连域名上。"
                ),
                actual=feed_url,
            )
            return

        self._check_stable_distribution_url(release, feed_url, result)

    def _check_stable_distribution_url(
        self,
        release: AppRelease,
        distribution_url: str,
        result: ReleaseReadinessResult,
    ) -> None:
        if release.channel != "stable":
            return

        host = (urlsplit(distribution_url).hostname or "").lower()
        non_production_markers = {"dev", "test", "preprod", "staging", "beta"}
        host_tokens = set(host.replace(".", "-").split("-"))
        if host_tokens & non_production_markers:
            self._issue(
                result,
                code="stable_asset_on_non_production_domain",
                severity="warning",
                message=(
                    "正式版安装包仍指向开发/测试下载域，浏览器与操作系统无法建立稳定的发行信誉。"
                ),
                expected="生产 CDN 域名（不得包含 dev/test/preprod/staging/beta）",
                actual=distribution_url,
            )

    def _probe_blockmap(
        self,
        release: AppRelease,
        result: ReleaseReadinessResult,
    ) -> None:
        """探测安装包旁的 .blockmap，缺失时差分更新静默退化为全量下载。"""
        file_url = (release.file_url or "").strip()
        if not file_url:
            return

        blockmap_url = f"{file_url}.blockmap"
        response = None
        try:
            response = requests.head(
                blockmap_url,
                timeout=self.timeout_seconds,
                headers=_DEFAULT_HEADERS,
                allow_redirects=True,
            )
            if response.status_code == 405:
                response.close()
                response = requests.get(
                    blockmap_url,
                    timeout=self.timeout_seconds,
                    headers=_DEFAULT_HEADERS,
                    allow_redirects=True,
                    stream=True,
                )
            response.raise_for_status()
        except requests.RequestException:
            self._issue(
                result,
                code="blockmap_missing",
                severity="warning",
                message="未找到安装包对应的 .blockmap，差分更新不可用，客户端将全量下载。",
                actual=blockmap_url,
            )
        finally:
            if response is not None:
                response.close()

    def _fetch_manifest(self, result: ReleaseReadinessResult) -> dict[str, Any] | None:
        try:
            response = requests.get(
                result.manifest_url,
                timeout=self.timeout_seconds,
                headers=_DEFAULT_HEADERS,
                allow_redirects=True,
            )
            result.manifest_http_status = response.status_code
            response.raise_for_status()
        except requests.RequestException as exc:
            logger.warning("[UpdaterReadiness] 拉取 manifest 失败: %s", exc)
            self._issue(
                result,
                code="manifest_fetch_failed",
                severity="error",
                message=f"无法拉取 Manifest：{exc}",
                actual=result.manifest_url,
            )
            return None

        body = response.text or ""
        if len(body.encode("utf-8")) > _MAX_MANIFEST_BYTES:
            self._issue(
                result,
                code="manifest_too_large",
                severity="error",
                message="Manifest 内容过大，疑似不是 electron-updater 生成的 yml 文件。",
                actual=str(len(body.encode('utf-8'))),
            )
            return None

        try:
            payload = yaml.safe_load(body) or {}
        except yaml.YAMLError as exc:
            logger.warning("[UpdaterReadiness] 解析 manifest YAML 失败: %s", exc)
            self._issue(
                result,
                code="manifest_parse_failed",
                severity="error",
                message=f"Manifest YAML 解析失败：{exc}",
            )
            return None

        if not isinstance(payload, dict):
            self._issue(
                result,
                code="manifest_invalid_payload",
                severity="error",
                message="Manifest 顶层结构不是对象，无法按 electron-updater 规范读取。",
            )
            return None

        return payload

    def _extract_asset_info(
        self,
        release: AppRelease,
        manifest_data: dict[str, Any],
        result: ReleaseReadinessResult,
    ) -> ReleaseReadinessAsset | None:
        expected_asset_name = release.get_asset_name()
        file_entries = manifest_data.get("files")

        if isinstance(file_entries, list):
            candidates = [item for item in file_entries if isinstance(item, dict)]
            if candidates:
                matched = next(
                    (
                        item
                        for item in candidates
                        if self._candidate_asset_name(item) == expected_asset_name
                    ),
                    None,
                )
                selected = matched or candidates[0]
                if matched is None:
                    self._issue(
                        result,
                        code="manifest_asset_name_mismatch",
                        severity="warning",
                        message="Manifest files[] 中未找到与后台安装包同名的资源，已按首个文件继续校验。",
                        expected=expected_asset_name,
                        actual=self._candidate_asset_name(selected),
                    )
                return self._build_asset(release, selected)

        legacy_path = str(manifest_data.get("path") or "").strip()
        if legacy_path:
            self._issue(
                result,
                code="manifest_legacy_path_fields",
                severity="info",
                message="Manifest 使用 legacy path/sha512 字段，建议升级为 files[] 结构以便后续扩展。",
            )
            return self._build_asset(
                release,
                {
                    "url": legacy_path,
                    "sha512": manifest_data.get("sha512"),
                    "size": manifest_data.get("filesize") or manifest_data.get("size"),
                },
            )

        self._issue(
            result,
            code="manifest_files_missing",
            severity="error",
            message="Manifest 缺少 files[] 或 path 字段，客户端无法定位安装包。",
        )
        return None

    def _build_asset(self, release: AppRelease, payload: dict[str, Any]) -> ReleaseReadinessAsset:
        raw_url = str(payload.get("url") or payload.get("path") or "").strip()
        resolved_url = urljoin(release.get_effective_feed_url(), raw_url) if raw_url else ""
        return ReleaseReadinessAsset(
            raw_url=raw_url,
            resolved_url=resolved_url,
            sha512=str(payload.get("sha512") or "").strip(),
            size=self._coerce_int(payload.get("size")),
        )

    def _probe_asset(
        self,
        asset: ReleaseReadinessAsset,
        release: AppRelease,
        result: ReleaseReadinessResult,
    ) -> None:
        if not asset.resolved_url:
            self._issue(
                result,
                code="asset_url_resolve_failed",
                severity="error",
                message="无法根据 Manifest 解析出安装包绝对地址。",
                expected=release.file_url,
                actual=asset.raw_url,
            )
            return

        response = None
        head_error: requests.RequestException | None = None
        try:
            try:
                response = requests.head(
                    asset.resolved_url,
                    timeout=self.timeout_seconds,
                    headers=_DEFAULT_HEADERS,
                    allow_redirects=True,
                )
                if response.status_code == 405:
                    response.close()
                    response = None
            except requests.RequestException as exc:
                head_error = exc
                logger.warning("[UpdaterReadiness] HEAD 探测安装包失败，尝试 Range GET: %s", exc)

            if response is None:
                response = requests.get(
                    asset.resolved_url,
                    timeout=self.timeout_seconds,
                    headers=_RANGE_PROBE_HEADERS,
                    allow_redirects=True,
                    stream=True,
                )

            asset.http_status = response.status_code
            response.raise_for_status()
        except requests.RequestException as exc:
            if response is not None:
                asset.http_status = getattr(response, "status_code", None)
            if head_error is not None:
                logger.warning("[UpdaterReadiness] Range GET 兜底仍无法探测安装包: head=%s fallback=%s", head_error, exc)
            else:
                logger.warning("[UpdaterReadiness] 探测安装包失败: %s", exc)
            self._issue(
                result,
                code="asset_probe_failed",
                severity="error",
                message=f"无法访问 Manifest 指向的安装包：{exc}",
                actual=asset.resolved_url,
            )
            return
        finally:
            if response is not None:
                response.close()

        content_length = self._coerce_int(response.headers.get("content-length") if response else None)
        if content_length is None:
            return

        if asset.size is not None and asset.size != content_length:
            self._issue(
                result,
                code="asset_content_length_manifest_mismatch",
                severity="warning",
                message="安装包响应头中的 Content-Length 与 Manifest size 不一致。",
                expected=str(asset.size),
                actual=str(content_length),
            )

        if release.file_size != content_length:
            self._issue(
                result,
                code="asset_content_length_release_mismatch",
                severity="warning",
                message="安装包响应头中的 Content-Length 与后台配置 file_size 不一致。",
                expected=str(release.file_size),
                actual=str(content_length),
            )

    @staticmethod
    def _issue(
        result: ReleaseReadinessResult,
        *,
        code: str,
        severity: ReadinessSeverity,
        message: str,
        expected: str = "",
        actual: str = "",
    ) -> None:
        result.issues.append(
            ReleaseReadinessIssue(
                code=code,
                severity=severity,
                message=message,
                expected=expected,
                actual=actual,
            )
        )

    @staticmethod
    def _coerce_int(value: Any) -> int | None:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _candidate_asset_name(payload: dict[str, Any]) -> str:
        raw_url = str(payload.get("url") or payload.get("path") or "").strip()
        if not raw_url:
            return ""
        return PurePosixPath(urlsplit(raw_url).path).name

    @staticmethod
    def _normalize_url_for_compare(url: str) -> str:
        parts = urlsplit((url or "").strip())
        normalized_query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)), doseq=True)
        normalized_path = unquote(parts.path or "")
        return urlunsplit(
            (
                parts.scheme.lower(),
                parts.netloc.lower(),
                normalized_path,
                normalized_query,
                "",
            )
        )

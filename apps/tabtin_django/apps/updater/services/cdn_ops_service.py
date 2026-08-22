"""
桌面更新 CDN 刷新 / 预热。

模式：
- mock（默认）：只记录 URL，不调阿里云——本地 / api-test 无 CDN 凭据时可用
- aliyun：调用 CDN OpenAPI RefreshObjectCaches / PushObjectCache
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Literal
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

from django.conf import settings

from apps.updater.models import AppRelease

logger = logging.getLogger(__name__)

CdnAction = Literal["refresh", "warmup"]


@dataclass
class CdnOpsItemResult:
    action: CdnAction
    url: str
    ok: bool
    mode: str
    detail: str = ""
    request_id: str = ""


@dataclass
class CdnOpsResult:
    mode: str
    ok: bool
    urls: list[str] = field(default_factory=list)
    items: list[CdnOpsItemResult] = field(default_factory=list)
    message: str = ""


def collect_release_cdn_urls(release: AppRelease) -> list[str]:
    """收集某条发版记录应刷新/预热的 CDN URL（去重、保序）。"""
    urls: list[str] = []
    seen: set[str] = set()

    def add(url: str) -> None:
        cleaned = (url or "").strip()
        if not cleaned or cleaned in seen:
            return
        seen.add(cleaned)
        urls.append(cleaned)

    add(release.get_manifest_url())
    add(release.file_url)
    add(release.website_file_url)
    # electron-updater 差分：安装包 URL + .blockmap
    package = (release.file_url or "").strip()
    if package and not package.endswith(".blockmap"):
        add(f"{package}.blockmap")
    website = (release.website_file_url or "").strip()
    if website and website != package and not website.endswith(".blockmap"):
        add(f"{website}.blockmap")
    return urls


def resolve_cdn_ops_mode() -> str:
    raw = str(getattr(settings, "UPDATER_CDN_OPS_MODE", None) or os.getenv("UPDATER_CDN_OPS_MODE") or "mock")
    mode = raw.strip().lower()
    return mode if mode in {"mock", "aliyun"} else "mock"


class DesktopCdnOpsService:
    def __init__(self, *, mode: str | None = None):
        self.mode = (mode or resolve_cdn_ops_mode()).strip().lower()
        if self.mode not in {"mock", "aliyun"}:
            self.mode = "mock"

    def run(
        self,
        releases: Iterable[AppRelease],
        *,
        refresh: bool = True,
        warmup: bool = True,
    ) -> CdnOpsResult:
        urls: list[str] = []
        seen: set[str] = set()
        for release in releases:
            for url in collect_release_cdn_urls(release):
                if url not in seen:
                    seen.add(url)
                    urls.append(url)

        if not urls:
            return CdnOpsResult(mode=self.mode, ok=False, message="没有可刷新/预热的 CDN URL")

        actions: list[CdnAction] = []
        if refresh:
            actions.append("refresh")
        if warmup:
            actions.append("warmup")
        if not actions:
            return CdnOpsResult(mode=self.mode, ok=False, urls=urls, message="未选择 refresh/warmup")

        items: list[CdnOpsItemResult] = []
        for action in actions:
            for url in urls:
                items.append(self._execute(action, url))

        ok = all(item.ok for item in items)
        return CdnOpsResult(
            mode=self.mode,
            ok=ok,
            urls=urls,
            items=items,
            message="CDN 操作完成" if ok else "部分 CDN 操作失败",
        )

    def _execute(self, action: CdnAction, url: str) -> CdnOpsItemResult:
        if self.mode == "mock":
            return CdnOpsItemResult(
                action=action,
                url=url,
                ok=True,
                mode="mock",
                detail="mock：已记录，未调用阿里云",
                request_id=f"mock-{uuid.uuid4().hex[:12]}",
            )
        try:
            request_id = self._aliyun_cdn_object_cache(action, url)
            return CdnOpsItemResult(
                action=action,
                url=url,
                ok=True,
                mode="aliyun",
                detail="ok",
                request_id=request_id,
            )
        except Exception as exc:
            logger.exception("[UpdaterCDN] %s failed url=%s", action, url)
            return CdnOpsItemResult(
                action=action,
                url=url,
                ok=False,
                mode="aliyun",
                detail=str(exc),
            )

    def _aliyun_credentials(self) -> tuple[str, str]:
        access_key_id = (
            getattr(settings, "UPDATER_CDN_ACCESS_KEY_ID", None)
            or getattr(settings, "UPDATER_ALIYUN_ACCESS_KEY_ID", None)
            or getattr(settings, "ALIYUN_ACCESS_KEY_ID", None)
            or os.getenv("UPDATER_CDN_ACCESS_KEY_ID")
            or os.getenv("UPDATER_ALIYUN_ACCESS_KEY_ID")
            or os.getenv("ALIYUN_ACCESS_KEY_ID")
            or ""
        )
        access_key_secret = (
            getattr(settings, "UPDATER_CDN_ACCESS_KEY_SECRET", None)
            or getattr(settings, "UPDATER_ALIYUN_ACCESS_KEY_SECRET", None)
            or getattr(settings, "ALIYUN_ACCESS_KEY_SECRET", None)
            or os.getenv("UPDATER_CDN_ACCESS_KEY_SECRET")
            or os.getenv("UPDATER_ALIYUN_ACCESS_KEY_SECRET")
            or os.getenv("ALIYUN_ACCESS_KEY_SECRET")
            or ""
        )
        if not access_key_id or not access_key_secret:
            raise ValueError("缺少阿里云 CDN AccessKey（UPDATER_CDN_ACCESS_KEY_* / ALIYUN_ACCESS_KEY_*）")
        return str(access_key_id), str(access_key_secret)

    def _aliyun_cdn_object_cache(self, action: CdnAction, url: str) -> str:
        """阿里云 CDN 2018-05-10 RPC：RefreshObjectCaches / PushObjectCache。"""
        access_key_id, access_key_secret = self._aliyun_credentials()
        api_action = "RefreshObjectCaches" if action == "refresh" else "PushObjectCache"
        # ObjectPath 需要完整 URL；刷新大文件用 File
        params = {
            "Format": "JSON",
            "Version": "2018-05-10",
            "AccessKeyId": access_key_id,
            "SignatureMethod": "HMAC-SHA1",
            "SignatureVersion": "1.0",
            "SignatureNonce": uuid.uuid4().hex,
            "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "Action": api_action,
            "ObjectPath": url,
        }
        if action == "refresh":
            params["ObjectType"] = "File"

        canonical = "&".join(
            f"{_percent_encode(k)}={_percent_encode(params[k])}" for k in sorted(params)
        )
        string_to_sign = f"GET&%2F&{_percent_encode(canonical)}"
        digest = hmac.new(
            (access_key_secret + "&").encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha1,
        ).digest()
        params["Signature"] = base64.b64encode(digest).decode("utf-8")

        endpoint = getattr(settings, "UPDATER_CDN_ENDPOINT", None) or "https://cdn.aliyuncs.com/"
        request_url = f"{endpoint.rstrip('/')}/?{urlencode(params)}"
        request = Request(request_url, method="GET")
        with urlopen(request, timeout=30) as response:  # noqa: S310 - 固定阿里云 endpoint
            body = response.read().decode("utf-8", errors="replace")
            if response.status >= 400:
                raise RuntimeError(f"CDN API HTTP {response.status}: {body[:300]}")
        # 粗解析 RequestId
        request_id = ""
        if '"RequestId"' in body:
            try:
                import json

                request_id = str(json.loads(body).get("RequestId") or "")
            except Exception:
                request_id = ""
        logger.info("[UpdaterCDN] %s url=%s request_id=%s", api_action, _safe_url_for_log(url), request_id)
        return request_id


def _percent_encode(value: str) -> str:
    return quote(str(value), safe="~")


def _safe_url_for_log(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"

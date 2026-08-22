"""Deterministic browser runtime for Agent-authored slide HTML.

Platform libraries keep their historical jsDelivr URLs in the document so
classic-script ordering and ``document.currentScript`` semantics remain
unchanged. Playwright fulfills those exact URLs from versioned local assets.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from apps.services.common.url_security import ssrf_safe_request


logger = logging.getLogger(__name__)


class RenderDocumentError(RuntimeError):
    """Stable internal failure classification without exposing HTML content."""

    def __init__(self, failure_kind: str, stage: str) -> None:
        self.failure_kind = failure_kind
        self.stage = stage
        super().__init__(f"{failure_kind} at {stage}")


class RenderDocumentValidationError(RenderDocumentError, ValueError):
    """A stable authoring error that remains compatible with API validation."""


class ExternalResourceTooLarge(RuntimeError):
    """Raised as soon as an external response exceeds its byte budget."""


@dataclass(frozen=True)
class FetchedExternalResource:
    status: int
    headers: dict[str, str]
    body: bytes


class _SlideCounter(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.count = 0

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = next((value for name, value in attrs if name == "class"), None)
        if classes and "ppt-slide" in classes.split():
            self.count += 1


def _declared_slide_count(html: str) -> int:
    counter = _SlideCounter()
    counter.feed(html)
    return counter.count


FONTAWESOME_STYLESHEET_HTML = (
    '<link href="https://cdn.jsdelivr.net/npm/@fortawesome/'
    'fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet" />\n'
)
ECHARTS_SCRIPT_HTML = (
    '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/'
    'dist/echarts.min.js"></script>\n'
)
CHARTJS_SCRIPT_HTML = (
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/'
    'dist/chart.umd.min.js"></script>\n'
)
MATHJAX_SCRIPT_HTML = (
    '<script src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/'
    'es5/tex-svg.min.js"></script>\n'
)
PLATFORM_HEAD_RESOURCES_HTML = (
    FONTAWESOME_STYLESHEET_HTML
    + ECHARTS_SCRIPT_HTML
    + CHARTJS_SCRIPT_HTML
    + MATHJAX_SCRIPT_HTML
)

_VENDOR_ROOT = Path(__file__).resolve().parents[1] / "assets" / "vendor"
_VENDOR_MANIFEST_PATH = _VENDOR_ROOT / "manifest.json"
_LOCAL_FONT_DIR = Path(__file__).resolve().parents[1] / "assets" / "fonts"
_LOCAL_FONT_SPECS = (
    ("Inter", "100 900", "Inter-latin-variable.woff2"),
    ("Noto Sans SC", "400", "NotoSansSC-sc-400.woff2"),
    ("Noto Sans SC", "700", "NotoSansSC-sc-700.woff2"),
)
_EXTERNAL_RESOURCE_TIMEOUT_MS = 3_000
_EXTERNAL_RESOURCE_TOTAL_BUDGET_MS = 8_000
_EXTERNAL_RESOURCE_MAX_REQUESTS = 8
_EXTERNAL_RESOURCE_MAX_BYTES = 5 * 1024 * 1024
_EXTERNAL_RESOURCE_TOTAL_MAX_BYTES = 10 * 1024 * 1024
_ALLOWED_HTTPS_HOSTS = (
    "cdn.tailwindcss.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "cdnjs.cloudflare.com",
)
_ASSET_MODE_ENV = "TABSLIDE_RENDER_ASSET_MODE"
_LOCAL_ASSET_MODE = "local_v1"
_LEGACY_ASSET_MODE = "cdn_legacy"
_PLATFORM_ASSETS = {
    "https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css": (
        _VENDOR_ROOT / "fontawesome" / "css" / "all.min.css",
        "text/css; charset=utf-8",
    ),
    "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js": (
        _VENDOR_ROOT / "echarts" / "echarts.min.js",
        "application/javascript; charset=utf-8",
    ),
    "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js": (
        _VENDOR_ROOT / "chartjs" / "chart.umd.min.js",
        "application/javascript; charset=utf-8",
    ),
    "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.min.js": (
        _VENDOR_ROOT / "mathjax" / "tex-svg.min.js",
        "application/javascript; charset=utf-8",
    ),
}
_PLATFORM_SCRIPT_GLOBALS = {
    "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js": "echarts",
    "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js": "Chart",
    "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.min.js": "MathJax",
}

for _font_name, _font_content_type in (
    ("fa-brands-400.ttf", "font/ttf"),
    ("fa-brands-400.woff2", "font/woff2"),
    ("fa-regular-400.ttf", "font/ttf"),
    ("fa-regular-400.woff2", "font/woff2"),
    ("fa-solid-900.ttf", "font/ttf"),
    ("fa-solid-900.woff2", "font/woff2"),
    ("fa-v4compatibility.ttf", "font/ttf"),
    ("fa-v4compatibility.woff2", "font/woff2"),
):
    _PLATFORM_ASSETS[
        "https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/webfonts/"
        + _font_name
    ] = (
        _VENDOR_ROOT / "fontawesome" / "webfonts" / _font_name,
        _font_content_type,
    )


@functools.lru_cache(maxsize=None)
def _read_platform_asset(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as exc:
        raise RuntimeError(f"TabSlide platform asset is unavailable: {path.name}") from exc


@functools.lru_cache(maxsize=1)
def validate_platform_assets() -> None:
    """Fail before browser navigation if packaged assets are missing or drifted."""
    try:
        manifest = json.loads(_VENDOR_MANIFEST_PATH.read_text(encoding="utf-8"))
        expected_hashes = manifest["sha256"]
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        raise RenderDocumentError("platform_script_error", "platform_assets") from exc

    for path, _content_type in _PLATFORM_ASSETS.values():
        try:
            content = _read_platform_asset(path)
        except RuntimeError as exc:
            raise RenderDocumentError("platform_script_error", "platform_assets") from exc
        relative_path = path.relative_to(_VENDOR_ROOT).as_posix()
        actual_hash = hashlib.sha256(content).hexdigest()
        if expected_hashes.get(relative_path) != actual_hash:
            raise RenderDocumentError("platform_script_error", "platform_assets")


@functools.lru_cache(maxsize=1)
def build_local_font_face_css() -> str:
    """Build the shared offline font CSS used by extraction and preview."""
    rules: list[str] = []
    for family, weight, filename in _LOCAL_FONT_SPECS:
        path = _LOCAL_FONT_DIR / filename
        try:
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        except OSError:
            logger.warning(
                "[TabSlideRender] local_font_unavailable file=%s",
                filename,
            )
            continue
        rules.append(
            "@font-face{font-family:'%s';font-style:normal;font-weight:%s;"
            "src:url(data:font/woff2;base64,%s) format('woff2');}"
            % (family, weight, encoded)
        )
    if not rules:
        return ""
    rules.append(
        ".ppt-slide{font-family:'Inter','Noto Sans SC','Microsoft YaHei',sans-serif;}"
    )
    return '<style id="tabtin-local-fonts">\n' + "\n".join(rules) + "\n</style>\n"


def _allowed_https_host(host: str) -> bool:
    return host in _ALLOWED_HTTPS_HOSTS or host in _configured_oss_hosts()


@functools.lru_cache(maxsize=1)
def _configured_oss_hosts() -> frozenset[str]:
    """Return only this deployment's OSS bucket/CDN hosts, never all Aliyun."""
    try:
        from django.conf import settings

        bucket = (getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "") or "").strip()
        endpoint = (
            (getattr(settings, "ALIYUN_OSS_ENDPOINT", "") or "")
            .removeprefix("https://")
            .removeprefix("http://")
            .strip("/")
            .lower()
        )
        cdn = (
            (getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "") or "")
            .removeprefix("https://")
            .removeprefix("http://")
            .strip("/")
            .lower()
        )
    except Exception:
        return frozenset()

    hosts = {cdn} if cdn else set()
    if bucket and endpoint:
        hosts.add(f"{bucket.lower()}.{endpoint}")
    return frozenset(hosts)


def _close_response(response: Any) -> None:
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - best-effort transport cleanup
            pass


def _read_bounded_response_body(response: Any, *, max_bytes: int) -> bytes:
    """Stream a response and stop before content can exceed ``max_bytes``."""
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                _close_response(response)
                raise ExternalResourceTooLarge
        except ValueError:
            pass

    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            _close_response(response)
            raise ExternalResourceTooLarge
        chunks.append(bytes(chunk))
    return b"".join(chunks)


def _fetch_external_resource_sync(
    url: str,
    timeout_seconds: float,
) -> FetchedExternalResource:
    response = ssrf_safe_request(
        "GET",
        url,
        allow_redirects=False,
        timeout=timeout_seconds,
        stream=True,
        headers={"Accept-Encoding": "identity"},
    )
    try:
        body = _read_bounded_response_body(
            response,
            max_bytes=_EXTERNAL_RESOURCE_MAX_BYTES,
        )
        headers = {
            str(name).lower(): str(value)
            for name, value in response.headers.items()
            if str(name).lower()
            not in {
                "connection",
                "content-encoding",
                "content-length",
                "keep-alive",
                "proxy-authenticate",
                "proxy-authorization",
                "te",
                "trailer",
                "transfer-encoding",
                "upgrade",
            }
        }
        return FetchedExternalResource(
            status=int(response.status_code),
            headers=headers,
            body=body,
        )
    finally:
        _close_response(response)


async def _fetch_external_resource(
    url: str,
    timeout_ms: int,
) -> FetchedExternalResource:
    timeout_seconds = max(timeout_ms / 1000, 0.001)
    return await asyncio.wait_for(
        asyncio.to_thread(_fetch_external_resource_sync, url, timeout_seconds),
        timeout=timeout_seconds,
    )


def _is_timeout_error(exc: Exception) -> bool:
    return isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or (
        "timeout" in type(exc).__name__.lower()
    )


def _capture_page_error(page: Any, _error: Any) -> None:
    errors = getattr(page, "_tabtin_render_page_errors", None)
    if errors is not None:
        errors.append("pageerror")


async def install_render_routes(page: Any) -> None:
    """Serve platform assets locally and bound the remaining HTML network surface."""
    if getattr(page, "_tabtin_render_routes_installed", False):
        return
    asset_mode = os.environ.get(_ASSET_MODE_ENV, _LOCAL_ASSET_MODE).strip()
    if asset_mode not in {_LOCAL_ASSET_MODE, _LEGACY_ASSET_MODE}:
        raise RuntimeError(f"Unsupported {_ASSET_MODE_ENV}: {asset_mode}")
    if asset_mode == _LOCAL_ASSET_MODE:
        validate_platform_assets()
    logger.info("[TabSlideRender] asset_mode=%s", asset_mode)

    if not getattr(page, "_tabtin_render_page_error_listener_installed", False):
        page.on("pageerror", lambda error: _capture_page_error(page, error))
        setattr(page, "_tabtin_render_page_error_listener_installed", True)

    async def _handle_render_request(route: Any) -> None:
        request = route.request
        asset = _PLATFORM_ASSETS.get(route.request.url)
        if asset is not None and asset_mode == _LOCAL_ASSET_MODE:
            path, content_type = asset
            await route.fulfill(
                status=200,
                headers={
                    "content-type": content_type,
                    "cache-control": "public, max-age=31536000, immutable",
                },
                body=_read_platform_asset(path),
            )
            return

        url = request.url
        if url.startswith(("data:", "blob:", "about:")):
            await route.continue_()
            return

        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not _allowed_https_host(host):
            logger.info(
                "[TabSlideRender] blocked_request host=%s resource_type=%s",
                host or "invalid",
                request.resource_type,
            )
            await route.abort("blockedbyclient")
            return

        if request.method != "GET":
            await route.abort("blockedbyclient")
            return

        request_count = getattr(page, "_tabtin_render_resource_count", 0) + 1
        setattr(page, "_tabtin_render_resource_count", request_count)
        if request_count > _EXTERNAL_RESOURCE_MAX_REQUESTS:
            logger.warning(
                "[TabSlideRender] external_resource_aborted "
                "host=%s resource_type=%s reason=request_limit",
                host,
                request.resource_type,
            )
            await route.abort("blockedbyclient")
            return

        deadline = getattr(page, "_tabtin_render_resource_deadline", time.monotonic())
        remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
        timeout_ms = min(_EXTERNAL_RESOURCE_TIMEOUT_MS, remaining_ms)
        if timeout_ms <= 0:
            if asset is not None and asset_mode == _LEGACY_ASSET_MODE:
                setattr(
                    page,
                    "_tabtin_render_platform_failure",
                    "platform_asset_timeout",
                )
            await route.abort("timedout")
            return

        try:
            response = await _fetch_external_resource(url, timeout_ms)
            total_bytes = getattr(page, "_tabtin_render_resource_bytes", 0)
            if total_bytes + len(response.body) > _EXTERNAL_RESOURCE_TOTAL_MAX_BYTES:
                raise ExternalResourceTooLarge
            setattr(
                page,
                "_tabtin_render_resource_bytes",
                total_bytes + len(response.body),
            )
            await route.fulfill(
                status=response.status,
                headers=response.headers,
                body=response.body,
            )
        except Exception as exc:
            if asset is not None and asset_mode == _LEGACY_ASSET_MODE:
                failure_kind = (
                    "platform_asset_timeout"
                    if _is_timeout_error(exc)
                    else "platform_script_error"
                )
                setattr(page, "_tabtin_render_platform_failure", failure_kind)
            logger.warning(
                "[TabSlideRender] external_resource_aborted "
                "host=%s resource_type=%s reason=%s",
                host,
                request.resource_type,
                type(exc).__name__,
            )
            await route.abort("timedout")

    await page.route("**/*", _handle_render_request)
    setattr(page, "_tabtin_render_routes_installed", True)


async def _missing_platform_script_global(page: Any, html: str) -> bool:
    for url, global_name in _PLATFORM_SCRIPT_GLOBALS.items():
        if url not in html:
            continue
        exists = await page.evaluate(
            "name => typeof globalThis[name] !== 'undefined'",
            global_name,
        )
        if not exists:
            return True
    return False


async def load_render_document(
    page: Any,
    html: str,
    *,
    slide_selector: str = ".ppt-slide",
    structural_timeout_ms: int = 10_000,
) -> int:
    """Load a complete document and return its final structural slide count."""
    declared_slide_count = _declared_slide_count(html)
    await install_render_routes(page)
    setattr(
        page,
        "_tabtin_render_resource_deadline",
        time.monotonic() + (_EXTERNAL_RESOURCE_TOTAL_BUDGET_MS / 1000),
    )
    setattr(page, "_tabtin_render_resource_count", 0)
    setattr(page, "_tabtin_render_resource_bytes", 0)
    setattr(page, "_tabtin_render_platform_failure", None)
    setattr(page, "_tabtin_render_page_errors", [])
    await page.set_content(
        html,
        wait_until="domcontentloaded",
        timeout=structural_timeout_ms,
    )
    platform_failure = getattr(page, "_tabtin_render_platform_failure", None)
    if platform_failure:
        raise RenderDocumentError(platform_failure, "platform_assets")
    if await _missing_platform_script_global(page, html):
        raise RenderDocumentError("platform_script_error", "script_execution")
    if getattr(page, "_tabtin_render_page_errors", []):
        raise RenderDocumentError("script_execution_error", "script_execution")
    dom_slide_count = await page.locator(slide_selector).count()
    if declared_slide_count and dom_slide_count < declared_slide_count:
        logger.error(
            "[TabSlideRender] structural_mismatch "
            "failure_kind=partial_dom declared=%d dom=%d",
            declared_slide_count,
            dom_slide_count,
        )
        raise RenderDocumentError("partial_dom", "structural_ready")
    if dom_slide_count == 0:
        raise RenderDocumentValidationError("no_slide", "structural_ready")
    return dom_slide_count


async def wait_for_optional_render_ready(page: Any, *, timeout_seconds: int = 3) -> None:
    """Wait for explicit Agent/MathJax promises without making them mandatory."""
    await asyncio.wait_for(
        page.evaluate(
            """async () => {
                const agentReady = window.__TABSLIDE_READY__;
                if (agentReady && typeof agentReady.then === 'function') {
                    await agentReady;
                }
                const mathReady = window.MathJax?.startup?.promise;
                if (mathReady && typeof mathReady.then === 'function') {
                    await mathReady;
                }
                return true;
            }"""
        ),
        timeout=timeout_seconds,
    )


async def wait_for_image_decode(page: Any, *, timeout_seconds: int = 3) -> None:
    """Let layout-critical images settle, with broken images treated as degradation."""
    await asyncio.wait_for(
        page.evaluate(
            """async () => {
                const pending = Array.from(document.images).map(async image => {
                    if (image.complete) return;
                    if (typeof image.decode === 'function') {
                        try { await image.decode(); } catch (_) {}
                        return;
                    }
                    await new Promise(resolve => {
                        image.addEventListener('load', resolve, {once: true});
                        image.addEventListener('error', resolve, {once: true});
                    });
                });
                await Promise.all(pending);
                return true;
            }"""
        ),
        timeout=timeout_seconds,
    )

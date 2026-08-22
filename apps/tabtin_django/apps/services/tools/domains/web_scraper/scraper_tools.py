"""
Web Scraper 工具 — 面向 mobile / web 客户端的后端网页抓取能力

提供核心工具：
- web_scraper_scrape_url: 通过 httpx 纯 HTTP 抓取网页并返回内容

浏览器渲染能力已迁移至前端 Electron/Daemon，Django 不再维护 Playwright 浏览器池。
需要 JS 渲染的场景请使用前端浏览器工具（browser.navigate / browser.snapshot 等）。
"""

from __future__ import annotations

import ipaddress
import logging
import random
import re
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

from apps.services.common.state.injected_state import InjectedState
from asgiref.sync import async_to_sync
import httpx
from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import build_tool_error

logger = logging.getLogger(__name__)


_URL_SCHEME_PREFIX = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*):")
_DNS_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


class ScrapeURLPolicyError(ValueError):
    """The SSRF-safe transport rejected a target URL."""


# ── UA 与反检测 ──

_DESKTOP_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
]


def _random_ua() -> str:
    return random.choice(_DESKTOP_UAS)


def _build_client_hints(ua: str) -> dict[str, str]:
    """根据 UA 生成 Sec-CH-UA 系列请求头"""
    import re as _re
    m = _re.search(r"Chrome/(\d+)", ua)
    ver = m.group(1) if m else "133"
    return {
        "Sec-CH-UA": f'"Chromium";v="{ver}", "Google Chrome";v="{ver}", "Not-A.Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"macOS"' if "Mac" in ua else ('"Windows"' if "Win" in ua else '"Linux"'),
    }


# ── 工具输入 Schema ──

class ScrapeUrlInput(BaseModel):
    """scrape_url 工具输入"""
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="用户 ID（自动注入）",
    )
    url: str = Field(
        description="要抓取的网页 URL",
    )
    output_mode: str = Field(
        default="text",
        description="输出格式：text / markdown / html / json",
    )
    extract_selector: Optional[str] = Field(
        default=None,
        description="CSS 选择器，提取页面中特定区域的内容",
    )
    engine: str = Field(
        default="httpx",
        description="抓取引擎：httpx（纯 HTTP 快速抓取）。需要 JS 渲染请使用前端浏览器工具。",
    )
    timeout: int = Field(
        default=30,
        description="页面加载超时时间（秒）",
    )


# ── SSRF 防护（由 ssrf_safe_request_async 在 _fetch_with_httpx 内处理）──


# ── 辅助函数 ──

def _contains_invalid_url_character(url: str) -> bool:
    """Reject C0/DEL and whitespace before urllib can normalize it away."""
    return any(ord(char) <= 32 or ord(char) == 127 or char.isspace() for char in url)


def _is_valid_authority_hostname(hostname: str) -> bool:
    """Prove FQDN, IP literal, or localhost authority; reject single labels."""
    if hostname.lower() == "localhost":
        return True
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        pass
    if all(char.isdigit() or char == "." for char in hostname):
        return False
    fqdn = hostname.rstrip(".")
    labels = fqdn.split(".")
    return (
        "." in fqdn
        and len(fqdn) <= 253
        and all(_DNS_LABEL.fullmatch(label) for label in labels)
    )


def _is_scheme_less_authority_with_port(url: str) -> bool:
    """Recognize a valid hostname/IP authority with an explicit numeric port."""
    try:
        parsed = urlparse(f"//{url}")
        hostname = parsed.hostname
    except ValueError:
        return False
    if not parsed.netloc or not hostname or "@" in parsed.netloc:
        return False
    if not _is_valid_authority_hostname(hostname):
        return False

    authority = parsed.netloc
    if authority.startswith("["):
        closing = authority.find("]")
        if closing < 0 or closing + 1 >= len(authority):
            return False
        port_text = authority[closing + 1 :]
        if not port_text.startswith(":"):
            return False
        port_text = port_text[1:]
    else:
        if ":" not in authority:
            return False
        port_text = authority.rsplit(":", 1)[1]
    return bool(port_text) and port_text.isascii() and port_text.isdigit()


def _validate_url(url: str) -> str:
    """校验并规范化 URL（纯格式校验，不做 DNS 解析）。

    - 显式非 http/https scheme 直接拒绝（不会改写成 https://ftp://...）
    - 仅在无 scheme 时补 https
    - hostname 必需，且不得含空白/控制字符
    - 拒绝 userinfo 凭证
    - port 仅允许 1..65535，并捕获解析错误
    """
    if not url:
        raise ValueError("URL cannot be empty")
    if _contains_invalid_url_character(url):
        raise ValueError("URL contains an invalid control character or whitespace")

    scheme_match = _URL_SCHEME_PREFIX.match(url)
    if scheme_match:
        scheme = scheme_match.group(1).lower()
        explicit_scheme = not _is_scheme_less_authority_with_port(url)
    else:
        scheme = ""
        explicit_scheme = False
        authority = url.split("/", 1)[0]
        if ":" in authority and not _is_scheme_less_authority_with_port(url):
            raise ValueError("Invalid URL authority")

    if explicit_scheme:
        if scheme not in {"http", "https"}:
            raise ValueError(f"Unsupported URL scheme: {scheme}")
        normalized = url
    else:
        normalized = "https://" + url

    parsed = urlparse(normalized)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ValueError(f"Unsupported URL scheme: {parsed.scheme}")

    netloc = parsed.netloc or ""
    if "@" in netloc or parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not contain userinfo credentials")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"Invalid URL: missing hostname: {url}")
    if any(ch.isspace() or ord(ch) < 32 for ch in hostname):
        raise ValueError(f"Invalid URL hostname: {hostname!r}")
    if any(ch.isspace() or ord(ch) < 32 for ch in netloc):
        raise ValueError(f"Invalid URL host: {netloc!r}")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"Invalid URL port: {exc}") from exc
    if port is not None and not (1 <= port <= 65535):
        raise ValueError(f"Invalid URL port: {port}")

    return normalized


def _sanitize_url_for_observability(url: str) -> str:
    """Allowlist only scheme + host (+ port) + path."""
    try:
        if not isinstance(url, str) or _contains_invalid_url_character(url):
            return "[invalid-url]"
        parsed = urlparse(url)
        hostname = parsed.hostname
        if parsed.scheme not in {"http", "https"} or not hostname:
            return "[invalid-url]"
        host = f"[{hostname}]" if ":" in hostname else hostname
        try:
            port = parsed.port
        except ValueError:
            return "[invalid-url]"
        netloc = f"{host}:{port}" if port else host
        sanitized = urlunparse(
            (
                parsed.scheme,
                netloc,
                parsed.path,
                "",
                "",
                "",
            )
        )
        if _contains_invalid_url_character(sanitized):
            return "[invalid-url]"
        return sanitized
    except (TypeError, ValueError):
        return "[invalid-url]"


async def _fetch_page_content(
    url: str,
    timeout: int = 30,
    engine: str = "httpx",
) -> dict:
    """通过 httpx 纯 HTTP 抓取网页内容

    返回 { 'html': str, 'title': str, 'status_code': int, 'url': str, 'engine': str }
    """
    if engine == "playwright":
        raise ValueError(
            "Playwright engine is no longer supported in the backend. "
            "For JS-rendered pages, use the frontend browser tools "
            "(browser.navigate / browser.snapshot / browser.evaluate)."
        )
    return await _fetch_with_httpx(url, timeout)


async def _fetch_with_httpx(url: str, timeout: int = 30) -> dict:
    """纯 HTTP 抓取（快速，适合静态页面），resolve-and-pin 防止 DNS rebinding"""
    from apps.services.common.url_security import ssrf_safe_request_async

    ua = _random_ua()
    headers = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        **_build_client_hints(ua),
    }

    try:
        response = await ssrf_safe_request_async(
            "GET",
            url,
            headers=headers,
            timeout=timeout,
            allow_redirects=True,
            max_redirects=10,
        )
    except ValueError as exc:
        # This boundary only raises ValueError for URL/SSRF/redirect policy rejection.
        raise ScrapeURLPolicyError from exc
    response.raise_for_status()

    return {
        'html': response.text,
        'title': _extract_title(response.text),
        'status_code': response.status_code,
        'url': str(response.url),
        'engine': 'httpx',
    }


def _extract_title(html: str) -> str:
    """从 HTML 中提取 title"""
    match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else ''


def _html_to_text(html: str, selector: str | None = None) -> str:
    """将 HTML 转为纯文本"""
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')

        if selector:
            target = soup.select_one(selector)
            if target:
                return target.get_text(separator='\n', strip=True)
            return f"[Selector '{selector}' did not match any content]"

        # 移除 script 和 style
        for tag in soup(['script', 'style', 'nav', 'footer', 'header']):
            tag.decompose()

        return soup.get_text(separator='\n', strip=True)

    except ImportError:
        # 无 bs4 时的简陋回退
        clean = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        clean = re.sub(r'<style[^>]*>.*?</style>', '', clean, flags=re.DOTALL | re.IGNORECASE)
        clean = re.sub(r'<[^>]+>', '', clean)
        return re.sub(r'\n\s*\n', '\n\n', clean).strip()


def _html_to_markdown(html: str, selector: str | None = None) -> str:
    """将 HTML 转为 Markdown"""
    try:
        from markdownify import markdownify as md
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, 'html.parser')

        if selector:
            target = soup.select_one(selector)
            if target:
                return md(str(target), heading_style='ATX', strip=['img'])
            return f"[Selector '{selector}' did not match any content]"

        # 取 article / main / body
        content = soup.select_one('article') or soup.select_one('main') or soup.body
        if content:
            for tag in content(['script', 'style', 'nav', 'footer']):
                tag.decompose()
            return md(str(content), heading_style='ATX')

        return md(html, heading_style='ATX')

    except ImportError:
        # 无 markdownify 时回退为纯文本
        return _html_to_text(html, selector)


# ── 工具实现 ──

class WebScraperScrapeUrlTool(BaseTool):
    """抓取网页并返回内容"""

    category: str = "web"
    # 命名约束（dogfood P0 修复 2026-04-30）：LLM 上游 tool name 正则
    # `^[a-zA-Z0-9_-]{1,64}$` 不允许点号；旧名 `web-scraper.scrape_url` 被
    # 拆点号为 `_`、连字符保留为下划线（所有 LLM tool 改为 snake_case）。
    # `app_id` / `required_permissions` 仍保留连字符（非 LLM tool 名空间）。
    name: str = "web_scraper_scrape_url"
    app_id: str = "web-scraper"
    description: str = "Fetch a web page and return its content as clean text, markdown, HTML, or JSON metadata."
    required_permissions: list[str] = ["web-scraper"]
    args_schema: type[ScrapeUrlInput] = ScrapeUrlInput

    def run(
        self,
        url: str,
        output_mode: str = "text",
        extract_selector: Optional[str] = None,
        engine: str = "httpx",
        timeout: int = 30,
        user_id: Optional[str] = None,
        **kwargs,
    ) -> dict[str, Any]:
        """执行网页抓取（HTTP-only）"""
        if engine == "playwright" or kwargs.get("wait_for_selector") or kwargs.get("evaluate_js"):
            return build_tool_error(
                (
                    "Playwright engine is no longer supported in the backend. "
                    "For JS-rendered pages, use the frontend browser tools "
                    "(browser.navigate / browser.snapshot / browser.evaluate)."
                ),
                error_kind="host_unsupported",
                hint=(
                    "Use browser.navigate / browser.snapshot / browser.evaluate "
                    "for JS-rendered pages instead of web_scraper_scrape_url."
                ),
                retryable=False,
            )

        try:
            url = _validate_url(url)
        except ValueError:
            return build_tool_error(
                "Invalid or empty URL.",
                error_kind="invalid_param_format",
                hint="Provide a valid http(s) URL, e.g. https://example.com.",
                retryable=False,
            )

        try:
            page_data = async_to_sync(_fetch_page_content)(
                url,
                timeout=timeout,
                engine=engine,
            )

            html = page_data['html']
            title = page_data['title']
            safe_final_url = _sanitize_url_for_observability(page_data['url'])

            # 按 output_mode 转换
            if output_mode == 'html':
                content = html
            elif output_mode == 'markdown':
                content = _html_to_markdown(html, extract_selector)
            elif output_mode == 'json':
                content = {
                    'title': title,
                    'url': safe_final_url,
                    'text': _html_to_text(html, extract_selector)[:5000],
                    'fetched_at': datetime.now(timezone.utc).isoformat(),
                }
            else:  # text
                content = _html_to_text(html, extract_selector)

            # 截断过长内容
            max_len = 50000
            if isinstance(content, str) and len(content) > max_len:
                content = content[:max_len] + f"\n\n[Content truncated, original length: {len(content)} chars]"

            logger.info(
                "web_scraper.scrape_url.success url=%s mode=%s len=%s",
                safe_final_url,
                output_mode,
                len(str(content)),
            )

            return {
                "success": True,
                "url": safe_final_url,
                "title": title,
                "content": content,
                "status_code": page_data['status_code'],
            }

        except ScrapeURLPolicyError:
            safe_url = _sanitize_url_for_observability(url)
            logger.warning(
                "web_scraper.scrape_url.policy_rejected url=%s",
                safe_url,
            )
            return build_tool_error(
                "The target URL is not allowed by network security policy.",
                error_kind="permission_denied",
                hint="Choose a public https URL that is not blocked by SSRF policy.",
                retryable=False,
                context={"url": safe_url},
            )
        except httpx.TimeoutException as exc:
            safe_url = _sanitize_url_for_observability(url)
            logger.warning(
                "web_scraper.scrape_url.error url=%s error_type=%s",
                safe_url,
                type(exc).__name__,
            )
            return build_tool_error(
                "The web scrape request timed out.",
                error_kind="request_timeout",
                hint="Increase timeout or retry later; the target site may be slow.",
                retryable=True,
                context={"url": safe_url},
            )
        except httpx.HTTPStatusError as exc:
            safe_url = _sanitize_url_for_observability(url)
            logger.warning(
                "web_scraper.scrape_url.error url=%s error_type=%s",
                safe_url,
                type(exc).__name__,
            )
            return build_tool_error(
                "The target site returned an HTTP error.",
                error_kind="upstream_error",
                hint="Check the URL returns HTTP 2xx, then retry web_scraper_scrape_url.",
                retryable=True,
                context={"url": safe_url},
            )
        except Exception as exc:
            exc_type = type(exc).__name__
            safe_url = _sanitize_url_for_observability(url)
            # Never log str(exc) — may contain query tokens / auth fragments in URLs.
            logger.warning(
                "web_scraper.scrape_url.error url=%s error_type=%s",
                safe_url,
                exc_type,
            )
            return build_tool_error(
                "The web scrape request could not be completed.",
                error_kind="network_failed",
                hint=(
                    "Retry once. If it fails again, verify the URL is reachable "
                    "or use browser tools for JS-rendered pages."
                ),
                retryable=True,
                context={"url": safe_url},
            )


# ── 工具工厂 ──

def get_web_scraper_tools() -> list[BaseTool]:
    """返回 web-scraper 所有工具实例"""
    return [
        WebScraperScrapeUrlTool(),
    ]

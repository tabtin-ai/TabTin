"""LLM Wire Adapter · Image Fetcher(W1b 升级版,harness 总控 § 8 后续小专题)。

替代 W0 ``proxy_service._temp_normalize_image_urls`` 的 wire_adapter 内置实现。
对外暴露的核心 API:

* ``normalize_image_urls(messages, *, max_size_bytes, max_count_per_request)``:
  扫 messages 里 OpenAI 风 ``image_url``,把 https/http URL 同步下载 + base64
  编码 + 替换;触发 ``ImageFetchError`` 时携带 host / status / failed_count /
  total_count 由调用方走 SSE 错误路径(沿用 W0 模板表)。

W1b 升级点(相对 W0):

1. **Redis L2 缓存**:走 Django cache(``django_redis.cache.RedisCache`` backend),
   key prefix ``llm:image_fetch:``,默认 24h TTL。命中直接返回 base64,不下载。
   Miss 时下载完后写 Redis + 内存 LRU 双层。
2. **并发下载**:用 ``concurrent.futures.ThreadPoolExecutor`` 同时拉多张图,
   避免 W0 串行下载在多图场景下累计耗时(W0 单图 5s timeout × 4 张 = 最坏 20s
   阻塞 worker pool)。max_workers 限制为 8(避免 OSS 端突发 DDoS 触发限流)。
3. **size cap**:单图 ≤ ``max_size_bytes``(由 caps.image.max_size_bytes /
   max_size_mb 推断,默认 5 MB)+ 单 message 图片数 ≤ ``max_count_per_request``
   (由 caps.image.max_count_per_request 推断,默认 8)。超限抛
   ``ImageFetchError(reason='oversize')`` / ``reason='too_many_images'``。
4. **错误聚合**:同 W0 行为,任一失败抛 ``ImageFetchError`` 含
   ``failed_count``/``total_count`` 占位,由 LLMProxy ``proxy_stream_events``
   走 SSE error 路径透传。

设计取舍:

- 走 Django cache(``django.core.cache.caches['default']``)而非裸 ``redis-py``,
  好处:settings 已配 ``django_redis.cache.RedisCache``,自动复用连接池 + 健康
  检查;测试时可换 ``django.core.cache.backends.locmem.LocMemCache`` 不需要
  真 Redis。
- ThreadPoolExecutor 而非 ``asyncio.gather``,因为 LLMProxy ``stream_upstream``
  是 sync generator,asyncio.run 嵌套会触发 "cannot be called from a running
  event loop" 报错(已在 docparse 等处验证过)。后续若 LLMProxy 整体改 async,
  可平滑改 asyncio.gather。
- 内存 LRU 仍保留(从 W0 inline 沿用模式),作为 Redis L1。Redis miss 但内存命
  中的请求(同 worker 重复发图)依然秒级返回。
- L1 + L2 双写一致性:成功下载后**先写 Redis 再写内存**,避免内存命中但 Redis
  miss 的不一致(实际场景里只读不强一致,无所谓但写顺序明示)。
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import logging
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

from .error_messages import ImageFetchError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 配置常量
# ---------------------------------------------------------------------------

IMAGE_FETCH_TIMEOUT_S = 5.0
IMAGE_CACHE_TTL_S = 24 * 3600  # 24h(W1b 升级,W0 是 1h)
IMAGE_CACHE_CAP_BYTES = 200 * 1024 * 1024  # 200 MB(L1 内存上限)
DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
DEFAULT_MAX_COUNT_PER_REQUEST = 8
MAX_WORKERS = 8  # 并发下载上限,避免 OSS 端限流

REDIS_KEY_PREFIX = "llm:image_fetch:"
_BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
}
_BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "100.64.0.0/10",       # carrier-grade NAT, includes Alibaba metadata 100.100.100.200
        "169.254.169.254/32",  # cloud metadata endpoint
    )
)

# 当上游 Content-Type header 缺失或不可信时,按 URL 后缀回填 mime。
# 主要服务于一些 OSS/CDN 不返回 Content-Type 而 picky provider(如 MiniMax)
# 拒绝 image/jpeg 兜底的场景。后缀小写匹配,优先 Content-Type header。
IMAGE_MIME_BY_EXT: Dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
}


# ---------------------------------------------------------------------------
# L1 内存 LRU(W0 行为兼容)
# ---------------------------------------------------------------------------

_L1_LOCK = threading.Lock()
# url -> (data_url, mime, expires_at_epoch)
_L1_CACHE: Dict[str, Tuple[str, str, float]] = {}
_L1_BYTES = 0


def _l1_get(url: str) -> Optional[str]:
    """从 L1 内存 LRU 取 data URL,过期或不存在返回 None。"""
    global _L1_BYTES
    now = time.time()
    with _L1_LOCK:
        entry = _L1_CACHE.get(url)
        if not entry:
            return None
        data_url, _mime, expires_at = entry
        if expires_at < now:
            _L1_CACHE.pop(url, None)
            _L1_BYTES = max(0, _L1_BYTES - len(data_url))
            return None
        # LRU 提升:重新插入到末尾(Python 3.7+ dict 保持插入顺序)
        _L1_CACHE.pop(url, None)
        _L1_CACHE[url] = (data_url, _mime, expires_at)
        return data_url


def _l1_put(url: str, data_url: str, mime: str, ttl_s: float = IMAGE_CACHE_TTL_S) -> None:
    """写 L1,超 200MB 时按插入顺序逐出。"""
    global _L1_BYTES
    now = time.time()
    size = len(data_url)
    with _L1_LOCK:
        if size > IMAGE_CACHE_CAP_BYTES:
            return  # 单图过大,不缓存
        while _L1_BYTES + size > IMAGE_CACHE_CAP_BYTES and _L1_CACHE:
            old_url, (old_data, _, _) = next(iter(_L1_CACHE.items()))
            _L1_CACHE.pop(old_url, None)
            _L1_BYTES = max(0, _L1_BYTES - len(old_data))
        _L1_CACHE[url] = (data_url, mime, now + ttl_s)
        _L1_BYTES += size


def _l1_clear() -> None:
    """测试用:清空 L1 cache。"""
    global _L1_BYTES
    with _L1_LOCK:
        _L1_CACHE.clear()
        _L1_BYTES = 0


# ---------------------------------------------------------------------------
# L2 Redis(走 Django cache 框架)
# ---------------------------------------------------------------------------

def _redis_key(url: str) -> str:
    """URL → Redis key(SHA256 截短,避免 URL 太长被 Redis 拒绝)。"""
    h = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return f"{REDIS_KEY_PREFIX}{h[:32]}"


def _l2_get(url: str) -> Optional[str]:
    """从 L2 Redis cache 取 data URL,失败/不存在返回 None。

    异常防御:Redis 不可达时不阻断请求,fallback 到下载。
    """
    try:
        from django.core.cache import cache
        return cache.get(_redis_key(url))
    except Exception as exc:  # noqa: BLE001 — Redis 任何异常都不能阻断请求
        logger.debug(
            "[wire_adapter][image_fetcher] L2 Redis get failed url_hash=%s err=%s",
            _redis_key(url), exc,
        )
        return None


def _l2_put(url: str, data_url: str, ttl_s: int = IMAGE_CACHE_TTL_S) -> None:
    """写 L2 Redis cache,失败静默(不阻断请求)。"""
    try:
        from django.core.cache import cache
        cache.set(_redis_key(url), data_url, timeout=ttl_s)
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "[wire_adapter][image_fetcher] L2 Redis set failed url_hash=%s err=%s",
            _redis_key(url), exc,
        )


def _l2_clear_for_url(url: str) -> None:
    """测试用:清空指定 URL 的 L2 cache 项。"""
    try:
        from django.core.cache import cache
        cache.delete(_redis_key(url))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 单图下载
# ---------------------------------------------------------------------------

def _is_data_url(url: str) -> bool:
    return url.startswith("data:")


def _extract_host(url: str) -> str:
    try:
        parsed = urlparse(url)
        return parsed.netloc or "未知主机"
    except Exception:
        return "未知主机"


def _resolve_host_ips(host: str) -> list[str]:
    """解析主机名到 IP，单独函数便于测试替换。"""
    return sorted({
        sockaddr[0]
        for *_, sockaddr in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    })


def _allowed_fetch_hosts() -> set[str]:
    """返回允许后端主动拉取图片的可信域名集合。"""
    try:
        from django.conf import settings
    except Exception:
        return set()

    hosts: set[str] = set()
    for value in (
        getattr(settings, "LLM_IMAGE_FETCH_ALLOWED_HOSTS", "") or "",
        getattr(settings, "ASSET_PUBLIC_DOMAIN", "") or "",
        getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "") or "",
    ):
        for item in str(value).split(","):
            parsed = urlparse(item.strip())
            host = parsed.hostname or item.strip().split("/", 1)[0]
            if host:
                hosts.add(host.rstrip(".").lower())

    bucket = getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "") or ""
    endpoint = (getattr(settings, "ALIYUN_OSS_ENDPOINT", "") or "").removeprefix("https://").removeprefix("http://").strip("/")
    if bucket and endpoint:
        hosts.add(f"{bucket}.{endpoint}".rstrip(".").lower())
    return hosts


def _host_matches_allowed(host: str, allowed_hosts: set[str]) -> bool:
    return host in allowed_hosts


def _is_forbidden_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    ):
        return True
    return any(addr in network for network in _BLOCKED_NETWORKS)


def _validate_fetch_url(url: str) -> None:
    """阻断内网/元数据地址，避免服务端替用户拉图时形成 SSRF。"""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ImageFetchError(
            reason="forbidden_url",
            host=_extract_host(url),
            detail="image url scheme or host is not allowed",
        )

    host = parsed.hostname.rstrip(".").lower()
    if host in _BLOCKED_HOSTNAMES or host.endswith(".localhost"):
        raise ImageFetchError(
            reason="forbidden_url",
            host=host,
            detail="image url host is blocked",
        )

    allowed_hosts = _allowed_fetch_hosts()
    if not allowed_hosts or not _host_matches_allowed(host, allowed_hosts):
        raise ImageFetchError(
            reason="forbidden_url",
            host=host,
            detail="image url host is not in allowlist",
        )

    try:
        literal_ip = ipaddress.ip_address(host)
    except ValueError:
        try:
            resolved_ips = _resolve_host_ips(host)
        except OSError as exc:
            raise ImageFetchError(
                reason="network_error",
                host=host,
                detail=f"resolve image host failed: {exc}",
            ) from exc
    else:
        resolved_ips = [str(literal_ip)]

    if not resolved_ips or any(_is_forbidden_ip(ip) for ip in resolved_ips):
        raise ImageFetchError(
            reason="forbidden_url",
            host=host,
            detail="image url resolves to a blocked address",
        )


def _is_trusted_local_oss_url(url: str) -> bool:
    """本机 dev OSS 直读 URL:host=127.0.0.1/localhost 且 path 以 /api/services/oss/ 开头。

    与前端 ``apps/tabtin-electron/src/shared/llm-image-url.ts::isTrustedLocalOssUrl``
    对齐。这类 URL 云端上游 / SSRF 守卫下的 HTTP 拉取都够不着,须由本机
    Django 直接读存储转 base64。
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").rstrip(".").lower()
    if host not in ("127.0.0.1", "localhost"):
        return False
    return parsed.path.startswith("/api/services/oss/")


def _local_oss_provider_enabled() -> bool:
    """仅当 SERVICES_OSS_PROVIDER=local(dev)时才允许直读本机存储。"""
    try:
        from django.conf import settings
        return str(getattr(settings, "SERVICES_OSS_PROVIDER", "")).lower() == "local"
    except Exception:
        return False


def _read_local_oss_to_data_url(url: str, *, max_size_bytes: int) -> str:
    """本机 dev OSS:按 object_key 直接读存储转 ``data:`` URL。

    不发 loopback HTTP、不碰 SSRF 守卫——本机 Django 拥有 LOCAL_OSS_ROOT,直接
    经 OSS provider 读盘。仅在 ``_local_oss_provider_enabled()`` 为真时调用。
    """
    from urllib.parse import parse_qs

    parsed = urlparse(url)
    object_key = (parse_qs(parsed.query).get("object_key") or [""])[0]
    if not object_key:
        raise ImageFetchError(
            reason="forbidden_url",
            host=_extract_host(url),
            detail="local oss url missing object_key",
        )

    from apps.services.oss.services.factory import get_oss_service

    result = get_oss_service().download_file(object_key)
    if not result.get("success") or not result.get("data"):
        raise ImageFetchError(
            reason="http_error",
            host=_extract_host(url),
            status=404,
            detail=f"local oss object not found: {object_key}",
        )
    data = result["data"]
    content = data.get("content", b"") or b""
    if len(content) > max_size_bytes:
        raise ImageFetchError(
            reason="oversize",
            host=_extract_host(url),
            detail=f"local oss image oversize: {len(content)} bytes > {max_size_bytes}",
        )
    mime = data.get("content_type") or _infer_media_type(url, "")
    if not str(mime).startswith("image/"):
        mime = _infer_media_type(url, "")
    encoded = base64.b64encode(content).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _infer_media_type(url: str, content_type_header: str) -> str:
    """从 Content-Type header 优先推断 mime,否则按 URL 后缀,最后兜底 image/jpeg。

    与 W0 临时 normalizer 行为对齐:某些 OSS/CDN 不返回 Content-Type,部分
    上游对 image/jpeg 兜底敏感(实际是 png 但 mime 写成 jpeg 会被拒),需要
    按 URL 后缀回填准确 mime。
    """
    if content_type_header:
        ct = content_type_header.split(";", 1)[0].strip().lower()
        if ct.startswith("image/"):
            return ct
    path = urlparse(url).path.lower()
    for ext, mime in IMAGE_MIME_BY_EXT.items():
        if path.endswith(ext):
            return mime
    return "image/jpeg"


def fetch_image_to_data_url(
    url: str,
    *,
    timeout_s: float = IMAGE_FETCH_TIMEOUT_S,
    max_size_bytes: int = DEFAULT_MAX_SIZE_BYTES,
) -> str:
    """同步下载 URL 转成 ``data:<mime>;base64,<...>``。

    缓存查询顺序:L1 内存 → L2 Redis → 下载。

    Raises:
        ImageFetchError(reason='timeout'/'http_error'/'network_error'/'oversize',
                        host=..., status=...) — 由 LLMProxy 走 SSE error 路径。
    """
    # 本机 dev OSS(127.0.0.1 /api/services/oss/*):云端上游与 SSRF 守卫都够不着,
    # 直接读本机存储转 base64,不走 HTTP 拉取。
    if _is_trusted_local_oss_url(url) and _local_oss_provider_enabled():
        return _read_local_oss_to_data_url(url, max_size_bytes=max_size_bytes)

    _validate_fetch_url(url)

    # L1 hit
    cached = _l1_get(url)
    if cached is not None:
        return cached

    # L2 hit(Redis)
    cached = _l2_get(url)
    if cached is not None:
        # 回填 L1
        # mime 从 data URL 头部解析(用于内存 size 估计;不严格)
        try:
            mime_part = cached.split(";", 1)[0].replace("data:", "", 1)
        except Exception:
            mime_part = "image/jpeg"
        _l1_put(url, cached, mime_part)
        return cached

    host = _extract_host(url)
    try:
        with httpx.Client(timeout=timeout_s) as client:
            resp = client.get(url)
    except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout) as exc:
        raise ImageFetchError(
            reason="timeout",
            host=host,
            timeout=timeout_s,
            detail=f"fetch image timeout: {exc}",
        )
    except httpx.HTTPError as exc:
        raise ImageFetchError(
            reason="network_error",
            host=host,
            detail=f"fetch image network error: {exc}",
        )
    except Exception as exc:  # noqa: BLE001
        raise ImageFetchError(
            reason="network_error",
            host=host,
            detail=f"fetch image unexpected error: {exc}",
        )

    if resp.status_code != 200:
        raise ImageFetchError(
            reason="http_error",
            host=host,
            status=resp.status_code,
            detail=f"fetch image got HTTP {resp.status_code}",
        )

    final_url = str(getattr(resp, "url", "") or "")
    if final_url.startswith(("http://", "https://")) and final_url != url:
        _validate_fetch_url(final_url)

    content = resp.content
    if len(content) > max_size_bytes:
        raise ImageFetchError(
            reason="oversize",
            host=host,
            detail=f"fetch image oversize: {len(content)} bytes > {max_size_bytes}",
        )

    mime = _infer_media_type(url, resp.headers.get("content-type", ""))
    encoded = base64.b64encode(content).decode("ascii")
    data_url = f"data:{mime};base64,{encoded}"

    # 双写 L2 + L1(L2 先,理论上一致性更稳)
    _l2_put(url, data_url)
    _l1_put(url, data_url, mime)
    return data_url


# ---------------------------------------------------------------------------
# 多图并发下载 + messages 重写
# ---------------------------------------------------------------------------

def rewrite_local_oss_images(
    messages: List[Dict[str, Any]],
    *,
    max_size_bytes: int = DEFAULT_MAX_SIZE_BYTES,
) -> List[Dict[str, Any]]:
    """把受信本机 dev OSS 图片(127.0.0.1 /api/services/oss/*)就地转 base64。

    与 ``normalize_image_urls`` 的区别:只处理本机 OSS URL、直接读盘(不发 HTTP)、
    **不管模型 input_via 是否含 url 都转**——因为这类 URL 云端上游拿不到。公网
    URL / data URL 一律原样保留,交给后续 ``normalize_image_urls`` 或透传处理。

    provider 非 local(生产)时直接返回原 messages,不做任何改写。
    """
    if not _local_oss_provider_enabled():
        return messages

    targets: List[Tuple[int, int, str]] = []
    for msg_idx, msg in enumerate(messages):
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part_idx, part in enumerate(content):
            if not isinstance(part, dict) or part.get("type") != "image_url":
                continue
            image_url_obj = part.get("image_url")
            if not isinstance(image_url_obj, dict):
                continue
            url = image_url_obj.get("url", "")
            if url and not _is_data_url(url) and _is_trusted_local_oss_url(url):
                targets.append((msg_idx, part_idx, url))

    if not targets:
        return messages

    new_messages = [dict(m) for m in messages]
    for msg_idx, part_idx, url in targets:
        data_url = fetch_image_to_data_url(url, max_size_bytes=max_size_bytes)
        msg = new_messages[msg_idx]
        new_content = list(msg["content"])
        old_part = new_content[part_idx]
        new_part = dict(old_part)
        new_part["image_url"] = {**old_part["image_url"], "url": data_url}
        new_content[part_idx] = new_part
        msg["content"] = new_content
    return new_messages


def normalize_image_urls(
    messages: List[Dict[str, Any]],
    *,
    timeout_s: float = IMAGE_FETCH_TIMEOUT_S,
    max_size_bytes: int = DEFAULT_MAX_SIZE_BYTES,
    max_count_per_request: int = DEFAULT_MAX_COUNT_PER_REQUEST,
) -> List[Dict[str, Any]]:
    """扫 messages 找 OpenAI 风 image_url(非 data URL),并发下载替换为 base64。

    与 W0 ``_temp_normalize_image_urls`` 行为等价:
    - 任一图下载失败 → 抛 ``ImageFetchError`` 含 ``failed_count``/``total_count``
    - 全部成功 → 返回深拷贝的新 messages(原 messages 不被 mutate)

    新增:
    - 并发下载(ThreadPoolExecutor max_workers=8)
    - max_count_per_request 上限
    - max_size_bytes 上限(单图)
    - L2 Redis cache(走 Django cache)

    Args:
        messages: OpenAI 风 messages 数组
        timeout_s: 单图下载超时秒数
        max_size_bytes: 单图大小上限(字节)
        max_count_per_request: 单次请求图片总数上限

    Returns:
        新 messages list(深拷贝),image_url 已替换为 data URL。

    Raises:
        ImageFetchError: 任一图失败或图片数超限。
    """
    # 1) 收集所有需要下载的 https/http image url(非 data URL)
    targets: List[Tuple[int, int, str]] = []  # (msg_idx, part_idx, url)
    for msg_idx, msg in enumerate(messages):
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for part_idx, part in enumerate(content):
            if not isinstance(part, dict):
                continue
            if part.get("type") != "image_url":
                continue
            image_url_obj = part.get("image_url")
            if not isinstance(image_url_obj, dict):
                continue
            url = image_url_obj.get("url", "")
            if not url or _is_data_url(url):
                continue
            if not (url.startswith("http://") or url.startswith("https://")):
                continue
            targets.append((msg_idx, part_idx, url))

    if not targets:
        return messages

    total_count = len(targets)

    # 2) max_count_per_request 上限校验
    if total_count > max_count_per_request:
        raise ImageFetchError(
            reason="too_many_images",
            host=_extract_host(targets[0][2]) if targets else "未知主机",
            total_count=total_count,
            failed_count=total_count - max_count_per_request,
            detail=(
                f"image count {total_count} exceeds max_count_per_request "
                f"{max_count_per_request}"
            ),
        )

    # 3) 并发下载
    logger.debug(
        "[wire_adapter][image_fetcher] downloading %d images concurrently "
        "(max_workers=%d timeout=%ss)",
        total_count, MAX_WORKERS, timeout_s,
    )

    succeeded: Dict[int, Tuple[int, int, str]] = {}  # idx -> (msg_idx, part_idx, data_url)
    failed: List[Tuple[int, int, str, ImageFetchError]] = []  # (msg_idx, part_idx, url, exc)

    workers = min(total_count, MAX_WORKERS)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_target = {
            executor.submit(
                fetch_image_to_data_url,
                url,
                timeout_s=timeout_s,
                max_size_bytes=max_size_bytes,
            ): (idx, msg_idx, part_idx, url)
            for idx, (msg_idx, part_idx, url) in enumerate(targets)
        }
        for future in as_completed(future_to_target):
            idx, msg_idx, part_idx, url = future_to_target[future]
            try:
                data_url = future.result()
                succeeded[idx] = (msg_idx, part_idx, data_url)
            except ImageFetchError as exc:
                failed.append((msg_idx, part_idx, url, exc))
            except Exception as exc:  # noqa: BLE001
                # 兜底:非 ImageFetchError 包装(防 ThreadPool 内的 unhandled)
                failed.append((
                    msg_idx, part_idx, url,
                    ImageFetchError(
                        reason="network_error",
                        host=_extract_host(url),
                        detail=f"unexpected error: {exc}",
                    ),
                ))

    # 4) 失败聚合
    if failed:
        first_err = failed[0][3]
        priority = {"http_error": 0, "oversize": 1, "timeout": 2, "network_error": 3}
        worst_err = min(
            (e for _, _, _, e in failed),
            key=lambda e: priority.get(e.reason, 99),
        )
        logger.warning(
            "[wire_adapter][image_fetcher] %d/%d images failed; worst reason=%s host=%s",
            len(failed), total_count, worst_err.reason, worst_err.host,
        )
        raise ImageFetchError(
            reason=worst_err.reason,
            host=worst_err.host or first_err.host,
            status=worst_err.status,
            timeout=worst_err.timeout,
            total_count=total_count,
            failed_count=len(failed),
            detail=(
                f"image normalize failed {len(failed)}/{total_count}: "
                f"{worst_err.detail}"
            ),
        )

    # 5) 全部成功 → 深拷贝替换
    new_messages = [dict(m) for m in messages]
    # 按 idx 排序遍历(避免改 part_idx 后影响后续替换的索引)
    for idx in sorted(succeeded.keys()):
        msg_idx, part_idx, data_url = succeeded[idx]
        msg = new_messages[msg_idx]
        new_content = list(msg["content"])
        old_part = new_content[part_idx]
        new_part = dict(old_part)
        new_part["image_url"] = {**old_part["image_url"], "url": data_url}
        new_content[part_idx] = new_part
        msg["content"] = new_content

    return new_messages


__all__ = [
    "normalize_image_urls",
    "rewrite_local_oss_images",
    "fetch_image_to_data_url",
    "IMAGE_FETCH_TIMEOUT_S",
    "DEFAULT_MAX_SIZE_BYTES",
    "DEFAULT_MAX_COUNT_PER_REQUEST",
    "IMAGE_MIME_BY_EXT",
]

"""
collab-live HTTP API 统一调用工具。

所有模块（TabData、TabSlide、TabDoc、TabVideo）
对 collab-live 的 HTTP 调用统一收敛到此处，保证：
  - 可配置重试（默认 2 次，共 3 次尝试）
  - 统一的超时和错误处理
  - 统一的日志格式

Usage:
    from apps.services.common.live_api import call_live_api

    # 阻塞型：失败抛 RuntimeError（适用于 Agent 操作、后台任务）
    data = call_live_api("/convert/markdown-to-update", {"markdown": md})

    # fire-and-forget 型：失败仅打 warning，不抛（适用于非关键请求）
    result = call_live_api_safe("/collab/apply-ops", body)

    # 高频/用户请求线程中：禁用重试避免阻塞
    result = call_live_api_safe("/endpoint", body, max_retries=0)

配置优先级：
  - URL:    COLLAB_LIVE_URL > http://localhost:4100
  - Secret: COLLAB_LIVE_SECRET（必须配置，生产环境禁止使用默认开发密钥）
"""

import logging
import threading
import time

logger = logging.getLogger("collab_live_api")

_cached_url: str | None = None
_cached_secret: str | None = None
_cache_lock = threading.Lock()

_circuit_open_until: float = 0.0
_circuit_lock = threading.Lock()
_CIRCUIT_COOLDOWN = 30.0


def _get_live_url() -> str:
    global _cached_url
    if _cached_url is None:
        with _cache_lock:
            if _cached_url is None:
                from django.conf import settings
                _cached_url = (
                    getattr(settings, "COLLAB_LIVE_URL", None)
                    or "http://localhost:4100"
                )
    return _cached_url


_DEFAULT_DEV_SECRET = "collab-live-dev-secret"


def _get_live_secret() -> str:
    global _cached_secret
    if _cached_secret is None:
        with _cache_lock:
            if _cached_secret is None:
                from django.conf import settings
                _cached_secret = getattr(settings, "COLLAB_LIVE_SECRET", "") or ""
                if not _cached_secret:
                    logger.critical(
                        "COLLAB_LIVE_SECRET 未配置，collab-live 调用将被拒绝"
                    )
                elif _cached_secret == _DEFAULT_DEV_SECRET and not settings.DEBUG:
                    logger.critical(
                        "生产环境使用了默认开发密钥 COLLAB_LIVE_SECRET，"
                        "请立即通过环境变量设置安全的随机密钥"
                    )
    return _cached_secret


def call_live_api(
    endpoint: str,
    data: dict,
    *,
    timeout: int = 10,
    max_retries: int = 2,
    retry_backoff: float = 0.5,
) -> dict:
    """
    调用 collab-live HTTP API（带重试）。

    :param endpoint: URL 路径（如 /convert/binary-to-formats）
    :param data: POST body（JSON 序列化）
    :param timeout: 单次请求超时秒数
    :param max_retries: 最大重试次数（0 = 不重试，默认 2 即最多 3 次尝试）
    :param retry_backoff: 重试间隔基数（秒），实际间隔 = backoff × attempt
    :returns: 响应 JSON 的 data 字段
    :raises RuntimeError: 所有尝试均失败
    """
    import requests

    global _circuit_open_until

    now = time.monotonic()
    if now < _circuit_open_until:
        raise RuntimeError("collab-live 服务不可用（熔断中，%ds 后重试）" % int(_circuit_open_until - now))

    url = f"{_get_live_url()}{endpoint}"
    headers = {
        "Content-Type": "application/json",
        "X-Live-Secret": _get_live_secret(),
    }

    last_err: Exception | None = None
    attempts = max_retries + 1
    is_connection_error = False

    for attempt in range(attempts):
        try:
            resp = requests.post(url, json=data, headers=headers, timeout=timeout)
            resp.raise_for_status()
            result = resp.json()
            status = result.get("status")
            # RB-011: status "partial" 表示本地撤销成功但 Redis 广播失败，仍返回 data 供调用方使用
            if status == "ok" or status == "partial":
                return result.get("data", {})
            raise RuntimeError(
                f"collab-live error: {result.get('message', 'unknown')}"
            )
        except requests.exceptions.ConnectionError as e:
            is_connection_error = True
            last_err = RuntimeError("collab-live 服务不可用")
            last_err.__cause__ = e
            break
        except requests.exceptions.Timeout as e:
            last_err = RuntimeError("collab-live 请求超时")
            last_err.__cause__ = e
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response else "?"
            if e.response is not None and 400 <= e.response.status_code < 500:
                raise RuntimeError(f"collab-live HTTP {status}: {e}") from e
            last_err = RuntimeError(f"collab-live HTTP {status}: {e}")
            last_err.__cause__ = e
        except RuntimeError:
            raise
        except Exception as e:
            last_err = RuntimeError(f"collab-live 调用失败: {e}")
            last_err.__cause__ = e

        if attempt < max_retries:
            wait = retry_backoff * (attempt + 1)
            logger.debug(
                "collab-live 重试 %d/%d (%.1fs后): %s",
                attempt + 1, max_retries, wait, endpoint,
            )
            time.sleep(wait)

    if is_connection_error:
        with _circuit_lock:
            _circuit_open_until = time.monotonic() + _CIRCUIT_COOLDOWN
        logger.warning(
            "collab-live 服务不可用，熔断 %ds: %s", int(_CIRCUIT_COOLDOWN), endpoint,
        )
    else:
        logger.warning(
            "collab-live 调用失败(已重试%d次): %s err=%s",
            max_retries, endpoint, last_err,
        )
    raise last_err  # type: ignore[misc]


def call_live_api_safe(
    endpoint: str,
    data: dict,
    *,
    timeout: int = 10,
    max_retries: int = 2,
    retry_backoff: float = 0.5,
    source: str = "",
    quiet: bool = False,
) -> dict:
    """
    fire-and-forget 版本：失败仅打 warning，不抛异常。

    返回 {"error": str} 或正常 data dict。

    :param quiet: 为 True 时，失败不打 warning 日志（由调用方自行处理日志），
                  适用于高频调用场景需要自定义日志降级的场景。
    """
    try:
        return call_live_api(
            endpoint, data,
            timeout=timeout,
            max_retries=max_retries,
            retry_backoff=retry_backoff,
        )
    except Exception as e:
        if not quiet:
            logger.warning(
                "call_live_api_safe 失败 [%s] %s: %s",
                source or "unknown", endpoint, e,
            )
        return {"error": str(e)}

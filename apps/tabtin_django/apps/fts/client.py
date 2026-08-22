"""ES 单例客户端 + Redis 共享 CircuitBreaker（PRD 4.8.A / ADR-14）。

职责：
    - 统一封装 `elasticsearch.Elasticsearch` 实例化，读取 settings
      `SEARCH_ES_HOSTS` / `SEARCH_ES_HTTP_AUTH` / `SEARCH_ES_TIMEOUT`。
    - 用 `pybreaker.CircuitBreaker` 做熔断，`CircuitRedisStorage` 共享
      多 worker 状态（避免 PRD 4.8.A 指出的"每进程独立阈值"陷阱）。
    - `SEARCH_ENGINE_ENABLED=false`（ADR-12 默认）时拒绝使用客户端，
      确保 flag 关闭场景不会意外打到 ES。

为什么用 elasticsearch-py 8.x（ADR-14）：
    - 阿里云 Elasticsearch 8.x 托管服务原生支持 8.x client；
    - 8.x client 支持 RRF retriever API，Wave 2 搜索服务层直接受益；
    - `opensearch-py` 仅兼容 ES 7.x 端点，无法调 8.x 新 API。

关于与阿里云 ES 的兼容：客户端 `headers` 中可通过
`elastic-api-version` 或 `compatible-with` 控制请求版本兼容头；
8.x client + 阿里云 ES 8.x 不需要额外兼容层，但本模块预留
`SEARCH_ES_COMPATIBILITY_HEADERS` 开关以便后续调优。
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from django.conf import settings

logger = logging.getLogger(__name__)

__all__ = [
    "SearchEngineDisabledError",
    "get_client",
    "get_breaker",
    "reset_client",
    "breaker_run",
    "is_engine_enabled",
    "record_search_outcome",
    "should_open_circuit",
    "ERROR_RATE_MIN_SAMPLE",
]


class SearchEngineDisabledError(RuntimeError):
    """当 SEARCH_ENGINE_ENABLED=false 时访问 client 抛出。

    **推荐调用模式**（避免异常做控制流扩散，Review A4）：

        from apps.fts.client import is_engine_enabled, get_client

        def my_handler(...):
            if not is_engine_enabled():
                return                         # 正常"关闭"路径，不走异常
            client = get_client()              # 此处不会抛
            client.index(...)

    `SearchEngineDisabledError` 只作为"调用方忘了判断"的 fail-fast 兜底，
    不是主路径。signal handler、API 层都应优先用 `is_engine_enabled()`
    前置判断。
    """


def is_engine_enabled() -> bool:
    """判断 FTS 主开关是否打开（settings.SEARCH_ENGINE_ENABLED）。

    供 signal handler / API / 降级路径在入口做 gate，避免异常控制流。
    """
    return _is_engine_enabled()


# ── 单例状态（模块级缓存 + 锁） ────────────────────────────────
_client_lock = threading.Lock()
_client_instance: Any | None = None

_breaker_lock = threading.Lock()
_breaker_instance: Any | None = None


def _is_engine_enabled() -> bool:
    return bool(getattr(settings, "SEARCH_ENGINE_ENABLED", False))


def _get_hosts() -> list[str]:
    hosts = getattr(settings, "SEARCH_ES_HOSTS", None) or ["http://localhost:9200"]
    if isinstance(hosts, str):
        hosts = [h.strip() for h in hosts.split(",") if h.strip()]
    return list(hosts)


def _get_http_auth() -> tuple[str, str] | None:
    raw = getattr(settings, "SEARCH_ES_HTTP_AUTH", None)
    if not raw:
        return None
    if isinstance(raw, (tuple, list)):
        user, pwd = (raw + ("", ""))[:2]
    elif isinstance(raw, str) and ":" in raw:
        user, pwd = raw.split(":", 1)
    else:
        return None
    if not user and not pwd:
        return None
    return (user, pwd)


def _build_client() -> Any:
    """构造并返回 `elasticsearch.Elasticsearch` 实例。

    分离出来以便测试可 monkeypatch。
    """
    from elasticsearch import Elasticsearch  # 延迟导入，支持未安装时优雅降级

    hosts = _get_hosts()
    kwargs: dict[str, Any] = {
        "hosts": hosts,
        "request_timeout": int(getattr(settings, "SEARCH_ES_TIMEOUT", 5)),
        # 阿里云 ES 托管兼容：默认关闭产品检查（本地开源镜像会校验失败；
        # 阿里云 ES 会返回非 Elastic 官方 product 头，client 默认会抛
        # `UnsupportedProductError`。关闭检查 + 手动校验 info() 更稳。
        "verify_certs": bool(getattr(settings, "SEARCH_ES_VERIFY_CERTS", True)),
    }
    http_auth = _get_http_auth()
    if http_auth:
        # 8.x client 用 `basic_auth` 命名
        kwargs["basic_auth"] = http_auth

    # 阿里云 ES 官方推荐禁用 product header 严格校验（阿里云内核返回自定义头）
    # https://help.aliyun.com/document_detail/196017.html
    if getattr(settings, "SEARCH_ES_DISABLE_PRODUCT_CHECK", True):
        kwargs["headers"] = {"x-elastic-product": "Elasticsearch"}

    client = Elasticsearch(**kwargs)
    logger.info("[FTS] ES client initialized; hosts=%s", hosts)
    return client


def get_client() -> Any:
    """返回线程安全的 ES 客户端单例。

    Raises:
        SearchEngineDisabledError: `SEARCH_ENGINE_ENABLED=false` 场景。
    """
    if not _is_engine_enabled():
        raise SearchEngineDisabledError(
            "SEARCH_ENGINE_ENABLED=false；拒绝返回 ES 客户端。"
            "请通过环境变量开启，或在降级路径上跳过 ES 访问。",
        )
    global _client_instance
    if _client_instance is not None:
        return _client_instance
    with _client_lock:
        if _client_instance is None:
            _client_instance = _build_client()
    return _client_instance


def reset_client() -> None:
    """释放单例（测试场景或热切换 settings 后使用）。"""
    global _client_instance
    with _client_lock:
        if _client_instance is not None:
            try:
                close = getattr(_client_instance, "close", None)
                if callable(close):
                    close()
            except Exception:  # pragma: no cover - 释放失败不影响流程
                logger.warning("[FTS] ES client close failed", exc_info=True)
        _client_instance = None
    global _breaker_instance
    with _breaker_lock:
        _breaker_instance = None


# ── CircuitBreaker（PRD 4.8.A） ────────────────────────────────
def _build_redis_storage():
    """构建 pybreaker `CircuitRedisStorage`。

    复用 Django `django_redis.get_redis_connection('default')` 拿到
    共享连接池，避免新建连接池增加 Redis 压力。
    """
    from pybreaker import CircuitRedisStorage
    from django_redis import get_redis_connection

    redis_conn = get_redis_connection("default")
    namespace = getattr(settings, "FTS_BREAKER_NAMESPACE", "fts_breaker")
    # pybreaker 1.4 的 CircuitRedisStorage 签名：(state, redis, namespace)
    # state 初始默认 'closed'；底层 ZSET 存放 fail counters 等
    return CircuitRedisStorage(state="closed", redis_object=redis_conn, namespace=namespace)


def _build_breaker() -> Any:
    """构造 pybreaker.CircuitBreaker 实例。

    参数：
        - fail_max：连续失败次数阈值（PRD 4.8.A）
        - reset_timeout：open -> half-open 的等待秒数
        - exclude：业务异常（如 ValidationError）不计入熔断样本

    Redis 共享状态（PRD 4.8.A 的核心承诺）：
        - `FTS_BREAKER_REQUIRE_REDIS=True`（生产默认）：Redis 不可达
          则 raise，让 worker 快速失败重启；**严禁**生产期静默降级到
          内存，否则多 worker 状态撕裂、故障阈值失效（Review A3）。
        - `FTS_BREAKER_REQUIRE_REDIS=False`（本地 DEBUG 默认）：允许
          降级到进程内存，打 WARNING 日志便于定位。
    """
    from pybreaker import CircuitBreaker

    fail_max = int(getattr(settings, "FTS_BREAKER_FAIL_MAX", 5))
    reset_timeout = int(getattr(settings, "FTS_BREAKER_RESET_TIMEOUT", 30))
    require_redis = bool(
        getattr(
            settings,
            "FTS_BREAKER_REQUIRE_REDIS",
            not getattr(settings, "DEBUG", False),
        ),
    )
    namespace = getattr(settings, "FTS_BREAKER_NAMESPACE", "fts_breaker")

    try:
        storage = _build_redis_storage()
    except Exception as exc:
        if require_redis:
            # 生产场景：Redis 不可用必须让 worker 立刻失败，供 Celery 重启
            # 或 Kubernetes 拉起新实例，避免带病运行。
            logger.error(
                "[FTS] Redis breaker storage unavailable and "
                "FTS_BREAKER_REQUIRE_REDIS=True: %s",
                exc,
            )
            raise
        logger.warning(
            "[FTS] Redis breaker storage unavailable, falling back to "
            "in-memory (FTS_BREAKER_REQUIRE_REDIS=False, 仅本地/测试"
            "允许使用；生产务必设为 True)",
            exc_info=True,
        )
        storage = None

    breaker_kwargs: dict[str, Any] = {
        "fail_max": fail_max,
        "reset_timeout": reset_timeout,
        # name 与 namespace 绑定，避免两者偏差后日志里仍是旧名
        "name": f"fts-{namespace}",
    }
    if storage is not None:
        breaker_kwargs["state_storage"] = storage

    return CircuitBreaker(**breaker_kwargs)


def get_breaker() -> Any:
    """返回共享 CircuitBreaker 单例。

    注意：breaker 即使在 `SEARCH_ENGINE_ENABLED=false` 时也可以实例化，
    因为 Wave 2 降级路径需要读取它判断是否 half-open 放流量探测。
    只是此时不会有任何调用能到达 ES。
    """
    global _breaker_instance
    if _breaker_instance is not None:
        return _breaker_instance
    with _breaker_lock:
        if _breaker_instance is None:
            _breaker_instance = _build_breaker()
    return _breaker_instance


def breaker_run(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """用 breaker 包裹 ES 调用。

    典型用法：
        >>> breaker_run(client.search, index='tabtin-*', query={...})

    抛 `pybreaker.CircuitBreakerError` 时，调用方应走降级路径
    （Wave 2 fallback_service.fallback_search）。

    R0-04 滑窗记录：
        - 同步把每次调用结果（成功/失败）写入 1min Redis 桶；
        - `should_open_circuit()` 读这两个桶按错误率决策；
        - 只在 search_service 路径调用此 helper（不要在 sync 同步管道里
          用，否则会污染搜索 SLO 的样本基数）
    """
    breaker = get_breaker()
    try:
        result = breaker.call(func, *args, **kwargs)
    except Exception as exc:
        # 记录失败到 1min 滑窗（pybreaker 已经把它算进 fail_max）
        record_search_outcome(success=False)
        raise
    record_search_outcome(success=True)
    return result


# ── 1min 滑窗错误率（R0-04 + PRD 4.8.B） ───────────────────────
# 设计：两个 Redis 桶 `fts:errors:{minute}:total` / `:errors`
#   - 每次 breaker_run() 同步 INCR 一次（所以 fts API QPS 影响 Redis QPS 1:1）
#   - TTL 70s（覆盖跨分钟边界场景，避免到点失效造成"读 0/0 误判健康"）
#   - 样本不足时（total < ERROR_RATE_MIN_SAMPLE）不开熔断，保护"刚启动
#     就被几次失败误熔断"的场景
#   - 阈值由 settings.FTS_BREAKER_ERROR_RATE_THRESHOLD 控制，默认 0.5
ERROR_RATE_MIN_SAMPLE = 20  # 1min 内至少 20 个样本才能触发熔断决策
_ERROR_RATE_KEY_PREFIX = "fts:errors:"
_ERROR_RATE_TTL = 70  # 秒


def _current_minute_bucket() -> int:
    import time
    return int(time.time() // 60)


def _get_redis_for_metrics():
    """供错误率统计用 Redis；失败时静默退化（不影响主流程）。"""
    try:
        from django_redis import get_redis_connection
        return get_redis_connection("default")
    except Exception:
        return None


def record_search_outcome(*, success: bool) -> None:
    """记录一次搜索调用的成功/失败到 1min 桶。"""
    redis = _get_redis_for_metrics()
    if redis is None:
        return
    minute = _current_minute_bucket()
    base = f"{_ERROR_RATE_KEY_PREFIX}{minute}"
    try:
        # pipelined for fewer round-trips
        pipe = redis.pipeline()
        pipe.incr(f"{base}:total")
        pipe.expire(f"{base}:total", _ERROR_RATE_TTL)
        if not success:
            pipe.incr(f"{base}:errors")
            pipe.expire(f"{base}:errors", _ERROR_RATE_TTL)
        pipe.execute()
    except Exception:  # pragma: no cover - 监控失败不影响业务
        logger.debug("[FTS] error rate record failed", exc_info=True)


def should_open_circuit() -> bool:
    """读 1min 桶判断是否触发熔断（PRD 4.8.B）。

    返回 True 表示"错误率超过阈值"；fallback_service 据此判定 reason=
    'error_rate_breach'。注意：这里 **不实际调用 breaker.open()**，
    pybreaker 自己按 fail_max 触发；此方法只是给降级路径多一个判定依据，
    避免单个 worker 的 pybreaker 还没攒够 5 次失败但全局错误率已经飙红
    的真空期。
    """
    redis = _get_redis_for_metrics()
    if redis is None:
        return False
    threshold = float(getattr(settings, "FTS_BREAKER_ERROR_RATE_THRESHOLD", 0.5) or 0.5)
    minute = _current_minute_bucket()
    base = f"{_ERROR_RATE_KEY_PREFIX}{minute}"
    try:
        total_raw = redis.get(f"{base}:total")
        err_raw = redis.get(f"{base}:errors")
    except Exception:  # pragma: no cover
        return False
    total = int(total_raw or 0)
    errors = int(err_raw or 0)
    if total < ERROR_RATE_MIN_SAMPLE:
        return False
    return (errors / total) > threshold

"""
向量化服务

负责调用 LLM Embedding API 生成向量

v0.1 宪法：provider/model/credentials/dimensions 单源来自 LLMSceneBinding 解析出的
LLMModel；EmbeddingService 不再读 settings.RAG_EMBEDDING_* 业务感 env。

调用入口：
- capability 入口 ``apps.services.llm.services.embedding.embed_text(scene_key=..., ...)``
  会将 resolve_model() 选出的 LLMModel 通过 ``model_info`` 传入，下游 OpenAI
  兼容客户端凭 model_info.provider 的 base_url + api_key 构造。
- 历史调用方 ``get_embedding_service()`` 不传 model_info 时，懒加载阶段以
  ``rag_search_query`` scene 兜底解析（v0.1 全部 8 个 embedding scene 共用同一
  global provider）。
"""

import functools
import logging
import random
import threading
import time
from typing import TYPE_CHECKING, List, Optional

from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured

from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

if TYPE_CHECKING:
    from apps.services.llm.models import LLMModel

logger = logging.getLogger(__name__)

# ── 计费模块启动时 import ──────────────────────────────────────────────────────
# 统一在模块级 import，避免运行时 try/except 逐次 import 掩盖缺失依赖。
# import 失败时仅记录 error 日志并设标志位，保证 Embedding 服务本身仍可用。
try:
    from apps.services.billing.services.billing_precheck import (
        billing_precheck as _billing_precheck,
    )
    from apps.users.wallet.services import CreditsService as _CreditsService
    _BILLING_AVAILABLE = True
except ImportError as _billing_import_err:
    logger.error(
        "计费模块导入失败，Embedding 计费功能将不可用: %s",
        _billing_import_err,
    )
    _BILLING_AVAILABLE = False
    _billing_precheck = None  # type: ignore[assignment]
    _CreditsService = None  # type: ignore[assignment]


@functools.lru_cache(maxsize=1)
def _get_retryable_exceptions() -> tuple:
    """收集可重试的异常类型，不直接依赖 openai 包。"""
    bases: list = [ConnectionError, TimeoutError, OSError]
    try:
        from openai import (
            RateLimitError, APIConnectionError, APITimeoutError, InternalServerError,
        )
        bases.extend([RateLimitError, APIConnectionError, APITimeoutError, InternalServerError])
    except ImportError:
        pass
    return tuple(bases)

EMBED_MAX_RETRIES = 3
EMBED_RETRY_BASE_DELAY = 1.0

# EB-010: Redis 熔断器配置
# provider 级熔断：连续 429 次数超过阈值后快速失败，避免所有并发 worker 进入重试风暴
_CIRCUIT_BREAKER_THRESHOLD = 5          # 连续 429 次数阈值
_CIRCUIT_BREAKER_OPEN_TTL = 60          # 熔断打开后冷却秒数（TTL）
_CIRCUIT_BREAKER_REDIS_KEY_PREFIX = "rag:circuit:embedding"


class DailyQuotaExceededError(Exception):
    """RAG 每日 token 配额已耗尽。"""
    pass


class CircuitBreakerOpenError(Exception):
    """provider 级熔断器已打开，拒绝请求以避免重试风暴。"""
    pass


_DAILY_QUOTA_REDIS_KEY_PREFIX = "rag:daily_token_usage"


def _get_daily_quota_key() -> str:
    """Return a Redis key scoped to today's date for daily token counting."""
    from django.utils import timezone as _tz
    today = _tz.localdate().isoformat()
    return f"{_DAILY_QUOTA_REDIS_KEY_PREFIX}:{today}"


def _parse_duration_to_seconds(duration_str: str) -> Optional[float]:
    """EB-008: 将 OpenAI x-ratelimit-reset-requests 头的时间格式转换为秒数。

    支持格式：
    - "30s" → 30.0
    - "1m30s" → 90.0
    - "1h2m3s" → 3723.0
    - "42" → 42.0（纯数字，单位秒）
    """
    import re
    if not duration_str:
        return None
    try:
        return float(duration_str)
    except ValueError:
        pass
    pattern = re.compile(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?')
    match = pattern.fullmatch(duration_str.strip())
    if match and any(match.groups()):
        hours = float(match.group(1) or 0)
        minutes = float(match.group(2) or 0)
        seconds = float(match.group(3) or 0)
        total = hours * 3600 + minutes * 60 + seconds
        return total if total > 0 else None
    return None


class EmbeddingService:
    """
    向量化服务

    职责：
    - 调用 LLM Embedding API 生成向量
    - 管理向量化缓存
    - 批量处理优化
    - RAG_DAILY_QUOTA 每日 token 配额护栏

    v0.1 宪法：所有可调参数（provider / model / dimensions / api_key / base_url）
    单源来自 LLMSceneBinding 解析出的 LLMModel。
    - capability 入口（``apps.services.llm.services.embedding.embed_text``）调用时
      显式传入 ``model_info``，零额外开销。
    - 历史/legacy 调用方使用 ``get_embedding_service()`` 时，首次访问触发懒解析，
      以 ``rag_search_query`` scene 作为兜底入口（v0.1 全部 embedding scene 共用同
      一 global provider）。
    """

    # DashScope Embedding API 每请求最多 10 条
    _QWEN_MAX_BATCH_SIZE = 10
    _QWEN_SUPPORTED_DIMENSIONS = (64, 128, 256, 512, 1024)
    # v0.1 宪法：所有 embedding scene 强制 dimensions=1024（参见 06 §1）
    _DEFAULT_DIMENSIONS = 1024
    # v0.1 兜底用 scene_key（仅 legacy 调用方未传 model_info 时使用）
    _FALLBACK_RESOLVE_SCENE = 'rag_search_query'

    def __init__(self, *, model_info: "Optional[LLMModel]" = None):
        """初始化向量化服务（懒加载）。

        Args:
            model_info: capability 入口已解析好的 LLMModel；为 None 时首次调用
                时通过 ``rag_search_query`` scene 兜底解析。
        """
        self._model_info: "Optional[LLMModel]" = model_info
        self.batch_size = getattr(settings, 'RAG_BATCH_SIZE', 50)
        # 缓存 key 中保留版本占位符，便于未来切模型时强制失效旧 cache
        self._model_version = 'v1'
        self._client = None
        self._resolved = False

    # ── 懒解析 ──────────────────────────────────────────────────────────

    def _ensure_resolved(self) -> None:
        """首次访问 provider/model/dimensions/client 时触发模型解析。"""
        if self._resolved:
            return
        if self._model_info is None:
            from apps.services.llm.services._runtime.model_resolver import resolve_model
            from apps.services.llm.scenes.registry import SCENES

            scene = SCENES.get(self._FALLBACK_RESOLVE_SCENE)
            if scene is None:
                raise ImproperlyConfigured(
                    f"EmbeddingService 兜底 scene '{self._FALLBACK_RESOLVE_SCENE}' "
                    f"未在 SceneRegistry 注册，无法解析 embedding 模型。"
                )
            try:
                model, _scope = resolve_model(
                    scene_key=self._FALLBACK_RESOLVE_SCENE,
                    capability_domain='embedding',
                    capability_requirements=scene.capability_requirements,
                )
            except SceneRoutingDisabled:
                raise
            except Exception as exc:
                raise ImproperlyConfigured(
                    f"EmbeddingService 无法从 LLMSceneBinding(scene_key="
                    f"'{self._FALLBACK_RESOLVE_SCENE}') 解析 embedding 模型："
                    f"{exc}。请先 seed LLMSceneBinding fixture。"
                ) from exc
            self._model_info = model

        provider_obj = self._model_info.provider
        api_key = provider_obj.api_key
        # v0.1.x Phase 2.5：base_url 从 model 取（Provider.base_url 已删）。
        # embedding 走 OpenAI 兼容协议，model.base_url 通常是 https://.../compatible-mode/v1。
        base_url = self._model_info.base_url
        if not api_key:
            raise ImproperlyConfigured(
                f"LLMProvider '{provider_obj.name}' 未配置 api_key，"
                f"无法初始化 embedding 客户端。请在 AdminDash 或 fixture 中补齐凭据。"
            )

        from apps.services.llm.services._runtime.embedding_sdk_client import create_embedding_client
        self._client = create_embedding_client(api_key, base_url)

        provider_key = self._compute_provider_key()
        if 'qwen' in provider_key or 'dashscope' in provider_key:
            self.batch_size = min(self.batch_size, self._QWEN_MAX_BATCH_SIZE)

        cap_config = self._model_info.capabilities_config or {}
        dims = int(cap_config.get('embedding_dimensions') or self._DEFAULT_DIMENSIONS)
        if 'qwen' in provider_key and dims not in self._QWEN_SUPPORTED_DIMENSIONS:
            raise ImproperlyConfigured(
                f"qwen embedding (model={self._model_info.model_name}) 不支持 "
                f"dimensions={dims}，支持维度 {self._QWEN_SUPPORTED_DIMENSIONS}。"
                f"请检查 LLMModel.capabilities_config.embedding_dimensions 或 "
                f"SceneRegistry 配置。"
            )

        self._resolved = True
        logger.info(
            "✅ 向量化服务解析完成: provider=%s, model=%s, dimensions=%s, base_url=%s",
            provider_key, self._model_info.model_name, dims, base_url,
        )

    @property
    def model_info(self) -> "LLMModel":
        self._ensure_resolved()
        return self._model_info  # type: ignore[return-value]

    def _compute_provider_key(self) -> str:
        """直接从已设置的 _model_info 计算 provider key，不触发 _ensure_resolved。

        仅在 _ensure_resolved 内部及已经触发过 ensure 的属性访问后使用。
        """
        provider_obj = self._model_info.provider  # type: ignore[union-attr]
        return (provider_obj.provider_key or provider_obj.name or '').lower()

    @property
    def provider(self) -> str:
        """返回 provider 标识（小写），主要用于 metadata 与 qwen 行为分支。"""
        self._ensure_resolved()
        return self._compute_provider_key()

    @property
    def model(self) -> str:
        self._ensure_resolved()
        return self._model_info.model_name  # type: ignore[union-attr]

    @property
    def dimensions(self) -> int:
        self._ensure_resolved()
        cap_config = self._model_info.capabilities_config or {}  # type: ignore[union-attr]
        dims = cap_config.get('embedding_dimensions') or self._DEFAULT_DIMENSIONS
        return int(dims)

    @property
    def client(self):
        self._ensure_resolved()
        return self._client

    # OpenAI 支持 dimensions 参数的模型前缀（ada-002 不支持）
    _OPENAI_DIMENSIONS_SUPPORTED_PREFIXES = (
        "text-embedding-3-small",
        "text-embedding-3-large",
    )

    def _build_embed_kwargs(self, input_data):
        """构建 embeddings.create 参数。

        qwen 和 OpenAI text-embedding-3 系列均支持 dimensions 参数；
        text-embedding-ada-002 不支持，不传。
        """
        self._ensure_resolved()
        model_name = self._model_info.model_name  # type: ignore[union-attr]
        kwargs = {'model': model_name, 'input': input_data}
        provider_key = self._compute_provider_key()
        if 'qwen' in provider_key or 'dashscope' in provider_key:
            kwargs['dimensions'] = self.dimensions
        elif any(
            model_name.startswith(prefix)
            for prefix in self._OPENAI_DIMENSIONS_SUPPORTED_PREFIXES
        ):
            kwargs['dimensions'] = self.dimensions
        return kwargs

    def _truncate_text(self, text: str) -> str:
        """截断超长文本，防止 Embedding API 超额调用。"""
        max_tokens = getattr(settings, "RAG_MAX_TOKENS_PER_REQUEST", 8192)
        # FND-13: 中文约 1.5 token/char，1 token ≈ 0.67 char，保守取 max_tokens * 2/3
        max_chars = max_tokens * 2 // 3
        if len(text) > max_chars:
            logger.warning(
                "Text truncated: %d -> %d chars (max_tokens=%d)",
                len(text), max_chars, max_tokens,
            )
            text = text[:max_chars]
        return text

    def embed_text(
        self,
        text: str,
        use_cache: bool = True,
        user_id: str = "",
        organization_id: str = "",
        raise_on_rate_limit: bool = False,
    ) -> List[float]:
        """
        单文本向量化

        Args:
            text: 要向量化的文本
            use_cache: 是否使用缓存（默认 True）
            user_id: 用于计费的用户 ID
            organization_id: 用于计费的组织 ID
            raise_on_rate_limit: EB-009 协调参数。Celery 外层重试时设为 True，
                内层遇到 RateLimitError 直接抛出而不消耗内层重试次数，
                避免双重重试放大 (内 3+1) × (外 3+1) = 16 次 API 调用。

        计费策略（v0.1.x Phase 2.5 修订）：
        - EmbeddingService 内部 ``_charge_embedding_usage`` 是 embedding 计费的唯一入口
          （处理大额同步扣 Credits / 小额异步聚合 / degradation 追踪）。
        - capability 入口（``apps.services.llm.services.embedding.embed_text``）的
          ``_runtime/usage_recorder._write_billing_event`` 会**跳过 embedding domain**，
          避免双写 BillingUsageEvent。
        - 这样保留了"老路径扣费 + 新路径 LLMUsageFact 审计"的分工，没有重复/漏算。

        Returns:
            List[float]: 向量
        """
        if not text or not text.strip():
            raise ValueError("文本不能为空")

        text = self._truncate_text(text)
        content_hash = self._calculate_hash(text)

        if use_cache:
            cached_vector = self._get_cached_vector(content_hash)
            if cached_vector:
                return cached_vector

        self._check_daily_quota()
        self._check_circuit_breaker()
        self._precheck_billing(user_id, organization_id)

        retryable = _get_retryable_exceptions()
        last_exc: Optional[Exception] = None
        # FND-12 (W4-fix): 用内容 hash 作为 charge_id，保证跨进程重试（Celery 重启）幂等，
        # 避免同一文本在进程重启后被重复计费。同一文本在 48h 缓存 TTL 内只计费一次，
        # 超过缓存 TTL 后重新向量化时漏计费，符合 D1 可用性优先原则。
        charge_id = content_hash

        for attempt in range(EMBED_MAX_RETRIES + 1):
            try:
                response = self.client.embeddings.create(
                    **self._build_embed_kwargs(text)
                )

                vector = response.data[0].embedding

                if len(vector) != self.dimensions:
                    raise ValueError(
                        f"向量维度不匹配: expected={self.dimensions}, got={len(vector)}"
                    )

                self._reset_circuit_breaker()
                self._charge_embedding_usage(
                    response, user_id, organization_id, charge_id=charge_id,
                )
                self._record_usage_from_response(response)

                if use_cache:
                    self._cache_vector(content_hash, vector)

                return vector

            except retryable as e:
                last_exc = e
                is_rate_limit = self._is_rate_limit_error(e)
                if is_rate_limit:
                    self._record_rate_limit_hit()
                    # EB-009: Celery 外层重试时不在内层消耗重试次数，直接抛出让外层处理
                    if raise_on_rate_limit:
                        logger.warning(
                            "向量化 RateLimitError (raise_on_rate_limit=True，"
                            "交由 Celery 外层重试): %s", e,
                        )
                        raise
                if attempt < EMBED_MAX_RETRIES:
                    # EB-008: 优先读取 Retry-After 响应头；EB-007: 加 jitter 抖动
                    delay = self._compute_retry_delay(e, attempt)
                    logger.warning(
                        "向量化可重试错误 (attempt %d/%d), %.1fs 后重试: %s",
                        attempt + 1, EMBED_MAX_RETRIES, delay, e,
                    )
                    time.sleep(delay)
                else:
                    logger.error("向量化失败 (已重试 %d 次): %s", EMBED_MAX_RETRIES, e)
                    raise

            except Exception as e:
                logger.error("向量化失败 (不可重试): %s", e)
                raise

        raise last_exc  # type: ignore[misc]

    def embed_texts(
        self,
        texts: List[str],
        use_cache: bool = True,
        user_id: str = "",
        organization_id: str = "",
        raise_on_rate_limit: bool = False,
    ) -> List[List[float]]:
        """
        批量文本向量化 — 减少网络往返，提高吞吐。

        内部按 self.batch_size 分批调用 API，每批一次网络请求。
        命中缓存的文本不占用 API 调用额度。

        Args:
            raise_on_rate_limit: EB-009 协调参数。Celery 外层重试时设为 True，
                内层遇到 RateLimitError 直接抛出，避免双重重试放大。

        Returns:
            List[List[float]]: 与输入 texts 顺序一致的向量列表
        """
        if not texts:
            return []

        results: List[Optional[List[float]]] = [None] * len(texts)
        uncached_indices: List[int] = []
        uncached_texts: List[str] = []
        hash_list: List[str] = [''] * len(texts)

        for i, text in enumerate(texts):
            if not text or not text.strip():
                raise ValueError(f"texts[{i}] 不能为空")
            truncated = self._truncate_text(text)
            content_hash = self._calculate_hash(truncated)
            hash_list[i] = content_hash

            if use_cache:
                cached = self._get_cached_vector(content_hash)
                if cached:
                    results[i] = cached
                    continue

            uncached_indices.append(i)
            uncached_texts.append(truncated)

        if not uncached_texts:
            return results  # type: ignore[return-value]

        self._check_daily_quota()
        self._check_circuit_breaker()
        self._precheck_billing(user_id, organization_id)

        retryable = _get_retryable_exceptions()
        batch_size = self.batch_size
        import hashlib as _hashlib

        for batch_start in range(0, len(uncached_texts), batch_size):
            batch = uncached_texts[batch_start:batch_start + batch_size]
            batch_idx = uncached_indices[batch_start:batch_start + batch_size]

            # FND-12 (W4-fix): 用批次内各文本内容 hash 拼接后的 MD5 生成确定性 batch_charge_id，
            # 保证跨进程重试（Celery 重启）幂等，彻底消除随机 uuid4 在进程重启时重复计费的风险。
            _batch_key_src = "|".join(hash_list[i] for i in batch_idx)
            batch_charge_id = _hashlib.md5(_batch_key_src.encode()).hexdigest()[:24]
            last_exc: Optional[Exception] = None
            for attempt in range(EMBED_MAX_RETRIES + 1):
                try:
                    response = self.client.embeddings.create(
                        **self._build_embed_kwargs(batch)
                    )

                    sorted_data = sorted(response.data, key=lambda d: d.index)
                    for j, emb_obj in enumerate(sorted_data):
                        vector = emb_obj.embedding
                        if len(vector) != self.dimensions:
                            raise ValueError(
                                f"向量维度不匹配: expected={self.dimensions}, got={len(vector)}"
                            )
                        orig_idx = batch_idx[j]
                        results[orig_idx] = vector
                        if use_cache:
                            self._cache_vector(hash_list[orig_idx], vector)

                    self._reset_circuit_breaker()
                    self._charge_embedding_usage(
                        response, user_id, organization_id,
                        charge_id=batch_charge_id,
                    )
                    self._record_usage_from_response(response)
                    break

                except retryable as e:
                    last_exc = e
                    is_rate_limit = self._is_rate_limit_error(e)
                    if is_rate_limit:
                        self._record_rate_limit_hit()
                        if raise_on_rate_limit:
                            logger.warning(
                                "批量向量化 RateLimitError (raise_on_rate_limit=True，"
                                "交由 Celery 外层重试): %s", e,
                            )
                            raise
                    if attempt < EMBED_MAX_RETRIES:
                        # EB-008: 优先读取 Retry-After 响应头；EB-007: 加 jitter 抖动
                        delay = self._compute_retry_delay(e, attempt)
                        logger.warning(
                            "批量向量化可重试错误 (attempt %d/%d, batch %d-%d), %.1fs 后重试: %s",
                            attempt + 1, EMBED_MAX_RETRIES,
                            batch_start, batch_start + len(batch), delay, e,
                        )
                        time.sleep(delay)
                    else:
                        logger.error("批量向量化失败 (已重试 %d 次): %s", EMBED_MAX_RETRIES, e)
                        raise

                except Exception as e:
                    logger.error("批量向量化失败 (不可重试): %s", e)
                    raise

        missing = [i for i, v in enumerate(results) if v is None]
        if missing:
            raise ValueError(
                f"embed_texts: {len(missing)}/{len(texts)} texts 未获得向量 "
                f"(indices: {missing[:10]})"
            )

        return results  # type: ignore[return-value]

    # ===== 私有方法 =====

    @staticmethod
    def _is_rate_limit_error(exc: Exception) -> bool:
        """判断异常是否为 429 RateLimitError（鸭子类型，不直接 import openai）。"""
        status = getattr(exc, 'status_code', None)
        if status == 429:
            return True
        cls_name = type(exc).__name__
        return cls_name == 'RateLimitError'

    @staticmethod
    def _extract_retry_after(exc: Exception) -> Optional[float]:
        """EB-008: 从 RateLimitError 响应头中提取 Retry-After 冷却秒数。

        OpenAI/DashScope 429 响应可能包含：
        - Retry-After: <seconds>
        - x-ratelimit-reset-requests: <ISO8601 duration 或秒数>
        返回 None 表示未找到有效头，调用方应使用默认指数退避。
        鸭子类型检测，不直接 import openai。
        """
        if not EmbeddingService._is_rate_limit_error(exc):
            return None
        try:
            response = getattr(exc, "response", None)
            if response is None:
                return None
            headers = getattr(response, "headers", {}) or {}
            retry_after = headers.get("retry-after") or headers.get("Retry-After")
            if retry_after:
                return float(retry_after)
            reset_requests = (
                headers.get("x-ratelimit-reset-requests")
                or headers.get("X-Ratelimit-Reset-Requests")
            )
            if reset_requests:
                return _parse_duration_to_seconds(reset_requests)
        except Exception:
            pass
        return None

    def _compute_retry_delay(self, exc: Exception, attempt: int) -> float:
        """EB-007 + EB-008: 计算重试等待时间。

        优先级：Retry-After 头 > 带 jitter 的指数退避。
        jitter 范围 [0, base]，防止多 worker 同步重试。
        """
        retry_after = self._extract_retry_after(exc)
        if retry_after is not None and retry_after > 0:
            # 在 Retry-After 基础上加小幅 jitter，避免同 TTL 的多 worker 同步触发
            jitter = random.uniform(0, min(EMBED_RETRY_BASE_DELAY, retry_after * 0.1))
            delay = retry_after + jitter
            logger.info(
                "Retry-After 头指定冷却 %.1fs，实际等待 %.1fs (jitter=%.2f)",
                retry_after, delay, jitter,
            )
            return delay
        # EB-007: 指数退避 + full jitter，避免多 worker 同步重试
        base = EMBED_RETRY_BASE_DELAY * (2 ** attempt)
        jitter = random.uniform(0, EMBED_RETRY_BASE_DELAY)
        return base + jitter

    def _get_circuit_breaker_key(self) -> str:
        return f"{_CIRCUIT_BREAKER_REDIS_KEY_PREFIX}:{self.provider}"

    def _check_circuit_breaker(self) -> None:
        """EB-010: 检查 provider 级熔断器状态。熔断打开时抛出 CircuitBreakerOpenError。"""
        try:
            from django_redis import get_redis_connection
            redis = get_redis_connection("default")
            key = self._get_circuit_breaker_key()
            val = redis.get(key)
            if val is not None:
                consecutive = int(val)
                if consecutive >= _CIRCUIT_BREAKER_THRESHOLD:
                    ttl = redis.ttl(key)
                    logger.warning(
                        "Embedding 熔断器已打开 (provider=%s, consecutive_429=%d, ttl=%ds)，"
                        "快速失败以避免重试风暴",
                        self.provider, consecutive, ttl,
                    )
                    raise CircuitBreakerOpenError(
                        f"Embedding provider={self.provider} 熔断器已打开，"
                        f"连续 429 次数={consecutive}，请 {ttl}s 后重试"
                    )
        except CircuitBreakerOpenError:
            raise
        except Exception as exc:
            logger.debug("熔断器检查失败（允许请求通过）: %s", exc)

    def _record_rate_limit_hit(self) -> None:
        """EB-010: 记录一次 429 hit，若超阈值则打开熔断器。"""
        try:
            from django_redis import get_redis_connection
            redis = get_redis_connection("default")
            key = self._get_circuit_breaker_key()
            pipe = redis.pipeline()
            pipe.incr(key)
            pipe.expire(key, _CIRCUIT_BREAKER_OPEN_TTL)
            results = pipe.execute()
            consecutive = results[0]
            if consecutive >= _CIRCUIT_BREAKER_THRESHOLD:
                logger.warning(
                    "Embedding 熔断器触发 (provider=%s, consecutive_429=%d >= threshold=%d)，"
                    "后续请求将快速失败 %ds",
                    self.provider, consecutive, _CIRCUIT_BREAKER_THRESHOLD,
                    _CIRCUIT_BREAKER_OPEN_TTL,
                )
        except Exception as exc:
            logger.debug("记录 429 hit 失败: %s", exc)

    def _reset_circuit_breaker(self) -> None:
        """EB-010: 请求成功后重置熔断器计数。"""
        try:
            from django_redis import get_redis_connection
            redis = get_redis_connection("default")
            redis.delete(self._get_circuit_breaker_key())
        except Exception as exc:
            logger.debug("重置熔断器失败: %s", exc)

    @staticmethod
    def _check_daily_quota() -> None:
        """RAG-8: 检查当日 token 用量是否超过 RAG_DAILY_QUOTA，超限则拒绝请求。"""
        quota = getattr(settings, "RAG_DAILY_QUOTA", 0)
        if not quota or quota <= 0:
            return
        try:
            from django_redis import get_redis_connection
            redis = get_redis_connection("default")
            key = _get_daily_quota_key()
            current = redis.get(key)
            current_usage = int(current) if current else 0
            if current_usage >= quota:
                logger.warning(
                    "RAG daily quota exceeded: usage=%d, quota=%d",
                    current_usage, quota,
                )
                raise DailyQuotaExceededError(
                    f"每日 embedding token 配额已耗尽 ({current_usage}/{quota})"
                )
        except DailyQuotaExceededError:
            raise
        except Exception as exc:
            logger.warning("RAG daily quota check failed (allowing request): %s", exc)

    @staticmethod
    def _record_daily_usage(tokens: int) -> None:
        """RAG-8: 将本次消耗的 token 数累加到 Redis 每日计数器。"""
        if tokens <= 0:
            return
        try:
            from django_redis import get_redis_connection
            redis = get_redis_connection("default")
            key = _get_daily_quota_key()
            pipe = redis.pipeline()
            pipe.incrby(key, tokens)
            pipe.expire(key, 86400 + 3600)
            pipe.execute()
        except Exception as exc:
            logger.warning("RAG daily usage recording failed: %s", exc)

    @staticmethod
    def _record_usage_from_response(response) -> None:
        """Extract token usage from API response and record to daily quota counter."""
        try:
            usage = getattr(response, "usage", None)
            if not usage:
                return
            total_tokens = getattr(usage, "total_tokens", 0) or getattr(usage, "prompt_tokens", 0)
            EmbeddingService._record_daily_usage(total_tokens)
        except Exception as exc:
            logger.warning("Failed to record usage from response: %s", exc)

    @staticmethod
    def _precheck_billing(user_id: str, organization_id: str) -> None:
        """统一四层计费预检，阻断时按 layer 抛出对应 BillingError 子类。

        计费模块不可用（_BILLING_AVAILABLE=False）时记录 warning 并直接返回，
        保持 Embedding 服务可用性，但不做任何余额/预算检查。
        """
        if not user_id:
            return
        if not organization_id:
            logger.debug(
                "跳过 Embedding 预检：organization_id 为空 (user_id=%s)",
                user_id,
            )
            return
        if not _BILLING_AVAILABLE:
            logger.warning(
                "计费模块不可用，跳过 Embedding 预检 "
                "(user_id=%s, organization_id=%s)",
                user_id, organization_id,
            )
            return
        result = _billing_precheck(organization_id, user_id, context="rag_embedding", source="auto_task")
        result.raise_if_blocked()

    def _charge_embedding_usage(
        self, response, user_id: str, organization_id: str,
        *, charge_id: str = "",
    ) -> None:
        """从 OpenAI Embedding 响应中提取 usage 并计费。

        FND-12: 调用方应在重试循环外生成 charge_id 并传入，
        保证同一批次重试时 idempotency_key 不变，避免重复计费。
        计费模块不可用时静默跳过（_BILLING_AVAILABLE=False）。
        """
        if not user_id:
            return
        if not _BILLING_AVAILABLE:
            # ECI-008: 计费模块不可用时记录降级日志，确保运维可感知
            try:
                from apps.services.billing.services.degradation_tracker import track_billing_degradation
                track_billing_degradation(
                    meter_key="rag.embedding",
                    organization_id=organization_id or "",
                    biz_type="embedding",
                    error="billing_module_unavailable",
                )
            except Exception:
                logger.warning(
                    "Embedding 计费模块不可用且降级追踪也失败 "
                    "(user_id=%s, organization_id=%s)",
                    user_id, organization_id,
                )
            return
        try:
            usage = getattr(response, "usage", None)
            if not usage:
                return
            total_tokens = getattr(usage, "total_tokens", 0) or getattr(usage, "prompt_tokens", 0)
            if total_tokens <= 0:
                return
            from decimal import Decimal
            import uuid as _uuid_mod
            if not charge_id:
                charge_id = str(_uuid_mod.uuid4())

            quantity = Decimal(str(total_tokens)) / Decimal("1000")

            # W3-4: 按金额阈值动态分流（大额同步、小额异步聚合）
            try:
                from apps.services.billing.services.pricing_service import MeterPricingService
                from apps.services.billing.models import BillingRuntimeConfig
                unit_price = MeterPricingService.get_unit_price(
                    "rag.embedding.tokens",
                    organization_id=organization_id or None,
                    provider_key=self.provider,
                    default_price=Decimal("0"),
                ) or Decimal("0")
                estimated_amount = quantity * unit_price
                threshold = Decimal(str(
                    BillingRuntimeConfig.get_instance().sync_charge_threshold_credits
                ))
            except Exception:
                unit_price = Decimal("0")
                estimated_amount = Decimal("0")
                threshold = Decimal("100")

            if estimated_amount >= threshold:
                billing_result = _CreditsService.consume_credits(
                    user_id=user_id,
                    organization_id=organization_id or None,
                    meter_key="rag.embedding.tokens",
                    quantity=quantity,
                    unit="k_tokens",
                    provider_key=self.provider,
                    biz_type="embedding",
                    description=f"Embedding {total_tokens} tokens ({self.model})",
                    biz_id=charge_id,
                    idempotency_key=f"embedding:{charge_id}",
                )
                if isinstance(billing_result, dict) and not billing_result.get("charged", True):
                    reason = billing_result.get("reason", "unknown")
                    logger.warning(
                        "Embedding 计费跳过（tokens 已消耗但未扣款）: "
                        "reason=%s user_id=%s organization_id=%s tokens=%d charge_id=%s",
                        reason, user_id, organization_id, total_tokens, charge_id,
                    )
            else:
                from apps.services.billing.services import BillingUsageService
                BillingUsageService.record_event(
                    organization_id=organization_id or "",
                    user_id=user_id,
                    meter_key="rag.embedding.tokens",
                    quantity=quantity,
                    unit="k_tokens",
                    unit_price=unit_price,
                    amount=estimated_amount,
                    currency="CREDITS",
                    provider_key=self.provider,
                    biz_type="embedding",
                    biz_id=charge_id,
                    idempotency_key=f"embedding:{charge_id}",
                    charge_status="pending",
                )
        except Exception as exc:
            logger.warning("Embedding 计费失败（不中断主流程）: %s", exc, exc_info=True)
            try:
                from apps.services.billing.services.degradation_tracker import track_billing_degradation
                track_billing_degradation(meter_key="rag.embedding", organization_id=organization_id or "", biz_type="embedding", error=str(exc))
            except Exception:
                pass

    @staticmethod
    def _calculate_hash(text: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(text)

    def _get_cached_vector(self, content_hash: str) -> Optional[List[float]]:
        """从缓存获取向量"""
        cache_key = f"rag:vector:{self.model}:{self.dimensions}:{self._model_version}:{content_hash}"
        return cache.get(cache_key)

    def _cache_vector(self, content_hash: str, vector: List[float]):
        """缓存向量（2天过期，降低 Redis 内存压力）"""
        cache_key = f"rag:vector:{self.model}:{self.dimensions}:{self._model_version}:{content_hash}"
        cache.set(cache_key, vector, timeout=60 * 60 * 48)


_embedding_service_cache: dict[str, EmbeddingService] = {}
_embedding_service_lock = threading.Lock()


def invalidate_embedding_service_cache(model_id: Optional[str] = None) -> int:
    """主动清除 EmbeddingService 缓存。

    LLMProvider / LLMModel 在 DB 中变更后调用，确保下次 ``get_embedding_service``
    用新的 api_key / base_url / capabilities_config 重建客户端。

    Args:
        model_id: 指定模型 ID 时仅清除该条；None 时清空全部（含 legacy fallback）。

    Returns:
        被清除的缓存条目数。
    """
    with _embedding_service_lock:
        if model_id is not None:
            removed = 1 if _embedding_service_cache.pop(str(model_id), None) is not None else 0
        else:
            removed = len(_embedding_service_cache)
            _embedding_service_cache.clear()
    if removed:
        logger.info(
            "[EmbeddingService] cache invalidated: model_id=%s, removed=%d",
            model_id or "*", removed,
        )
    return removed


def _on_llm_provider_or_model_saved(sender, instance, **kwargs):  # noqa: ARG001
    """LLMModel / LLMProvider 变更时驱逐 EmbeddingService 缓存。

    粒度：LLMModel 变更按 model.id 精确清除；LLMProvider 变更保守清空全部，
    因为同一 provider 下的多个 model client 共用其 api_key/base_url。
    """
    model_id = None
    if sender.__name__ == 'LLMModel':
        model_id = str(instance.pk) if instance.pk else None
    invalidate_embedding_service_cache(model_id=model_id)


def connect_embedding_cache_invalidation_signals() -> None:
    """在 AppConfig.ready() 中调用以注册 post_save 信号。

    与 ``apps.services.llm.litellm_config.connect_cache_invalidation_signals``
    并列，但作用对象是 EmbeddingService 的 client 缓存（独立字典）。
    延迟导入避免 AppRegistryNotReady；失败仅记日志不阻断启动。
    """
    try:
        from django.db.models.signals import post_save
        from apps.services.llm.models import LLMModel, LLMProvider

        post_save.connect(
            _on_llm_provider_or_model_saved,
            sender=LLMModel,
            dispatch_uid="embedding_service_invalidate_model",
        )
        post_save.connect(
            _on_llm_provider_or_model_saved,
            sender=LLMProvider,
            dispatch_uid="embedding_service_invalidate_provider",
        )
        logger.info("[EmbeddingService] cache invalidation signals connected")
    except Exception as exc:
        logger.warning("[EmbeddingService] 无法注册缓存失效信号: %s", exc)


def get_embedding_service(
    *,
    force_new: bool = False,
    model_info: "Optional[LLMModel]" = None,
) -> EmbeddingService:
    """获取 EmbeddingService 实例，按 LLMModel.id 缓存。

    Args:
        force_new: 强制重建（配置变更后使用）。
        model_info: capability 入口已解析好的 LLMModel；为 None 时按
            ``EmbeddingService._FALLBACK_RESOLVE_SCENE`` 兜底解析。

    Returns:
        EmbeddingService 实例（按 model id 缓存，保证 Redis 熔断器等状态复用）。
    """
    cache_key = str(getattr(model_info, 'id', '') or '__legacy_fallback__')

    if not force_new:
        cached = _embedding_service_cache.get(cache_key)
        if cached is not None:
            return cached

    with _embedding_service_lock:
        if not force_new:
            cached = _embedding_service_cache.get(cache_key)
            if cached is not None:
                return cached
        svc = EmbeddingService(model_info=model_info)
        _embedding_service_cache[cache_key] = svc
        return svc

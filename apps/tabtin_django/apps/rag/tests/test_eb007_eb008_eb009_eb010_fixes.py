"""
EB-007 / EB-008 / EB-009 / EB-010 修复回归测试

EB-007: 无 jitter（随机抖动），多 worker 并发 429 时产生重试风暴
        修复：delay = base * 2^attempt + random.uniform(0, base)

EB-008: 未读取 Retry-After 响应头，忽略 API 指定的冷却时间
        修复：优先从 retry-after / x-ratelimit-reset-requests 头提取冷却时间

EB-009: 双重重试放大：内层 embed 重试 × Celery 任务重试未协调
        修复：新增 raise_on_rate_limit 参数，Celery 外层传 True 时内层 429 直接抛出

EB-010: 无 provider 级熔断器
        修复：Redis 记录连续 429 次数，超阈值设置熔断键，快速失败

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/rag/tests/test_eb007_eb008_eb009_eb010_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import pytest
from unittest.mock import MagicMock, patch, PropertyMock
from apps.rag.services.embedding_service import (
    _parse_duration_to_seconds,
    CircuitBreakerOpenError,
    _CIRCUIT_BREAKER_THRESHOLD,
    _CIRCUIT_BREAKER_OPEN_TTL,
    EMBED_RETRY_BASE_DELAY,
)


# ━━ _parse_duration_to_seconds 辅助函数测试（EB-008 基础） ━━━━━━━━━━━━━━━

class TestParseDurationToSeconds:
    def test_pure_numeric_string(self):
        assert _parse_duration_to_seconds("30") == 30.0

    def test_seconds_only(self):
        assert _parse_duration_to_seconds("30s") == 30.0

    def test_minutes_and_seconds(self):
        assert _parse_duration_to_seconds("1m30s") == 90.0

    def test_hours_minutes_seconds(self):
        assert _parse_duration_to_seconds("1h2m3s") == 3723.0

    def test_minutes_only(self):
        assert _parse_duration_to_seconds("5m") == 300.0

    def test_hours_only(self):
        assert _parse_duration_to_seconds("2h") == 7200.0

    def test_empty_string(self):
        assert _parse_duration_to_seconds("") is None

    def test_invalid_format(self):
        assert _parse_duration_to_seconds("invalid") is None

    def test_float_seconds(self):
        result = _parse_duration_to_seconds("1.5s")
        assert result == pytest.approx(1.5)


# ━━ EB-007: jitter 验证 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestEB007Jitter:
    """验证 _compute_retry_delay 对非 429 错误加入 jitter，多次调用结果不完全相同。"""

    def _make_service(self):
        with patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service"):
            with patch("django.conf.settings") as mock_settings:
                mock_settings.RAG_EMBEDDING_PROVIDER = "openai"
                mock_settings.RAG_EMBEDDING_MODEL = "text-embedding-3-small"
                mock_settings.RAG_EMBEDDING_DIMENSIONS = 1536
                mock_settings.RAG_BATCH_SIZE = 100
                from apps.rag.services.embedding_service import EmbeddingService
                svc = EmbeddingService.__new__(EmbeddingService)
                svc.provider = "openai"
                svc.dimensions = 1536
                return svc

    def test_delay_includes_jitter_non_rate_limit(self):
        """非 429 错误（APIConnectionError）：延迟 = 指数基础 + [0, base] jitter，
        多次采样值不全相同（概率极低会碰巧相同，重复 100 次大概率有差异）。
        """
        svc = self._make_service()
        import openai

        # 用非 429 错误触发 jitter 路径
        conn_err = openai.APIConnectionError(request=MagicMock())
        delays = [svc._compute_retry_delay(conn_err, attempt=0) for _ in range(100)]

        # 最小值应 >= base（attempt=0 时 base=1.0），最大 = base + base = 2.0
        assert all(d >= EMBED_RETRY_BASE_DELAY for d in delays), \
            "延迟不应小于 base delay"
        assert all(d <= EMBED_RETRY_BASE_DELAY * 2 + 0.01 for d in delays), \
            "延迟不应超过 base + jitter_max"
        # 100 次采样至少应有 2 个不同值
        assert len(set(f"{d:.6f}" for d in delays)) > 1, \
            "jitter 应产生随机差异，不能全部相同"

    def test_delay_grows_exponentially_with_jitter(self):
        """不同 attempt 下的基础延迟应指数增长（jitter 范围保持 [0, base]）。"""
        svc = self._make_service()
        import openai

        conn_err = openai.APIConnectionError(request=MagicMock())
        # attempt=0: base=1s，delay 在 [1.0, 2.0]
        # attempt=1: base=2s，delay 在 [2.0, 3.0]
        # attempt=2: base=4s，delay 在 [4.0, 5.0]
        for attempt, (min_d, max_d) in enumerate([(1.0, 2.0), (2.0, 3.0), (4.0, 5.0)]):
            delays = [svc._compute_retry_delay(conn_err, attempt=attempt) for _ in range(20)]
            assert all(min_d <= d <= max_d + 0.01 for d in delays), \
                f"attempt={attempt} 延迟应在 [{min_d}, {max_d}]，实际: {delays}"


# ━━ EB-008: Retry-After 头读取 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestEB008RetryAfterHeader:
    def _make_service(self):
        from apps.rag.services.embedding_service import EmbeddingService
        svc = EmbeddingService.__new__(EmbeddingService)
        svc.provider = "openai"
        return svc

    def _make_rate_limit_error(self, headers: dict):
        """构造携带指定响应头的 RateLimitError mock。"""
        import openai
        mock_response = MagicMock()
        mock_response.headers = headers
        exc = openai.RateLimitError.__new__(openai.RateLimitError)
        exc.response = mock_response
        return exc

    def test_retry_after_header_numeric(self):
        """Retry-After: 30 → 延迟约 30s（加小幅 jitter）。"""
        svc = self._make_service()
        exc = self._make_rate_limit_error({"retry-after": "30"})
        delay = svc._compute_retry_delay(exc, attempt=0)
        assert 30.0 <= delay <= 33.1, f"应基于 Retry-After=30s，实际={delay}"

    def test_retry_after_header_uppercase(self):
        """大写头名 Retry-After 也应被识别。"""
        svc = self._make_service()
        exc = self._make_rate_limit_error({"Retry-After": "15"})
        delay = svc._compute_retry_delay(exc, attempt=0)
        assert 15.0 <= delay <= 16.6, f"应基于 Retry-After=15s，实际={delay}"

    def test_x_ratelimit_reset_requests_duration_format(self):
        """x-ratelimit-reset-requests: 1m30s → 延迟约 90s。"""
        svc = self._make_service()
        exc = self._make_rate_limit_error({"x-ratelimit-reset-requests": "1m30s"})
        delay = svc._compute_retry_delay(exc, attempt=0)
        assert 90.0 <= delay <= 91.1, f"应基于 x-ratelimit=90s，实际={delay}"

    def test_no_retry_after_falls_back_to_exponential(self):
        """无 Retry-After 头时回退到带 jitter 的指数退避。"""
        svc = self._make_service()
        import openai
        exc = openai.RateLimitError.__new__(openai.RateLimitError)
        exc.response = None  # 无响应对象
        delay = svc._compute_retry_delay(exc, attempt=0)
        # attempt=0: base=1s, delay in [1.0, 2.0]
        assert 1.0 <= delay <= 2.01, f"应回退到指数退避，实际={delay}"

    def test_non_rate_limit_error_ignores_headers(self):
        """非 RateLimitError 不尝试读头，直接用指数退避。"""
        svc = self._make_service()
        import openai
        conn_err = openai.APIConnectionError(request=MagicMock())
        delay = svc._compute_retry_delay(conn_err, attempt=1)
        # attempt=1: base=2s, delay in [2.0, 3.0]
        assert 2.0 <= delay <= 3.01, f"非 429 错误应用指数退避，实际={delay}"


# ━━ EB-009: raise_on_rate_limit 协调参数 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestEB009RaiseOnRateLimit:
    """验证 raise_on_rate_limit=True 时内层遇到 429 立即抛出，不消耗内层重试次数。"""

    def _build_service_with_mock_client(self, side_effect):
        """构造一个 EmbeddingService，其 client.embeddings.create 按 side_effect 表现。"""
        with patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service"):
            with patch("django.conf.settings") as mock_settings:
                mock_settings.RAG_EMBEDDING_PROVIDER = "openai"
                mock_settings.RAG_EMBEDDING_MODEL = "text-embedding-3-small"
                mock_settings.RAG_EMBEDDING_DIMENSIONS = 1536
                mock_settings.RAG_BATCH_SIZE = 100
                mock_settings.RAG_DAILY_QUOTA = 0
                mock_settings.RAG_MAX_TOKENS_PER_REQUEST = 8192
                from apps.rag.services.embedding_service import EmbeddingService
                svc = EmbeddingService.__new__(EmbeddingService)
                svc.provider = "openai"
                svc.dimensions = 1536
                svc.batch_size = 100
                svc.model = "text-embedding-3-small"
                svc._model_version = "v1"
                svc.client = MagicMock()
                svc.client.embeddings.create.side_effect = side_effect
                return svc

    def test_raise_on_rate_limit_true_immediately_raises(self):
        """raise_on_rate_limit=True：第一次 429 即抛出，client.create 只调用 1 次。"""
        import openai
        rate_limit_exc = openai.RateLimitError.__new__(openai.RateLimitError)
        rate_limit_exc.response = None
        svc = self._build_service_with_mock_client(side_effect=rate_limit_exc)

        with patch.object(svc, "_check_daily_quota"):
            with patch.object(svc, "_check_circuit_breaker"):
                with patch.object(svc, "_precheck_billing"):
                    with patch.object(svc, "_record_rate_limit_hit"):
                        with patch("apps.rag.utils.calculate_content_hash", return_value="hash123"):
                            with pytest.raises(openai.RateLimitError):
                                svc.embed_text(
                                    "test text",
                                    use_cache=False,
                                    raise_on_rate_limit=True,
                                )
        # 仅调用 1 次，没有内层重试
        assert svc.client.embeddings.create.call_count == 1, \
            "raise_on_rate_limit=True 时不应内层重试"

    def test_raise_on_rate_limit_false_retries_internally(self):
        """raise_on_rate_limit=False（默认）：429 应触发内层重试，最终重试耗尽后抛出。"""
        import openai
        rate_limit_exc = openai.RateLimitError.__new__(openai.RateLimitError)
        rate_limit_exc.response = None
        svc = self._build_service_with_mock_client(side_effect=rate_limit_exc)

        with patch.object(svc, "_check_daily_quota"):
            with patch.object(svc, "_check_circuit_breaker"):
                with patch.object(svc, "_precheck_billing"):
                    with patch.object(svc, "_record_rate_limit_hit"):
                        with patch.object(svc, "_compute_retry_delay", return_value=0.001):
                            with patch("apps.rag.utils.calculate_content_hash", return_value="hash123"):
                                with pytest.raises(openai.RateLimitError):
                                    svc.embed_text(
                                        "test text",
                                        use_cache=False,
                                        raise_on_rate_limit=False,
                                    )
        from apps.rag.services.embedding_service import EMBED_MAX_RETRIES
        # EMBED_MAX_RETRIES=3，总调用 = 初始 1 + 3 重试 = 4
        assert svc.client.embeddings.create.call_count == EMBED_MAX_RETRIES + 1, \
            f"raise_on_rate_limit=False 应内层重试 {EMBED_MAX_RETRIES} 次"


# ━━ EB-010: 熔断器 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestEB010CircuitBreaker:
    """验证 provider 级熔断器核心逻辑（无真实 Redis，全部 mock）。"""

    def _make_service(self, provider="openai"):
        from apps.rag.services.embedding_service import EmbeddingService
        svc = EmbeddingService.__new__(EmbeddingService)
        svc.provider = provider
        return svc

    def test_check_circuit_breaker_open_raises(self):
        """熔断器已打开（Redis 计数 >= 阈值）时，_check_circuit_breaker 应抛出 CircuitBreakerOpenError。"""
        svc = self._make_service()
        mock_redis = MagicMock()
        mock_redis.get.return_value = str(_CIRCUIT_BREAKER_THRESHOLD).encode()
        mock_redis.ttl.return_value = 45

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            with pytest.raises(CircuitBreakerOpenError) as exc_info:
                svc._check_circuit_breaker()
        assert "熔断器已打开" in str(exc_info.value)

    def test_check_circuit_breaker_below_threshold_passes(self):
        """计数未到阈值时，_check_circuit_breaker 不抛出。"""
        svc = self._make_service()
        mock_redis = MagicMock()
        mock_redis.get.return_value = str(_CIRCUIT_BREAKER_THRESHOLD - 1).encode()

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            svc._check_circuit_breaker()  # 不应抛出

    def test_check_circuit_breaker_no_key_passes(self):
        """Redis 中无熔断键时，_check_circuit_breaker 不抛出。"""
        svc = self._make_service()
        mock_redis = MagicMock()
        mock_redis.get.return_value = None

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            svc._check_circuit_breaker()  # 不应抛出

    def test_record_rate_limit_hit_increments_counter(self):
        """_record_rate_limit_hit 应调用 Redis INCR 并设置 TTL。"""
        svc = self._make_service()
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_pipe.execute.return_value = [_CIRCUIT_BREAKER_THRESHOLD - 1]
        mock_redis.pipeline.return_value = mock_pipe

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            svc._record_rate_limit_hit()

        mock_pipe.incr.assert_called_once()
        mock_pipe.expire.assert_called_once()
        _, expire_call_args, _ = mock_pipe.expire.mock_calls[0]
        assert expire_call_args[1] == _CIRCUIT_BREAKER_OPEN_TTL, \
            f"TTL 应为 {_CIRCUIT_BREAKER_OPEN_TTL}s"

    def test_record_rate_limit_hit_logs_warning_at_threshold(self):
        """连续 429 达到阈值时，_record_rate_limit_hit 应记录 WARNING 日志。"""
        svc = self._make_service()
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_pipe.execute.return_value = [_CIRCUIT_BREAKER_THRESHOLD]  # 恰好达到阈值
        mock_redis.pipeline.return_value = mock_pipe

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            with patch("apps.rag.services.embedding_service.logger") as mock_logger:
                svc._record_rate_limit_hit()
        mock_logger.warning.assert_called()
        logged_msg = mock_logger.warning.call_args[0][0]
        assert "熔断器触发" in logged_msg

    def test_reset_circuit_breaker_deletes_key(self):
        """_reset_circuit_breaker 应调用 Redis DELETE 清除熔断键。"""
        svc = self._make_service()
        mock_redis = MagicMock()

        with patch("django_redis.get_redis_connection", return_value=mock_redis):
            svc._reset_circuit_breaker()

        mock_redis.delete.assert_called_once_with(svc._get_circuit_breaker_key())

    def test_circuit_breaker_redis_failure_allows_request(self):
        """Redis 不可用时，熔断器检查应静默失败（允许请求通过，不抛出）。"""
        svc = self._make_service()

        with patch("django_redis.get_redis_connection", side_effect=Exception("Redis down")):
            svc._check_circuit_breaker()  # 不应抛出

    def test_circuit_breaker_key_includes_provider(self):
        """不同 provider 应有独立的熔断键，互不影响。"""
        openai_svc = self._make_service(provider="openai")
        qwen_svc = self._make_service(provider="qwen")
        assert openai_svc._get_circuit_breaker_key() != qwen_svc._get_circuit_breaker_key(), \
            "不同 provider 应有独立熔断键"
        assert "openai" in openai_svc._get_circuit_breaker_key()
        assert "qwen" in qwen_svc._get_circuit_breaker_key()


# ━━ 集成验证：embed_text 成功后重置熔断器 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestEB010CircuitBreakerReset:
    """验证请求成功后熔断器计数被清除（_reset_circuit_breaker 被调用）。"""

    def test_successful_embed_resets_circuit_breaker(self):
        """embed_text 成功时应调用 _reset_circuit_breaker。"""
        import openai

        with patch("apps.rag.services.embedding_service.EmbeddingService._init_llm_service"):
            from apps.rag.services.embedding_service import EmbeddingService
            svc = EmbeddingService.__new__(EmbeddingService)
            svc.provider = "openai"
            svc.dimensions = 3
            svc.batch_size = 100
            svc.model = "text-embedding-3-small"
            svc._model_version = "v1"

        mock_response = MagicMock()
        mock_emb = MagicMock()
        mock_emb.embedding = [0.1, 0.2, 0.3]
        mock_response.data = [mock_emb]
        mock_response.usage = MagicMock(total_tokens=10, prompt_tokens=10)
        svc.client = MagicMock()
        svc.client.embeddings.create.return_value = mock_response

        with patch.object(svc, "_check_daily_quota"):
            with patch.object(svc, "_check_circuit_breaker"):
                with patch.object(svc, "_precheck_billing"):
                    with patch.object(svc, "_reset_circuit_breaker") as mock_reset:
                        with patch.object(svc, "_charge_embedding_usage"):
                            with patch.object(svc, "_record_usage_from_response"):
                                with patch.object(svc, "_cache_vector"):
                                    with patch("apps.rag.utils.calculate_content_hash", return_value="hash123"):
                                        svc.embed_text("test text", use_cache=False)

        mock_reset.assert_called_once(), "成功请求后应重置熔断器"

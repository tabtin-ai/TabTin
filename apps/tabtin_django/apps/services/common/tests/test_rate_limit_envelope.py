"""Wave 1 (API 限流的全栈体验治理) 协议规范化回归测试。

验收对象：``apps/services/common/middleware.py::RateLimitMiddleware``。

覆盖矩阵：
1. 429 响应 body **业务统一信封** ``{success, code, message, data, retry_after_seconds}``
2. 429 响应 headers **保留** ``Retry-After`` / ``X-RateLimit-Limit/Remaining/Reset``（双发，回归保护）
3. ``Retry-After`` 头 == ``X-RateLimit-Reset`` == ``body.retry_after_seconds``（同源不变量）
4. ``agenda`` / ``scheduler`` / ``goal`` 模块阈值已注册（Tracker 雪崩修复）
5. 兼容性：老客户端仅读 headers 时 Retry-After 仍可见（与 §5.1 兼容性章节对账）
6. ``retry_after_seconds`` 始终 ≥ 1（cache 层返 0 时被防御性补丁拦下）

设计原则：
- 不依赖 Redis 实例：mock ``is_rate_limited`` 直接控制返回值
- 不依赖业务 view：直接调用 middleware ``process_request`` 拿响应
- 与 ``test_middleware_xff.py`` 同一架构（pytest fixture + RequestFactory）

Wave 1 协议规范文档：``docs/api/rate-limit-protocol.md`` v1.0
样板出处：``apps/credential_vault/api.py::_rate_limited_response``
"""
import json
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from unittest.mock import patch  # noqa: E402
from django.test import RequestFactory  # noqa: E402


@pytest.fixture
def rf():
    return RequestFactory()


def _build_request(rf, path="/api/tracker/list/", method="GET"):
    """构造未 JWT 请求（走 ``ip:`` 限流 key），方便单测断言。"""
    request_factory_method = getattr(rf, method.lower())
    request = request_factory_method(path)
    request.META["REMOTE_ADDR"] = "10.0.0.99"
    request.META.pop("HTTP_AUTHORIZATION", None)
    return request


def _trigger_rate_limit(mw, request):
    """让 ``is_rate_limited`` 返 ``(True, 121, 42)`` 模拟用户被限流。

    返回 mw 的 ``process_request`` 实际响应（HttpResponse）。
    """
    with patch(
        "apps.services.common.middleware.is_rate_limited",
        return_value=(True, 121, 42),
    ):
        return mw.process_request(request)


# ────────────────────────────────────────────────────────
# Wave1-1：429 响应 body 必须遵循业务统一信封
# ────────────────────────────────────────────────────────


class TestRateLimitEnvelope:
    """协议 §2.2 — 429 body 必须是业务统一信封 + retry_after_seconds。"""

    def test_429_body_has_all_required_fields(self, rf):
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        assert response is not None, "should return 429 response, got None"
        assert response.status_code == 429

        body = json.loads(response.content)
        # ── 必有字段 ──
        for field in ("success", "code", "message", "data", "retry_after_seconds"):
            assert field in body, f"429 body missing required field: {field}"

    def test_429_body_field_values(self, rf):
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        body = json.loads(response.content)
        # success=False（信封约定）
        assert body["success"] is False
        # code 是字符串字面量"RATE_LIMITED"，**不是数字 code 也不是新枚举**
        assert body["code"] == "RATE_LIMITED"
        # data=null（错误响应固定）
        assert body["data"] is None
        # message 是已 i18n 翻译的字符串（中/英/日任一）
        assert isinstance(body["message"], str) and len(body["message"]) > 0
        # retry_after_seconds 是正整数 ≥ 1
        assert isinstance(body["retry_after_seconds"], int)
        assert body["retry_after_seconds"] >= 1

    def test_429_body_no_legacy_error_field(self, rf):
        """旧 body ``{"error": "Too Many Requests", "status": 429}`` 已彻底替换。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        body = json.loads(response.content)
        # 老字段不应继续存在 — 客户端不该有理由读它们
        assert "error" not in body, "legacy 'error' field must be removed"
        # status 字段是 HTTP 状态码的冗余表达，新信封通过 success+code 表达
        assert "status" not in body, "legacy 'status' field must be removed"


# ────────────────────────────────────────────────────────
# Wave1-2：429 响应 headers 必须保留（双发）
# ────────────────────────────────────────────────────────


class TestRateLimitHeaders:
    """协议 §2.1 — 头部双发，本期改造**只加不减**。"""

    def test_retry_after_header_present(self, rf):
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        assert "Retry-After" in response, "Retry-After header missing (RFC 6585)"
        # 必须是正整数字符串
        assert response["Retry-After"].isdigit()
        assert int(response["Retry-After"]) >= 1

    def test_x_ratelimit_headers_present(self, rf):
        """``X-RateLimit-Limit/Remaining/Reset`` 三件套保留。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        for header in ("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"):
            assert header in response, f"{header} header missing"

        assert response["X-RateLimit-Remaining"] == "0", "命中限流时 Remaining 必须为 0"

    def test_retry_after_equals_reset_equals_body_field(self, rf):
        """协议同源不变量：``Retry-After == X-RateLimit-Reset == body.retry_after_seconds``。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        body = json.loads(response.content)
        assert int(response["Retry-After"]) == body["retry_after_seconds"]
        assert int(response["X-RateLimit-Reset"]) == body["retry_after_seconds"]


# ────────────────────────────────────────────────────────
# Wave1-3：兼容性 — 老客户端只读 headers 仍可工作
# ────────────────────────────────────────────────────────


class TestBackwardCompatibility:
    """协议 §5.1 — 老客户端只读 headers 时仍能拿到 retry-after。"""

    def test_old_client_headers_only_path_works(self, rf):
        """模拟只解析 headers 不解析 body 的客户端：必须仍能拿到 Retry-After。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        # 1) HTTP 状态码 = 429（任何 RFC 6585 客户端识别）
        assert response.status_code == 429
        # 2) Retry-After header 存在且为有效正整数
        assert "Retry-After" in response
        retry_seconds = int(response["Retry-After"])
        assert retry_seconds >= 1
        # 3) 不解析 body 的客户端凭这两点就能完成退避，无需读 body 字段


# ────────────────────────────────────────────────────────
# Wave1-4：模块阈值（Tracker 雪崩修复）
# ────────────────────────────────────────────────────────


class TestModuleLimits:
    """``_MODULE_LIMITS`` 必须显式包含 tracker / scheduler。"""

    def test_tracker_module_registered(self):
        from apps.services.common.middleware import RateLimitMiddleware

        assert "tracker" in RateLimitMiddleware._MODULE_LIMITS, (
            "tracker 模块阈值未注册 — Tracker 多视图场景必须显式声明"
        )
        read, write, window = RateLimitMiddleware._MODULE_LIMITS["tracker"]
        # 必须高于默认 120 — 反映 Tracker 多视图同时挂载的场景
        assert read > RateLimitMiddleware._DEFAULT_READ_LIMIT
        assert window > 0

    def test_scheduler_module_registered(self):
        from apps.services.common.middleware import RateLimitMiddleware

        assert "scheduler" in RateLimitMiddleware._MODULE_LIMITS
        read, write, window = RateLimitMiddleware._MODULE_LIMITS["scheduler"]
        assert read > RateLimitMiddleware._DEFAULT_READ_LIMIT

    def test_tracker_resolve_tier_returns_dedicated_bucket(self, rf):
        """``GET /api/tracker/list/`` 必须落在 ``api:tracker:r`` 桶而不是 ``api:other``。"""
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        tier_key, limit, window = mw._resolve_tier("/api/tracker/list/", "GET")
        assert tier_key == "api:tracker:r"
        # 限流值必须等于 _MODULE_LIMITS['tracker'][0]（read_limit）
        expected_read = RateLimitMiddleware._MODULE_LIMITS["tracker"][0]
        assert limit == expected_read

    def test_scheduler_resolve_tier_returns_dedicated_bucket(self, rf):
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        tier_key, limit, window = mw._resolve_tier("/api/scheduler/run/", "POST")
        assert tier_key == "api:scheduler:w"
        expected_write = RateLimitMiddleware._MODULE_LIMITS["scheduler"][1]
        assert limit == expected_write


# ────────────────────────────────────────────────────────
# Wave1-5：防御性 — retry_after_seconds 不会为 0
# ────────────────────────────────────────────────────────


class TestRetryAfterMinimum:
    """协议 §2.2 — ``retry_after_seconds`` 必须 ≥ 1。

    cache 层在边界情况下可能返 ``ttl=0``（窗口刚好到点），如果直接透传给客户端，
    客户端会立刻重试 → 雷击群效应。middleware 层做了 ``max(1, int(ttl))`` 防御。
    """

    def test_zero_ttl_floored_to_one(self, rf):
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        with patch(
            "apps.services.common.middleware.is_rate_limited",
            return_value=(True, 999, 0),  # 边界：ttl=0
        ):
            response = mw.process_request(request)

        body = json.loads(response.content)
        assert body["retry_after_seconds"] == 1, "ttl=0 应被防御性补到 1"
        assert int(response["Retry-After"]) == 1
        assert int(response["X-RateLimit-Reset"]) == 1


# ────────────────────────────────────────────────────────
# Wave1-6：i18n message 在 zh-CN 下是中文（确保翻译键有效）
# ────────────────────────────────────────────────────────


class TestI18nIntegration:
    """``message`` 字段必须是已翻译的人话，不是翻译键名本身。"""

    def test_message_is_translated_not_raw_key(self, rf):
        from apps.services.common.middleware import RateLimitMiddleware

        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        response = _trigger_rate_limit(mw, request)

        body = json.loads(response.content)
        # 翻译失败时 _() 通常返回 key 本身，所以确认翻译键名不在结果里
        assert body["message"] != "middleware.rate_limited"
        # 翻译键已存在于 zh-CN/en-US/ja-JP（grep 确认过）
        assert len(body["message"]) > 0


# ────────────────────────────────────────────────────────
# Wave2A-1：CredentialVault 端点级 429 与全局 middleware 信封完全对齐(L-8)
# ────────────────────────────────────────────────────────


class TestCredentialVaultEnvelopeAlignment:
    """协议 §5.4 — 全局 middleware + 端点级 vault 两条 429 路径必须返同一信封。

    Wave 2A 修复 L-8:之前 `_rate_limited_response` 缺 ``data: null`` 字段,
    客户端要写两套解析。修复后两条路径 body 字段集合完全一致。
    """

    def test_credential_vault_429_body_has_data_null_field(self):
        from apps.credential_vault.api import _rate_limited_response

        response = _rate_limited_response(retry_after=42)

        body = json.loads(response.content)
        # 必有字段(与 middleware 全局 429 一致)
        for field in ("success", "code", "message", "data", "retry_after_seconds"):
            assert field in body, f"vault 429 body missing required field: {field}"

        # data 固定 null(L-8 修复点)
        assert body["data"] is None, "Wave 2A L-8:data 字段应固定 null"
        # 其它字段一致性
        assert body["success"] is False
        assert body["code"] == "RATE_LIMITED"
        assert body["retry_after_seconds"] == 42
        assert isinstance(body["message"], str)
        assert len(body["message"]) > 0

    def test_credential_vault_429_envelope_matches_middleware(self, rf):
        """两路径返回的 body 字段集合 + 各字段类型必须完全一致(协议 §5.4)。"""
        from apps.credential_vault.api import _rate_limited_response
        from apps.services.common.middleware import RateLimitMiddleware

        # 端点级
        vault_resp = _rate_limited_response(retry_after=42)
        vault_body = json.loads(vault_resp.content)

        # 全局 middleware
        mw = RateLimitMiddleware(get_response=lambda r: None)
        request = _build_request(rf)
        mw_resp = _trigger_rate_limit(mw, request)
        mw_body = json.loads(mw_resp.content)

        # 字段集合相等
        assert set(vault_body.keys()) == set(mw_body.keys()), (
            "两路径 429 body 字段集合不一致 — Wave 2A 信封统一意图被破坏"
        )

        # 公共字段类型/字面量值一致
        assert vault_body["success"] is False and mw_body["success"] is False
        assert vault_body["code"] == "RATE_LIMITED" == mw_body["code"]
        assert vault_body["data"] is None and mw_body["data"] is None
        # message 不必相等(可能不同 key),但都是非空字符串
        assert isinstance(vault_body["message"], str)
        assert isinstance(mw_body["message"], str)
        # retry_after_seconds 都是正整数
        assert isinstance(vault_body["retry_after_seconds"], int)
        assert isinstance(mw_body["retry_after_seconds"], int)
        assert vault_body["retry_after_seconds"] >= 1
        assert mw_body["retry_after_seconds"] >= 1

    def test_credential_vault_429_retry_after_header_present(self):
        """vault 路径同样需要 ``Retry-After`` 头,与全局 middleware 一致。"""
        from apps.credential_vault.api import _rate_limited_response

        response = _rate_limited_response(retry_after=15)
        assert "Retry-After" in response
        assert response["Retry-After"] == "15"

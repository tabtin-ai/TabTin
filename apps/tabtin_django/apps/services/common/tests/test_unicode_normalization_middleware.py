"""
UnicodeNormalizationMiddleware 测试

覆盖：
- JSON 请求体中的字符串值被 NFC 规范化
- 检测到不可见字符时有 warning 日志
- 检测到 BiDi 控制字符时有 warning 日志
- 非 JSON 请求不受影响
- 大请求体被跳过
- 文件上传不受影响
- 配置开关 UNICODE_NORMALIZATION_ENABLED 生效
- 同形字检测函数 detect_homoglyphs 基本行为
"""

import io
import json
import os
import sys
import unicodedata

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import logging  # noqa: E402
import pytest  # noqa: E402
from unittest.mock import patch, call  # noqa: E402
from django.test import RequestFactory  # noqa: E402
from django.http import HttpResponse  # noqa: E402


@pytest.fixture
def rf():
    return RequestFactory()


def _dummy_response(request):
    return HttpResponse("ok")


def _make_json_request(rf, data: dict, method="POST", path="/api/test/"):
    """构造 JSON 请求。"""
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    request = getattr(rf, method.lower())(
        path,
        data=body,
        content_type="application/json",
    )
    return request


# ────────────────────────────────────────────────────────
# NFC 规范化
# ────────────────────────────────────────────────────────


class TestNFCNormalization:

    def test_nfd_string_normalized_to_nfc(self, rf):
        """NFD 形式的字符串应被规范化为 NFC。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        # é 的 NFD 形式：U+0065 U+0301（'e' + combining acute）
        nfd_text = unicodedata.normalize("NFD", "café")
        assert nfd_text != unicodedata.normalize("NFC", "café")

        request = _make_json_request(rf, {"name": nfd_text})
        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        result = json.loads(request.body)
        assert result["name"] == unicodedata.normalize("NFC", "café")

    def test_already_nfc_unchanged(self, rf):
        """已是 NFC 形式的文本不应被修改。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        nfc_text = unicodedata.normalize("NFC", "café")
        request = _make_json_request(rf, {"name": nfc_text})
        original_body = request.body

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        # body 不应被替换（没有变化时不触发重写）
        assert request.body == original_body

    def test_nested_object_normalization(self, rf):
        """嵌套对象中的字符串也应被规范化。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        nfd = unicodedata.normalize("NFD", "naïve")
        data = {"user": {"bio": nfd, "tags": [nfd, "normal"]}}

        request = _make_json_request(rf, data)
        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        result = json.loads(request.body)
        expected = unicodedata.normalize("NFC", "naïve")
        assert result["user"]["bio"] == expected
        assert result["user"]["tags"][0] == expected
        assert result["user"]["tags"][1] == "normal"

    def test_non_string_values_preserved(self, rf):
        """数字、布尔值、null 等非字符串值应保持不变。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        data = {"count": 42, "active": True, "value": None, "items": [1, 2, 3]}
        request = _make_json_request(rf, data)
        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        result = json.loads(request.body)
        assert result == data


# ────────────────────────────────────────────────────────
# 不可见字符检测
# ────────────────────────────────────────────────────────


class TestInvisibleCharDetection:

    def test_invisible_chars_logged_as_warning(self, rf):
        """请求体中包含不可见字符时应记录 warning 日志。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        text_with_zwsp = "hello\u200Bworld"
        request = _make_json_request(rf, {"message": text_with_zwsp})

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        with patch("apps.services.common.middleware.logger") as mock_logger:
            mock_logger.debug = lambda *a, **kw: None
            mw(request)
            warning_calls = mock_logger.warning.call_args_list
            assert any("不可见字符" in str(c) for c in warning_calls)

    def test_clean_text_no_warning(self, rf):
        """正常文本不应触发 warning 日志。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        request = _make_json_request(rf, {"message": "hello world 你好"})

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        with patch("apps.services.common.middleware.logger") as mock_logger:
            mock_logger.debug = lambda *a, **kw: None
            mw(request)
            warning_calls = mock_logger.warning.call_args_list
            assert not any("不可见字符" in str(c) for c in warning_calls)


# ────────────────────────────────────────────────────────
# BiDi 控制字符检测
# ────────────────────────────────────────────────────────


class TestBidiDetection:

    def test_bidi_chars_logged_as_warning(self, rf):
        """请求体中包含 BiDi 控制字符时应记录 warning 日志。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        text_with_bidi = "hello\u202Eworld"  # Right-to-Left Override
        request = _make_json_request(rf, {"filename": text_with_bidi})

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        with patch("apps.services.common.middleware.logger") as mock_logger:
            mock_logger.debug = lambda *a, **kw: None
            mw(request)
            warning_calls = mock_logger.warning.call_args_list
            assert any("BiDi" in str(c) for c in warning_calls)


# ────────────────────────────────────────────────────────
# 跳过条件
# ────────────────────────────────────────────────────────


class TestSkipConditions:

    def test_non_json_request_untouched(self, rf):
        """非 JSON 请求（如表单提交）不应被处理。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        request = rf.post(
            "/api/test/",
            data="name=test",
            content_type="application/x-www-form-urlencoded",
        )
        original_body = request.body

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        assert request.body == original_body

    def test_multipart_upload_untouched(self, rf):
        """文件上传请求（multipart/form-data）不应被处理。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        request = rf.post(
            "/api/upload/",
            data={"file": io.BytesIO(b"file content")},
            format="multipart",
        )

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        response = mw(request)

        assert response.status_code == 200

    def test_large_body_skipped(self, rf):
        """超过 1MB 的请求体应被跳过。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        nfd_text = unicodedata.normalize("NFD", "café")
        request = _make_json_request(rf, {"text": nfd_text})
        request.META["CONTENT_LENGTH"] = str(2 * 1024 * 1024)  # 2MB

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        # body 未被规范化（仍含 NFD 字符）
        result = json.loads(request.body)
        assert result["text"] == nfd_text

    def test_empty_body_no_error(self, rf):
        """空请求体不应报错。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        request = rf.post(
            "/api/test/",
            data=b"",
            content_type="application/json",
        )

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        response = mw(request)
        assert response.status_code == 200

    def test_invalid_json_no_error(self, rf):
        """非法 JSON 不应阻断请求。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        request = rf.post(
            "/api/test/",
            data=b"{invalid json",
            content_type="application/json",
        )

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        response = mw(request)
        assert response.status_code == 200


# ────────────────────────────────────────────────────────
# 配置开关
# ────────────────────────────────────────────────────────


class TestConfigSwitch:

    def test_disabled_skips_processing(self, rf):
        """UNICODE_NORMALIZATION_ENABLED=False 时跳过处理。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        nfd_text = unicodedata.normalize("NFD", "café")
        request = _make_json_request(rf, {"name": nfd_text})

        with patch("django.conf.settings.UNICODE_NORMALIZATION_ENABLED", False):
            mw = UnicodeNormalizationMiddleware(_dummy_response)
            mw(request)

        result = json.loads(request.body)
        assert result["name"] == nfd_text  # 未被规范化


# ────────────────────────────────────────────────────────
# 中间件不阻断请求
# ────────────────────────────────────────────────────────


class TestNoBlockingBehavior:

    def test_invisible_chars_not_cleaned(self, rf):
        """中间件只检测记录，不清理不可见字符——清理是业务层的责任。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        text_with_zwsp = "hello\u200Bworld"
        request = _make_json_request(rf, {"msg": text_with_zwsp})

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        mw(request)

        result = json.loads(request.body)
        assert "\u200B" in result["msg"]

    def test_response_always_returned(self, rf):
        """无论检测到什么，请求都不会被拒绝。"""
        from apps.services.common.middleware import UnicodeNormalizationMiddleware

        evil_text = "\u200B\u200C\u200D\u202E\uFEFF"
        request = _make_json_request(rf, {"payload": evil_text})

        mw = UnicodeNormalizationMiddleware(_dummy_response)
        response = mw(request)
        assert response.status_code == 200


# ────────────────────────────────────────────────────────
# detect_homoglyphs
# ────────────────────────────────────────────────────────


class TestDetectHomoglyphs:

    def test_pure_latin_no_detection(self):
        from apps.services.common.unicode_security import detect_homoglyphs
        assert detect_homoglyphs("hello world") == []

    def test_pure_cyrillic_no_detection(self):
        from apps.services.common.unicode_security import detect_homoglyphs
        # 纯西里尔文本
        assert detect_homoglyphs("Привет мир") == []

    def test_mixed_latin_cyrillic_detected(self):
        """混合 Latin 和 Cyrillic 应被检测为高风险。"""
        from apps.services.common.unicode_security import detect_homoglyphs
        # 'а' (U+0430 Cyrillic) 在视觉上与 'a' (U+0061 Latin) 相同
        mixed = "pаypal"  # p(Latin) а(Cyrillic) y(Latin) p(Latin) a(Latin) l(Latin)
        results = detect_homoglyphs(mixed)
        assert len(results) == 1
        assert results[0]["risk"] == "high"
        assert "LATIN" in results[0]["scripts"]
        assert "CYRILLIC" in results[0]["scripts"]

    def test_mixed_latin_greek_detected(self):
        """混合 Latin 和 Greek 应被检测。"""
        from apps.services.common.unicode_security import detect_homoglyphs
        # 'ο' (U+03BF Greek) 在视觉上与 'o' (U+006F Latin) 相似
        mixed = "gοogle"  # g(Latin) ο(Greek) o(Latin) g(Latin) l(Latin) e(Latin)
        results = detect_homoglyphs(mixed)
        assert len(results) == 1
        assert "GREEK" in results[0]["scripts"]

    def test_cjk_with_latin_no_detection(self):
        """CJK + Latin 混合不应触发告警（这是正常的中英混排）。"""
        from apps.services.common.unicode_security import detect_homoglyphs
        assert detect_homoglyphs("Hello 你好世界") == []

    def test_empty_string(self):
        from apps.services.common.unicode_security import detect_homoglyphs
        assert detect_homoglyphs("") == []

    def test_pure_ascii(self):
        from apps.services.common.unicode_security import detect_homoglyphs
        assert detect_homoglyphs("abc123!@#") == []


# ────────────────────────────────────────────────────────
# detect_bidi_controls
# ────────────────────────────────────────────────────────


class TestDetectBidiControls:

    def test_no_bidi(self):
        from apps.services.common.unicode_security import detect_bidi_controls
        assert detect_bidi_controls("hello world") == []

    def test_detect_rlo(self):
        """检测 Right-to-Left Override (U+202E)。"""
        from apps.services.common.unicode_security import detect_bidi_controls
        text = "test\u202Eevil.exe"
        results = detect_bidi_controls(text)
        assert len(results) == 1
        assert results[0][1] == 4  # 位置

    def test_detect_multiple_bidi(self):
        from apps.services.common.unicode_security import detect_bidi_controls
        text = "\u200Ehello\u200F"
        results = detect_bidi_controls(text)
        assert len(results) == 2

    def test_empty_string(self):
        from apps.services.common.unicode_security import detect_bidi_controls
        assert detect_bidi_controls("") == []

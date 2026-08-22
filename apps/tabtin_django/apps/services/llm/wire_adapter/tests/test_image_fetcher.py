"""W1b · image_fetcher 单测(Redis L2 + 并发下载升级版)。

覆盖:
- _infer_media_type:Content-Type 优先 / URL 后缀 fallback / 兜底 jpeg
- fetch_image_to_data_url:成功 / http_error / timeout / network_error / oversize
- normalize_image_urls:并发下载多图成功 / 部分失败聚合 / max_count 上限
- L1 内存 LRU + L2 Redis cache(走 Django cache,locmem backend 单测可用)
- data URL 透传不下载
"""

from __future__ import annotations

import base64
from unittest.mock import MagicMock, patch

import httpx
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from apps.services.llm.wire_adapter import (
    DEFAULT_MAX_COUNT_PER_REQUEST,
    DEFAULT_MAX_SIZE_BYTES,
    ImageFetchError,
    fetch_image_to_data_url,
    normalize_image_urls,
)
from apps.services.llm.wire_adapter import image_fetcher as ifmod
from apps.services.llm.wire_adapter.image_fetcher import (
    _infer_media_type,
    _is_trusted_local_oss_url,
    rewrite_local_oss_images,
)

_TEST_ALLOWED_HOSTS = {
    "example.com",
    "oss.example.com",
    "slow.example.com",
    "broken.example.com",
    "e1.com",
    "e2.com",
    "e3.com",
}


def _resp(status: int = 200, body: bytes = b"\xff\xd8\xff", content_type: str = "image/jpeg"):
    """构造 httpx.Response mock。"""
    mock = MagicMock(spec=httpx.Response)
    mock.status_code = status
    mock.content = body
    mock.headers = {"content-type": content_type}
    return mock


class InferMediaTypeTests(SimpleTestCase):
    """_infer_media_type:Content-Type 优先 / URL 后缀 fallback / 兜底。

    覆盖产品场景:某些 OSS/CDN 不返回 Content-Type 时,按 URL 后缀回填 mime,
    避免 image/jpeg 兜底导致 picky provider(如 MiniMax)拒收 png 图。
    """

    def test_content_type_header_priority(self):
        # Content-Type 有效 → 优先返回(忽略 URL 后缀)
        self.assertEqual(_infer_media_type("https://x/y.jpg", "image/png"), "image/png")
        # 含 charset 也能正确解析
        self.assertEqual(
            _infer_media_type("https://x/y.jpg", "image/png; charset=utf-8"),
            "image/png",
        )

    def test_url_suffix_fallback_when_no_content_type(self):
        # Content-Type 为空 → 按 URL 后缀推
        self.assertEqual(_infer_media_type("https://x/y.png", ""), "image/png")
        # 大小写不敏感
        self.assertEqual(_infer_media_type("https://x/y.JPG", ""), "image/jpeg")
        self.assertEqual(_infer_media_type("https://x/y.webp", ""), "image/webp")
        self.assertEqual(_infer_media_type("https://x/y.heic", ""), "image/heic")

    def test_unknown_falls_back_to_jpeg(self):
        # 既无 Content-Type 又无可识别后缀 → image/jpeg 兜底(覆盖率最高)
        self.assertEqual(_infer_media_type("https://x/y.xyz", ""), "image/jpeg")
        # Content-Type 不是 image/* → 按后缀走;没匹配上 → jpeg
        self.assertEqual(_infer_media_type("https://x/y.xyz", "text/html"), "image/jpeg")
        # Content-Type 不是 image/* 但 URL 后缀有效 → 用后缀的 mime
        self.assertEqual(_infer_media_type("https://x/y.png", "text/html"), "image/png")


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "wire-adapter-image-fetcher-tests",
    }
})
class FetchImageToDataUrlTests(SimpleTestCase):
    """单图下载 + L1 + L2 cache 行为。"""

    def setUp(self):
        ifmod._l1_clear()
        cache.clear()
        self.resolve_patcher = patch.object(
            ifmod,
            "_resolve_host_ips",
            return_value=["93.184.216.34"],
        )
        self.resolve_patcher.start()
        self.addCleanup(self.resolve_patcher.stop)
        self.allowed_hosts_patcher = patch.object(
            ifmod,
            "_allowed_fetch_hosts",
            return_value=set(_TEST_ALLOWED_HOSTS),
        )
        self.allowed_hosts_patcher.start()
        self.addCleanup(self.allowed_hosts_patcher.stop)

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_success_returns_data_url(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"hello", "image/png")

        url = "https://example.com/test1.png"
        data_url = fetch_image_to_data_url(url)

        self.assertTrue(data_url.startswith("data:image/png;base64,"))
        self.assertIn(base64.b64encode(b"hello").decode("ascii"), data_url)

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_5xx_raises_http_error(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(503, b"")

        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url("https://oss.example.com/img.jpg")
        self.assertEqual(cm.exception.reason, "http_error")
        self.assertEqual(cm.exception.status, 503)
        self.assertEqual(cm.exception.host, "oss.example.com")

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_timeout_raises_timeout(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.side_effect = httpx.ReadTimeout("boom")

        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url("https://slow.example.com/img.jpg")
        self.assertEqual(cm.exception.reason, "timeout")

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_network_error(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.side_effect = httpx.NetworkError("conn reset")

        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url("https://broken.example.com/img.jpg")
        self.assertEqual(cm.exception.reason, "network_error")

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_oversize_raises(self, MockClient):
        big_body = b"x" * 10
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, big_body, "image/png")

        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url(
                "https://example.com/big.png",
                max_size_bytes=5,  # 故意限制更小
            )
        self.assertEqual(cm.exception.reason, "oversize")

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_l1_memory_cache_hit(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"data", "image/jpeg")

        url = "https://example.com/cached.jpg"
        d1 = fetch_image_to_data_url(url)
        d2 = fetch_image_to_data_url(url)

        self.assertEqual(d1, d2)
        # 第二次应直接命中 L1,不再调 httpx
        self.assertEqual(client_inst.get.call_count, 1)

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_l2_redis_cache_hit_after_l1_eviction(self, MockClient):
        """L1 清空后 L2 仍命中,无需 httpx 二次。"""
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"data2", "image/png")

        url = "https://example.com/cached2.png"
        d1 = fetch_image_to_data_url(url)
        # 模拟内存 cache 被驱逐(进程重启等场景)
        ifmod._l1_clear()
        d2 = fetch_image_to_data_url(url)

        self.assertEqual(d1, d2)
        # 第二次走 L2(Redis),不再调 httpx
        self.assertEqual(client_inst.get.call_count, 1)

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_url_suffix_fallback_when_content_type_missing(self, MockClient):
        """上游不返回 Content-Type 时按 URL 后缀推 mime(MiniMax 兼容性场景)。"""
        client_inst = MockClient.return_value.__enter__.return_value
        # 模拟某些 OSS 不返回 Content-Type 的场景
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.content = b"PNGDATA"
        resp.headers = {}  # 无 Content-Type
        client_inst.get.return_value = resp

        data_url = fetch_image_to_data_url("https://oss.example.com/avatar.png")
        # 应按 URL 后缀 .png 推 image/png,而不是兜底 image/jpeg
        self.assertTrue(data_url.startswith("data:image/png;base64,"))

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_redis_unavailable_no_break(self, MockClient):
        """Redis backend 异常不能阻断请求,走原始下载。

        通过 patch django.core.cache.cache 让 get/set 抛异常,验证 _l2_get /
        _l2_put 内部的 try/except 不让异常逃逸。
        """
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"data3", "image/png")

        # 模拟 Redis backend 抛异常(djangocache 路径全部失败)
        broken_cache = MagicMock()
        broken_cache.get.side_effect = Exception("redis down")
        broken_cache.set.side_effect = Exception("redis down")

        with patch("django.core.cache.cache", broken_cache):
            url = "https://example.com/redisdown.png"
            d = fetch_image_to_data_url(url)
            self.assertTrue(d.startswith("data:image/png;base64,"))

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_loopback_ip_is_rejected_before_http_request(self, MockClient):
        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url("http://127.0.0.1/admin.png")

        self.assertEqual(cm.exception.reason, "forbidden_url")
        MockClient.assert_not_called()

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_cloud_metadata_ip_is_rejected_before_http_request(self, MockClient):
        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url("http://169.254.169.254/latest/meta-data/iam.png")

        self.assertEqual(cm.exception.reason, "forbidden_url")
        MockClient.assert_not_called()

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_hostname_resolving_to_private_ip_is_rejected(self, MockClient):
        with patch.object(ifmod, "_allowed_fetch_hosts", return_value={"images.example.internal"}), patch.object(
            ifmod,
            "_resolve_host_ips",
            return_value=["10.0.0.8"],
        ):
            with self.assertRaises(ImageFetchError) as cm:
                fetch_image_to_data_url("https://images.example.internal/a.png")

        self.assertEqual(cm.exception.reason, "forbidden_url")
        MockClient.assert_not_called()

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_untrusted_hostname_is_rejected_before_dns_or_http(self, MockClient):
        with patch.object(ifmod, "_resolve_host_ips") as mock_resolve:
            with self.assertRaises(ImageFetchError) as cm:
                fetch_image_to_data_url("https://attacker.example.net/a.png")

        self.assertEqual(cm.exception.reason, "forbidden_url")
        mock_resolve.assert_not_called()
        MockClient.assert_not_called()

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_redirect_to_private_ip_is_rejected(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        resp = _resp(200, b"hello", "image/png")
        resp.url = "http://127.0.0.1/redirected.png"
        client_inst.get.return_value = resp

        with self.assertRaises(ImageFetchError) as cm:
            fetch_image_to_data_url("https://example.com/public.png")

        self.assertEqual(cm.exception.reason, "forbidden_url")


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "wire-adapter-image-fetcher-multi-tests",
    }
})
class NormalizeImageUrlsTests(SimpleTestCase):
    """多图并发下载 + messages 替换。"""

    def setUp(self):
        ifmod._l1_clear()
        cache.clear()
        self.resolve_patcher = patch.object(
            ifmod,
            "_resolve_host_ips",
            return_value=["93.184.216.34"],
        )
        self.resolve_patcher.start()
        self.addCleanup(self.resolve_patcher.stop)
        self.allowed_hosts_patcher = patch.object(
            ifmod,
            "_allowed_fetch_hosts",
            return_value=set(_TEST_ALLOWED_HOSTS),
        )
        self.allowed_hosts_patcher.start()
        self.addCleanup(self.allowed_hosts_patcher.stop)

    def test_no_image_messages_passthrough(self):
        msgs = [{"role": "user", "content": "hello"}]
        out = normalize_image_urls(msgs)
        self.assertEqual(out, msgs)

    def test_data_url_passthrough_no_download(self):
        msgs = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}
            ],
        }]
        with patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client") as MC:
            out = normalize_image_urls(msgs)
            MC.assert_not_called()
        # data URL 不进入下载列表 → messages 透传
        self.assertEqual(
            out[0]["content"][0]["image_url"]["url"],
            "data:image/png;base64,AAA",
        )

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_concurrent_download_multi_images_success(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"x", "image/png")

        msgs = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "hi"},
                {"type": "image_url", "image_url": {"url": "https://e1.com/a.png"}},
                {"type": "image_url", "image_url": {"url": "https://e2.com/b.png"}},
                {"type": "image_url", "image_url": {"url": "https://e3.com/c.png"}},
            ],
        }]
        out = normalize_image_urls(msgs)

        # 三张图都被替换为 data URL
        for part in out[0]["content"][1:]:
            self.assertTrue(part["image_url"]["url"].startswith("data:image/png;base64,"))

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_partial_failure_aggregates(self, MockClient):
        """3 张图,1 张 404 → 抛 ImageFetchError(failed=1, total=3)。"""
        client_inst = MockClient.return_value.__enter__.return_value

        def _side(url):
            if "missing" in url:
                return _resp(404, b"")
            return _resp(200, b"x", "image/png")

        client_inst.get.side_effect = _side

        msgs = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "https://e1.com/a.png"}},
                {"type": "image_url", "image_url": {"url": "https://e2.com/missing.png"}},
                {"type": "image_url", "image_url": {"url": "https://e3.com/c.png"}},
            ],
        }]
        with self.assertRaises(ImageFetchError) as cm:
            normalize_image_urls(msgs)
        # 失败聚合:total=3, failed=1, 优先级 http_error 占优
        self.assertEqual(cm.exception.total_count, 3)
        self.assertEqual(cm.exception.failed_count, 1)
        self.assertEqual(cm.exception.reason, "http_error")

    def test_too_many_images_capped(self):
        msgs = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"https://e{i}.com/x.png"}}
                for i in range(20)
            ],
        }]
        with self.assertRaises(ImageFetchError) as cm:
            normalize_image_urls(msgs, max_count_per_request=5)
        self.assertEqual(cm.exception.reason, "too_many_images")
        self.assertEqual(cm.exception.total_count, 20)

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_input_messages_not_mutated(self, MockClient):
        """normalize_image_urls 必须深拷贝 messages,不能改 input."""
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"x", "image/png")

        original_url = "https://e1.com/a.png"
        msgs = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": original_url}},
            ],
        }]
        out = normalize_image_urls(msgs)

        # input 仍是原 URL
        self.assertEqual(msgs[0]["content"][0]["image_url"]["url"], original_url)
        # output 已替换
        self.assertTrue(out[0]["content"][0]["image_url"]["url"].startswith("data:"))

    def test_default_caps_constants_exposed(self):
        # 防 W1b 升级时常量名意外改动
        self.assertEqual(DEFAULT_MAX_SIZE_BYTES, 5 * 1024 * 1024)
        self.assertEqual(DEFAULT_MAX_COUNT_PER_REQUEST, 8)

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_oversize_image_attribution(self, MockClient):
        """单图过大时 ImageFetchError(reason='oversize') + 模板渲染."""
        from apps.services.llm.wire_adapter import render_error
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"x" * 1000, "image/png")

        msgs = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "https://e1.com/big.png"}},
            ],
        }]
        with self.assertRaises(ImageFetchError) as cm:
            normalize_image_urls(msgs, max_size_bytes=500)
        # 验证 reason='oversize' + render_error 命中专属模板
        user_msg, _ = render_error(
            "image_fetch", "image", cm.exception.reason,
            host=cm.exception.host,
            total_count=cm.exception.total_count,
            failed_count=cm.exception.failed_count,
        )
        self.assertIn("图片体积过大", user_msg)
        self.assertIn("压缩图片", user_msg)

    def test_too_many_images_attribution(self):
        from apps.services.llm.wire_adapter import render_error
        msgs = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"https://e{i}.com/x.png"}}
                for i in range(10)
            ],
        }]
        with self.assertRaises(ImageFetchError) as cm:
            normalize_image_urls(msgs, max_count_per_request=3)
        user_msg, _ = render_error(
            "image_fetch", "image", cm.exception.reason,
            host=cm.exception.host,
            total_count=cm.exception.total_count,
            failed_count=cm.exception.failed_count,
        )
        # ：必须写出上限本身（3），不能让用户把「超额 7」误读成上限
        self.assertIn("包含 10 张图片", user_msg)
        self.assertIn("超过单次上限 3 张", user_msg)
        self.assertIn("减少到 3 张以内", user_msg)
        self.assertIn("分多次发送", user_msg)
        # 旧歧义句式不应再出现
        self.assertNotIn("张超过单次上限", user_msg)


@override_settings(SERVICES_OSS_PROVIDER="local")
class LocalOssDirectReadTests(SimpleTestCase):
    """#5648 · 本机 dev OSS 图片直读转 base64(不发 loopback HTTP、不碰 SSRF)。"""

    LOCAL_URL = "http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png"

    def _mock_oss(self, content: bytes = b"\x89PNG\r\n\x1a\n", content_type: str = "image/png"):
        svc = MagicMock()
        svc.download_file.return_value = {
            "success": True,
            "data": {"content": content, "content_type": content_type},
        }
        return patch("apps.services.oss.services.factory.get_oss_service", return_value=svc)

    def test_is_trusted_local_oss_url(self):
        self.assertTrue(_is_trusted_local_oss_url(self.LOCAL_URL))
        self.assertTrue(_is_trusted_local_oss_url(
            "http://localhost:6060/api/services/oss/local-object?object_key=x"))
        # 反：非 OSS 路径 / 公网 host 不算受信本机 OSS
        self.assertFalse(_is_trusted_local_oss_url("http://127.0.0.1:9999/tmp/x.png"))
        self.assertFalse(_is_trusted_local_oss_url("https://cdn.example.com/api/services/oss/x"))

    def test_fetch_local_oss_short_circuits_to_direct_read(self):
        with self._mock_oss(content=b"AAAA", content_type="image/png") as m:
            data_url = fetch_image_to_data_url(self.LOCAL_URL)
        self.assertTrue(data_url.startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(data_url.split(",", 1)[1]), b"AAAA")
        m.return_value.download_file.assert_called_once_with("chat/a.png")

    def test_fetch_local_oss_oversize_raises(self):
        with self._mock_oss(content=b"X" * 2048):
            with self.assertRaises(ImageFetchError) as cm:
                fetch_image_to_data_url(self.LOCAL_URL, max_size_bytes=1024)
        self.assertEqual(cm.exception.reason, "oversize")

    def test_rewrite_local_oss_images_converts_only_local(self):
        msgs = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "hi"},
                {"type": "image_url", "image_url": {"url": self.LOCAL_URL}},
                {"type": "image_url", "image_url": {"url": "https://cdn.example.com/pub.png"}},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
        }]
        with self._mock_oss(content=b"BBBB"):
            out = rewrite_local_oss_images(msgs)
        parts = out[0]["content"]
        # 本机 OSS → data:；公网 URL / data: 原样保留；原 messages 不被 mutate
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(parts[2]["image_url"]["url"], "https://cdn.example.com/pub.png")
        self.assertEqual(parts[3]["image_url"]["url"], "data:image/png;base64,AAAA")
        self.assertEqual(msgs[0]["content"][1]["image_url"]["url"], self.LOCAL_URL)

    @override_settings(SERVICES_OSS_PROVIDER="aliyun")
    def test_rewrite_noop_when_provider_not_local(self):
        msgs = [{
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": self.LOCAL_URL}}],
        }]
        out = rewrite_local_oss_images(msgs)
        # provider 非 local:原样返回同一对象,不改写
        self.assertIs(out, msgs)

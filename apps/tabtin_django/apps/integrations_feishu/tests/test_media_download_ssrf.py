"""download_media / tmp_url SSRF 与超大响应防护回归。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.integrations_feishu.client import FeishuAPIError, FeishuClient
from apps.integrations_feishu.constants import MAX_ATTACHMENT_BYTES
from apps.integrations_feishu.media_url_security import (
    FeishuMediaURLError,
    download_feishu_media_url,
    is_allowed_feishu_media_hostname,
    looks_like_feishu_media_url,
    stream_read_response,
    validate_feishu_media_url,
)
from apps.integrations_feishu.feishu_images import _looks_like_feishu_image_ref


class HostnameAllowlistTests(SimpleTestCase):
    def test_exact_and_subdomain_allowed(self):
        self.assertTrue(is_allowed_feishu_media_hostname("feishu.cn"))
        self.assertTrue(is_allowed_feishu_media_hostname("internal-api-drive-stream.feishu.cn"))
        self.assertTrue(is_allowed_feishu_media_hostname("cdn.feishucdn.com"))
        self.assertTrue(is_allowed_feishu_media_hostname("open.larksuite.com"))

    def test_suffix_spoof_and_ip_rejected(self):
        self.assertFalse(is_allowed_feishu_media_hostname("feishu.cn.evil.com"))
        self.assertFalse(is_allowed_feishu_media_hostname("evilfeishu.cn"))
        self.assertFalse(is_allowed_feishu_media_hostname("127.0.0.1"))
        self.assertFalse(is_allowed_feishu_media_hostname("192.168.1.1"))
        self.assertFalse(is_allowed_feishu_media_hostname("example.com"))


class ValidateFeishuMediaURLTests(SimpleTestCase):
    @patch("apps.integrations_feishu.media_url_security.resolve_and_validate")
    def test_valid_https_feishu_url(self, mock_resolve):
        mock_resolve.return_value = MagicMock()
        url = "https://internal-api-drive-stream.feishu.cn/file/boxcnXXX"
        self.assertEqual(validate_feishu_media_url(url), url)
        mock_resolve.assert_called_once()

    def test_http_rejected(self):
        with self.assertRaises(FeishuMediaURLError):
            validate_feishu_media_url("http://feishu.cn/a")

    def test_userinfo_bypass_rejected(self):
        with self.assertRaises(FeishuMediaURLError):
            validate_feishu_media_url("https://feishu.cn@127.0.0.1/a")
        with self.assertRaises(FeishuMediaURLError):
            validate_feishu_media_url("https://example-user:example-password@feishu.cn/a")

    def test_nonstandard_port_rejected(self):
        with self.assertRaises(FeishuMediaURLError):
            validate_feishu_media_url("https://feishu.cn:8443/a")

    def test_spoof_suffix_rejected_without_dns(self):
        with self.assertRaises(FeishuMediaURLError):
            validate_feishu_media_url("https://feishu.cn.attacker.com/a")

    @patch("apps.integrations_feishu.media_url_security.resolve_and_validate")
    def test_private_dns_rejected(self, mock_resolve):
        mock_resolve.side_effect = ValueError("目标地址属于受限网段")
        with self.assertRaises(FeishuMediaURLError):
            validate_feishu_media_url("https://internal-api-drive-stream.feishu.cn/x")


class _FakeRequestsResp:
    def __init__(self, chunks, *, status_code=200, is_redirect=False, headers=None):
        self._chunks = chunks
        self.status_code = status_code
        self.is_redirect = is_redirect
        self.headers = headers or {}
        self.closed = False

    def iter_content(self, chunk_size=64 * 1024):  # noqa: ARG002
        return iter(self._chunks)

    def close(self):
        self.closed = True


class _FakeHttpxResp:
    def __init__(self, chunks, *, status_code=200):
        self._chunks = chunks
        self.status_code = status_code

    def iter_bytes(self):
        return iter(self._chunks)


class StreamReadLimitTests(SimpleTestCase):
    def test_stream_stops_over_limit(self):
        resp = _FakeRequestsResp([b"a" * 100, b"b" * 100, b"c" * 100])
        with self.assertRaises(FeishuMediaURLError):
            stream_read_response(resp, max_bytes=150)
        self.assertTrue(resp.closed)


class DownloadFeishuMediaURLTests(SimpleTestCase):
    @patch("apps.integrations_feishu.media_url_security.ssrf_safe_request")
    @patch("apps.integrations_feishu.media_url_security.resolve_and_validate")
    def test_happy_path(self, mock_resolve, mock_req):
        mock_resolve.return_value = MagicMock()
        mock_req.return_value = _FakeRequestsResp([b"img-bytes"])
        data = download_feishu_media_url(
            "https://cdn.feishucdn.com/a.png",
            max_bytes=1024,
        )
        self.assertEqual(data, b"img-bytes")

    @patch("apps.integrations_feishu.media_url_security.ssrf_safe_request")
    @patch("apps.integrations_feishu.media_url_security.resolve_and_validate")
    def test_redirect_revalidated_each_hop(self, mock_resolve, mock_req):
        mock_resolve.return_value = MagicMock()
        mock_req.return_value = _FakeRequestsResp(
            [], status_code=302, is_redirect=True,
            headers={"Location": "https://evil.example.com/x"},
        )
        with self.assertRaises(FeishuMediaURLError):
            download_feishu_media_url(
                "https://cdn.feishucdn.com/a.png",
                max_bytes=1024,
            )
        self.assertGreaterEqual(mock_req.call_count, 1)

    @patch("apps.integrations_feishu.media_url_security.ssrf_safe_request")
    @patch("apps.integrations_feishu.media_url_security.resolve_and_validate")
    def test_redirect_to_allowed_host_then_ok(self, mock_resolve, mock_req):
        mock_resolve.return_value = MagicMock()
        redirect = _FakeRequestsResp(
            [], status_code=302, is_redirect=True,
            headers={
                "Location": "https://internal-api-drive-stream.feishu.cn/final",
            },
        )
        final = _FakeRequestsResp([b"ok"])
        mock_req.side_effect = [redirect, final]
        data = download_feishu_media_url(
            "https://cdn.feishucdn.com/a.png",
            max_bytes=1024,
        )
        self.assertEqual(data, b"ok")
        self.assertEqual(mock_req.call_count, 2)


class DownloadMediaClientTests(SimpleTestCase):
    @patch.object(FeishuClient, "_client")
    def test_prefers_file_token_official_api(self, mock_client_factory):
        resp = _FakeHttpxResp([b"from-api"])
        stream_cm = MagicMock()
        stream_cm.__enter__.return_value = resp
        stream_cm.__exit__.return_value = False
        client = MagicMock()
        client.stream.return_value = stream_cm
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        mock_client_factory.return_value = client

        out = FeishuClient(api_base="https://open.feishu.cn").download_media(
            "atok",
            "filetok",
            tmp_url="https://127.0.0.1/evil",
        )
        self.assertEqual(out, b"from-api")
        client.stream.assert_called_once()
        args, _kwargs = client.stream.call_args
        self.assertEqual(args[0], "GET")
        self.assertIn("/medias/filetok/download", args[1])

    @patch("apps.integrations_feishu.media_url_security.download_feishu_media_url")
    def test_tmp_url_only_when_no_file_token(self, mock_dl):
        mock_dl.return_value = b"cdn"
        out = FeishuClient().download_media(
            "atok",
            "",
            tmp_url="https://cdn.feishucdn.com/a.png",
        )
        self.assertEqual(out, b"cdn")
        mock_dl.assert_called_once()

    @patch("apps.integrations_feishu.media_url_security.ssrf_safe_request")
    def test_malicious_tmp_url_without_token_sends_no_request(self, mock_req):
        with self.assertRaises(FeishuAPIError):
            FeishuClient().download_media(
                "atok",
                "",
                tmp_url="https://127.0.0.1/steal",
            )
        mock_req.assert_not_called()

    @patch("apps.integrations_feishu.media_url_security.ssrf_safe_request")
    def test_spoof_hostname_without_token_sends_no_request(self, mock_req):
        with self.assertRaises(FeishuAPIError):
            FeishuClient().download_media(
                "atok",
                "",
                tmp_url="https://feishu.cn.evil.com/x",
            )
        mock_req.assert_not_called()

    @patch.object(FeishuClient, "_client")
    def test_official_api_enforces_size_limit(self, mock_client_factory):
        resp = _FakeHttpxResp([b"x" * (MAX_ATTACHMENT_BYTES + 1)])
        stream_cm = MagicMock()
        stream_cm.__enter__.return_value = resp
        stream_cm.__exit__.return_value = False
        client = MagicMock()
        client.stream.return_value = stream_cm
        client.__enter__.return_value = client
        client.__exit__.return_value = False
        mock_client_factory.return_value = client

        with self.assertRaises(FeishuAPIError):
            FeishuClient(api_base="https://open.feishu.cn").download_media(
                "atok", "filetok",
            )


class ImageRefAllowlistTests(SimpleTestCase):
    def test_token_still_accepted(self):
        self.assertTrue(_looks_like_feishu_image_ref("boxcnABCDEF123456"))

    def test_substring_spoof_rejected(self):
        self.assertFalse(
            _looks_like_feishu_image_ref("https://evil.com/feishu.cn/steal"),
        )
        self.assertFalse(looks_like_feishu_media_url("https://evil.com/?q=feishu.cn"))

    def test_real_feishu_https_accepted(self):
        self.assertTrue(
            _looks_like_feishu_image_ref(
                "https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/xxx",
            ),
        )

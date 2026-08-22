"""W1b · request_adapter.adapt_request + 8 个 _normalize_* 单测。

测试覆盖矩阵(每 helper ≥ 3 case):
- _normalize_images:capability gate / 透传 url / 下载替换 base64
- _normalize_system:OpenAI 透传 / Anthropic 顶层 hoist / unsupported drop / qwq strip
- _normalize_tool_definitions:OpenAI 透传 / Anthropic 改名 input_schema / drop tools
- _normalize_tool_choice:required → any / specific dict 降级 / auto 透传
- _normalize_parallel_tool_calls:Qwen 默认关注入 / Anthropic 反向 / 用户显式
- _normalize_cache_control:strip / 保留 / 幂等
- _normalize_json_mode:json_schema 降级 prompt / output_config 改名 / 透传
- _normalize_reasoning_param:hidden drop / Claude budget / Moonshot delta drop
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
from django.test import SimpleTestCase, override_settings

from apps.services.llm.wire_adapter import (
    CapabilityGateError,
    ResolvedCapabilities,
    adapt_request,
)
from apps.services.llm.wire_adapter.request_adapter import (
    _normalize_cache_control,
    _normalize_documents,
    _normalize_parallel_tool_calls,
    _normalize_images,
    _normalize_json_mode,
    _normalize_reasoning_param,
    _normalize_system,
    _normalize_tool_choice,
    _normalize_tool_definitions,
    _normalize_videos,
)
from apps.services.llm.wire_adapter.resolved_capabilities import (
    CachingCaps,
    DocumentCaps,
    ImageCaps,
    JsonModeCaps,
    MediaFilesApiCaps,
    ReasoningCaps,
    ToolCaps,
    VideoCaps,
    VideoFilesApiCaps,
    WireFormatCaps,
)


def _ctx(model_name: str = "test-model"):
    """构造极简 ProxyContext 替身。"""
    obj = MagicMock()
    obj.model_name = model_name
    obj.request_id = "req-test-1"
    return obj


def _resp(status: int = 200, body: bytes = b"\xff", content_type: str = "image/jpeg"):
    mock = MagicMock(spec=httpx.Response)
    mock.status_code = status
    mock.content = body
    mock.headers = {"content-type": content_type}
    return mock


# ---------------------------------------------------------------------------
# 1. _normalize_images
# ---------------------------------------------------------------------------

@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ra-test-images",
    }
})
class NormalizeImagesTests(SimpleTestCase):

    def setUp(self):
        from apps.services.llm.wire_adapter import image_fetcher as ifmod
        from django.core.cache import cache
        ifmod._l1_clear()
        cache.clear()

    def test_no_image_passthrough(self):
        caps = ResolvedCapabilities()  # 默认 image disabled,但无图也 OK
        body = {"messages": [{"role": "user", "content": "hi"}]}
        out = _normalize_images(body, caps, _ctx())
        self.assertIs(out["messages"], body["messages"])

    def test_capability_gate_reject_when_image_disabled(self):
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=False)
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://e.com/a.png"}}
                ],
            }],
        }
        with self.assertRaises(CapabilityGateError) as cm:
            _normalize_images(body, caps, _ctx())
        self.assertEqual(cm.exception.error_code, "image_not_supported")
        self.assertIn("不支持图片输入", cm.exception.user_message)

    def test_url_passthrough_when_caps_accepts_url(self):
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=True, input_via=("base64", "url"))
        url = "https://e.com/a.png"
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": url}}
                ],
            }],
        }
        with patch(
            "apps.services.llm.wire_adapter.image_fetcher.httpx.Client",
        ) as MC:
            out = _normalize_images(body, caps, _ctx())
            MC.assert_not_called()
        # URL 保持不变(无下载)
        self.assertEqual(out["messages"][0]["content"][0]["image_url"]["url"], url)

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_oss_inline_base64_when_upload_mode_default(self):
        """upload_mode=inline_base64（默认）：本机 OSS 直读转 base64；公网 URL 透传。"""
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(
            enabled=True,
            input_via=("base64", "url"),
            upload_mode="inline_base64",
        )
        local_url = "http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png"
        pub_url = "https://cdn.example.com/pub.png"
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": local_url}},
                    {"type": "image_url", "image_url": {"url": pub_url}},
                ],
            }],
        }
        svc = MagicMock()
        svc.download_file.return_value = {
            "success": True,
            "data": {"content": b"AAAA", "content_type": "image/png"},
        }
        with patch("apps.services.oss.services.factory.get_oss_service", return_value=svc), \
                patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client") as MC:
            out = _normalize_images(body, caps, _ctx())
            MC.assert_not_called()
        parts = out["messages"][0]["content"]
        self.assertTrue(parts[0]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(parts[1]["image_url"]["url"], pub_url)

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_oss_skipped_when_upload_mode_none(self):
        """upload_mode=none：不主动改写本机 URL（由 provider 显式关闭）。"""
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(
            enabled=True,
            input_via=("base64", "url"),
            upload_mode="none",
        )
        local_url = "http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png"
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": local_url}},
                ],
            }],
        }
        with patch("apps.services.oss.services.factory.get_oss_service") as oss_mock:
            out = _normalize_images(body, caps, _ctx())
            oss_mock.assert_not_called()
        self.assertEqual(
            out["messages"][0]["content"][0]["image_url"]["url"],
            local_url,
        )

    @override_settings(SERVICES_OSS_PROVIDER="local")
    def test_local_oss_files_api_upload_mode(self):
        """upload_mode=files_api：本机图 → Files API → url_scheme 引用。"""
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(
            enabled=True,
            input_via=("base64", "file_id"),
            upload_mode="files_api",
            files_api=VideoFilesApiCaps(
                endpoint="/files",
                purpose="file-extract",
                url_scheme="ms://",
            ),
            native_url_prefixes=("ms://", "data:image/"),
        )
        local_url = "http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png"
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": local_url}},
                ],
            }],
        }
        ctx = _ctx("kimi-k2.6")
        ctx.api_base = "https://api.moonshot.cn/v1"
        ctx.api_key = "sk-test"
        svc = MagicMock()
        svc.download_file.return_value = {
            "success": True,
            "data": {"content": b"AAAA", "content_type": "image/png"},
        }
        with patch("apps.services.oss.services.factory.get_oss_service", return_value=svc), \
                patch(
                    "apps.services.llm.wire_adapter.provider_media_upload.upload_media_bytes",
                    return_value="file-img-1",
                ) as upload_mock:
            out = _normalize_images(body, caps, ctx)
        self.assertEqual(
            out["messages"][0]["content"][0]["image_url"]["url"],
            "ms://file-img-1",
        )
        upload_mock.assert_called_once()

    @patch("apps.services.llm.wire_adapter.image_fetcher.httpx.Client")
    def test_download_when_caps_only_base64(self, MockClient):
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _resp(200, b"x", "image/png")

        caps = ResolvedCapabilities()
        caps.image = ImageCaps(
            enabled=True,
            input_via=("base64",),
            upload_mode="none",
        )
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://e.com/a.png"}}
                ],
            }],
        }
        with patch(
            "apps.services.llm.wire_adapter.image_fetcher._allowed_fetch_hosts",
            return_value={"e.com"},
        ), patch(
            "apps.services.llm.wire_adapter.image_fetcher._resolve_host_ips",
            return_value=["93.184.216.34"],
        ):
            out = _normalize_images(body, caps, _ctx())
        self.assertTrue(
            out["messages"][0]["content"][0]["image_url"]["url"].startswith(
                "data:image/png;base64,",
            )
        )


# ---------------------------------------------------------------------------
# 1b. _normalize_videos
# ---------------------------------------------------------------------------

class NormalizeVideosTests(SimpleTestCase):

    def test_no_video_passthrough(self):
        caps = ResolvedCapabilities()
        body = {"messages": [{"role": "user", "content": "hi"}]}
        out = _normalize_videos(body, caps, _ctx())
        self.assertIs(out["messages"], body["messages"])

    def test_capability_gate_reject_when_video_disabled(self):
        caps = ResolvedCapabilities()
        caps.video = VideoCaps(enabled=False)
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": "https://e.com/a.mp4"}}
                ],
            }],
        }
        with self.assertRaises(CapabilityGateError) as cm:
            _normalize_videos(body, caps, _ctx())
        self.assertEqual(cm.exception.error_code, "video_not_supported")
        self.assertIn("不支持视频输入", cm.exception.user_message)

    def test_url_passthrough_when_caps_accepts_url(self):
        caps = ResolvedCapabilities()
        caps.video = VideoCaps(enabled=True, input_via=("url",))
        url = "https://e.com/a.mp4"
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": url}}
                ],
            }],
        }
        out = _normalize_videos(body, caps, _ctx())
        self.assertEqual(out["messages"][0]["content"][0]["video_url"]["url"], url)

    def test_files_api_upload_mode_rewrites_local_url(self):
        """upload_mode=files_api：本机 URL → Files API → url_scheme 引用。"""
        from apps.services.llm.wire_adapter.video_media_resolver import VideoBytes

        caps = ResolvedCapabilities()
        caps.video = VideoCaps(
            enabled=True,
            input_via=("url", "file_id"),
            upload_mode="files_api",
            files_api=VideoFilesApiCaps(
                endpoint="/files",
                purpose="video",
                url_scheme="ms://",
            ),
            native_url_prefixes=("ms://", "data:video/"),
        )
        local_url = (
            "http://127.0.0.1:6060/api/services/oss/local-object"
            "?object_key=chat%2Fattachments%2Fdemo.mov"
        )
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": local_url}},
                    {"type": "text", "text": "描述视频"},
                ],
            }],
        }
        ctx = _ctx("kimi-k2.6")
        ctx.api_base = "https://api.moonshot.cn/v1"
        ctx.api_key = "sk-test"

        with patch(
            "apps.services.llm.wire_adapter.video_media_resolver.resolve_video_bytes",
            return_value=VideoBytes(
                content=b"\x00\x00\x00\x14ftypqt  ",
                filename="demo.mov",
                mime_type="video/quicktime",
            ),
        ), patch(
            "apps.services.llm.wire_adapter.provider_media_upload.upload_media_bytes",
            return_value="file-abc123",
        ) as upload_mock:
            out = _normalize_videos(body, caps, ctx)

        self.assertEqual(
            out["messages"][0]["content"][0]["video_url"]["url"],
            "ms://file-abc123",
        )
        self.assertEqual(out["messages"][0]["content"][1]["text"], "描述视频")
        upload_mock.assert_called_once()
        self.assertEqual(upload_mock.call_args.kwargs["purpose"], "video")

    def test_native_scheme_passthrough_skips_upload(self):
        caps = ResolvedCapabilities()
        caps.video = VideoCaps(
            enabled=True,
            input_via=("url", "file_id"),
            upload_mode="files_api",
            files_api=VideoFilesApiCaps(url_scheme="ms://"),
            native_url_prefixes=("ms://", "data:video/"),
        )
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": "ms://already-there"}},
                ],
            }],
        }
        ctx = _ctx("kimi-k2.6")
        ctx.api_base = "https://api.moonshot.cn/v1"
        ctx.api_key = "sk-test"

        with patch(
            "apps.services.llm.wire_adapter.provider_media_upload.upload_media_bytes",
        ) as upload_mock:
            out = _normalize_videos(body, caps, ctx)

        self.assertEqual(
            out["messages"][0]["content"][0]["video_url"]["url"],
            "ms://already-there",
        )
        upload_mock.assert_not_called()

    def test_inline_base64_upload_mode(self):
        from apps.services.llm.wire_adapter.video_media_resolver import VideoBytes

        caps = ResolvedCapabilities()
        caps.video = VideoCaps(
            enabled=True,
            input_via=("url", "base64"),
            upload_mode="inline_base64",
        )
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "video_url", "video_url": {"url": "http://127.0.0.1/x.mp4"}},
                ],
            }],
        }
        with patch(
            "apps.services.llm.wire_adapter.video_media_resolver.resolve_video_bytes",
            return_value=VideoBytes(
                content=b"abc",
                filename="x.mp4",
                mime_type="video/mp4",
            ),
        ):
            out = _normalize_videos(body, caps, _ctx())

        url = out["messages"][0]["content"][0]["video_url"]["url"]
        self.assertTrue(url.startswith("data:video/mp4;base64,"))


# ---------------------------------------------------------------------------
# 1c. _normalize_documents
# ---------------------------------------------------------------------------

class NormalizeDocumentsTests(SimpleTestCase):

    def test_no_file_passthrough(self):
        caps = ResolvedCapabilities()
        body = {"messages": [{"role": "user", "content": "hi"}]}
        out = _normalize_documents(body, caps, _ctx())
        self.assertIs(out["messages"], body["messages"])

    def test_capability_gate_reject_when_document_disabled(self):
        caps = ResolvedCapabilities()
        caps.document = DocumentCaps(enabled=False)
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {
                        "type": "file",
                        "file_url": {"url": "http://127.0.0.1:6060/api/services/oss/local-object?object_key=a.pdf"},
                        "file_name": "a.pdf",
                    },
                ],
            }],
        }
        with self.assertRaises(CapabilityGateError) as cm:
            _normalize_documents(body, caps, _ctx())
        self.assertEqual(cm.exception.error_code, "document_not_supported")
        self.assertIn("不支持文档附件", cm.exception.user_message)

    def test_rejects_when_document_count_exceeds_model_limit(self):
        caps = ResolvedCapabilities()
        caps.document = DocumentCaps(enabled=True, upload_mode="none")
        caps.limits.max_documents_per_request = 1
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "file", "file_url": {"url": "https://test/a.pdf"}},
                    {"type": "file", "file_url": {"url": "https://test/b.pdf"}},
                ],
            }],
        }

        with self.assertRaises(CapabilityGateError) as cm:
            _normalize_documents(body, caps, _ctx())

        self.assertEqual(cm.exception.error_code, "too_many_documents")
        self.assertIn("最多上传 1 个文档", cm.exception.user_message)

    def test_file_extract_injects_system_and_strips_file_part(self):
        from apps.services.llm.wire_adapter.document_media_resolver import DocumentBytes

        caps = ResolvedCapabilities()
        caps.document = DocumentCaps(
            enabled=True,
            upload_mode="file_extract",
            files_api=MediaFilesApiCaps(
                endpoint="/files",
                purpose="file-extract",
                url_scheme="ms://",
            ),
        )
        local_url = (
            "http://127.0.0.1:6060/api/services/oss/local-object"
            "?object_key=chat%2Fattachments%2Fdemo.pdf"
        )
        body = {
            "messages": [
                {"role": "system", "content": "you are helpful"},
                {
                    "role": "user",
                    "content": [
                        {"type": "file", "file_url": {"url": local_url}, "file_name": "demo.pdf"},
                        {"type": "text", "text": "摘要一下"},
                    ],
                },
            ],
        }
        ctx = _ctx("kimi-k2.6")
        ctx.api_base = "https://api.moonshot.cn/v1"
        ctx.api_key = "sk-test"

        with patch(
            "apps.services.llm.wire_adapter.document_media_resolver.resolve_document_bytes",
            return_value=DocumentBytes(
                content=b"%PDF-1.1 TABTIN6945NATIVEFEED",
                filename="demo.pdf",
                mime_type="application/pdf",
            ),
        ), patch(
            "apps.services.llm.wire_adapter.provider_media_upload.extract_document_text_via_files_api",
            return_value="TABTIN6945NATIVEFEED extracted",
        ) as extract_mock:
            out = _normalize_documents(body, caps, ctx)

        msgs = out["messages"]
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[0]["content"], "TABTIN6945NATIVEFEED extracted")
        self.assertEqual(msgs[1]["role"], "system")
        self.assertEqual(msgs[1]["content"], "you are helpful")
        self.assertEqual(msgs[2]["role"], "user")
        self.assertEqual(msgs[2]["content"], "摘要一下")
        extract_mock.assert_called_once()
        self.assertEqual(extract_mock.call_args.kwargs["purpose"], "file-extract")

    def test_file_extract_attachment_only_user_gets_placeholder(self):
        """#7299：仅附件无正文时 user 不得为空，否则 Kimi 拒收。"""
        from apps.services.llm.wire_adapter.document_media_resolver import DocumentBytes

        caps = ResolvedCapabilities()
        caps.document = DocumentCaps(
            enabled=True,
            upload_mode="file_extract",
            files_api=MediaFilesApiCaps(
                endpoint="/files",
                purpose="file-extract",
                url_scheme="ms://",
            ),
        )
        local_url = (
            "http://127.0.0.1:6060/api/services/oss/local-object"
            "?object_key=chat%2Fattachments%2Fdemo.pdf"
        )
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "file", "file_url": {"url": local_url}, "file_name": "demo.pdf"},
                ],
            }],
        }
        ctx = _ctx("kimi-k2.5")
        ctx.api_base = "https://api.moonshot.cn/v1"
        ctx.api_key = "sk-test"

        with patch(
            "apps.services.llm.wire_adapter.document_media_resolver.resolve_document_bytes",
            return_value=DocumentBytes(
                content=b"%PDF-1.1 content",
                filename="demo.pdf",
                mime_type="application/pdf",
            ),
        ), patch(
            "apps.services.llm.wire_adapter.provider_media_upload.extract_document_text_via_files_api",
            return_value="extracted body",
        ):
            out = _normalize_documents(body, caps, ctx)

        msgs = out["messages"]
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[0]["content"], "extracted body")
        self.assertEqual(msgs[1]["role"], "user")
        self.assertEqual(msgs[1]["content"], "查看这个文件")

    def test_file_extract_dedupes_same_url_in_one_request(self):
        from apps.services.llm.wire_adapter.document_media_resolver import DocumentBytes

        caps = ResolvedCapabilities()
        caps.document = DocumentCaps(
            enabled=True,
            upload_mode="file_extract",
            files_api=MediaFilesApiCaps(purpose="file-extract"),
        )
        url = "data:application/pdf;base64,QUFB"
        body = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "file", "file_url": {"url": url}},
                        {"type": "text", "text": "q1"},
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "file", "file_url": {"url": url}},
                        {"type": "text", "text": "q2"},
                    ],
                },
            ],
        }
        ctx = _ctx("kimi-k2.6")
        ctx.api_base = "https://api.moonshot.cn/v1"
        ctx.api_key = "sk-test"

        with patch(
            "apps.services.llm.wire_adapter.document_media_resolver.resolve_document_bytes",
            return_value=DocumentBytes(content=b"AAA", filename="a.pdf", mime_type="application/pdf"),
        ) as resolve_mock, patch(
            "apps.services.llm.wire_adapter.provider_media_upload.extract_document_text_via_files_api",
            return_value="doc-text",
        ) as extract_mock:
            out = _normalize_documents(body, caps, ctx)

        self.assertEqual(resolve_mock.call_count, 1)
        self.assertEqual(extract_mock.call_count, 1)
        self.assertEqual(out["messages"][0]["content"], "doc-text")
        # 两个 user 的 file part 都剥掉，只留下一条 inject system
        self.assertEqual(sum(1 for m in out["messages"] if m["role"] == "system"), 1)


# ---------------------------------------------------------------------------
# 2. _normalize_system
# ---------------------------------------------------------------------------

class NormalizeSystemTests(SimpleTestCase):

    def test_openai_style_passthrough(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(system_message_style="messages_first_role_system")
        body = {
            "messages": [
                {"role": "system", "content": "you are helpful"},
                {"role": "user", "content": "hi"},
            ],
        }
        out = _normalize_system(body, caps, _ctx())
        self.assertEqual(out["messages"][0]["role"], "system")
        self.assertNotIn("system", out)

    def test_anthropic_top_level_hoist(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(system_message_style="top_level_system_field")
        body = {
            "messages": [
                {"role": "system", "content": "be concise"},
                {"role": "user", "content": "hi"},
            ],
        }
        out = _normalize_system(body, caps, _ctx())
        self.assertEqual(out["system"], "be concise")
        # messages 内不再有 role=system
        roles = [m["role"] for m in out["messages"]]
        self.assertNotIn("system", roles)

    def test_unsupported_drops_system(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(system_message_style="unsupported")
        body = {
            "messages": [
                {"role": "system", "content": "ignored"},
                {"role": "user", "content": "hi"},
            ],
        }
        events = []
        out = _normalize_system(body, caps, _ctx(), events)
        roles = [m["role"] for m in out["messages"]]
        self.assertNotIn("system", roles)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["feature"], "system")
        self.assertEqual(events[0]["fallback_to"], "omit_system_prompt")

    def test_qwq_strip_to_user_prefix(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(
            system_message_style="messages_first_role_system",
            system_quirks=("qwq_strip_to_user",),
        )
        body = {
            "messages": [
                {"role": "system", "content": "be concise"},
                {"role": "user", "content": "hi"},
            ],
        }
        events = []
        out = _normalize_system(body, caps, _ctx(), events)
        # system 被 drop,user 内容前缀含 system 文本
        roles = [m["role"] for m in out["messages"]]
        self.assertNotIn("system", roles)
        first_user = next(m for m in out["messages"] if m["role"] == "user")
        self.assertIn("be concise", first_user["content"])
        self.assertIn("hi", first_user["content"])
        self.assertEqual(events[0]["feature"], "system")
        self.assertEqual(events[0]["fallback_to"], "user_message_prefix")

    def test_qvq_drop_emits_capability_downgrade_event(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(
            system_message_style="messages_first_role_system",
            system_quirks=("qvq_drop",),
        )
        body = {
            "messages": [
                {"role": "system", "content": "hidden instruction"},
                {"role": "user", "content": "hi"},
            ],
        }
        events = []

        out = _normalize_system(body, caps, _ctx(model_name="qvq-test"), events)

        roles = [m["role"] for m in out["messages"]]
        self.assertNotIn("system", roles)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "capability_downgrade")
        self.assertEqual(events[0]["stage"], "system")
        self.assertEqual(events[0]["feature"], "system")
        self.assertEqual(events[0]["fallback_to"], "omit_system_prompt")
        self.assertEqual(events[0]["reason"], "system_prompt_unsupported_dropped_by_quirk")

    def test_top_level_idempotent(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(system_message_style="top_level_system_field")
        body = {
            "system": "already set",
            "messages": [{"role": "user", "content": "hi"}],
        }
        out = _normalize_system(body, caps, _ctx())
        self.assertEqual(out["system"], "already set")
        self.assertEqual(len(out["messages"]), 1)


# ---------------------------------------------------------------------------
# 3. _normalize_tool_definitions
# ---------------------------------------------------------------------------

class NormalizeToolDefinitionsTests(SimpleTestCase):

    def test_no_tools_passthrough(self):
        caps = ResolvedCapabilities()
        body = {"messages": [{"role": "user", "content": "hi"}]}
        out = _normalize_tool_definitions(body, caps, _ctx())
        self.assertNotIn("tools", out)

    def test_openai_param_field_passthrough(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, param_field="parameters")
        body = {
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_w",
                    "description": "weather",
                    "parameters": {"type": "object", "properties": {}},
                },
            }],
        }
        out = _normalize_tool_definitions(body, caps, _ctx())
        self.assertEqual(out["tools"][0]["type"], "function")
        self.assertIn("function", out["tools"][0])

    def test_anthropic_input_schema_rename(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, param_field="input_schema")
        body = {
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_w",
                    "description": "weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }],
        }
        out = _normalize_tool_definitions(body, caps, _ctx())
        tool = out["tools"][0]
        self.assertEqual(tool["name"], "get_w")
        self.assertEqual(tool["description"], "weather")
        self.assertIn("input_schema", tool)
        self.assertNotIn("function", tool)

    def test_tools_dropped_when_disabled(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=False)
        body = {
            "tools": [{
                "type": "function",
                "function": {"name": "x", "parameters": {}}
            }],
            "tool_choice": "required",
        }
        events = []
        out = _normalize_tool_definitions(body, caps, _ctx(), events)
        self.assertNotIn("tools", out)
        self.assertNotIn("tool_choice", out)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["feature"], "tool")
        self.assertEqual(events[0]["fallback_to"], "omit_tools")


# ---------------------------------------------------------------------------
# 4. _normalize_tool_choice
# ---------------------------------------------------------------------------

class NormalizeToolChoiceTests(SimpleTestCase):

    def test_no_tool_choice_passthrough(self):
        caps = ResolvedCapabilities()
        body = {"messages": []}
        out = _normalize_tool_choice(body, caps, _ctx())
        self.assertNotIn("tool_choice", out)

    def test_required_to_any_for_anthropic(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, choice_modes=("auto", "any", "none", "specific"))
        body = {"tool_choice": "required"}
        out = _normalize_tool_choice(body, caps, _ctx())
        self.assertEqual(out["tool_choice"], {"type": "any"})

    def test_required_to_any_for_anthropic_does_not_emit_downgrade_event(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, choice_modes=("auto", "any", "none", "specific"))
        body = {"tool_choice": "required"}
        events = []

        out = _normalize_tool_choice(body, caps, _ctx(), events)

        self.assertEqual(out["tool_choice"], {"type": "any"})
        self.assertEqual(events, [])

    def test_required_passthrough_for_openai(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            choice_modes=("auto", "required", "none", "specific"),
        )
        body = {"tool_choice": "required"}
        out = _normalize_tool_choice(body, caps, _ctx())
        self.assertEqual(out["tool_choice"], "required")

    def test_specific_dict_downgraded_when_unsupported(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, choice_modes=("auto", "required", "none"))
        body = {
            "tool_choice": {"type": "function", "function": {"name": "x"}},
        }
        events = []
        out = _normalize_tool_choice(body, caps, _ctx(), events)
        self.assertEqual(out["tool_choice"], "auto")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["feature"], "tool")
        self.assertEqual(events[0]["fallback_to"], "auto_tool_choice")

    def test_required_downgrades_to_auto_with_capability_event(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, choice_modes=("auto", "none", "specific"))
        body = {"tool_choice": "required"}
        events = []

        out = _normalize_tool_choice(body, caps, _ctx(model_name="tool-test"), events)

        self.assertEqual(out["tool_choice"], "auto")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "capability_downgrade")
        self.assertEqual(events[0]["stage"], "tool_choice")
        self.assertEqual(events[0]["feature"], "tool")
        self.assertEqual(events[0]["fallback_to"], "auto_tool_choice")
        self.assertEqual(events[0]["reason"], "required_tool_choice_unsupported")

    def test_specific_dict_passthrough_when_supported(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            choice_modes=("auto", "required", "none", "specific"),
        )
        body = {
            "tool_choice": {"type": "function", "function": {"name": "x"}},
        }
        out = _normalize_tool_choice(body, caps, _ctx())
        self.assertEqual(out["tool_choice"]["type"], "function")


# ---------------------------------------------------------------------------
# 5. _normalize_parallel_tool_calls
# ---------------------------------------------------------------------------

class InjectParallelToolCallsTests(SimpleTestCase):

    def test_no_tools_passthrough(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, parallel_default=False)
        body = {"messages": []}
        out = _normalize_parallel_tool_calls(body, caps, _ctx())
        self.assertNotIn("parallel_tool_calls", out)

    def test_qwen_default_off_injects_false(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            parallel_default=False,
            parallel_param_name="parallel_tool_calls",
            parallel_param_inverted=False,
        )
        body = {
            "tools": [{"type": "function", "function": {"name": "x", "parameters": {}}}],
        }
        out = _normalize_parallel_tool_calls(body, caps, _ctx())
        self.assertEqual(out["parallel_tool_calls"], False)

    def test_anthropic_inverted_param_injection(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            parallel_default=True,
            parallel_param_name="disable_parallel_tool_use",
            parallel_param_inverted=True,
        )
        body = {
            "tools": [{"type": "function", "function": {"name": "x", "parameters": {}}}],
        }
        out = _normalize_parallel_tool_calls(body, caps, _ctx())
        self.assertEqual(out["disable_parallel_tool_use"], False)
        self.assertNotIn("parallel_tool_calls", out)

    def test_user_explicit_value_inverted(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            parallel_default=True,
            parallel_param_name="disable_parallel_tool_use",
            parallel_param_inverted=True,
        )
        body = {
            "tools": [{"type": "function", "function": {"name": "x", "parameters": {}}}],
            "parallel_tool_calls": False,
        }
        out = _normalize_parallel_tool_calls(body, caps, _ctx())
        self.assertEqual(out["disable_parallel_tool_use"], True)


# ---------------------------------------------------------------------------
# 6. _normalize_cache_control
# ---------------------------------------------------------------------------

class FilterCacheControlTests(SimpleTestCase):

    def test_strip_disabled_passthrough(self):
        caps = ResolvedCapabilities()
        caps.caching = CachingCaps(cache_control_strip=False)
        body = {
            "messages": [{
                "role": "user",
                "content": [{"type": "text", "text": "hi", "cache_control": {"type": "ephemeral"}}],
            }],
        }
        out = _normalize_cache_control(body, caps, _ctx())
        # 保留 cache_control(Anthropic 走显式 cache)
        self.assertIn("cache_control", out["messages"][0]["content"][0])

    def test_strip_enabled_removes_cache_control(self):
        caps = ResolvedCapabilities()
        caps.caching = CachingCaps(cache_control_strip=True)
        body = {
            "messages": [{
                "role": "user",
                "content": [{"type": "text", "text": "hi", "cache_control": {"type": "ephemeral"}}],
            }],
        }
        out = _normalize_cache_control(body, caps, _ctx())
        self.assertNotIn("cache_control", out["messages"][0]["content"][0])

    def test_strip_at_message_top_level(self):
        caps = ResolvedCapabilities()
        caps.caching = CachingCaps(cache_control_strip=True)
        body = {
            "messages": [{
                "role": "user",
                "content": "hi",
                "cache_control": {"type": "ephemeral"},
            }],
        }
        out = _normalize_cache_control(body, caps, _ctx())
        self.assertNotIn("cache_control", out["messages"][0])

    def test_strip_in_tools(self):
        caps = ResolvedCapabilities()
        caps.caching = CachingCaps(cache_control_strip=True)
        body = {
            "messages": [],
            "tools": [{
                "type": "function",
                "function": {"name": "x", "parameters": {}},
                "cache_control": {"type": "ephemeral"},
            }],
        }
        out = _normalize_cache_control(body, caps, _ctx())
        self.assertNotIn("cache_control", out["tools"][0])


# ---------------------------------------------------------------------------
# 7. _normalize_json_mode
# ---------------------------------------------------------------------------

class NormalizeJsonModeTests(SimpleTestCase):

    def test_no_response_format_passthrough(self):
        caps = ResolvedCapabilities()
        body = {"messages": []}
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)
        self.assertNotIn("response_format", out)
        self.assertEqual(events, [])

    def test_json_schema_passthrough_when_supported(self):
        caps = ResolvedCapabilities()
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object", "json_schema"),
            schema_field="response_format.json_schema.schema",
        )
        rf = {"type": "json_schema", "json_schema": {"name": "x", "schema": {"type": "object"}}}
        body = {"messages": [], "response_format": rf}
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)
        self.assertEqual(out["response_format"]["type"], "json_schema")
        self.assertEqual(events, [])

    def test_json_schema_fallback_to_prompt_for_qwen(self):
        caps = ResolvedCapabilities()
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object"),
            schema_fallback=True,
        )
        rf = {
            "type": "json_schema",
            "json_schema": {"name": "x", "schema": {"type": "object"}},
        }
        body = {
            "messages": [{"role": "user", "content": "hi"}],
            "response_format": rf,
        }
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)
        # response_format 已删除
        self.assertNotIn("response_format", out)
        # messages 头部插入 system 提示词
        first = out["messages"][0]
        self.assertEqual(first["role"], "system")
        self.assertIn("JSON Schema", first["content"])
        # downgrade event 被记录
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "capability_downgrade")
        self.assertEqual(events[0]["feature"], "json_schema")
        self.assertEqual(events[0]["capability"], "json_schema")
        self.assertEqual(events[0]["fallback_to"], "system_prompt_hint")
        self.assertIn("JSON Schema", events[0]["message"])

    def test_json_object_fallback_event_uses_frontend_contract_fields(self):
        caps = ResolvedCapabilities()
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_schema"),
            schema_fallback=True,
            schema_field="output_config.json_schema.schema",
        )
        body = {
            "messages": [{"role": "user", "content": "return json"}],
            "response_format": {"type": "json_object"},
        }
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)

        self.assertNotIn("response_format", out)
        self.assertNotIn("output_config", out)
        first = out["messages"][0]
        self.assertEqual(first["role"], "system")
        self.assertIn("严格 JSON 格式", first["content"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "capability_downgrade")
        self.assertEqual(events[0]["feature"], "json_object")
        self.assertEqual(events[0]["capability"], "json_object")
        self.assertEqual(events[0]["fallback_to"], "system_prompt_hint")
        self.assertIn("JSON Object", events[0]["message"])

    def test_json_object_fallback_respects_unsupported_system(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(system_message_style="unsupported")
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_schema"),
            schema_fallback=True,
            schema_field="output_config.json_schema.schema",
        )
        body = {
            "messages": [{"role": "user", "content": "return json"}],
            "response_format": {"type": "json_object"},
        }
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)

        self.assertNotIn("response_format", out)
        self.assertNotIn("output_config", out)
        self.assertEqual(out["messages"][0]["role"], "user")
        self.assertIn("严格 JSON 格式", out["messages"][0]["content"])
        self.assertEqual(events[0]["feature"], "json_object")

    def test_json_schema_fallback_uses_top_level_system_when_required(self):
        caps = ResolvedCapabilities()
        caps.wire = WireFormatCaps(system_message_style="top_level_system_field")
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object"),
            schema_fallback=True,
        )
        body = {
            "messages": [{"role": "user", "content": "return json"}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "x", "schema": {"type": "object"}},
            },
        }
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)

        self.assertNotIn("response_format", out)
        self.assertIn("JSON Schema", out["system"])
        self.assertEqual(out["messages"][0]["role"], "user")
        self.assertEqual(events[0]["feature"], "json_schema")

    def test_anthropic_response_format_renamed(self):
        caps = ResolvedCapabilities()
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object", "json_schema"),
            schema_field="output_config.json_schema.schema",
        )
        rf = {"type": "json_schema", "json_schema": {"name": "x", "schema": {}}}
        body = {"messages": [], "response_format": rf}
        events = []
        out = _normalize_json_mode(body, caps, _ctx(), events)
        self.assertNotIn("response_format", out)
        self.assertIn("output_config", out)


# ---------------------------------------------------------------------------
# 8. _normalize_reasoning_param
# ---------------------------------------------------------------------------

class NormalizeReasoningParamTests(SimpleTestCase):

    def test_no_reasoning_passthrough(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(enabled=True, format="thinking_block", param_path="thinking")
        body = {"messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertNotIn("reasoning_effort", out)
        self.assertNotIn("thinking", out)

    def test_hidden_drops_reasoning_effort(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(enabled=True, format="hidden", param_path=None)
        body = {"reasoning_effort": "high", "messages": []}
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx(), events)
        self.assertNotIn("reasoning_effort", out)
        self.assertEqual(events[0]["feature"], "reasoning")
        self.assertEqual(events[0]["fallback_to"], "omit_reasoning_param")

    def test_hidden_response_with_explicit_effort_path_keeps_effort(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="hidden",
            param_path="reasoning_effort",
        )
        body = {
            "reasoning_effort": "xhigh",
            "thinking": {"type": "enabled"},
            "messages": [],
        }
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertEqual(out["reasoning_effort"], "xhigh")
        self.assertNotIn("thinking", out)

    def test_claude_reasoning_effort_to_thinking_budget(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_block",
            param_path="thinking",
        )
        body = {"reasoning_effort": "high", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertNotIn("reasoning_effort", out)
        self.assertIn("thinking", out)
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertGreaterEqual(out["thinking"]["budget_tokens"], 1024)

    def test_kimi_k3_keeps_reasoning_effort_and_strips_thinking(self):
        """K3 始终推理，请求侧只要 reasoning_effort，thinking 会上游 400。"""
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="reasoning_content_field",
            param_path="reasoning_effort",
            budget_param="reasoning_effort",
        )
        body = {
            "reasoning_effort": "low",
            "thinking": {"type": "disabled"},
            "messages": [],
        }
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx("kimi-k3"), events)
        self.assertEqual(out["reasoning_effort"], "low")
        self.assertNotIn("thinking", out)
        self.assertEqual(events[0]["fallback_to"], "omit_thinking_param")

    def test_kimi_k3_maps_medium_effort_to_high(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="reasoning_content_field",
            param_path="reasoning_effort",
        )
        body = {"reasoning_effort": "medium", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx("kimi-k3"))
        self.assertEqual(out["reasoning_effort"], "high")

    def test_reasoning_disabled_drops_user_params(self):
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(enabled=False)
        body = {"reasoning_effort": "low", "thinking": {"type": "enabled"}, "messages": []}
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx(), events)
        self.assertNotIn("reasoning_effort", out)
        self.assertNotIn("thinking", out)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["feature"], "reasoning")
        self.assertEqual(events[0]["fallback_to"], "omit_reasoning_param")

    def test_moonshot_drops_reasoning_param_no_path(self):
        # Moonshot/Qwen reasoning 是响应侧 delta 字段,请求侧无显式开关
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="reasoning_content_field",
            param_path=None,
        )
        body = {"reasoning_effort": "medium", "messages": []}
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx(), events)
        self.assertNotIn("reasoning_effort", out)
        self.assertEqual(events[0]["feature"], "reasoning")

    def test_gemini_extra_body_thinking_config_high(self):
        """W1b-fix Block C2:Gemini reasoning_effort='high' → 写入 nested
        extra_body.google.thinking_config + 删除顶层 reasoning_effort。
        """
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_config",
            param_path="extra_body.google.thinking_config",
        )
        body = {"reasoning_effort": "high", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        # 顶层 reasoning_effort 已删(与 thinking_level 互斥)
        self.assertNotIn("reasoning_effort", out)
        # nested path 写入
        thinking = out["extra_body"]["google"]["thinking_config"]
        self.assertEqual(thinking["thinking_level"], "high")
        self.assertTrue(thinking["include_thoughts"])

    def test_gemini_extra_body_low_medium(self):
        """W1b-fix Block C2:effort='low'/'medium' 三档映射对应 thinking_level"""
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_config",
            param_path="extra_body.google.thinking_config",
        )
        for effort in ("low", "medium", "high"):
            body = {"reasoning_effort": effort, "messages": []}
            out = _normalize_reasoning_param(body, caps, _ctx())
            tl = out["extra_body"]["google"]["thinking_config"]["thinking_level"]
            self.assertEqual(tl, effort)

    def test_gemini_extra_body_idempotent_when_user_set(self):
        """用户已显式配过 thinking_level → 保留(幂等)"""
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_config",
            param_path="extra_body.google.thinking_config",
        )
        body = {
            "reasoning_effort": "low",
            "extra_body": {
                "google": {
                    "thinking_config": {
                        "thinking_budget": 4096,
                        "include_thoughts": False,
                    }
                }
            },
            "messages": [],
        }
        out = _normalize_reasoning_param(body, caps, _ctx())
        # 用户已配 thinking_budget → 不动
        tc = out["extra_body"]["google"]["thinking_config"]
        self.assertEqual(tc["thinking_budget"], 4096)
        # 用户配的 include_thoughts=False → 不动
        self.assertFalse(tc["include_thoughts"])
        self.assertNotIn("reasoning_effort", out)

    def test_gemini_extra_body_no_reasoning_effort_passthrough(self):
        """body 无 reasoning_effort/thinking → 不动 extra_body"""
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_config",
            param_path="extra_body.google.thinking_config",
        )
        body = {"messages": [], "extra_body": {"google": {"foo": "bar"}}}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertEqual(out["extra_body"]["google"]["foo"], "bar")
        # 没引发 thinking_config 创建
        self.assertNotIn(
            "thinking_config",
            out["extra_body"]["google"],
        )

    def test_gemini_drops_anthropic_thinking_field(self):
        """用户(可能误)传了 Anthropic 风 thinking 字段 → Gemini 不识别,drop"""
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_config",
            param_path="extra_body.google.thinking_config",
        )
        body = {
            "thinking": {"type": "enabled", "budget_tokens": 4096},
            "messages": [],
        }
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertNotIn("thinking", out)

    # -- Runtime Profile Phase 1 / W2:thinking budget 映射 -------------------

    def _claude_caps(self, **overrides):
        caps = ResolvedCapabilities()
        kwargs = {
            "enabled": True,
            "format": "thinking_block",
            "param_path": "thinking",
        }
        kwargs.update(overrides)
        caps.reasoning = ReasoningCaps(**kwargs)
        return caps

    def test_thinking_budget_is_monotonic_across_canonical_levels(self):
        """W2 :四档 budget 必须严格递增,'最高档'不能弱于'高'。"""
        budgets = {}
        for level in ("low", "medium", "high", "max"):
            body = {"reasoning_effort": level, "messages": []}
            out = _normalize_reasoning_param(body, self._claude_caps(), _ctx())
            self.assertEqual(out["thinking"]["type"], "enabled")
            budgets[level] = out["thinking"]["budget_tokens"]
        self.assertLess(budgets["low"], budgets["medium"])
        self.assertLess(budgets["medium"], budgets["high"])
        self.assertLess(
            budgets["high"], budgets["max"],
            f"max 档必须高于 high 档,实际 {budgets!r}",
        )

    def test_thinking_off_tokens_disable_thinking(self):
        """canonical off(及 none/disabled 别名)→ type=disabled,不能落成默认预算。"""
        for token in ("off", "none", "disabled", "OFF"):
            body = {"reasoning_effort": token, "messages": []}
            events = []
            out = _normalize_reasoning_param(body, self._claude_caps(), _ctx(), events)
            self.assertEqual(
                out["thinking"], {"type": "disabled"},
                f"effort={token!r} 应关闭思考,实际 {out['thinking']!r}",
            )
            self.assertNotIn("reasoning_effort", out)
            self.assertEqual(events, [], "显式关闭是用户意图,不该报降级")

    def test_thinking_unknown_level_falls_back_to_lowest_with_downgrade(self):
        """未登记档位不再静默取中档,改为落最低档 + 显式降级事件。"""
        body = {"reasoning_effort": "xhigh", "messages": []}
        events = []
        out = _normalize_reasoning_param(body, self._claude_caps(), _ctx("claude-x"), events)
        self.assertEqual(out["thinking"]["type"], "enabled")
        self.assertEqual(out["thinking"]["budget_tokens"], 1024)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["reason"], "unknown_reasoning_effort_level")
        self.assertEqual(events[0]["fallback_to"], "thinking_budget_low")
        self.assertIn("claude-x", events[0]["message"])

    def test_thinking_budget_map_override_wins(self):
        """per-model budget_map 覆盖默认表。"""
        caps = self._claude_caps(budget_map={"low": 500, "high": 9999})
        body = {"reasoning_effort": "high", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertEqual(out["thinking"]["budget_tokens"], 9999)

    def test_thinking_budget_map_override_narrows_fallback(self):
        """覆盖表存在时,未登记档位落的是覆盖表里的最低档。"""
        caps = self._claude_caps(budget_map={"medium": 2048, "high": 8192})
        body = {"reasoning_effort": "max", "messages": []}
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx(), events)
        self.assertEqual(out["thinking"]["budget_tokens"], 2048)
        self.assertEqual(events[0]["fallback_to"], "thinking_budget_medium")

    def test_thinking_budget_map_invalid_entries_ignored(self):
        """脏配置(非数字 / bool / 负数 / off 档)逐项丢弃,全脏则回退默认表。"""
        caps = self._claude_caps(
            budget_map={"low": "abc", "medium": True, "high": -1, "off": 100},
        )
        body = {"reasoning_effort": "medium", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertEqual(out["thinking"]["budget_tokens"], 4096)

    def test_thinking_explicit_dict_is_idempotent(self):
        """上游已给 thinking dict → 原样保留,不被档位表覆盖。"""
        caps = self._claude_caps()
        body = {"thinking": {"type": "enabled", "budget_tokens": 777}, "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertEqual(out["thinking"]["budget_tokens"], 777)

    # -- Runtime Profile Phase 1 / W1:enable_thinking --------------------------

    def _qwen_caps(self, **overrides):
        caps = ResolvedCapabilities()
        kwargs = {
            "enabled": True,
            "format": "reasoning_content_field",
            "param_path": "enable_thinking",
        }
        kwargs.update(overrides)
        caps.reasoning = ReasoningCaps(**kwargs)
        return caps

    def test_qwen_enable_thinking_true_and_effort_removed(self):
        """W1 :reasoning_effort 不再原样透传给 DashScope。"""
        body = {"reasoning_effort": "high", "messages": []}
        out = _normalize_reasoning_param(body, self._qwen_caps(), _ctx("qwen3-plus"))
        self.assertNotIn("reasoning_effort", out)
        self.assertIs(out["enable_thinking"], True)

    def test_qwen_enable_thinking_false_on_off(self):
        """显式关闭要写 False,不能靠省略字段(DashScope 缺省值随型号变)。"""
        for token in ("off", "none", "disabled"):
            body = {"reasoning_effort": token, "messages": []}
            out = _normalize_reasoning_param(body, self._qwen_caps(), _ctx())
            self.assertIs(out["enable_thinking"], False, f"effort={token!r}")
            self.assertNotIn("reasoning_effort", out)

    def test_qwen_enable_thinking_writes_budget_when_declared(self):
        """声明了 budget_param 的模型按档位补 token 预算。"""
        caps = self._qwen_caps(budget_param="thinking_budget")
        body = {"reasoning_effort": "low", "messages": []}
        out = _normalize_reasoning_param(body, caps, _ctx())
        self.assertIs(out["enable_thinking"], True)
        self.assertEqual(out["thinking_budget"], 1024)

    def test_qwen_enable_thinking_unknown_level_keeps_upstream_budget(self):
        """档位未登记:思考仍开启,放弃精细预算,不报降级(主意图未丢)。"""
        caps = self._qwen_caps(budget_param="thinking_budget")
        body = {"reasoning_effort": "xhigh", "messages": []}
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx(), events)
        self.assertIs(out["enable_thinking"], True)
        self.assertNotIn("thinking_budget", out)
        self.assertEqual(events, [])

    def test_qwen_enable_thinking_strips_anthropic_thinking_dict(self):
        """DashScope 不认 thinking dict → drop + 降级事件。"""
        body = {
            "reasoning_effort": "high",
            "thinking": {"type": "enabled", "budget_tokens": 4096},
            "messages": [],
        }
        events = []
        out = _normalize_reasoning_param(body, self._qwen_caps(), _ctx(), events)
        self.assertNotIn("thinking", out)
        self.assertIs(out["enable_thinking"], True)
        self.assertEqual(events[0]["fallback_to"], "omit_thinking_param")

    def test_qwen_enable_thinking_respects_explicit_value(self):
        """上游已显式给 enable_thinking → 幂等,但仍要摘掉 reasoning_effort。"""
        body = {"enable_thinking": False, "reasoning_effort": "high", "messages": []}
        out = _normalize_reasoning_param(body, self._qwen_caps(), _ctx())
        self.assertIs(out["enable_thinking"], False)
        self.assertNotIn("reasoning_effort", out)

    def test_qwen_enable_thinking_without_effort_is_noop(self):
        """只有 thinking dict、没有 effort → 不凭空造 enable_thinking。"""
        body = {"thinking": {"type": "enabled"}, "messages": []}
        out = _normalize_reasoning_param(body, self._qwen_caps(), _ctx())
        self.assertNotIn("thinking", out)
        self.assertNotIn("enable_thinking", out)

    # -- Runtime Profile Phase 1 / W1:未接线 param_path 兜底 ------------------

    def test_unhandled_param_path_drops_params_with_downgrade(self):
        """枚举里新增但适配器没接线的 param_path:drop + 降级,不再原样透传。"""
        caps = ResolvedCapabilities()
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="reasoning_content_field",
            param_path="some_future_vendor_switch",
        )
        body = {
            "reasoning_effort": "high",
            "thinking": {"type": "enabled"},
            "messages": [],
        }
        events = []
        out = _normalize_reasoning_param(body, caps, _ctx("future-model"), events)
        self.assertNotIn("reasoning_effort", out)
        self.assertNotIn("thinking", out)
        self.assertEqual(events[0]["reason"], "unhandled_reasoning_param_path")
        self.assertEqual(out["messages"], [])


# ---------------------------------------------------------------------------
# adapt_request 集成测试 + 顺序约束
# ---------------------------------------------------------------------------

class AdaptRequestIntegrationTests(SimpleTestCase):
    """端到端验证 8 个 helper 的顺序与组合行为。"""

    def test_input_body_not_mutated(self):
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=True, input_via=("base64", "url"))
        caps.wire = WireFormatCaps(system_message_style="top_level_system_field")
        body = {
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "hi"},
            ],
        }
        original = {"messages": list(body["messages"])}
        out, events = adapt_request(body, caps, _ctx())
        # 原 body 未被 mutate
        self.assertEqual(body["messages"][0]["role"], "system")

    def test_anthropic_full_path(self):
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=True, input_via=("base64",))
        caps.tool = ToolCaps(
            enabled=True,
            choice_modes=("auto", "any", "none", "specific"),
            param_field="input_schema",
            parallel_default=True,
            parallel_param_name="disable_parallel_tool_use",
            parallel_param_inverted=True,
        )
        caps.wire = WireFormatCaps(system_message_style="top_level_system_field")
        caps.caching = CachingCaps(mode="explicit_cache_control", cache_control_strip=False)
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object", "json_schema"),
            schema_field="output_config.json_schema.schema",
        )
        caps.reasoning = ReasoningCaps(
            enabled=True,
            format="thinking_block",
            param_path="thinking",
        )
        body = {
            "messages": [
                {"role": "system", "content": "you are concise"},
                {"role": "user", "content": "hi"},
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_w",
                    "description": "weather",
                    "parameters": {"type": "object"},
                },
            }],
            "tool_choice": "required",
            "reasoning_effort": "medium",
        }
        out, events = adapt_request(body, caps, _ctx())
        # system hoisted
        self.assertEqual(out["system"], "you are concise")
        # tool input_schema 改名
        self.assertIn("input_schema", out["tools"][0])
        # tool_choice required → {type:any}
        self.assertEqual(out["tool_choice"], {"type": "any"})
        # parallel inverted 注入
        self.assertEqual(out["disable_parallel_tool_use"], False)
        # reasoning thinking budget
        self.assertEqual(out["thinking"]["type"], "enabled")
        # 无降级事件
        self.assertEqual(events, [])

    def test_qwen_full_path_with_json_schema_fallback(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(
            enabled=True,
            choice_modes=("auto", "required", "none"),
            param_field="parameters",
            parallel_default=False,
            parallel_param_name="parallel_tool_calls",
        )
        caps.wire = WireFormatCaps(system_message_style="messages_first_role_system")
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object"),
            schema_fallback=True,
        )
        body = {
            "messages": [
                {"role": "user", "content": "weather?"}
            ],
            "tools": [{
                "type": "function",
                "function": {"name": "get_w", "parameters": {}},
            }],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "weather", "schema": {"type": "object"}},
            },
        }
        out, events = adapt_request(body, caps, _ctx())
        # parallel injected as False(Qwen 默认关)
        self.assertEqual(out["parallel_tool_calls"], False)
        # tools 保留 OpenAI 风
        self.assertEqual(out["tools"][0]["type"], "function")
        # response_format 已删除,system prompt 注入 schema 提示
        self.assertNotIn("response_format", out)
        # downgrade event emitted
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["feature"], "json_schema")
        self.assertEqual(events[0]["capability"], "json_schema")
        self.assertEqual(events[0]["fallback_to"], "system_prompt_hint")

    def test_capability_gate_short_circuits_pipeline(self):
        """image gate 拒绝时,后续 helpers 不应执行(防止 system/tool 被改但拒绝)。"""
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=False)
        caps.tool = ToolCaps(enabled=True, param_field="input_schema")
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://e.com/a.png"}}
                ],
            }],
            "tools": [{"type": "function", "function": {"name": "x", "parameters": {}}}],
        }
        with self.assertRaises(CapabilityGateError):
            adapt_request(body, caps, _ctx())


# ---------------------------------------------------------------------------
# Order constraint(顺序约束)— 防 W2 重构时打乱 helper 顺序
# ---------------------------------------------------------------------------

class HelperOrderConstraintTests(SimpleTestCase):
    """显式记录 8 个 helper 的执行顺序,作为 W2 重构 guard。

    W1b-fix Block M1:从仅 hasattr 检查升级为 mock 真验证调用顺序。
    """

    EXPECTED_ORDER = [
        "_normalize_images",
        "_normalize_videos",
        "_normalize_system",
        "_normalize_tool_definitions",
        "_normalize_tool_choice",
        "_normalize_parallel_tool_calls",
        "_normalize_cache_control",
        "_normalize_json_mode",
        "_normalize_reasoning_param",
    ]

    def test_adapt_request_helper_order_documented(self):
        """8 个 helper 都在 module 内(浅层 sanity check)。"""
        from apps.services.llm.wire_adapter import request_adapter as ra
        for name in self.EXPECTED_ORDER:
            self.assertTrue(hasattr(ra, name), f"missing helper {name}")

    def test_adapt_request_calls_helpers_in_spec_order(self):
        """W1b-fix Block M1:用 mock 替换 8 个 helper,记录真实调用顺序,
        断言与 EXPECTED_ORDER 完全一致。"""
        from apps.services.llm.wire_adapter import request_adapter as ra

        call_order: list[str] = []

        def make_mock(name: str):
            def _fake(body, caps, ctx=None, *_args, **_kwargs):
                call_order.append(name)
                return body
            return _fake

        patches = {name: make_mock(name) for name in self.EXPECTED_ORDER}

        caps = ResolvedCapabilities()
        body = {"messages": [{"role": "user", "content": "hi"}]}

        with patch.multiple(ra, **patches):
            ra.adapt_request(body, caps, _ctx())

        # 断言调用顺序与 spec EXPECTED_ORDER 完全一致(包括位置 + 元素)
        self.assertEqual(
            call_order, self.EXPECTED_ORDER,
            f"adapt_request helper 调用顺序错乱: 期望 {self.EXPECTED_ORDER}, "
            f"实际 {call_order}",
        )

    def test_order_assertion_catches_swapped_helpers(self):
        """反向测试:故意把 _normalize_images 与 _normalize_system 的 mock
        交换记录顺序,验证 assertEqual 真能检测到差异(防 mock 机制本身失效)。"""
        from apps.services.llm.wire_adapter import request_adapter as ra

        call_order: list[str] = []

        # 故意制造错乱:让 _normalize_system 的 mock 记录成 _normalize_images
        def make_mock(reported_name: str):
            def _fake(body, caps, ctx=None, *_args, **_kwargs):
                call_order.append(reported_name)
                return body
            return _fake

        # 错位映射:images mock 记 system / system mock 记 images
        patches = {
            "_normalize_images": make_mock("_normalize_system"),
            "_normalize_videos": make_mock("_normalize_videos"),
            "_normalize_system": make_mock("_normalize_images"),
            "_normalize_tool_definitions": make_mock("_normalize_tool_definitions"),
            "_normalize_tool_choice": make_mock("_normalize_tool_choice"),
            "_normalize_parallel_tool_calls": make_mock("_normalize_parallel_tool_calls"),
            "_normalize_cache_control": make_mock("_normalize_cache_control"),
            "_normalize_json_mode": make_mock("_normalize_json_mode"),
            "_normalize_reasoning_param": make_mock("_normalize_reasoning_param"),
        }

        caps = ResolvedCapabilities()
        body = {"messages": []}

        with patch.multiple(ra, **patches):
            ra.adapt_request(body, caps, _ctx())

        # 实际调用顺序:第一个被调的是 images 位 → mock 记成 "_normalize_system",
        # 与 EXPECTED_ORDER[0]="_normalize_images" 不等 → 应失配
        self.assertNotEqual(
            call_order, self.EXPECTED_ORDER,
            "反向测试失败:mock 错位时仍判等 → 顺序断言机制无效",
        )
        # 具体验证错位:第一位记成 system；videos 仍在第二位
        self.assertEqual(call_order[0], "_normalize_system")
        self.assertEqual(call_order[1], "_normalize_videos")
        self.assertEqual(call_order[2], "_normalize_images")

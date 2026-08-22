"""
J3-01 / J3-02 安全修复测试

J3-01: import_pptx multipart 上传端点文件大小限制（50MB）
J3-02: preview_service 文本/形状/表格元素 content XSS 净化
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabslide import api as slide_api
from apps.tabslide.models import SlideProject
from apps.tabslide.services.preview_service import (
    _sanitize_content_html,
    _render_text_element,
    _render_shape_element,
    _render_table_element,
    build_slide_html,
)
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization

User = get_user_model()


def _status(resp) -> int:
    if isinstance(resp, tuple):
        return resp[0]
    if hasattr(resp, "status_code"):
        return resp.status_code
    return 200


def _body(resp) -> dict:
    if isinstance(resp, tuple):
        return resp[1]
    if hasattr(resp, "content"):
        return json.loads(resp.content)
    return resp


def _make_user(suffix: str) -> User:
    return User.objects.create_user(
        username=f"j3test_{suffix}",
        email=f"j3test_{suffix}@test.com",
        password="pass123",
    )


def _ensure_space_membership(organization, space, user, role="editor"):
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"name": user.username, "type": "human", "is_active": True},
    )
    SpaceMembership.objects.update_or_create(
        workspace=space,
        agent=agent,
        defaults={"role": role, "is_active": True},
    )


# ─────────────────────────────────────────────────────────────────────────────
# J3-01: import_pptx 文件大小限制
# ─────────────────────────────────────────────────────────────────────────────


class ImportPptxFileSizeLimitTests(TestCase):
    """J3-01: import_pptx 多部分上传端点应拒绝超过 50MB 的文件。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user(f"j301_{uuid.uuid4().hex[:6]}")
        self.organization = Organization.objects.create(
            name="j301-ws",
            owner=self.owner,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="j301-space",
        )
        _ensure_space_membership(self.organization, self.space, self.owner, "editor")
        self.request = SimpleNamespace(auth=self.owner)

    def _make_oversized_file(self, size_bytes: int = 55 * 1024 * 1024) -> MagicMock:
        fake_file = MagicMock()
        fake_file.name = "huge.pptx"
        fake_file.size = size_bytes
        fake_file.chunks.return_value = iter([b"x" * size_bytes])
        return fake_file

    def _make_normal_file(self, size_bytes: int = 1024) -> MagicMock:
        fake_file = MagicMock()
        fake_file.name = "small.pptx"
        fake_file.size = size_bytes
        fake_file.read.return_value = b"PK\x03\x04"
        fake_file.chunks.return_value = iter([b"x" * size_bytes])
        return fake_file

    def test_import_pptx_rejects_oversized_file_at_api_layer(self):
        """55MB 文件应在 API 层被拒绝（400），不进入 service。"""
        resp = slide_api.import_pptx(
            self.request,
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            file=self._make_oversized_file(),
        )
        self.assertEqual(_status(resp), 400)
        body = _body(resp)
        self.assertIn("50MB", str(body))

    def test_import_pptx_rejects_exactly_over_limit(self):
        """刚好超过 50MB + 1 byte 应被拒绝。"""
        limit = 50 * 1024 * 1024 + 1
        resp = slide_api.import_pptx(
            self.request,
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            file=self._make_oversized_file(size_bytes=limit),
        )
        self.assertEqual(_status(resp), 400)

    def test_import_pptx_accepts_file_within_limit(self):
        """10KB 文件应通过大小检查，暂存 OSS 并派发异步任务。"""
        oss_service = MagicMock()
        oss_service.upload_file.return_value = {"success": True, "data": {}}
        slide_service = MagicMock()
        slide_service.check_space_permission.return_value = True
        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch("apps.tabslide.api._build_service", return_value=slide_service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch("apps.tabslide.tasks.import_pptx_oss_task.delay",
                   return_value=SimpleNamespace(id="task-small")):
            resp = slide_api.import_pptx(
                self.request,
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
                file=self._make_normal_file(),
            )
        self.assertEqual(_status(resp), 200)

    def test_service_import_pptx_streaming_size_check(self):
        """service 层 import_pptx 应在流式写入时拒绝超大文件。"""
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=self.owner)
        chunk_5mb = b"A" * (5 * 1024 * 1024)
        chunks = iter([chunk_5mb] * 12)  # 60MB total

        with patch.object(svc, "check_space_permission", return_value=True):
            with self.assertRaises(ValueError) as ctx:
                svc.import_pptx(
                    organization_id=str(self.organization.id),
                    space_id=str(self.space.id),
                    file_name="huge.pptx",
                    file_chunks=chunks,
                    max_size=50 * 1024 * 1024,
                )
            self.assertIn("50MB", str(ctx.exception))

    def test_import_pptx_null_size_passes_to_service(self):
        """file.size 为 None 时（某些 proxy 场景）不在 API 层拦截，由 service 层兜底。"""
        fake_file = MagicMock()
        fake_file.name = "unknown.pptx"
        fake_file.size = None
        fake_file.read.return_value = b"PK\x03\x04"
        fake_file.chunks.return_value = iter([b"x" * 1024])

        oss_service = MagicMock()
        oss_service.upload_file.return_value = {"success": True, "data": {}}
        slide_service = MagicMock()
        slide_service.check_space_permission.return_value = True
        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch("apps.tabslide.api._build_service", return_value=slide_service), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch("apps.tabslide.tasks.import_pptx_oss_task.delay",
                   return_value=SimpleNamespace(id="task-unknown")):
            resp = slide_api.import_pptx(
                self.request,
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
                file=fake_file,
            )
        self.assertEqual(_status(resp), 200)


# ─────────────────────────────────────────────────────────────────────────────
# J3-02: preview_service content XSS 净化
# ─────────────────────────────────────────────────────────────────────────────


class SanitizeContentHtmlTests(TestCase):
    """J3-02: _sanitize_content_html 应移除所有 XSS 载荷。"""

    def test_strips_script_tags(self):
        html = '<p>Hello</p><script>alert("xss")</script><p>World</p>'
        result = _sanitize_content_html(html)
        self.assertNotIn("<script", result)
        self.assertNotIn("alert", result)
        self.assertIn("<p>Hello</p>", result)
        self.assertIn("<p>World</p>", result)

    def test_strips_script_tags_case_insensitive(self):
        html = '<SCRIPT>document.cookie</SCRIPT>'
        result = _sanitize_content_html(html)
        self.assertNotIn("SCRIPT", result)
        self.assertNotIn("document.cookie", result)

    def test_strips_iframe_tags(self):
        html = '<p>ok</p><iframe src="evil.com"></iframe>'
        result = _sanitize_content_html(html)
        self.assertNotIn("<iframe", result)
        self.assertIn("<p>ok</p>", result)

    def test_strips_event_handlers(self):
        html = '<div onmouseover="alert(1)" onclick="steal()">text</div>'
        result = _sanitize_content_html(html)
        self.assertNotIn("onmouseover", result)
        self.assertNotIn("onclick", result)
        self.assertIn("text", result)

    def test_strips_javascript_protocol_href(self):
        html = '<a href="javascript:alert(1)">link</a>'
        result = _sanitize_content_html(html)
        self.assertNotIn("javascript:", result)
        self.assertIn("link", result)

    def test_strips_form_tags(self):
        html = '<form action="evil.com"><input type="text"></form>'
        result = _sanitize_content_html(html)
        self.assertNotIn("<form", result)
        self.assertNotIn("<input", result)

    def test_strips_meta_tag(self):
        html = '<meta http-equiv="refresh" content="0;url=evil.com">'
        result = _sanitize_content_html(html)
        self.assertNotIn("<meta", result)

    def test_strips_embed_object(self):
        html = '<embed src="evil.swf"><object data="evil.swf"></object>'
        result = _sanitize_content_html(html)
        self.assertNotIn("<embed", result)
        self.assertNotIn("<object", result)

    def test_preserves_safe_formatting(self):
        html = '<span style="color:red"><b>Bold</b> <i>Italic</i></span>'
        result = _sanitize_content_html(html)
        self.assertEqual(result, html)

    def test_preserves_br_tags(self):
        html = 'Line 1<br/>Line 2<br>Line 3'
        result = _sanitize_content_html(html)
        self.assertEqual(result, html)

    def test_empty_string_passthrough(self):
        self.assertEqual(_sanitize_content_html(""), "")

    def test_none_returns_empty_string(self):
        self.assertEqual(_sanitize_content_html(None), "")

    def test_combined_xss_payload(self):
        html = (
            '<span>Safe</span>'
            '<script>alert(1)</script>'
            '<img src=x onerror="alert(2)">'
            '<a href="javascript:void(0)">click</a>'
            '<form><input></form>'
        )
        result = _sanitize_content_html(html)
        self.assertNotIn("<script", result)
        self.assertNotIn("onerror", result)
        self.assertNotIn("javascript:", result)
        self.assertNotIn("<form", result)
        self.assertNotIn("<input", result)
        self.assertIn("<span>Safe</span>", result)


class PreviewServiceXssRenderTests(TestCase):
    """J3-02: preview_service 渲染函数应净化用户内容。"""

    def test_text_element_sanitizes_script(self):
        el = {
            "id": "t1",
            "type": "text",
            "content": '<p>Hello</p><script>alert("xss")</script>',
            "defaultFontSize": 16,
        }
        html = _render_text_element(el, "left:0;top:0;", 'data-element-id="t1"')
        self.assertNotIn("<script", html)
        self.assertIn("<p>Hello</p>", html)

    def test_text_element_sanitizes_event_handler(self):
        el = {
            "id": "t2",
            "type": "text",
            "content": '<div onload="steal()">text</div>',
        }
        html = _render_text_element(el, "", "")
        self.assertNotIn("onload", html)
        self.assertIn("text", html)

    def test_shape_text_sanitizes_script(self):
        el = {
            "id": "s1",
            "type": "shape",
            "fill": "#ccc",
            "text": {
                "content": '<b>Title</b><script>evil()</script>',
                "defaultFontSize": 14,
            },
        }
        html = _render_shape_element(el, "left:0;", 'data-element-id="s1"')
        self.assertNotIn("<script", html)
        self.assertIn("<b>Title</b>", html)

    def test_table_cell_sanitizes_script(self):
        el = {
            "id": "tbl1",
            "type": "table",
            "data": [
                [{"text": '<script>alert(1)</script>Safe text'}],
            ],
        }
        html = _render_table_element(el, "left:0;", 'data-element-id="tbl1"')
        self.assertNotIn("<script", html)
        self.assertIn("Safe text", html)

    def test_table_richtext_sanitizes(self):
        el = {
            "id": "tbl2",
            "type": "table",
            "data": [
                [{"richText": '<b>Bold</b><iframe src="evil.com"></iframe>'}],
            ],
        }
        html = _render_table_element(el, "", "")
        self.assertNotIn("<iframe", html)
        self.assertIn("<b>Bold</b>", html)

    def test_build_slide_html_safe_with_xss_elements(self):
        elements = [
            {
                "id": "xss1",
                "type": "text",
                "left": 100,
                "top": 100,
                "width": 400,
                "height": 200,
                "content": '<p>OK</p><script>document.cookie</script>',
            },
            {
                "id": "xss2",
                "type": "shape",
                "left": 500,
                "top": 100,
                "width": 200,
                "height": 200,
                "fill": "#eee",
                "text": {"content": '<img src=x onerror="alert(1)">'},
            },
            {
                "id": "xss3",
                "type": "table",
                "left": 100,
                "top": 400,
                "width": 600,
                "height": 300,
                "data": [
                    [{"text": "Header<script>bad()</script>"}],
                    [{"text": "Cell<form><input></form>"}],
                ],
            },
        ]
        html = build_slide_html(elements)
        # No dangerous tags should survive in rendered HTML
        self.assertNotIn("<script>document.cookie</script>", html)
        self.assertNotIn("onerror", html)
        self.assertNotIn("<form>", html)
        self.assertNotIn("<input>", html)
        self.assertIn("<p>OK</p>", html)

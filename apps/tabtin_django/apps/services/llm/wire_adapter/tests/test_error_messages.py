"""error_messages 模板表 + render_error 行为测试。

覆盖三类:
1. 9 个 W0 必备 key 在表中存在(防止后续误删)
2. render_error 渲染填值正确 + fallback 链工作
3. 占位符缺失时不抛 KeyError(用户看得到友好兜底,不是 stack trace)
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter import (
    ERROR_TEMPLATES,
    ImageFetchError,
    render_error,
)


REQUIRED_W0_KEYS = [
    ("upstream", "*", "4xx"),
    ("upstream", "*", "5xx"),
    ("billing", "*", "budget_exceeded"),
    ("billing", "*", "freeze_failed"),
    ("system_routing", "*", "model_not_found"),
    ("system_routing", "*", "key_unavailable"),
    ("system_routing", "*", "missing_organization_id"),
    ("image_fetch", "image", "timeout"),
    ("image_fetch", "image", "http_error"),
]


class TestRequiredKeysExist(SimpleTestCase):
    """北极星指标:W0 至少 9 个 key 在 ERROR_TEMPLATES 中。"""

    def test_all_required_keys_present(self):
        missing = [k for k in REQUIRED_W0_KEYS if k not in ERROR_TEMPLATES]
        self.assertEqual(
            missing,
            [],
            f"以下 W0 必备 key 缺失: {missing}",
        )

    def test_at_least_9_keys(self):
        # 副指标 3:模板表至少 9 个 key
        self.assertGreaterEqual(len(ERROR_TEMPLATES), 9)


class TestRenderError(SimpleTestCase):
    """render_error 渲染 + fallback 链行为。"""

    def test_image_fetch_timeout_renders_host_and_timeout(self):
        user_msg, tech = render_error(
            "image_fetch", "image", "timeout",
            host="oss.example.com",
            timeout=5.0,
        )
        # 中文文案 + 主机名 + 超时秒数
        self.assertIn("oss.example.com", user_msg)
        self.assertIn("5.0", user_msg)
        self.assertIn("超时", user_msg)
        # technical_detail 含 stage / reason / vars
        self.assertIn("stage=image_fetch", tech)
        self.assertIn("reason=timeout", tech)
        self.assertIn("host=oss.example.com", tech)

    def test_image_fetch_http_error_renders_status(self):
        user_msg, _ = render_error(
            "image_fetch", "image", "http_error",
            host="oss.example.com",
            status=404,
        )
        self.assertIn("oss.example.com", user_msg)
        self.assertIn("404", user_msg)

    def test_upstream_4xx_capability_wildcard_fallback(self):
        """`(upstream, image, 4xx)` 不存在,应 fallback 到 `(upstream, *, 4xx)`。"""
        user_msg, _ = render_error(
            "upstream", "image", "4xx",
            status=400,
        )
        self.assertIn("400", user_msg)
        self.assertIn("上游", user_msg)

    def test_upstream_5xx_fallback(self):
        user_msg, _ = render_error(
            "upstream", "*", "5xx",
            status=502,
        )
        self.assertIn("502", user_msg)
        self.assertIn("上游", user_msg)

    def test_budget_exceeded(self):
        user_msg, _ = render_error("billing", "*", "budget_exceeded")
        self.assertIn("预算", user_msg)

    def test_freeze_failed(self):
        user_msg, _ = render_error("billing", "*", "freeze_failed")
        self.assertIn("余额", user_msg)

    def test_model_not_found_renders_model_name(self):
        user_msg, _ = render_error(
            "system_routing", "*", "model_not_found",
            model_name="claude-sonnet-4.5",
        )
        self.assertIn("claude-sonnet-4.5", user_msg)
        self.assertIn("不存在", user_msg)

    def test_key_unavailable(self):
        user_msg, _ = render_error("system_routing", "*", "key_unavailable")
        self.assertIn("Key", user_msg)

    def test_missing_organization_id(self):
        user_msg, _ = render_error("system_routing", "*", "missing_organization_id")
        # W0-fix:文案改为中文「组织」(原断言 'Organization' 是 stale 英文)
        self.assertIn("组织", user_msg)

    def test_unknown_stage_returns_safe_fallback(self):
        """未知 stage/reason 不应抛异常,而是返回兜底文案。"""
        user_msg, tech = render_error("never_seen_stage", "*", "wat")
        self.assertIn("never_seen_stage", user_msg)
        self.assertIn("wat", user_msg)
        # 不能崩,而是给可读的中文兜底
        self.assertIn("失败", user_msg)

    def test_missing_placeholder_does_not_raise(self):
        """模板里有 {host} 但 caller 没传 host,不应 KeyError + 不留未渲染占位符。

        产品视角:缺 host 时,_safe_vars 兜底"未知",用户看到"主机：未知"
        比"主机：{host}"更友好;占位符泄露到 user_msg 反而是 bug 的标识。
        """
        try:
            user_msg, tech = render_error("image_fetch", "image", "timeout", timeout=5.0)
        except KeyError:
            self.fail("render_error 不应在缺占位符时抛 KeyError")
        # 不应留 {host} 字面量(_safe_vars 兜底替换了)
        self.assertNotIn("{host}", user_msg)
        # 应渲染出"主机：未知"友好兜底
        self.assertIn("未知", user_msg)
        # technical_detail 不掩盖事实:caller 没传 host 这条信息可被 admin 看到
        # (technical_detail 仅含 caller 主动传的 vars,host 缺失即不出现)
        self.assertNotIn("host=", tech)

    def test_too_many_images_states_max_count_not_overage(self):
        """#7834：文案写出上限本身；14 张超限 10 时不得让人读成「上限=4」。"""
        user_msg, _ = render_error(
            "image_fetch", "image", "too_many_images",
            total_count=14,
            failed_count=4,  # 超额张数；上限应由 render_error 推成 10
        )
        self.assertIn("包含 14 张图片", user_msg)
        self.assertIn("超过单次上限 10 张", user_msg)
        self.assertIn("减少到 10 张以内", user_msg)
        self.assertNotIn("4 张超过单次上限", user_msg)
        self.assertNotIn("{max_count}", user_msg)


class TestImageFetchError(SimpleTestCase):
    """ImageFetchError 错误类型字段。"""

    def test_default_status_is_502(self):
        err = ImageFetchError(user_message="test")
        self.assertEqual(err.status, 502)
        self.assertEqual(err.error_code, "image_fetch_failed")

    def test_carries_user_message_and_tech_detail(self):
        err = ImageFetchError(
            user_message="图片下载超时",
            technical_detail="stage=image_fetch reason=timeout",
            status=504,
        )
        self.assertEqual(err.user_message, "图片下载超时")
        self.assertEqual(err.technical_detail, "stage=image_fetch reason=timeout")
        self.assertEqual(err.status, 504)
        # super().__init__(user_message) → str(err) 是 user_message
        self.assertEqual(str(err), "图片下载超时")

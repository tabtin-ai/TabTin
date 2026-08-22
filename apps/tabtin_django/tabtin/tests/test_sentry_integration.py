"""tabtin/sentry.py 单测：tags 白名单注入 + 脱敏红线 + DSN 空则禁用。

契约来源：docs/agent/error-context-schema.md。
纯函数测试，不依赖 DB / 不要求 sentry-sdk 已安装。
"""

from unittest import mock

from django.test import SimpleTestCase

import tabtin.sentry as sentry_module
from tabtin.sentry import (
    _RATE_LIMIT_MAX,
    _rate_limited,
    capture_api_exception,
    collect_context_tags,
    init_sentry,
    resolve_sentry_initial_scope,
    resolve_sentry_release,
    resolve_sentry_environment,
    scrub_event,
    scrub_text,
)


class ScrubTextTests(SimpleTestCase):
    """脱敏规则与 Electron 诊断包 diagnostics-redact.ts 对齐。"""

    def test_bearer_token_redacted(self):
        out = scrub_text("Authorization: Bearer abcdef1234567890")
        self.assertNotIn("abcdef1234567890", out)
        self.assertIn("<redacted>", out)

    def test_key_value_secret_redacted(self):
        out = scrub_text('{"access_token": "sk-verysecretvalue"}')
        self.assertNotIn("sk-verysecretvalue", out)

    def test_jwt_redacted(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123"
        self.assertNotIn(jwt, scrub_text(f"token dump: {jwt}"))

    def test_phone_masked(self):
        out = scrub_text("用户 13812345678 反馈")
        self.assertNotIn("13812345678", out)
        self.assertIn("138****5678", out)

    def test_email_masked(self):
        out = scrub_text("contact someone@example.com now")
        self.assertNotIn("someone@example.com", out)
        self.assertIn("s***@example.com", out)

    def test_home_dir_username_masked(self):
        self.assertIn("/Users/<user>/proj", scrub_text("/Users/alice/proj"))
        self.assertIn("/home/<user>/proj", scrub_text("/home/alice/proj"))

    def test_empty_and_none_safe(self):
        self.assertEqual(scrub_text(""), "")
        self.assertEqual(scrub_text(None), "")  # type: ignore[arg-type]


class CollectContextTagsTests(SimpleTestCase):
    """业务 tags 从平台 ContextVar 收集，空值不上报。"""

    def test_empty_context_yields_no_tags(self):
        self.assertEqual(collect_context_tags(), {})

    def test_context_vars_become_tags(self):
        from apps.services.common import platform_context, thread_context

        thread_context.set_current_organization_id("wt-1")
        thread_context.set_current_space_id("sp-2")
        thread_context.set_current_execution_agent_id("ag-3")
        run_token = platform_context.set_current_run_id("run-4")
        session_token = platform_context.set_current_session_id("sess-5")
        try:
            tags = collect_context_tags()
        finally:
            thread_context.set_current_organization_id(None)
            thread_context.set_current_space_id(None)
            thread_context.set_current_execution_agent_id(None)
            platform_context.reset_current_run_id(run_token)
            platform_context.reset_current_session_id(session_token)

        self.assertEqual(
            tags,
            {
                "organization_id": "wt-1",
                "space_id": "sp-2",
                "agent_id": "ag-3",
                "run_id": "run-4",
                "session_id": "sess-5",
            },
        )


class ScrubEventTests(SimpleTestCase):
    """before_send 钩子：白名单 tags 注入 + 事件各部位脱敏 + 请求体不出境。"""

    def setUp(self):
        sentry_module._fingerprint_hits.clear()

    def test_message_and_exception_scrubbed(self):
        event = {
            "message": "login failed for 13812345678",
            "exception": {
                "values": [
                    {"type": "ValueError", "value": "token=abcdSECRETvalue in payload"}
                ]
            },
        }
        out = scrub_event(event)
        self.assertNotIn("13812345678", out["message"])
        self.assertNotIn("abcdSECRETvalue", out["exception"]["values"][0]["value"])

    def test_breadcrumbs_scrubbed(self):
        event = {
            "breadcrumbs": {
                "values": [
                    {
                        "message": "GET /api?access_token=verysecret123",
                        "data": {
                            "url": "/api?access_token=verysecret123",
                            "status_code": 500,
                        },
                    }
                ]
            }
        }
        out = scrub_event(event)
        crumb = out["breadcrumbs"]["values"][0]
        self.assertNotIn("verysecret123", crumb["message"])
        self.assertNotIn("verysecret123", crumb["data"]["url"])
        self.assertEqual(crumb["data"]["status_code"], 500)

    def test_request_body_dropped(self):
        event = {
            "request": {
                "url": "http://x/api",
                "data": {"password": "hunter22"},
                "query_string": "phone=13812345678",
            }
        }
        out = scrub_event(event)
        self.assertNotIn("data", out["request"])
        self.assertNotIn("13812345678", out["request"]["query_string"])

    def test_context_tags_injected_without_overwriting(self):
        from apps.services.common import platform_context

        token = platform_context.set_current_run_id("run-9")
        try:
            out = scrub_event({"tags": {"run_id": "explicit"}})
            self.assertEqual(out["tags"]["run_id"], "explicit")
            out2 = scrub_event({})
            self.assertEqual(out2["tags"]["run_id"], "run-9")
        finally:
            platform_context.reset_current_run_id(token)


class RateLimitTests(SimpleTestCase):
    """同指纹限频：兜住 capture_message 类调用点被 DSN 激活后刷屏。"""

    def setUp(self):
        sentry_module._fingerprint_hits.clear()

    def tearDown(self):
        sentry_module._fingerprint_hits.clear()

    def test_same_fingerprint_dropped_after_limit(self):
        event = {"message": "[RelayMessageWriter] silent drop: widget_skip"}
        for _ in range(_RATE_LIMIT_MAX):
            self.assertFalse(_rate_limited(dict(event)))
        self.assertTrue(_rate_limited(dict(event)))

    def test_different_fingerprints_independent(self):
        for _ in range(_RATE_LIMIT_MAX):
            self.assertFalse(_rate_limited({"message": "flood A"}))
        self.assertFalse(_rate_limited({"message": "unrelated B"}))

    def test_window_expiry_resets_count(self):
        now = 1000.0
        event = {"message": "flood"}
        for _ in range(_RATE_LIMIT_MAX):
            self.assertFalse(_rate_limited(dict(event), now=now))
        self.assertTrue(_rate_limited(dict(event), now=now))
        self.assertFalse(
            _rate_limited(dict(event), now=now + sentry_module._RATE_LIMIT_WINDOW_S)
        )

    def test_scrub_event_returns_none_when_limited(self):
        event = {"message": "spam spam spam"}
        for _ in range(_RATE_LIMIT_MAX):
            self.assertIsNotNone(scrub_event(dict(event)))
        self.assertIsNone(scrub_event(dict(event)))

    def test_exception_fingerprint_uses_type_and_value(self):
        exc_event = {
            "exception": {"values": [{"type": "ValueError", "value": "boom"}]},
            "message": "ignored-when-exception-present",
        }
        for _ in range(_RATE_LIMIT_MAX):
            self.assertFalse(_rate_limited(dict(exc_event)))
        self.assertTrue(_rate_limited(dict(exc_event)))
        # 同 message 不同异常 → 不同指纹，不受影响
        other = {
            "exception": {"values": [{"type": "KeyError", "value": "boom"}]},
        }
        self.assertFalse(_rate_limited(other))


class InitSentryTests(SimpleTestCase):
    def test_source_sha_is_attached_to_every_django_event(self):
        """告警 relay 以此回到实际部署版本做 blame，不能依赖 Sentry 猜提交。"""
        with mock.patch.dict(
            "os.environ",
            {
                "SENTRY_DSN": "https://public@example.invalid/1",
                "SENTRY_ENVIRONMENT": "test",
                "TABTIN_SOURCE_SHA": "28d527e93bf3ed10337484f44a38684f862ce77b",
                "SENTRY_RELEASE": "",
            },
            clear=False,
        ), mock.patch.dict(
            "sys.modules", {"sentry_sdk": mock.Mock()}, clear=False
        ):
            release = resolve_sentry_release()
            scope = resolve_sentry_initial_scope()

        self.assertEqual(release, "tabtin-django@28d527e93bf3ed10337484f44a38684f862ce77b")
        self.assertEqual(scope["tags"]["source_sha"], "28d527e93bf3ed10337484f44a38684f862ce77b")

    def test_environment_contract_accepts_legacy_test_and_governed_environments(self):
        for environment in ("test", "test-new", "production"):
            with self.subTest(environment=environment):
                with mock.patch.dict(
                    "os.environ", {"SENTRY_ENVIRONMENT": environment}, clear=False
                ):
                    self.assertEqual(resolve_sentry_environment(), environment)

        with mock.patch.dict(
            "os.environ", {"SENTRY_ENVIRONMENT": "prod"}, clear=False
        ):
            with self.assertRaisesRegex(ValueError, "test-new.*production"):
                resolve_sentry_environment()

    def test_environment_defaults_follow_debug_mode(self):
        with mock.patch.dict(
            "os.environ", {"SENTRY_ENVIRONMENT": "", "DEBUG": "True"}, clear=False
        ):
            self.assertEqual(resolve_sentry_environment(), "test-new")
        with mock.patch.dict(
            "os.environ", {"SENTRY_ENVIRONMENT": "", "DEBUG": "False"}, clear=False
        ):
            self.assertEqual(resolve_sentry_environment(), "production")

    def test_disabled_without_dsn(self):
        with mock.patch.dict("os.environ", {"SENTRY_DSN": ""}):
            self.assertFalse(init_sentry())

    def test_initializes_without_unsupported_initial_scope_option(self):
        """旧版 sentry-sdk 也必须能启动，部署 SHA 仍需要作为 tag 上报。"""
        sdk = mock.Mock()
        django_integration = mock.Mock()
        celery_integration = mock.Mock()
        modules = {
            "sentry_sdk": sdk,
            "sentry_sdk.integrations": mock.Mock(),
            "sentry_sdk.integrations.django": mock.Mock(DjangoIntegration=django_integration),
            "sentry_sdk.integrations.celery": mock.Mock(CeleryIntegration=celery_integration),
        }
        with mock.patch.dict(
            "os.environ",
            {
                "SENTRY_DSN": "https://public@example.invalid/1",
                "SENTRY_ENVIRONMENT": "test-new",
                "TABTIN_SOURCE_SHA": "28d527e93bf3ed10337484f44a38684f862ce77b",
            },
            clear=False,
        ), mock.patch.dict("sys.modules", modules, clear=False), mock.patch.object(
            sentry_module, "_initialized", False
        ):
            self.assertTrue(init_sentry())

        self.assertNotIn("initial_scope", sdk.init.call_args.kwargs)
        sdk.set_tag.assert_called_once_with(
            "source_sha", "28d527e93bf3ed10337484f44a38684f862ce77b"
        )

    def test_capture_is_noop_when_disabled(self):
        # 未初始化时不抛异常、不产生副作用（ninja handler 每个 500 都会调）
        request = mock.Mock()
        capture_api_exception(request, RuntimeError("boom"))

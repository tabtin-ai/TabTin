"""R5-03 修复验证：tabtin.otel_init.setup_otel 契约。

测试矩阵：
    1. 未设 OTEL_EXPORTER_OTLP_ENDPOINT → setup_otel 返回 False，不注册 SDK
    2. 设了 endpoint + SDK 已装 → setup 注册 TracerProvider + BatchSpanProcessor
    3. setup 是 idempotent（多次调只 install 一次）
    4. setup 失败时 swallow，不让进程启动崩
    5. wsgi.py / asgi.py / celery.py 都在 Django 业务前调 setup_otel
       （静态扫描断言）
    6. requirements.txt 含 opentelemetry-api / sdk / exporter-otlp-proto-grpc 三件套
"""
from __future__ import annotations

import inspect
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from tabtin import otel_init


class SetupOtelDisabledTests(SimpleTestCase):
    """env 未设 OTEL_EXPORTER_OTLP_ENDPOINT → 不调任何 OTel 注册。"""

    def setUp(self):
        otel_init.reset_for_test()

    def test_no_endpoint_returns_false(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": ""}, clear=False):
            self.assertFalse(otel_init.setup_otel())
            self.assertFalse(otel_init.is_installed())

    def test_endpoint_whitespace_treated_as_empty(self):
        """`endpoint='   '` 也按未设处理（容错环境变量误填空格）。"""
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "   "}):
            self.assertFalse(otel_init.setup_otel())


class SetupOtelEnabledTests(SimpleTestCase):
    """env 设了 endpoint → 真注册 SDK（用 mock 确认调用链）。"""

    def setUp(self):
        otel_init.reset_for_test()

    def test_endpoint_registers_tracer_provider(self):
        with patch.dict(os.environ, {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4317",
            "OTEL_SERVICE_NAME": "tabtin-django-test",
        }):
            with patch("opentelemetry.trace.set_tracer_provider") as set_mock, \
                 patch("opentelemetry.sdk.trace.TracerProvider") as tp_mock, \
                 patch("opentelemetry.sdk.trace.export.BatchSpanProcessor") as bsp_mock, \
                 patch(
                     "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter"
                 ) as exporter_mock:
                provider = MagicMock()
                tp_mock.return_value = provider

                ok = otel_init.setup_otel()

                self.assertTrue(ok)
                self.assertTrue(otel_init.is_installed())
                tp_mock.assert_called_once()  # TracerProvider() 被实例化
                exporter_mock.assert_called_once()  # OTLPSpanExporter 被实例化
                bsp_mock.assert_called_once()
                provider.add_span_processor.assert_called_once()
                set_mock.assert_called_once_with(provider)

    def test_idempotent_install_called_only_once(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4317"}):
            with patch("opentelemetry.trace.set_tracer_provider") as set_mock, \
                 patch("opentelemetry.sdk.trace.TracerProvider"), \
                 patch("opentelemetry.sdk.trace.export.BatchSpanProcessor"), \
                 patch(
                     "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter"
                 ):
                self.assertTrue(otel_init.setup_otel())
                self.assertTrue(otel_init.setup_otel())  # 第二次不应再注册
                self.assertTrue(otel_init.setup_otel())
                set_mock.assert_called_once()  # 只设一次

    def test_http_protocol_path_supported(self):
        """OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf 时走 http exporter。

        本环境只装了 grpc exporter（默认）；http exporter 包未必装上。
        本测试只断言：当环境变量切到 http 时，setup_otel **会尝试** import http exporter，
        缺包时优雅返回 False（不让进程崩）。
        """
        with patch.dict(os.environ, {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318/v1/traces",
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        }):
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # noqa: F401
                    OTLPSpanExporter as _HTTPExp,
                )
                _http_available = True
            except ImportError:
                _http_available = False

            if _http_available:
                with patch("opentelemetry.trace.set_tracer_provider"), \
                     patch("opentelemetry.sdk.trace.TracerProvider"), \
                     patch("opentelemetry.sdk.trace.export.BatchSpanProcessor"), \
                     patch(
                         "opentelemetry.exporter.otlp.proto.http.trace_exporter.OTLPSpanExporter"
                     ) as http_exporter_mock:
                    self.assertTrue(otel_init.setup_otel())
                    http_exporter_mock.assert_called_once()
            else:
                # http 包没装 → setup 应返回 False 但不 raise
                ok = otel_init.setup_otel()
                self.assertFalse(ok)
                self.assertFalse(otel_init.is_installed())

    def test_setup_failure_swallowed_returns_false(self):
        """exporter 抛异常时不让进程启动崩，返回 False + log error。"""
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x"}):
            with patch(
                "opentelemetry.sdk.trace.TracerProvider",
                side_effect=Exception("simulated SDK init failure"),
            ):
                ok = otel_init.setup_otel()
                self.assertFalse(ok)
                self.assertFalse(otel_init.is_installed())


class EntrypointBootstrapTests(SimpleTestCase):
    """wsgi.py / asgi.py / celery.py 必须在 Django 业务模块 import 前调 setup_otel。"""

    BASE = Path(__file__).resolve().parents[3]  # apps/tabtin_django

    def test_wsgi_calls_setup_otel_before_get_wsgi_application(self):
        path = self.BASE / "tabtin" / "wsgi.py"
        src = path.read_text()
        idx_setup = src.find("setup_otel()")
        # 真实业务调用：`application = get_wsgi_application()`
        idx_get_wsgi = src.find("application = get_wsgi_application()")
        self.assertGreater(idx_setup, 0, "wsgi.py 缺 setup_otel() 调用")
        self.assertGreater(idx_get_wsgi, 0, "wsgi.py 缺 application = get_wsgi_application() 调用")
        self.assertLess(
            idx_setup, idx_get_wsgi,
            "wsgi.py 必须在 application = get_wsgi_application() 之前调 setup_otel；"
            "否则业务模块缓存的 tracer 仍是 NoOp",
        )

    def test_asgi_calls_setup_otel_before_get_asgi_application(self):
        path = self.BASE / "tabtin" / "asgi.py"
        src = path.read_text()
        idx_setup = src.find("setup_otel()")
        # 真实业务调用：`django_asgi_app = get_asgi_application()`
        idx_get_asgi = src.find("django_asgi_app = get_asgi_application()")
        self.assertGreater(idx_setup, 0, "asgi.py 缺 setup_otel() 调用")
        self.assertGreater(
            idx_get_asgi, 0,
            "asgi.py 缺 django_asgi_app = get_asgi_application() 调用",
        )
        self.assertLess(
            idx_setup, idx_get_asgi,
            "asgi.py 必须在 django_asgi_app = get_asgi_application() 之前调 setup_otel",
        )

    def test_celery_calls_setup_otel_before_celery_app_creation(self):
        path = self.BASE / "tabtin" / "celery.py"
        src = path.read_text()
        idx_setup = src.find("setup_otel()")
        idx_celery_app = src.find("app = Celery(")
        self.assertGreater(idx_setup, 0, "celery.py 缺 setup_otel() 调用")
        self.assertLess(
            idx_setup, idx_celery_app,
            "celery.py 必须在 Celery() 实例化之前调 setup_otel；"
            "Celery worker 是 flush_outbox / FC 的 trace 来源",
        )


class RequirementsTests(SimpleTestCase):
    """requirements.txt 必须含 OTel 三件套（api / sdk / exporter-otlp-proto-grpc）。"""

    def test_requirements_lists_all_otel_packages(self):
        path = (
            Path(__file__).resolve().parents[3] / "requirements.txt"
        )
        content = path.read_text()
        for pkg in (
            "opentelemetry-api",
            "opentelemetry-sdk",
            "opentelemetry-exporter-otlp-proto-grpc",
        ):
            self.assertIn(
                pkg, content,
                f"requirements.txt 缺 {pkg}；R5-03 上线前 OTel exporter 不可用",
            )

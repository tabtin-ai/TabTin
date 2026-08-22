"""R5-21 修复验证：Prometheus metrics multi-process 配置。

测试矩阵：
    1. 单进程模式（默认）— metrics_view 走 generate_latest()，行为不变
    2. Multi-process 模式（env PROMETHEUS_MULTIPROC_DIR 注入）—
       _collect_metrics_payload 自动用 MultiProcessCollector
    3. multiprocess 模式异常 fallback 不崩 endpoint
    4. fts/metrics.py 所有 Gauge 都已声明 multiprocess_mode
       （R5-21 启用前提：缺这个属性会让 multi-process 启动 raise）
    5. ws/metrics.py 关键 Gauge 也已声明 multiprocess_mode
       （历史代码补齐；否则全局 metrics 端点会因为 ws_connections_total raise）
    6. settings.py 早期处理 PROMETHEUS_MULTIPROC_DIR 自动 mkdir
"""
from __future__ import annotations

import inspect
import os
import tempfile
from unittest.mock import MagicMock, patch

from django.test import RequestFactory, SimpleTestCase

from apps.services.common.ws import metrics as ws_metrics_mod


class CollectMetricsPayloadTests(SimpleTestCase):
    """`_collect_metrics_payload` 在两种模式下的行为。"""

    def test_single_process_uses_generate_latest(self):
        """无 PROMETHEUS_MULTIPROC_DIR → 走默认 generate_latest（不动 REGISTRY）。"""
        with patch.dict(os.environ, {"PROMETHEUS_MULTIPROC_DIR": ""}, clear=False):
            with patch.object(
                ws_metrics_mod, "generate_latest", return_value=b"# HELP single\n",
            ) as gen_mock:
                payload = ws_metrics_mod._collect_metrics_payload()
                gen_mock.assert_called_once_with()  # 不传 registry 即默认
        self.assertEqual(payload, b"# HELP single\n")

    def test_multiproc_uses_multiprocess_collector(self):
        """env 注入 → _collect_metrics_payload 用 MultiProcessCollector + 自定义 registry。"""
        with patch.dict(os.environ, {"PROMETHEUS_MULTIPROC_DIR": "/tmp/tabtin_multiproc_test"}):
            with patch.object(
                ws_metrics_mod, "generate_latest", return_value=b"# HELP multi\n",
            ) as gen_mock, patch(
                "prometheus_client.multiprocess.MultiProcessCollector"
            ) as mpc_mock, patch(
                "prometheus_client.CollectorRegistry"
            ) as registry_mock:
                fake_registry = MagicMock()
                registry_mock.return_value = fake_registry

                payload = ws_metrics_mod._collect_metrics_payload()

                # MultiProcessCollector(registry) 必须真调
                mpc_mock.assert_called_once_with(fake_registry)
                # generate_latest 必须传入 registry 参数（与单进程行为不同）
                gen_mock.assert_called_once_with(fake_registry)
        self.assertEqual(payload, b"# HELP multi\n")

    def test_multiproc_collector_failure_falls_back_safely(self):
        """MultiProcessCollector 异常 → 不崩 endpoint，fallback 到默认 generate_latest。"""
        with patch.dict(os.environ, {"PROMETHEUS_MULTIPROC_DIR": "/tmp/x"}):
            with patch(
                "prometheus_client.multiprocess.MultiProcessCollector",
                side_effect=Exception("simulated multiproc dir broken"),
            ), patch.object(
                ws_metrics_mod, "generate_latest", return_value=b"# fallback\n",
            ) as gen_mock:
                payload = ws_metrics_mod._collect_metrics_payload()
        # 至少调了 fallback generate_latest（不传 registry）
        # 注意：异常路径下 generate_latest 只在最后调一次（不传 registry）
        self.assertGreater(gen_mock.call_count, 0)
        self.assertEqual(payload, b"# fallback\n")


class MetricsViewTests(SimpleTestCase):
    """metrics_view 端到端：localhost 不需要 token，token 必须正确。"""

    def setUp(self):
        self.factory = RequestFactory()

    def test_localhost_no_token_required(self):
        req = self.factory.get("/metrics/", REMOTE_ADDR="127.0.0.1")
        with patch.object(
            ws_metrics_mod, "_collect_metrics_payload", return_value=b"# OK\n",
        ):
            resp = ws_metrics_mod.metrics_view(req)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content, b"# OK\n")

    def test_external_ip_without_token_forbidden(self):
        req = self.factory.get("/metrics/", REMOTE_ADDR="1.2.3.4")
        # METRICS_TOKEN 默认 None，外网无法访问
        resp = ws_metrics_mod.metrics_view(req)
        self.assertEqual(resp.status_code, 403)


class GaugeMultiprocessModeTests(SimpleTestCase):
    """所有 Gauge 必须声明 multiprocess_mode；缺一个就让 multi-process 启动 raise。"""

    def test_fts_metrics_all_gauges_have_multiprocess_mode(self):
        """fts/metrics.py 的所有 Gauge 必须各自声明 multiprocess_mode。

        校验策略：对每个 `<NAME>: "Gauge" = Gauge(` 声明，取下一个空行
        （Gauge 块结束）之前的全部内容，断言 multiprocess_mode 关键字在内。
        """
        from apps.fts import metrics as fts_metrics

        if not getattr(fts_metrics, "_PROM_AVAILABLE", False):
            self.skipTest("prometheus_client 未装；跳过 multiprocess_mode 检查")

        src = inspect.getsource(fts_metrics)
        # 找所有 `<NAME>: "Gauge" = Gauge(` 声明位置
        import re
        pattern = re.compile(
            r'(?P<name>[A-Z_]+)\s*:\s*"Gauge"\s*=\s*Gauge\(', re.MULTILINE,
        )
        gauges = list(pattern.finditer(src))
        self.assertGreater(len(gauges), 0, "fts/metrics.py 找不到 Gauge 声明")

        for m in gauges:
            name = m.group("name")
            start = m.start()
            # 取该 Gauge 后接 800 字符（足够覆盖整个 Gauge( ... ) 调用）
            block = src[start : start + 800]
            # 用空行作为块结束标志（fts/metrics.py 每个 Gauge 后都有空行隔开）
            end_marker = block.find("\n\n")
            if end_marker > 0:
                block = block[:end_marker]
            self.assertIn(
                "multiprocess_mode",
                block,
                f"Gauge {name} 缺 multiprocess_mode；multi-process 启动会 raise",
            )

    def test_ws_metrics_critical_gauges_have_multiprocess_mode(self):
        """ws/metrics.py 的核心 Gauge（ws_connections_total / ws_subscription_count）
        也必须声明 multiprocess_mode。"""
        src = inspect.getsource(ws_metrics_mod)

        for gauge_name in ("ws_connections_total", "ws_subscription_count"):
            idx = src.find(f"{gauge_name} = Gauge(")
            self.assertGreater(idx, 0, f"找不到 Gauge {gauge_name}")
            # 取该 Gauge 调用块（找到闭合 ）
            block = src[idx : idx + 800]
            close = block.find(")")
            self.assertIn(
                "multiprocess_mode",
                block[:close],
                f"{gauge_name} 缺 multiprocess_mode；multi-process 启动会 raise",
            )


class SettingsBootstrapTests(SimpleTestCase):
    """settings.py 早期处理 PROMETHEUS_MULTIPROC_DIR 的代码必须在位。"""

    def test_settings_handles_prom_multiproc_dir_env(self):
        """settings.py 必须含 PROMETHEUS_MULTIPROC_DIR 处理逻辑（mkdir）；
        没这段，生产 K8s 注入 env 时 prometheus_client 会找不到目录直接 raise。"""
        import tabtin.settings as settings_mod

        src = inspect.getsource(settings_mod)
        self.assertIn(
            "PROMETHEUS_MULTIPROC_DIR",
            src,
            "settings.py 缺 PROMETHEUS_MULTIPROC_DIR 处理；R5-21 修复未完整落地",
        )
        self.assertIn(
            "os.makedirs",
            src,
            "settings.py 应在检测到 PROMETHEUS_MULTIPROC_DIR 时尝试 mkdir 兜底",
        )


class GunicornHooksTests(SimpleTestCase):
    """gunicorn.conf.py 必须有 when_ready / child_exit hook 接 multiproc。"""

    def test_gunicorn_config_has_required_hooks(self):
        from pathlib import Path

        path = (
            Path(__file__).resolve().parents[3]
            / "deployment"
            / "gunicorn.conf.py"
        )
        self.assertTrue(path.exists(), f"找不到 {path}")
        src = path.read_text()
        # when_ready 必须 mkdir（确保第一次启动也能 work）
        self.assertIn("PROMETHEUS_MULTIPROC_DIR", src)
        self.assertIn("when_ready", src)
        self.assertIn("shutil.rmtree", src)
        self.assertIn("os.makedirs", src)
        # child_exit 必须 mark_process_dead
        self.assertIn("child_exit", src)
        self.assertIn("mark_process_dead", src)

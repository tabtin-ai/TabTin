"""
manifest_opens fallback alert telemetry — Wave 7（W6 跨 Wave 收敛 §6.2 W6 review §9 #1）。

业务背景：``get_supported_resource_types`` 返回空集 = present_to_user 把 Agent
emit 的所有 resource_ref 全拒 = 用户视角"看不到任何 Agent 产物"。这是 PRD §6
标准 1"可见率 ≥ 80%" 灾难场景，必须有运维告警通路。

本测试只验证"告警分支真触发了"——不依赖真 sentry_sdk 后端，靠 logger 名 grep
+ caplog 抓断言（生产 ELK / Sentry 自动采集 ``manifest_opens.fallback_alert``
logger）。
"""
from __future__ import annotations

import logging
from pathlib import Path
from unittest.mock import patch

import pytest

from apps.services.common import manifest_opens


@pytest.fixture(autouse=True)
def _reset_lru_cache():
    """每个测试前清 lru_cache，避免上次测试的 frozenset 缓存污染本次断言。"""
    manifest_opens.reload_for_tests()
    yield
    manifest_opens.reload_for_tests()


# ─── 1. happy path：manifest 存在 → 不触发告警 ─────────────────────


def test_no_alert_when_manifest_returns_types(caplog: pytest.LogCaptureFixture):
    """真 manifest 加载成功 → 不应触发任何告警 logger。"""
    caplog.set_level(logging.CRITICAL, logger="manifest_opens.fallback_alert")
    types = manifest_opens.get_supported_resource_types()
    assert isinstance(types, frozenset)
    # 真实 manifest 至少 1 种（参照 W6 后端 manifest 驱动 ≥ 11 种）
    assert len(types) >= 1, f"manifest 必有 types，实际 {types}"
    # 没有任何 CRITICAL 告警进入 manifest_opens.fallback_alert logger
    alerts = [r for r in caplog.records if r.name == "manifest_opens.fallback_alert"]
    assert alerts == [], f"happy path 不应告警；实际 {alerts}"


# ─── 2. fallback path：manifest 全空 → 触发告警 ────────────────────


def test_alert_fires_when_apps_dir_missing(
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
):
    """指 _APPS_DIR 到不存在路径 → 返回空集 + CRITICAL 告警。"""
    fake_dir = tmp_path / "definitely_not_existing"
    caplog.set_level(logging.CRITICAL, logger="manifest_opens.fallback_alert")
    with patch.object(manifest_opens, "_APPS_DIR", fake_dir):
        manifest_opens.reload_for_tests()  # 清缓存让 patch 生效
        types = manifest_opens.get_supported_resource_types()

    assert types == frozenset()
    alerts = [r for r in caplog.records if r.name == "manifest_opens.fallback_alert"]
    assert len(alerts) == 1, f"应触发恰好 1 条告警；实际 {alerts}"
    alert = alerts[0]
    assert alert.levelno == logging.CRITICAL
    assert "manifest_opens.types_empty" in alert.getMessage()


def test_alert_fires_when_apps_dir_empty(
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
):
    """_APPS_DIR 存在但目录空 → 返回空集 + CRITICAL 告警。"""
    empty_dir = tmp_path / "empty_apps"
    empty_dir.mkdir()
    caplog.set_level(logging.CRITICAL, logger="manifest_opens.fallback_alert")
    with patch.object(manifest_opens, "_APPS_DIR", empty_dir):
        manifest_opens.reload_for_tests()
        types = manifest_opens.get_supported_resource_types()

    assert types == frozenset()
    alerts = [r for r in caplog.records if r.name == "manifest_opens.fallback_alert"]
    assert len(alerts) == 1


def test_alert_fires_when_manifests_have_no_opens_field(
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
):
    """manifest 存在但都没 opens 字段 → 返回空集 + 告警。

    这是 PRD §6 标准 1 灾难场景的最真实复现：app.json 文件本身存在但 opens
    字段都被误删（如 W2 manifest 改造时漏改 11 个之一）。
    """
    apps_dir = tmp_path / "apps"
    for app_id in ("tabdata", "tabdoc", "tabweb"):
        d = apps_dir / app_id
        d.mkdir(parents=True)
        # 故意没 opens 字段
        (d / "app.json").write_text(
            '{"id":"' + app_id + '","name":"' + app_id + '","kind":"app"}',
            encoding="utf-8",
        )
    caplog.set_level(logging.CRITICAL, logger="manifest_opens.fallback_alert")
    with patch.object(manifest_opens, "_APPS_DIR", apps_dir):
        manifest_opens.reload_for_tests()
        types = manifest_opens.get_supported_resource_types()

    assert types == frozenset()
    alerts = [r for r in caplog.records if r.name == "manifest_opens.fallback_alert"]
    assert len(alerts) == 1


def test_alert_includes_metric_tag(
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
):
    """告警 logger 必须含 ``metric=manifest_opens.types_empty`` 便于运维聚合。"""
    fake_dir = tmp_path / "missing"
    caplog.set_level(logging.CRITICAL, logger="manifest_opens.fallback_alert")
    with patch.object(manifest_opens, "_APPS_DIR", fake_dir):
        manifest_opens.reload_for_tests()
        manifest_opens.get_supported_resource_types()

    alerts = [r for r in caplog.records if r.name == "manifest_opens.fallback_alert"]
    assert len(alerts) == 1
    extra_metric = getattr(alerts[0], "metric", None) or alerts[0].__dict__.get("metric")
    # logger.critical(..., extra={"metric": ...}) → record.metric 直接挂在 record 对象
    assert extra_metric == "manifest_opens.types_empty", (
        f"告警必须带 metric tag 让 ELK / Sentry 按维度 group；实际 {extra_metric}"
    )


# ─── 3. lru_cache 行为：告警只触发一次（cache 后不重复） ───────────


def test_alert_does_not_repeat_within_cache(
    caplog: pytest.LogCaptureFixture,
    tmp_path: Path,
):
    """get_supported_resource_types 用 lru_cache → 第一次 miss 触发告警，第二次
    cache hit 不应重复告警（避免运维被同类告警刷屏）。
    """
    fake_dir = tmp_path / "missing"
    caplog.set_level(logging.CRITICAL, logger="manifest_opens.fallback_alert")
    with patch.object(manifest_opens, "_APPS_DIR", fake_dir):
        manifest_opens.reload_for_tests()
        manifest_opens.get_supported_resource_types()
        manifest_opens.get_supported_resource_types()
        manifest_opens.get_supported_resource_types()

    alerts = [r for r in caplog.records if r.name == "manifest_opens.fallback_alert"]
    assert len(alerts) == 1, (
        f"lru_cache 必须让告警仅触发一次；实际 {len(alerts)} 条（运维会被刷屏）"
    )

"""DV-2：stale 设备巡检的「墙钟跳变」防护回归。

背景（根因）：单机 dev 下 celery 与 Electron 同机，Mac 休眠 / dev 栈重启时 HTTP
心跳的「发」「收」一起冻结；唤醒后 `cleanup_stale_online_devices`（beat 每 120s）
抢在下一次 60s 心跳之前跑，拿休眠前的旧 `last_heartbeat_at` 把**在线**设备误标
offline，并往对话注入持久 ⚠️ 横幅（约 60s 后心跳恢复又翻回 online）。

修法：巡检按 cache 记录的「上轮运行时刻」算实际间隔，若远超调度间隔（判定服务端
自身停摆过）则**跳过本轮**，给设备一个完整心跳周期重连。下一轮间隔恢复正常即照常
巡检；真离线设备至多延迟一轮被收口。

注意：本文件**独立**于 `test_device_status.py`（后者在 conftest 的 infra_drift
名单里、默认 CI 跳过），确保这些回归在默认 CI 真正执行。
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from django.core.cache import cache
from django.test import SimpleTestCase

from apps.tabtinspace.services.device_service import (
    _CLEANUP_LAST_RUN_CACHE_KEY,
    DeviceService,
)


class CleanupStaleWallclockGapTests(SimpleTestCase):
    def setUp(self):
        cache.delete(_CLEANUP_LAST_RUN_CACHE_KEY)

    def tearDown(self):
        cache.delete(_CLEANUP_LAST_RUN_CACHE_KEY)

    @staticmethod
    def _patch_stale_query(stale_devices):
        """mock `Device.objects.filter(...).exclude(...).select_related(...)[:200]` 链。"""
        qs = MagicMock()
        qs.exclude.return_value = qs
        qs.select_related.return_value = qs
        qs.__getitem__.return_value = stale_devices
        return patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            return_value=qs,
        )

    def test_wallclock_gap_skips_round_without_marking_offline(self):
        # 上轮巡检在 1000s 前（远超 2×120s 阈值）→ 判定服务端睡过去/重启 → 本轮跳过。
        cache.set(_CLEANUP_LAST_RUN_CACHE_KEY, time.time() - 1000)

        with self._patch_stale_query([]) as mock_filter:
            count = DeviceService.cleanup_stale_online_devices()

        self.assertEqual(count, 0)
        # 关键：跳过时**根本不查 stale 设备**，自然不会误标离线、不广播。
        mock_filter.assert_not_called()
        # 跳过后仍把本轮时刻写回 cache，下一轮间隔恢复正常即照常巡检。
        self.assertIsNotNone(cache.get(_CLEANUP_LAST_RUN_CACHE_KEY))

    def test_normal_interval_proceeds_and_marks_stale_offline(self):
        cache.set(_CLEANUP_LAST_RUN_CACHE_KEY, time.time() - 120)  # 正常间隔，gap < 阈值
        device = SimpleNamespace(
            status="online", fingerprint="fp-1", organization_id="ws-1", save=Mock()
        )

        with self._patch_stale_query([device]), patch.object(
            DeviceService, "_cleanup_routing_caches"
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status"
        ) as mock_broadcast:
            count = DeviceService.cleanup_stale_online_devices()

        self.assertEqual(count, 1)
        self.assertEqual(device.status, "offline")
        device.save.assert_called_once()
        mock_broadcast.assert_called_once()

    def test_first_run_no_cache_record_proceeds(self):
        # 无上轮记录（首跑 / cache 丢失）→ fail-safe 照常巡检（偏向清理幽灵设备）。
        self.assertIsNone(cache.get(_CLEANUP_LAST_RUN_CACHE_KEY))

        with self._patch_stale_query([]) as mock_filter:
            count = DeviceService.cleanup_stale_online_devices()

        self.assertEqual(count, 0)
        mock_filter.assert_called_once()  # 证明真的进入了巡检逻辑

    def test_detect_wallclock_gap_false_bypasses_skip(self):
        # 即便存在巨大 gap，显式关闭探测（测试 / 手动调用）也照常巡检。
        cache.set(_CLEANUP_LAST_RUN_CACHE_KEY, time.time() - 99999)

        with self._patch_stale_query([]) as mock_filter:
            count = DeviceService.cleanup_stale_online_devices(detect_wallclock_gap=False)

        self.assertEqual(count, 0)
        mock_filter.assert_called_once()

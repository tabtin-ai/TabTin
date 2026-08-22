"""
C5-02 回归测试：heartbeat() 对 git_statuses 数组的处理

验证 device_service.heartbeat() 能正确处理：
1. 单个 git_status dict（原有路径）
2. git_statuses 数组（多 workspace 场景）
3. 两者同时上报时均被处理
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, call, patch

from django.test import SimpleTestCase

from apps.tabtinspace.services.device_service import DeviceService, HeartbeatCache


def _make_device(fingerprint="fp-test", device_type="daemon"):
    return SimpleNamespace(
        id="device-1",
        user_id="user-1",
        fingerprint=fingerprint,
        name="Test Daemon",
        device_type=device_type,
        role="control",
        capabilities=["terminal_execute"],
        organization_id="ws-1",
        status="online",
        os_info={},
        save=Mock(),
        refresh_from_db=Mock(),
    )


def _make_service(device):
    svc = DeviceService.__new__(DeviceService)
    svc.user = SimpleNamespace(id="user-1")
    svc.check_organization_permission = Mock(return_value=True)
    return svc


class HeartbeatGitStatusArrayTests(SimpleTestCase):
    """C5-02：git_statuses 数组路径"""

    def setUp(self):
        HeartbeatCache.get().invalidate("fp-test")

    def test_single_git_status_dict_is_synced(self):
        """原有路径：单个 git_status dict 正常处理。"""
        device = _make_device()
        svc = _make_service(device)
        git_status = {"is_repo": True, "branch": "main", "has_changes": False}

        with (
            patch.object(DeviceService, "_sync_git_status_to_workspaces") as mock_sync,
            patch("apps.tabtinspace.services.device_service.Device.objects") as mock_objs,
            patch("apps.tabtinspace.services.device_service.HeartbeatCache.get") as mock_cache,
        ):
            mock_objs.get.return_value = device
            cache_inst = MagicMock()
            cache_inst.should_write_db.return_value = True
            mock_cache.return_value = cache_inst

            svc.heartbeat(
                fingerprint="fp-test",
                system_info={"git_status": git_status, "home_dir": "/home/user"},
            )

        mock_sync.assert_called_once_with(device, git_status)

    def test_git_statuses_array_all_items_synced(self):
        """新路径：git_statuses 数组中每一项都触发 Workspace 状态同步。"""
        device = _make_device()
        svc = _make_service(device)

        gs1 = {"is_repo": True, "branch": "main", "has_changes": False, "workspace_dir": "/proj/a"}
        gs2 = {"is_repo": True, "branch": "feat/x", "has_changes": True, "workspace_dir": "/proj/b"}
        gs3 = {"is_repo": False, "workspace_dir": "/tmp/notgit"}

        with (
            patch.object(DeviceService, "_sync_git_status_to_workspaces") as mock_sync,
            patch("apps.tabtinspace.services.device_service.Device.objects") as mock_objs,
            patch("apps.tabtinspace.services.device_service.HeartbeatCache.get") as mock_cache,
        ):
            mock_objs.get.return_value = device
            cache_inst = MagicMock()
            cache_inst.should_write_db.return_value = True
            mock_cache.return_value = cache_inst

            svc.heartbeat(
                fingerprint="fp-test",
                system_info={"git_statuses": [gs1, gs2, gs3], "home_dir": "/home/user"},
            )

        # 三项均应被处理
        self.assertEqual(mock_sync.call_count, 3)
        mock_sync.assert_any_call(device, gs1)
        mock_sync.assert_any_call(device, gs2)
        mock_sync.assert_any_call(device, gs3)

    def test_git_status_and_git_statuses_both_processed(self):
        """两者同时上报时均被处理（先处理单个，再遍历数组）。"""
        device = _make_device()
        svc = _make_service(device)

        single_gs = {"is_repo": True, "branch": "main", "has_changes": False}
        arr_gs1 = {"is_repo": True, "branch": "dev", "has_changes": True, "workspace_dir": "/proj/sub"}

        with (
            patch.object(DeviceService, "_sync_git_status_to_workspaces") as mock_sync,
            patch("apps.tabtinspace.services.device_service.Device.objects") as mock_objs,
            patch("apps.tabtinspace.services.device_service.HeartbeatCache.get") as mock_cache,
        ):
            mock_objs.get.return_value = device
            cache_inst = MagicMock()
            cache_inst.should_write_db.return_value = True
            mock_cache.return_value = cache_inst

            svc.heartbeat(
                fingerprint="fp-test",
                system_info={
                    "git_status": single_gs,
                    "git_statuses": [arr_gs1],
                    "home_dir": "/home/user",
                },
            )

        self.assertEqual(mock_sync.call_count, 2)
        mock_sync.assert_any_call(device, single_gs)
        mock_sync.assert_any_call(device, arr_gs1)

    def test_empty_git_statuses_array_does_not_call_sync(self):
        """空数组不触发 Workspace 状态同步。"""
        device = _make_device()
        svc = _make_service(device)

        with (
            patch.object(DeviceService, "_sync_git_status_to_workspaces") as mock_sync,
            patch("apps.tabtinspace.services.device_service.Device.objects") as mock_objs,
            patch("apps.tabtinspace.services.device_service.HeartbeatCache.get") as mock_cache,
        ):
            mock_objs.get.return_value = device
            cache_inst = MagicMock()
            cache_inst.should_write_db.return_value = True
            mock_cache.return_value = cache_inst

            svc.heartbeat(
                fingerprint="fp-test",
                system_info={"git_statuses": [], "home_dir": "/home/user"},
            )

        mock_sync.assert_not_called()

    def test_non_dict_items_in_array_are_skipped(self):
        """数组中非 dict 项（None / str）被静默跳过，不抛异常。"""
        device = _make_device()
        svc = _make_service(device)

        valid_gs = {"is_repo": True, "branch": "main", "has_changes": False}

        with (
            patch.object(DeviceService, "_sync_git_status_to_workspaces") as mock_sync,
            patch("apps.tabtinspace.services.device_service.Device.objects") as mock_objs,
            patch("apps.tabtinspace.services.device_service.HeartbeatCache.get") as mock_cache,
        ):
            mock_objs.get.return_value = device
            cache_inst = MagicMock()
            cache_inst.should_write_db.return_value = True
            mock_cache.return_value = cache_inst

            svc.heartbeat(
                fingerprint="fp-test",
                system_info={"git_statuses": [None, "invalid", valid_gs], "home_dir": "/home/user"},
            )

        # 只有 valid_gs 触发 sync
        mock_sync.assert_called_once_with(device, valid_gs)

    def test_git_statuses_field_removed_from_system_info(self):
        """git_statuses 字段应从 system_info 中 pop，不保存到 device.os_info。"""
        device = _make_device()
        svc = _make_service(device)

        captured_os_info = {}

        def capture_save(update_fields=None):
            captured_os_info.update(device.os_info or {})

        device.save = capture_save

        gs = {"is_repo": True, "branch": "main", "has_changes": False}

        with (
            patch.object(DeviceService, "_sync_git_status_to_workspaces"),
            patch("apps.tabtinspace.services.device_service.Device.objects") as mock_objs,
            patch("apps.tabtinspace.services.device_service.HeartbeatCache.get") as mock_cache,
        ):
            mock_objs.get.return_value = device
            cache_inst = MagicMock()
            cache_inst.should_write_db.return_value = True
            mock_cache.return_value = cache_inst

            svc.heartbeat(
                fingerprint="fp-test",
                system_info={"git_statuses": [gs], "home_dir": "/home/user"},
            )

        runtime = captured_os_info.get("runtime", {})
        self.assertNotIn("git_statuses", runtime, "git_statuses 不应写入 device.os_info.runtime")

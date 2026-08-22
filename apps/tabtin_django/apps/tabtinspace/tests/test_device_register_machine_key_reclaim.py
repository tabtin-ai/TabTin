"""#5415：硬件锚定注册 reclaim（previous_fingerprint / machine_key）。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from django.test import SimpleTestCase

from apps.tabtinspace.services.device_service import DeviceService


def _empty_qs():
    qs = Mock()
    qs.exclude.return_value.select_related.return_value.first.return_value = None
    qs.exclude.return_value.first.return_value = None
    qs.select_related.return_value.first.return_value = None
    qs.first.return_value = None
    return qs


class DeviceRegisterMachineKeyReclaimTests(SimpleTestCase):
    def _make_legacy(self, *, user_id, fingerprint: str, machine_key: str = ""):
        return SimpleNamespace(
            id=uuid.uuid4(),
            user_id=user_id,
            organization_id=uuid.uuid4(),
            name="Old Laptop",
            device_type="electron",
            role="control",
            fingerprint=fingerprint,
            machine_key=machine_key,
            status="offline",
            capabilities=[],
            os_info={},
            save=Mock(),
        )

    def test_machine_key_reclaim_refuses_an_online_and_offline_pair(self):
        user = SimpleNamespace(id=uuid.uuid4())
        offline = self._make_legacy(
            user_id=user.id,
            fingerprint=f"electron-{uuid.uuid4()}",
            machine_key="a" * 32,
        )
        online = self._make_legacy(
            user_id=user.id,
            fingerprint=f"electron-{uuid.uuid4()}",
            machine_key="a" * 32,
        )
        online.status = "online"
        qs = MagicMock()
        qs.exclude.return_value.select_related.return_value.__getitem__.side_effect = (
            lambda _: [offline] if qs.filter_status == "offline" else [offline, online]
        )

        def filter_side_effect(**kwargs):
            qs.filter_status = kwargs.get("status")
            return qs

        service = DeviceService(user=user)
        with patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            side_effect=filter_side_effect,
        ), patch.object(service, "_reclaim_device_identity") as reclaim:
            result = service._reclaim_device_by_machine_key(
                organization=SimpleNamespace(),
                fingerprint="electron-" + ("b" * 32),
                machine_key="a" * 32,
                device_type="electron",
                name="Reinstalled Laptop",
                os_info=None,
                capabilities=None,
            )

        self.assertIsNone(result)
        reclaim.assert_not_called()

    def test_machine_key_reclaim_uses_the_single_offline_legacy_device(self):
        user = SimpleNamespace(id=uuid.uuid4())
        legacy = self._make_legacy(
            user_id=user.id,
            fingerprint=f"electron-{uuid.uuid4()}",
            machine_key="a" * 32,
        )
        qs = MagicMock()
        qs.exclude.return_value.select_related.return_value.__getitem__.return_value = [legacy]
        service = DeviceService(user=user)

        with patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            return_value=qs,
        ), patch.object(service, "_reclaim_device_identity", return_value=legacy) as reclaim:
            result = service._reclaim_device_by_machine_key(
                organization=SimpleNamespace(),
                fingerprint="electron-" + ("b" * 32),
                machine_key="a" * 32,
                device_type="electron",
                name="Reinstalled Laptop",
                os_info=None,
                capabilities=None,
            )

        self.assertIs(result, legacy)
        self.assertEqual(reclaim.call_args.kwargs["lookup_fingerprint"], legacy.fingerprint)

    def test_recovery_fingerprint_refuses_an_online_legacy_device(self):
        organization_id = uuid.uuid4()
        user = SimpleNamespace(id=uuid.uuid4())
        organization = SimpleNamespace(id=organization_id)
        old_fp = f"electron-{uuid.uuid4()}"
        new_fp = "electron-" + ("a" * 32)
        machine_key = "a" * 32
        legacy = self._make_legacy(
            user_id=user.id,
            fingerprint=old_fp,
            machine_key=machine_key,
        )
        legacy.status = "online"
        created = self._make_legacy(user_id=user.id, fingerprint=new_fp, machine_key=machine_key)

        def filter_side_effect(**kwargs):
            qs = MagicMock()
            qs.exclude.return_value.select_related.return_value.first.return_value = None
            qs.exclude.return_value.first.return_value = None
            qs.select_related.return_value.first.return_value = None
            qs.exclude.return_value.select_related.return_value.__getitem__.return_value = []
            if kwargs.get("fingerprint") == old_fp and kwargs.get("user_id") == user.id:
                if kwargs.get("status") != "offline":
                    qs.select_related.return_value.first.return_value = legacy
            return qs

        service = DeviceService(user=user)
        with patch.object(type(service), "check_organization_permission", return_value=True), patch(
            "apps.tabtinspace.services.device_service.Organization.objects.get",
            return_value=organization,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            side_effect=filter_side_effect,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.update_or_create",
            return_value=(created, True),
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ):
            result = service.register_device(
                organization_id=organization_id,
                fingerprint=new_fp,
                device_type="electron",
                name="Reinstalled Laptop",
                machine_key=machine_key,
                recovery_fingerprints=[old_fp],
            )

        self.assertIs(result, created)
        legacy.save.assert_not_called()

    def test_reclaim_by_previous_fingerprint_preserves_device_id(self):
        organization_id = uuid.uuid4()
        user = SimpleNamespace(id=uuid.uuid4())
        organization = SimpleNamespace(id=organization_id)
        old_fp = f"electron-{uuid.uuid4()}"
        new_fp = "electron-" + ("a" * 32)
        machine_key = "a" * 32
        legacy = self._make_legacy(user_id=user.id, fingerprint=old_fp)

        def filter_side_effect(**kwargs):
            qs = _empty_qs()
            # 本用户旧 fingerprint → reclaim 目标
            if kwargs.get("fingerprint") == old_fp and kwargs.get("user_id") == user.id:
                qs.select_related.return_value.first.return_value = legacy
                return qs
            # 其它查询（含 other-user / conflict）一律空
            return qs

        service = DeviceService(user=user)
        with patch.object(type(service), "check_organization_permission", return_value=True), patch(
            "apps.tabtinspace.services.device_service.Organization.objects.get",
            return_value=organization,
        ), patch(
            "apps.tabtinspace.services.device_service.Device.objects.filter",
            side_effect=filter_side_effect,
        ), patch(
            "apps.services.common.ws.device_broadcast._broadcast_device_status",
        ):
            result = service.register_device(
                organization_id=organization_id,
                fingerprint=new_fp,
                device_type="electron",
                name="LAPTOP (win32)",
                os_info={"os": "win32"},
                capabilities=["terminal_execute"],
                machine_key=machine_key,
                previous_fingerprint=old_fp,
            )

        self.assertIs(result, legacy)
        self.assertEqual(legacy.fingerprint, new_fp)
        self.assertEqual(legacy.machine_key, machine_key)
        self.assertEqual(legacy.status, "online")
        # 不迁移 Organization（即使注册请求带了另一个 org）
        self.assertNotEqual(getattr(legacy, "organization", None), organization)
        legacy.save.assert_called()

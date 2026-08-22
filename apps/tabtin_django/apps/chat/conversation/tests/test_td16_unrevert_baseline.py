"""TD-16 rollback/unrevert baseline unit tests."""

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4

from apps.chat.conversation.api.rollback import (
    _build_reapply_resource_items,
    _capture_unrevert_baseline_version,
    _unrevert_resources,
)


class TD16UnrevertBaselineTests(TestCase):
    def test_capture_unrevert_baseline_creates_forced_snapshot(self):
        """rollback_resources must snapshot the visible pre-rollback state."""
        resource_id = uuid4()
        organization_id = uuid4()
        resource = SimpleNamespace(id=resource_id, organization_id=organization_id)
        snapshot = {
            "format": "json_snapshot",
            "title": "回退前标题",
            "description_markdown": "# 回退前正文",
        }
        adapter = MagicMock()
        adapter.get_version_data.return_value = snapshot
        created_vh = SimpleNamespace(id=uuid4())
        svc = MagicMock()
        svc.create_history.return_value = created_vh

        with patch("apps.collab.service.VersionHistoryService", return_value=svc):
            result = _capture_unrevert_baseline_version(
                adapter=adapter,
                resource=resource,
                session_id="session-td16",
            )

        self.assertEqual(result, str(created_vh.id))
        adapter.get_version_data.assert_called_once_with(resource)
        svc.create_history.assert_called_once()
        kwargs = svc.create_history.call_args.kwargs
        self.assertEqual(kwargs["resource_id"], resource_id)
        self.assertEqual(kwargs["data"], snapshot)
        self.assertEqual(kwargs["organization_id"], organization_id)
        self.assertTrue(kwargs["force_snapshot"])
        self.assertTrue(kwargs["skip_throttle"])
        self.assertEqual(kwargs["editor_info"]["editor_id"], "unrevert-baseline:session-td16")

    def test_capture_unrevert_baseline_failure_is_not_silent(self):
        """If VH creation fails, rollback must not pretend unrevert is reliable."""
        adapter = MagicMock()
        adapter.get_version_data.return_value = {"format": "json_snapshot"}
        resource = SimpleNamespace(id=uuid4(), organization_id=uuid4())
        svc = MagicMock()
        svc.create_history.return_value = None

        with patch("apps.collab.service.VersionHistoryService", return_value=svc):
            with self.assertRaisesRegex(RuntimeError, "unrevert baseline"):
                _capture_unrevert_baseline_version(
                    adapter=adapter,
                    resource=resource,
                    session_id="session-td16",
                )

    def test_capture_unrevert_baseline_keeps_tabdoc_binary_raw_with_title_metadata(self):
        """TD-16: TabDoc binary baselines keep raw bytes and carry title out-of-band."""
        resource = SimpleNamespace(id=uuid4(), organization_id=uuid4(), title="协作态标题")
        adapter = MagicMock()
        adapter.resource_type = "docs"
        adapter.get_version_data.return_value = b"binary-yjs"
        created_vh = SimpleNamespace(id=uuid4())
        svc = MagicMock()
        svc.create_history.return_value = created_vh

        with patch("apps.collab.service.VersionHistoryService", return_value=svc):
            _capture_unrevert_baseline_version(
                adapter=adapter,
                resource=resource,
                session_id="session-td16",
            )

        snapshot_data = svc.create_history.call_args.kwargs["data"]
        self.assertEqual(snapshot_data, b"binary-yjs")
        self.assertEqual(
            svc.create_history.call_args.kwargs["extra_metadata"],
            {"tabdoc_title": "协作态标题"},
        )

    def test_build_reapply_resource_items_keeps_original_restore_plan(self):
        """unrevert history should retain the resource plan for rolling back again."""
        rollback_target_vh_id = str(uuid4())

        result = _build_reapply_resource_items([
            {
                "resource_type": "docs",
                "resource_id": "doc-1",
                "action": "restore_version",
                "restore_to_version_id": rollback_target_vh_id,
                "pre_version_id": str(uuid4()),
                "success": True,
            },
            {
                "resource_type": "docs",
                "resource_id": "doc-2",
                "action": "trash",
                "pre_version_id": None,
                "success": True,
            },
            {
                "resource_type": "docs",
                "resource_id": "doc-3",
                "action": "skip",
                "success": True,
            },
        ])

        self.assertEqual(result, [
            {
                "resource_type": "docs",
                "resource_id": "doc-1",
                "action": "restore_version",
                "restore_to_version_id": rollback_target_vh_id,
            },
            {
                "resource_type": "docs",
                "resource_id": "doc-2",
                "action": "trash",
                "restore_to_version_id": None,
            },
        ])

    def test_unrevert_resources_reports_untrash_false(self):
        """TD-16: failed untrash must be reported instead of silently succeeding."""
        with patch(
            "apps.chat.conversation.api.rollback._untrash_resource",
            return_value=False,
        ):
            failed = _unrevert_resources([
                {
                    "resource_type": "docs",
                    "resource_id": "doc-1",
                    "action": "trash",
                },
            ], "session-td16")

        self.assertEqual(failed, [{
            "resource_type": "docs",
            "resource_id": "doc-1",
            "error": "资源恢复出回收站失败",
        }])

    def test_unrevert_resources_reports_missing_pre_version(self):
        """TD-16: restore_version without baseline cannot be marked successful."""
        failed = _unrevert_resources([
            {
                "resource_type": "docs",
                "resource_id": "doc-1",
                "action": "restore_version",
                "pre_version_id": None,
            },
        ], "session-td16")

        self.assertEqual(failed, [{
            "resource_type": "docs",
            "resource_id": "doc-1",
            "error": "缺少 rollback 前 baseline 版本 ID",
        }])

    def test_unrevert_resources_force_closes_after_restore(self):
        """TD-16: unrevert must refresh opened TabDoc panels after version restore."""
        resource_id = uuid4()
        baseline_id = uuid4()
        adapter = MagicMock()
        svc = MagicMock()
        svc.restore_to_version.return_value = SimpleNamespace(id=uuid4())
        collab_warnings: list[dict[str, str]] = []

        with patch("apps.collab.registry.get_adapter", return_value=adapter), patch(
            "apps.collab.service.VersionHistoryService",
            return_value=svc,
        ), patch(
            "apps.collab.api._force_close_collab_document",
            return_value={"success": True},
        ) as force_close:
            failed = _unrevert_resources([
                {
                    "resource_type": "docs",
                    "resource_id": str(resource_id),
                    "action": "restore_version",
                    "pre_version_id": str(baseline_id),
                },
            ], "session-td16", collab_sync_warnings=collab_warnings)

        self.assertEqual(failed, [])
        self.assertEqual(collab_warnings, [])
        force_close.assert_called_once_with("docs", str(resource_id), reason="document_restored")

    def test_unrevert_resources_records_force_close_warning_without_failed_restore(self):
        """TD-16: collab refresh warnings must not keep an already-restored resource in revert state."""
        resource_id = uuid4()
        baseline_id = uuid4()
        adapter = MagicMock()
        svc = MagicMock()
        svc.restore_to_version.return_value = SimpleNamespace(id=uuid4())
        collab_warnings: list[dict[str, str]] = []

        with patch("apps.collab.registry.get_adapter", return_value=adapter), patch(
            "apps.collab.service.VersionHistoryService",
            return_value=svc,
        ), patch(
            "apps.collab.api._force_close_collab_document",
            return_value={"success": False},
        ):
            failed = _unrevert_resources([
                {
                    "resource_type": "docs",
                    "resource_id": str(resource_id),
                    "action": "restore_version",
                    "pre_version_id": str(baseline_id),
                },
            ], "session-td16", collab_sync_warnings=collab_warnings)

        self.assertEqual(failed, [])
        self.assertEqual(collab_warnings, [{
            "resource": f"docs:{resource_id}",
            "warning": "force_close_failed",
        }])

    def test_partial_success_schema_preserves_failed_items(self):
        """TD-16: UnrevertResponse must not drop resource failure details."""
        from apps.chat.conversation.schemas import RollbackPartialSuccessDetailsView

        details = RollbackPartialSuccessDetailsView(
            resources={
                "failed_count": 1,
                "failed_items": [{
                    "resource_type": "docs",
                    "resource_id": "doc-1",
                    "error": "版本恢复失败",
                }],
            },
        ).model_dump(mode="json")

        self.assertEqual(details["resources"]["failed_items"], [{
            "resource_type": "docs",
            "resource_id": "doc-1",
            "error": "版本恢复失败",
        }])

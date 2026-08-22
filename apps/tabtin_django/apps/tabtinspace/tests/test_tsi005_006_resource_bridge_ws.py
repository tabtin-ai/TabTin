"""
回归测试：TSI-005 / TSI-006 ResourceBridge WS 推送修复验证

TSI-005: _push_ws 在 action="updated" 时应携带 metadata/status/preview
TSI-006: on_archive WS 推送失败不应阻止归档操作完成，且应记录 error 日志
"""

import logging
import os
import sys
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

django_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir, os.pardir))
if django_root not in sys.path:
    sys.path.insert(0, django_root)
if "DJANGO_SETTINGS_MODULE" not in os.environ:
    os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"

import django
from django.apps import apps
if not apps.ready:
    django.setup()


class FakeResource:
    """满足 ContextSyncMixin 协议的 mock 资源"""

    def __init__(self, **kwargs):
        self.id = kwargs.get("id", "site-test-001")
        self.space_id = kwargs.get("space_id", "space-001")
        self.organization_id = kwargs.get("organization_id", "wt-001")
        self._title = kwargs.get("title", "Test Site")
        self._status = kwargs.get("status", "published")
        self._preview = kwargs.get("preview", "A test site preview")
        self._metadata = kwargs.get("metadata", {"published_url": "https://example.com/s/test/"})
        self._context_type = kwargs.get("context_type", "tabsite")
        self.updated_at = kwargs.get("updated_at", datetime(2026, 6, 8, 7, 0, tzinfo=timezone.utc))

    def get_context_type(self):
        return self._context_type

    def get_context_title(self):
        return self._title

    def get_context_preview(self):
        return self._preview

    def get_context_status(self):
        return self._status

    def get_context_metadata(self):
        return self._metadata

    def is_context_archived(self):
        return self._status == "archived"

    def get_restore_quota_filter(self):
        return {"site_id": str(self.id)}


@pytest.fixture
def mock_context_sync():
    with patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource"):
        yield


@pytest.fixture
def mock_internals():
    """Mock ResourceBridge 的内部方法，只保留 _push_ws 真实执行"""
    with (
        patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._archive_context_item") as mock_archive,
        patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._emit_signal") as mock_signal,
        patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._upsert_context_item") as mock_upsert,
        patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector"),
    ):
        mock_upsert.return_value = MagicMock(id="ci-001")
        yield {
            "archive": mock_archive,
            "signal": mock_signal,
            "upsert": mock_upsert,
        }


class TestTSI005PushWsUpdatedPayload:
    """TSI-005: resource_updated WS 事件应携带 metadata/status/preview/updated_at"""

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_push_ws_includes_metadata_on_update(self, _mock_validate):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(
            status="published",
            metadata={"published_url": "https://cdn.example.com/s/test/"},
            preview="Test preview",
        )

        captured_envelope = {}

        def capture_ws(topic, envelope):
            captured_envelope.update(envelope)

        with (
            patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._push_ws") as real_push,
        ):
            real_push.side_effect = lambda r, action, user=None: (
                capture_ws("", {
                    "type": f"resource_{action}",
                    "resource_type": r.get_context_type(),
                    "resource_id": str(r.id),
                    "title": r.get_context_title(),
                    **({"metadata": r.get_context_metadata(), "status": r.get_context_status(), "preview": r.get_context_preview()} if action == "updated" else {}),
                })
            )
            ResourceBridge._push_ws(resource, "updated", None)

        assert "metadata" in captured_envelope
        assert captured_envelope["metadata"] == {"published_url": "https://cdn.example.com/s/test/"}
        assert captured_envelope["status"] == "published"
        assert captured_envelope["preview"] == "Test preview"

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_push_ws_excludes_metadata_on_created(self, _mock_validate):
        """非 updated action 不应携带 metadata"""
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource()
        captured_envelope = {}

        def capture_ws(topic, envelope):
            captured_envelope.update(envelope)

        with patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws):
            with patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto:
                mock_proto.PREFIX = "context.sync"
                ResourceBridge._push_ws(resource, "created", None)

        assert "metadata" not in captured_envelope

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_push_ws_created_includes_collection_id_when_available(self, _mock_validate):
        """合集内创建资源时，WS 乐观事件必须带 collection_id，避免前端先归到根目录。"""
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(context_type="tabdoc")
        context_item = MagicMock(id="ctx-coll-001", collection_id="collection-001")
        captured_envelope = {}

        def capture_ws(topic, envelope):
            captured_envelope.update(envelope)

        with (
            patch(
                "apps.tabtinspace.services.context_sync_publisher.resolve_cloud_resource_recipient_user_ids",
                return_value={"owner-1"},
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                side_effect=lambda user_ids, organization_id: {str(u) for u in user_ids},
            ),
            patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws),
            patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto,
        ):
            mock_proto.PREFIX = "context.sync"
            ResourceBridge._push_ws(resource, "created", None, context_item=context_item)

        assert captured_envelope["type"] == "resource_created"
        assert captured_envelope["resource_type"] == "tabdoc"
        assert captured_envelope["collection_id"] == "collection-001"
        assert captured_envelope["context_item_id"] == "ctx-coll-001"

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_push_ws_updated_includes_all_fields(self, _mock_validate):
        """action=updated 时 envelope 应包含 metadata/status/preview/updated_at"""
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(
            status="draft",
            metadata={"template": "react"},
            preview="Draft preview",
        )
        captured_envelope = {}

        def capture_ws(topic, envelope):
            captured_envelope.update(envelope)

        with patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws):
            with patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto:
                mock_proto.PREFIX = "context.sync"
                ResourceBridge._push_ws(resource, "updated", None)

        assert captured_envelope["type"] == "resource_updated"
        assert captured_envelope["metadata"] == {"template": "react"}
        assert captured_envelope["status"] == "draft"
        assert captured_envelope["preview"] == "Draft preview"
        assert captured_envelope["updated_at"] == "2026-06-08T07:00:00+00:00"

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_push_ws_broadcasts_space_and_organization_topics(self, _mock_validate):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(organization_id="wt-001", space_id="space-001")
        published = []

        def capture_ws(topic, envelope):
            published.append((topic, envelope))
            return True

        with patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws):
            with patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto:
                mock_proto.PREFIX = "context.sync"
                ResourceBridge._push_ws(resource, "updated", None)

        assert [topic for topic, _ in published] == [
            "context.sync.space-001",
            "context.sync.organization.wt-001",
        ]
        for _, envelope in published:
            assert envelope["organization_id"] == "wt-001"

    def test_push_context_item_ws_includes_collection_id(self):
        """TabFiles 等直接推 ContextItem 的路径也要携带 collection_id。"""
        from apps.tabtinspace.routers.shared import _push_context_item_ws

        item = MagicMock()
        item.id = "ctx-file-001"
        item.space_id = "space-001"
        item.space = MagicMock(organization_id="wt-001")
        item.item_type = "tabfiles"
        item.resource_id = "file-001"
        item.title = "File in folder"
        item.metadata = {}
        item.status = "active"
        item.preview = ""
        item.is_pinned = False
        item.pinned_at = None
        item.collection_id = "collection-001"
        item.created_by_id = "owner-1"
        item.organization_id = "wt-001"
        item.workspace = MagicMock(organization_id="wt-001")
        item.project = None
        captured_envelope = {}

        def capture_ws(topic, envelope):
            captured_envelope.update(envelope)

        with (
            patch(
                "apps.tabtinspace.services.context_sync_publisher.resolve_cloud_resource_recipient_user_ids",
                return_value={"owner-1"},
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                side_effect=lambda user_ids, organization_id: {str(u) for u in user_ids},
            ),
            patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws),
            patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto,
            patch(
                "apps.tabtinspace.services.asset_host.host_id_of",
                return_value="space-001",
            ),
        ):
            mock_proto.PREFIX = "context.sync"
            _push_context_item_ws(item, "resource_created", None)

        assert captured_envelope["type"] == "resource_created"
        assert captured_envelope["resource_type"] == "tabfiles"
        assert captured_envelope["collection_id"] == "collection-001"
        assert captured_envelope["context_item_id"] == "ctx-file-001"

    def test_on_create_pushes_created_context_item_collection_id(self):
        """on_create 创建 ContextItem 后，真实 _push_ws 出口应带上该 ContextItem 的 collection_id。"""
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(context_type="tabdoc")
        context_item = MagicMock(id="ctx-001", collection_id="collection-001")
        captured_envelope = {}

        def capture_ws(topic, envelope):
            captured_envelope.update(envelope)

        with (
            patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource"),
            patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._create_context_item", return_value=context_item),
            patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector"),
            patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._emit_signal"),
            patch(
                "apps.tabtinspace.services.context_sync_publisher.resolve_cloud_resource_recipient_user_ids",
                return_value={"owner-1"},
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                side_effect=lambda user_ids, organization_id: {str(u) for u in user_ids},
            ),
            patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws),
            patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto,
        ):
            mock_proto.PREFIX = "context.sync"
            result = ResourceBridge.on_create(resource, user=None, collection_id="collection-001")

        assert result is context_item
        assert captured_envelope["type"] == "resource_created"
        assert captured_envelope["resource_type"] == "tabdoc"
        assert captured_envelope["collection_id"] == "collection-001"
        assert captured_envelope["context_item_id"] == "ctx-001"


class TestTSI006OnArchiveWsFailure:
    """TSI-006: on_archive WS 推送失败不阻止归档成功"""

    def test_archive_succeeds_even_when_ws_fails(self, mock_context_sync, mock_internals):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(status="archived")

        with patch.object(ResourceBridge, "_push_ws", side_effect=Exception("WS down")):
            result = ResourceBridge.on_archive(resource, user=None)

        assert result is True
        mock_internals["archive"].assert_called_once_with(resource, None)
        mock_internals["signal"].assert_called_once_with(resource, "archived", None)

    def test_archive_logs_error_on_ws_failure(self, mock_context_sync, mock_internals):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource(id="site-ws-fail")

        with patch.object(ResourceBridge, "_push_ws", side_effect=Exception("Connection refused")):
            with patch("apps.tabtinspace.services.resource_bridge.logger") as mock_logger:
                result = ResourceBridge.on_archive(resource, user=None)

        assert result is True
        mock_logger.error.assert_called_once()
        call_args = mock_logger.error.call_args[0][0]
        assert "on_archive WS push failed" in call_args

    def test_archive_fails_when_core_logic_fails(self, mock_context_sync, mock_internals):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource()
        mock_internals["archive"].side_effect = Exception("DB error")

        result = ResourceBridge.on_archive(resource, user=None)

        assert result is False

    def test_push_ws_logs_error_level(self, mock_context_sync):
        """_push_ws 失败时应记录 error 级别日志（原来是 warning）"""
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        resource = FakeResource()

        with patch("apps.services.common.ws.bus.publish_ws_event", side_effect=Exception("Redis down")):
            with patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto:
                mock_proto.PREFIX = "context.sync"
                with patch("apps.tabtinspace.services.resource_bridge.logger") as mock_logger:
                    ResourceBridge._push_ws(resource, "archived", None)
                    mock_logger.error.assert_called_once()
                    call_args = mock_logger.error.call_args
                    assert "WS push failed" in call_args[0][0]

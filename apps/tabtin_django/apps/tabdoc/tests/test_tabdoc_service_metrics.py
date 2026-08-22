from __future__ import annotations

from contextlib import nullcontext
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4
import unittest

from django.db.models import Q
from django.utils import timezone

from apps.tabdoc.services import (
    ConflictError,
    DocumentExchangeService,
    DocumentSearchService,
    DocumentService,
    get_tabdoc_metrics,
)
from apps.services.common.db_router import postgres_app_db_alias

_fake_user = SimpleNamespace(id=1, pk=1)


def _flatten_q_children(q_obj):
    children = []
    for child in getattr(q_obj, "children", []):
        if isinstance(child, Q):
            children.extend(_flatten_q_children(child))
        else:
            children.append(child)
    return children


class TabdocServiceMetricsTests(unittest.TestCase):
    def setUp(self):
        get_tabdoc_metrics().reset()

    def test_save_content_records_conflict_metric(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        document = SimpleNamespace(
            id="doc-1",
            latest_version=2,
            title="old",
            description_markdown="old",
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )

        with self.assertRaises(ConflictError):
            service.save_content(
                document,
                base_version=1,
                content_pm_json={"type": "doc", "content": []},
                content_markdown="冲突内容",
                content_plaintext="",
            )

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["save"]["attempts"], 1)
        self.assertEqual(snapshot["save"]["conflicts"], 1)
        self.assertEqual(snapshot["save"]["successes"], 0)

    def test_save_content_records_success_metric(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        document = SimpleNamespace(
            id="doc-1",
            latest_version=2,
            title="正常保存标题",
            description_markdown="正常保存",
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        update_qs = MagicMock()
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
                with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                    with patch.object(service, "_update_search_vector"):
                        returned = service.save_content(
                            document,
                            base_version=2,
                            content_pm_json={"type": "doc", "content": []},
                            content_markdown="正常保存",
                            content_plaintext="",
                        )

        self.assertIs(returned, document)
        self.assertEqual(document.latest_version, 3)
        update_qs.update.assert_called_once()
        document.refresh_from_db.assert_called_once()

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["save"]["attempts"], 1)
        self.assertEqual(snapshot["save"]["successes"], 1)
        self.assertEqual(snapshot["save"]["failures"], 0)

    def test_save_content_records_failure_metric(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        document = SimpleNamespace(
            id="doc-1",
            latest_version=1,
            title="old",
            description_markdown="old",
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        update_qs = MagicMock()
        update_qs.update.side_effect = RuntimeError("db write failed")

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
                with self.assertRaises(RuntimeError):
                    service.save_content(
                        document,
                        base_version=1,
                        content_pm_json={"type": "doc", "content": []},
                        content_markdown="失败保存",
                        content_plaintext="",
                    )

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["save"]["attempts"], 1)
        self.assertEqual(snapshot["save"]["failures"], 1)
        self.assertEqual(snapshot["save"]["successes"], 0)

    def test_save_content_records_conflict_metric_on_cas_miss(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        document = SimpleNamespace(
            id="doc-1",
            latest_version=2,
            title="old",
            description_markdown="old",
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        cas_qs = MagicMock()
        cas_qs.update.return_value = 0
        latest_qs = MagicMock()
        latest_qs.values_list.return_value.first.return_value = 4

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch(
                "apps.tabdoc.services.document_service.Document.objects.filter",
                side_effect=[cas_qs, latest_qs],
            ):
                with self.assertRaises(ConflictError):
                    service.save_content(
                        document,
                        base_version=2,
                        content_pm_json={"type": "doc", "content": []},
                        content_markdown="CAS 冲突",
                        content_plaintext="",
                    )

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["save"]["attempts"], 1)
        self.assertEqual(snapshot["save"]["conflicts"], 1)
        self.assertEqual(snapshot["save"]["failures"], 0)

    def test_update_document_uses_metadata_cas_without_bumping_latest_version(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        space_id = uuid4()
        document = SimpleNamespace(
            id="doc-1",
            space_id=space_id,
            latest_version=3,
            title="旧标题",
            status="active",
            parent_id=None,
            icon="",
            cover_image="",
            cover_position=0.5,
            tags=[],
            properties={},
            is_full_width=False,
            font_style="default",
            description_plaintext="现有正文",
            updated_at=updated_at,
            refresh_from_db=MagicMock(),
            updated_by=None,
            _state=SimpleNamespace(db="postgresql"),
        )
        update_qs = MagicMock()
        update_qs.filter.return_value = update_qs
        update_qs.update.return_value = 1
        document_manager = MagicMock()
        document_manager.filter.return_value = update_qs
        space_lock_qs = MagicMock()
        space_manager = MagicMock()
        space_manager.select_for_update.return_value = space_lock_qs

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.using", return_value=document_manager):
                with patch("apps.tabdoc.services.document_service.Space.objects.using", return_value=space_manager):
                    with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                        with patch.object(service, "_update_search_vector"):
                            returned = service.update_document(
                                document,
                                base_version=3,
                                base_updated_at=updated_at.isoformat(),
                                title="新标题",
                            )

        self.assertIs(returned, document)
        self.assertEqual(document.title, "新标题")
        self.assertEqual(document.latest_version, 3)
        document_manager.filter.assert_called_once_with(id="doc-1", latest_version=3)
        update_qs.update.assert_called_once()
        document.refresh_from_db.assert_called_once_with(using="postgresql", fields=["updated_at"])

    def test_update_document_raises_conflict_on_stale_updated_at(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-1",
            latest_version=5,
            title="旧标题",
            status="active",
            parent_id=None,
            icon="",
            cover_image="",
            cover_position=0.5,
            tags=[],
            properties={},
            is_full_width=False,
            font_style="default",
            updated_at=updated_at,
            refresh_from_db=MagicMock(),
            updated_by=None,
            _state=SimpleNamespace(db="postgresql"),
        )
        cas_qs = MagicMock()
        cas_qs.filter.return_value = cas_qs
        cas_qs.update.return_value = 0
        latest_qs = MagicMock()
        latest_qs.values_list.return_value.first.return_value = 5
        document_manager = MagicMock()
        document_manager.filter.side_effect = [cas_qs, latest_qs]

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.using", return_value=document_manager):
                with self.assertRaises(ConflictError):
                    service.update_document(
                        document,
                        base_version=5,
                        base_updated_at=(updated_at - timedelta(seconds=5)).isoformat(),
                        title="新标题",
                    )

    def test_save_content_can_update_title_in_same_version(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-1",
            latest_version=2,
            title="旧标题",
            description_markdown="旧正文",
            updated_at=updated_at,
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        update_qs = MagicMock()
        update_qs.filter.return_value = update_qs
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
                with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                    with patch.object(service, "_update_search_vector"):
                        with patch.object(service, "push_and_update_binary", return_value=None):
                            returned = service.save_content(
                                document,
                                base_version=2,
                                base_updated_at=updated_at.isoformat(),
                                title="新标题",
                                content_pm_json={"type": "doc", "content": []},
                                content_markdown="新正文",
                                content_plaintext="新正文",
                            )

        self.assertIs(returned, document)
        self.assertEqual(document.title, "新标题")
        self.assertEqual(document.description_markdown, "新正文")
        self.assertEqual(document.latest_version, 3)
        update_qs.update.assert_called_once()
        document.refresh_from_db.assert_called_once()

    def test_save_content_ignores_client_timestamp_but_keeps_snapshot_cas(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-1",
            latest_version=2,
            title="旧标题",
            description_markdown="旧正文",
            updated_at=updated_at,
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        cas_qs = MagicMock()
        cas_qs.filter.return_value = cas_qs
        cas_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch(
                "apps.tabdoc.services.document_service.Document.objects.filter",
                return_value=cas_qs,
            ):
                with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                    with patch.object(service, "_update_search_vector"):
                        with patch.object(service, "push_and_update_binary", return_value=None):
                            returned = service.save_content(
                                document,
                                base_version=2,
                                base_updated_at=(updated_at - timedelta(seconds=5)).isoformat(),
                                title="新标题",
                                content_pm_json={"type": "doc", "content": []},
                                content_markdown="新正文",
                                content_plaintext="新正文",
                            )

        self.assertIs(returned, document)
        cas_qs.filter.assert_called_once_with(updated_at=updated_at)
        cas_qs.update.assert_called_once()

    def test_save_content_timestamp_only_client_still_conflicts_when_stale(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-1",
            latest_version=2,
            title="旧标题",
            description_markdown="旧正文",
            updated_at=updated_at,
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        cas_qs = MagicMock()
        cas_qs.filter.return_value = cas_qs
        cas_qs.update.return_value = 0
        latest_qs = MagicMock()
        latest_qs.values_list.return_value.first.return_value = 2

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch(
                "apps.tabdoc.services.document_service.Document.objects.filter",
                side_effect=[cas_qs, latest_qs],
            ):
                with self.assertRaises(ConflictError):
                    service.save_content(
                        document,
                        base_version=None,
                        base_updated_at=(updated_at - timedelta(seconds=5)).isoformat(),
                        title="新标题",
                        content_pm_json={"type": "doc", "content": []},
                        content_markdown="新正文",
                        content_plaintext="新正文",
                    )

    def test_restore_history_raises_conflict_on_stale_updated_at(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        history_id = "11111111-1111-1111-1111-111111111111"
        histories = MagicMock()
        histories.filter.return_value.first.return_value = SimpleNamespace(id=history_id)
        document = SimpleNamespace(
            id="doc-1",
            latest_version=4,
            updated_at=updated_at,
            status="active",
            histories=histories,
            refresh_from_db=MagicMock(),
            description_json={},
            description_markdown="旧正文",
            description_plaintext="旧正文",
        )
        cas_qs = MagicMock()
        cas_qs.filter.return_value = cas_qs
        cas_qs.update.return_value = 0
        latest_qs = MagicMock()
        latest_qs.values_list.return_value.first.return_value = 4

        with patch.object(service, "_resolve_history_content", return_value={
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "恢复正文",
            "description_plaintext": "恢复正文",
        }):
            with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
                with patch(
                    "apps.tabdoc.services.document_service.Document.objects.filter",
                    side_effect=[cas_qs, latest_qs],
                ):
                    with self.assertRaises(ConflictError):
                        service.restore_history(
                            document,
                            history_id=history_id,
                            base_version=4,
                            base_updated_at=(updated_at - timedelta(seconds=5)).isoformat(),
                        )

    def test_search_records_latency_on_permission_denied(self):
        service = DocumentSearchService(user=_fake_user)

        with patch.object(service._doc_service, "_ensure_space_context", return_value=None):
            with patch.object(service._doc_service, "check_space_permission", return_value=False):
                with self.assertRaises(PermissionError):
                    service.search_documents(
                        organization_id="11111111-1111-1111-1111-111111111111",
                        space_id="22222222-2222-2222-2222-222222222222",
                        keyword="测试",
                    )

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["search"]["requests"], 1)

    def test_search_records_latency_on_validation_error(self):
        service = DocumentSearchService(user=_fake_user)

        with self.assertRaises(ValueError):
            service.search_documents(
                organization_id="11111111-1111-1111-1111-111111111111",
                space_id="22222222-2222-2222-2222-222222222222",
                keyword="",
            )

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["search"]["requests"], 1)

    def test_postgres_search_falls_back_to_plaintext_contains_when_vector_misses(self):
        service = DocumentSearchService(user=_fake_user)
        doc_service = service._doc_service
        doc_service._parse_uuid = MagicMock(side_effect=lambda value, _field: value)
        doc_service._ensure_space_context = MagicMock(return_value=None)
        doc_service.check_space_permission = MagicMock(return_value=True)
        doc_service._build_permission_filter_q = MagicMock(return_value=Q())

        base_qs = MagicMock(name="base_qs")
        permitted_qs = MagicMock(name="permitted_qs")
        filtered_qs = MagicMock(name="filtered_qs")
        ordered_qs = MagicMock(name="ordered_qs")
        base_qs.filter.return_value = permitted_qs
        permitted_qs.distinct.return_value = permitted_qs
        permitted_qs.filter.return_value = filtered_qs
        filtered_qs.annotate.return_value = filtered_qs
        filtered_qs.order_by.return_value = ordered_qs
        ordered_qs.count.return_value = 1
        ordered_qs.__getitem__.return_value = [
            SimpleNamespace(
                title="游记",
                description_plaintext="这里有西湖龙井正文",
                title_hit=0,
                content_hit=0,
                content_text_hit=1,
            )
        ]

        with patch("apps.tabdoc.services.search_service.Document.objects") as manager:
            with patch("django.db.router.db_for_read", return_value="postgresql"):
                with patch("django.db.connections", {"postgresql": SimpleNamespace(vendor="postgresql")}):
                    manager.filter.return_value = base_qs
                    result = service.search_documents(
                        organization_id="11111111-1111-1111-1111-111111111111",
                        space_id="22222222-2222-2222-2222-222222222222",
                        keyword="西湖",
                    )

        search_q = permitted_qs.filter.call_args.args[0]
        q_children = _flatten_q_children(search_q)
        self.assertIn(("title__icontains", "西湖"), q_children)
        self.assertIn(("description_plaintext__icontains", "西湖"), q_children)
        filtered_qs.order_by.assert_called_once_with("-title_hit", "-ts_rank", "-content_text_hit", "-updated_at")
        hit = result["items"][0]
        self.assertEqual(hit.snippet, "这里有西湖龙井正文")
        self.assertEqual(hit.relevance_score, 1.0)
        self.assertFalse(hit.matched_on_title)

    def test_import_records_success_and_failure_metrics(self):
        service = DocumentExchangeService(user=_fake_user)

        with patch.object(service, "_ensure_space_context", return_value=None):
            with patch.object(service, "check_space_permission", return_value=True):
                result = service.import_markdown_draft(
                    organization_id="11111111-1111-1111-1111-111111111111",
                    space_id="22222222-2222-2222-2222-222222222222",
                    markdown="# 标题",
                )
                self.assertIn("pm_json", result)

        with patch.object(service, "_ensure_space_context", side_effect=ValueError("bad project")):
            with self.assertRaises(ValueError):
                service.import_markdown_draft(
                    organization_id="11111111-1111-1111-1111-111111111111",
                    space_id="22222222-2222-2222-2222-222222222222",
                    markdown="# 标题",
                )

        snapshot = get_tabdoc_metrics().snapshot()
        self.assertEqual(snapshot["import"]["attempts"], 2)
        self.assertEqual(snapshot["import"]["successes"], 1)
        self.assertEqual(snapshot["import"]["failures"], 1)

    def test_restore_revision_uses_latest_version_as_base(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        target_revision = SimpleNamespace(
            content_pm_json={"type": "doc", "content": []},
            content_markdown="历史版本",
            content_plaintext="历史版本",
        )
        revisions = MagicMock()
        revisions.filter.return_value.first.return_value = target_revision
        document = SimpleNamespace(revisions=revisions, latest_version=6, updated_at=updated_at)
        service.save_content = MagicMock(return_value="restored")

        result = service.restore_revision(document, version=3)

        self.assertEqual(result, "restored")
        service.save_content.assert_called_once_with(
            document,
            base_version=6,
            base_updated_at=None,
            content_pm_json=target_revision.content_pm_json,
            content_markdown=target_revision.content_markdown,
            content_plaintext=target_revision.content_plaintext,
        )

    def test_create_named_version_raises_conflict_on_stale_updated_at(self):
        service = DocumentService(user=_fake_user)
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-1",
            latest_version=4,
            updated_at=updated_at,
            organization_id="ws-1",
            description_binary=None,
            description_json={"type": "doc", "content": []},
            description_markdown="正文",
            description_plaintext="正文",
            status="active",
        )
        snapshot_qs = MagicMock()
        snapshot_qs.filter.return_value = snapshot_qs
        snapshot_qs.values.return_value.first.return_value = None
        latest_qs = MagicMock()
        latest_qs.values_list.return_value.first.return_value = 5

        with patch(
            "apps.tabdoc.services.document_service.Document.objects.filter",
            side_effect=[snapshot_qs, latest_qs],
        ):
            with self.assertRaises(ConflictError):
                service.create_named_version(
                    document,
                    name="快照",
                    base_version=4,
                    base_updated_at=(updated_at - timedelta(seconds=5)).isoformat(),
                )

    def test_update_search_vector_uses_routed_postgresql_connection(self):
        service = DocumentService(user=_fake_user)
        document = SimpleNamespace(pk="doc-1")

        manager = MagicMock()
        qs = MagicMock()
        manager.using.return_value = manager
        manager.filter.return_value = qs

        cursor = MagicMock()
        cursor_ctx = MagicMock()
        cursor_ctx.__enter__.return_value = cursor
        cursor_ctx.__exit__.return_value = False

        conn = MagicMock()
        conn.vendor = "postgresql"
        conn.cursor.return_value = cursor_ctx

        with patch("apps.tabdoc.services.document_service.router.db_for_write", return_value="postgresql"):
            with patch("apps.tabdoc.services.document_service.Document.objects", manager):
                with patch("apps.tabdoc.services.document_service.connections", {"postgresql": conn}):
                    service._update_search_vector(document, plaintext="hello world")

        manager.using.assert_called_once_with("postgresql")
        qs.update.assert_called_once()
        cursor.execute.assert_called_once()

    def test_update_search_vector_skips_raw_sql_on_non_pg_connection(self):
        service = DocumentService(user=_fake_user)
        document = SimpleNamespace(pk="doc-2")

        manager = MagicMock()
        qs = MagicMock()
        manager.using.return_value = manager
        manager.filter.return_value = qs

        cursor = MagicMock()
        cursor_ctx = MagicMock()
        cursor_ctx.__enter__.return_value = cursor
        cursor_ctx.__exit__.return_value = False

        conn = MagicMock()
        conn.vendor = "mysql"
        conn.cursor.return_value = cursor_ctx

        with patch("apps.tabdoc.services.document_service.router.db_for_write", return_value="default"):
            with patch("apps.tabdoc.services.document_service.Document.objects", manager):
                with patch("apps.tabdoc.services.document_service.connections", {"default": conn}):
                    with patch("apps.tabdoc.services.document_service.logger.warning") as warn_mock:
                        service._update_search_vector(document, plaintext="hello world")

        qs.update.assert_called_once()
        cursor.execute.assert_not_called()
        warn_mock.assert_called()


if __name__ == "__main__":
    unittest.main()

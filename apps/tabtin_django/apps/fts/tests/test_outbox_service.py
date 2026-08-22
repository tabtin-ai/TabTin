"""`apps.fts.services.outbox_service` 的纯逻辑 + 查询结构测试。

真实 ORM 写入验证放独立集成脚本（`tests/integration/verify_outbox_migration.py`），
这里只验证：
    - db alias → Model 分发（get_model / 未知 db 抛错）
    - `action` 校验（非法值 raise）
    - `scan_outbox` 的 QuerySet 结构命中 partial index 约束（D5）
    - `mark_processed` / `mark_failed` SQL 参数正确
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.fts.models import FtsOutbox, FtsOutboxPg
from apps.fts.services import outbox_service


class GetModelTests(SimpleTestCase):

    def test_default_returns_mysql_model(self) -> None:
        self.assertIs(outbox_service.get_model("default"), FtsOutbox)

    def test_postgresql_returns_pg_model(self) -> None:
        self.assertIs(outbox_service.get_model("postgresql"), FtsOutboxPg)

    def test_unknown_db_raises(self) -> None:
        with self.assertRaises(ValueError):
            outbox_service.get_model("elastic")  # type: ignore[arg-type]


class ActionValidationTests(SimpleTestCase):

    def test_write_outbox_rejects_invalid_action(self) -> None:
        with self.assertRaises(ValueError):
            outbox_service.write_outbox(
                db="default",
                index_name="tabtin-messages",
                doc_id="m-1",
                action="ultra_weird_op",
            )


class ScanOutboxQueryStructureTests(SimpleTestCase):
    """D5：scan_outbox 必须 filter processed_at__isnull + order_by created_at。

    这里不访问真 DB，而是断言 QuerySet 的 SQL query.where / order_by 结构
    与约束一致，确保未来 refactor 不会悄悄破坏 partial index 命中条件。
    """

    def test_scan_query_uses_pending_filter_and_order(self) -> None:
        # FtsOutbox 的 QuerySet 字符串包含关键 SQL 片段
        qs = (
            FtsOutbox.objects
            .using("default")
            .filter(processed_at__isnull=True, retry_count__lt=5)
            .order_by("created_at")
        )
        sql = str(qs.query).lower()
        self.assertIn("processed_at", sql)
        self.assertIn("is null", sql)
        self.assertIn("order by", sql)
        self.assertIn("created_at", sql)

    def test_scan_outbox_calls_queryset(self) -> None:
        """scan_outbox 必须把两个过滤条件叠加且 order_by created_at。"""
        Model = FtsOutbox
        fake_result = [MagicMock(id=1), MagicMock(id=2)]
        with patch.object(outbox_service, "get_model", return_value=Model), \
             patch.object(Model, "objects") as m_objects:
            # 构造链：using().filter().order_by()[:N]
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.order_by.return_value.__getitem__.return_value = fake_result

            out = outbox_service.scan_outbox("default", limit=50)

            m_objects.using.assert_called_once_with("default")
            chain.filter.assert_called_once()
            kwargs = chain.filter.call_args.kwargs
            # D5 约束：processed_at__isnull=True 且 retry_count__lt=5
            self.assertTrue(kwargs.get("processed_at__isnull"))
            self.assertEqual(kwargs.get("retry_count__lt"), 5)
            chain.filter.return_value.order_by.assert_called_once_with("created_at")
            self.assertEqual(out, fake_result)


class MarkProcessedTests(SimpleTestCase):

    def test_mark_processed_empty_ids_returns_zero(self) -> None:
        self.assertEqual(outbox_service.mark_processed("default", []), 0)

    def test_mark_processed_calls_update_with_now(self) -> None:
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.update.return_value = 3
            n = outbox_service.mark_processed("default", [10, 11, 12])
        self.assertEqual(n, 3)
        m_objects.using.assert_called_with("default")
        chain.filter.assert_called_once()
        filter_kwargs = chain.filter.call_args.kwargs
        self.assertEqual(set(filter_kwargs.get("id__in") or []), {10, 11, 12})
        self.assertTrue(filter_kwargs.get("processed_at__isnull"))


class MarkFailedTests(SimpleTestCase):

    def test_mark_failed_increments_retry_and_writes_error(self) -> None:
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.update.return_value = 1
            outbox_service.mark_failed("default", 42, "strict_dynamic_mapping_exception: foo")
        update_kwargs = chain.filter.return_value.update.call_args.kwargs
        # F('retry_count') + 1 应作为 update 参数
        self.assertIn("retry_count", update_kwargs)
        self.assertIn("last_error", update_kwargs)
        self.assertIn("strict_dynamic", update_kwargs["last_error"])

    def test_mark_failed_truncates_long_error(self) -> None:
        long_err = "x" * 1000
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.update.return_value = 1
            outbox_service.mark_failed("default", 1, long_err)
        update_kwargs = chain.filter.return_value.update.call_args.kwargs
        # LAST_ERROR_MAX_LEN = 512
        self.assertLessEqual(len(update_kwargs["last_error"]), 512)


class MarkTerminalTests(SimpleTestCase):
    """D3 终态失败测试：STRICT_MAPPING / MAPPER_PARSING 直接置 retry_count=max。"""

    def test_mark_terminal_sets_retry_count_to_max(self) -> None:
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.update.return_value = 1
            outbox_service.mark_terminal(
                "default", 99, "strict_dynamic_mapping_exception: new_field",
            )
        kwargs = chain.filter.return_value.update.call_args.kwargs
        # retry_count 不是 F 表达式而是常量，确保一次性推到终态
        self.assertEqual(kwargs.get("retry_count"), outbox_service.TERMINAL_RETRY_COUNT)
        self.assertEqual(kwargs.get("retry_count"), 5)
        self.assertTrue(kwargs.get("last_error", "").startswith("TERMINAL:"))

    def test_mark_terminal_only_affects_pending(self) -> None:
        """filter 条件必须 processed_at__isnull=True，否则会覆盖已成功处理行。"""
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.update.return_value = 0
            outbox_service.mark_terminal("default", 1, "err")
        filter_kwargs = chain.filter.call_args.kwargs
        self.assertTrue(filter_kwargs.get("processed_at__isnull"))


class GetTerminalBacklogTests(SimpleTestCase):

    def test_filters_terminal_pending_rows(self) -> None:
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            chain = MagicMock()
            m_objects.using.return_value = chain
            chain.filter.return_value.count.return_value = 7
            n = outbox_service.get_terminal_backlog("default")
        self.assertEqual(n, 7)
        kwargs = chain.filter.call_args.kwargs
        self.assertTrue(kwargs.get("processed_at__isnull"))
        self.assertEqual(kwargs.get("retry_count__gte"), outbox_service.TERMINAL_RETRY_COUNT)


class WriteOutboxTests(SimpleTestCase):

    def test_write_outbox_truncates_long_fields(self) -> None:
        long_index = "tabtin-" + "x" * 100
        long_doc = "d" * 100
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            m_objects.using.return_value.create.return_value = MagicMock(id=1)
            outbox_service.write_outbox(
                db="default",
                index_name=long_index,
                doc_id=long_doc,
                action="upsert",
                organization_id="wt-1",
            )
        kwargs = m_objects.using.return_value.create.call_args.kwargs
        self.assertEqual(len(kwargs["index_name"]), FtsOutbox.INDEX_NAME_MAX_LEN)
        self.assertEqual(len(kwargs["doc_id"]), FtsOutbox.DOC_ID_MAX_LEN)
        self.assertEqual(kwargs["organization_id"], "wt-1")

    def test_write_outbox_accepts_none_organization(self) -> None:
        with patch.object(outbox_service, "get_model", return_value=FtsOutbox), \
             patch.object(FtsOutbox, "objects") as m_objects:
            m_objects.using.return_value.create.return_value = MagicMock(id=1)
            outbox_service.write_outbox(
                db="default",
                index_name="tabtin-messages",
                doc_id="m-1",
                action="delete",
                organization_id=None,
            )
        kwargs = m_objects.using.return_value.create.call_args.kwargs
        self.assertIsNone(kwargs["organization_id"])

"""`apps.fts.tasks` 的 Wave 1 行为测试。

测试 flush / scan / update_by_query / delete_by_query 四个 task
在不同场景下的职责分工。

覆盖：
    - is_engine_enabled=false 时 task 直接 return
    - flush_outbox_task：成功 / 失败 / 业务数据不存在的路径
    - flush_outbox_task：breaker open 时返回 aborted_reason
    - scan_outbox_tick 分发两库
    - delete_by_query_task 组装正确的 body
    - update_by_query_task 组装 painless 脚本
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.fts import tasks


# ── flush_outbox_task ────────────────────────────────────────────
@override_settings(SEARCH_ENGINE_ENABLED=False)
class FlushOutboxDisabledTests(SimpleTestCase):

    def test_disabled_skips(self) -> None:
        with patch("apps.fts.tasks.scan_outbox") as scan:
            out = tasks.flush_outbox_task.run(db="default")
        scan.assert_not_called()
        self.assertEqual(out, {"skipped": "engine_disabled"})


@override_settings(SEARCH_ENGINE_ENABLED=True)
class FlushOutboxEmptyTests(SimpleTestCase):

    def test_empty_outbox_skips(self) -> None:
        with patch("apps.fts.tasks.scan_outbox", return_value=[]):
            out = tasks.flush_outbox_task.run(db="default")
        self.assertEqual(out, {"skipped": "empty_outbox"})


@override_settings(SEARCH_ENGINE_ENABLED=True)
class FlushOutboxSuccessTests(SimpleTestCase):

    def test_upsert_fetches_instance_and_builds_action(self) -> None:
        row = MagicMock()
        row.id = 1
        row.index_name = "tabtin-resources"
        row.doc_id = "item-1"
        row.action = "upsert"

        instance = MagicMock()
        instance.id = "item-1"
        instance.item_type = "tabdoc"
        instance.title = "t"
        instance.preview = "p"
        instance.resource_id = "r"
        instance.workspace_id = "s1"
        instance.project_id = None
        instance.is_archived = False
        instance.trashed_at = None
        instance.created_by_id = "u1"
        from datetime import datetime, timezone as _tz
        instance.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        instance.updated_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        workspace = MagicMock()
        workspace.organization_id = "wt-1"
        instance.workspace = workspace
        instance.project = None

        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=instance), \
             patch("apps.fts.tasks.get_client") as gc, \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            flush_result = MagicMock(
                succeeded_row_ids=[1],
                failed_items=[],
                total_actions=1,
                classified_counts={},
            )
            br.return_value = flush_result
            out = tasks.flush_outbox_task.run(db="postgresql")
        mp.assert_called_once_with("postgresql", [1])
        mf.assert_not_called()
        self.assertEqual(out["attempted"], 1)
        self.assertEqual(out["success"], 1)
        self.assertEqual(out["failed"], 0)

    def test_upsert_missing_instance_marks_processed(self) -> None:
        """业务数据已删 → 视作 noop 推进 processed_at。"""
        row = MagicMock()
        row.id = 7
        row.index_name = "tabtin-resources"
        row.doc_id = "ghost"
        row.action = "upsert"
        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=None), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run"), \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            out = tasks.flush_outbox_task.run(db="postgresql")
        mp.assert_called_once_with("postgresql", [7])
        mf.assert_not_called()

    def test_single_message_delete_without_created_at_falls_back_to_dbq(self) -> None:
        """Wave 5 R1-04 兜底：无 created_at 时单条 messages delete 走 delete_by_query_task。

        理论上 outbox 行总有 auto_now_add 字段；保留兜底避免历史数据 / 测试 mock
        缺字段时无法处理。
        """
        row = MagicMock()
        row.id = 5
        row.index_name = "tabtin-messages"
        row.doc_id = "msg-123"
        row.action = "delete"
        row.created_at = None  # 显式兜底场景
        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks.delete_by_query_task") as dbq, \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            out = tasks.flush_outbox_task.run(db="default")
        dbq.delay.assert_called_once()
        call_kwargs = dbq.delay.call_args.kwargs or {}
        self.assertEqual(call_kwargs.get("field"), "message_id")
        self.assertEqual(call_kwargs.get("value"), "msg-123")
        # skip rows 推进 processed
        mp.assert_called_once_with("default", [5])
        mf.assert_not_called()

    def test_single_message_delete_with_created_at_goes_to_bulk(self) -> None:
        """Wave 5 R1-04 优化：有 created_at 时单条 messages delete 走 bulk delete。

        原方案（Wave 1）：所有 messages delete 都 delete_by_query → 多 1 次 ES round-trip
        新方案（Wave 5）：用 outbox.created_at 推断月度索引名，直接 bulk delete
        """
        from datetime import datetime, timezone as _tz
        row = MagicMock()
        row.id = 9
        row.index_name = "tabtin-messages"
        row.doc_id = "msg-456"
        row.action = "delete"
        row.created_at = datetime(2026, 4, 17, 12, 0, 0, tzinfo=_tz.utc)
        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks.delete_by_query_task") as dbq, \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            br.return_value = MagicMock(
                succeeded_row_ids=[9],
                failed_items=[],
                total_actions=1,
                classified_counts={},
                idempotent_deletes=0,
                idempotent_delete_targets=[],
            )
            tasks.flush_outbox_task.run(db="default")
        # 不应走 delete_by_query 兜底
        dbq.delay.assert_not_called()
        # bulk 必走（execute_bulk 通过 breaker_run 包裹）
        br.assert_called_once()
        # 推进成功
        mp.assert_called_once_with("default", [9])
        mf.assert_not_called()

    def test_messages_idempotent_delete_triggers_dbq_fallback(self) -> None:
        """Wave 5 三视角 Review C3 修复：messages 索引 bulk delete 拿到 404
        触发 delete_by_query 兜底（防月份边界 silent loss）。"""
        from datetime import datetime, timezone as _tz
        row = MagicMock()
        row.id = 11
        row.index_name = "tabtin-messages"
        row.doc_id = "msg-789"
        row.action = "delete"
        row.created_at = datetime(2026, 4, 30, 23, 59, 59, 999999, tzinfo=_tz.utc)
        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks.delete_by_query_task") as dbq, \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            # bulk delete 命中 404 not_found → idempotent_delete_targets 含本条
            br.return_value = MagicMock(
                succeeded_row_ids=[11],
                failed_items=[],
                total_actions=1,
                classified_counts={},
                idempotent_deletes=1,
                idempotent_delete_targets=[("tabtin-messages-2026-04", "msg-789")],
            )
            tasks.flush_outbox_task.run(db="default")
        # C3 修复要求：必须触发 delete_by_query 兜底（按 message_id 跨月匹配）
        dbq.delay.assert_called_once()
        kwargs = dbq.delay.call_args.kwargs or {}
        self.assertEqual(kwargs.get("index_alias"), "tabtin-messages")
        self.assertEqual(kwargs.get("field"), "message_id")
        self.assertEqual(kwargs.get("value"), "msg-789")
        # 同时仍 mark_processed（idempotent delete 视为成功）
        mp.assert_called_once_with("default", [11])

    def test_non_messages_idempotent_delete_no_dbq_fallback(self) -> None:
        """非 messages 索引（resources 等）的 idempotent delete 不触发 dbq 兜底。

        因为 resources 不是 rollover 索引，不存在月份边界问题，404 真就是幂等。
        """
        row = MagicMock()
        row.id = 12
        row.index_name = "tabtin-resources"
        row.doc_id = "res-3"
        row.action = "delete"
        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks.delete_by_query_task") as dbq, \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_processed"):
            br.return_value = MagicMock(
                succeeded_row_ids=[12],
                failed_items=[],
                total_actions=1,
                classified_counts={},
                idempotent_deletes=1,
                idempotent_delete_targets=[("tabtin-resources", "res-3")],
            )
            tasks.flush_outbox_task.run(db="postgresql")
        # 不应走 dbq 兜底
        dbq.delay.assert_not_called()

    def test_delete_non_message_index_enters_bulk(self) -> None:
        """tabtin-resources 的 delete 直接 bulk delete。"""
        row = MagicMock()
        row.id = 3
        row.index_name = "tabtin-resources"
        row.doc_id = "res-1"
        row.action = "delete"
        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            br.return_value = MagicMock(
                succeeded_row_ids=[3],
                failed_items=[],
                total_actions=1,
                classified_counts={},
            )
            tasks.flush_outbox_task.run(db="postgresql")
        # breaker_run 被调用（execute_bulk 是第一个 arg）
        br.assert_called_once()
        mp.assert_called_once_with("postgresql", [3])


@override_settings(SEARCH_ENGINE_ENABLED=True)
class FlushOutboxBreakerOpenTests(SimpleTestCase):

    def test_breaker_error_aborts_without_mark_failed(self) -> None:
        """breaker open 时不推进 processed_at，返回 aborted_reason。"""
        from pybreaker import CircuitBreakerError
        row = MagicMock()
        row.id = 1
        row.index_name = "tabtin-resources"
        row.doc_id = "r-1"
        row.action = "upsert"
        instance = MagicMock()
        instance.trashed_at = None
        instance.item_type = "x"
        instance.title = "x"
        instance.preview = ""
        instance.resource_id = ""
        instance.workspace_id = "s"
        instance.project_id = None
        instance.is_archived = False
        instance.created_by_id = None
        from datetime import datetime, timezone as _tz
        instance.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        instance.updated_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        workspace = MagicMock()
        workspace.organization_id = "wt-1"
        instance.workspace = workspace
        instance.project = None

        with patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=instance), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run", side_effect=CircuitBreakerError("open")), \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf:
            out = tasks.flush_outbox_task.run(db="postgresql")
        self.assertEqual(out.get("aborted_reason"), "circuit_breaker_open")
        mp.assert_not_called()
        mf.assert_not_called()


@override_settings(SEARCH_ENGINE_ENABLED=True)
class FlushOutboxBulkFailureTests(SimpleTestCase):

    def _make_ok_instance(self):
        good = MagicMock()
        good.trashed_at = None
        good.item_type = "x"; good.title = "ok"; good.preview = ""
        good.resource_id = ""; good.workspace_id = "s"; good.project_id = None
        good.is_archived = False
        good.created_by_id = None
        from datetime import datetime, timezone as _tz
        good.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        good.updated_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        workspace = MagicMock()
        workspace.organization_id = "wt-1"
        good.workspace = workspace
        good.project = None
        return good

    def test_strict_mapping_failure_marks_terminal(self) -> None:
        """D3 修正：strict_dynamic_mapping_exception → `mark_terminal` 而非 mark_failed，
        避免无意义重试 5 次 ES 带宽；Wave 5 Grafana 按 terminal_backlog 告警。"""
        row_ok = MagicMock(id=1, index_name="tabtin-resources", doc_id="r-1", action="upsert")
        row_bad = MagicMock(id=2, index_name="tabtin-resources", doc_id="r-2", action="upsert")

        with patch("apps.fts.tasks.scan_outbox", return_value=[row_ok, row_bad]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=self._make_ok_instance()), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_processed") as mp, \
             patch("apps.fts.tasks.mark_failed") as mf, \
             patch("apps.fts.tasks.mark_terminal") as mt:
            from apps.fts.services.bulk_buffer import FailureClass
            flush_result = MagicMock(
                succeeded_row_ids=[1],
                failed_items=[(2, FailureClass.STRICT_MAPPING, "strict_dynamic_mapping_exception: foo")],
                total_actions=2,
                classified_counts={FailureClass.STRICT_MAPPING: 1},
            )
            br.return_value = flush_result
            out = tasks.flush_outbox_task.run(db="postgresql")

        mp.assert_called_once_with("postgresql", [1])
        mf.assert_not_called()  # 终态类不走 mark_failed
        mt.assert_called_once()  # 走 mark_terminal
        mt_args = mt.call_args.args
        self.assertEqual(mt_args[0], "postgresql")
        self.assertEqual(mt_args[1], 2)
        self.assertIn("strict_dynamic", mt_args[2])
        self.assertEqual(out["failed"], 1)

    def test_mapper_parsing_also_marks_terminal(self) -> None:
        """MAPPER_PARSING 同为 schema 类终态失败。"""
        row_bad = MagicMock(id=10, index_name="tabtin-resources", doc_id="r-10", action="upsert")
        with patch("apps.fts.tasks.scan_outbox", return_value=[row_bad]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=self._make_ok_instance()), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_terminal") as mt, \
             patch("apps.fts.tasks.mark_failed") as mf:
            from apps.fts.services.bulk_buffer import FailureClass
            br.return_value = MagicMock(
                succeeded_row_ids=[],
                failed_items=[(10, FailureClass.MAPPER_PARSING, "mapper_parsing_exception: type mismatch")],
                total_actions=1,
                classified_counts={FailureClass.MAPPER_PARSING: 1},
            )
            tasks.flush_outbox_task.run(db="postgresql")
        mt.assert_called_once()
        mf.assert_not_called()

    def test_transient_failure_marks_failed_not_terminal(self) -> None:
        """网络/集群 transient 错误仍走 mark_failed，等下轮 scan 重试。"""
        row_bad = MagicMock(id=20, index_name="tabtin-resources", doc_id="r-20", action="upsert")
        with patch("apps.fts.tasks.scan_outbox", return_value=[row_bad]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=self._make_ok_instance()), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_terminal") as mt, \
             patch("apps.fts.tasks.mark_failed") as mf:
            from apps.fts.services.bulk_buffer import FailureClass
            br.return_value = MagicMock(
                succeeded_row_ids=[],
                failed_items=[(20, FailureClass.TRANSIENT, "connection timeout")],
                total_actions=1,
                classified_counts={FailureClass.TRANSIENT: 1},
            )
            tasks.flush_outbox_task.run(db="postgresql")
        mf.assert_called_once()
        mt.assert_not_called()


# ── scan_outbox_tick ────────────────────────────────────────────
@override_settings(SEARCH_ENGINE_ENABLED=True)
class ScanOutboxTickTests(SimpleTestCase):

    def test_dispatches_both_dbs(self) -> None:
        with patch("apps.fts.tasks.flush_outbox_task") as fl:
            tasks.scan_outbox_tick()
        dbs = [call.kwargs.get("db") for call in fl.delay.call_args_list]
        self.assertCountEqual(dbs, ["default", "postgresql"])


@override_settings(SEARCH_ENGINE_ENABLED=False)
class ScanOutboxTickDisabledTests(SimpleTestCase):

    def test_skips_when_flag_off(self) -> None:
        with patch("apps.fts.tasks.flush_outbox_task") as fl:
            tasks.scan_outbox_tick()
        fl.delay.assert_not_called()


# ── update_by_query_task ─────────────────────────────────────────
@override_settings(SEARCH_ENGINE_ENABLED=True)
class UpdateByQueryTests(SimpleTestCase):

    def test_composes_painless_script(self) -> None:
        with patch("apps.fts.tasks.get_client") as gc, \
             patch("apps.fts.tasks.breaker_run") as br:
            client = MagicMock()
            gc.return_value = client
            tasks.update_by_query_task.run(
                index_alias="tabtin-messages",
                field="session_id",
                value="sess-1",
                partial_doc={"session_title": "new title", "session_status": "archived"},
            )
        br.assert_called_once()
        # breaker_run(client.update_by_query, index=, body=, conflicts=, ...)
        call_args = br.call_args
        # 第一个参数是 client.update_by_query
        self.assertEqual(call_args.args[0], client.update_by_query)
        body = call_args.kwargs["body"]
        self.assertEqual(body["query"], {"term": {"session_id": "sess-1"}})
        script = body["script"]
        self.assertEqual(script["lang"], "painless")
        self.assertIn("ctx._source.session_title", script["source"])
        self.assertIn("ctx._source.session_status", script["source"])
        # params 覆盖
        self.assertIn("new title", script["params"].values())
        self.assertIn("archived", script["params"].values())
        self.assertEqual(call_args.kwargs["conflicts"], "proceed")
        self.assertFalse(call_args.kwargs["wait_for_completion"])

    def test_empty_partial_returns(self) -> None:
        with patch("apps.fts.tasks.get_client") as gc:
            tasks.update_by_query_task.run(
                index_alias="tabtin-messages",
                field="session_id",
                value="s1",
                partial_doc={},
            )
        gc.assert_not_called()


# ── delete_by_query_task ─────────────────────────────────────────
@override_settings(SEARCH_ENGINE_ENABLED=True)
class DeleteByQueryTests(SimpleTestCase):

    def test_builds_term_query_body(self) -> None:
        with patch("apps.fts.tasks.get_client") as gc, \
             patch("apps.fts.tasks.breaker_run") as br:
            client = MagicMock()
            gc.return_value = client
            tasks.delete_by_query_task.run(
                index_alias="tabtin-messages",
                field="session_id",
                value="sess-1",
            )
        br.assert_called_once()
        call_args = br.call_args
        self.assertEqual(call_args.args[0], client.delete_by_query)
        self.assertEqual(call_args.kwargs["index"], "tabtin-messages")
        self.assertEqual(
            call_args.kwargs["body"],
            {"query": {"term": {"session_id": "sess-1"}}},
        )
        self.assertEqual(call_args.kwargs["conflicts"], "proceed")
        self.assertFalse(call_args.kwargs["wait_for_completion"])


# ── Beat schedule 定义 ──────────────────────────────────────────
@override_settings(SEARCH_ENGINE_ENABLED=True)
class BeatScheduleTests(SimpleTestCase):

    def test_fts_beat_schedule_has_required_entries(self) -> None:
        schedule = tasks.get_fts_beat_schedule()
        self.assertIn("fts-scan-outbox", schedule)
        self.assertIn("fts-health-probe", schedule)

    def test_scan_outbox_every_5s(self) -> None:
        entry = tasks.get_fts_beat_schedule()["fts-scan-outbox"]
        self.assertEqual(entry["schedule"], 5.0)
        self.assertEqual(entry["task"], "apps.fts.tasks.scan_outbox_tick")
        self.assertEqual(entry["options"]["queue"], "search_indexing")

    def test_health_probe_every_10s(self) -> None:
        entry = tasks.get_fts_beat_schedule()["fts-health-probe"]
        self.assertEqual(entry["schedule"], 10.0)
        self.assertEqual(entry["task"], "apps.fts.tasks.health_probe_task")
        self.assertEqual(entry["options"]["queue"], "search_indexing")


@override_settings(SEARCH_ENGINE_ENABLED=False)
class BeatScheduleDisabledTests(SimpleTestCase):

    def test_no_producers_when_search_disabled(self) -> None:
        """flag=false 时不得注册会投递 search_indexing 的 beat 条目。"""
        self.assertEqual(tasks.get_fts_beat_schedule(), {})


# ── _resolve_logical_from_index_name 反查 ───────────────────────
class ResolveLogicalTests(SimpleTestCase):

    def test_messages_alias(self) -> None:
        self.assertEqual(
            tasks._resolve_logical_from_index_name("tabtin-messages"),
            "messages",
        )

    def test_resources_alias(self) -> None:
        self.assertEqual(
            tasks._resolve_logical_from_index_name("tabtin-resources"),
            "resources",
        )

    def test_unknown_returns_none(self) -> None:
        self.assertIsNone(
            tasks._resolve_logical_from_index_name("tabtin-foo"),
        )

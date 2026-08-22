"""`apps.fts.services.bulk_buffer` 失败隔离测试（D3 规范）。

测试要点：
    - 100 条含 1 条 `strict_dynamic_mapping_exception`，99 条成功 + 1 条失败
    - 网络类错误 → 整批抛 ConnectionError 由上层 caller 处理
    - classify_failure 对几种常见错误类型分级正确
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.fts.services import bulk_buffer
from apps.fts.services.bulk_buffer import BulkAction, FailureClass, classify_failure


class ClassifyFailureTests(SimpleTestCase):

    def test_strict_dynamic_mapping_exception(self) -> None:
        self.assertEqual(
            classify_failure("strict_dynamic_mapping_exception", "bad field"),
            FailureClass.STRICT_MAPPING,
        )

    def test_mapper_parsing_exception(self) -> None:
        self.assertEqual(
            classify_failure("mapper_parsing_exception", "x"),
            FailureClass.MAPPER_PARSING,
        )

    def test_illegal_argument_exception_maps_to_mapper_parsing(self) -> None:
        # illegal_argument_exception 属于 schema/数据问题（D3 不自动重试）
        self.assertEqual(
            classify_failure("illegal_argument_exception", "x"),
            FailureClass.MAPPER_PARSING,
        )

    def test_es_rejected_execution_maps_to_transient(self) -> None:
        """集群繁忙/队列满 → TRANSIENT，允许重试。"""
        self.assertEqual(
            classify_failure("es_rejected_execution_exception", "queue full"),
            FailureClass.TRANSIENT,
        )

    def test_document_parsing_maps_to_mapper_parsing(self) -> None:
        self.assertEqual(
            classify_failure("document_parsing_exception", "bad json"),
            FailureClass.MAPPER_PARSING,
        )

    def test_version_conflict(self) -> None:
        self.assertEqual(
            classify_failure("version_conflict_engine_exception", "conflict"),
            FailureClass.CONFLICT,
        )

    def test_unknown_goes_to_transient(self) -> None:
        self.assertEqual(
            classify_failure(None, "timeout"),
            FailureClass.TRANSIENT,
        )


def _make_actions(n: int, indices: list[str] | None = None) -> list[BulkAction]:
    indices = indices or ["tabtin-messages-2026-04"] * n
    return [
        BulkAction(
            _op_type="index",
            _index=indices[i],
            _id=f"doc-{i}",
            row_id=100 + i,
            _source={"message_id": f"doc-{i}", "content": f"content-{i}"},
        )
        for i in range(n)
    ]


class ExecuteBulkTests(SimpleTestCase):

    def test_empty_actions_returns_empty_result(self) -> None:
        fake_client = MagicMock()
        result = bulk_buffer.execute_bulk(fake_client, [])
        self.assertEqual(result.total_actions, 0)
        self.assertEqual(result.succeeded_row_ids, [])
        self.assertEqual(result.failed_items, [])

    def test_all_success(self) -> None:
        actions = _make_actions(5)
        fake_client = MagicMock()

        with patch("elasticsearch.helpers.bulk", return_value=(5, [])):
            result = bulk_buffer.execute_bulk(fake_client, actions)

        self.assertEqual(result.total_actions, 5)
        self.assertEqual(len(result.succeeded_row_ids), 5)
        self.assertEqual(result.failed_items, [])

    def test_one_strict_dynamic_failure_isolates(self) -> None:
        """D3：100 条 1 条 strict_dynamic 失败，其他 99 条成功入库。"""
        actions = _make_actions(100)
        failed_doc_id = "doc-42"
        errors = [
            {
                "index": {
                    "_id": failed_doc_id,
                    "status": 400,
                    "error": {
                        "type": "strict_dynamic_mapping_exception",
                        "reason": "mapping set to strict, dynamic introduction of [foo] not allowed",
                    },
                }
            }
        ]
        fake_client = MagicMock()

        with patch("elasticsearch.helpers.bulk", return_value=(99, errors)):
            result = bulk_buffer.execute_bulk(fake_client, actions)

        self.assertEqual(result.total_actions, 100)
        self.assertEqual(len(result.succeeded_row_ids), 99)
        self.assertEqual(len(result.failed_items), 1)
        row_id, cls_name, raw_err = result.failed_items[0]
        self.assertEqual(row_id, 100 + 42)
        self.assertEqual(cls_name, FailureClass.STRICT_MAPPING)
        self.assertIn("strict_dynamic", raw_err)
        # breakdown 计数
        self.assertEqual(
            result.classified_counts.get(FailureClass.STRICT_MAPPING), 1,
        )

    def test_multiple_failures_distinct_classes(self) -> None:
        actions = _make_actions(10)
        errors = [
            {"index": {"_id": "doc-1", "status": 400,
                       "error": {"type": "strict_dynamic_mapping_exception", "reason": "x"}}},
            {"index": {"_id": "doc-3", "status": 400,
                       "error": {"type": "mapper_parsing_exception", "reason": "type mismatch"}}},
            {"index": {"_id": "doc-5", "status": 503,
                       "error": {"type": "es_rejected_execution_exception", "reason": "queue full"}}},
        ]
        fake_client = MagicMock()
        with patch("elasticsearch.helpers.bulk", return_value=(7, errors)):
            result = bulk_buffer.execute_bulk(fake_client, actions)

        # 7 条成功，3 条失败
        self.assertEqual(len(result.succeeded_row_ids), 7)
        self.assertEqual(len(result.failed_items), 3)

        cls_counts = result.classified_counts
        self.assertEqual(cls_counts.get(FailureClass.STRICT_MAPPING), 1)
        self.assertEqual(cls_counts.get(FailureClass.MAPPER_PARSING), 1)
        # es_rejected_execution_exception → TRANSIENT（集群繁忙，允许重试）
        self.assertEqual(cls_counts.get(FailureClass.TRANSIENT), 1)
        total_counted = sum(cls_counts.values())
        self.assertEqual(total_counted, 3)

    def test_delete_action_is_formatted(self) -> None:
        action = BulkAction(
            _op_type="delete",
            _index="tabtin-resources",
            _id="res-1",
            row_id=1,
        )
        self.assertEqual(
            action.to_bulk_dict(),
            {"_op_type": "delete", "_index": "tabtin-resources", "_id": "res-1"},
        )

    def test_index_action_includes_source(self) -> None:
        action = BulkAction(
            _op_type="index",
            _index="tabtin-resources",
            _id="res-1",
            row_id=1,
            _source={"title": "x"},
        )
        d = action.to_bulk_dict()
        self.assertEqual(d["_op_type"], "index")
        self.assertEqual(d["_source"], {"title": "x"})


class IdempotentDeleteNotFoundTests(SimpleTestCase):
    """HIGH-4 修复：bulk delete 拿到 ES 404 not_found 应当幂等成功。

    复现路径：trash → delete outbox → flush → ES 删 → 再 .delete() →
    再发 delete outbox → flush 时 ES 已无 doc，返回 404 not_found；
    helpers.bulk 把它放进 errors（status >= 400），但语义上是"目标态
    已达成"，必须当 success，不能 retry 5 次。
    """

    def test_single_delete_not_found_is_success_not_failure(self) -> None:
        action = BulkAction(_op_type="delete", _index="tabtin-resources",
                            _id="r-1", row_id=99)
        # ES bulk 返回的 errors 形式：{"delete": {"_id": ..., "status": 404,
        # "result": "not_found"}}（注意 helpers.bulk 把 status>=400 都放 errors）
        errors = [{"delete": {
            "_id": "r-1",
            "status": 404,
            "result": "not_found",
        }}]
        fake_client = MagicMock()
        with patch("elasticsearch.helpers.bulk", return_value=(0, errors)):
            result = bulk_buffer.execute_bulk(fake_client, [action])

        # 关键：不进 failed_items，不调 mark_failed
        self.assertEqual(len(result.failed_items), 0)
        # 计入 succeeded（外层 flush_outbox_task 会 mark_processed）
        self.assertEqual(result.succeeded_row_ids, [99])
        # idempotent 计数
        self.assertEqual(result.idempotent_deletes, 1)
        # 没有任何 FailureClass 计入
        self.assertEqual(result.classified_counts, {})

    def test_mixed_real_failure_and_idempotent_delete(self) -> None:
        """同批：1 条 strict_dynamic 真失败 + 1 条 delete 404 幂等 + 8 条正常。"""
        actions = _make_actions(8)  # 8 条 index OK
        actions.append(BulkAction(_op_type="delete", _index="tabtin-messages-2026-04",
                                  _id="m-bad", row_id=200))
        actions.append(BulkAction(_op_type="delete", _index="tabtin-messages-2026-04",
                                  _id="m-ghost", row_id=300))
        errors = [
            {"index": {"_id": "doc-3", "status": 400,
                       "error": {"type": "strict_dynamic_mapping_exception", "reason": "x"}}},
            {"delete": {"_id": "m-ghost", "status": 404, "result": "not_found"}},
        ]
        fake_client = MagicMock()
        with patch("elasticsearch.helpers.bulk", return_value=(8, errors)):
            result = bulk_buffer.execute_bulk(fake_client, actions)

        # strict_dynamic 1 条进 failed_items
        self.assertEqual(len(result.failed_items), 1)
        self.assertEqual(result.failed_items[0][1], FailureClass.STRICT_MAPPING)
        # ghost delete 计入 idempotent + success
        self.assertEqual(result.idempotent_deletes, 1)
        # 9 条成功（7 条 index OK + 1 条 m-bad delete + 1 条 m-ghost 幂等）
        # 注意：strict 失败的是 doc-3，对应 actions 索引 3，被加到 failed_positions
        self.assertEqual(len(result.succeeded_row_ids), 9)
        self.assertNotIn(actions[3].row_id, result.succeeded_row_ids)


class UnknownErrorTypeTests(SimpleTestCase):
    """D2 盲区补丁：未知 error_type 默认归 TRANSIENT 行为必须有显式测试。

    防止未来有人改 classify_failure 把 None → STRICT_MAPPING（沉默泄漏到
    mark_terminal）或改成 raise（破坏整批 flush）。
    """

    def test_unknown_error_type_defaults_to_transient(self) -> None:
        self.assertEqual(
            classify_failure(None, "some weird transport error"),
            FailureClass.TRANSIENT,
        )
        self.assertEqual(
            classify_failure("", "completely unknown_exception_type_yyy"),
            FailureClass.TRANSIENT,
        )
        # 未在 4 个分类匹配的 exception name 也归 transient（保守）
        self.assertEqual(
            classify_failure("totally_made_up_exception", "x"),
            FailureClass.TRANSIENT,
        )

    def test_unknown_error_routes_to_mark_failed_not_terminal(self) -> None:
        """通过 ES 错误流到 flush_outbox_task 验证 unknown 走 mark_failed
        而非 mark_terminal。这是为了避免 D2 盲区：未知错误类型不能被
        当作 schema 类终态失败处理（schema 错误才需要 SRE 介入）。
        """
        from apps.fts import tasks
        row = MagicMock(id=1, index_name="tabtin-resources", doc_id="r-1", action="upsert")
        instance = MagicMock()
        instance.trashed_at = None
        instance.item_type = "x"; instance.title = "x"; instance.preview = ""
        instance.resource_id = ""; instance.workspace_id = "s"; instance.project_id = None
        instance.is_archived = False
        instance.created_by_id = None
        from datetime import datetime, timezone as _tz
        instance.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        instance.updated_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        workspace = MagicMock()
        workspace.organization_id = "wt-1"
        instance.workspace = workspace
        instance.project = None

        from django.test import override_settings
        with override_settings(SEARCH_ENGINE_ENABLED=True), \
             patch("apps.fts.tasks.scan_outbox", return_value=[row]), \
             patch("apps.fts.tasks._fetch_instance_for_logical", return_value=instance), \
             patch("apps.fts.tasks.get_client"), \
             patch("apps.fts.tasks.breaker_run") as br, \
             patch("apps.fts.tasks.mark_terminal") as mt, \
             patch("apps.fts.tasks.mark_failed") as mf, \
             patch("apps.fts.tasks.mark_processed"):
            br.return_value = MagicMock(
                succeeded_row_ids=[],
                failed_items=[(1, FailureClass.TRANSIENT, "unknown: connection reset by peer")],
                total_actions=1,
                classified_counts={FailureClass.TRANSIENT: 1},
                idempotent_deletes=0,
            )
            tasks.flush_outbox_task.run(db="postgresql")
        mf.assert_called_once()
        mt.assert_not_called()

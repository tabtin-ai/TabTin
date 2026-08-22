"""R5-13 修复验证：fts_requeue_terminal 命令 + outbox_service.requeue_terminal。

测试矩阵：
    服务层 outbox_service.requeue_terminal:
        - 空 row_ids → 0
        - 真行 update：mock get_model + ORM chain，断言 filter 条件齐全
        - 幂等：只动 retry_count >= TERMINAL_RETRY_COUNT AND processed_at IS NULL
        - clear_error=True 时清 last_error；False 时保留
        - list_terminal_rows 接受 row_ids 子集

    Management command 调用链 + 参数解析：
        - --row-id / --all 互斥
        - --row-id=1,2,3 解析正确
        - --dry-run 不调真 requeue（只调 list）
        - --db=both 调两库
        - --all + 超 limit 必须 --confirm-large
"""
from __future__ import annotations

from io import StringIO
from unittest.mock import MagicMock, patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase

from apps.fts.services import outbox_service
from apps.fts.services.outbox_service import (
    TERMINAL_RETRY_COUNT,
    list_terminal_rows,
    requeue_terminal,
)


# ── 服务层 ──────────────────────────────────────────────────
class RequeueTerminalServiceTests(SimpleTestCase):
    def test_empty_returns_zero(self):
        self.assertEqual(requeue_terminal("default", []), 0)

    def test_filter_chain_correct(self):
        with patch.object(outbox_service, "get_model") as get_model_mock:
            Model = MagicMock()
            get_model_mock.return_value = Model
            qs = Model.objects.using.return_value.filter.return_value
            qs.update.return_value = 3

            n = requeue_terminal("postgresql", [10, 20, 30])

            Model.objects.using.assert_called_once_with("postgresql")
            # filter 必须含 3 个条件：id__in / processed_at__isnull / retry_count__gte
            args, kwargs = Model.objects.using.return_value.filter.call_args
            self.assertEqual(kwargs["id__in"], [10, 20, 30])
            self.assertTrue(kwargs["processed_at__isnull"])
            self.assertEqual(kwargs["retry_count__gte"], TERMINAL_RETRY_COUNT)
            # update 调用：retry_count=0 + last_error="" (clear_error=True 默认)
            qs.update.assert_called_once()
            update_kwargs = qs.update.call_args[1]
            self.assertEqual(update_kwargs["retry_count"], 0)
            self.assertEqual(update_kwargs["last_error"], "")
        self.assertEqual(n, 3)

    def test_keep_error_does_not_clear_last_error(self):
        with patch.object(outbox_service, "get_model") as get_model_mock:
            Model = MagicMock()
            get_model_mock.return_value = Model
            qs = Model.objects.using.return_value.filter.return_value
            qs.update.return_value = 1

            requeue_terminal("default", [99], clear_error=False)

            update_kwargs = qs.update.call_args[1]
            self.assertNotIn("last_error", update_kwargs)
            self.assertEqual(update_kwargs["retry_count"], 0)


class ListTerminalRowsTests(SimpleTestCase):
    def test_default_filter_no_row_ids(self):
        with patch.object(outbox_service, "get_model") as get_model_mock:
            Model = MagicMock()
            get_model_mock.return_value = Model
            qs = Model.objects.using.return_value.filter.return_value
            qs.order_by.return_value.__getitem__.return_value = ["row1", "row2"]

            rows = list_terminal_rows("postgresql", limit=50)

            kwargs = Model.objects.using.return_value.filter.call_args[1]
            self.assertTrue(kwargs["processed_at__isnull"])
            self.assertEqual(kwargs["retry_count__gte"], TERMINAL_RETRY_COUNT)
        self.assertEqual(rows, ["row1", "row2"])

    def test_with_row_ids_adds_filter(self):
        with patch.object(outbox_service, "get_model") as get_model_mock:
            Model = MagicMock()
            get_model_mock.return_value = Model
            qs1 = Model.objects.using.return_value.filter.return_value
            qs2 = qs1.filter.return_value
            qs2.order_by.return_value.__getitem__.return_value = []

            list_terminal_rows("default", limit=10, row_ids=[1, 2, 3])

            qs1.filter.assert_called_once_with(id__in=[1, 2, 3])


# ── Management command ──────────────────────────────────────
class CommandArgsTests(SimpleTestCase):
    def test_row_id_and_all_are_mutually_exclusive(self):
        with self.assertRaises(CommandError) as ctx:
            call_command("fts_requeue_terminal", "--row-id=1", "--all")
        self.assertIn("互斥", str(ctx.exception))

    def test_must_specify_one(self):
        with self.assertRaises(CommandError) as ctx:
            call_command("fts_requeue_terminal", "--db=default")
        self.assertIn("必须指定", str(ctx.exception))

    def test_invalid_row_id_format_raises(self):
        with self.assertRaises(CommandError) as ctx:
            call_command("fts_requeue_terminal", "--db=default", "--row-id=abc,42")
        self.assertIn("逗号分隔的整数", str(ctx.exception))


class CommandDryRunBehaviourTests(SimpleTestCase):
    def test_dry_run_does_not_call_requeue(self):
        """--dry-run 必须只调 list_terminal_rows，绝不能真改数据。"""
        out = StringIO()
        fake_row = MagicMock(
            id=42, index_name="tabtin-resources", doc_id="doc-uuid",
            action="upsert", retry_count=5,
            last_error="TERMINAL: strict_dynamic_mapping_exception ...",
        )

        with patch.object(
            outbox_service, "list_terminal_rows", return_value=[fake_row]
        ) as list_mock, \
             patch.object(outbox_service, "requeue_terminal") as requeue_mock:
            call_command(
                "fts_requeue_terminal",
                "--db=default", "--row-id=42", "--dry-run",
                stdout=out,
            )
            list_mock.assert_called_once()
            requeue_mock.assert_not_called()  # 关键：dry-run 绝不真改

        output = out.getvalue()
        self.assertIn("dry-run", output)
        self.assertIn("42", output)


class CommandRealRequeueTests(SimpleTestCase):
    def test_row_id_real_requeue_calls_service(self):
        out = StringIO()
        fake_rows = [MagicMock(id=i, index_name="tabtin-memos", doc_id=f"d{i}",
                               action="upsert", retry_count=5, last_error="x")
                     for i in (1, 2, 3)]

        with patch.object(
            outbox_service, "list_terminal_rows", return_value=fake_rows
        ), patch.object(
            outbox_service, "requeue_terminal", return_value=3
        ) as requeue_mock:
            call_command(
                "fts_requeue_terminal",
                "--db=default", "--row-id=1,2,3",
                stdout=out,
            )
            requeue_mock.assert_called_once()
            kwargs = requeue_mock.call_args[1]
            self.assertEqual(kwargs["db"], "default")
            self.assertEqual(kwargs["row_ids"], [1, 2, 3])
            self.assertTrue(kwargs["clear_error"])

        self.assertIn("requeue 3 行", out.getvalue())

    def test_no_terminal_rows_raises_for_scripting(self):
        """无可 requeue 时必须 raise CommandError，让 SRE bash 脚本能 if 判断。"""
        out = StringIO()
        with patch.object(
            outbox_service, "list_terminal_rows", return_value=[]
        ):
            with self.assertRaises(CommandError):
                call_command(
                    "fts_requeue_terminal",
                    "--db=default", "--row-id=999",
                    stdout=out,
                )

    def test_db_both_iterates_two_dbs(self):
        out = StringIO()
        fake_row = MagicMock(id=1, index_name="x", doc_id="y",
                             action="upsert", retry_count=5, last_error="")
        # list_terminal_rows 第一次返回 1 条（default），第二次返回 1 条（postgresql）
        with patch.object(
            outbox_service, "list_terminal_rows",
            side_effect=[[fake_row], [fake_row]],
        ) as list_mock, patch.object(
            outbox_service, "requeue_terminal", return_value=1,
        ) as requeue_mock, patch.object(
            outbox_service, "get_terminal_backlog", return_value=1,
        ):
            call_command(
                "fts_requeue_terminal", "--all", "--db=both",
                stdout=out,
            )
            # 必须 list 两次（default + postgresql）
            self.assertEqual(list_mock.call_count, 2)
            self.assertEqual(requeue_mock.call_count, 2)
            calls = [c[1]["db"] for c in requeue_mock.call_args_list]
            self.assertEqual(set(calls), {"default", "postgresql"})

    def test_all_with_oversize_warns_but_proceeds_with_limit(self):
        """--all 模式扫到的 terminal 总数 > limit 时打 warn 但继续；
        不强制要求 --confirm-large（只是不超 limit）。"""
        out = StringIO()
        fake_rows = [MagicMock(id=i, index_name="x", doc_id="y",
                               action="upsert", retry_count=5, last_error="")
                     for i in range(5)]
        with patch.object(
            outbox_service, "list_terminal_rows", return_value=fake_rows,
        ), patch.object(
            outbox_service, "get_terminal_backlog", return_value=999,
        ), patch.object(
            outbox_service, "requeue_terminal", return_value=5,
        ):
            call_command(
                "fts_requeue_terminal",
                "--all", "--db=default", "--limit=5",
                stdout=out, stderr=out,
            )
        # 包含 warning 提示
        self.assertIn("--confirm-large", out.getvalue())
        # 但仍真 requeue
        self.assertIn("requeue 5 行", out.getvalue())

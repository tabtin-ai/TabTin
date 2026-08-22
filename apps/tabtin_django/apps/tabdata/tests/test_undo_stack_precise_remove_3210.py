"""
#3210: _pop_stack_entry 只读扫描 + 精确移除，过滤未命中不得 pop 即弃。
"""

from __future__ import annotations

from uuid import uuid4

from django.test import SimpleTestCase, override_settings

from apps.tabdata.services.undo_redo_stack_service import UndoRedoStackService


@override_settings(
    TABDATA_UNDO_REDIS_STACK_ENABLED=True,
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "undo-stack-precise-remove-3210",
        }
    },
)
class UndoStackPreciseRemoveTests(SimpleTestCase):
    def setUp(self):
        self.svc = UndoRedoStackService()
        self.user_id = str(uuid4())
        self.table_id = str(uuid4())
        self.window_id = "win-a"

    def test_remove_operation_keeps_unmatched_entries(self):
        other = {
            "id": str(uuid4()),
            "history_id": str(uuid4()),
            "record_id": str(uuid4()),
            "table_id": self.table_id,
            "action": "update",
            "user": {"id": "other-user"},
        }
        mine = {
            "id": str(uuid4()),
            "history_id": str(uuid4()),
            "record_id": str(uuid4()),
            "table_id": self.table_id,
            "action": "update",
            "user": {"id": self.user_id},
        }
        # 先压 other，再压 mine → 栈顶是 mine
        self.svc.push_undo_operation(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            operation=other,
            clear_redo=True,
        )
        self.svc.push_undo_operation(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            operation=mine,
            clear_redo=True,
        )

        removed = self.svc.remove_operation_from_undo(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            operation=mine,
        )
        self.assertTrue(removed)

        stack, total = self.svc.get_undo_stack(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            limit=10,
        )
        self.assertEqual(total, 1)
        self.assertEqual(stack[0]["history_id"], other["history_id"])

    def test_remove_skips_non_matching_identity(self):
        kept = {
            "id": str(uuid4()),
            "history_id": str(uuid4()),
            "table_id": self.table_id,
            "action": "update",
        }
        self.svc.push_undo_operation(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            operation=kept,
            clear_redo=True,
        )
        removed = self.svc.remove_operation_from_undo(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            operation={"id": str(uuid4()), "history_id": str(uuid4())},
        )
        self.assertFalse(removed)
        _, total = self.svc.get_undo_stack(
            user_id=self.user_id,
            table_id=self.table_id,
            window_id=self.window_id,
            limit=10,
        )
        self.assertEqual(total, 1)

    def test_operation_identity_prefers_history_id(self):
        op = {"id": "a", "history_id": "b", "name": "deleteFields"}
        self.assertEqual(UndoRedoStackService.operation_identity(op), "b")

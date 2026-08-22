"""R1-22 修复回归测试：Space 硬删跨库 cascade 隐患。

为什么放在 fts/tests/：
    1. fts/tests/conftest.py 已配齐 SimpleTestCase + SQLite + 内存 cache
    2. 修复本身是为了让 fts signal 同步管道（on_space_deleted）能正常触发——
       Space.delete() 不报错才会走到 post_delete 链条，cascade delete_by_query 才会执行

回归契约：
    - `_detach_chat_sessions_from_spaces` 接受 None / 空 / 单 UUID / 列表 / tuple
    - 调用方式必须 using('default')（而不是 'postgresql'，否则修复无效）
    - 异常 swallow 不抛（否则 delete_space 反而引入新失败点）
    - delete_space() 必须在 space.delete() 前调 detach helper
    - tasks.py 批量 delete 路径同样调 detach helper

不依赖真实双库（用 mock 验证调用契约即可）；真实双库行为由生产部署 + ROLLBACK 演练覆盖。
"""
from __future__ import annotations

# fts/tests/conftest.py 已经把 Django setup 好；这里直接 import 即可
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabtinspace.services.space_service import (
    SpaceService,
    _detach_chat_sessions_from_spaces,
)


class DetachHelperTests(SimpleTestCase):
    """`_detach_chat_sessions_from_spaces` 的契约测试。"""

    def test_empty_list_returns_zero(self):
        self.assertEqual(_detach_chat_sessions_from_spaces([]), 0)

    def test_none_returns_zero(self):
        self.assertEqual(_detach_chat_sessions_from_spaces(None), 0)

    def test_only_none_in_list_returns_zero(self):
        self.assertEqual(_detach_chat_sessions_from_spaces([None, None]), 0)

    def test_single_uuid_treated_as_list(self):
        """单 UUID 应被规范化为单元素列表，而不是当成可迭代字符切片。"""
        sid = uuid4()
        with patch("apps.chat.conversation.models.ChatSession.objects") as mgr_mock:
            chained = mgr_mock.using.return_value.filter.return_value
            chained.update.return_value = 0
            n = _detach_chat_sessions_from_spaces(sid)
            mgr_mock.using.assert_called_once_with("default")
            mgr_mock.using.return_value.filter.assert_called_once_with(
                workspace_id__in=[str(sid)]
            )
            chained.update.assert_called_once_with(workspace=None)
        self.assertEqual(n, 0)

    def test_calls_using_default_and_filter_in(self):
        """关键：必须 using('default')，否则修复无效。"""
        ids = [uuid4(), uuid4(), uuid4()]
        with patch("apps.chat.conversation.models.ChatSession.objects") as mgr_mock:
            chained = mgr_mock.using.return_value.filter.return_value
            chained.update.return_value = 2
            n = _detach_chat_sessions_from_spaces(ids)
            mgr_mock.using.assert_called_once_with("default")
            mgr_mock.using.return_value.filter.assert_called_once_with(
                workspace_id__in=[str(x) for x in ids]
            )
            chained.update.assert_called_once_with(workspace=None)
        self.assertEqual(n, 2)

    def test_swallow_exception_returns_zero_not_raise(self):
        """ChatSession 查询失败必须 swallow 让 Space.delete() 兜底；
        修复绝不能成为 delete_space 的新失败点。"""
        ids = [uuid4()]
        with patch("apps.chat.conversation.models.ChatSession.objects") as mgr_mock:
            mgr_mock.using.side_effect = Exception("simulated DB outage")
            n = _detach_chat_sessions_from_spaces(ids)
        self.assertEqual(n, 0)

    def test_tuple_input_works(self):
        sid = uuid4()
        with patch("apps.chat.conversation.models.ChatSession.objects") as mgr_mock:
            chained = mgr_mock.using.return_value.filter.return_value
            chained.update.return_value = 1
            n = _detach_chat_sessions_from_spaces((sid,))
            mgr_mock.using.return_value.filter.assert_called_once_with(
                workspace_id__in=[str(sid)]
            )
        self.assertEqual(n, 1)


class PurgeTrashedSpacesCallsDetachTests(SimpleTestCase):
    """#6342：永久删除回收站 Project 前必须 detach ChatSession.workspace。

    ``delete_space`` 壳已退役；真路径是 ``purge_trashed_spaces``。
    """

    def test_purge_trashed_spaces_calls_detach_before_delete(self):
        import inspect
        from apps.tabtinspace.services import space_service

        purge_src = inspect.getsource(space_service.SpaceService.purge_trashed_spaces)
        idx_detach = purge_src.find("_detach_chat_sessions_from_spaces(ids)")
        idx_delete = purge_src.find("Project.objects.filter(id__in=ids).delete()")
        self.assertGreater(
            idx_detach, 0,
            "purge_trashed_spaces 未调用 _detach_chat_sessions_from_spaces；"
            "R1-22 /  detach 契约缺失",
        )
        self.assertGreater(idx_delete, 0, "purge_trashed_spaces 未调用 Project.delete")
        self.assertLess(
            idx_detach,
            idx_delete,
            "detach 必须在 Project.delete() 之前；颠倒顺序等于不修",
        )


if __name__ == "__main__":
    unittest.main()

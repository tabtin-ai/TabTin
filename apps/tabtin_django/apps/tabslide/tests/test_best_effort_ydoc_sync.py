"""
TC-YDOC-01 — DB-first 写入后 best-effort 同步 Y.Doc

回归用例覆盖：
  1. _best_effort_sync_yjs — Y.js 关闭时静默 noop
  2. _best_effort_sync_yjs — Y.js 启用但 collab-live 抛异常 → 仅记 log，不冒泡
  3. _best_effort_sync_yjs — 推送成功（applied > 0）→ 正常完成
  4. _best_effort_sync_yjs — 推送 applied=0（Y.Doc 没有 page）→ 视为正常完成
  5. _best_effort_sync_yjs — sync_changes 为空 → 直接 return 不调底层

设计原则：
  这个函数是 DB-first 写入后的"补偿同步"，绝不允许任何异常冒泡
  影响主流程（DB 写入已经持久化，回滚没有意义）。
"""

from __future__ import annotations

import logging
import unittest
from unittest.mock import MagicMock, patch


class BestEffortYDocSyncTests(unittest.TestCase):
    """SlideService._best_effort_sync_yjs — 静默失败契约。"""

    def _make_svc(self):
        # 不连真实 DB，直接构造一个空 SlideService 实例
        from apps.tabslide.services.slide_service import SlideService
        return SlideService.__new__(SlideService)

    def test_noop_when_yjs_disabled(self):
        svc = self._make_svc()
        with patch("apps.services.common.config.is_yjs_first_enabled", return_value=False), \
             patch("apps.tabslide.services.collab_service.SlideCollabService.push_element_changes") as push:
            svc._best_effort_sync_yjs(
                "proj-1",
                [{"page_id": "p1", "element_id": "e1", "patch": {"props": {"content": "x"}}}],
            )
            push.assert_not_called()

    def test_noop_when_empty_changes(self):
        svc = self._make_svc()
        with patch("apps.tabslide.services.collab_service.SlideCollabService.push_element_changes") as push:
            svc._best_effort_sync_yjs("proj-1", [])
            push.assert_not_called()

    def test_pushes_when_yjs_enabled(self):
        svc = self._make_svc()
        with patch("apps.services.common.config.is_yjs_first_enabled", return_value=True), \
             patch("apps.tabslide.services.collab_service.SlideCollabService.push_element_changes") as push:
            push.return_value = {"applied": 1, "total": 1}
            svc._best_effort_sync_yjs(
                "proj-1",
                [{"page_id": "p1", "element_id": "e1", "patch": {"props": {"content": "x"}}}],
            )
            push.assert_called_once()
            call_args = push.call_args.kwargs
            self.assertEqual(call_args["project_id"], "proj-1")
            self.assertEqual(call_args["editor_type"], "system")
            self.assertEqual(len(call_args["changes"]), 1)
            self.assertEqual(call_args["changes"][0]["type"], "update")

    def test_silent_when_applied_zero(self):
        """Y.Doc 没数据时 applied=0 是正常情况（用户没在线编辑），不算失败。"""
        svc = self._make_svc()
        with patch("apps.services.common.config.is_yjs_first_enabled", return_value=True), \
             patch("apps.tabslide.services.collab_service.SlideCollabService.push_element_changes") as push:
            push.return_value = {"applied": 0, "total": 1}
            # 不应该抛
            svc._best_effort_sync_yjs(
                "proj-1",
                [{"page_id": "p1", "element_id": "e1", "patch": {"props": {"content": "x"}}}],
            )

    def test_swallows_collab_live_exception(self):
        """collab-live 不可达时绝不冒泡。"""
        svc = self._make_svc()
        with patch("apps.services.common.config.is_yjs_first_enabled", return_value=True), \
             patch(
                 "apps.tabslide.services.collab_service.SlideCollabService.push_element_changes",
                 side_effect=ConnectionError("collab-live unreachable"),
             ), \
             self.assertLogs("apps.tabslide.services.slide_service", level=logging.WARNING) as logs:
            # 不应该抛 ConnectionError
            svc._best_effort_sync_yjs(
                "proj-1",
                [{"page_id": "p1", "element_id": "e1", "patch": {"props": {"content": "x"}}}],
            )
        self.assertTrue(any("best-effort Y.Doc sync failed" in line for line in logs.output))

    def test_swallows_arbitrary_exception(self):
        """任何异常都不应冒泡（防 collab_service 内部不稳定）。"""
        svc = self._make_svc()
        with patch("apps.services.common.config.is_yjs_first_enabled", return_value=True), \
             patch(
                 "apps.tabslide.services.collab_service.SlideCollabService.push_element_changes",
                 side_effect=RuntimeError("unexpected"),
             ):
            # 不应该抛
            svc._best_effort_sync_yjs(
                "proj-1",
                [{"page_id": "p1", "element_id": "e1", "patch": {"props": {"content": "x"}}}],
            )


if __name__ == "__main__":
    unittest.main()

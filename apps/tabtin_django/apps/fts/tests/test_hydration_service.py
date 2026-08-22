"""hydration_service 单测：批量查 + N+1 防回归 + 字段补全。"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


def _item(**kwargs):
    from apps.fts.schemas import SearchResultItem
    base = {"id": "x", "type": "message", "title": "x"}
    base.update(kwargs)
    return SearchResultItem(**base)


class HydrateBasicTests(unittest.TestCase):
    def test_empty_input_returns_empty(self):
        from apps.fts.services.hydration_service import hydrate
        self.assertEqual(hydrate([]), [])

    def test_no_lookups_needed_skips_db(self):
        from apps.fts.services.hydration_service import hydrate
        with patch("apps.fts.services.hydration_service._batch_fetch") as m:
            m.return_value = MagicMock(spaces={}, agents={}, users={}, sessions={})
            items = [_item(id="m1", type="message", title="t")]
            hydrate(items)
        m.assert_called_once()

    def test_space_name_filled(self):
        from apps.fts.services.hydration_service import hydrate, BatchLookups
        items = [_item(id="r1", type="resource", title="t", space_id="sp-1")]
        with patch("apps.fts.services.hydration_service._batch_fetch") as m:
            l = BatchLookups()
            l.spaces["sp-1"] = {"id": "sp-1", "name": "工作空间", "icon": "📁",
                                "avatar": "", "type": "team", "agent_id": None}
            m.return_value = l
            hydrate(items)
        self.assertEqual(items[0].space_name, "工作空间")

    def test_creator_user_name_and_avatar(self):
        from apps.fts.services.hydration_service import hydrate, BatchLookups
        items = [_item(id="m1", type="message", title="t",
                       creator_type="user", creator_id="u-1")]
        with patch("apps.fts.services.hydration_service._batch_fetch") as m:
            l = BatchLookups()
            l.users["u-1"] = {"id": "u-1", "username": "alice",
                              "display_name": "Alice", "avatar": "https://x/y.png"}
            m.return_value = l
            hydrate(items)
        self.assertEqual(items[0].creator_name, "Alice")
        self.assertEqual(items[0].creator_avatar, "https://x/y.png")

    def test_creator_agent_name(self):
        from apps.fts.services.hydration_service import hydrate, BatchLookups
        items = [_item(id="m1", type="message", title="t",
                       creator_type="agent", creator_id="a-1")]
        with patch("apps.fts.services.hydration_service._batch_fetch") as m:
            l = BatchLookups()
            l.agents["a-1"] = {"id": "a-1", "name": "CodeBot", "type": "bot"}
            m.return_value = l
            hydrate(items)
        self.assertEqual(items[0].creator_name, "CodeBot")

    def test_session_title_overrides_stale_snapshot(self):
        from apps.fts.services.hydration_service import hydrate, BatchLookups
        items = [_item(id="m1", type="message", title="旧标题",
                       session_id="s-1", session_title="旧标题")]
        with patch("apps.fts.services.hydration_service._batch_fetch") as m:
            l = BatchLookups()
            l.sessions["s-1"] = {"id": "s-1", "title": "新标题", "status": "active"}
            m.return_value = l
            hydrate(items)
        self.assertEqual(items[0].session_title, "新标题")

    def test_n_plus_one_protection_single_call(self):
        """100 hits 只触发一次 _batch_fetch（不是每条 hit 一次）。"""
        from apps.fts.services.hydration_service import hydrate, BatchLookups
        items = [_item(id=f"m{i}", type="message", title="t",
                       space_id=f"sp-{i}", creator_type="user", creator_id=f"u-{i}",
                       session_id=f"s-{i}") for i in range(100)]
        with patch("apps.fts.services.hydration_service._batch_fetch") as m:
            m.return_value = BatchLookups()
            hydrate(items)
        self.assertEqual(m.call_count, 1)


class BatchFetchSetSizeTests(unittest.TestCase):
    """验证去重 set：同 space_id 的 hits 不重复入参。"""

    def test_same_space_collapsed(self):
        from apps.fts.services.hydration_service import hydrate
        items = [
            _item(id="m1", type="message", title="t", space_id="sp-1"),
            _item(id="m2", type="message", title="t", space_id="sp-1"),
            _item(id="m3", type="message", title="t", space_id="sp-1"),
        ]
        captured = {}

        def fake_batch(s, u, a, sess):
            captured["spaces"] = set(s)
            from apps.fts.services.hydration_service import BatchLookups
            return BatchLookups()

        with patch("apps.fts.services.hydration_service._batch_fetch", side_effect=fake_batch):
            hydrate(items)
        self.assertEqual(captured["spaces"], {"sp-1"})


if __name__ == "__main__":
    unittest.main()

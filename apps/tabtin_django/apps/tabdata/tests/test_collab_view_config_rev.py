"""视图配置回退防护：collab-persist config_rev 单调性回归测试。

covers CollabService._persist_collab_views 的 config_rev max() 语义——旧 Y.Doc
快照（config_rev 更低）持久化时不得把 PG 里已有的更高版本号回退。

纯 mock，不依赖数据库。
"""
from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import UUID

from apps.tabdata.services.collab_service import CollabService


VIEW_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def _existing_view(config_rev: int) -> MagicMock:
    view = MagicMock()
    view.id = UUID(VIEW_ID)
    view.config_rev = config_rev
    return view


class PersistCollabViewsConfigRevTests(TestCase):
    def _run_persist(self, existing_rev: int, incoming_rev):
        table = MagicMock()
        current = _existing_view(existing_rev)

        with patch(
            "apps.tabdata.services.collab_service.TableView.objects.using"
        ) as using_mock:
            # existing 视图集合
            using_mock.return_value.filter.return_value = [current]
            CollabService._persist_collab_views(
                table=table,
                collab_views={VIEW_ID: {"config_rev": incoming_rev}},
                editor_user=None,
            )
        return current

    def test_incoming_lower_rev_does_not_regress(self):
        # PG 已是 rev=5，收到旧快照 rev=3 → 保持 5，不回退
        current = self._run_persist(existing_rev=5, incoming_rev=3)
        self.assertEqual(current.config_rev, 5)
        current.save.assert_not_called()

    def test_incoming_lower_rev_does_not_overwrite_view_config(self):
        """旧 Y.Doc 快照不能保留高版本号却把分组配置回退成旧值。"""
        table = MagicMock()
        current = _existing_view(5)
        current.view_type = "kanban"
        current.config = {"group_by_field": "fld_status"}
        current.groups = [{"field_id": "fld_status", "direction": "asc"}]

        with patch(
            "apps.tabdata.services.collab_service.TableView.objects.using"
        ) as using_mock:
            using_mock.return_value.filter.return_value = [current]
            CollabService._persist_collab_views(
                table=table,
                collab_views={
                    VIEW_ID: {
                        "view_type": "kanban",
                        "config_rev": 3,
                        "config": {},
                        "groups": [],
                    }
                },
                editor_user=None,
            )

        self.assertEqual(current.config_rev, 5)
        self.assertEqual(current.config, {"group_by_field": "fld_status"})
        self.assertEqual(
            current.groups,
            [{"field_id": "fld_status", "direction": "asc"}],
        )
        current.save.assert_not_called()

    def test_legacy_snapshot_without_rev_still_updates_view_config(self):
        """旧客户端未携带 config_rev 时继续兼容原有写入语义。"""
        table = MagicMock()
        current = _existing_view(5)
        current.view_type = "kanban"
        current.config = {}
        current.groups = []

        with patch(
            "apps.tabdata.services.collab_service.TableView.objects.using"
        ) as using_mock:
            using_mock.return_value.filter.return_value = [current]
            CollabService._persist_collab_views(
                table=table,
                collab_views={
                    VIEW_ID: {
                        "view_type": "kanban",
                        "config": {"group_by_field": "fld_status"},
                        "groups": [
                            {"field_id": "fld_status", "direction": "asc"}
                        ],
                    }
                },
                editor_user=None,
            )

        self.assertEqual(current.config_rev, 5)
        self.assertEqual(current.config, {"group_by_field": "fld_status"})
        self.assertEqual(
            current.groups,
            [{"field_id": "fld_status", "direction": "asc"}],
        )
        current.save.assert_called_once()

    def test_incoming_higher_rev_advances(self):
        # 收到更高 rev=8 → 前进到 8 并落库
        current = self._run_persist(existing_rev=5, incoming_rev=8)
        self.assertEqual(current.config_rev, 8)
        current.save.assert_called_once()
        saved_fields = current.save.call_args.kwargs.get("update_fields", [])
        self.assertIn("config_rev", saved_fields)

    def test_non_integer_rev_ignored(self):
        # 非法 config_rev 被忽略，不写入
        current = self._run_persist(existing_rev=5, incoming_rev="oops")
        self.assertEqual(current.config_rev, 5)
        current.save.assert_not_called()

    def test_non_kanban_strips_group_by_field_from_config(self):
        """#7752：grid 视图 persist 时剥掉看板专用 group_by_field，避免污染表格。"""
        table = MagicMock()
        current = _existing_view(1)
        current.view_type = "grid"
        current.config = {}
        current.name = "Grid"
        current.description = ""
        current.filter = None
        current.filters = []
        current.sorts = []
        current.groups = []
        current.visible_fields = []
        current.field_order = []
        current.column_meta = {}
        current.is_shared = False
        current.is_locked = False
        current.order = 0

        with patch(
            "apps.tabdata.services.collab_service.TableView.objects.using"
        ) as using_mock:
            using_mock.return_value.filter.return_value = [current]
            CollabService._persist_collab_views(
                table=table,
                collab_views={
                    VIEW_ID: {
                        "config_rev": 2,
                        "config": {"group_by_field": "fld_status", "filter_logic": "and"},
                    }
                },
                editor_user=None,
            )

        self.assertNotIn("group_by_field", current.config)
        self.assertEqual(current.config.get("filter_logic"), "and")
        current.save.assert_called_once()

    def test_missing_incoming_view_is_not_deleted(self):
        """#10856：不完整 Y.Doc 快照不能把 REST 已有视图删掉。"""
        table = MagicMock()
        table.default_view_id = UUID(VIEW_ID)
        kept = _existing_view(4)
        kept.view_type = "kanban"
        kept.config = {"group_by_field": "fld_status"}
        kept.groups = [{"field_id": "fld_status", "direction": "asc"}]
        kept.name = "Kanban"
        kept.description = ""
        kept.filter = None
        kept.filters = []
        kept.sorts = []
        kept.visible_fields = []
        kept.field_order = []
        kept.column_meta = {}
        kept.is_shared = False
        kept.is_locked = False
        kept.order = 0

        extra_id = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        extra = MagicMock()
        extra.id = extra_id
        extra.config_rev = 1
        extra.view_type = "grid"
        extra.delete = MagicMock()

        with patch(
            "apps.tabdata.services.collab_service.TableView.objects.using"
        ) as using_mock:
            using_mock.return_value.filter.return_value = [kept, extra]
            CollabService._persist_collab_views(
                table=table,
                collab_views={
                    VIEW_ID: {
                        "view_type": "kanban",
                        "config_rev": 4,
                        "config": {"group_by_field": "fld_status"},
                        "groups": [
                            {"field_id": "fld_status", "direction": "asc"}
                        ],
                    }
                },
                editor_user=None,
            )

        extra.delete.assert_not_called()

    def test_kanban_keeps_group_by_field_in_config(self):
        table = MagicMock()
        current = _existing_view(1)
        current.view_type = "kanban"
        current.config = {}
        current.name = "Kanban"
        current.description = ""
        current.filter = None
        current.filters = []
        current.sorts = []
        current.groups = []
        current.visible_fields = []
        current.field_order = []
        current.column_meta = {}
        current.is_shared = False
        current.is_locked = False
        current.order = 0

        with patch(
            "apps.tabdata.services.collab_service.TableView.objects.using"
        ) as using_mock:
            using_mock.return_value.filter.return_value = [current]
            CollabService._persist_collab_views(
                table=table,
                collab_views={
                    VIEW_ID: {
                        "config_rev": 2,
                        "config": {"group_by_field": "fld_status"},
                    }
                },
                editor_user=None,
            )

        self.assertEqual(current.config.get("group_by_field"), "fld_status")
        current.save.assert_called_once()

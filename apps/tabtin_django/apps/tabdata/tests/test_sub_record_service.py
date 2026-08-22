import json
from unittest import skipUnless
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase

from apps.tabdata.constants import UNNAMED_RECORD_DISPLAY_NAME
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord, TableView
from apps.tabdata.domain.events import RecordCreated, RecordsBatchUpdated
from apps.tabdata.infrastructure import get_event_bus
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.services.collab_service import CollabService
from apps.tabdata.services.link_field_service import LinkFieldService
from apps.tabdata.services.record_service import ORDER_REBALANCE_STEP, RecordService
from apps.tabdata.services.sub_record_service import SubRecordService
from apps.tabdata.services.view_sub_record_tree_service import apply_sub_record_tree_order
from apps.tabdata.services.view_service import ViewService
from apps.tabdata.tests.test_undo_redo import (
    _ensure_free_tier,
    _ensure_native_table,
    _ensure_project_membership,
)
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent

User = get_user_model()


def _coerce_json_cell(value):
    return json.loads(value) if isinstance(value, str) else value


class _RecordCreatedCaptureSubscriber:
    def __init__(self):
        self.events = []

    @staticmethod
    def handles():
        return [RecordCreated]

    @staticmethod
    def priority():
        return 9999

    def handle(self, event):
        self.events.append(event)


class _RecordsBatchUpdatedCaptureSubscriber:
    def __init__(self):
        self.events = []

    @staticmethod
    def handles():
        return [RecordsBatchUpdated]

    @staticmethod
    def priority():
        return 9999

    def handle(self, event):
        self.events.append(event)


def _unregister_record_created_capture(subscriber):
    bus = get_event_bus()
    if hasattr(bus, '_subscribers'):
        bus._subscribers = [sub for sub in bus._subscribers if sub is not subscriber]
    if hasattr(bus, '_event_map'):
        bus._event_map[RecordCreated] = [
            sub for sub in bus._event_map.get(RecordCreated, []) if sub is not subscriber
        ]


def _unregister_records_batch_updated_capture(subscriber):
    bus = get_event_bus()
    if hasattr(bus, '_subscribers'):
        bus._subscribers = [sub for sub in bus._subscribers if sub is not subscriber]
    if hasattr(bus, '_event_map'):
        bus._event_map[RecordsBatchUpdated] = [
            sub for sub in bus._event_map.get(RecordsBatchUpdated, []) if sub is not subscriber
        ]


class SubRecordServiceTestCase(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()

        self.owner = User.objects.create_user(
            username="sub_record_owner",
            email="sub_record_owner@example.com",
            password="password123",
        )
        self.viewer = User.objects.create_user(
            username="sub_record_viewer",
            email="sub_record_viewer@example.com",
            password="password123",
        )

        ctx = create_test_organization_with_agent(
            owner=self.owner,
            organization_name="子记录测试组织",
            space_name="子记录测试项目",
            prefix="sub_record",
        )
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        self.organization.members.create(user=self.viewer, role="viewer")
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.owner,
            role="owner",
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.viewer,
            role="viewer",
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name="子记录测试表",
            owner=self.owner,
        )
        self.primary_field = TableField.objects.create(
            table=self.table,
            name="标题",
            field_type="text",
            is_primary=True,
            order=0,
        )
        _ensure_native_table(
            self.space.id,
            self.table.id,
            fields=[self.primary_field],
        )

        self.other_table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name="其他表",
            owner=self.owner,
        )

    def _create_record(self, title: str, order: float) -> TableRecord:
        return TableRecord.objects.create(
            table=self.table,
            created_by=self.owner,
            updated_by=self.owner,
            data={str(self.primary_field.id): title},
            order=order,
        )

    def _create_parent_link_field(self, *, flagged: bool = True) -> TableField:
        config = {
            "foreignTableId": str(self.table.id),
            "relationship": "ManyOne",
            "isOneWay": True,
        }
        if flagged:
            config["isSubRecordParentField"] = True
        field = TableField.objects.create(
            table=self.table,
            name="父记录关系",
            field_type="link",
            order=1,
            config=config,
        )
        _ensure_native_table(self.space.id, self.table.id, fields=[field])
        return field

    def _create_grid_view(self, config=None, groups=None) -> TableView:
        return TableView.objects.create(
            table=self.table,
            name="子记录视图",
            view_type="grid",
            config=config or {},
            groups=groups or [],
            created_by=self.owner,
            order=0,
        )

    def test_get_self_link_fields_only_returns_many_one_self_one_way(self):
        valid = self._create_parent_link_field(flagged=False)
        TableField.objects.create(
            table=self.table,
            name="非 ManyOne",
            field_type="link",
            order=2,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )
        TableField.objects.create(
            table=self.table,
            name="非单向",
            field_type="link",
            order=3,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "ManyOne",
                "isOneWay": False,
            },
        )
        TableField.objects.create(
            table=self.table,
            name="跨表字段",
            field_type="link",
            order=4,
            config={
                "foreignTableId": str(self.other_table.id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        fields = SubRecordService.get_self_link_fields(self.table.id)
        self.assertEqual([f.id for f in fields], [valid.id])

    @skipUnless(connection.vendor == 'postgresql', 'ensure_parent_field writes native column')
    def test_ensure_parent_field_uses_suffix_when_name_conflicts(self):
        TableField.objects.create(
            table=self.table,
            name="父记录",
            field_type="text",
            order=2,
        )
        TableField.objects.create(
            table=self.table,
            name="父记录 1",
            field_type="text",
            order=3,
        )

        parent_field = SubRecordService.ensure_parent_field(self.table.id, self.owner)

        self.assertEqual(parent_field.name, "父记录 2")
        self.assertEqual(parent_field.field_type, "link")
        self.assertEqual(parent_field.config.get("relationship"), "ManyOne")
        self.assertTrue(parent_field.config.get("isOneWay"))
        self.assertTrue(parent_field.config.get("isSubRecordParentField"))

    def test_ensure_parent_field_requires_editor_permission(self):
        with self.assertRaises(PermissionError):
            SubRecordService.ensure_parent_field(self.table.id, self.viewer)

    @skipUnless(connection.vendor == 'postgresql', 'create_parent_field writes native column')
    def test_create_parent_field_always_creates_new_field(self):
        first = SubRecordService.create_parent_field(self.table.id, self.owner)
        second = SubRecordService.create_parent_field(self.table.id, self.owner)

        self.assertNotEqual(first.id, second.id)
        self.assertEqual(first.name, "父记录")
        self.assertEqual(second.name, "父记录 1")
        self.assertTrue(first.config.get("isSubRecordParentField"))
        self.assertTrue(second.config.get("isSubRecordParentField"))

    @skipUnless(connection.vendor == 'postgresql', 'ensure_parent_field writes native column')
    def test_ensure_parent_field_remains_idempotent_after_create(self):
        created = SubRecordService.create_parent_field(self.table.id, self.owner)
        ensured = SubRecordService.ensure_parent_field(self.table.id, self.owner)
        self.assertEqual(created.id, ensured.id)

    @skipUnless(connection.vendor == 'postgresql', 'create_parent_field writes native column')
    def test_create_parent_field_adds_to_view_column_config(self):
        view = TableView.objects.create(
            table=self.table,
            name="默认视图",
            view_type="grid",
            created_by=self.owner,
            visible_fields=[str(self.primary_field.id)],
            field_order=[str(self.primary_field.id)],
        )
        parent_field = SubRecordService.create_parent_field(self.table.id, self.owner)
        view.refresh_from_db()
        field_id = str(parent_field.id)
        self.assertIn(field_id, view.visible_fields or [])
        self.assertIn(field_id, view.field_order or [])

    def test_create_parent_field_requires_editor_permission(self):
        with self.assertRaises(PermissionError):
            SubRecordService.create_parent_field(self.table.id, self.viewer)

    def test_validate_parent_field_selection_rejects_invalid(self):
        invalid = TableField.objects.create(
            table=self.table,
            name="非父字段",
            field_type="text",
            order=2,
        )
        with self.assertRaises(ValueError):
            SubRecordService.validate_parent_field_selection(
                self.table.id, str(invalid.id)
            )
        SubRecordService.validate_parent_field_selection(self.table.id, None)
        SubRecordService.validate_parent_field_selection(self.table.id, "")

    @skipUnless(connection.vendor == 'postgresql', 'delete_field clears native + view config')
    def test_delete_active_parent_field_clears_view_config(self):
        from apps.tabdata.services import TableService

        parent_field = SubRecordService.create_parent_field(self.table.id, self.owner)
        view = TableView.objects.create(
            table=self.table,
            name="层级视图",
            view_type="grid",
            created_by=self.owner,
            config={"subRecordParentFieldId": str(parent_field.id)},
        )
        ok = TableService(user=self.owner).delete_field(parent_field.id)
        self.assertTrue(ok)
        view.refresh_from_db()
        self.assertIsNone((view.config or {}).get("subRecordParentFieldId"))

    def test_create_sub_record_rejects_invalid_parent_field_id(self):
        invalid_parent_field = TableField.objects.create(
            table=self.table,
            name="错误父字段",
            field_type="link",
            order=2,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )
        parent_record = self._create_record("父记录", order=1)

        with self.assertRaises(ValueError) as exc:
            SubRecordService.create_sub_record(
                table_id=self.table.id,
                parent_record_id=parent_record.id,
                parent_field_id=invalid_parent_field.id,
                data={},
                user=self.owner,
                order_context=None,
            )

        self.assertIn("父记录字段无效", str(exc.exception))

    @skipUnless(connection.vendor == 'postgresql', 'create_sub_record writes native storage')
    def test_create_sub_record_with_parent_payload_writes_native_jsonb(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        event_capture = _RecordCreatedCaptureSubscriber()
        event_bus = get_event_bus()
        event_bus.register(event_capture)

        try:
            child, resolved_parent_field = SubRecordService.create_sub_record(
                table_id=self.table.id,
                parent_record_id=parent.id,
                parent_field_id=parent_field.id,
                data={str(parent_field.id): str(parent.id)},
                user=self.owner,
                order_context={
                    "position": "after",
                    "anchor_record_id": str(parent.id),
                },
            )
        finally:
            _unregister_record_created_capture(event_capture)

        self.assertEqual(resolved_parent_field.id, parent_field.id)
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record=child,
                foreign_record=parent,
            ).exists()
        )
        self.assertEqual(
            child.data[str(parent_field.id)]["id"],
            str(parent.id),
        )
        native_row = NativeRecordIO(self.space.id, self.table.id).read_single(
            child.id,
            field_ids=[str(parent_field.id)],
        )
        native_parent_cell = _coerce_json_cell(native_row[parent_field.id.hex])
        self.assertEqual(native_parent_cell["id"], str(parent.id))

        created_events = [
            event
            for event in event_capture.events
            if str(event.record_id) == str(child.id)
        ]
        self.assertEqual(len(created_events), 1)
        self.assertEqual(
            created_events[0].after[str(parent_field.id)]["id"],
            str(parent.id),
        )

    @skipUnless(connection.vendor == 'postgresql', 'create_record normalizes link fields before events')
    def test_create_record_with_link_field_writes_linkrecord_native_and_event_payload(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        event_capture = _RecordCreatedCaptureSubscriber()
        event_bus = get_event_bus()
        event_bus.register(event_capture)

        try:
            child, error = RecordService(user=self.owner).create_record(
                table_id=self.table.id,
                data={str(parent_field.id): str(parent.id)},
                order_context={
                    "position": "after",
                    "anchor_record_id": str(parent.id),
                },
            )
        finally:
            _unregister_record_created_capture(event_capture)

        self.assertIsNone(error)
        self.assertIsNotNone(child)
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record=child,
                foreign_record=parent,
            ).exists()
        )
        self.assertEqual(child.data[str(parent_field.id)]["id"], str(parent.id))

        native_row = NativeRecordIO(self.space.id, self.table.id).read_single(
            child.id,
            field_ids=[str(parent_field.id)],
        )
        native_parent_cell = _coerce_json_cell(native_row[parent_field.id.hex])
        self.assertEqual(native_parent_cell["id"], str(parent.id))

        created_events = [
            event
            for event in event_capture.events
            if str(event.record_id) == str(child.id)
        ]
        self.assertEqual(len(created_events), 1)
        self.assertEqual(
            created_events[0].after[str(parent_field.id)]["id"],
            str(parent.id),
        )

    @skipUnless(connection.vendor == 'postgresql', 'native fallback requires native storage')
    def test_link_cell_title_falls_back_to_native_when_jsonb_primary_missing(self):
        """#2989: 父记录主字段值只在原生列（JSONB 缓存滞后）时，link cell title
        应从原生真源解析，而非兜底成 id 前 8 位。"""
        parent_field = self._create_parent_link_field(flagged=True)
        # 对齐生产 SubRecordService.find_or_create_parent_field：父链字段带 lookupFieldId
        parent_field.config = {
            **(parent_field.config or {}),
            "lookupFieldId": str(self.primary_field.id),
        }
        parent_field.save(update_fields=["config"])
        parent, error = RecordService(user=self.owner).create_record(
            table_id=self.table.id,
            data={str(self.primary_field.id): "父记录"},
        )
        self.assertIsNone(error)
        child = self._create_record("子记录", order=2)

        # 模拟 native-first 下父记录 JSONB 缓存尚未回填：清空 data，只留原生列真源
        TableRecord.objects.using("postgresql").filter(id=parent.id).update(data={})

        cell_value = LinkFieldService.set_link_cell(
            parent_field, child, [str(parent.id)]
        )

        self.assertEqual(cell_value["id"], str(parent.id))
        self.assertEqual(cell_value["title"], "父记录")
        # 绝不能兜底成 id 前 8 位（旧 bug）
        self.assertNotEqual(cell_value["title"], str(parent.id)[:8])

    def test_extract_record_title_uses_unnamed_placeholder_when_primary_is_unavailable(self):
        """#2989: 无主字段可解析且无 title 时使用关联记录占位符。"""
        rec = self._create_record("x", order=1)
        TableRecord.objects.using("postgresql").filter(id=rec.id).update(data={})
        rec.refresh_from_db()

        title = LinkFieldService._extract_record_title(rec, None)

        self.assertEqual(title, UNNAMED_RECORD_DISPLAY_NAME)
        self.assertNotEqual(title, str(rec.id))

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_new_records_skips_existing_server_created_record(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        child, _ = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=parent.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "子记录"},
            user=self.owner,
            order_context={
                "position": "after",
                "anchor_record_id": str(parent.id),
            },
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(child.id): {
                    self.primary_field.id.hex: "子记录",
                    parent_field.id.hex: {"id": str(parent.id), "title": "父记录"},
                },
            },
            deleted_record_ids=[],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.owner.id),
        )

        self.assertEqual(result["created"], 0)
        self.assertEqual(
            TableRecord.objects.filter(id=child.id, table=self.table).count(),
            1,
        )
        child.refresh_from_db()
        self.assertEqual(child.data[str(self.primary_field.id)], "子记录")
        self.assertEqual(child.data[str(parent_field.id)]["id"], str(parent.id))

    @skipUnless(connection.vendor == 'postgresql', 'collab persist row order uses native storage')
    def test_collab_duplicate_new_record_still_applies_row_order(self):
        parent_field = self._create_parent_link_field(flagged=True)
        first, error = RecordService(user=self.owner).create_record(
            self.table.id,
            {str(self.primary_field.id): "第一条"},
        )
        self.assertIsNone(error)
        second, error = RecordService(user=self.owner).create_record(
            self.table.id,
            {str(self.primary_field.id): "第二条"},
        )
        self.assertIsNone(error)
        child, _ = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=first.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "子记录"},
            user=self.owner,
            order_context={
                "position": "after",
                "anchor_record_id": str(first.id),
            },
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(child.id): {
                    self.primary_field.id.hex: "子记录",
                    parent_field.id.hex: {"id": str(first.id), "title": "第一条"},
                },
            },
            deleted_record_ids=[],
            row_order=[str(child.id), str(second.id), str(first.id)],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.owner.id),
        )

        self.assertEqual(result["created"], 0)
        self.assertEqual(
            TableRecord.objects.filter(id=child.id, table=self.table).count(),
            1,
        )
        child.refresh_from_db()
        second.refresh_from_db()
        first.refresh_from_db()
        self.assertEqual(child.order, float(ORDER_REBALANCE_STEP))
        self.assertEqual(second.order, float(ORDER_REBALANCE_STEP * 2))
        self.assertEqual(first.order, float(ORDER_REBALANCE_STEP * 3))

    def test_move_record_rejects_when_subtree_depth_will_overflow(self):
        parent_field = self._create_parent_link_field(flagged=True)

        p0 = self._create_record("P0", order=1)
        p1 = self._create_record("P1", order=2)
        p2 = self._create_record("P2", order=3)
        p3 = self._create_record("P3", order=4)
        m0 = self._create_record("M0", order=5)
        m1 = self._create_record("M1", order=6)
        m2 = self._create_record("M2", order=7)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=p1, foreign_record=p0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=p2, foreign_record=p1, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=p3, foreign_record=p2, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=m1, foreign_record=m0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=m2, foreign_record=m1, order=0
        )

        with self.assertRaises(ValueError) as exc:
            SubRecordService.move_record(
                table_id=self.table.id,
                record_id=m0.id,
                new_parent_id=p3.id,
                parent_field_id=parent_field.id,
                user=self.owner,
            )

        self.assertIn("移动后将超过最大层级深度", str(exc.exception))

    def test_filter_with_ancestors_includes_full_parent_chain(self):
        parent_field = self._create_parent_link_field(flagged=True)
        root = self._create_record("Root", order=1)
        parent = self._create_record("Parent", order=2)
        child = self._create_record("Child", order=3)
        other = self._create_record("Other", order=4)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=parent, foreign_record=root, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        expanded = SubRecordService.filter_with_ancestors(
            matched_record_ids={child.id},
            parent_field=parent_field,
            table_id=self.table.id,
        )

        self.assertEqual(expanded, {root.id, parent.id, child.id})
        self.assertNotIn(other.id, expanded)

    def test_apply_tree_order_fetches_missing_parent_for_unfiltered_page(self):
        parent_field = self._create_parent_link_field(flagged=True)
        root = self._create_record("Root", order=1)
        child = self._create_record("Child", order=2)
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )

        records_serialized = [
            {
                "id": str(child.id),
                "row_id": str(child.id),
                "table_id": str(self.table.id),
                "data": {self.primary_field.name: "Child"},
                "fields": {str(self.primary_field.id): "Child"},
                "order": child.order,
            }
        ]
        context_ancestor_ids = set()

        tree_data = apply_sub_record_tree_order(
            records_serialized,
            str(parent_field.id),
            self.table.id,
            has_filter=False,
            space_id=self.space.id,
            all_fields=[self.primary_field, parent_field],
            field_key_type="id",
            requested_fields={str(self.primary_field.id), str(parent_field.id)},
            context_ancestor_ids=context_ancestor_ids,
        )

        self.assertEqual([record["id"] for record in records_serialized], [str(root.id), str(child.id)])
        self.assertEqual(context_ancestor_ids, {str(root.id)})
        self.assertIsNotNone(tree_data)
        self.assertEqual(tree_data[str(root.id)]["depth"], 0)
        self.assertTrue(tree_data[str(root.id)]["has_children"])
        self.assertEqual(tree_data[str(child.id)]["depth"], 1)
        self.assertEqual(tree_data[str(child.id)]["parent_id"], str(root.id))

    def test_apply_tree_order_backfills_parent_link_field_from_link_record(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("Parent", order=1)
        child = self._create_record("Child", order=2)
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        records_serialized = [
            {
                "id": str(parent.id),
                "row_id": str(parent.id),
                "table_id": str(self.table.id),
                "data": {self.primary_field.name: "Parent"},
                "fields": {str(self.primary_field.id): "Parent"},
                "order": parent.order,
            },
            {
                "id": str(child.id),
                "row_id": str(child.id),
                "table_id": str(self.table.id),
                "data": {self.primary_field.name: "Child"},
                "fields": {str(self.primary_field.id): "Child"},
                "order": child.order,
            },
        ]

        apply_sub_record_tree_order(
            records_serialized,
            str(parent_field.id),
            self.table.id,
            space_id=self.space.id,
            all_fields=[self.primary_field, parent_field],
            field_key_type="id",
            requested_fields={str(self.primary_field.id), str(parent_field.id)},
        )

        child_record = next(record for record in records_serialized if record["id"] == str(child.id))
        self.assertEqual(child_record["fields"][str(parent_field.id)]["id"], str(parent.id))
        self.assertEqual(child_record["fields"][str(parent_field.id)]["title"], "Parent")
        self.assertEqual(child_record["data"][parent_field.name]["id"], str(parent.id))
        self.assertEqual(child_record["data"][parent_field.name]["title"], "Parent")

    def test_apply_tree_order_backfills_parent_title_when_parent_not_in_page(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("Parent", order=1)
        child = self._create_record("Child", order=2)
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        records_serialized = [
            {
                "id": str(child.id),
                "row_id": str(child.id),
                "table_id": str(self.table.id),
                "data": {self.primary_field.name: "Child"},
                "fields": {str(self.primary_field.id): "Child"},
                "order": child.order,
            },
        ]

        apply_sub_record_tree_order(
            records_serialized,
            str(parent_field.id),
            self.table.id,
            has_filter=True,
            space_id=self.space.id,
            all_fields=[self.primary_field, parent_field],
            field_key_type="id",
            requested_fields={str(self.primary_field.id), str(parent_field.id)},
        )

        child_record = next(record for record in records_serialized if record["id"] == str(child.id))
        self.assertEqual(child_record["fields"][str(parent_field.id)]["id"], str(parent.id))
        self.assertEqual(child_record["fields"][str(parent_field.id)]["title"], "Parent")

    def test_apply_tree_order_refreshes_id_only_parent_cell(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("Parent", order=1)
        child = self._create_record("Child", order=2)
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        records_serialized = [
            {
                "id": str(child.id),
                "row_id": str(child.id),
                "table_id": str(self.table.id),
                "data": {
                    self.primary_field.name: "Child",
                    parent_field.name: {"id": str(parent.id)},
                },
                "fields": {
                    str(self.primary_field.id): "Child",
                    str(parent_field.id): {"id": str(parent.id)},
                },
                "order": child.order,
            },
        ]

        apply_sub_record_tree_order(
            records_serialized,
            str(parent_field.id),
            self.table.id,
            space_id=self.space.id,
            all_fields=[self.primary_field, parent_field],
            field_key_type="id",
            requested_fields={str(self.primary_field.id), str(parent_field.id)},
        )

        child_record = next(record for record in records_serialized if record["id"] == str(child.id))
        self.assertEqual(child_record["fields"][str(parent_field.id)]["title"], "Parent")

    def test_apply_tree_order_does_not_backfill_parent_field_when_not_requested(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("Parent", order=1)
        child = self._create_record("Child", order=2)
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        records_serialized = [
            {
                "id": str(parent.id),
                "row_id": str(parent.id),
                "table_id": str(self.table.id),
                "data": {self.primary_field.name: "Parent"},
                "fields": {str(self.primary_field.id): "Parent"},
                "order": parent.order,
            },
            {
                "id": str(child.id),
                "row_id": str(child.id),
                "table_id": str(self.table.id),
                "data": {self.primary_field.name: "Child"},
                "fields": {str(self.primary_field.id): "Child"},
                "order": child.order,
            },
        ]

        apply_sub_record_tree_order(
            records_serialized,
            str(parent_field.id),
            self.table.id,
            space_id=self.space.id,
            all_fields=[self.primary_field, parent_field],
            field_key_type="id",
            requested_fields={str(self.primary_field.id)},
        )

        child_record = next(record for record in records_serialized if record["id"] == str(child.id))
        self.assertNotIn(str(parent_field.id), child_record["fields"])
        self.assertNotIn(parent_field.name, child_record["data"])

    def test_delete_parent_record_does_not_delete_child_record(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        child = self._create_record("子记录", order=2)
        LinkFieldService.set_link_cell(parent_field, child, [str(parent.id)])
        child.refresh_from_db()
        old_parent_cell = (child.data or {}).get(str(parent_field.id))

        parent.is_deleted = True
        parent.save(update_fields=["is_deleted"])
        affected = LinkFieldService.cleanup_record_links(parent)

        child.refresh_from_db()
        self.assertFalse(child.is_deleted)
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record=child,
            ).exists()
        )
        self.assertIsNone((child.data or {}).get(str(parent_field.id)))
        self.assertEqual(
            affected,
            [{
                'table_id': str(self.table.id),
                'record_id': str(child.id),
                'field_id': str(parent_field.id),
                'old_value': old_parent_cell,
                'value': None,
                'before_data': {
                    str(self.primary_field.id): '子记录',
                    str(parent_field.id): old_parent_cell,
                },
                'after_data': {
                    str(self.primary_field.id): '子记录',
                    str(parent_field.id): None,
                },
            }],
        )

    def test_delete_parent_record_publishes_child_parent_clear_update(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        child = self._create_record("子记录", order=2)
        LinkFieldService.set_link_cell(parent_field, child, [str(parent.id)])
        child.refresh_from_db()
        old_version = child.version
        old_parent_cell = (child.data or {}).get(str(parent_field.id))

        event_capture = _RecordsBatchUpdatedCaptureSubscriber()
        event_bus = get_event_bus()
        event_bus.register(event_capture)
        try:
            self.assertTrue(RecordService(user=self.owner).delete_record(parent.id))
        finally:
            _unregister_records_batch_updated_capture(event_capture)

        child.refresh_from_db()
        self.assertFalse(child.is_deleted)
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record=child,
            ).exists()
        )
        self.assertIsNone((child.data or {}).get(str(parent_field.id)))
        self.assertGreater(child.version, old_version)

        matching_events = [
            event for event in event_capture.events
            if str(event.table_id) == str(self.table.id)
        ]
        self.assertEqual(len(matching_events), 1)
        payload = matching_events[0].records[0]
        self.assertEqual(str(payload.record_id), str(child.id))
        self.assertIn(str(parent_field.id), payload.changes)
        self.assertEqual(
            payload.changes[str(parent_field.id)].old,
            old_parent_cell,
        )
        self.assertIsNone(payload.changes[str(parent_field.id)].new)
        self.assertIsNone(payload.after[str(parent_field.id)])

    def test_batch_delete_parent_and_child_skips_child_parent_clear_update(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        child = self._create_record("子记录", order=2)
        LinkFieldService.set_link_cell(parent_field, child, [str(parent.id)])

        event_capture = _RecordsBatchUpdatedCaptureSubscriber()
        event_bus = get_event_bus()
        event_bus.register(event_capture)
        try:
            deleted_count, errors, _deleted_ids, _failed_ids = RecordService(user=self.owner).bulk_delete_records([
                parent.id,
                child.id,
            ])
        finally:
            _unregister_records_batch_updated_capture(event_capture)

        self.assertEqual(deleted_count, 2)
        self.assertEqual(errors, [])
        self.assertFalse(event_capture.events)

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_delete_parent_record_cleans_child_parent_link(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent, error = RecordService(user=self.owner).create_record(
            self.table.id,
            {str(self.primary_field.id): "父记录"},
        )
        self.assertIsNone(error)
        child, resolved_parent_field = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=parent.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "子记录"},
            user=self.owner,
            order_context={
                "position": "after",
                "anchor_record_id": str(parent.id),
            },
        )
        self.assertEqual(resolved_parent_field.id, parent_field.id)
        child.refresh_from_db()
        old_parent_cell = (child.data or {}).get(str(parent_field.id))
        old_child_version = child.version

        event_capture = _RecordsBatchUpdatedCaptureSubscriber()
        event_bus = get_event_bus()
        event_bus.register(event_capture)
        try:
            result = CollabService.persist_changes(
                table_id=self.table.id,
                changed_records={},
                new_records={},
                deleted_record_ids=[str(parent.id)],
                row_order=[str(child.id)],
                source="collab_persist",
                editor_type="user",
                editor_id=str(self.owner.id),
            )
        finally:
            _unregister_records_batch_updated_capture(event_capture)

        self.assertEqual(result["deleted"], 1)
        parent.refresh_from_db()
        child.refresh_from_db()
        self.table.refresh_from_db()
        self.assertEqual(result["version"], self.table.record_version_seq)
        self.assertTrue(parent.is_deleted)
        self.assertFalse(child.is_deleted)
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record=child,
            ).exists()
        )
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field,
                foreign_record=parent,
            ).exists()
        )
        self.assertIsNone((child.data or {}).get(str(parent_field.id)))
        self.assertGreater(child.version, old_child_version)

        native_row = NativeRecordIO(self.space.id, self.table.id).read_single(
            child.id,
            field_ids=[str(parent_field.id)],
        )
        self.assertIsNone(native_row[parent_field.id.hex])

        matching_events = [
            event for event in event_capture.events
            if str(event.table_id) == str(self.table.id)
        ]
        self.assertEqual(len(matching_events), 1)
        payload = matching_events[0].records[0]
        self.assertEqual(str(payload.record_id), str(child.id))
        self.assertEqual(
            payload.changes[str(parent_field.id)].old,
            old_parent_cell,
        )
        self.assertIsNone(payload.changes[str(parent_field.id)].new)
        self.assertIsNone(payload.after[str(parent_field.id)])

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_batch_delete_parent_and_child_skips_child_clear_update(self):
        parent_field = self._create_parent_link_field(flagged=True)
        parent, error = RecordService(user=self.owner).create_record(
            self.table.id,
            {str(self.primary_field.id): "父记录"},
        )
        self.assertIsNone(error)
        child, resolved_parent_field = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=parent.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "子记录"},
            user=self.owner,
            order_context={
                "position": "after",
                "anchor_record_id": str(parent.id),
            },
        )
        self.assertEqual(resolved_parent_field.id, parent_field.id)

        event_capture = _RecordsBatchUpdatedCaptureSubscriber()
        event_bus = get_event_bus()
        event_bus.register(event_capture)
        try:
            result = CollabService.persist_changes(
                table_id=self.table.id,
                changed_records={},
                new_records={},
                deleted_record_ids=[str(parent.id), str(child.id)],
                row_order=[],
                source="collab_persist",
                editor_type="user",
                editor_id=str(self.owner.id),
            )
        finally:
            _unregister_records_batch_updated_capture(event_capture)

        parent.refresh_from_db()
        child.refresh_from_db()
        self.table.refresh_from_db()
        self.assertEqual(result["deleted"], 2)
        self.assertEqual(result["version"], self.table.record_version_seq)
        self.assertTrue(parent.is_deleted)
        self.assertTrue(child.is_deleted)
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field,
                foreign_record=parent,
            ).exists()
        )
        self.assertFalse(event_capture.events)

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_move_child_via_link_cell_syncs_link_record(self):
        """Yjs-first 拖拽：协作写父字段 cell 落库时同步 LinkRecord（真源）。"""
        parent_field = self._create_parent_link_field(flagged=True)
        parent_a, error_a = RecordService(user=self.owner).create_record(
            self.table.id, {str(self.primary_field.id): "父A"},
        )
        self.assertIsNone(error_a)
        parent_b, error_b = RecordService(user=self.owner).create_record(
            self.table.id, {str(self.primary_field.id): "父B"},
        )
        self.assertIsNone(error_b)
        child, _pf = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=parent_a.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "子"},
            user=self.owner,
        )
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_a,
            ).exists()
        )

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={
                str(child.id): {parent_field.id.hex: {"id": str(parent_b.id)}},
            },
            new_records={},
            deleted_record_ids=[],
            row_order=[str(parent_a.id), str(parent_b.id), str(child.id)],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.owner.id),
        )
        self.assertIn("version", result)

        # LinkRecord 真源已切到 parent_b
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_a,
            ).exists()
        )
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_b,
            ).exists()
        )

        # 权威表征（native cell）按目标主字段重建为 {id,title} 并指向 parent_b
        native_row = NativeRecordIO(self.space.id, self.table.id).read_single(
            child.id, field_ids=[str(parent_field.id)],
        )
        native_cell = native_row[parent_field.id.hex]
        self.assertIsNotNone(native_cell)
        if isinstance(native_cell, str):
            native_cell = json.loads(native_cell)
        native_obj = native_cell[0] if isinstance(native_cell, list) else native_cell
        self.assertIsInstance(native_obj, dict)
        self.assertEqual(str(native_obj.get("id")), str(parent_b.id))

        # 序列化（前端读取链路）解析到的父子关系也应指向 parent_b
        from apps.tabdata.utils.record_serializers import serialize_record

        child.refresh_from_db()
        serialized = serialize_record(child, field_key_type='id')
        serialized_cell = serialized["fields"].get(str(parent_field.id))
        serialized_obj = (
            serialized_cell[0] if isinstance(serialized_cell, list) else serialized_cell
        )
        self.assertIsInstance(serialized_obj, dict)
        self.assertEqual(str(serialized_obj.get("id")), str(parent_b.id))

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_move_via_link_cell_rejects_cycle(self):
        """协作落库守卫：不能把记录移动到自己的子记录下（成环）。"""
        parent_field = self._create_parent_link_field(flagged=True)
        root, error = RecordService(user=self.owner).create_record(
            self.table.id, {str(self.primary_field.id): "根"},
        )
        self.assertIsNone(error)
        child, _pf = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=root.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "子"},
            user=self.owner,
        )

        CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={
                # 试图把 root 挂到它的子记录 child 下 → 成环，必须被拒绝
                str(root.id): {parent_field.id.hex: {"id": str(child.id)}},
            },
            new_records={},
            deleted_record_ids=[],
            row_order=[str(root.id), str(child.id)],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.owner.id),
        )

        # root 仍无父记录（变更被拒绝），child 仍挂在 root 下
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=root,
            ).exists()
        )
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=root,
            ).exists()
        )

    def test_validate_grouping_policy_rejects_non_parent_group_field(self):
        parent_field = self._create_parent_link_field(flagged=True)
        other_field = TableField.objects.create(
            table=self.table,
            name="状态",
            field_type="text",
            order=9,
        )

        with self.assertRaises(ValueError) as exc:
            SubRecordService.validate_grouping_policy(
                table_id=self.table.id,
                groups=[{"field_id": str(other_field.id)}],
                sub_record_parent_field_id=str(parent_field.id),
            )

        self.assertIn("仅支持按父记录字段分组", str(exc.exception))

    def test_validate_grouping_policy_rejects_multi_level_groups(self):
        parent_field = self._create_parent_link_field(flagged=True)

        with self.assertRaises(ValueError) as exc:
            SubRecordService.validate_grouping_policy(
                table_id=self.table.id,
                groups=[
                    {"field_id": str(parent_field.id)},
                    {"field_id": str(parent_field.id)},
                ],
                sub_record_parent_field_id=str(parent_field.id),
            )

        self.assertIn("暂不支持多级分组", str(exc.exception))

    def test_update_view_allows_single_parent_group_in_sub_record_mode(self):
        parent_field = self._create_parent_link_field(flagged=True)
        view = self._create_grid_view(
            config={"subRecordParentFieldId": str(parent_field.id)}
        )

        service = ViewService(user=self.owner)
        updated = service.update_view(
            view_id=view.id,
            groups=[{"field_id": str(parent_field.id), "direction": "asc"}],
        )

        self.assertIsNotNone(updated)
        self.assertEqual(updated.groups[0]["field_id"], str(parent_field.id))

    def test_update_view_rejects_non_parent_group_in_sub_record_mode(self):
        parent_field = self._create_parent_link_field(flagged=True)
        other_field = TableField.objects.create(
            table=self.table,
            name="优先级",
            field_type="text",
            order=10,
        )
        view = self._create_grid_view(
            config={"subRecordParentFieldId": str(parent_field.id)}
        )

        service = ViewService(user=self.owner)
        with self.assertRaises(ValueError) as exc:
            service.update_view(
                view_id=view.id,
                groups=[{"field_id": str(other_field.id)}],
            )

        self.assertIn("仅支持按父记录字段分组", str(exc.exception))

    # ──────────────────────────────────────────────────────
    # reorder_tree 原子接口测试
    # ──────────────────────────────────────────────────────

    @skipUnless(connection.vendor == 'postgresql', 'reorder_tree writes native storage')
    def test_reorder_tree_changes_hierarchy_and_order(self):
        """reorder_tree 单事务同时改变层级和排序"""
        parent_field = self._create_parent_link_field(flagged=True)
        root = self._create_record("Root", order=1)
        child_a = self._create_record("ChildA", order=2)
        sibling = self._create_record("Sibling", order=3)

        # child_a 是 root 的子记录
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child_a, foreign_record=root, order=0
        )

        # 将 child_a 移动到 sibling 下面
        result = SubRecordService.reorder_tree(
            table_id=self.table.id,
            moved_root_record_id=child_a.id,
            new_parent_id=sibling.id,
            position='after',
            anchor_record_id=sibling.id,
            parent_field_id=parent_field.id,
            user=self.owner,
        )

        self.assertTrue(result['success'])
        self.assertIn(str(child_a.id), result['updated_record_ids'])

        # 验证层级已改变
        new_parent = LinkRecord.objects.filter(
            link_field=parent_field, self_record=child_a
        ).values_list('foreign_record_id', flat=True).first()
        self.assertEqual(new_parent, sibling.id)

    @skipUnless(connection.vendor == 'postgresql', 'reorder_tree writes native storage')
    def test_reorder_tree_to_top_level(self):
        """reorder_tree 可将子记录提升为顶级记录"""
        parent_field = self._create_parent_link_field(flagged=True)
        root = self._create_record("Root", order=1)
        child = self._create_record("Child", order=2)
        other = self._create_record("Other", order=3)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )

        result = SubRecordService.reorder_tree(
            table_id=self.table.id,
            moved_root_record_id=child.id,
            new_parent_id=None,
            position='after',
            anchor_record_id=other.id,
            parent_field_id=parent_field.id,
            user=self.owner,
        )

        self.assertTrue(result['success'])
        # 验证已无父链接
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child
            ).exists()
        )

    def test_reorder_tree_rejects_cycle(self):
        """reorder_tree 防止循环引用"""
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("Parent", order=1)
        child = self._create_record("Child", order=2)
        grandchild = self._create_record("Grandchild", order=3)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=grandchild, foreign_record=child, order=0
        )

        with self.assertRaises(ValueError) as exc:
            SubRecordService.reorder_tree(
                table_id=self.table.id,
                moved_root_record_id=parent.id,
                new_parent_id=grandchild.id,
                position='after',
                anchor_record_id=grandchild.id,
                parent_field_id=parent_field.id,
                user=self.owner,
            )
        self.assertIn("不能将记录移动到自己的子记录下", str(exc.exception))

    def test_reorder_tree_rejects_depth_overflow(self):
        """reorder_tree 校验子树移动后深度不超限"""
        parent_field = self._create_parent_link_field(flagged=True)

        # 构建 4 级链：d0 -> d1 -> d2 -> d3
        d0 = self._create_record("D0", order=1)
        d1 = self._create_record("D1", order=2)
        d2 = self._create_record("D2", order=3)
        d3 = self._create_record("D3", order=4)
        # 移动目标：m0 -> m1
        m0 = self._create_record("M0", order=5)
        m1 = self._create_record("M1", order=6)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=d1, foreign_record=d0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d2, foreign_record=d1, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d3, foreign_record=d2, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=m1, foreign_record=m0, order=0
        )

        # m0(depth=0) 有子树深度 1，移到 d3(depth=3) 下后 m0 depth=4, m1 depth=5 > 4
        with self.assertRaises(ValueError) as exc:
            SubRecordService.reorder_tree(
                table_id=self.table.id,
                moved_root_record_id=m0.id,
                new_parent_id=d3.id,
                position='after',
                anchor_record_id=d3.id,
                parent_field_id=parent_field.id,
                user=self.owner,
            )
        self.assertIn("超过最大层级深度", str(exc.exception))

    @skipUnless(connection.vendor == 'postgresql', 'reorder_tree writes native storage')
    def test_reorder_tree_with_descendants(self):
        """reorder_tree 移动时子树整体跟随"""
        parent_field = self._create_parent_link_field(flagged=True)

        root = self._create_record("Root", order=1)
        child = self._create_record("Child", order=2)
        grandchild = self._create_record("Grandchild", order=3)
        target = self._create_record("Target", order=4)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=grandchild, foreign_record=child, order=0
        )

        result = SubRecordService.reorder_tree(
            table_id=self.table.id,
            moved_root_record_id=child.id,
            new_parent_id=target.id,
            position='after',
            anchor_record_id=target.id,
            parent_field_id=parent_field.id,
            move_with_descendants=True,
            user=self.owner,
        )

        # child + grandchild 都应在 updated 列表中
        self.assertEqual(len(result['updated_record_ids']), 2)
        self.assertIn(str(child.id), result['updated_record_ids'])
        self.assertIn(str(grandchild.id), result['updated_record_ids'])

    def test_reorder_tree_permission_denied(self):
        """reorder_tree 对 viewer 应拒绝"""
        parent_field = self._create_parent_link_field(flagged=True)
        record = self._create_record("A", order=1)

        with self.assertRaises(PermissionError):
            SubRecordService.reorder_tree(
                table_id=self.table.id,
                moved_root_record_id=record.id,
                new_parent_id=None,
                position='end',
                user=self.viewer,
            )

    # ──────────────────────────────────────────────────────
    # _get_all_descendants 测试
    # ──────────────────────────────────────────────────────

    def test_get_all_descendants(self):
        """获取所有后代记录"""
        parent_field = self._create_parent_link_field(flagged=True)
        root = self._create_record("Root", order=1)
        c1 = self._create_record("C1", order=2)
        c2 = self._create_record("C2", order=3)
        gc1 = self._create_record("GC1", order=4)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=c1, foreign_record=root, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=c2, foreign_record=root, order=1
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=gc1, foreign_record=c1, order=0
        )

        descendants = SubRecordService._get_all_descendants(root.id, parent_field)
        self.assertEqual(set(descendants), {c1.id, c2.id, gc1.id})

    def test_get_all_descendants_empty_for_leaf(self):
        """叶子节点无后代"""
        parent_field = self._create_parent_link_field(flagged=True)
        leaf = self._create_record("Leaf", order=1)

        descendants = SubRecordService._get_all_descendants(leaf.id, parent_field)
        self.assertEqual(descendants, [])

    # ──────────────────────────────────────────────────────
    # 成功路径测试
    # ──────────────────────────────────────────────────────

    @skipUnless(connection.vendor == 'postgresql', 'create_sub_record writes native storage')
    def test_create_sub_record_happy_path(self):
        """成功创建子记录并验证父子关系"""
        parent_field = self._create_parent_link_field(flagged=True)
        parent_record = self._create_record("Parent", order=1)

        new_record, returned_field = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=parent_record.id,
            parent_field_id=parent_field.id,
            data={str(self.primary_field.id): "Child"},
            user=self.owner,
        )

        self.assertIsNotNone(new_record)
        self.assertEqual(returned_field.id, parent_field.id)
        # 验证 LinkRecord 已创建
        link = LinkRecord.objects.filter(
            link_field=parent_field,
            self_record=new_record,
            foreign_record=parent_record,
        )
        self.assertTrue(link.exists())
        # 验证深度
        depth = SubRecordService.get_record_depth(new_record.id, parent_field)
        self.assertEqual(depth, 1)

    @skipUnless(connection.vendor == 'postgresql', 'create_sub_record writes native storage')
    def test_create_sub_record_auto_creates_parent_field(self):
        """不传 parent_field_id 时自动创建父记录字段"""
        from apps.tabdata.services.record_service import RecordService

        parent_record = self._create_record("Parent", order=1)
        captured_create_data = {}
        original_create_record = RecordService.create_record

        def capture_create_record(service, *args, **kwargs):
            captured_create_data.update(kwargs.get("data") or {})
            return original_create_record(service, *args, **kwargs)

        with patch.object(
            RecordService,
            "create_record",
            autospec=True,
            side_effect=capture_create_record,
        ):
            new_record, auto_field = SubRecordService.create_sub_record(
                table_id=self.table.id,
                parent_record_id=parent_record.id,
                parent_field_id=None,
                data={},
                user=self.owner,
            )

        self.assertIsNotNone(auto_field)
        self.assertEqual(auto_field.field_type, "link")
        self.assertTrue(auto_field.config.get("isSubRecordParentField"))
        self.assertTrue(auto_field.config.get("isOneWay"))
        self.assertEqual(auto_field.config["relationship"], "ManyOne")
        self.assertEqual(
            captured_create_data.get(str(auto_field.id)),
            str(parent_record.id),
        )

    def test_move_record_happy_path(self):
        """成功将子记录从一个父记录移到另一个父记录"""
        parent_field = self._create_parent_link_field(flagged=True)
        parent_a = self._create_record("ParentA", order=1)
        parent_b = self._create_record("ParentB", order=2)
        child = self._create_record("Child", order=3)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent_a, order=0
        )

        SubRecordService.move_record(
            table_id=self.table.id,
            record_id=child.id,
            new_parent_id=parent_b.id,
            parent_field_id=parent_field.id,
            user=self.owner,
        )

        # 旧链接应该消失
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_a
            ).exists()
        )
        # 新链接应该建立
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child, foreign_record=parent_b
            ).exists()
        )
        self.assertEqual(SubRecordService.get_record_depth(child.id, parent_field), 1)

    def test_move_record_to_root(self):
        """将子记录移到根级别"""
        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("Parent", order=1)
        child = self._create_record("Child", order=2)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=parent, order=0
        )

        SubRecordService.move_record(
            table_id=self.table.id,
            record_id=child.id,
            new_parent_id=None,
            parent_field_id=parent_field.id,
            user=self.owner,
        )

        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field, self_record=child
            ).exists()
        )
        self.assertEqual(SubRecordService.get_record_depth(child.id, parent_field), 0)

    # ──────────────────────────────────────────────────────
    # DFS 树排序与元数据测试
    # ──────────────────────────────────────────────────────

    def test_build_tree_ordered_records_dfs(self):
        """build_tree_ordered_records 应以 DFS 顺序返回"""
        parent_field = self._create_parent_link_field(flagged=True)

        root_a = self._create_record("RootA", order=1)
        child_a1 = self._create_record("ChildA1", order=2)
        child_a2 = self._create_record("ChildA2", order=3)
        grandchild_a1 = self._create_record("GCA1", order=4)
        root_b = self._create_record("RootB", order=5)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child_a1, foreign_record=root_a, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=child_a2, foreign_record=root_a, order=1
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=grandchild_a1, foreign_record=child_a1, order=0
        )

        record_ids = [root_a.id, child_a1.id, child_a2.id, grandchild_a1.id, root_b.id]
        tree_ordered = SubRecordService.build_tree_ordered_records(
            record_ids=record_ids,
            parent_field=parent_field,
            table_id=self.table.id,
        )

        ordered_ids = [rid for rid, _ in tree_ordered]
        ordered_depths = [depth for _, depth in tree_ordered]

        # DFS 顺序: RootA → ChildA1 → GCA1 → ChildA2 → RootB
        self.assertEqual(ordered_ids, [
            root_a.id, child_a1.id, grandchild_a1.id, child_a2.id, root_b.id
        ])
        self.assertEqual(ordered_depths, [0, 1, 2, 1, 0])

    def test_build_tree_metadata_structure(self):
        """build_tree_metadata 返回正确的深度、has_children 和 parent_id"""
        parent_field = self._create_parent_link_field(flagged=True)

        root = self._create_record("Root", order=1)
        child = self._create_record("Child", order=2)
        grandchild = self._create_record("Grandchild", order=3)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=child, foreign_record=root, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=grandchild, foreign_record=child, order=0
        )

        tree_ordered = [
            (root.id, 0),
            (child.id, 1),
            (grandchild.id, 2),
        ]

        metadata = SubRecordService.build_tree_metadata(
            tree_ordered=tree_ordered,
            parent_field=parent_field,
            table_id=self.table.id,
        )

        root_meta = metadata[str(root.id)]
        self.assertEqual(root_meta['depth'], 0)
        self.assertTrue(root_meta['has_children'])
        self.assertIsNone(root_meta['parent_id'])

        child_meta = metadata[str(child.id)]
        self.assertEqual(child_meta['depth'], 1)
        self.assertTrue(child_meta['has_children'])
        self.assertEqual(child_meta['parent_id'], str(root.id))

        grandchild_meta = metadata[str(grandchild.id)]
        self.assertEqual(grandchild_meta['depth'], 2)
        self.assertFalse(grandchild_meta['has_children'])
        self.assertEqual(grandchild_meta['parent_id'], str(child.id))

    # ──────────────────────────────────────────────────────
    # 深度边界测试（补充）
    # ──────────────────────────────────────────────────────

    @skipUnless(connection.vendor == 'postgresql', 'create_sub_record writes native storage')
    def test_create_sub_record_at_max_depth_succeeds(self):
        """创建第 4 级子记录应成功（depth 0→1→2→3→4）"""
        parent_field = self._create_parent_link_field(flagged=True)

        d0 = self._create_record("D0", order=1)
        d1 = self._create_record("D1", order=2)
        d2 = self._create_record("D2", order=3)
        d3 = self._create_record("D3", order=4)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=d1, foreign_record=d0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d2, foreign_record=d1, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d3, foreign_record=d2, order=0
        )

        # d3 depth=3, 创建 d4 depth=4 应该成功
        new_record, returned_field = SubRecordService.create_sub_record(
            table_id=self.table.id,
            parent_record_id=d3.id,
            parent_field_id=parent_field.id,
            data={},
            user=self.owner,
        )
        self.assertIsNotNone(new_record)
        depth = SubRecordService.get_record_depth(new_record.id, parent_field)
        self.assertEqual(depth, 4)

    @skipUnless(connection.vendor == 'postgresql', 'create_sub_record writes native storage')
    def test_create_sub_record_beyond_max_depth_fails(self):
        """创建第 5 级子记录应被拒绝"""
        parent_field = self._create_parent_link_field(flagged=True)

        d0 = self._create_record("D0", order=1)
        d1 = self._create_record("D1", order=2)
        d2 = self._create_record("D2", order=3)
        d3 = self._create_record("D3", order=4)
        d4 = self._create_record("D4", order=5)

        LinkRecord.objects.create(
            link_field=parent_field, self_record=d1, foreign_record=d0, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d2, foreign_record=d1, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d3, foreign_record=d2, order=0
        )
        LinkRecord.objects.create(
            link_field=parent_field, self_record=d4, foreign_record=d3, order=0
        )

        # d4 depth=4，创建 d5 应被拒
        with self.assertRaises(ValueError) as exc:
            SubRecordService.create_sub_record(
                table_id=self.table.id,
                parent_record_id=d4.id,
                parent_field_id=parent_field.id,
                data={},
                user=self.owner,
            )
        self.assertIn("已达最大层级深度", str(exc.exception))

    def _build_depth_chain(self, parent_field: TableField, depth: int):
        """构造 depth=0..depth 的父子链，返回最深节点。"""
        records = []
        for i in range(depth + 1):
            records.append(self._create_record(f"D{i}", order=i + 1))
        for i in range(1, depth + 1):
            LinkRecord.objects.create(
                link_field=parent_field,
                self_record=records[i],
                foreign_record=records[i - 1],
                order=0,
            )
        return records

    @skipUnless(connection.vendor == 'postgresql', 'create_record writes native storage')
    def test_create_record_with_parent_link_beyond_max_depth_fails(self):
        """通用 create_record 写父链也不能绕过 4 级上限。"""
        parent_field = self._create_parent_link_field(flagged=True)
        chain = self._build_depth_chain(parent_field, depth=4)
        d4 = chain[-1]

        with self.assertRaises(ValueError) as exc:
            RecordService(user=self.owner).create_record(
                table_id=self.table.id,
                data={str(parent_field.id): str(d4.id)},
            )
        self.assertIn("已达最大层级深度", str(exc.exception))

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_create_sub_record_writes_linkrecord(self):
        """协作 create 带子记录父链时必须写入 LinkRecord。"""
        from uuid import uuid4

        parent_field = self._create_parent_link_field(flagged=True)
        parent = self._create_record("父记录", order=1)
        child_id = uuid4()

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(child_id): {
                    self.primary_field.id.hex: "协作子记录",
                    parent_field.id.hex: {"id": str(parent.id), "title": "父记录"},
                },
            },
            deleted_record_ids=[],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.owner.id),
        )

        self.assertEqual(result["created"], 1)
        self.assertTrue(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record_id=child_id,
                foreign_record=parent,
            ).exists()
        )
        child = TableRecord.objects.get(id=child_id)
        self.assertEqual(child.data[parent_field.id.hex]["id"], str(parent.id))

    @skipUnless(connection.vendor == 'postgresql', 'collab persist uses native storage')
    def test_collab_create_beyond_max_depth_clears_parent_and_returns_correction(self):
        """协作 create 第 5 级应拒绝父链并回写 cell 修正，不写 LinkRecord。"""
        from uuid import uuid4

        parent_field = self._create_parent_link_field(flagged=True)
        chain = self._build_depth_chain(parent_field, depth=4)
        d4 = chain[-1]
        child_id = uuid4()

        result = CollabService.persist_changes(
            table_id=self.table.id,
            changed_records={},
            new_records={
                str(child_id): {
                    self.primary_field.id.hex: "超深子记录",
                    parent_field.id.hex: {"id": str(d4.id), "title": "D4"},
                },
            },
            deleted_record_ids=[],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.owner.id),
        )

        self.assertEqual(result["created"], 1)
        self.assertFalse(
            LinkRecord.objects.filter(
                link_field=parent_field,
                self_record_id=child_id,
            ).exists()
        )
        corrections = result.get("record_cell_corrections") or {}
        self.assertIn(str(child_id), corrections)
        self.assertIsNone(corrections[str(child_id)][parent_field.id.hex])
        child = TableRecord.objects.get(id=child_id)
        self.assertNotIn(parent_field.id.hex, child.data or {})
        self.assertNotIn(str(parent_field.id), child.data or {})

    # ──────────────────────────────────────────────────────
    # 多父字段切换测试
    # ──────────────────────────────────────────────────────

    def test_multiple_parent_fields_switch(self):
        """多个自引用字段可分别构建独立的树结构"""
        field_a = self._create_parent_link_field(flagged=True)
        field_b = TableField.objects.create(
            table=self.table,
            name="另一种层级",
            field_type="link",
            order=2,
            config={
                "foreignTableId": str(self.table.id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        root = self._create_record("Root", order=1)
        child = self._create_record("Child", order=2)
        other_root = self._create_record("OtherRoot", order=3)
        other_child = self._create_record("OtherChild", order=4)

        # field_a: child → root；field_b: other_child → other_root（独立关系）
        LinkRecord.objects.create(
            link_field=field_a, self_record=child, foreign_record=root, order=0
        )
        LinkRecord.objects.create(
            link_field=field_b, self_record=other_child, foreign_record=other_root, order=0
        )

        self.assertEqual(SubRecordService.get_record_depth(child.id, field_a), 1)
        self.assertEqual(SubRecordService.get_record_depth(child.id, field_b), 0)
        self.assertEqual(SubRecordService.get_record_depth(other_child.id, field_b), 1)
        self.assertEqual(SubRecordService.get_record_depth(other_child.id, field_a), 0)

        ordered_a = SubRecordService.build_tree_ordered_records(
            [root.id, child.id, other_root.id, other_child.id],
            field_a,
            self.table.id,
        )
        ordered_b = SubRecordService.build_tree_ordered_records(
            [root.id, child.id, other_root.id, other_child.id],
            field_b,
            self.table.id,
        )
        depth_by_id_a = {rid: depth for rid, depth in ordered_a}
        depth_by_id_b = {rid: depth for rid, depth in ordered_b}
        self.assertEqual(depth_by_id_a[child.id], 1)
        self.assertEqual(depth_by_id_a[other_child.id], 0)
        self.assertEqual(depth_by_id_b[other_child.id], 1)
        self.assertEqual(depth_by_id_b[child.id], 0)

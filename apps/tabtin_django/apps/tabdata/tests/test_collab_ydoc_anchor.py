"""CollabYDocSubscriber 锚点口径单元测试。

覆盖新增的两段核心逻辑：
- ``_extract_created_ids``：从新建记录事件提取 record_id。
- ``_compute_anchor_map``：为新记录算出 ``__order`` 前驱（anchor），无前驱时为 None。

锚点用于让 collab-live 把新记录插到前驱之后，使协作行序跟随 ``__order``，
而不再一律 ``maxPos+1`` 沉底。
"""
from datetime import datetime, timezone

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.events import (
    RecordCreated, RecordCreatedPayload,
    RecordsBatchCreated, RecordUpdated,
)
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.subscribers.collab_ydoc import CollabYDocSubscriber
from apps.tabtinspace.models import Space, Organization

User = get_user_model()


def _now():
    return datetime.now(timezone.utc)


class CollabYDocAnchorTestCase(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.user = User.objects.create_user(
            username="collab_anchor_user",
            email="collab_anchor_user@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Collab Anchor Organization", owner=self.user,
        )
        self.space = Space.objects.create(
            organization=self.organization, name="Collab Anchor Space",
            type="team",
        )
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id, space_id=self.space.id,
            name="锚点表", owner=self.user,
        )
        self.field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, name="标题", field_type="text", order=0,
        )
        # 三条已有记录，order = 0 / 1024 / 2048
        self.r0 = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "A"}, order=0.0,
        )
        self.r1 = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "B"}, order=1024.0,
        )
        self.r2 = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "C"}, order=2048.0,
        )

    # ── _extract_created_ids ──

    def test_extract_created_ids_for_record_created(self):
        ev = RecordCreated(
            event_id="e1", table_id=self.table.id, occurred_at=_now(),
            triggered_by=None, record_id=self.r1.id,
            data={}, after={},
        )
        self.assertEqual(
            CollabYDocSubscriber._extract_created_ids(ev), [str(self.r1.id)],
        )

    def test_extract_created_ids_for_batch_created(self):
        ev = RecordsBatchCreated(
            event_id="e3", table_id=self.table.id, occurred_at=_now(),
            triggered_by=None,
            records=(
                RecordCreatedPayload(record_id=self.r1.id, data={}, after={}),
                RecordCreatedPayload(record_id=self.r2.id, data={}, after={}),
            ),
            count=2,
        )
        self.assertEqual(
            CollabYDocSubscriber._extract_created_ids(ev),
            [str(self.r1.id), str(self.r2.id)],
        )

    def test_extract_created_ids_empty_for_update(self):
        ev = RecordUpdated(
            event_id="e4", table_id=self.table.id, occurred_at=_now(),
            triggered_by=None, record_id=self.r1.id,
            before={}, after={}, changes={},
        )
        self.assertEqual(CollabYDocSubscriber._extract_created_ids(ev), [])

    # ── _compute_anchor_map ──

    def test_anchor_is_immediate_predecessor_by_order(self):
        # 新记录夹在 r0(0) 与 r1(1024) 之间 → anchor 应为 r0
        new = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "child"}, order=512.0,
        )
        anchor_map = CollabYDocSubscriber._compute_anchor_map(
            self.table.id, [str(new.id)],
        )
        self.assertEqual(anchor_map[str(new.id)], str(self.r0.id))

    def test_anchor_none_when_record_is_global_top(self):
        # order 比所有人都小 → 无前驱 → None（插到最前）
        top = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "top"}, order=-100.0,
        )
        anchor_map = CollabYDocSubscriber._compute_anchor_map(
            self.table.id, [str(top.id)],
        )
        self.assertIsNone(anchor_map[str(top.id)])

    def test_anchor_for_record_at_end(self):
        # order 比所有人都大 → anchor 为 r2（当前末尾）
        tail = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "tail"}, order=9999.0,
        )
        anchor_map = CollabYDocSubscriber._compute_anchor_map(
            self.table.id, [str(tail.id)],
        )
        self.assertEqual(anchor_map[str(tail.id)], str(self.r2.id))

    def test_anchor_excludes_self_and_deleted(self):
        # 软删的记录不应成为 anchor
        self.r1.is_deleted = True
        self.r1.save(using=TABDATA_DB_ALIAS, update_fields=["is_deleted"])
        new = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={str(self.field.id): "child"}, order=1500.0,
        )
        anchor_map = CollabYDocSubscriber._compute_anchor_map(
            self.table.id, [str(new.id)],
        )
        # r1 已删，前驱应跳过 r1，落到 r0（order=0 < 1500，r2=2048>1500）
        self.assertEqual(anchor_map[str(new.id)], str(self.r0.id))

    def test_anchor_map_empty_for_no_created(self):
        self.assertEqual(
            CollabYDocSubscriber._compute_anchor_map(self.table.id, []), {},
        )

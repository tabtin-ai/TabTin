"""
Association schema §1 骨架测试：LinkRelation/LinkEdge 约束 + gateway plan/execute。

运行（推荐 syncdb + 独立 PG 测试库，避开历史迁移阻塞）：
    cd apps/tabtin_django
    USE_SQLITE_FOR_TESTS=0 PG_TEST_DB_NAME=test_tabtin_assoc_6083 \
      python manage.py test apps.tabdata.tests.test_association_schema_gateway -v 2 \
      --settings=tabtin.settings_tabdata_test --keepdb
"""

from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase, TransactionTestCase

from apps.tabdata.models import LinkEdge, LinkRelation, Table, TableField, TableRecord
from apps.tabdata.services.association_schema_gateway import AssociationSchemaGateway
from apps.tabdata.services.association_schema_types import (
    AssociationCommand,
    AssociationCommandKind,
)
from apps.tabtinspace.models import Organization, Space

User = get_user_model()


class AssociationSchemaModelTests(TestCase):
    """模型约束：唯一边、单向/对称一致性。"""

    databases = ["default"]

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(
            username="assoc-model-user",
            email="assoc-model@example.com",
            password="testpass123",
        )
        cls.organization = Organization.objects.create(
            name="AssocModelOrg",
            owner=cls.user,
        )
        cls.space = Space.objects.create(
            organization=cls.organization,
            name="AssocModelSpace",
        )
        cls.host_table = Table.objects.create(
            name="Host",
            organization_id=cls.organization.id,
            space_id=cls.space.id,
            owner=cls.user,
        )
        cls.foreign_table = Table.objects.create(
            name="Foreign",
            organization_id=cls.organization.id,
            space_id=cls.space.id,
            owner=cls.user,
        )
        cls.host_field = TableField.objects.create(
            table=cls.host_table,
            name="Link",
            field_type="link",
            config={"foreignTableId": str(cls.foreign_table.id), "isOneWay": True},
        )
        cls.host_record = TableRecord.objects.create(
            table=cls.host_table,
            created_by=cls.user,
        )
        cls.foreign_record = TableRecord.objects.create(
            table=cls.foreign_table,
            created_by=cls.user,
        )

    def test_one_way_relation_requires_null_symmetric(self):
        relation = LinkRelation.objects.create(
            organization_id=self.organization.id,
            host_table=self.host_table,
            foreign_table=self.foreign_table,
            host_field=self.host_field,
            symmetric_field=None,
            host_relationship="ManyOne",
            is_one_way=True,
        )
        self.assertTrue(relation.is_one_way)
        self.assertIsNone(relation.symmetric_field_id)

    def test_edge_unique_triple(self):
        relation = LinkRelation.objects.create(
            organization_id=self.organization.id,
            host_table=self.host_table,
            foreign_table=self.foreign_table,
            host_field=self.host_field,
            host_relationship="ManyMany",
            is_one_way=True,
        )
        LinkEdge.objects.create(
            relation=relation,
            host_record=self.host_record,
            foreign_record=self.foreign_record,
            host_order=0,
            foreign_order=0,
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                LinkEdge.objects.create(
                    relation=relation,
                    host_record=self.host_record,
                    foreign_record=self.foreign_record,
                    host_order=1,
                    foreign_order=1,
                )


class AssociationSchemaGatewayTests(TransactionTestCase):
    """gateway plan/execute 骨架行为。"""

    databases = ["default"]

    def setUp(self):
        self.user = User.objects.create_user(
            username=f"assoc-gw-{uuid4().hex[:8]}",
            email=f"assoc-gw-{uuid4().hex[:8]}@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="AssocGwOrg",
            owner=self.user,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="AssocGwSpace",
        )
        self.host_table = Table.objects.create(
            name="Host",
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner=self.user,
        )
        self.foreign_table = Table.objects.create(
            name="Foreign",
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner=self.user,
        )
        self.host_field = TableField.objects.create(
            table=self.host_table,
            name="ToForeign",
            field_type="link",
            config={
                "foreignTableId": str(self.foreign_table.id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        self.symmetric_field = TableField.objects.create(
            table=self.foreign_table,
            name="ToHost",
            field_type="link",
            config={
                "foreignTableId": str(self.host_table.id),
                "relationship": "ManyMany",
                "isOneWay": False,
                "symmetricFieldId": str(self.host_field.id),
            },
        )
        self.host_field.config["symmetricFieldId"] = str(self.symmetric_field.id)
        self.host_field.save(update_fields=["config"])
        self.host_record = TableRecord.objects.create(
            table=self.host_table,
            created_by=self.user,
        )
        self.foreign_record_a = TableRecord.objects.create(
            table=self.foreign_table,
            created_by=self.user,
        )
        self.foreign_record_b = TableRecord.objects.create(
            table=self.foreign_table,
            created_by=self.user,
        )

    def test_plan_create_link_blocked_without_host_field(self):
        plan = AssociationSchemaGateway.plan(
            AssociationCommand(
                kind=AssociationCommandKind.CREATE_LINK,
                organization_id=self.organization.id,
                host_table_id=self.host_table.id,
                foreign_table_id=self.foreign_table.id,
                host_relationship="ManyMany",
                is_one_way=True,
            )
        )
        self.assertFalse(plan.can_execute)
        self.assertIn("missing_host_field", [b.code for b in plan.blockers])

    def test_create_and_set_edges_roundtrip(self):
        create_cmd = AssociationCommand(
            kind=AssociationCommandKind.CREATE_LINK,
            organization_id=self.organization.id,
            host_table_id=self.host_table.id,
            foreign_table_id=self.foreign_table.id,
            host_field_id=self.host_field.id,
            symmetric_field_id=self.symmetric_field.id,
            host_relationship="ManyMany",
            is_one_way=False,
        )
        plan = AssociationSchemaGateway.plan(create_cmd)
        self.assertTrue(plan.can_execute, plan.blockers)
        result = AssociationSchemaGateway.execute(create_cmd, plan=plan)
        self.assertTrue(result.success, result.error_message)
        self.assertIsNotNone(result.relation_id)
        relation = LinkRelation.objects.get(id=result.relation_id)
        self.assertEqual(relation.host_field_id, self.host_field.id)
        self.assertEqual(relation.symmetric_field_id, self.symmetric_field.id)

        set_cmd = AssociationCommand(
            kind=AssociationCommandKind.SET_EDGES,
            organization_id=self.organization.id,
            relation_id=relation.id,
            edges=(
                {
                    "host_record_id": str(self.host_record.id),
                    "foreign_record_id": str(self.foreign_record_a.id),
                    "host_order": 0,
                    "foreign_order": 0,
                },
                {
                    "host_record_id": str(self.host_record.id),
                    "foreign_record_id": str(self.foreign_record_b.id),
                    "host_order": 1,
                    "foreign_order": 0,
                },
            ),
        )
        set_plan = AssociationSchemaGateway.plan(set_cmd)
        set_result = AssociationSchemaGateway.execute(set_cmd, plan=set_plan)
        self.assertTrue(set_result.success, set_result.error_message)
        self.assertEqual(set_result.edges_created, 2)
        self.assertEqual(LinkEdge.objects.filter(relation=relation).count(), 2)

        # 缩边：只保留一条
        shrink_cmd = AssociationCommand(
            kind=AssociationCommandKind.SET_EDGES,
            organization_id=self.organization.id,
            relation_id=relation.id,
            edges=(
                {
                    "host_record_id": str(self.host_record.id),
                    "foreign_record_id": str(self.foreign_record_a.id),
                    "host_order": 0,
                    "foreign_order": 3,
                },
            ),
        )
        shrink_plan = AssociationSchemaGateway.plan(shrink_cmd)
        shrink_result = AssociationSchemaGateway.execute(shrink_cmd, plan=shrink_plan)
        self.assertTrue(shrink_result.success)
        self.assertEqual(shrink_result.edges_deleted, 1)
        self.assertEqual(shrink_result.edges_updated, 1)
        edge = LinkEdge.objects.get(relation=relation)
        self.assertEqual(edge.foreign_record_id, self.foreign_record_a.id)
        self.assertEqual(edge.foreign_order, 3)

    def test_execute_rejects_stale_fingerprint(self):
        create_cmd = AssociationCommand(
            kind=AssociationCommandKind.CREATE_LINK,
            organization_id=self.organization.id,
            host_table_id=self.host_table.id,
            foreign_table_id=self.foreign_table.id,
            host_field_id=self.host_field.id,
            symmetric_field_id=self.symmetric_field.id,
            host_relationship="ManyMany",
            is_one_way=False,
            expected_fingerprint="deadbeef" * 4,
        )
        plan = AssociationSchemaGateway.plan(create_cmd)
        result = AssociationSchemaGateway.execute(create_cmd, plan=plan)
        # plan 本身可执行，但 command.expected_fingerprint 不匹配
        self.assertFalse(result.success)
        self.assertEqual(result.error_code, "fingerprint_mismatch")

    def test_delete_relation_removes_edges(self):
        create_cmd = AssociationCommand(
            kind=AssociationCommandKind.CREATE_LINK,
            organization_id=self.organization.id,
            host_table_id=self.host_table.id,
            foreign_table_id=self.foreign_table.id,
            host_field_id=self.host_field.id,
            is_one_way=True,
            host_relationship="ManyOne",
        )
        # one-way: clear symmetric on host field path — use one-way host only
        # Reconfigure: create needs is_one_way without symmetric
        # host_field already has symmetric in config; model allows one-way register
        result = AssociationSchemaGateway.execute(create_cmd)
        self.assertTrue(result.success, result.error_message)
        relation_id = result.relation_id
        AssociationSchemaGateway.execute(
            AssociationCommand(
                kind=AssociationCommandKind.SET_EDGES,
                organization_id=self.organization.id,
                relation_id=relation_id,
                edges=(
                    {
                        "host_record_id": str(self.host_record.id),
                        "foreign_record_id": str(self.foreign_record_a.id),
                    },
                ),
            )
        )
        delete_result = AssociationSchemaGateway.execute(
            AssociationCommand(
                kind=AssociationCommandKind.DELETE_LINK,
                organization_id=self.organization.id,
                relation_id=relation_id,
            )
        )
        self.assertTrue(delete_result.success)
        self.assertFalse(LinkRelation.objects.filter(id=relation_id).exists())
        self.assertEqual(LinkEdge.objects.filter(relation_id=relation_id).count(), 0)

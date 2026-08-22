"""billing.0039 真实 PostgreSQL 升级场景：孤儿 organization_id。

复现 ACK Test 迁移 Job 曾踩的坑：清理 SQL 先把孤儿引用写成 NULL，
但字段仍是 NOT NULL，PostgreSQL 直接拒绝。

本测试在临时库上：
migrate → 0038 → 插入孤儿行 → migrate → 0039 → 断言行保留且列变为可空 UUID。
"""

from __future__ import annotations

import uuid

import pytest

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase

pytestmark = pytest.mark.requires_pg_native


class BillingOrganizationFkOrphanMigrationScenario(
    PostgresMigrationScenarioTestCase
):
    app_label = "billing"
    migrate_from = "0038_auto_topup_yuan_fields"
    migrate_to = "0039_organization_fk_convergence_3832"

    def test_migration_scenario(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        self.event_id = str(uuid.uuid4())
        orphan_org = f"orphan-{uuid.uuid4().hex[:12]}"
        self.execute(
            """
            INSERT INTO services_billing_usage_event (
                id,
                organization_id,
                user_id,
                meter_key,
                quantity,
                unit,
                unit_price,
                amount,
                currency,
                provider_key,
                model_name,
                biz_type,
                biz_id,
                idempotency_key,
                metadata,
                occurred_at,
                created_at,
                aggregation_key,
                charge_status,
                scene_key
            ) VALUES (
                %s::uuid,
                %s,
                %s,
                'llm.tokens',
                1,
                'token',
                0.001,
                0.001,
                'CNY',
                'test',
                'scenario',
                'migration_scenario',
                %s,
                %s,
                '{}'::jsonb,
                NOW(),
                NOW(),
                '',
                'pending',
                ''
            )
            """,
            [
                self.event_id,
                orphan_org,
                uuid.uuid4().hex[:32],
                uuid.uuid4().hex,
                f"migscen-{uuid.uuid4().hex}",
            ],
        )
        # 0038 时仍是 varchar NOT NULL
        self.assertFalse(
            self.column_nullable("services_billing_usage_event", "organization_id")
        )

    def assert_after_migration(self, connection) -> None:
        row = self.fetchone(
            """
            SELECT organization_id
            FROM services_billing_usage_event
            WHERE id = %s::uuid
            """,
            [self.event_id],
        )
        self.assertIsNotNone(row, "孤儿计费事件在迁移后必须保留")
        self.assertIsNone(row[0], "孤儿 organization_id 应被清成 NULL")
        self.assertTrue(
            self.column_nullable("services_billing_usage_event", "organization_id")
        )
        self.assertEqual(
            self.column_udt_name("services_billing_usage_event", "organization_id"),
            "uuid",
        )

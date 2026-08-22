"""wallet.0020 真实 PostgreSQL 升级场景：孤儿 organization_id。

与 billing.0039 同类顺序问题：必须先把历史 CharField 改为可空，
再把无法归因的流水 organization_id 清成 NULL。

脏数据构造：
- 组织 + 钱包保留（避免被「孤儿钱包连同流水删除」清掉）
- 流水自身的 organization_id 写成不存在的值（模拟无法归因的 legacy 流水）
"""

from __future__ import annotations

import uuid

import pytest

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase

pytestmark = pytest.mark.requires_pg_native


class WalletOrganizationFkOrphanMigrationScenario(
    PostgresMigrationScenarioTestCase
):
    app_label = "wallet"
    migrate_from = "0019_cash_transaction_llm_auto_topup_type"
    migrate_to = "0020_organization_fk_convergence_3832"
    # 0020 才依赖 tabtinspace.0093；seed 需要组织表已存在，故提前钉住。
    extra_targets = (("tabtinspace", "0093_organization_tombstone_fields_3832"),)

    def test_migration_scenario(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        self.tx_id = uuid.uuid4().hex[:32]
        self.wallet_id = uuid.uuid4().hex[:32]
        self.org_id = str(uuid.uuid4())
        orphan_org = f"orphan-{uuid.uuid4().hex[:12]}"
        owner_id = uuid.uuid4().hex[:32]

        # 组织.owner 有 FK；临时关闭触发器/FK，专注测流水 organization_id 顺序。
        self.execute("SET session_replication_role = replica")
        try:
            self.execute(
                """
                INSERT INTO tabtinspace_organization (
                    id, name, description, icon, is_default, settings,
                    space_count, table_count, member_count,
                    created_at, updated_at, owner_id, type, status,
                    delete_requested_by_id
                ) VALUES (
                    %s::uuid, 'migscen org', '', '', FALSE, '{}'::jsonb,
                    0, 0, 0, NOW(), NOW(), %s, 'team', 'active', ''
                )
                """,
                [self.org_id, owner_id],
            )
            self.execute(
                """
                INSERT INTO users_wallet_organization_wallet (
                    id, organization_id, credits, credits_precise,
                    credits_frozen, credits_frozen_precise, created_at, updated_at
                ) VALUES (
                    %s, %s, 10, 10, 0, 0, NOW(), NOW()
                )
                """,
                [self.wallet_id, self.org_id],
            )
            self.execute(
                """
                INSERT INTO users_wallet_transaction (
                    id,
                    organization_wallet_id,
                    transaction_type,
                    amount,
                    amount_precise,
                    balance_before,
                    balance_before_precise,
                    balance_after,
                    balance_after_precise,
                    organization_id,
                    operator_user_id,
                    related_order_id,
                    description,
                    created_at,
                    usage_event_id,
                    billing_metadata
                ) VALUES (
                    %s,
                    %s,
                    'consume',
                    1,
                    1,
                    10,
                    10,
                    9,
                    9,
                    %s,
                    %s,
                    '',
                    'migration scenario orphan org on tx',
                    NOW(),
                    '',
                    '{}'::jsonb
                )
                """,
                [
                    self.tx_id,
                    self.wallet_id,
                    orphan_org,
                    owner_id,
                ],
            )
        finally:
            self.execute("SET session_replication_role = DEFAULT")

        self.assertFalse(
            self.column_nullable("users_wallet_transaction", "organization_id")
        )

    def assert_after_migration(self, connection) -> None:
        row = self.fetchone(
            """
            SELECT organization_id
            FROM users_wallet_transaction
            WHERE id = %s
            """,
            [self.tx_id],
        )
        self.assertIsNotNone(row, "无法归因的钱包流水在迁移后必须保留")
        self.assertIsNone(row[0], "孤儿 organization_id 应被清成 NULL")
        self.assertTrue(
            self.column_nullable("users_wallet_transaction", "organization_id")
        )
        self.assertEqual(
            self.column_udt_name("users_wallet_transaction", "organization_id"),
            "uuid",
        )

"""
Wave 1-B 回归测试 + system_key 扩展测试：
workspace 自动预置「规划」Collection + 存量迁移幂等性 + system_key 稳定锚点。

测试设计要点：
- 用 disconnect_signal 关闭 User.post_save → create_default_organization 链路，
  防止 setUp 创建 user 时副带创建一个 personal Organization + workspace，
  污染我们对预置/迁移行为的断言。
- ProvisionTests 用真实 User（AgentService 内部需要 user.id 与 display_name）。
- MigrationTests 用 fake UUID 作为 owner_id（Organization.owner db_constraint=False）
  以最小化 setUp 复杂度。
"""
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabtinspace.models import (
    Agent,
    Collection,
    Space,
    Organization,
    OrganizationMember,
)
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()

PLANNING_NAME = "规划"
PLANNING_ICON = "📋"
PLANNING_SYSTEM_KEY = "planning_root"


class _DisconnectDefaultOrganizationSignal:
    """临时 disconnect User.post_save → create_default_organization，避免测试副作用。"""

    def __enter__(self):
        post_save.disconnect(receiver=create_default_organization, sender=User)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        post_save.connect(receiver=create_default_organization, sender=User)
        return False


class PlanningCollectionProvisionTests(TestCase):
    """create_agent_workspace 预置「规划」Collection 的正向 / 负向 / 事务性测试。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._signal_guard = _DisconnectDefaultOrganizationSignal()
        cls._signal_guard.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._signal_guard.__exit__(None, None, None)
        super().tearDownClass()

    def setUp(self):
        user_manager = User.objects.db_manager("default")
        self.owner = user_manager.create_user(
            username="planning_owner",
            email="planning-owner@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Planning Provision Team",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.service = AgentService(user=self.owner)

    def _create_agent_workspace(self, name="Bot A"):
        return self.service.create_agent_workspace(
            organization_id=self.organization.id,
            name=name,
        )

    def test_bot_space_provisions_planning_collection(self):
        """新建 workspace → 根级出现一个带 system_key 的「规划」Collection。"""
        _agent, space, _warning = self._create_agent_workspace()

        collections = list(Collection.objects.filter(workspace=space))
        self.assertEqual(len(collections), 1)

        coll = collections[0]
        self.assertEqual(coll.name, PLANNING_NAME)
        self.assertEqual(coll.icon, PLANNING_ICON)
        self.assertEqual(coll.system_key, PLANNING_SYSTEM_KEY)
        self.assertIsNone(coll.parent_id)
        self.assertEqual(coll.order, 0)
        self.assertEqual(coll.created_by_id, self.owner.id)

    def test_bot_space_planning_collection_is_idempotent(self):
        """重复调用 _provision_planning_collection 不会产生重复 Collection。"""
        _agent, space, _warning = self._create_agent_workspace()
        self.service._provision_planning_collection(space)
        self.service._provision_planning_collection(space)

        count = Collection.objects.filter(
            workspace=space, system_key=PLANNING_SYSTEM_KEY,
        ).count()
        self.assertEqual(count, 1)

    def test_user_space_is_not_provisioned(self):
        """直接 Space.objects.create(type='team') 不应自动出现 Collection。

        预置仅在 AgentService.create_agent_workspace 内显式触发，
        不挂在 Space.post_save signal 上，避免误装到非 workspace。
        """
        non_bot_space = Space.objects.create(
            organization=self.organization,
            name="Team Space",
            status="active",
            type="team",
        )
        self.assertFalse(
            Collection.objects.filter(workspace=non_bot_space).exists(),
        )

    def test_collection_failure_rolls_back_bot_space_creation(self):
        """Collection 创建抛异常 → Space / Agent 整体回滚，不留孤儿。"""
        bot_spaces_before = Space.objects.filter(
            organization=self.organization, type=Space.SpaceType.WORKSPACE,
        ).count()

        with patch.object(
            AgentService, '_provision_planning_collection',
            side_effect=RuntimeError("collection provision exploded"),
        ):
            with self.assertRaises(RuntimeError):
                self._create_agent_workspace(name="Will Rollback")

        bot_spaces_after = Space.objects.filter(
            organization=self.organization, type=Space.SpaceType.WORKSPACE,
        ).count()
        self.assertEqual(bot_spaces_before, bot_spaces_after)

        self.assertFalse(
            Space.objects.filter(
                organization=self.organization, name="Will Rollback",
            ).exists()
        )

    def test_multiple_bot_spaces_each_get_their_own_planning_collection(self):
        """多个 workspace 独立持有各自的「规划」Collection。"""
        _, space_a, _ = self._create_agent_workspace(name="Bot Alpha")
        _, space_b, _ = self._create_agent_workspace(name="Bot Beta")

        for sp in (space_a, space_b):
            colls = Collection.objects.filter(
                workspace=sp, system_key=PLANNING_SYSTEM_KEY,
            )
            self.assertEqual(colls.count(), 1)

    def test_renamed_collection_still_found_by_system_key(self):
        """用户重命名「规划」→「我的项目」后，_provision 仍通过 system_key 找到。"""
        _agent, space, _warning = self._create_agent_workspace()

        coll = Collection.objects.get(workspace=space, system_key=PLANNING_SYSTEM_KEY)
        coll.name = "我的项目"
        coll.save(update_fields=["name", "updated_at"])

        returned = self.service._provision_planning_collection(space)
        self.assertEqual(returned.id, coll.id)
        self.assertEqual(returned.system_key, PLANNING_SYSTEM_KEY)
        self.assertEqual(
            Collection.objects.filter(workspace=space, system_key=PLANNING_SYSTEM_KEY).count(), 1,
        )

    def test_system_key_unique_constraint_per_space(self):
        """同一 Space 不允许两个 system_key 相同的 Collection。"""
        _agent, space, _warning = self._create_agent_workspace()
        with self.assertRaises(IntegrityError):
            Collection.objects.create(
                workspace=space,
                parent=None,
                name="重复 planning",
                system_key=PLANNING_SYSTEM_KEY,
            )

    def test_user_collection_has_no_system_key(self):
        """用户自建 Collection 的 system_key 为 None。"""
        _agent, space, _warning = self._create_agent_workspace()
        user_coll = Collection.objects.create(
            workspace=space,
            parent=None,
            name="用户自建",
            icon="📂",
        )
        self.assertIsNone(user_coll.system_key)


class PlanningCollectionMigrationTests(TestCase):
    """0041_backfill_planning_collection 数据迁移的幂等性回归。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._signal_guard = _DisconnectDefaultOrganizationSignal()
        cls._signal_guard.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._signal_guard.__exit__(None, None, None)
        super().tearDownClass()

    def setUp(self):
        # owner FK 是 db_constraint=False，不需要真实 user
        self.organization = Organization.objects.create(
            name="Planning Migration Team",
            owner_id=uuid4(),
            is_default=False,
        )

    def _make_bot_space(self, name: str) -> Space:
        bot_agent = Agent.objects.create(
            organization=self.organization,
            name=f"{name} Agent",
            type='bot',
            is_active=True,
        )
        return Space.objects.create(
            organization=self.organization,
            agent=bot_agent,
            name=name,
            status="active",
            type=Space.SpaceType.WORKSPACE,
        )

    def _make_team_space(self, name: str) -> Space:
        return Space.objects.create(
            organization=self.organization,
            name=name,
            status="active",
            type="team",
        )

    def _run_migration_0041(self):
        """复用 migration 0041 的 forward 函数。"""
        import importlib
        from django.apps import apps as global_apps
        module = importlib.import_module(
            "apps.tabtinspace.migrations.0041_backfill_planning_collection",
        )
        module.forward(global_apps, schema_editor=None)

    def _run_migration_0042(self):
        """复用 migration 0042 的 backfill_planning_system_key 函数。"""
        import importlib
        from django.apps import apps as global_apps
        module = importlib.import_module(
            "apps.tabtinspace.migrations.0042_collection_system_key",
        )
        module.backfill_planning_system_key(global_apps, schema_editor=None)

    def _run_migration(self):
        """按顺序跑 0041 + 0042 的数据回填。"""
        self._run_migration_0041()
        self._run_migration_0042()

    def test_migration_backfills_planning_collection_for_bot_spaces(self):
        bot_a = self._make_bot_space("Existing Bot A")
        bot_b = self._make_bot_space("Existing Bot B")
        team_space = self._make_team_space("Existing Team")

        self.assertFalse(Collection.objects.filter(workspace__in=[bot_a, bot_b]).exists())

        self._run_migration()

        for sp in (bot_a, bot_b):
            colls = Collection.objects.filter(
                workspace=sp, parent__isnull=True, name=PLANNING_NAME,
            )
            self.assertEqual(colls.count(), 1)
            coll = colls.first()
            self.assertEqual(coll.icon, PLANNING_ICON)
            self.assertEqual(coll.order, 0)
            self.assertEqual(coll.system_key, PLANNING_SYSTEM_KEY)

        self.assertFalse(Collection.objects.filter(workspace=team_space).exists())

    def test_migration_is_idempotent_when_run_twice(self):
        bot = self._make_bot_space("Idempotent Bot")

        self._run_migration()
        self._run_migration()

        count = Collection.objects.filter(
            workspace=bot, system_key=PLANNING_SYSTEM_KEY,
        ).count()
        self.assertEqual(count, 1)

    def test_migration_skips_bot_space_with_existing_planning_collection(self):
        bot = self._make_bot_space("Pre-Provisioned Bot")
        existing = Collection.objects.create(
            workspace=bot,
            parent=None,
            name=PLANNING_NAME,
            icon='📁',  # 故意用不同 icon，验证 migration 不会覆写
            color='red',
            order=99,
        )

        self._run_migration()

        colls = list(Collection.objects.filter(
            workspace=bot, parent__isnull=True, name=PLANNING_NAME,
        ))
        self.assertEqual(len(colls), 1)
        self.assertEqual(colls[0].id, existing.id)
        self.assertEqual(colls[0].icon, '📁')
        self.assertEqual(colls[0].order, 99)

    def test_migration_handles_empty_database(self):
        """无任何 workspace 时迁移应静默完成（不会创建任何 Collection）。"""
        self.assertFalse(Space.objects.filter(type=Space.SpaceType.WORKSPACE).exists())
        before = Collection.objects.count()
        self._run_migration()
        after = Collection.objects.count()
        self.assertEqual(after, before)

    def test_migration_0042_backfills_system_key(self):
        """0042 data migration：已有 name='规划' 的 Collection 被回填 system_key。"""
        bot = self._make_bot_space("System Key Bot")
        coll = Collection.objects.create(
            workspace=bot,
            parent=None,
            name=PLANNING_NAME,
            icon=PLANNING_ICON,
        )
        self.assertIsNone(coll.system_key)

        self._run_migration_0042()

        coll.refresh_from_db()
        self.assertEqual(coll.system_key, PLANNING_SYSTEM_KEY)

    def test_migration_0042_is_idempotent(self):
        """0042 重复执行不会出错，也不会覆盖已有 system_key。"""
        bot = self._make_bot_space("Idempotent 0042 Bot")
        Collection.objects.create(
            workspace=bot,
            parent=None,
            name=PLANNING_NAME,
            icon=PLANNING_ICON,
            system_key=PLANNING_SYSTEM_KEY,
        )

        self._run_migration_0042()
        self._run_migration_0042()

        count = Collection.objects.filter(
            workspace=bot, system_key=PLANNING_SYSTEM_KEY,
        ).count()
        self.assertEqual(count, 1)

    def test_migration_0042_skips_non_planning_collections(self):
        """非 name='规划' 的 Collection 不会被误回填 system_key。"""
        bot = self._make_bot_space("Non Planning Bot")
        user_coll = Collection.objects.create(
            workspace=bot,
            parent=None,
            name="我的笔记",
            icon="📝",
        )

        self._run_migration_0042()

        user_coll.refresh_from_db()
        self.assertIsNone(user_coll.system_key)

"""#7124：历史 agent_id=NULL 画像清偿逻辑单测。"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from django.apps import apps as django_apps
from django.test import TestCase, override_settings

if not django_apps.is_installed("apps.user_portrait.tests._fake_tabtinspace"):
    pytest.skip(
        "test_legacy_migration 需要 settings_user_portrait_integration_test",
        allow_module_level=True,
    )

from apps.user_portrait.constants import USER_PORTRAIT_DB
from apps.user_portrait.models import UserPortrait, UserPortraitSnapshot
from apps.user_portrait.services.legacy_migration import (
    migrate_legacy_null_portraits,
    reassign_memories_from_inactive_agents,
    resolve_preferred_agent_id,
    run_legacy_portrait_migration,
)
from apps.user_portrait.tests._fake_tabtinspace.models import Organization
from apps.users.auth.models import User


class _FakeAgentQS:
    def __init__(self, rows):
        self._rows = list(rows)

    def filter(self, **kwargs):
        out = self._rows
        for key, value in kwargs.items():
            out = [row for row in out if getattr(row, key) == value]
        return _FakeAgentQS(out)

    def order_by(self, *fields):
        if not fields:
            return self
        field = fields[0]
        reverse = field.startswith("-")
        key = field.lstrip("-")
        return _FakeAgentQS(
            sorted(self._rows, key=lambda r: getattr(r, key), reverse=reverse)
        )

    def first(self):
        return self._rows[0] if self._rows else None

    def values(self, *fields):
        return [
            {field: getattr(row, field) for field in fields}
            for row in self._rows
        ]


class _FakeAgentModel:
    def __init__(self, rows):
        self.objects = _FakeAgentQS(rows)


@override_settings(ROOT_URLCONF="tabtin.tests_urls_empty")
class ResolvePreferredAgentIdTests(TestCase):
    """不依赖真实 agent app：用 FakeAgentModel 验 owner 作用域。"""

    def test_prefers_default_for_same_owner_only(self):
        org = uuid.uuid4()
        owner_a = uuid.uuid4()
        owner_b = uuid.uuid4()
        t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
        t1 = datetime(2026, 1, 2, tzinfo=timezone.utc)
        agent_b_default = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id=org,
            owner_user_id=owner_b,
            is_active=True,
            is_default=True,
            created_at=t0,
        )
        agent_a_default = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id=org,
            owner_user_id=owner_a,
            is_active=True,
            is_default=True,
            created_at=t1,
        )
        agent_a_other = SimpleNamespace(
            id=uuid.uuid4(),
            organization_id=org,
            owner_user_id=owner_a,
            is_active=True,
            is_default=False,
            created_at=t0,
        )
        model = _FakeAgentModel([agent_b_default, agent_a_default, agent_a_other])

        picked = resolve_preferred_agent_id(
            organization_id=org,
            owner_user_id=owner_a,
            agent_model=model,
        )
        self.assertEqual(picked, agent_a_default.id)

    def test_returns_none_without_owner(self):
        self.assertIsNone(
            resolve_preferred_agent_id(
                organization_id=uuid.uuid4(),
                owner_user_id=None,
                agent_model=_FakeAgentModel([]),
            )
        )


@override_settings(ROOT_URLCONF="tabtin.tests_urls_empty")
class LegacyPortraitMigrationTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="legacy@portrait.test",
            password="StrongPass123!",
        )
        self.organization = Organization.objects.create(
            name="Legacy Org",
            owner_id=self.user.id,
        )
        self.oid = self.organization.id
        self.default_agent_id = uuid.uuid4()
        self.other_agent_id = uuid.uuid4()

    def _create_null_portrait(self, *, content: str, version: int = 1):
        return UserPortrait.objects.using(USER_PORTRAIT_DB).create(
            user=self.user,
            organization_id=self.oid,
            agent_id=None,
            content_md=content,
            version=version,
            last_distill_status=UserPortrait.DistillStatus.IDLE,
        )

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
    )
    def test_seeds_empty_sibling_and_deletes_null(self, mock_pref):
        mock_pref.return_value = self.default_agent_id
        legacy = self._create_null_portrait(content="## 工作背景\n旧正文")
        empty = UserPortrait.objects.using(USER_PORTRAIT_DB).create(
            user=self.user,
            organization_id=self.oid,
            agent_id=self.other_agent_id,
            content_md="",
            version=0,
        )

        stats = migrate_legacy_null_portraits(dry_run=False)

        empty.refresh_from_db()
        self.assertEqual(empty.content_md, "## 工作背景\n旧正文")
        self.assertEqual(empty.version, 1)
        self.assertFalse(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(id=legacy.id)
            .exists()
        )
        default_p = UserPortrait.objects.using(USER_PORTRAIT_DB).get(
            user=self.user,
            organization_id=self.oid,
            agent_id=self.default_agent_id,
        )
        self.assertEqual(default_p.content_md, "## 工作背景\n旧正文")
        self.assertEqual(stats.seeded_existing, 1)
        self.assertEqual(stats.created_for_default, 1)
        self.assertEqual(stats.deleted_null_portraits, 1)
        mock_pref.assert_called()
        self.assertEqual(
            mock_pref.call_args.kwargs.get("owner_user_id"),
            self.user.id,
        )

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
    )
    def test_keeps_null_when_preferred_non_empty_and_no_empty_sibling(self, mock_pref):
        """无法落点时保留 NULL，不静默丢弃唯一旧正文。"""
        mock_pref.return_value = self.default_agent_id
        legacy = self._create_null_portrait(content="## 工作背景\n旧正文")
        kept = UserPortrait.objects.using(USER_PORTRAIT_DB).create(
            user=self.user,
            organization_id=self.oid,
            agent_id=self.default_agent_id,
            content_md="## 工作背景\n已有正文",
            version=3,
        )

        stats = migrate_legacy_null_portraits(dry_run=False)

        kept.refresh_from_db()
        self.assertEqual(kept.content_md, "## 工作背景\n已有正文")
        self.assertEqual(kept.version, 3)
        self.assertTrue(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(id=legacy.id, agent_id__isnull=True)
            .exists()
        )
        self.assertEqual(stats.skipped_could_not_place, 1)
        self.assertEqual(stats.deleted_null_portraits, 0)

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
    )
    def test_seeds_whitespace_only_sibling_as_empty(self, mock_pref):
        mock_pref.return_value = self.default_agent_id
        legacy = self._create_null_portrait(content="## 工作背景\n旧正文")
        blankish = UserPortrait.objects.using(USER_PORTRAIT_DB).create(
            user=self.user,
            organization_id=self.oid,
            agent_id=self.other_agent_id,
            content_md="   \n",
            version=0,
        )

        stats = migrate_legacy_null_portraits(dry_run=False)

        blankish.refresh_from_db()
        self.assertEqual(blankish.content_md, "## 工作背景\n旧正文")
        self.assertEqual(stats.seeded_existing, 1)
        self.assertEqual(stats.deleted_null_portraits, 1)

    def test_empty_null_portrait_deleted_without_agent(self):
        legacy = self._create_null_portrait(content="")
        with patch(
            "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
            return_value=None,
        ):
            stats = migrate_legacy_null_portraits(dry_run=False)
        self.assertFalse(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(id=legacy.id)
            .exists()
        )
        self.assertEqual(stats.skipped_empty_null, 1)
        self.assertEqual(stats.deleted_null_portraits, 1)

    def test_dry_run_counts_empty_null_as_planned_delete(self):
        """dry-run 对空正文 NULL 行须计入 deleted_*，与实跑一致。"""
        legacy = self._create_null_portrait(content="")
        UserPortraitSnapshot.objects.using(USER_PORTRAIT_DB).create(
            portrait=legacy,
            content_md="",
            version_at_snapshot=0,
            trigger_reason="manual",
            input_summary={},
        )
        with patch(
            "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
            return_value=None,
        ):
            stats = migrate_legacy_null_portraits(dry_run=True)
        self.assertTrue(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(id=legacy.id)
            .exists()
        )
        self.assertEqual(stats.skipped_empty_null, 1)
        self.assertEqual(stats.deleted_null_portraits, 1)
        self.assertEqual(stats.deleted_snapshots, 1)

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
        return_value=None,
    )
    def test_contentful_null_kept_when_no_active_agent(self, _mock_pref):
        legacy = self._create_null_portrait(content="## 工作背景\n保留")
        stats = migrate_legacy_null_portraits(dry_run=False)
        self.assertTrue(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(id=legacy.id)
            .exists()
        )
        self.assertEqual(stats.skipped_no_active_agent, 1)
        self.assertEqual(stats.deleted_null_portraits, 0)

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
    )
    def test_idempotent_second_run(self, mock_pref):
        mock_pref.return_value = self.default_agent_id
        self._create_null_portrait(content="## 工作背景\n旧正文")
        first = run_legacy_portrait_migration(
            dry_run=False, reassign_inactive_memories=False,
        )
        second = run_legacy_portrait_migration(
            dry_run=False, reassign_inactive_memories=False,
        )
        self.assertEqual(first.deleted_null_portraits, 1)
        self.assertEqual(second.null_portraits_seen, 0)
        self.assertEqual(second.deleted_null_portraits, 0)

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
    )
    def test_dry_run_does_not_write(self, mock_pref):
        mock_pref.return_value = self.default_agent_id
        legacy = self._create_null_portrait(content="## 工作背景\n旧正文")
        stats = migrate_legacy_null_portraits(dry_run=True)
        self.assertTrue(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(id=legacy.id)
            .exists()
        )
        self.assertEqual(stats.deleted_null_portraits, 1)  # 预估
        self.assertEqual(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(agent_id=self.default_agent_id)
            .count(),
            0,
        )

    @patch(
        "apps.user_portrait.services.legacy_migration.resolve_preferred_agent_id",
    )
    def test_deletes_snapshots_with_null_portrait(self, mock_pref):
        mock_pref.return_value = self.default_agent_id
        legacy = self._create_null_portrait(content="## 工作背景\n旧正文")
        UserPortraitSnapshot.objects.using(USER_PORTRAIT_DB).create(
            portrait=legacy,
            content_md=legacy.content_md,
            version_at_snapshot=legacy.version,
            trigger_reason="manual",
            input_summary={},
        )
        stats = migrate_legacy_null_portraits(dry_run=False)
        self.assertEqual(stats.deleted_snapshots, 1)
        self.assertEqual(
            UserPortraitSnapshot.objects.using(USER_PORTRAIT_DB).count(),
            0,
        )


@override_settings(ROOT_URLCONF="tabtin.tests_urls_empty")
class ReassignInactiveMemoriesTests(TestCase):
    def test_reassigns_to_owner_scoped_preferred(self):
        org = uuid.uuid4()
        owner = uuid.uuid4()
        inactive_id = uuid.uuid4()
        preferred_id = uuid.uuid4()
        other_owner_default = uuid.uuid4()

        inactive = SimpleNamespace(
            id=inactive_id,
            organization_id=org,
            owner_user_id=owner,
            is_active=False,
            is_default=False,
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        preferred = SimpleNamespace(
            id=preferred_id,
            organization_id=org,
            owner_user_id=owner,
            is_active=True,
            is_default=True,
            created_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        )
        foreign_default = SimpleNamespace(
            id=other_owner_default,
            organization_id=org,
            owner_user_id=uuid.uuid4(),
            is_active=True,
            is_default=True,
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        agent_model = _FakeAgentModel([inactive, preferred, foreign_default])

        mem_qs = MagicMock()
        mem_qs.count.return_value = 2
        mem_qs.update.return_value = 2
        memory_model = MagicMock()
        memory_model.objects.filter.return_value = mem_qs

        registry = MagicMock()
        registry.is_installed.return_value = True

        def _get_model(app_label, model_name):
            if (app_label, model_name) == ("agent", "Agent"):
                return agent_model
            if (app_label, model_name) == ("agent_memory", "AgentMemory"):
                return memory_model
            raise LookupError(app_label)

        registry.get_model.side_effect = _get_model

        moved = reassign_memories_from_inactive_agents(
            dry_run=False,
            apps_registry=registry,
        )
        self.assertEqual(moved, 2)
        memory_model.objects.filter.assert_called_with(
            agent_id=inactive_id,
            status="active",
        )
        mem_qs.update.assert_called_once_with(agent_id=preferred_id)

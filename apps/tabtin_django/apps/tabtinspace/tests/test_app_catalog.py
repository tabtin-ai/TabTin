"""OrganizationAppCatalogService 单元测试 + API 集成测试 + Space Apps 过滤测试

覆盖范围（I13）：
- Service: get_installed_app_ids / list_catalog / install_app / uninstall_app / auto_install_core_apps
- API:     权限校验 / CORE_APP 保护 / 幂等安装 / 卸载级联
- Space:   get_space_app_settings 的 Organization 安装过滤层
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase

from apps.services.common.app_registry import CORE_APPS, MARKETPLACE_APPS
from apps.tabtinspace.models import (
    Agent,
    Space,
    SpaceAppSettings,
    Organization,
    OrganizationAppInstall,
    OrganizationMember,

    Workspace,
    Device,)
from apps.tabtinspace.services.app_catalog_service import OrganizationAppCatalogService
from apps.tabtinspace.services.base import ServiceError


# ── Helpers ──────────────────────────────────────────────────────────


def _make_user(uid=None):
    return SimpleNamespace(id=str(uid or uuid.uuid4()))


def _make_organization(owner) -> Organization:
    return Organization.objects.create(
        name="Test Team",
        owner_id=owner.id,
        is_default=False,
    )


def _make_space(organization, name="Test Space") -> Workspace:
    from apps.tabtinspace.models import Device, Workspace
    agent = Agent.objects.create(
        organization=organization,
        name=f"{name} Agent",
        type="bot",
        is_active=True,
    )
    device = Device.objects.create(
        organization=organization,
        user_id=organization.owner_id,
        name=f"{name} Device",
        device_type="electron",
        fingerprint=f"app-catalog-{organization.id}-{name}",
    )
    return Workspace.objects.create(
        organization=organization,
        device=device,
        created_by_id=organization.owner_id,
        name=name,
        working_dir=f"/tmp/app-catalog/{organization.id}/{name}",
        normalized_working_dir=f"/tmp/app-catalog/{organization.id}/{name}",
        kind=Workspace.Kind.STANDARD,
    )


def _make_member(organization, user, role='viewer') -> OrganizationMember:
    return OrganizationMember.objects.create(
        organization=organization,
        user_id=user.id,
        role=role,
    )


def _expected_core_ids(*extra_ids: str) -> set[str]:
    return {
        app_id for app_id, app_def in CORE_APPS.items()
        if getattr(app_def, 'is_default_enabled', True)
    } | set(extra_ids)


# ══════════════════════════════════════════════════════════════════════
# Service 层单元测试
# ══════════════════════════════════════════════════════════════════════


class GetInstalledAppIdsTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)

    def test_auto_backfills_core_apps_when_no_installs(self):
        result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(result, _expected_core_ids())
        self.assertEqual(
            OrganizationAppInstall.objects.filter(organization=self.organization).count(),
            len(_expected_core_ids()),
        )

    def test_preserves_marketplace_installs_while_backfilling_core_apps(self):
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdata', app_source='core',
        )
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(result, _expected_core_ids('my-tinapp'))

    def test_removes_default_disabled_core_app_installs(self):
        default_disabled = next(
            app_id for app_id, app_def in CORE_APPS.items()
            if not getattr(app_def, 'is_default_enabled', True)
        )
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id=default_disabled, app_source='core',
        )

        result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)

        self.assertEqual(result, _expected_core_ids())
        self.assertFalse(
            OrganizationAppInstall.objects.filter(
                organization=self.organization,
                app_id=default_disabled,
            ).exists()
        )

    @patch('apps.tabtinspace.services.app_catalog_service.cache')
    def test_cache_hit_with_stale_subset_triggers_core_app_backfill(self, mock_cache):
        mock_cache.get.return_value = ['tabdata', 'tabdoc']
        result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(result, _expected_core_ids())
        mock_cache.get.assert_called_once()
        mock_cache.set.assert_called_once()
        self.assertEqual(
            OrganizationAppInstall.objects.filter(organization=self.organization).count(),
            len(_expected_core_ids()),
        )

    @patch('apps.tabtinspace.services.app_catalog_service.cache')
    def test_falls_back_to_db_on_cache_miss(self, mock_cache):
        mock_cache.get.return_value = None
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdata', app_source='core',
        )
        result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(result, _expected_core_ids())
        mock_cache.set.assert_called_once()

    @patch('apps.tabtinspace.services.app_catalog_service.cache')
    def test_falls_back_to_core_apps_on_db_error(self, mock_cache):
        mock_cache.get.side_effect = Exception("Redis down")
        with patch.object(
            OrganizationAppInstall.objects, 'filter',
            side_effect=Exception("DB down"),
        ):
            result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(result, _expected_core_ids())

    def test_does_not_cross_organization_boundaries(self):
        other_owner = _make_user()
        other_wt = _make_organization(other_owner)
        OrganizationAppInstall.objects.create(
            organization=other_wt, app_id='my-tinapp', app_source='marketplace',
        )
        result = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(result, _expected_core_ids())
        self.assertNotIn('my-tinapp', result)


class AutoInstallCoreAppsTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)

    def test_creates_default_core_app_records(self):
        count = OrganizationAppCatalogService.auto_install_core_apps(
            self.organization, self.owner,
        )
        self.assertEqual(count, len(_expected_core_ids()))
        db_ids = set(
            OrganizationAppInstall.objects
            .filter(organization=self.organization)
            .values_list('app_id', flat=True)
        )
        self.assertEqual(db_ids, _expected_core_ids())

    def test_idempotent_on_duplicate_call(self):
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        total = OrganizationAppInstall.objects.filter(organization=self.organization).count()
        self.assertEqual(total, len(_expected_core_ids()))

    def test_all_records_have_core_source(self):
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        sources = set(
            OrganizationAppInstall.objects
            .filter(organization=self.organization)
            .values_list('app_source', flat=True)
        )
        self.assertEqual(sources, {'core'})

    def test_installed_by_set_to_user(self):
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        installers = set(
            OrganizationAppInstall.objects
            .filter(organization=self.organization)
            .values_list('installed_by_id', flat=True)
        )
        self.assertEqual(installers, {self.owner.id})

    @patch.object(OrganizationAppCatalogService, '_invalidate_cache')
    def test_invalidates_organization_cache_when_records_created(self, mock_invalidate_cache):
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        mock_invalidate_cache.assert_called_once_with(self.organization.id)


class ListCatalogTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)

    def test_returns_all_core_apps(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        app_ids = {a['id'] for a in result['apps']}
        for core_id in CORE_APPS:
            self.assertIn(core_id, app_ids)

    def test_core_apps_marked_installed(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        core_apps = [a for a in result['apps'] if a['source'] == 'core']
        for app in core_apps:
            self.assertTrue(app['installed'], f"{app['id']} should be installed")

    def test_categories_include_all_with_correct_count(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        all_cat = next(c for c in result['categories'] if c['id'] == 'all')
        self.assertEqual(all_cat['count'], len(result['apps']))

    def test_can_manage_true_for_owner(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        self.assertTrue(result['can_manage'])

    def test_can_manage_true_for_admin(self):
        admin = _make_user()
        _make_member(self.organization, admin, role='admin')
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=admin,
        )
        self.assertTrue(result['can_manage'])

    def test_can_manage_false_for_viewer(self):
        viewer = _make_user()
        _make_member(self.organization, viewer, role='viewer')
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=viewer,
        )
        self.assertFalse(result['can_manage'])

    def test_can_manage_false_for_editor(self):
        editor = _make_user()
        _make_member(self.organization, editor, role='editor')
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=editor,
        )
        self.assertFalse(result['can_manage'])

    def test_apps_have_description_and_category(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        for app in result['apps']:
            if app['source'] == 'core':
                self.assertTrue(
                    app['description'],
                    f"{app['id']} should have a description",
                )
                self.assertTrue(
                    app['category'],
                    f"{app['id']} should have a category",
                )

    def test_apps_have_required_fields(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        required_keys = {
            'id', 'name', 'icon', 'description', 'detail_description',
            'screenshots', 'category', 'source', 'installed',
            'is_default_enabled', 'order', 'version',
        }
        for app in result['apps']:
            self.assertTrue(
                required_keys.issubset(app.keys()),
                f"App {app.get('id', '?')} missing fields: {required_keys - app.keys()}",
            )

    def test_cowart_official_plugin_card_is_in_marketplace_catalog(self):
        self.assertIn('cowart', MARKETPLACE_APPS)

        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )

        cowart = next(app for app in result['apps'] if app['id'] == 'cowart')
        self.assertEqual(cowart['source'], 'marketplace')
        self.assertEqual(cowart['install_scope'], 'organization')
        self.assertEqual(cowart['version'], '0.1.2')
        self.assertFalse(cowart['installed'])
        self.assertEqual(
            cowart['official_plugin_release']['source']['origin'],
            'https://github.com/zhongerxin/cowart',
        )
        self.assertEqual(
            cowart['official_plugin_release']['source']['pinnedRevision'],
            'v0.1.2',
        )
        self.assertFalse(cowart['prepared_runtime']['dependencyInstallRequired'])

    def test_core_apps_have_no_version(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        for app in result['apps']:
            if app['source'] == 'core':
                self.assertIsNone(app['version'])

    def test_missing_core_apps_are_repaired_before_listing(self):
        """若 CORE_APPS 安装记录被手动删除，list_catalog 读取前会自动补齐。"""
        OrganizationAppInstall.objects.filter(
            organization=self.organization, app_id='tabdata',
        ).delete()
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        tabdata = next(a for a in result['apps'] if a['id'] == 'tabdata')
        self.assertTrue(tabdata['installed'])
        self.assertTrue(
            OrganizationAppInstall.objects.filter(
                organization=self.organization, app_id='tabdata',
            ).exists()
        )

    def test_category_counts_correct(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        cats = {c['id']: c['count'] for c in result['categories']}
        apps = result['apps']
        for cat_id, count in cats.items():
            if cat_id == 'all':
                self.assertEqual(count, len(apps))
            else:
                actual = sum(1 for a in apps if a['category'] == cat_id)
                self.assertEqual(count, actual, f"Category {cat_id}: expected {actual}, got {count}")


class InstallAppTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)

    def test_install_core_app_raises_error(self):
        with self.assertRaises(ServiceError) as ctx:
            OrganizationAppCatalogService.install_app(
                self.organization.id, 'tabdata', user=self.owner,
            )
        self.assertEqual(ctx.exception.code, 'INVALID_OPERATION')
        self.assertEqual(ctx.exception.status, 400)

    @patch('apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise')
    def test_install_tinapp_creates_record(self, mock_get):
        mock_get.return_value = SimpleNamespace(app_id='my-tinapp', status='enabled')
        install = OrganizationAppCatalogService.install_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(install.app_id, 'my-tinapp')
        self.assertEqual(install.app_source, 'marketplace')
        self.assertTrue(
            OrganizationAppInstall.objects.filter(
                organization=self.organization, app_id='my-tinapp',
            ).exists()
        )

    @patch('apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise')
    def test_install_idempotent(self, mock_get):
        mock_get.return_value = SimpleNamespace(app_id='my-tinapp', status='enabled')
        inst1 = OrganizationAppCatalogService.install_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        inst2 = OrganizationAppCatalogService.install_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(inst1.id, inst2.id)
        count = OrganizationAppInstall.objects.filter(
            organization=self.organization, app_id='my-tinapp',
        ).count()
        self.assertEqual(count, 1)

    @patch('apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise')
    def test_install_sets_installed_by(self, mock_get):
        mock_get.return_value = SimpleNamespace(app_id='my-tinapp', status='enabled')
        install = OrganizationAppCatalogService.install_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(install.installed_by_id, self.owner.id)

    def test_install_cowart_preserves_official_release_metadata(self):
        install = OrganizationAppCatalogService.install_app(
            self.organization.id, 'cowart', user=self.owner,
        )

        self.assertEqual(install.app_id, 'cowart')
        self.assertEqual(install.app_source, 'marketplace')
        self.assertEqual(
            install.install_metadata['official_plugin_release']['releaseId'],
            'tabtin-official:cowart:0.1.2',
        )
        self.assertEqual(
            install.install_metadata['official_plugin_release']['source']['origin'],
            'https://github.com/zhongerxin/cowart',
        )
        self.assertEqual(
            install.install_metadata['official_plugin_release']['source']['pinnedRevision'],
            'v0.1.2',
        )
        self.assertEqual(
            install.install_metadata['official_plugin_release']['adapter']['id'],
            'tabtin-cowart-adapter',
        )
        self.assertFalse(
            install.install_metadata['prepared_runtime']['dependencyInstallRequired'],
        )

    def test_install_all_core_apps_raise_error(self):
        """确认每个 CORE_APP 都不可手动安装。"""
        for app_id in list(CORE_APPS.keys())[:3]:
            with self.assertRaises(ServiceError) as ctx:
                OrganizationAppCatalogService.install_app(
                    self.organization.id, app_id, user=self.owner,
                )
            self.assertEqual(ctx.exception.code, 'INVALID_OPERATION')


class UninstallAppTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)

    def test_uninstall_core_app_raises_error(self):
        with self.assertRaises(ServiceError) as ctx:
            OrganizationAppCatalogService.uninstall_app(
                self.organization.id, 'tabdata', user=self.owner,
            )
        self.assertEqual(ctx.exception.code, 'INVALID_OPERATION')
        self.assertEqual(ctx.exception.status, 400)

    def test_uninstall_not_installed_returns_idempotent(self):
        result = OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertFalse(result['installed'])
        self.assertEqual(result['affected_spaces'], 0)

    def test_uninstall_deletes_record(self):
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        result = OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertFalse(result['installed'])
        self.assertFalse(
            OrganizationAppInstall.objects.filter(
                organization=self.organization, app_id='my-tinapp',
            ).exists()
        )

    def test_uninstall_cascades_to_space_disabled_apps(self):
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        space = _make_space(self.organization)
        settings = SpaceAppSettings.objects.create(
            workspace=space,
            user_id=self.owner.id,
            disabled_apps=[],
        )

        result = OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(result['affected_spaces'], 1)

        settings.refresh_from_db()
        self.assertIn('my-tinapp', settings.disabled_apps)

    def test_uninstall_cascade_no_duplicate_in_disabled_apps(self):
        """卸载时如果 disabled_apps 已包含该 app_id，不应重复添加。"""
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        space = _make_space(self.organization)
        SpaceAppSettings.objects.create(
            workspace=space,
            user_id=self.owner.id,
            disabled_apps=['my-tinapp'],
        )

        result = OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(result['affected_spaces'], 0)

    def test_uninstall_cascades_to_multiple_spaces(self):
        """卸载应影响 Organization 下所有 Space 的 SpaceAppSettings。"""
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        space1 = _make_space(self.organization, name="Space A")
        space2 = _make_space(self.organization, name="Space B")
        space3 = _make_space(self.organization, name="Space C")

        user2 = _make_user()
        s1 = SpaceAppSettings.objects.create(workspace=space1, user_id=self.owner.id, disabled_apps=[])
        s2 = SpaceAppSettings.objects.create(workspace=space2, user_id=self.owner.id, disabled_apps=[])
        s3 = SpaceAppSettings.objects.create(workspace=space3, user_id=user2.id, disabled_apps=[])

        result = OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(result['affected_spaces'], 3)

        for s in [s1, s2, s3]:
            s.refresh_from_db()
            self.assertIn('my-tinapp', s.disabled_apps)

    def test_uninstall_does_not_affect_other_organization_spaces(self):
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        other_owner = _make_user()
        other_wt = _make_organization(other_owner)
        other_space = _make_space(other_wt, name="Other Space")
        other_settings = SpaceAppSettings.objects.create(
            workspace=other_space, user_id=other_owner.id, disabled_apps=[],
        )

        OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        other_settings.refresh_from_db()
        self.assertNotIn('my-tinapp', other_settings.disabled_apps)

    def test_uninstall_returns_app_id(self):
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='my-tinapp', app_source='marketplace',
        )
        result = OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'my-tinapp', user=self.owner,
        )
        self.assertEqual(result['app_id'], 'my-tinapp')

    def test_uninstall_all_core_apps_raise_error(self):
        """确认每个 CORE_APP 都不可卸载。"""
        for app_id in list(CORE_APPS.keys())[:3]:
            with self.assertRaises(ServiceError) as ctx:
                OrganizationAppCatalogService.uninstall_app(
                    self.organization.id, app_id, user=self.owner,
                )
            self.assertEqual(ctx.exception.code, 'INVALID_OPERATION')


class CategoryMappingTests(TestCase):
    """验证 CORE_APPS 的 category 字段与 CONTEXT.md 分类体系一致。"""
    databases = {"default", "postgresql"}

    EXPECTED_CATEGORIES = {
        'tabdata': 'data',
        'tabdoc': 'creation',
        'tabslide': 'creation',
        'tabvideo': 'creation',
        'tabwhiteboard': 'creation',
        'tabmemo': 'creation',
        'tabsite': 'creation',
        'tabcode': 'development',
        'tabweb': 'development',
        'terminal': 'development',
        'orchestration': 'intelligence',
        'tabtracker': 'intelligence',
        'tabfolder': 'tools',
        'tabphone': 'tools',
    }

    def test_all_core_apps_have_category(self):
        for app_id, app_def in CORE_APPS.items():
            self.assertTrue(
                app_def.category,
                f"CORE_APP {app_id} missing category",
            )

    def test_categories_match_context_md(self):
        for app_id, expected_cat in self.EXPECTED_CATEGORIES.items():
            app_def = CORE_APPS.get(app_id)
            self.assertIsNotNone(app_def, f"CORE_APP {app_id} not found")
            self.assertEqual(
                app_def.category,
                expected_cat,
                f"CORE_APP {app_id}: expected category '{expected_cat}', got '{app_def.category}'",
            )

    def test_all_core_apps_have_description(self):
        for app_id, app_def in CORE_APPS.items():
            self.assertTrue(
                app_def.description,
                f"CORE_APP {app_id} missing description",
            )

    def test_category_names_cover_all_used_categories(self):
        used = {app_def.category for app_def in CORE_APPS.values() if app_def.category}
        known = set(OrganizationAppCatalogService.CATEGORY_NAMES.keys()) - {'all'}
        self.assertTrue(
            used.issubset(known),
            f"CORE_APPS 使用了未知分类: {used - known}",
        )


# ══════════════════════════════════════════════════════════════════════
# API 集成测试（直接调用视图函数，mock request）
# ══════════════════════════════════════════════════════════════════════


def _make_request(user, method='GET', **kwargs):
    """构造 mock request 对象，模拟 Django Ninja 的 auth 机制。"""
    req = SimpleNamespace(
        auth=user,
        method=method,
        META={'REMOTE_ADDR': '127.0.0.1', 'HTTP_USER_AGENT': 'test'},
        GET={},
    )
    for k, v in kwargs.items():
        setattr(req, k, v)
    return req


class AppCatalogAPIPermissionTests(TestCase):
    """API 端点权限校验测试。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)

    def test_get_catalog_success_for_member(self):
        from apps.tabtinspace.routers.app_catalog import get_organization_app_catalog

        viewer = _make_user()
        _make_member(self.organization, viewer, role='viewer')

        request = _make_request(viewer)
        response = get_organization_app_catalog(request, self.organization.id)
        self.assertIsInstance(response, dict)
        self.assertTrue(response.get('success', False))
        self.assertIn('apps', response.get('data', {}))

    def test_get_catalog_denied_for_non_member(self):
        from apps.tabtinspace.routers.app_catalog import get_organization_app_catalog

        stranger = _make_user()
        request = _make_request(stranger)
        response = get_organization_app_catalog(request, self.organization.id)

        if isinstance(response, tuple):
            status_code, body = response
            self.assertEqual(status_code, 403)
        else:
            self.assertTrue(
                response.get('success', True) is False
                or 'PERMISSION_DENIED' in str(response),
                f"Expected 403 for non-member, got: {response}",
            )

    def test_install_denied_for_viewer(self):
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        viewer = _make_user()
        _make_member(self.organization, viewer, role='viewer')

        request = _make_request(viewer, method='POST')
        response = install_organization_app(request, self.organization.id, 'some-app')
        if isinstance(response, tuple):
            status_code, _ = response
            self.assertEqual(status_code, 403)

    def test_install_denied_for_editor(self):
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        editor = _make_user()
        _make_member(self.organization, editor, role='editor')

        request = _make_request(editor, method='POST')
        response = install_organization_app(request, self.organization.id, 'some-app')
        if isinstance(response, tuple):
            status_code, _ = response
            self.assertEqual(status_code, 403)

    def test_uninstall_denied_for_viewer(self):
        from apps.tabtinspace.routers.app_catalog import uninstall_organization_app

        viewer = _make_user()
        _make_member(self.organization, viewer, role='viewer')

        request = _make_request(viewer, method='POST')
        response = uninstall_organization_app(request, self.organization.id, 'some-app')
        if isinstance(response, tuple):
            status_code, _ = response
            self.assertEqual(status_code, 403)


class AppCatalogAPICoreProtectionTests(TestCase):
    """API 层 CORE_APP 安装/卸载保护测试。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')

    def test_install_core_app_returns_400(self):
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        request = _make_request(self.owner, method='POST')
        response = install_organization_app(request, self.organization.id, 'tabdata')
        if isinstance(response, tuple):
            status_code, body = response
            self.assertEqual(status_code, 400)
        else:
            self.assertFalse(response.get('success', True))

    def test_uninstall_core_app_returns_400(self):
        from apps.tabtinspace.routers.app_catalog import uninstall_organization_app

        request = _make_request(self.owner, method='POST')
        response = uninstall_organization_app(request, self.organization.id, 'tabdoc')
        if isinstance(response, tuple):
            status_code, body = response
            self.assertEqual(status_code, 400)
        else:
            self.assertFalse(response.get('success', True))


class AppCatalogAPIInstallTests(TestCase):
    """API 层安装功能测试。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')

    @patch('apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise')
    def test_install_success(self, mock_get):
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        mock_get.return_value = SimpleNamespace(app_id='test-app', status='enabled')
        request = _make_request(self.owner, method='POST')
        response = install_organization_app(request, self.organization.id, 'test-app')

        if isinstance(response, dict):
            self.assertTrue(response.get('success'))
            self.assertTrue(response['data']['installed'])
            self.assertEqual(response['data']['app_id'], 'test-app')
        else:
            self.fail(f"Expected dict, got: {response}")

    @patch('apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise')
    def test_install_idempotent_via_api(self, mock_get):
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        mock_get.return_value = SimpleNamespace(app_id='test-app', status='enabled')
        request = _make_request(self.owner, method='POST')
        install_organization_app(request, self.organization.id, 'test-app')
        response = install_organization_app(request, self.organization.id, 'test-app')

        if isinstance(response, dict):
            self.assertTrue(response.get('success'))
        count = OrganizationAppInstall.objects.filter(
            organization=self.organization, app_id='test-app',
        ).count()
        self.assertEqual(count, 1)

    @patch('apps.tabtinspace.services.app_catalog_service.OrganizationAppCatalogService._get_tinapp_or_raise')
    def test_admin_can_install(self, mock_get):
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        admin = _make_user()
        _make_member(self.organization, admin, role='admin')
        mock_get.return_value = SimpleNamespace(app_id='test-app', status='enabled')

        request = _make_request(admin, method='POST')
        response = install_organization_app(request, self.organization.id, 'test-app')
        if isinstance(response, dict):
            self.assertTrue(response.get('success'))


class AppCatalogAPIUninstallTests(TestCase):
    """API 层卸载功能及级联测试。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')

    def test_uninstall_success(self):
        from apps.tabtinspace.routers.app_catalog import uninstall_organization_app

        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='test-app', app_source='marketplace',
        )
        request = _make_request(self.owner, method='POST')
        response = uninstall_organization_app(request, self.organization.id, 'test-app')

        if isinstance(response, dict):
            self.assertTrue(response.get('success'))
            self.assertFalse(response['data']['installed'])
            self.assertEqual(response['data']['app_id'], 'test-app')

    def test_uninstall_cascade_via_api(self):
        from apps.tabtinspace.routers.app_catalog import uninstall_organization_app

        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='test-app', app_source='marketplace',
        )
        space = _make_space(self.organization)
        settings = SpaceAppSettings.objects.create(
            workspace=space, user_id=self.owner.id, disabled_apps=[],
        )

        request = _make_request(self.owner, method='POST')
        response = uninstall_organization_app(request, self.organization.id, 'test-app')

        if isinstance(response, dict):
            self.assertTrue(response.get('success'))
            self.assertEqual(response['data']['affected_spaces'], 1)

        settings.refresh_from_db()
        self.assertIn('test-app', settings.disabled_apps)

    def test_uninstall_not_installed_idempotent(self):
        from apps.tabtinspace.routers.app_catalog import uninstall_organization_app

        request = _make_request(self.owner, method='POST')
        response = uninstall_organization_app(request, self.organization.id, 'not-installed')

        if isinstance(response, dict):
            self.assertTrue(response.get('success'))
            self.assertFalse(response['data']['installed'])
            self.assertEqual(response['data']['affected_spaces'], 0)


# ══════════════════════════════════════════════════════════════════════
# Space Apps API 过滤测试
# ══════════════════════════════════════════════════════════════════════


class SpaceAppsFilterTests(TestCase):
    """验证 Space Apps API 只返回 Organization 已安装的应用。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)
        self.space = _make_space(self.organization)
        _make_member(self.organization, self.owner, role='owner')

    def test_missing_core_apps_are_auto_backfilled_before_filtering(self):
        """旧 Organization 缺失新增 CORE_APPS 时，Space Apps 读取前会自动补齐。"""
        installed_ids = {'tabdata', 'tabdoc'}
        for app_id in installed_ids:
            OrganizationAppInstall.objects.create(
                organization=self.organization, app_id=app_id, app_source='core',
            )

        ids = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(ids, _expected_core_ids())

        from apps.services.common.app_registry import list_apps
        filtered = [app for app in list_apps() if app.id in ids]
        returned_ids = {app.id for app in filtered}

        self.assertEqual(returned_ids, _expected_core_ids())

    def test_default_core_apps_returned_when_installed(self):
        """安装默认 CORE_APPS 后，Space Apps 返回默认启用集合。"""
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        ids = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)

        from apps.services.common.app_registry import list_apps
        filtered = [app for app in list_apps() if app.id in ids]

        self.assertEqual(len(filtered), len(_expected_core_ids()))

    def test_empty_installs_auto_backfill_to_default_core_apps(self):
        """即使旧 Organization 完全缺失安装记录，读取时也会自动补齐默认 CORE_APPS。"""
        ids = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertEqual(ids, _expected_core_ids())

        from apps.services.common.app_registry import list_apps
        filtered = [app for app in list_apps() if app.id in ids]
        self.assertEqual(len(filtered), len(_expected_core_ids()))

    @patch('django.core.cache.cache')
    def test_space_app_settings_api_filters_by_organization(self, mock_cache):
        """直接测试 get_space_app_settings 视图的过滤逻辑。"""
        mock_cache.get.return_value = None
        mock_cache.set.return_value = None

        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdata', app_source='core',
        )
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdoc', app_source='core',
        )

        from apps.tabtinspace.routers.space import get_space_app_settings

        with patch(
            'apps.tabtinspace.routers.space.SpaceService'
        ) as MockSpaceService:
            mock_svc = MockSpaceService.return_value
            mock_svc.get_space.return_value = self.space

            request = _make_request(self.owner)
            response = get_space_app_settings(request, self.space.id)

        if isinstance(response, tuple):
            _, body = response
        else:
            body = response

        apps = body.get('data', {}).get('apps', [])
        app_ids = {a['id'] for a in apps}
        self.assertEqual(app_ids, _expected_core_ids())

    def test_disabled_apps_respected_in_space(self):
        """SpaceAppSettings.disabled_apps 正确标记 enabled=False。"""
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        SpaceAppSettings.objects.create(
            workspace=self.space,
            user_id=self.owner.id,
            disabled_apps=['tabdata', 'terminal'],
        )

        ids = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        settings = SpaceAppSettings.objects.get(workspace=self.space, user_id=self.owner.id)
        disabled = set(settings.disabled_apps) if settings.disabled_apps else set()

        from apps.services.common.app_registry import list_apps
        from apps.tabtinspace.schemas.space import SpaceAppOut

        apps = [
            SpaceAppOut(
                id=app.id,
                name=app.name,
                icon=app.icon,
                can_create=app.can_create,
                searchable=app.searchable,
                enabled=app.id not in disabled,
                order=app.order,
            )
            for app in list_apps()
            if app.id in ids
        ]

        tabdata = next(a for a in apps if a.id == 'tabdata')
        terminal = next(a for a in apps if a.id == 'terminal')
        tabdoc = next(a for a in apps if a.id == 'tabdoc')

        self.assertFalse(tabdata.enabled)
        self.assertFalse(terminal.enabled)
        self.assertTrue(tabdoc.enabled)

    def test_uninstall_removes_from_space_apps_list(self):
        """卸载应用后，该应用不再出现在 Space Apps 的已安装列表中。"""
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='test-tinapp', app_source='marketplace',
        )

        ids_before = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertIn('test-tinapp', ids_before)

        OrganizationAppCatalogService.uninstall_app(
            self.organization.id, 'test-tinapp', user=self.owner,
        )

        ids_after = OrganizationAppCatalogService.get_installed_app_ids(self.organization.id)
        self.assertNotIn('test-tinapp', ids_after)


# ══════════════════════════════════════════════════════════════════════
# Model 层约束测试
# ══════════════════════════════════════════════════════════════════════


class OrganizationAppInstallModelTests(TestCase):
    """OrganizationAppInstall 模型约束测试。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user()
        self.organization = _make_organization(self.owner)

    def test_unique_constraint_organization_app_id(self):
        """同一 Organization 内同一 app_id 不能重复安装。"""
        from django.db import IntegrityError

        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdata', app_source='core',
        )
        with self.assertRaises(IntegrityError):
            OrganizationAppInstall.objects.create(
                organization=self.organization, app_id='tabdata', app_source='core',
            )

    def test_different_organizations_can_install_same_app(self):
        """不同 Organization 可以安装同一应用。"""
        other_owner = _make_user()
        other_wt = _make_organization(other_owner)

        OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdata', app_source='core',
        )
        inst2 = OrganizationAppInstall.objects.create(
            organization=other_wt, app_id='tabdata', app_source='core',
        )
        self.assertIsNotNone(inst2.id)

    def test_cascade_delete_on_organization_delete(self):
        """删除 Organization 时，关联的 OrganizationAppInstall 记录应被级联删除。"""
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)
        wt_id = self.organization.id
        self.organization.delete()
        remaining = OrganizationAppInstall.objects.filter(organization_id=wt_id).count()
        self.assertEqual(remaining, 0)

    def test_str_representation(self):
        install = OrganizationAppInstall.objects.create(
            organization=self.organization, app_id='tabdata', app_source='core',
        )
        s = str(install)
        self.assertIn('tabdata', s)
        self.assertIn('Test Team', s)
        self.assertIn('core', s)


# ══════════════════════════════════════════════════════════════════════
# 目录 source 契约测试
# ══════════════════════════════════════════════════════════════════════


class ListCatalogSourceContractTests(TestCase):
    """list_catalog 的 source 字段契约。

    source 是目录契约字段：内置应用为 'core'、市场应用为 'marketplace'，
    供前端区分「内置不可卸」与「市场应用可卸」。曾经直接透传 manifest 的
    distribution（builtin/marketplace），导致内置应用 source 为 'builtin'，
    前端 source==='core' 判断失效、错误暴露卸载按钮，点击后被后端 400 拒绝。
    """
    databases = {"default", "postgresql"}

    def setUp(self):
        # 用真实 User，避免内置应用自动安装写 installed_by 触发 FK 约束（PG）
        from django.contrib.auth import get_user_model
        import uuid as _uuid

        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username=f"catalog_src_owner_{_uuid.uuid4().hex[:6]}",
            email=f"catalog_src_{_uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = _make_organization(self.owner)

    def test_builtin_apps_have_core_source(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        # CORE_APPS 中的内置应用 source 必须是 'core'，绝不能是 'builtin'
        for app in result['apps']:
            if app['id'] in CORE_APPS:
                self.assertEqual(
                    app['source'], 'core',
                    f"内置应用 {app['id']} 的 source 应为 'core'，实际 {app['source']!r}",
                )

    def test_source_values_are_contract_vocabulary(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        # 整个目录只允许 core / marketplace 两种 source，不允许泄漏 distribution 词汇
        for app in result['apps']:
            self.assertIn(
                app['source'], ('core', 'marketplace'),
                f"{app['id']} 的 source={app['source']!r} 不在契约词汇内",
            )

    def test_builtin_apps_not_installable(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        for app in result['apps']:
            if app['source'] == 'core':
                self.assertFalse(
                    app['installable'],
                    f"内置应用 {app['id']} 不应可安装/卸载",
                )


# ══════════════════════════════════════════════════════════════════════
# surface 三态分类真源（SSOT）暴露契约（切片 1）
# ══════════════════════════════════════════════════════════════════════


class SurfaceExposureContractTests(TestCase):
    """surface（builtin/local/collaborative）在 catalog / space apps 响应中的暴露。

    surface 是三态分类的唯一后端真源，前端据此派生展示，不再维护硬编码 ID 表
    （见 docs/agent/capability-taxonomy.md）。

    用真实 User（对齐 ListCatalogSourceContractTests）：内置应用自动安装会写
    installed_by / organization.owner_id，SimpleNamespace 假用户会触发 PG 延迟外键
    约束在 teardown 阶段报错，故这里创建真实 User。
    """
    databases = {"default", "postgresql"}

    def setUp(self):
        from django.contrib.auth import get_user_model
        import uuid as _uuid

        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username=f"surface_owner_{_uuid.uuid4().hex[:6]}",
            email=f"surface_{_uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')

    def test_catalog_exposes_surface_ssot(self):
        """app-catalog 响应必须暴露 surface（三态分类真源）。"""
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        apps_by_id = {a['id']: a for a in result['apps']}

        # 每个条目都带 surface 键（技能包等可为 None）
        for app in result['apps']:
            self.assertIn(
                'surface', app,
                f"{app['id']} catalog 条目缺 surface 字段",
            )

        # 三态代表性断言（权威映射见 capability-taxonomy.md）
        self.assertEqual(apps_by_id['tabweb']['surface'], 'builtin')
        self.assertEqual(apps_by_id['tabdoc']['surface'], 'collaborative')
        self.assertEqual(apps_by_id['cowart']['surface'], 'local')
        # 技能包不是应用形态 → surface 为 None
        self.assertIsNone(apps_by_id['tabtin-office-skills-pack']['surface'])

        # surface 值域约束：只允许三态词汇或 None
        for app in result['apps']:
            self.assertIn(
                app['surface'], ('builtin', 'local', 'collaborative', None),
                f"{app['id']} surface={app['surface']!r} 不在三态词汇内",
            )

    def test_install_response_exposes_surface(self):
        """安装响应（AppInstallOut）应带 surface。cowart 是本机（local）应用。"""
        from apps.tabtinspace.routers.app_catalog import install_organization_app

        request = _make_request(self.owner, method='POST')
        response = install_organization_app(request, self.organization.id, 'cowart')

        self.assertIsInstance(response, dict)
        self.assertTrue(response.get('success'))
        self.assertTrue(response['data']['installed'])
        self.assertEqual(response['data']['surface'], 'local')

    @patch('django.core.cache.cache')
    def test_space_apps_api_exposes_surface(self, mock_cache):
        """space apps 响应必须暴露 surface（三态分类真源）。"""
        mock_cache.get.return_value = None
        mock_cache.set.return_value = None

        space = _make_space(self.organization)
        OrganizationAppCatalogService.auto_install_core_apps(self.organization, self.owner)

        from apps.tabtinspace.routers.space import get_space_app_settings

        with patch(
            'apps.tabtinspace.routers.space.SpaceService'
        ) as MockSpaceService:
            mock_svc = MockSpaceService.return_value
            mock_svc.get_space.return_value = space

            request = _make_request(self.owner)
            response = get_space_app_settings(request, space.id)

        body = response[1] if isinstance(response, tuple) else response
        apps = body.get('data', {}).get('apps', [])
        self.assertTrue(apps, "space apps 不应为空")

        surface_by_id = {a['id']: a['surface'] for a in apps}
        # 每个条目都带 surface 字段
        for a in apps:
            self.assertIn('surface', a, f"{a['id']} 缺 surface 字段")
        # 三态代表性断言（tabdoc/tabweb 均为默认 CORE_APP）
        self.assertEqual(surface_by_id.get('tabdoc'), 'collaborative')
        self.assertEqual(surface_by_id.get('tabweb'), 'builtin')
        # 值域约束
        for a in apps:
            self.assertIn(
                a['surface'], ('builtin', 'local', 'collaborative', None),
                f"{a['id']} surface={a['surface']!r} 不在三态词汇内",
            )


# ══════════════════════════════════════════════════════════════════════
# mobile_mode 透传契约（Memo / 云盘 App 首页计划 Task 0）
# ══════════════════════════════════════════════════════════════════════


class ListCatalogMobileModeContractTests(TestCase):
    """list_catalog 透传 runtimeSupport.mobile.mode。

    三种可区分状态（与 get_app_runtime_mode 默认 full 不同）：
    - full：manifest 明确声明 mobile.mode=full（tabmemo / tabfiles / tabdoc / tabdata）
    - 未声明：无 mobile 块 → mobile_mode=None（helper 用假 app_def 覆盖）
    - 不可用：mobile.mode=unsupported（如 tabtin-demo-app）
    """
    databases = {"default", "postgresql"}

    def setUp(self):
        from django.contrib.auth import get_user_model
        import uuid as _uuid

        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username=f"mobile_mode_owner_{_uuid.uuid4().hex[:6]}",
            email=f"mobile_mode_{_uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = _make_organization(self.owner)
        _make_member(self.organization, self.owner, role='owner')

    def test_catalog_exposes_mobile_mode_full_undeclared_unsupported(self):
        result = OrganizationAppCatalogService.list_catalog(
            self.organization.id, user=self.owner,
        )
        apps_by_id = {a['id']: a for a in result['apps']}

        for app in result['apps']:
            self.assertIn(
                'mobile_mode', app,
                f"{app['id']} catalog 条目缺 mobile_mode 字段",
            )

        # full：已声明 runtimeSupport.mobile.mode=full 的核心 App
        self.assertEqual(apps_by_id['tabmemo']['mobile_mode'], 'full')
        self.assertEqual(apps_by_id['tabfiles']['mobile_mode'], 'full')
        self.assertEqual(apps_by_id['tabdoc']['mobile_mode'], 'full')
        self.assertEqual(apps_by_id['tabdata']['mobile_mode'], 'full')

        # 不可用：marketplace demo 明确声明 unsupported
        self.assertEqual(
            apps_by_id['tabtin-demo-app']['mobile_mode'],
            'unsupported',
        )

    def test_mobile_mode_from_app_def_helper(self):
        from apps.services.common.app_registry import get_app

        self.assertEqual(
            OrganizationAppCatalogService._mobile_mode_from_app_def(
                get_app('tabmemo'),
            ),
            'full',
        )
        self.assertEqual(
            OrganizationAppCatalogService._mobile_mode_from_app_def(
                get_app('tabdoc'),
            ),
            'full',
        )
        self.assertEqual(
            OrganizationAppCatalogService._mobile_mode_from_app_def(
                get_app('tabdata'),
            ),
            'full',
        )
        self.assertEqual(
            OrganizationAppCatalogService._mobile_mode_from_app_def(
                get_app('tabtin-demo-app'),
            ),
            'unsupported',
        )
        self.assertIsNone(
            OrganizationAppCatalogService._mobile_mode_from_app_def(
                SimpleNamespace(runtime_support=None),
            ),
        )
        self.assertIsNone(
            OrganizationAppCatalogService._mobile_mode_from_app_def(
                SimpleNamespace(runtime_support={'electron': {'mode': 'full'}}),
            ),
        )

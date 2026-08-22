"""
Organization 应用目录服务

管理 Organization 级别的应用目录：
- CORE_APPS（builtin）：自动安装，不可卸载
- MARKETPLACE_APPS（含 organization 级和 device 级）：管理员手动安装/卸载

所有 marketplace app 的安装状态均由后端 OrganizationAppInstall 统一记录。
device 级 app 安装时同时在后端落记录，本地另行下载二进制。
"""
from __future__ import annotations

import logging
from collections import Counter
from typing import Optional
from uuid import UUID

from django.core.cache import cache
from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias

from apps.services.common.app_registry import CORE_APPS, MARKETPLACE_APPS, get_app, list_apps
from apps.tabtinspace.models import (
    SpaceAppSettings,
    Organization,
    OrganizationAppInstall,
    OrganizationMember,
    Workspace,
)

logger = logging.getLogger(__name__)

_CACHE_KEY_INSTALLED_IDS = "organization_installed_ids:{organization_id}"
_CACHE_KEY_CATALOG = "organization_app_catalog:{organization_id}"
_CACHE_TTL_INSTALLED_IDS = 120
_CACHE_TTL_CATALOG = 300
_CORE_APP_IDS = frozenset(CORE_APPS.keys())
_DEFAULT_CORE_APP_IDS = frozenset(
    app_id for app_id, app_def in CORE_APPS.items()
    if getattr(app_def, 'is_default_enabled', True)
)


class OrganizationAppCatalogService:
    """Organization 应用目录服务"""

    CATEGORY_NAMES: dict[str, str] = {
        'all': '全部',
        'data': '数据',
        'creation': '创作',
        'development': '开发',
        'intelligence': '智能',
        'tools': '工具',
    }

    # ── 查询 ──────────────────────────────────────────────────────

    @classmethod
    def get_installed_app_ids(cls, organization_id) -> set[str]:
        """返回 Organization 已安装的 app_id 集合（Redis 缓存 120s）。

        兼容补偿：旧 Organization 可能创建于新增 CORE_APPS 之前，若发现缺失的
        core app 记录，会在读取时自动补齐并刷新缓存。

        降级策略：缓存和数据库都不可用时返回默认启用 CORE_APPS id，
        确保 Space Apps API 不因此中断。
        """
        wt_str = str(organization_id)
        cache_key = _CACHE_KEY_INSTALLED_IDS.format(organization_id=wt_str)

        try:
            cached = cache.get(cache_key)
            if cached is not None:
                ids, changed = cls._sync_core_app_installs(organization_id, set(cached))
                if changed:
                    cls._cache_installed_ids(cache_key, ids, wt_str)
                return ids
        except Exception:
            logger.warning("Redis 缓存读取失败，回退 DB 查询: organization=%s", wt_str)

        try:
            ids = set(
                OrganizationAppInstall.objects.filter(organization_id=organization_id)
                .values_list('app_id', flat=True)
            )
            ids, _ = cls._sync_core_app_installs(organization_id, ids)
            cls._cache_installed_ids(cache_key, ids, wt_str)
            return ids
        except Exception:
            logger.exception("查询已安装应用失败，降级返回默认 CORE_APPS: organization=%s", wt_str)
            return set(_DEFAULT_CORE_APP_IDS)

    CATEGORY_NAMES_EXTENDED: dict[str, str] = {
        **CATEGORY_NAMES,
        'integration': '集成',
    }

    @staticmethod
    def _get_user_id(user) -> str | None:
        user_id = getattr(user, 'id', None)
        if user_id in (None, ''):
            return None
        return str(user_id)

    @staticmethod
    def _build_install_metadata(app_def) -> dict:
        """Snapshot install-time marketplace provenance for audit and replay."""
        metadata: dict = {
            'version': getattr(app_def, 'version', '') or None,
            'distribution': getattr(app_def, 'distribution', ''),
            'install_scope': getattr(app_def, 'install_scope', ''),
        }
        official_release = getattr(app_def, 'official_plugin_release', None)
        if isinstance(official_release, dict):
            metadata['official_plugin_release'] = official_release
        prepared_runtime = getattr(app_def, 'prepared_runtime', None)
        if isinstance(prepared_runtime, dict):
            metadata['prepared_runtime'] = prepared_runtime
        return {key: value for key, value in metadata.items() if value not in (None, '', {})}


    @staticmethod
    def _mobile_mode_from_app_def(app_def) -> str | None:
        """透传 manifest runtimeSupport.mobile.mode；未声明返回 None。

        与 get_app_runtime_mode 不同：后者对未声明默认 full（electron/daemon 过滤用），
        catalog 的 mobile_mode 需区分 full / 未声明 / 明确不可用，供移动端门禁消费。
        """
        runtime_support = getattr(app_def, 'runtime_support', None)
        if not isinstance(runtime_support, dict):
            return None
        mobile = runtime_support.get('mobile')
        if not isinstance(mobile, dict):
            return None
        mode = mobile.get('mode')
        if not isinstance(mode, str) or not mode:
            return None
        return mode

    @classmethod
    def _get_tinapp_or_raise(cls, app_id: str):
        """兼容旧测试/旧调用名，实际解析当前 marketplace manifest。"""
        from apps.tabtinspace.services.base import ServiceError

        app_def = get_app(app_id)
        if not app_def:
            raise ServiceError('APP_NOT_FOUND', f'应用 {app_id} 不存在', 404)
        if app_def.distribution != 'marketplace':
            raise ServiceError(
                'INVALID_OPERATION',
                f'应用 {app_id} 是内置应用，无需手动安装。',
                400,
            )
        return app_def

    @classmethod
    def list_catalog(cls, organization_id, *, user) -> dict:
        """列出完整应用目录（CORE_APPS + MARKETPLACE_APPS + 安装状态）。

        返回 dict 格式与 AppCatalogOut schema 对齐：
        { "apps": [...], "categories": [...], "can_manage": bool }

        所有 marketplace app（含 installScope=device）的安装状态均由后端 OrganizationAppInstall 统一记录。
        device 级 app 安装时同时在后端落记录，本地另行下载二进制。
        """
        installed_ids = cls.get_installed_app_ids(organization_id)
        can_manage = cls._is_organization_admin(organization_id, user)

        apps: list[dict] = []

        for app_def in list_apps():
            is_marketplace = app_def.distribution == 'marketplace'
            is_device_scope = app_def.install_scope == 'device'

            apps.append({
                'id': app_def.id,
                'name': app_def.name,
                'icon': app_def.icon,
                'icon_asset': app_def.icon_asset,
                'description': app_def.description,
                'detail_description': app_def.description,
                'screenshots': [],
                'category': app_def.category,
                # source 是目录契约字段（core / marketplace），不是 manifest 的
                # distribution（builtin / marketplace）。前端据此区分「内置不可卸」
                # 与「市场应用可卸」。直接透传 distribution 会让内置应用的 source
                # 变成 'builtin'，使前端 source==='core' 判断失效、错误暴露卸载按钮，
                # 点击后必被后端以「内置应用不可卸载」400 拒绝。
                'source': 'marketplace' if is_marketplace else 'core',
                'install_scope': app_def.install_scope,
                # surface 是三态分类真源（SSOT），与 source/distribution 正交：
                # source 讲"可否卸载"，surface 讲"是内置/本机/协作哪一态"。
                'surface': app_def.surface,
                'installed': app_def.id in installed_ids,
                'is_default_enabled': app_def.is_default_enabled,
                'order': app_def.order,
                'version': app_def.version or None,
                'installable': is_marketplace,
                'official_plugin_release': app_def.official_plugin_release,
                'prepared_runtime': app_def.prepared_runtime,
                # 向后兼容：旧客户端忽略；移动端按 full / null / unsupported 门禁
                'mobile_mode': cls._mobile_mode_from_app_def(app_def),
            })

        all_category_names = cls.CATEGORY_NAMES_EXTENDED
        category_counter: Counter[str] = Counter()
        for app in apps:
            cat = app.get('category') or 'tools'
            if cat in all_category_names and cat != 'all':
                category_counter[cat] += 1

        categories = [{'id': 'all', 'name': all_category_names['all'], 'count': len(apps)}]
        for cat_id in ('data', 'creation', 'development', 'intelligence', 'tools', 'integration'):
            count = category_counter.get(cat_id, 0)
            if count > 0:
                categories.append({
                    'id': cat_id,
                    'name': all_category_names.get(cat_id, cat_id),
                    'count': count,
                })

        return {
            'apps': apps,
            'categories': categories,
            'can_manage': can_manage,
        }

    # ── 安装/卸载（marketplace app，含 device 级）──────

    @classmethod
    @transaction.atomic(using=postgres_app_db_alias())
    def install_app(cls, organization_id, app_id: str, *, user) -> OrganizationAppInstall:
        """安装市场应用到 Organization。

        支持所有 marketplace app（含 installScope=device）。
        幂等：已安装时返回现有记录。
        并发安全：捕获唯一约束冲突后查询已有记录。
        """
        from apps.tabtinspace.services.base import ServiceError

        app_def = cls._get_tinapp_or_raise(app_id)

        if not cls._is_organization_admin(organization_id, user):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可安装应用', 403)

        install, _ = OrganizationAppInstall.objects.update_or_create(
            organization_id=organization_id,
            app_id=app_id,
            defaults={
                'app_source': 'marketplace',
                'installed_by_id': cls._get_user_id(user),
                'install_metadata': cls._build_install_metadata(app_def),
            },
        )

        cls._invalidate_cache(organization_id)
        logger.info(
            "Marketplace app installed: organization=%s app=%s scope=%s by=%s",
            organization_id, app_id, app_def.install_scope, cls._get_user_id(user),
        )
        # ：新装 App 的 skill 挂到组织内活跃默认 Agent。
        from apps.skills.services.default_agent_skill_seed import (
            attach_app_skills_to_org_default_agents,
            run_default_agent_skill_seed_safe,
        )
        run_default_agent_skill_seed_safe(
            lambda: attach_app_skills_to_org_default_agents(
                organization_id=organization_id,
                app_id=app_id,
                user=user,
            ),
            event="default_agent_skill_seed.install_app",
            organization=organization_id,
            app=app_id,
        )
        return install

    @classmethod
    @transaction.atomic(using=postgres_app_db_alias())
    def uninstall_app(cls, organization_id, app_id: str, *, user) -> dict:
        """从 Organization 卸载市场应用。

        仅支持 marketplace app，core app 不可卸载。
        """
        from apps.tabtinspace.services.base import ServiceError

        app_def = get_app(app_id)
        if app_def and app_def.distribution != 'marketplace':
            raise ServiceError(
                'INVALID_OPERATION',
                f'应用 {app_id} 是内置应用，不可卸载。',
                400,
            )

        if not cls._is_organization_admin(organization_id, user):
            raise ServiceError('PERMISSION_DENIED', '仅组织所有者可卸载应用', 403)

        deleted_count, _ = OrganizationAppInstall.objects.filter(
            organization_id=organization_id, app_id=app_id,
        ).delete()

        affected_spaces = 0
        if deleted_count > 0:
            affected_spaces = cls._cascade_disable_app_in_spaces(organization_id, app_id)

        cls._invalidate_cache(organization_id)
        logger.info(
            "Marketplace app uninstalled: organization=%s app=%s by=%s deleted=%d",
            organization_id, app_id, cls._get_user_id(user), deleted_count,
        )
        return {
            'app_id': app_id,
            'installed': False,
            'affected_spaces': affected_spaces,
        }

    # ── 初始化 ────────────────────────────────────────────────────

    @classmethod
    def auto_install_core_apps(cls, organization: Organization, user) -> int:
        """为新 Organization 批量安装默认启用的 CORE_APPS。

        在 provision_organization_defaults 同一事务内调用。
        返回实际创建的记录数。
        """
        installs = [
            OrganizationAppInstall(
                organization=organization,
                app_id=app_id,
                app_source='core',
                installed_by_id=cls._get_user_id(user),
            )
            for app_id in _DEFAULT_CORE_APP_IDS
        ]
        created = OrganizationAppInstall.objects.bulk_create(
            installs, ignore_conflicts=True,
        )
        count = len(created)
        if count > 0:
            cls._invalidate_cache(organization.id)
        logger.info(
            "CORE_APPS 自动安装完成: organization=%s count=%d", organization.id, count,
        )
        return count

    # ── 内部方法 ──────────────────────────────────────────────────

    @classmethod
    def _cache_installed_ids(cls, cache_key: str, ids: set[str], wt_str: str) -> None:
        try:
            cache.set(cache_key, list(ids), timeout=_CACHE_TTL_INSTALLED_IDS)
        except Exception:
            logger.warning("Redis 缓存写入失败（非阻断）: organization=%s", wt_str)

    @classmethod
    @transaction.atomic(using=postgres_app_db_alias())
    def _sync_core_app_installs(
        cls,
        organization_id,
        installed_ids: set[str],
    ) -> tuple[set[str], bool]:
        disabled_core_ids = installed_ids & (_CORE_APP_IDS - _DEFAULT_CORE_APP_IDS)
        missing_core_ids = _DEFAULT_CORE_APP_IDS - installed_ids
        if not missing_core_ids and not disabled_core_ids:
            return installed_ids, False

        try:
            organization = Organization.objects.only('id', 'owner_id').get(id=organization_id)
        except Organization.DoesNotExist:
            logger.warning(
                "CORE_APPS 自动同步跳过：organization 不存在 organization=%s",
                organization_id,
            )
            return installed_ids, False

        deleted_count = 0
        if disabled_core_ids:
            deleted_count, _ = OrganizationAppInstall.objects.filter(
                organization=organization,
                app_id__in=disabled_core_ids,
                app_source='core',
            ).delete()

        installs = [
            OrganizationAppInstall(
                organization=organization,
                app_id=app_id,
                app_source='core',
                installed_by_id=organization.owner_id,
            )
            for app_id in sorted(missing_core_ids)
        ]
        created = OrganizationAppInstall.objects.bulk_create(
            installs,
            ignore_conflicts=True,
        )
        repaired_ids = (installed_ids - disabled_core_ids) | missing_core_ids

        cls._invalidate_cache(organization.id)
        space_ids = list(
            Workspace.objects.filter(organization_id=organization_id).values_list('id', flat=True)
        )
        if space_ids:
            cls._invalidate_space_caches(space_ids)

        logger.info(
            "CORE_APPS 自动同步完成: organization=%s missing=%s disabled=%s created=%d deleted=%d",
            organization.id,
            sorted(missing_core_ids),
            sorted(disabled_core_ids),
            len(created),
            deleted_count,
        )
        return repaired_ids, True

    @classmethod
    def _is_organization_admin(cls, organization_id, user) -> bool:
        """判断用户是否为 Organization 的 owner。两级模型（2026-06-10）：应用管理 owner-only。"""
        if not user:
            return False
        user_id = cls._get_user_id(user)
        if not user_id:
            return False
        try:
            organization = Organization.objects.get(id=organization_id)
            if str(organization.owner_id) == user_id:
                return True
        except Organization.DoesNotExist:
            return False
        try:
            member = OrganizationMember.objects.get(
                organization_id=organization_id, user_id=user_id,
            )
            return member.role == 'owner'
        except OrganizationMember.DoesNotExist:
            return False


    @classmethod
    def _cascade_disable_app_in_spaces(cls, organization_id, app_id: str) -> int:
        """将 app_id 加入 Organization 下所有 Space 的 SpaceAppSettings.disabled_apps。

        使用 select_for_update() + Python 层 append + save，保证并发安全。
        order_by('id') 固定加锁顺序防止死锁。
        部分 Space 更新失败时记录日志，不阻断卸载操作。
        返回受影响的 distinct Space 数量。
        """
        space_ids = list(
            Workspace.objects.filter(organization_id=organization_id)
            .values_list('id', flat=True)
        )
        if not space_ids:
            return 0

        affected_space_ids: set = set()
        settings_qs = (
            SpaceAppSettings.objects
            .filter(workspace_id__in=space_ids)
            .order_by('id')
            .select_for_update()
        )
        for settings in settings_qs:
            try:
                disabled = settings.disabled_apps or []
                if not isinstance(disabled, list):
                    disabled = []
                if app_id not in disabled:
                    disabled.append(app_id)
                    settings.disabled_apps = disabled
                    settings.save(update_fields=['disabled_apps', 'updated_at'])
                    affected_space_ids.add(settings.workspace_id)
            except Exception:
                logger.warning(
                    "级联禁用 app 失败: space_settings=%s app=%s",
                    settings.id, app_id, exc_info=True,
                )

        # 清除 Space 级缓存
        cls._invalidate_space_caches(space_ids)
        return len(affected_space_ids)

    @classmethod
    def _invalidate_cache(cls, organization_id) -> None:
        """清除 Organization 相关的 Redis 缓存。"""
        wt_str = str(organization_id)
        keys = [
            _CACHE_KEY_INSTALLED_IDS.format(organization_id=wt_str),
            _CACHE_KEY_CATALOG.format(organization_id=wt_str),
        ]
        try:
            cache.delete_many(keys)
        except Exception:
            logger.warning("缓存清除失败（非阻断）: keys=%s", keys)

    @classmethod
    def _invalidate_space_caches(cls, space_ids: list) -> None:
        """清除受影响 Workspace 的 app settings 缓存。"""
        for space_id in space_ids:
            try:
                delete_pattern = getattr(cache, 'delete_pattern', None)
                if not callable(delete_pattern):
                    continue
                delete_pattern(f"workspace_app_settings:{space_id}:*")
                # 兼容切换窗口期仍可能存在的旧键
                delete_pattern(f"space_app_settings:{space_id}:*")
            except Exception:
                logger.warning(
                    "Workspace app settings 缓存清除失败（非阻断）: workspace_id=%s",
                    space_id,
                    exc_info=True,
                )

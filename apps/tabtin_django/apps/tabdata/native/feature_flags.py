"""
原生列存储迁移阶段控制

Phase 3D 后，原生列是唯一数据路径。此模块保留用于：
1. backfill_service.py / consistency_checker.py 等工具类的阶段查询
2. 紧急回滚场景（将 NATIVE_STORAGE_PHASE 改回 'switch_read'）

正常运行时 NATIVE_STORAGE_PHASE = 'native_only'（默认值）。
"""

from uuid import UUID

from django.conf import settings

from apps.tabdata.constants import TABDATA_DB_ALIAS


class NativeStoragePhase:
    """迁移阶段常量与查询方法

    Phase 3D 后默认 native_only，record_service / view_data_service / table_service
    不再使用此类做条件判断（原生路径已成为无条件默认）。
    """

    DISABLED = 'disabled'
    DUAL_WRITE = 'dual_write'
    SWITCH_READ = 'switch_read'
    NATIVE_ONLY = 'native_only'

    _VALID_PHASES = frozenset({DISABLED, DUAL_WRITE, SWITCH_READ, NATIVE_ONLY})

    @classmethod
    def current(cls) -> str:
        """获取当前迁移阶段（默认 native_only）"""
        phase = getattr(settings, 'NATIVE_STORAGE_PHASE', cls.NATIVE_ONLY)
        if phase not in cls._VALID_PHASES:
            return cls.NATIVE_ONLY
        return phase

    @classmethod
    def is_native_write_enabled(cls) -> bool:
        """是否启用原生列写入（dual_write / switch_read / native_only）"""
        return cls.current() in (cls.DUAL_WRITE, cls.SWITCH_READ, cls.NATIVE_ONLY)

    @classmethod
    def is_native_read_enabled(cls) -> bool:
        """是否启用原生列读取（switch_read / native_only）"""
        return cls.current() in (cls.SWITCH_READ, cls.NATIVE_ONLY)

    @classmethod
    def is_json_write_enabled(cls) -> bool:
        """是否继续写 JSONField（disabled / dual_write / switch_read）"""
        return cls.current() in (cls.DISABLED, cls.DUAL_WRITE, cls.SWITCH_READ)

    @classmethod
    def is_json_read_enabled(cls) -> bool:
        """是否从 JSONField 读取（disabled / dual_write）"""
        return cls.current() in (cls.DISABLED, cls.DUAL_WRITE)

    @classmethod
    def is_table_migrated(cls, table_id: UUID) -> bool:
        """检查指定表是否已完成原生表创建。"""
        try:
            from apps.tabdata.models import NativeTableStatus
            return NativeTableStatus.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                native_table_created=True,
            ).exists()
        except Exception:
            return False

    @classmethod
    def is_table_backfill_completed(cls, table_id: UUID) -> bool:
        """检查指定表是否已完成数据回填"""
        try:
            from apps.tabdata.models import NativeTableStatus
            return NativeTableStatus.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                backfill_completed=True,
            ).exists()
        except Exception:
            return False

    @classmethod
    def should_read_native(cls, table_id: UUID) -> bool:
        """
        综合判断：是否应从原生列读取此表数据。

        Phase 3D 后 record_service / view_data_service 不再调用此方法
        （原生路径已成为无条件默认），保留供工具类使用。
        """
        if not cls.is_native_read_enabled():
            return False
        return cls.is_table_migrated(table_id) and cls.is_table_backfill_completed(table_id)

    @classmethod
    def should_write_native(cls, table_id: UUID) -> bool:
        """
        综合判断：是否应同时写入原生列。

        Phase 3D 后 record_service / table_service 不再调用此方法
        （原生路径已成为无条件默认），保留供工具类使用。
        """
        if not cls.is_native_write_enabled():
            return False
        return cls.is_table_migrated(table_id)

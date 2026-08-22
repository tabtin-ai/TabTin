"""
TabData Django 应用配置
"""

from django.apps import AppConfig


class TabdataConfig(AppConfig):
    """TabData 应用配置"""

    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.tabdata'
    label = 'tabdata'
    verbose_name = 'TabData'

    def ready(self):
        """应用启动时执行"""
        import apps.tabdata.signals  # noqa
        import apps.tabdata.history_event_listeners  # noqa

        try:
            from apps.collab.adapters.table import TableCollabAdapter
            from apps.collab.registry import register_adapter

            register_adapter(TableCollabAdapter())
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Failed to register TableCollabAdapter", exc_info=True
            )

        # TD-2 / TD-3 / Wave 1.1：把 tabdata 的 Resource / Impact contributor 注册
        # 到 collab 注册中心，给 Checkpoint 创建钩子（daemon_checkpoint_service）
        # 与 build_checkpoint_impact 提供数据源（Charter §3.2 / §3.3）。
        # 注册放在 adapter 之后——失败仅打 warning 不阻断 app 启动，与 W0-1
        # 注册中心的 fail-safe 设计配合（contributors.py docstring §4）。
        try:
            from apps.collab.services.contributors import (
                register_resource_contributor,
                register_impact_contributor,
            )
            from apps.tabdata.contributors import (
                TableResourceContributor,
                TableImpactContributor,
            )

            register_resource_contributor(TableResourceContributor())
            register_impact_contributor(TableImpactContributor())
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Failed to register tabdata contributors (Resource / Impact)",
                exc_info=True,
            )

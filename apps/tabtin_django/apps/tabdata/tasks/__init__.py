"""TabData Celery 异步任务模块聚合"""

# 任务模块说明：
# - import_export_tasks.py: 数据导入/导出异步任务
# - conversion_tasks.py: 字段类型转换异步任务
# - collab_changelog_tasks.py: bulk_update on_commit 异步化（W3.0 / D27）

from .collab_changelog_tasks import async_collab_changelog_after_records  # noqa: F401
from .conversion_tasks import convert_field_type_task  # noqa: F401
from .import_export_tasks import async_import_data, async_export_data  # noqa: F401
from .saga_tasks import (  # noqa: F401
    saga_cleanup_task,
    saga_mark_collab_task,
    saga_pause_outbox_task,
    saga_reconcile_task,
    saga_restore_data_task,
)

# ── beat schedule re-export(让 celery.py 自动扫描发现)──
# celery.py:_discover_beat_schedules_auto 用 dir(module) 找
# *_BEAT_SCHEDULE 字典,只扫到 apps.tabdata.tasks 命名空间(不深入子模块)。
from .saga_tasks import SAGA_RECONCILE_BEAT_SCHEDULE  # noqa: F401
from .field_recycle_cleanup import (  # noqa: F401
    cleanup_expired_deleted_fields,
    FIELD_RECYCLE_CLEANUP_BEAT_SCHEDULE,
)

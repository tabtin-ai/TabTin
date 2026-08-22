"""
统一版本历史工具库

提供可复用的 Model Mixin 和 Service 基类，供 TabDoc / TabSlide / TabData 使用。

使用方式:
    from apps.services.common.version_history import VersionHistoryMixin, HistoryServiceBase
"""

from .mixins import VersionHistoryMixin  # noqa: F401
from .service import HistoryServiceBase  # noqa: F401
from .schemas import serialize_history_item, serialize_history_list  # noqa: F401
from .constants import (  # noqa: F401
    HISTORY_TTL_FREE,
    HISTORY_TTL_PRO,
    HISTORY_TTL_TEAM,
    HISTORY_MIN_INTERVAL,
    HISTORY_SNAPSHOT_INTERVAL,
    HISTORY_SNAPSHOT_MAX_AGE,
    TTL_TIERS,
)

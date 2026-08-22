"""
平台能力清单服务 — 统一暴露设备 capability registry。
"""

import logging
from typing import List

logger = logging.getLogger(__name__)


def get_platform_capabilities() -> List[dict]:
    """返回平台能力清单（capabilities 列表）。"""
    try:
        from apps.services.common.device_capability_registry import (
            list_platform_capabilities,
        )

        return list_platform_capabilities()
    except Exception:
        logger.warning("[capability_service] 加载平台能力清单失败", exc_info=True)
        return []

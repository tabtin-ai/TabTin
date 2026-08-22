"""
Tabtin Space 授权规则加载服务（Hilt 重写：stub，旧逻辑已删）

Hilt W4：授权判决统一由 TS 侧 judge() 完成，Python 侧不再
resolve_authorization_rules。保留模块避免 import 爆炸。
"""

import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)


def load_authorization_rules_for_space(
    space_id: Optional[str],
) -> Dict[str, str]:
    """Stub — 返回空 dict，调用方已不消费。"""
    return {}


__all__ = ["load_authorization_rules_for_space"]

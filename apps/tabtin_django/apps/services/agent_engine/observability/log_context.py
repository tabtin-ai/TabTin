"""logging Filter — 将 ContextVar 中的 trace_id / run_id 注入每条 LogRecord。

在 Django settings.LOGGING 中注册即可：

    'filters': {
        'trace_context': {
            '()': 'apps.services.agent_engine.observability.log_context.TraceContextFilter',
        },
    },
    'handlers': {
        'agent_engine_file': {
            ...
            'filters': ['trace_context'],
        },
    },

日志 formatter 可通过 ``{trace_id}`` / ``{run_id}`` 引用。
"""

from __future__ import annotations

import logging
from typing import Optional


class TraceContextFilter(logging.Filter):
    """将编排层的 trace_id / run_id 从 ContextVar 注入 LogRecord。

    ContextVar 未设置时填入 ``"-"``，保证 formatter 不报错。
    仅在首次访问时 import trace 模块，避免 import 循环。
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = _get_trace_id() or "-"
        record.run_id = _get_run_id() or "-"
        return True


def _get_trace_id() -> Optional[str]:
    try:
        from apps.services.common.observability.trace import trace_id_var
        val = trace_id_var.get()
        return str(val) if val is not None else None
    except Exception:
        return None


def _get_run_id() -> Optional[str]:
    try:
        from apps.services.common.observability.trace import thread_id_var
        val = thread_id_var.get()
        return str(val) if val is not None else None
    except Exception:
        return None

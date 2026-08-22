"""将 FileHandler 异步化 — QueueHandler + QueueListener。

调用 ``patch_handlers_to_async()`` 后，所有已注册的 ``FileHandler``
会被替换为 ``QueueHandler``，日志写入改为后台线程，避免高 QPS
下磁盘 I/O 阻塞请求线程。

关闭时由 ``atexit`` 自动 stop 所有 QueueListener。
"""

from __future__ import annotations

import atexit
import logging
import logging.handlers
import os
import queue
import threading
from typing import List

_listeners: List[logging.handlers.QueueListener] = []
_patched = False
_patch_lock = threading.Lock()

_QUEUE_MAXSIZE = 10_000


def patch_handlers_to_async() -> int:
    """遍历所有 logger，将 FileHandler 替换为 QueueHandler。

    返回被替换的 handler 数量。跳过非 FileHandler 和 console handler。
    """
    global _patched
    if _patched:
        return 0

    with _patch_lock:
        if _patched:
            return 0

        if os.environ.get("LOG_ASYNC", "true").lower() in ("0", "false", "no"):
            _patched = True
            return 0

        replaced = 0
        seen_handlers: dict[int, logging.handlers.QueueHandler] = {}

        root = logging.root
        all_loggers = [root] + [
            logging.getLogger(name) for name in logging.root.manager.loggerDict
        ]

        for lgr in all_loggers:
            for idx, handler in enumerate(list(lgr.handlers)):
                if not isinstance(handler, logging.FileHandler):
                    continue

                hid = id(handler)
                if hid in seen_handlers:
                    lgr.handlers[idx] = seen_handlers[hid]
                    replaced += 1
                    continue

                log_queue: queue.Queue = queue.Queue(_QUEUE_MAXSIZE)
                queue_handler = logging.handlers.QueueHandler(log_queue)
                queue_handler.setLevel(handler.level)

                listener = logging.handlers.QueueListener(
                    log_queue, handler, respect_handler_level=True,
                )
                listener.start()
                _listeners.append(listener)

                seen_handlers[hid] = queue_handler
                lgr.handlers[idx] = queue_handler
                replaced += 1

        _patched = True
        atexit.register(_shutdown_listeners)
        return replaced


def _shutdown_listeners() -> None:
    for listener in _listeners:
        try:
            listener.stop()
        except Exception:
            pass

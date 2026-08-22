"""Django startup timing helper.

Import this module before ``django.setup()`` to record a baseline, then call
``log_startup_timing()`` after Django finishes initialization.
"""

import logging
import time

logger = logging.getLogger("tabtin.startup")

_start_time = time.perf_counter()


def log_startup_timing() -> None:
    """Log elapsed time from module import to this call."""
    elapsed_ms = int((time.perf_counter() - _start_time) * 1000)
    logger.info("Django startup completed in %dms", elapsed_ms)

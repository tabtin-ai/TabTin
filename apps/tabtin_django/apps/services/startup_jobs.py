"""Helpers for startup-only background jobs.

``AppConfig.ready()`` runs for every Django management command. Background
validation and sync jobs are useful in long-lived server processes, but they
should not run inside short-lived commands such as migrations where they can
race with schema work, spam the console, or keep the process alive on Windows.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


_SERVER_MANAGEMENT_COMMANDS = {"runserver"}


def should_skip_startup_background_jobs() -> bool:
    """Return True when ready() should not schedule background startup work."""
    if os.environ.get("TABTIN_DISABLE_STARTUP_BACKGROUND_JOBS") == "1":
        return True

    argv0 = Path(sys.argv[0]).name.lower()
    if argv0 not in {"manage.py", "manage"}:
        return False

    command = sys.argv[1] if len(sys.argv) > 1 else ""
    return command not in _SERVER_MANAGEMENT_COMMANDS


def configure_utf8_standard_streams() -> None:
    """Use UTF-8 console streams when the host shell defaults to GBK."""
    streams = [sys.stdout, sys.stderr]
    loggers = [logging.getLogger()]
    loggers.extend(
        logger
        for logger in logging.Logger.manager.loggerDict.values()
        if isinstance(logger, logging.Logger)
    )
    for logger in loggers:
        for handler in logger.handlers:
            stream = getattr(handler, "stream", None)
            if stream is not None:
                streams.append(stream)

    seen: set[int] = set()
    for stream in streams:
        if id(stream) in seen or not hasattr(stream, "reconfigure"):
            continue
        seen.add(id(stream))
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

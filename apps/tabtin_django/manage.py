#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys

from apps.services.startup_jobs import configure_utf8_standard_streams

configure_utf8_standard_streams()

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
import apps.services.startup_timing  # noqa: E402,F401  — 在 django.setup() 前设置 _start_time


def main():
    """Run administrative tasks."""
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc

    from apps.services.startup_timing import log_startup_timing
    log_startup_timing()

    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()

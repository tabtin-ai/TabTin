"""计费模块共享常量"""

from zoneinfo import ZoneInfo

from django.conf import settings

BILLING_TZ = ZoneInfo(settings.TIME_ZONE)

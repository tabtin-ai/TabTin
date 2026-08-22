"""
AdminDash 数据&内容模块测试专用 settings。

目标：
1. 复用 PostgreSQL 单库测试配置，避开 sqlite 对 PG 专有 SQL 的兼容问题。
2. 强制让 TabMail 的 MailEmbedding 使用 BinaryField fallback，避免 pgvector 扩展缺失阻塞 admin_api 测试。
"""

from __future__ import annotations

import sys

from .settings_lookup_e2e_test import *  # noqa: F401,F403

sys.modules["pgvector.django"] = None

_PGVECTOR_APPS = {"apps.capabilities"}
INSTALLED_APPS = [  # type: ignore[name-defined]
    app
    for app in INSTALLED_APPS  # type: ignore[name-defined]
    if app not in _PGVECTOR_APPS
    and not any(app.startswith(prefix + ".") for prefix in _PGVECTOR_APPS)
]

ROOT_URLCONF = "apps.tabdata.tests.empty_urls"

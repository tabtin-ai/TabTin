"""E2E 共享 fixture 与 helpers。

三视角 Review P0 修复:5 个 E2E 文件各自定义 _RealUser/_BenchUser 重复,
统一提取到此 conftest 模块。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import pytest
from django.core.cache import cache


@dataclass
class RealUser:
    """轻量 User stub,绕过权限检查;用真实 user.id 做 ORM 写入。

    与 ``apps.tabtinspace.tests.fixtures.create_test_user`` 创建的 User 实例不同,
    本 stub 不走 Django auth 体系,仅满足 ``BaseService`` 的 ``self.user.id`` /
    ``is_authenticated`` / ``is_active`` 三属性要求。
    """
    id: Any
    is_authenticated: bool = True
    is_active: bool = True


def is_prod_mode() -> bool:
    """判断当前环境是否启用 prod-mode 真表测试(D23 决策)。"""
    return os.environ.get("RUN_PROD_MODE_FIXTURE_TESTS") == "1"


@pytest.fixture(autouse=True)
def _clear_cache():
    """W3 E2E + W1 E2E 共享:清理 Django LocMemCache 避免跨测试污染。"""
    cache.clear()
    yield
    cache.clear()

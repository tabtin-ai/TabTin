"""E2E-W3-7: on_commit 异步化回归。

覆盖用户故事
============

bulk_update 500 行 → 验证 collab 异步执行

1. TABDATA_BULK_UPDATE_ASYNC_COLLAB flag 控制
2. pending counter 语义
3. wait_for_pending 归零返回 True
4. dispatch flag=True → Celery apply_async
5. dispatch flag=False → 同步 perform
6. flag settings 注册
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

import pytest
from django.core.cache import cache
from django.test import override_settings


# ── 1. flag 控制 ─────────────────────────────────────────────


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=True)
def test_async_changelog_enabled():
    from apps.tabdata.services.async_changelog import is_async_changelog_enabled
    assert is_async_changelog_enabled() is True


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=False)
def test_async_changelog_disabled():
    from apps.tabdata.services.async_changelog import is_async_changelog_enabled
    assert is_async_changelog_enabled() is False


# ── 2. pending counter ───────────────────────────────────────


def test_pending_counter_roundtrip():
    from apps.tabdata.services.async_changelog import (
        incr_pending_changelog,
        decr_pending_changelog,
        get_pending_count,
    )

    run_id = f'run_{uuid4().hex[:8]}'
    assert get_pending_count(run_id) == 0
    incr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 1
    decr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 0


# ── 3. wait 归零 ────────────────────────────────────────────


def test_wait_for_pending_zero_returns_true():
    from apps.tabdata.services.async_changelog import wait_for_pending_changelogs

    run_id = f'run_{uuid4().hex[:8]}'
    result = wait_for_pending_changelogs(run_id, timeout_ms=500)
    assert result is True


# ── 4. dispatch async → Celery ───────────────────────────────


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=True)
def test_dispatch_async_calls_celery():
    from apps.tabdata.services.async_changelog import dispatch_collab_changelog

    with patch(
        'apps.tabdata.tasks.collab_changelog_tasks.async_collab_changelog_after_records'
    ) as mock_task:
        mock_task.apply_async = MagicMock()
        dispatch_collab_changelog(
            table_id=str(uuid4()),
            change_type='update',
            record_ids=['r1', 'r2'],
            record_count=2,
            user_id=str(uuid4()),
            agent_run_id=f'run_{uuid4().hex[:8]}',
        )

    mock_task.apply_async.assert_called_once()


# ── 5. dispatch sync → perform ───────────────────────────────


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=False)
def test_dispatch_sync_calls_perform():
    from apps.tabdata.services.async_changelog import dispatch_collab_changelog

    with patch(
        'apps.tabdata.services.async_changelog.perform_changelog_write'
    ) as mock_perform:
        dispatch_collab_changelog(
            table_id=str(uuid4()),
            change_type='update',
            record_ids=['r1', 'r2'],
            record_count=2,
            user_id=str(uuid4()),
            agent_run_id='',
        )

    mock_perform.assert_called_once()


# ── 6. flag 注册 ─────────────────────────────────────────────


def test_async_collab_flag_registered():
    from django.conf import settings
    assert hasattr(settings, 'TABDATA_BULK_UPDATE_ASYNC_COLLAB')


def test_async_collab_flag_default_true():
    from django.conf import settings
    assert settings.TABDATA_BULK_UPDATE_ASYNC_COLLAB is True


# ── 7. 模块接口完整性 ───────────────────────────────────────


def test_async_changelog_module_exports():
    from apps.tabdata.services.async_changelog import (
        is_async_changelog_enabled,
        incr_pending_changelog,
        decr_pending_changelog,
        get_pending_count,
        wait_for_pending_changelogs,
        dispatch_collab_changelog,
        perform_changelog_write,
    )
    assert all(callable(fn) for fn in [
        is_async_changelog_enabled,
        incr_pending_changelog,
        decr_pending_changelog,
        get_pending_count,
        wait_for_pending_changelogs,
        dispatch_collab_changelog,
        perform_changelog_write,
    ])

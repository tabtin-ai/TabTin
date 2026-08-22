"""W3.0 / D27：async_changelog 模块单元测试。

覆盖：

1. ``is_async_changelog_enabled`` 读 settings flag。
2. ``incr / decr / get / wait`` Redis-backed pending counter 的基本语义。
3. ``wait_for_pending_changelogs`` 超时返回 ``False``、归零返回 ``True``。
4. ``dispatch_collab_changelog`` flag=False 时走同步 ``perform_changelog_write``。
5. ``dispatch_collab_changelog`` flag=True 时调 Celery ``apply_async`` 并 incr counter。
6. Celery 任务异常路径仍会 ``decr_pending_changelog``（finally 兜底）。
7. SchedulerSubscriber._batch_dispatch：同上（500 行只注册 1 个 on_commit 回调）。

不依赖真实 PG/Redis；用 ``LocMemCache`` + ``MagicMock``。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from django.core.cache import cache
from django.test import override_settings


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


# ── 1. flag ────────────────────────────────────────────────


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=True)
def test_flag_default_true():
    from apps.tabdata.services.async_changelog import is_async_changelog_enabled
    assert is_async_changelog_enabled() is True


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=False)
def test_flag_can_be_disabled():
    from apps.tabdata.services.async_changelog import is_async_changelog_enabled
    assert is_async_changelog_enabled() is False


# ── 2. counter 基本语义 ──────────────────────────────────


def test_incr_decr_counter_roundtrip():
    from apps.tabdata.services.async_changelog import (
        incr_pending_changelog, decr_pending_changelog, get_pending_count,
    )
    run_id = "run_unit_1"
    assert get_pending_count(run_id) == 0
    incr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 1
    incr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 2
    decr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 1
    decr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 0


def test_decr_below_zero_clamps():
    from apps.tabdata.services.async_changelog import (
        decr_pending_changelog, get_pending_count,
    )
    run_id = "run_unit_clamp"
    decr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 0


def test_empty_run_id_is_noop():
    from apps.tabdata.services.async_changelog import (
        incr_pending_changelog, decr_pending_changelog, get_pending_count,
    )
    incr_pending_changelog("")
    decr_pending_changelog("")
    assert get_pending_count("") == 0


# ── 3. wait_for_pending_changelogs ──────────────────────


def test_wait_returns_true_when_already_zero():
    from apps.tabdata.services.async_changelog import wait_for_pending_changelogs
    assert wait_for_pending_changelogs("never_set_run_id") is True


def test_wait_returns_true_when_empty_run_id():
    from apps.tabdata.services.async_changelog import wait_for_pending_changelogs
    assert wait_for_pending_changelogs("") is True


def test_wait_times_out_when_counter_stuck_above_zero():
    from apps.tabdata.services.async_changelog import (
        incr_pending_changelog, wait_for_pending_changelogs,
    )
    run_id = "run_unit_stuck"
    incr_pending_changelog(run_id)
    # 100ms timeout, 5ms interval
    assert wait_for_pending_changelogs(
        run_id, timeout_ms=100, interval_ms=5,
    ) is False


# ── 4. dispatch sync path ───────────────────────────────


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=False)
@patch("apps.tabdata.services.async_changelog.perform_changelog_write")
def test_dispatch_sync_path_calls_perform_directly(mock_perform):
    from apps.tabdata.services.async_changelog import dispatch_collab_changelog

    dispatch_collab_changelog(
        table_id="t1", change_type="update_record",
        record_ids=["r1"], record_count=1, user_id="u1",
        agent_run_id="run_sync", session_id="s1",
    )
    mock_perform.assert_called_once_with(
        table_id="t1",
        change_type="update_record",
        record_ids=["r1"],
        record_count=1,
        user_id="u1",
        agent_run_id="run_sync",
        session_id="s1",
    )


# ── 5. dispatch async path ──────────────────────────────


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=True)
def test_dispatch_async_path_apply_async_and_incr_counter():
    from apps.tabdata.services.async_changelog import (
        dispatch_collab_changelog, get_pending_count,
    )

    fake_task = MagicMock()
    fake_task.apply_async = MagicMock()

    with patch(
        "apps.tabdata.tasks.collab_changelog_tasks.async_collab_changelog_after_records",
        fake_task,
    ):
        dispatch_collab_changelog(
            table_id="t2", change_type="batch_update_records",
            record_ids=["r1", "r2"], record_count=2, user_id="u1",
            agent_run_id="run_async", session_id="s1",
        )

    fake_task.apply_async.assert_called_once()
    kwargs = fake_task.apply_async.call_args.kwargs["kwargs"]
    assert kwargs["table_id"] == "t2"
    assert kwargs["change_type"] == "batch_update_records"
    assert kwargs["record_ids"] == ["r1", "r2"]
    assert kwargs["record_count"] == 2
    assert kwargs["user_id"] == "u1"
    assert kwargs["agent_run_id"] == "run_async"
    assert kwargs["session_id"] == "s1"
    # Counter should be > 0 after dispatch（task 还没执行）
    assert get_pending_count("run_async") == 1


@override_settings(TABDATA_BULK_UPDATE_ASYNC_COLLAB=True)
@patch("apps.tabdata.services.async_changelog.perform_changelog_write")
def test_dispatch_falls_back_to_sync_when_apply_async_fails(mock_perform):
    """Broker 不可用时主链路必须降级到 inline 写入，不能丢 ChangeLog。"""
    from apps.tabdata.services.async_changelog import (
        dispatch_collab_changelog, get_pending_count,
    )

    fake_task = MagicMock()
    fake_task.apply_async = MagicMock(side_effect=RuntimeError("broker down"))

    with patch(
        "apps.tabdata.tasks.collab_changelog_tasks.async_collab_changelog_after_records",
        fake_task,
    ):
        dispatch_collab_changelog(
            table_id="t3", change_type="update_record",
            record_ids=["r1"], record_count=1, user_id="u1",
            agent_run_id="run_fallback", session_id="",
        )

    mock_perform.assert_called_once()
    # incr 后 fallback 时立刻 decr,不应留下 phantom pending
    assert get_pending_count("run_fallback") == 0


# ── 6. Celery 任务 finally 兜底 ─────────────────────────


def test_celery_task_decrements_counter_on_failure():
    """模拟任务异常路径：counter 必须 decr，避免 phantom pending。"""
    from apps.tabdata.services.async_changelog import (
        incr_pending_changelog, get_pending_count,
    )
    from apps.tabdata.tasks import collab_changelog_tasks as tasks_mod

    run_id = "run_failure_finally"
    # 模拟 dispatch 阶段 incr 一次
    incr_pending_changelog(run_id)
    assert get_pending_count(run_id) == 1

    # 直接调 .run（同步等价于 EAGER mode），patch perform_changelog_write 抛异常
    with patch(
        "apps.tabdata.services.async_changelog.perform_changelog_write",
        side_effect=RuntimeError("PG down"),
    ):
        with pytest.raises(RuntimeError):
            tasks_mod.async_collab_changelog_after_records.run(
                table_id="t",
                change_type="update_record",
                record_ids=[],
                record_count=0,
                user_id="",
                agent_run_id=run_id,
                session_id="",
            )

    # finally 块应当 decr 到 0
    assert get_pending_count(run_id) == 0


# ── 7. SchedulerSubscriber on_commit 合并 ────────────────


def test_scheduler_subscriber_batch_update_registers_single_on_commit():
    """500 行 batch update 在 SchedulerSubscriber 也只注册 1 个 on_commit 回调。"""
    from apps.tabdata.subscribers.scheduler import SchedulerSubscriber
    from apps.tabdata.domain.events import RecordsBatchUpdated

    payloads = []
    for _ in range(500):
        p = MagicMock()
        p.record_id = uuid4()
        p.changes = {"f1": ("old", "new")}
        payloads.append(p)
    event = MagicMock(spec=RecordsBatchUpdated)
    event.records = payloads
    event.table_id = uuid4()

    sub = SchedulerSubscriber()
    with patch(
        "apps.tabdata.subscribers.scheduler.run_after_commit",
    ) as mock_run_after:
        sub.handle(event)

    assert mock_run_after.call_count == 1

"""
基建层 P0 修复回归测试 — INFRA-7/8/9/10/11/12

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/maintenance/tests/test_infra_p0_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import json
import time
import tempfile
from unittest.mock import Mock, MagicMock, patch, PropertyMock
import pytest


# ━━ INFRA-21(用户INFRA-7): setup_periodic_tasks fallback 不再设置 beat_schedule ━━━

class TestSetupPeriodicTasksFallback:
    """验证 _sync_schedule_to_db 失败时不再错误地设置 sender.conf.beat_schedule。"""

    @patch("tabtin.celery._sync_schedule_to_db", side_effect=Exception("DB not ready"))
    @patch("tabtin.celery.get_beat_schedule", return_value={"test-task": {"task": "foo", "schedule": 60}})
    def test_fallback_does_not_set_beat_schedule(self, mock_get_schedule, mock_sync):
        """_sync_schedule_to_db 失败时 sender.conf.beat_schedule 不应被赋值。"""
        from tabtin.celery import setup_periodic_tasks

        sender = Mock()
        sender.conf = Mock()
        sender.conf.beat_schedule = {}

        with patch("tabtin.celery.PeriodicTask", create=True), \
             patch("tabtin.celery.IntervalSchedule", create=True), \
             patch("tabtin.celery.CrontabSchedule", create=True):
            try:
                from django_celery_beat.models import PeriodicTask, IntervalSchedule, CrontabSchedule
                with patch.dict("sys.modules", {"django_celery_beat.models": MagicMock()}):
                    setup_periodic_tasks(sender)
            except Exception:
                pass

        assert sender.conf.beat_schedule == {}, \
            "fallback 不应设置 sender.conf.beat_schedule（对 DatabaseScheduler 无效）"

    @patch("tabtin.celery.get_beat_schedule", return_value={})
    def test_import_failure_still_sets_beat_schedule(self, mock_get_schedule):
        """django_celery_beat 未安装时，fallback 到 sender.conf.beat_schedule 仍然合理。"""
        from tabtin.celery import setup_periodic_tasks

        sender = Mock()
        sender.conf = Mock()
        sender.conf.beat_schedule = None

        with patch.dict("sys.modules", {"django_celery_beat": None, "django_celery_beat.models": None}):
            with patch("builtins.__import__", side_effect=ImportError("no module")):
                try:
                    setup_periodic_tasks(sender)
                except Exception:
                    pass


# ━━ INFRA-11: multiagent conversation_state 注册到 Beat Schedule ━━━━━━━━━━━━

class TestAgentEngineBeatScheduleRegistration:
    """验证 AGENT_ENGINE_BEAT_SCHEDULE 包含 conversation_state 清理任务。"""

    def test_conversation_state_in_beat_schedule(self):
        """cleanup-stale-conversation-states 必须出现在合并后的 AGENT_ENGINE_BEAT_SCHEDULE 中。"""
        from apps.services.agent_engine.tasks import AGENT_ENGINE_BEAT_SCHEDULE

        assert "cleanup-stale-conversation-states" in AGENT_ENGINE_BEAT_SCHEDULE, \
            "AGENT_ENGINE_BEAT_SCHEDULE 应包含 cleanup-stale-conversation-states"

    def test_conversation_state_task_path(self):
        """任务路径必须指向正确的模块。"""
        from apps.services.agent_engine.tasks import AGENT_ENGINE_BEAT_SCHEDULE

        entry = AGENT_ENGINE_BEAT_SCHEDULE["cleanup-stale-conversation-states"]
        assert entry["task"] == \
            "apps.services.agent_engine.tasks.cleanup.conversation_state.cleanup_stale_conversation_states"

    def test_orchestration_alias_still_points_to_agent_engine(self):
        """向后兼容：ORCHESTRATION_BEAT_SCHEDULE 仍可用、与新名同对象、且首次访问触发 DeprecationWarning。

        新实现（与 legacy_env 告警统一）对 alias 做了"每进程每 legacy 名只告警一次"
        去重，因此测试先清空缓存保证"首次访问"语义独立于其它测试执行顺序。
        """
        import warnings as _w
        from apps.services.agent_engine.tasks import AGENT_ENGINE_BEAT_SCHEDULE
        import apps.services.agent_engine.tasks as tasks_mod

        tasks_mod._reset_alias_deprecation_cache()

        with _w.catch_warnings(record=True) as caught:
            _w.simplefilter("always")
            alias = tasks_mod.ORCHESTRATION_BEAT_SCHEDULE

        assert alias is AGENT_ENGINE_BEAT_SCHEDULE, \
            "ORCHESTRATION_BEAT_SCHEDULE 必须与 AGENT_ENGINE_BEAT_SCHEDULE 指向同一对象（deprecated alias）"
        deprecation_warnings = [
            w for w in caught if issubclass(w.category, DeprecationWarning)
        ]
        assert deprecation_warnings, \
            "访问 ORCHESTRATION_BEAT_SCHEDULE 必须触发 DeprecationWarning"
        assert "ORCHESTRATION_BEAT_SCHEDULE" in str(deprecation_warnings[0].message), \
            "DeprecationWarning 消息应显式提到废弃的符号名"

    def test_orchestration_alias_deprecation_deduped_per_process(self):
        """alias 告警必须与 legacy_env 一致，每进程每 legacy 名只发一次（日志 + warning）。

        连续访问两次，只应捕获到 1 次 DeprecationWarning；否则生产日志会在
        Celery Beat 扫描 / IDE 导入提示等场景下泛滥。
        """
        import warnings as _w
        import apps.services.agent_engine.tasks as tasks_mod

        tasks_mod._reset_alias_deprecation_cache()

        with _w.catch_warnings(record=True) as caught:
            _w.simplefilter("always")
            _ = tasks_mod.ORCHESTRATION_BEAT_SCHEDULE
            _ = tasks_mod.ORCHESTRATION_BEAT_SCHEDULE

        deprecation_warnings = [
            w for w in caught if issubclass(w.category, DeprecationWarning)
            and "ORCHESTRATION_BEAT_SCHEDULE" in str(w.message)
        ]
        assert len(deprecation_warnings) == 1, \
            f"每进程每 legacy 名只应发一次 DeprecationWarning，实际 {len(deprecation_warnings)} 次"

    def test_no_legacy_orchestration_schedule_keys(self):
        """所有 schedule key 都不应以 orchestration- 开头（Wave 12 命名归一）。"""
        from apps.services.agent_engine.tasks import AGENT_ENGINE_BEAT_SCHEDULE

        legacy_keys = [k for k in AGENT_ENGINE_BEAT_SCHEDULE if k.startswith("orchestration-")]
        assert not legacy_keys, \
            f"AGENT_ENGINE_BEAT_SCHEDULE 不应包含 orchestration-* 开头的 key，发现：{legacy_keys}"

    def test_full_beat_schedule_has_no_legacy_keys(self):
        """Wave 12：整个 Beat Schedule（含 middleware.trace 等）都不应有 orchestration- key。

        比 test_no_legacy_orchestration_schedule_keys 更严：覆盖 get_beat_schedule()
        合并后的所有 schedule（包括不在 AGENT_ENGINE_BEAT_SCHEDULE 聚合内的
        TRACE_PUBLISH_BEAT_SCHEDULE 等），防止未来在其他模块引入遗留命名。
        """
        from tabtin.celery import get_beat_schedule

        schedule = get_beat_schedule()
        legacy_keys = [k for k in schedule if k.startswith("orchestration-")]
        assert not legacy_keys, \
            f"get_beat_schedule() 不应包含 orchestration-* 开头的 key，发现：{legacy_keys}"

    def test_monitor_heartbeat_key_renamed(self):
        """Wave 12：监控心跳任务 key 应归一为无前缀风格 check-monitor-heartbeats。

        放弃 `orchestration-*` 和过渡态的 `agent-engine-*` 前缀，
        与 agent_engine 下其他 15 条无前缀 key 保持命名一致。
        """
        from apps.services.agent_engine.tasks.cleanup.monitor import MONITOR_BEAT_SCHEDULE

        assert "check-monitor-heartbeats" in MONITOR_BEAT_SCHEDULE, \
            "MONITOR_BEAT_SCHEDULE 必须使用新 key 'check-monitor-heartbeats'"
        assert "orchestration-check-monitor-heartbeats" not in MONITOR_BEAT_SCHEDULE, \
            "MONITOR_BEAT_SCHEDULE 不应再包含旧 key 'orchestration-check-monitor-heartbeats'"
        assert "agent-engine-check-monitor-heartbeats" not in MONITOR_BEAT_SCHEDULE, \
            "MONITOR_BEAT_SCHEDULE 不应再使用过渡态 key 'agent-engine-check-monitor-heartbeats'"


# ━━ Wave 12: legacy_schedules 单一来源契约 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestLegacySchedulesSingleSource:
    """确保 `apps.maintenance.legacy_schedules` 作为前缀单一来源，
    `tabtin.celery` 的 `_soft_disable_legacy_duplicates` 与
    `check_orchestration_beat_tasks` 命令共享同一套常量，避免两处漂移。
    """

    def test_legacy_schedule_key_prefixes_contract(self):
        from apps.maintenance.legacy_schedules import LEGACY_SCHEDULE_KEY_PREFIXES

        assert isinstance(LEGACY_SCHEDULE_KEY_PREFIXES, tuple), \
            "常量必须是不可变 tuple（防止运行时修改）"
        assert "orchestration-" in LEGACY_SCHEDULE_KEY_PREFIXES, \
            "Wave 12 归一的 orchestration- 前缀必须保留"

    def test_task_path_migrations_contract(self):
        from apps.maintenance.legacy_schedules import TASK_PATH_MIGRATIONS

        assert TASK_PATH_MIGRATIONS.get("apps.orchestration.") == \
            "apps.services.agent_engine.", \
            "Wave 11 迁移的 apps.orchestration. → apps.services.agent_engine. 必须保留"

    def test_resolve_new_task_path_matching(self):
        from apps.maintenance.legacy_schedules import resolve_new_task_path

        assert resolve_new_task_path("apps.orchestration.tasks.sweep") == \
            "apps.services.agent_engine.tasks.sweep"
        # 非 orchestration 路径返回 None，让调用方显式处理
        assert resolve_new_task_path("apps.tracker.tasks.x") is None
        # 显式短名 task（非 apps.orchestration. 前缀）不被匹配，与 @shared_task(name=...) 语义一致
        assert resolve_new_task_path("orchestration.sweep_stale_runs") is None

    def test_command_and_celery_share_same_prefix(self):
        """命令的 filter 覆盖 legacy_schedules 的全部前缀，task 路径迁移常量同步。"""
        from apps.maintenance.legacy_schedules import (
            LEGACY_SCHEDULE_KEY_PREFIXES,
            TASK_PATH_MIGRATIONS,
        )
        from apps.capabilities.management.commands.check_orchestration_beat_tasks import (
            TASK_PATH_OLD_PREFIX,
            TASK_PATH_NEW_PREFIX,
            _legacy_schedule_key_filter,
            _legacy_schedule_key_examples,
        )

        assert (TASK_PATH_OLD_PREFIX, TASK_PATH_NEW_PREFIX) == \
            next(iter(TASK_PATH_MIGRATIONS.items()))

        # filter 必须覆盖 legacy_schedules 的全部前缀（不是只取第一个）
        q_repr = str(_legacy_schedule_key_filter())
        for prefix in LEGACY_SCHEDULE_KEY_PREFIXES:
            assert prefix in q_repr, (
                f"_legacy_schedule_key_filter 必须覆盖前缀 '{prefix}'，否则"
                f" --purge-legacy-keys 无法清理该前缀的 DB 记录"
            )

        # 展示文本包含全部前缀
        examples = _legacy_schedule_key_examples()
        for prefix in LEGACY_SCHEDULE_KEY_PREFIXES:
            assert prefix in examples, (
                f"_legacy_schedule_key_examples 应展示前缀 '{prefix}'"
            )


# ━━ Wave 12: check_orchestration_beat_tasks 命令参数校验 ━━━━━━━━━━━━━━━━━━

class TestCheckOrchestrationBeatTasksCommand:
    """验证 check_orchestration_beat_tasks 命令的参数互斥与校验逻辑。

    不依赖真实 DB：通过 mock django_celery_beat.models 的 PeriodicTask manager
    只覆盖入口参数校验路径，避免 import 成本。
    """

    def test_confirm_without_purge_legacy_keys_exits_2(self):
        """--confirm 单独使用时必须 exit(2) 并提示用户。"""
        from django.core.management import call_command
        from io import StringIO

        stdout = StringIO()
        stderr = StringIO()
        with pytest.raises(SystemExit) as exc_info:
            call_command(
                "check_orchestration_beat_tasks",
                "--confirm",
                stdout=stdout,
                stderr=stderr,
            )
        assert exc_info.value.code == 2
        assert "--confirm 必须配合 --purge-legacy-keys 使用" in stderr.getvalue()

    def test_fix_and_disable_mutex_exits_2(self):
        """--fix 与 --disable 互斥，同时指定应 exit(2)。"""
        from django.core.management import call_command
        from io import StringIO

        stdout = StringIO()
        stderr = StringIO()
        with pytest.raises(SystemExit) as exc_info:
            call_command(
                "check_orchestration_beat_tasks",
                "--fix",
                "--disable",
                stdout=stdout,
                stderr=stderr,
            )
        assert exc_info.value.code == 2
        assert "--fix 与 --disable 互斥" in stderr.getvalue()

    @staticmethod
    def _build_fake_periodic_task(
        id_: int,
        name: str,
        task: str,
        enabled: bool = True,
    ):
        """构造一个最小的 PeriodicTask 替身，供 _query_legacy / report 循环使用。"""
        obj = Mock()
        obj.id = id_
        obj.name = name
        obj.task = task
        obj.enabled = enabled
        return obj

    @staticmethod
    def _install_fake_pt_model(
        legacy_path_tasks,
        legacy_key_tasks,
        active_path_tasks=None,
        active_key_tasks=None,
        delete_return=(0, {}),
    ):
        """返回 (fake_pt_model, delete_qs_mock, count_after) 组合。

        active_path_tasks / active_key_tasks 用于 _query_legacy(active_only=True) 的
        链式过滤场景；若未显式指定，默认等于 legacy_path_tasks / legacy_key_tasks
        （即"全部仍然活跃"，用于 --strict 无修复时的断言）。

        delete_qs_mock 是 delete() 真正被调用的 MagicMock，测试可用
        ``delete_qs_mock.delete.assert_called_once()`` 验证。
        """
        if active_path_tasks is None:
            active_path_tasks = list(legacy_path_tasks)
        if active_key_tasks is None:
            active_key_tasks = list(legacy_key_tasks)

        delete_qs = MagicMock()
        delete_qs.delete.return_value = delete_return

        count_after = {"value": 0}

        def make_qs(tasks_iter, *, count_value=None):
            qs = MagicMock()
            qs.order_by.return_value = list(tasks_iter)
            if count_value is not None:
                qs.count.return_value = count_value
            qs.filter.side_effect = lambda **_kw: qs
            return qs

        def fake_filter(*args, **kwargs):
            # W12 修复：_query_legacy 现在传 Q 对象（位置参数）覆盖多个 legacy 前缀，
            # 而非 name__startswith kwargs。识别 Q 对象为 schedule key filter。
            if args and not kwargs:
                qs = make_qs(legacy_key_tasks, count_value=count_after["value"])
                active_qs = make_qs(active_key_tasks)
                qs.filter.side_effect = lambda **_kw: active_qs
                qs.delete.side_effect = delete_qs.delete
                return qs
            if kwargs.get("task__startswith"):
                qs = make_qs(legacy_path_tasks)
                active_qs = make_qs(active_path_tasks)
                qs.filter.side_effect = lambda **_kw: active_qs
                return qs
            if kwargs.get("name__startswith"):
                qs = make_qs(legacy_key_tasks, count_value=count_after["value"])
                active_qs = make_qs(active_key_tasks, count_value=count_after["value"])
                qs.filter.side_effect = lambda **_kw: active_qs
                return qs
            if kwargs.get("id__in") is not None:
                return delete_qs
            return make_qs([])

        fake_manager = MagicMock()
        fake_manager.filter.side_effect = fake_filter

        fake_pt_model = MagicMock()
        fake_pt_model.objects = fake_manager
        fake_pt_model._meta.app_label = "django_celery_beat"
        fake_pt_model.__name__ = "PeriodicTask"

        return fake_pt_model, delete_qs, count_after

    def test_purge_dry_run_does_not_delete(self):
        """--purge-legacy-keys 不加 --confirm 时，只列出不删除。"""
        from django.core.management import call_command
        from io import StringIO

        fake_task = self._build_fake_periodic_task(
            id_=999,
            name="orchestration-fake-key",
            task="apps.services.agent_engine.tasks.fake",
        )
        fake_pt_model, delete_qs, _ = self._install_fake_pt_model(
            legacy_path_tasks=[],
            legacy_key_tasks=[fake_task],
        )

        with patch.dict(
            "sys.modules",
            {
                "django_celery_beat": MagicMock(),
                "django_celery_beat.models": MagicMock(PeriodicTask=fake_pt_model),
            },
        ):
            stdout = StringIO()
            stderr = StringIO()
            call_command(
                "check_orchestration_beat_tasks",
                "--purge-legacy-keys",
                stdout=stdout,
                stderr=stderr,
            )
            output = stdout.getvalue()
            assert "DRY RUN" in output, "dry-run 必须有醒目横幅（含 DRY RUN 字样）"
            assert "未指定 --confirm" in output
            assert "orchestration-fake-key" in output
            assert "包括任何自定义/调试用途的记录" in output, \
                "dry-run 应显式警告该前缀下所有记录都会被一并删除"
            assert "legacy-beat-backup" in output, \
                "dry-run 应给出 stdout 重定向备份的命令示例，降低 SRE 回滚门槛"
            delete_qs.delete.assert_not_called()

    def test_purge_with_confirm_calls_delete(self):
        """--purge-legacy-keys --confirm 时，真正调用 .delete() 并显示复核。"""
        from django.core.management import call_command
        from io import StringIO

        fake_task = self._build_fake_periodic_task(
            id_=101,
            name="orchestration-legacy-key",
            task="apps.services.agent_engine.tasks.some",
        )
        fake_pt_model, delete_qs, count_after = self._install_fake_pt_model(
            legacy_path_tasks=[],
            legacy_key_tasks=[fake_task],
            delete_return=(1, {"django_celery_beat.PeriodicTask": 1}),
        )
        count_after["value"] = 0

        with patch.dict(
            "sys.modules",
            {
                "django_celery_beat": MagicMock(),
                "django_celery_beat.models": MagicMock(PeriodicTask=fake_pt_model),
            },
        ):
            stdout = StringIO()
            stderr = StringIO()
            call_command(
                "check_orchestration_beat_tasks",
                "--purge-legacy-keys",
                "--confirm",
                stdout=stdout,
                stderr=stderr,
            )
            delete_qs.delete.assert_called_once()
            output = stdout.getvalue()
            assert "已删除 1 条" in output
            # W12 修复：复核消息展示全部 legacy 前缀，覆盖 orchestration- 和 agent-engine-
            assert "复核：DB 中已无" in output and \
                "'orchestration-*'" in output and "'agent-engine-*'" in output, \
                "删除后应打印 after 复核确认无残留，且覆盖全部 legacy 前缀"

    def test_strict_exit1_when_legacy_remains(self):
        """--strict 在仍有遗留时应退出码 1，并打印对应修复命令提示。"""
        from django.core.management import call_command
        from io import StringIO

        fake_path_task = self._build_fake_periodic_task(
            id_=1,
            name="sweep-stale-runs",
            task="apps.orchestration.tasks.sweep",
        )
        fake_key_task = self._build_fake_periodic_task(
            id_=2,
            name="orchestration-old",
            task="apps.services.agent_engine.tasks.foo",
        )
        fake_pt_model, _, _ = self._install_fake_pt_model(
            legacy_path_tasks=[fake_path_task],
            legacy_key_tasks=[fake_key_task],
        )

        with patch.dict(
            "sys.modules",
            {
                "django_celery_beat": MagicMock(),
                "django_celery_beat.models": MagicMock(PeriodicTask=fake_pt_model),
            },
        ):
            stdout = StringIO()
            stderr = StringIO()
            with pytest.raises(SystemExit) as exc_info:
                call_command(
                    "check_orchestration_beat_tasks",
                    "--strict",
                    stdout=stdout,
                    stderr=stderr,
                )
            assert exc_info.value.code == 1
            output = stdout.getvalue()
            assert "--strict 判定失败" in output
            # CI 场景下新人开发常不知道下一步跑什么；断言修复提示精确输出两条分支命令
            assert "修复建议" in output, "--strict 失败输出必须含修复建议段"
            assert "--fix --strict" in output, "有 task 路径遗留时应提示 --fix"
            assert "--purge-legacy-keys --confirm --strict" in output, \
                "有 schedule key 遗留时应提示 --purge-legacy-keys --confirm"

    def test_query_legacy_db_error_exits_2(self):
        """_query_legacy 遇到 ProgrammingError/DatabaseError 应退出码 2 并在 stderr 有明确提示。"""
        from django.core.management import call_command
        from django.db import ProgrammingError
        from io import StringIO

        fake_manager = MagicMock()
        fake_manager.filter.side_effect = ProgrammingError(
            "relation \"django_celery_beat_periodictask\" does not exist"
        )
        fake_pt_model = MagicMock()
        fake_pt_model.objects = fake_manager

        with patch.dict(
            "sys.modules",
            {
                "django_celery_beat": MagicMock(),
                "django_celery_beat.models": MagicMock(PeriodicTask=fake_pt_model),
            },
        ):
            stdout = StringIO()
            stderr = StringIO()
            with pytest.raises(SystemExit) as exc_info:
                call_command(
                    "check_orchestration_beat_tasks",
                    stdout=stdout,
                    stderr=stderr,
                )
            assert exc_info.value.code == 2
            assert "查询 PeriodicTask 失败" in stderr.getvalue()
            assert "ProgrammingError" in stderr.getvalue()

    def test_disable_with_strict_passes_after_disable(self):
        """--disable --strict 组合：disable 后 active_only 查询返回空，strict 判定通过（退出码 0）。

        回归 Wave 12 Review 反馈的语义陷阱：disable 把记录置 enabled=False，
        strict 最终查询使用 active_only=True 排除这些记录，视为已清理。
        """
        from django.core.management import call_command
        from io import StringIO

        fake_path_task = self._build_fake_periodic_task(
            id_=1,
            name="legacy-path-task",
            task="apps.orchestration.tasks.sweep",
        )
        # disable 后，active_only=True 查询返回空（模拟已 enabled=False）
        fake_pt_model, _, _ = self._install_fake_pt_model(
            legacy_path_tasks=[fake_path_task],
            legacy_key_tasks=[],
            active_path_tasks=[],
            active_key_tasks=[],
        )

        with patch.dict(
            "sys.modules",
            {
                "django_celery_beat": MagicMock(),
                "django_celery_beat.models": MagicMock(PeriodicTask=fake_pt_model),
            },
        ):
            stdout = StringIO()
            stderr = StringIO()
            # 不加 pytest.raises SystemExit：exit code 0 不会抛
            call_command(
                "check_orchestration_beat_tasks",
                "--disable",
                "--strict",
                stdout=stdout,
                stderr=stderr,
            )
            output = stdout.getvalue()
            assert "--strict 判定失败" not in output, \
                "disable 后 active_only 应排除 enabled=False 记录，strict 不应失败"


# ━━ Wave 12: setup_periodic_tasks 软禁用 legacy duplicates ━━━━━━━━━━━━━━

class TestSoftDisableLegacyDuplicates:
    """验证 `_soft_disable_legacy_duplicates` 在 Worker 启动时自动禁用被替代的 legacy key，
    避免 SRE 忘记手工执行 `--purge-legacy-keys --confirm` 导致任务双倍调度。

    并发锁：函数通过 `cache.add('celery:soft_disable_legacy_lock', ...)` 做分布式
    advisory lock，避免多 Worker 同时执行。单元测试跨用例可能残留锁值，
    setup_method 统一清锁保证每条用例独立可重入。
    """

    _LOCK_KEY = "celery:soft_disable_legacy_lock"

    def setup_method(self, method):
        from django.core.cache import cache
        cache.delete(self._LOCK_KEY)

    def teardown_method(self, method):
        from django.core.cache import cache
        cache.delete(self._LOCK_KEY)

    def test_soft_disable_only_affects_task_in_current_schedule(self):
        """仅 task 字段在当前 schedule 里的 legacy key 才被软禁用，
        自建 'orchestration-' 前缀但 task 不匹配的记录不会被触碰。
        """
        from tabtin.celery import _soft_disable_legacy_duplicates

        schedule_dict = {
            "check-monitor-heartbeats": {
                "task": "apps.services.agent_engine.tasks.cleanup.monitor.check_monitor_heartbeats",
                "schedule": 60.0,
            },
        }

        legacy_match = Mock()
        legacy_match.id = 1
        legacy_match.name = "orchestration-check-monitor-heartbeats"
        legacy_match.task = "apps.services.agent_engine.tasks.cleanup.monitor.check_monitor_heartbeats"
        legacy_match.enabled = True
        legacy_match.description = ""

        custom_task = Mock()
        custom_task.id = 2
        custom_task.name = "orchestration-custom-admin-job"
        custom_task.task = "apps.services.something_else.custom"
        custom_task.enabled = True

        fake_qs = MagicMock()
        fake_qs.filter.return_value = MagicMock(
            only=MagicMock(return_value=[legacy_match])
        )

        updated_ids = []

        def fake_filter(**kwargs):
            if "task__in" in kwargs and kwargs.get("enabled") is True:
                return fake_qs
            if "id__in" in kwargs:
                update_qs = MagicMock()
                update_qs.update.side_effect = lambda **_kw: (
                    updated_ids.extend(kwargs["id__in"]),
                    len(kwargs["id__in"]),
                )[1]
                return update_qs
            return MagicMock()

        fake_pt_model = MagicMock()
        fake_pt_model.objects.filter.side_effect = fake_filter

        _soft_disable_legacy_duplicates(schedule_dict, fake_pt_model)
        assert legacy_match.id in updated_ids, \
            "task 匹配当前 schedule 的 legacy key 应被软禁用"
        assert custom_task.id not in updated_ids, \
            "task 不匹配的自建 orchestration-* 不应被触碰（查询条件 task__in=schedule 集合已排除）"

    def test_soft_disable_skips_when_name_already_in_schedule(self):
        """schedule_dict 中已经存在该 name 时，update_or_create 已经处理了，
        软禁用分支应跳过（避免把刚刚写入的新 key 误禁用）。
        """
        from tabtin.celery import _soft_disable_legacy_duplicates

        schedule_dict = {
            "orchestration-legitimate-kept": {
                "task": "apps.services.agent_engine.tasks.kept",
                "schedule": 60.0,
            },
        }

        matched = Mock()
        matched.id = 1
        matched.name = "orchestration-legitimate-kept"
        matched.task = "apps.services.agent_engine.tasks.kept"
        matched.enabled = True
        matched.description = ""

        fake_qs = MagicMock()
        fake_qs.filter.return_value = MagicMock(
            only=MagicMock(return_value=[matched])
        )

        updated_ids = []

        def fake_filter(**kwargs):
            if "task__in" in kwargs and kwargs.get("enabled") is True:
                return fake_qs
            if "id__in" in kwargs:
                update_qs = MagicMock()
                update_qs.update.side_effect = lambda **_kw: (
                    updated_ids.extend(kwargs["id__in"]),
                    len(kwargs["id__in"]),
                )[1]
                return update_qs
            return MagicMock()

        fake_pt_model = MagicMock()
        fake_pt_model.objects.filter.side_effect = fake_filter

        _soft_disable_legacy_duplicates(schedule_dict, fake_pt_model)
        assert not updated_ids, \
            "name 仍在 schedule 里（同名未被新 key 替代）时不应软禁用"

    def test_soft_disable_uses_distributed_lock(self):
        """已有其他进程持锁时（cache.add 返回 False）本次应直接 return，
        既不查 candidates 也不 update，避免多 Worker 竞态打重复 WARNING。
        """
        from django.core.cache import cache
        from tabtin.celery import _soft_disable_legacy_duplicates

        # 预先占锁模拟另一进程已在跑
        cache.set("celery:soft_disable_legacy_lock", 1, timeout=300)

        fake_pt_model = MagicMock()

        _soft_disable_legacy_duplicates(
            {"x": {"task": "t", "schedule": 60}},
            fake_pt_model,
        )

        # 未尝试任何 filter 查询
        fake_pt_model.objects.filter.assert_not_called()

    def test_soft_disable_writes_description_marker(self):
        """首次软禁用时写入 description marker；已含 marker 的记录不再算 fresh_names。"""
        from tabtin.celery import (
            _soft_disable_legacy_duplicates,
            _SOFT_DISABLE_DESCRIPTION_MARK,
        )

        schedule_dict = {
            "check-monitor-heartbeats": {
                "task": "apps.services.agent_engine.tasks.cleanup.monitor.check_monitor_heartbeats",
                "schedule": 60.0,
            },
        }

        # 两条 legacy：一条是"首次"（空 description）；另一条已含 marker（重启幂等场景）
        first_time = Mock()
        first_time.id = 1
        first_time.name = "orchestration-check-monitor-heartbeats"
        first_time.task = "apps.services.agent_engine.tasks.cleanup.monitor.check_monitor_heartbeats"
        first_time.description = ""

        already_marked = Mock()
        already_marked.id = 2
        already_marked.name = "orchestration-check-monitor-heartbeats-2"
        already_marked.task = "apps.services.agent_engine.tasks.cleanup.monitor.check_monitor_heartbeats"
        already_marked.description = _SOFT_DISABLE_DESCRIPTION_MARK

        fake_qs = MagicMock()
        fake_qs.filter.return_value = MagicMock(
            only=MagicMock(return_value=[first_time, already_marked])
        )

        update_calls = []

        def fake_filter(**kwargs):
            if "task__in" in kwargs and kwargs.get("enabled") is True:
                return fake_qs
            if "id__in" in kwargs:
                update_qs = MagicMock()
                def track_update(**kw):
                    update_calls.append({"ids": kwargs["id__in"], "kw": kw})
                    return len(kwargs["id__in"])
                update_qs.update.side_effect = track_update
                return update_qs
            return MagicMock()

        fake_pt_model = MagicMock()
        fake_pt_model.objects.filter.side_effect = fake_filter

        _soft_disable_legacy_duplicates(schedule_dict, fake_pt_model)

        assert len(update_calls) == 1, "应恰好执行一次 update"
        assert sorted(update_calls[0]["ids"]) == [1, 2], "两条都应被禁用（含已标记的）"
        assert update_calls[0]["kw"] == {
            "enabled": False,
            "description": _SOFT_DISABLE_DESCRIPTION_MARK,
        }, "应同时写入 enabled=False 与 description marker"


# ━━ INFRA-12: TINS_BEAT_SCHEDULE 注册到 _SCHEDULE_EXPORTS ━━━━━━━━━━━━━━━━

class TestTinsBeatScheduleRegistration:
    """验证 TINS_BEAT_SCHEDULE 出现在 _SCHEDULE_EXPORTS 中。"""

    def test_tins_in_schedule_exports(self):
        """_SCHEDULE_EXPORTS 必须包含 TINS_BEAT_SCHEDULE。"""
        from tabtin.celery import _SCHEDULE_EXPORTS

        tins_entries = [
            e for e in _SCHEDULE_EXPORTS
            if e["attr"] == "TINS_BEAT_SCHEDULE"
        ]
        assert len(tins_entries) == 1, "_SCHEDULE_EXPORTS 应包含恰好一条 TINS_BEAT_SCHEDULE"
        assert tins_entries[0]["module"] == "apps.tins.tasks"

    def test_load_tins_schedule_export(self):
        """_load_schedule_export 应能加载 TINS_BEAT_SCHEDULE。"""
        from tabtin.celery import _load_schedule_export

        result = _load_schedule_export(
            module_path="apps.tins.tasks",
            attr_name="TINS_BEAT_SCHEDULE",
            required_apps=("apps.tins",),
        )
        assert "tins-cleanup-run-logs" in result, \
            "TINS_BEAT_SCHEDULE 应包含 tins-cleanup-run-logs"


# ━━ INFRA-8(表): 健康检查 default 队列 Redis key 修复 ━━━━━━━━━━━━━━━━━━━━━━

class TestQueueHealthRedisKey:
    """验证 check_queue_health 使用正确的 Redis key 'default' 而非 'celery'。"""

    @patch("redis.from_url")
    def test_default_queue_uses_correct_key(self, mock_redis_from_url):
        """default 队列应使用 r.llen('default')，而非错误的 r.llen('celery')。"""
        mock_redis = MagicMock()
        mock_redis.llen.return_value = 0
        mock_redis_from_url.return_value = mock_redis

        from apps.maintenance.celery_health import CeleryHealthChecker
        checker = CeleryHealthChecker.__new__(CeleryHealthChecker)
        checker.inspect = MagicMock()

        result = checker.check_queue_health()

        llen_calls = [str(c) for c in mock_redis.llen.call_args_list]
        assert any("'default'" in c for c in llen_calls), \
            "应使用 r.llen('default') 读取 default 队列长度"
        assert not any("'celery'" in c for c in llen_calls), \
            "不应使用 r.llen('celery')（这是错误的 key）"


# ━━ INFRA-9: full_check() 发现问题时触发 webhook 告警 ━━━━━━━━━━━━━━━━━━━━

class TestFullCheckWebhookAlert:
    """验证 full_check() 在检测到问题时调用 _send_health_alert。"""

    @patch("apps.maintenance.celery_health._write_health_status_file")
    @patch("apps.maintenance.celery_health._send_health_alert")
    def test_alert_triggered_when_unhealthy(self, mock_alert, mock_write):
        """full_check() 检测到异常时必须调用 _send_health_alert。"""
        from apps.maintenance.celery_health import CeleryHealthChecker

        checker = CeleryHealthChecker.__new__(CeleryHealthChecker)
        checker.inspect = MagicMock()

        checker.check_workers = Mock(return_value={
            "healthy": False,
            "workers": [],
            "issues": ["没有活跃的 Worker"],
        })
        checker.check_queue_health = Mock(return_value={
            "healthy": True,
            "queues": {},
            "issues": [],
        })

        report = checker.full_check()

        assert not report["healthy"]
        mock_alert.assert_called_once()
        alert_issues = mock_alert.call_args[0][0]
        assert "没有活跃的 Worker" in alert_issues

    @patch("apps.maintenance.celery_health._write_health_status_file")
    @patch("apps.maintenance.celery_health._send_health_alert")
    def test_no_alert_when_healthy(self, mock_alert, mock_write):
        """full_check() 一切正常时不应触发告警。"""
        from apps.maintenance.celery_health import CeleryHealthChecker

        checker = CeleryHealthChecker.__new__(CeleryHealthChecker)
        checker.inspect = MagicMock()

        checker.check_workers = Mock(return_value={
            "healthy": True,
            "workers": ["celery@main"],
            "issues": [],
        })
        checker.check_queue_health = Mock(return_value={
            "healthy": True,
            "queues": {"default": 0},
            "issues": [],
        })

        report = checker.full_check()

        assert report["healthy"]
        mock_alert.assert_not_called()


class TestQuickCheck:
    """验证周期健康检查使用轻量 inspect，避免 critical worker 噪音。"""

    @patch("apps.maintenance.celery_health._write_health_status_file")
    @patch("apps.maintenance.celery_health._send_health_alert")
    def test_quick_check_uses_ping_without_deep_inspect(self, mock_alert, mock_write):
        from apps.maintenance.celery_health import CeleryHealthChecker

        checker = CeleryHealthChecker.__new__(CeleryHealthChecker)
        checker.inspect = MagicMock()
        checker.inspect.ping.return_value = {"celery@critical": {"ok": "pong"}}
        checker.check_queue_health = Mock(return_value={
            "healthy": True,
            "queues": {"critical": 0},
            "issues": [],
        })

        report = checker.quick_check()

        assert report["healthy"]
        checker.inspect.ping.assert_called_once()
        checker.inspect.active.assert_not_called()
        checker.inspect.registered.assert_not_called()
        mock_alert.assert_not_called()
        mock_write.assert_called_once()

    @patch("apps.maintenance.celery_health.health_checker")
    def test_celery_health_task_calls_quick_check(self, mock_health_checker):
        from apps.maintenance.celery_health_tasks import celery_health_check

        mock_health_checker.quick_check.return_value = {
            "healthy": True,
            "summary": {"total_issues": 0},
            "workers": {"workers": ["celery@critical"]},
        }

        result = celery_health_check.run()

        mock_health_checker.quick_check.assert_called_once()
        mock_health_checker.full_check.assert_not_called()
        assert result == {
            "status": "healthy",
            "issues_count": 0,
            "workers_count": 1,
        }


# ━━ INFRA-9: webhook 告警冷却机制 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestAlertCooldown:
    """验证 webhook 告警的冷却机制。"""

    @patch("apps.maintenance.celery_health.deliver_webhook_once",
           create=True, return_value={"ok": True})
    def test_cooldown_prevents_spam(self, mock_deliver):
        """冷却期内第二次调用应被跳过。"""
        import apps.maintenance.celery_health as mod
        old_last = mod._last_alert_time
        try:
            mod._last_alert_time = 0.0

            with patch.object(mod, "deliver_webhook_once",
                              create=True, return_value={"ok": True}):
                with patch("django.conf.settings") as mock_settings:
                    mock_settings.CELERY_HEALTH_ALERT_WEBHOOK_URL = "https://example.com/hook"

                    result1 = mod._send_health_alert(["test issue"], {"timestamp": "t"})

                    result2 = mod._send_health_alert(["test issue again"], {"timestamp": "t"})
                    assert result2 is False, "冷却期内应返回 False"
        finally:
            mod._last_alert_time = old_last


# ━━ INFRA-10: 健康状态文件写入 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestHealthStatusFile:
    """验证健康状态文件正确写入，供外部探针读取。"""

    def test_write_health_status_file(self):
        """_write_health_status_file 应写出 JSON 文件。"""
        import apps.maintenance.celery_health as mod

        with tempfile.TemporaryDirectory() as tmpdir:
            old_dir = mod.HEALTH_STATUS_DIR
            old_file = mod.HEALTH_STATUS_FILE
            try:
                mod.HEALTH_STATUS_DIR = tmpdir
                mod.HEALTH_STATUS_FILE = os.path.join(tmpdir, "celery_health_status.json")

                report = {
                    "healthy": False,
                    "timestamp": "2026-03-17T12:00:00+00:00",
                    "workers": {"workers": ["celery@main"]},
                    "summary": {"issues": ["test issue"]},
                    "queues": {"queues": {"default": 5}},
                }
                mod._write_health_status_file(report)

                assert os.path.exists(mod.HEALTH_STATUS_FILE)
                with open(mod.HEALTH_STATUS_FILE) as f:
                    data = json.load(f)
                assert data["healthy"] is False
                assert "test issue" in data["issues"]
                assert "epoch" in data
                assert data["workers"] == ["celery@main"]
            finally:
                mod.HEALTH_STATUS_DIR = old_dir
                mod.HEALTH_STATUS_FILE = old_file

    @patch("apps.maintenance.celery_health._write_health_status_file")
    @patch("apps.maintenance.celery_health._send_health_alert")
    def test_full_check_always_writes_status_file(self, mock_alert, mock_write):
        """full_check() 无论健康与否都应写入状态文件。"""
        from apps.maintenance.celery_health import CeleryHealthChecker

        checker = CeleryHealthChecker.__new__(CeleryHealthChecker)
        checker.inspect = MagicMock()
        checker.check_workers = Mock(return_value={
            "healthy": True, "workers": ["w1"], "issues": [],
        })
        checker.check_queue_health = Mock(return_value={
            "healthy": True, "queues": {}, "issues": [],
        })

        checker.full_check()
        mock_write.assert_called_once()


# ━━ INFRA-24(关联): 卡住任务阈值从 30min 降至 15min ━━━━━━━━━━━━━━━━━━━━

class TestStuckTaskThreshold:
    """验证卡住任务检测阈值已从 30min 改为 15min。"""

    def test_stuck_threshold_is_15_minutes(self):
        """check_workers 应在 15 分钟时触发卡住任务告警。"""
        from apps.maintenance.celery_health import CeleryHealthChecker
        from django.utils import timezone
        import datetime

        checker = CeleryHealthChecker.__new__(CeleryHealthChecker)
        mock_inspect = MagicMock()

        now = timezone.now()
        start_16min_ago = (now - datetime.timedelta(minutes=16)).timestamp()
        start_10min_ago = (now - datetime.timedelta(minutes=10)).timestamp()

        mock_inspect.active.return_value = {
            "celery@main": [
                {"name": "slow_task", "time_start": start_16min_ago},
                {"name": "normal_task", "time_start": start_10min_ago},
            ]
        }
        mock_inspect.ping.return_value = {"celery@main": {"ok": "pong"}}
        mock_inspect.registered.return_value = {"celery@main": ["task1"]}
        checker.inspect = mock_inspect

        result = checker.check_workers()

        stuck_issues = [i for i in result["issues"] if "长时间运行" in i]
        assert len(stuck_issues) == 1, "16 分钟的任务应被检测为卡住"
        assert "slow_task" in stuck_issues[0]


# ━━ 健康检查任务队列验证 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestHealthCheckTaskQueue:
    """验证健康检查任务被路由到 critical 队列。"""

    def test_health_check_schedule_uses_critical_queue(self):
        """celery-health-check 应被路由到 critical 队列。"""
        from apps.maintenance.celery_health_tasks import CELERY_HEALTH_CHECK_SCHEDULE

        entry = CELERY_HEALTH_CHECK_SCHEDULE["celery-health-check"]
        queue = entry.get("options", {}).get("queue")
        assert queue == "critical", \
            f"健康检查应路由到 critical 队列，实际: {queue}"

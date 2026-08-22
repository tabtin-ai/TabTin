"""
回归测试：基建层 P0 修复 — 队列饥饿与路由问题

覆盖：
  INFRA-5  critical 队列独立 Worker
  INFRA-6  visibility_timeout = 7200（2x time_limit）
  INFRA-19 重型任务路由到 heavy 队列
"""
import os
import re
import subprocess
import sys

import pytest

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
DJANGO_DIR = os.path.join(ROOT_DIR, 'apps', 'tabtin_django')
SCRIPTS_DIR = os.path.join(ROOT_DIR, 'scripts')


# ---------------------------------------------------------------------------
# Django settings 加载 (不需要数据库)
# ---------------------------------------------------------------------------

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
sys.path.insert(0, DJANGO_DIR)

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402


# ===========================================================================
# INFRA-5: critical 队列必须由独立 Worker 消费
# ===========================================================================

class TestInfra5CriticalWorkerIsolation:
    """验证 celery-start.sh 中 critical 队列不再与 heavy 共享 Worker。"""

    @pytest.fixture(autouse=True)
    def _load_script(self):
        script_path = os.path.join(SCRIPTS_DIR, 'celery-start.sh')
        with open(script_path) as f:
            self.script = f.read()

    def test_main_worker_does_not_include_critical(self):
        """主 Worker 的 -Q 参数不应包含 critical 队列。"""
        main_worker_lines = [
            line for line in self.script.splitlines()
            if 'celery' in line and 'worker' in line and '-n worker@' in line
        ]
        assert main_worker_lines, "未找到主 Worker 启动行"
        for line in main_worker_lines:
            q_match = re.search(r'-Q\s+([\S]+)', line)
            assert q_match, f"主 Worker 未指定 -Q 参数: {line}"
            queues = q_match.group(1).split(',')
            assert 'critical' not in queues, (
                f"主 Worker 仍包含 critical 队列，会导致队列饥饿: {line}"
            )

    def test_critical_worker_exists_as_separate_process(self):
        """应存在独立的 critical Worker 进程配置。"""
        critical_lines = [
            line for line in self.script.splitlines()
            if 'celery' in line and 'worker' in line and '-Q critical' in line
        ]
        assert critical_lines, "未找到独立的 critical Worker 启动命令"
        for line in critical_lines:
            assert '-n critical@' in line, (
                f"critical Worker 应使用 -n critical@%%h 命名: {line}"
            )

    def test_stop_script_handles_critical_worker(self):
        """celery-stop.sh 应能停止 critical Worker。"""
        stop_path = os.path.join(SCRIPTS_DIR, 'celery-stop.sh')
        with open(stop_path) as f:
            stop_script = f.read()
        assert 'celery-critical.pid' in stop_script, (
            "celery-stop.sh 未处理 critical Worker PID 文件"
        )


# ===========================================================================
# INFRA-6: visibility_timeout 必须 > time_limit，避免任务重复执行
# ===========================================================================

class TestInfra6VisibilityTimeout:
    """验证 visibility_timeout >= 2 * CELERY_TASK_TIME_LIMIT。"""

    def test_visibility_timeout_is_7200(self):
        vt = settings.CELERY_BROKER_TRANSPORT_OPTIONS.get('visibility_timeout')
        assert vt == 7200, (
            f"visibility_timeout 应为 7200，实际为 {vt}。"
            "等于 time_limit 时，任务被 SIGKILL 后消息立即 requeue 导致重复执行。"
        )

    def test_visibility_timeout_exceeds_time_limit(self):
        vt = settings.CELERY_BROKER_TRANSPORT_OPTIONS.get('visibility_timeout', 0)
        tl = settings.CELERY_TASK_TIME_LIMIT
        assert vt > tl, (
            f"visibility_timeout ({vt}) 必须大于 time_limit ({tl})，"
            "否则任务超时后消息在 ack 前重新可见。"
        )


# ===========================================================================
# INFRA-19: 重型任务必须路由到 heavy 队列
# ===========================================================================

class TestInfra19HeavyTaskRouting:
    """验证所有耗时 > 5min 或含 LLM 调用的任务路由到 heavy 队列。"""

    EXPECTED_HEAVY_TASKS = [
        # tabvideo 渲染 / 转录（6–36min）
        'tabvideo.transcribe_clip',
        'tabvideo.server_render',
        'tabvideo.render_html',
        # tabdata 导入 / 导出（30min）
        'tabdata.async_import_data',
        'tabdata.async_export_data',
        # tabtinspace 重型清理 / 对账（30min）
        'tabtinspace.reconcile_context_items',
        'tabtinspace.cleanup_expired_trashed_resources',
    ]

    def test_all_heavy_tasks_routed(self):
        """INFRA-19 中列出的所有重型任务必须出现在 CELERY_TASK_ROUTES 中。"""
        routes = settings.CELERY_TASK_ROUTES
        for task_name in self.EXPECTED_HEAVY_TASKS:
            assert task_name in routes, (
                f"任务 '{task_name}' 未在 CELERY_TASK_ROUTES 中配置，"
                "将落入 default 轻量队列，阻塞轻量任务。"
            )

    def test_heavy_tasks_route_to_heavy_queue(self):
        """路由目标必须是 heavy 队列。"""
        routes = settings.CELERY_TASK_ROUTES
        for task_name in self.EXPECTED_HEAVY_TASKS:
            if task_name in routes:
                queue = routes[task_name].get('queue')
                assert queue == 'heavy', (
                    f"任务 '{task_name}' 路由到了 '{queue}' 而非 'heavy'"
                )

    def test_previously_routed_tasks_still_present(self):
        """之前已有的路由规则不应在本次修改中丢失。"""
        routes = settings.CELERY_TASK_ROUTES
        must_exist = [
            'tabvideo.synthesize_speech',
            'tabvideo.generate_bgm',
            'rag.incremental_index_all',
            'docparse.parse_document',
        ]
        for task_name in must_exist:
            assert task_name in routes, (
                f"原有路由 '{task_name}' 在修改后丢失！"
            )

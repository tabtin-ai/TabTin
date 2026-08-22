"""W1c · validate_wire_capabilities / llm_capability_test 命令 smoke 测试。

注:用 subprocess 调 manage.py(避免 pytest sqlite test DB 与真实库 schema 不兼容)。

测试只在本地 DB 可用时跑(MySQL connection ok),CI 跳过。
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest

from django.test import SimpleTestCase

# 跑命令用 manage.py 在 apps/tabtin_django 子进程
PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..")
)
MANAGE_PY = os.path.join(PROJECT_ROOT, "manage.py")
PYTHON_BIN = os.path.join(PROJECT_ROOT, "venv", "bin", "python")


def _can_run_subprocess() -> bool:
    return os.path.isfile(MANAGE_PY) and os.path.isfile(PYTHON_BIN)


@unittest.skipUnless(_can_run_subprocess(), "manage.py / venv 不可用")
class ValidateCommandSubprocessTests(SimpleTestCase):
    """子进程跑 validate_wire_capabilities 命令(避免测试 DB 不兼容)。"""

    def _run(self, *args, save_report=None, expect_exit=None):
        cmd = [PYTHON_BIN, MANAGE_PY, "validate_wire_capabilities", *args]
        if save_report:
            cmd.append(f"--save-report={save_report}")
        proc = subprocess.run(
            cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=120,
        )
        if expect_exit is not None:
            self.assertEqual(proc.returncode, expect_exit,
                             msg=f"stderr:\n{proc.stderr}\nstdout:\n{proc.stdout}")
        return proc

    def test_all_active_passes(self):
        proc = self._run("--all-active", expect_exit=0)
        self.assertIn("PASS", proc.stdout)

    def test_model_filter(self):
        proc = self._run("--model=kimi")
        self.assertIn("kimi", proc.stdout)

    def test_save_report_writes_json(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as fp:
            path = fp.name
        try:
            self._run("--all-active", save_report=path)
            with open(path, encoding="utf-8") as fp:
                data = json.load(fp)
            self.assertEqual(data["version"], "W1c.validate_wire_capabilities.v1")
            self.assertGreater(len(data["models"]), 0)
        finally:
            os.unlink(path)


@unittest.skipUnless(_can_run_subprocess(), "manage.py / venv 不可用")
class CapabilityTestCommandSubprocessTests(SimpleTestCase):

    def _run(self, *args):
        cmd = [PYTHON_BIN, MANAGE_PY, "llm_capability_test", *args, "--dry-run"]
        return subprocess.run(
            cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=120,
        )

    def test_dry_run_all_active(self):
        proc = self._run("--all-active")
        self.assertIn(proc.returncode, (0, 1))
        self.assertIn("dry-run", proc.stdout)

    def test_specific_probe(self):
        proc = self._run("--all-active", "--probe=basic_chat")
        # 表头列宽截断到 8 字符,所以匹配 "basic_ch"
        self.assertIn("basic_ch", proc.stdout)
        self.assertIn("9 model", proc.stdout)
        self.assertIn("1 probe", proc.stdout)

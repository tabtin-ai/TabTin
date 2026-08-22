from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _native_fixture(tmp_path: Path) -> Path:
    root = tmp_path / "TabTin Community Source"
    scripts = root / "scripts" / "backend"
    django = root / "apps" / "tabtin_django"
    scripts.mkdir(parents=True)
    django.mkdir(parents=True)
    prepare_source = ROOT / "scripts" / "backend" / "prepare-native-dev.sh"
    if prepare_source.is_file():
        shutil.copy2(prepare_source, scripts)
    else:
        _write_executable(scripts / "prepare-native-dev.sh", "#!/bin/sh\nexit 0\n")
    shutil.copy2(ROOT / "scripts" / "backend" / "generate-local-env-secrets.py", scripts)
    shutil.copy2(ROOT / ".env.example", root / ".env.example")
    shutil.copy2(ROOT / "scripts" / "backend" / "start.sh", scripts)
    for helper in (
        "_load-scheme.sh",
        "_centrifugo-helpers.sh",
        "_detach-spawn.sh",
        "_http-health.sh",
    ):
        (scripts / helper).write_text("", encoding="utf-8")
    shutil.copy2(ROOT / "scripts" / "backend" / "_env-key.sh", scripts)
    (scripts / "_redis-ready.sh").write_text(
        """REDIS_HOST=127.0.0.1
REDIS_PORT=6379
_tabtin_infra_label() { printf 'fixture'; }
_infra_try_start() { return 0; }
_ensure_redis_ready() { return 0; }
""",
        encoding="utf-8",
    )
    _write_executable(
        scripts / "db-prepare.sh",
        """#!/bin/sh
test -n "${CREDENTIAL_ENCRYPTION_KEY:-}" || exit 76
exit 77
""",
    )
    _write_executable(
        scripts / "django-setup.sh",
        """#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname "$0")/../../apps/tabtin_django/venv/bin"
ln -s "$TABTIN_TEST_PYTHON" "$(dirname "$0")/../../apps/tabtin_django/venv/bin/python"
printf 'setup\n' >> "$(dirname "$0")/../../setup.trace"
""",
    )
    return root


def _run_prepare(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/bash", str(root / "scripts" / "backend" / "prepare-native-dev.sh")],
        cwd=Path("/"),
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": os.environ.get("HOME", ""),
            "TABTIN_TEST_PYTHON": sys.executable,
        },
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_fresh_native_checkout_creates_local_config_and_python_environment(
    tmp_path: Path,
) -> None:
    root = _native_fixture(tmp_path)

    result = _run_prepare(root)

    assert result.returncode == 0, result.stdout + result.stderr
    env_file = root / ".env"
    assert env_file.is_file()
    generated = env_file.read_text(encoding="utf-8")
    assert "TABTIN_EDITION=community" in generated
    assert "TABTIN_REQUIRE_INVITE_CODE=false" in generated
    assert "QWEN_BASE_URL=\n" in generated
    assert "dashscope.aliyuncs.com" not in generated
    for key in (
        "SECRET_KEY",
        "JWT_SECRET_KEY",
        "CREDENTIAL_ENCRYPTION_KEY",
        "CENTRIFUGO_API_KEY",
        "CENTRIFUGO_PROXY_SECRET",
        "CENTRIFUGO_TOKEN_SECRET",
    ):
        value = next(line.split("=", 1)[1] for line in generated.splitlines() if line.startswith(f"{key}="))
        assert value
    assert (root / "apps/tabtin_django/venv/bin/python").is_file()
    assert (root / "setup.trace").read_text(encoding="utf-8") == "setup\n"


def test_native_prepare_preserves_existing_config_and_python_environment(
    tmp_path: Path,
) -> None:
    root = _native_fixture(tmp_path)
    (root / ".env").write_text("LOCAL_VALUE=keep-me\n", encoding="utf-8")
    local_secret = "existing-local-secret-key"
    (root / ".env.local").write_text(
        f"SECRET_KEY={local_secret}\nCREDENTIAL_ENCRYPTION_KEY=\n",
        encoding="utf-8",
    )
    python = root / "apps/tabtin_django/venv/bin/python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)

    result = _run_prepare(root)

    assert result.returncode == 0, result.stdout + result.stderr
    generated = (root / ".env").read_text(encoding="utf-8")
    assert generated.startswith("LOCAL_VALUE=keep-me\n")
    expected_credential = base64.urlsafe_b64encode(
        hashlib.sha256(local_secret.encode()).digest()
    ).decode()
    assert f"CREDENTIAL_ENCRYPTION_KEY={expected_credential}" in generated
    assert not (root / "setup.trace").exists()


def test_standard_native_start_prepares_checkout_before_database_start(
    tmp_path: Path,
) -> None:
    root = _native_fixture(tmp_path)

    result = subprocess.run(
        ["/bin/bash", str(root / "scripts" / "backend" / "start.sh")],
        cwd=Path("/"),
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": os.environ.get("HOME", ""),
            "TABTIN_TEST_PYTHON": sys.executable,
        },
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert result.returncode == 77, result.stdout + result.stderr
    assert (root / ".env").is_file()
    assert (root / "apps/tabtin_django/venv/bin/python").is_file()


def _import_invite_setting(value: str | None) -> subprocess.CompletedProcess[str]:
    env = {
        "PYTHONPATH": str(ROOT / "apps/tabtin_django"),
        "DJANGO_SETTINGS_MODULE": "tabtin.settings",
        "TABTIN_EDITION": "community",
        "DEBUG": "true",
        "SECRET_KEY": "native-bootstrap-test-only",
    }
    if value is not None:
        env["TABTIN_REQUIRE_INVITE_CODE"] = value
    script = """
import dotenv
dotenv.load_dotenv = lambda *args, **kwargs: False
from django.conf import settings
print('enabled' if settings.TABTIN_REQUIRE_INVITE_CODE else 'disabled')
"""
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_community_invite_gate_is_disabled_by_default() -> None:
    result = _import_invite_setting(None)

    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip().splitlines()[-1] == "disabled"


def test_community_invite_gate_can_be_explicitly_enabled() -> None:
    result = _import_invite_setting("true")

    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip().splitlines()[-1] == "enabled"


def test_missing_invite_settings_fail_open_for_first_run() -> None:
    env = {
        "PYTHONPATH": str(ROOT / "apps/tabtin_django"),
        "DJANGO_SETTINGS_MODULE": "tabtin.settings",
        "TABTIN_EDITION": "community",
        "DEBUG": "true",
        "SECRET_KEY": "native-bootstrap-test-only",
    }
    script = """
import dotenv
dotenv.load_dotenv = lambda *args, **kwargs: False
import django
django.setup()
from django.test import override_settings
from apps.users.auth.services.invite_code_service import is_invite_gate_enabled
with override_settings(TABTIN_REQUIRE_INVITE_CODE=None, REQUIRE_INVITE_CODE=None):
    print('enabled' if is_invite_gate_enabled() else 'disabled')
"""

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip().splitlines()[-1] == "disabled"

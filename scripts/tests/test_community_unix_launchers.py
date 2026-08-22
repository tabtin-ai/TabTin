from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
LAUNCHERS = ("start", "stop", "status")


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _launcher_fixture() -> tuple[tempfile.TemporaryDirectory[str], Path, Path, Path]:
    temporary = tempfile.TemporaryDirectory(prefix="tabtin unix launcher ")
    root = Path(temporary.name) / "TabTin Community Source"
    root.mkdir()
    for name in LAUNCHERS:
        shutil.copy2(ROOT / f"{name}.sh", root / f"{name}.sh")
        shutil.copy2(ROOT / f"{name}.command", root / f"{name}.command")
    shutil.copy2(ROOT / "compose.yaml", root / "compose.yaml")

    fake_bin = Path(temporary.name) / "fake bin"
    fake_bin.mkdir()
    trace = Path(temporary.name) / "trace.log"
    _write_executable(
        fake_bin / "docker",
        """#!/bin/sh
printf 'docker %s\\n' "$*" >> "$TRACE_FILE"
case "$*" in
  "info") [ "${FAKE_DOCKER_ENGINE:-up}" = "up" ] ;;
  *"ps --status running --services"*)
    [ "${FAKE_DJANGO_RUNNING:-0}" = "1" ] && printf 'django\\n'
    ;;
esac
""",
    )
    _write_executable(
        fake_bin / "curl",
        """#!/bin/sh
printf 'curl %s\\n' "$*" >> "$TRACE_FILE"
case "$*" in
  *6060/health/ready*) [ "${FAKE_SERVER_READY:-0}" = "1" ] ;;
  *8100/health*) [ "${FAKE_REALTIME_READY:-0}" = "1" ] ;;
  *) exit 1 ;;
esac
""",
    )
    return temporary, root, fake_bin, trace


def _run(
    script: Path,
    *,
    cwd: Path,
    fake_bin: Path,
    trace: Path,
    extra_env: dict[str, str] | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = {
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "TRACE_FILE": str(trace),
        "HOME": os.environ.get("HOME", ""),
        "COMPOSE_DISABLE_ENV_FILE": "1",
        **(extra_env or {}),
    }
    return subprocess.run(
        ["/bin/bash", str(script)],
        cwd=cwd,
        env=environment,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=10,
    )


def test_start_works_from_non_repo_cwd_when_source_path_contains_spaces() -> None:
    temporary, root, fake_bin, trace = _launcher_fixture()
    with temporary:
        outside = Path(temporary.name) / "outside cwd"
        outside.mkdir()
        result = _run(
            root / "start.sh",
            cwd=outside,
            fake_bin=fake_bin,
            trace=trace,
            extra_env={"FAKE_SERVER_READY": "1"},
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "TabTin Community is READY" in result.stdout
        calls = trace.read_text(encoding="utf-8")
        physical_root = root.resolve()
        assert (
            f"--project-directory {physical_root} "
            f"-f {physical_root / 'compose.yaml'} up -d --build"
        ) in calls


def test_start_reports_missing_docker_and_stopped_engine_without_mutation() -> None:
    temporary, root, fake_bin, trace = _launcher_fixture()
    with temporary:
        (fake_bin / "docker").unlink()
        missing = _run(root / "start.sh", cwd=Path("/"), fake_bin=fake_bin, trace=trace)
        assert missing.returncode != 0
        assert "Docker is not installed" in missing.stdout + missing.stderr
        assert not trace.exists()

        _write_executable(
            fake_bin / "docker",
            """#!/bin/sh
printf 'docker %s\\n' "$*" >> "$TRACE_FILE"
[ "$*" != "info" ]
""",
        )
        stopped = _run(root / "start.sh", cwd=Path("/"), fake_bin=fake_bin, trace=trace)
        assert stopped.returncode != 0
        assert "Docker Engine is not running" in stopped.stdout + stopped.stderr
        assert " up " not in trace.read_text(encoding="utf-8")


def test_repeated_start_is_idempotent_and_never_deletes_data() -> None:
    temporary, root, fake_bin, trace = _launcher_fixture()
    with temporary:
        for _ in range(2):
            result = _run(
                root / "start.sh",
                cwd=Path("/"),
                fake_bin=fake_bin,
                trace=trace,
                extra_env={"FAKE_SERVER_READY": "1"},
            )
            assert result.returncode == 0, result.stdout + result.stderr
        calls = trace.read_text(encoding="utf-8")
        assert calls.count("up -d --build") == 2
        assert "down -v" not in calls
        assert "prune" not in calls


def test_stop_targets_only_community_compose_and_preserves_volumes() -> None:
    temporary, root, fake_bin, trace = _launcher_fixture()
    with temporary:
        result = _run(root / "stop.sh", cwd=Path("/"), fake_bin=fake_bin, trace=trace)
        assert result.returncode == 0, result.stdout + result.stderr
        calls = trace.read_text(encoding="utf-8")
        physical_root = root.resolve()
        assert (
            f"--project-directory {physical_root} "
            f"-f {physical_root / 'compose.yaml'} down"
        ) in calls
        assert "down -v" not in calls
        assert "volume prune" not in calls
        assert "system prune" not in calls


def test_status_is_read_only_and_distinguishes_starting_from_not_ready() -> None:
    temporary, root, fake_bin, trace = _launcher_fixture()
    with temporary:
        starting = _run(
            root / "status.sh",
            cwd=Path("/"),
            fake_bin=fake_bin,
            trace=trace,
            extra_env={"FAKE_DJANGO_RUNNING": "1"},
        )
        assert starting.returncode == 0, starting.stdout + starting.stderr
        assert "Docker: RUNNING" in starting.stdout
        assert "TabTin Server: STARTING" in starting.stdout
        assert "Realtime: NOT READY" in starting.stdout
        calls = trace.read_text(encoding="utf-8")
        assert " compose " in calls
        for mutation in (" up ", " down", "restart", "prune", " rm "):
            assert mutation not in calls

        trace.write_text("", encoding="utf-8")
        ready = _run(
            root / "status.sh",
            cwd=Path("/"),
            fake_bin=fake_bin,
            trace=trace,
            extra_env={"FAKE_SERVER_READY": "1", "FAKE_REALTIME_READY": "1"},
        )
        assert ready.returncode == 0, ready.stdout + ready.stderr
        assert "TabTin Server: READY" in ready.stdout
        assert "Realtime: READY" in ready.stdout


def test_command_files_are_thin_executable_delegates() -> None:
    temporary, root, fake_bin, trace = _launcher_fixture()
    with temporary:
        for name in LAUNCHERS:
            target = root / f"{name}.sh"
            _write_executable(
                target,
                f"#!/bin/sh\nprintf '{name} delegated\\n'\n",
            )
            result = _run(
                root / f"{name}.command",
                cwd=Path("/"),
                fake_bin=fake_bin,
                trace=trace,
                input_text="\n",
            )
            assert result.returncode == 0, result.stdout + result.stderr
            assert f"{name} delegated" in result.stdout
            assert "Press Enter to close" in result.stdout


def test_launchers_are_executable_and_docs_expose_platform_entrypoints() -> None:
    for name in LAUNCHERS:
        for suffix in (".sh", ".command"):
            mode = (ROOT / f"{name}{suffix}").stat().st_mode
            assert mode & stat.S_IXUSR

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    guide = (ROOT / "COMMUNITY_OPEN_SOURCE_GUIDE.md").read_text(encoding="utf-8")
    for content in (readme, guide):
        assert "start.command" in content
        assert "start.sh" in content
        assert "stop.command" in content
        assert "status.command" in content


def test_compose_remains_the_same_five_service_contract() -> None:
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            str(ROOT / "compose.yaml"),
            "config",
            "--services",
        ],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", ""),
            "COMPOSE_DISABLE_ENV_FILE": "1",
        },
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert set(result.stdout.splitlines()) == {
        "postgres",
        "redis",
        "django",
        "celery",
        "centrifugo",
    }

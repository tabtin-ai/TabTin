from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _text(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def test_windows_start_checks_docker_waits_for_ready_and_prints_next_steps() -> None:
    source = _text("start.bat")
    lowered = source.lower()

    for contract in (
        "docker --version",
        "docker compose version",
        "docker info",
        "set compose_disable_env_file=1",
        "docker compose up -d --build",
        "http://127.0.0.1:6060/health/ready",
        "tabtin community is ready",
        "settings",
        "model configuration",
        "byok",
        "http://127.0.0.1:6060",
    ):
        assert contract in lowered

    for forbidden in (
        "postgres_password",
        "secret_key",
        "jwt_secret",
        "credential_encryption",
        "safe_migrate",
        "tabtin_bootstrap",
    ):
        assert forbidden not in lowered


def test_windows_stop_preserves_data_and_only_stops_community_compose() -> None:
    source = _text("stop.bat").lower()
    assert "set compose_disable_env_file=1" in source
    assert "docker compose down" in source
    for forbidden in ("down -v", "system prune", "volume prune", "docker stop"):
        assert forbidden not in source


def test_windows_status_is_read_only_and_reports_public_health() -> None:
    source = _text("status.bat").lower()
    for contract in (
        "docker info",
        "http://127.0.0.1:6060/health/ready",
        "http://127.0.0.1:8100/health",
        "docker: running",
        "docker: not running",
        "tabtin server: ready",
        "tabtin server: not ready",
        "centrifugo: ready",
        "centrifugo: not ready",
    ):
        assert contract in source
    for forbidden in ("docker compose up", "docker compose down", "/api/services/llm"):
        assert forbidden not in source


def test_public_docs_have_the_same_windows_quick_start() -> None:
    for name in ("README.md", "COMMUNITY_OPEN_SOURCE_GUIDE.md"):
        source = _text(name).lower()
        for contract in (
            "https://www.docker.com/products/docker-desktop/",
            "download tabtin source",
            "start.bat",
            "tabtin desktop client",
            "register / login",
            "settings",
            "model configuration",
            "byok",
            "start chat",
        ):
            assert contract in source, f"{name}: missing {contract}"

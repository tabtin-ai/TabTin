from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _compose() -> dict:
    return yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))


def test_five_service_installation_is_serial_and_runtime_only() -> None:
    compose = _compose()
    services = compose["services"]
    assert set(services) == {"postgres", "redis", "django", "celery", "centrifugo"}

    django = services["django"]
    celery = services["celery"]
    assert django["command"] == ["community-web"]
    assert django["user"] == "0:0"
    assert celery["command"] == ["worker"]
    assert celery["user"] == "10001:10001"
    assert services["centrifugo"]["user"] == "10001:10001"

    runtime_environment = celery["environment"]
    assert runtime_environment["PG_DB_USER"] == "tabtin_runtime"
    assert runtime_environment["PG_DB_PASSWORD_FILE"].endswith("PG_RUNTIME_PASSWORD")
    assert "PG_INIT_PASSWORD_FILE" not in runtime_environment
    assert "PG_MIGRATOR_PASSWORD_FILE" not in runtime_environment

    entrypoint = (
        ROOT / "apps/tabtin_django/docker-entrypoint.sh"
    ).read_text(encoding="utf-8")
    community_case = entrypoint.index("community-web)")
    ordered_steps = (
        "python -m tabtin.community_secrets init",
        "python -m tabtin.community_database sync",
        "safe_migrate --noinput",
        "python -m tabtin.community_database finalize",
        "tabtin_bootstrap --edition community",
        "tabtin.asgi:application",
    )
    positions = [entrypoint.index(step, community_case) for step in ordered_steps]
    assert positions == sorted(positions)


def test_community_assets_are_self_contained_and_compose_has_no_fixed_secret() -> None:
    raw = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    dockerfile = (
        ROOT / "apps/tabtin_django/Dockerfile"
    ).read_text(encoding="utf-8")

    assert "COPY community-assets/postgres /app/community-assets/postgres" in dockerfile
    assert "ARG INSTALL_PLAYWRIGHT=true" in dockerfile
    assert 'if [ "$INSTALL_PLAYWRIGHT" = "true" ]' in dockerfile
    assert "deployment/" not in raw.lower()
    assert "POSTGRES_PASSWORD:" not in raw
    assert "SECRET_KEY:" not in raw
    assert "JWT_SECRET_KEY:" not in raw
    assert "CREDENTIAL_ENCRYPTION_KEY:" not in raw

    sql_root = ROOT / "community-assets/postgres"
    assert sorted(path.name for path in sql_root.glob("*.sql")) == [
        "10-foundation.sql",
        "20-capabilities.sql",
    ]


def test_community_does_not_require_a_model_at_startup() -> None:
    environment = _compose()["services"]["django"]["environment"]
    assert "LLM_BASE_URL" not in environment
    assert "LLM_API_KEY" not in environment
    assert "LLM_MODEL" not in environment
    assert environment["RUN_BOOTSTRAP"] == "false"


def test_loopback_installation_keeps_local_storage_client_reachable() -> None:
    """The localhost-only developer profile must pass upstream local OSS checks."""

    environment = _compose()["services"]["django"]["environment"]
    assert environment["TABTIN_PUBLIC_BASE_URL"] == "http://127.0.0.1:6060"
    assert environment["SERVICES_OSS_PROVIDER"] == "local"
    # Upstream deliberately rejects loopback object URLs in production mode.
    # This official profile is bound to 127.0.0.1 and is therefore a local
    # developer installation, not an Internet-facing production deployment.
    assert environment["DEBUG"] == "True"


def test_golden_path_probe_uses_only_existing_public_product_contracts() -> None:
    probe = ROOT / "apps/tabtin_django/tabtin/community_golden_path.py"
    assert probe.is_file()
    source = probe.read_text(encoding="utf-8")
    for contract in (
        "/api/auth/register",
        "/api/auth/login",
        "/api/context/devices/register",
        "/api/context/devices/heartbeat",
        "/api/context/workspaces/ensure-home",
        "/api/services/llm/organizations/",
        "/api/chat/sessions",
        "chat.send_message",
        "agent.prompt.forward",
        "/api/services/llm/chat",
        "agent.stream.persist_message",
    ):
        assert contract in source
    assert "apps.tabchat" not in source

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess


ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = ROOT / "compose.yaml"
COMMUNITY_COMMAND = ROOT / "community"


def _resolved_compose() -> dict:
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "COMPOSE_DISABLE_ENV_FILE": "1",
    }
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            str(COMPOSE_FILE),
            "config",
            "--format",
            "json",
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


def test_official_community_installation_has_one_five_service_interface() -> None:
    assert COMPOSE_FILE.is_file()
    assert COMMUNITY_COMMAND.is_file()
    assert COMMUNITY_COMMAND.stat().st_mode & stat.S_IXUSR

    compose = _resolved_compose()
    services = compose["services"]
    assert compose["name"] == "tabtin-community"
    assert set(services) == {
        "postgres",
        "redis",
        "django",
        "celery",
        "centrifugo",
    }

    assert services["postgres"]["image"] == "pgvector/pgvector:pg16"
    assert services["redis"]["image"] == "redis:8-alpine"
    assert services["centrifugo"]["image"] == "centrifugo/centrifugo:v6"
    assert services["django"]["build"]["args"]["INSTALL_PLAYWRIGHT"] == "true"

    assert "ports" not in services["postgres"]
    assert "ports" not in services["redis"]
    assert services["django"]["ports"] == [
        {
            "mode": "ingress",
            "host_ip": "127.0.0.1",
            "target": 6060,
            "published": "6060",
            "protocol": "tcp",
        }
    ]
    assert services["centrifugo"]["ports"] == [
        {
            "mode": "ingress",
            "host_ip": "127.0.0.1",
            "target": 8100,
            "published": "8100",
            "protocol": "tcp",
        }
    ]

    raw_manifest = COMPOSE_FILE.read_text(encoding="utf-8").lower()
    resolved = json.dumps(compose, sort_keys=True).lower()
    for forbidden in (
        "deployment/",
        "ack-test",
        "aliyun",
        "preprod",
        "api-test.example.com",
        "docker-compose.test",
        "api.example.com",
        "ws.example.com",
        "gptapi.xmov.ai",
        "tabtin-acr-registry",
    ):
        assert forbidden not in raw_manifest
        assert forbidden not in resolved

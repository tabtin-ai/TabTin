from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from tabtin.community_secrets import ensure_installation_secrets, secret_file_paths


DJANGO_ROOT = Path(__file__).resolve().parents[2]
_TEST_CREDENTIAL_KEY = base64.urlsafe_b64encode(
    hashlib.sha256(b"phase-2-1-settings-credential-key").digest()
).decode("ascii")


def _import_settings(
    *,
    edition: str | None,
    include_saas_secrets: bool,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = {
        "PYTHONPATH": str(DJANGO_ROOT),
        "DJANGO_SETTINGS_MODULE": "tabtin.settings",
        "DEBUG": "false",
        "SECRET_KEY": "phase-2-1-settings-secret-not-a-default",
        "PG_DB_PASSWORD": "phase-2-1-postgres-password",
        "JWT_SECRET_KEY": "phase-2-1-jwt-secret",
        "CREDENTIAL_ENCRYPTION_KEY": _TEST_CREDENTIAL_KEY,
        "CENTRIFUGO_API_KEY": "phase-2-1-centrifugo-api-key",
        "CENTRIFUGO_TOKEN_SECRET": "phase-2-1-centrifugo-token-secret",
        "CENTRIFUGO_PROXY_SECRET": "phase-2-1-centrifugo-proxy-secret",
        "DAEMON_TOKEN_SECRET": "",
        "SOURCEMAP_UPLOAD_KEY": "",
        "ENABLE_HTTPS_SECURITY": "false",
        "OPENAI_API_KEY": "",
        "EMAIL_HOST_USER": "",
        "EMAIL_HOST_PASSWORD": "",
        "OPENAI_BASE_URL": "",
        "QWEN_BASE_URL": "",
        "DAEMON_SERVER_URL": "",
        "DAEMON_WS_URL": "",
        "SERVICES_OSS_PROVIDER": "",
        "TABTIN_PUBLIC_BASE_URL": "",
        "UPDATER_OSS_ENDPOINT": "",
        "UPDATER_CDN_ENDPOINT": "",
        "EMAIL_HOST": "",
        "EMAIL_BACKEND": "",
        "SERVICES_EMAIL_PROVIDER": "",
    }
    if edition is not None:
        env["TABTIN_EDITION"] = edition
    if include_saas_secrets:
        env.update(
            {
                "OPENAI_API_KEY": "saas-openai-key",
                "EMAIL_HOST_USER": "saas@example.test",
                "EMAIL_HOST_PASSWORD": "saas-email-password",
                "DAEMON_TOKEN_SECRET": "phase-2-1-daemon-token-secret",
                "SOURCEMAP_UPLOAD_KEY": "phase-2-1-sourcemap-upload-key",
            }
        )
        for key in (
            "OPENAI_BASE_URL",
            "QWEN_BASE_URL",
            "DAEMON_SERVER_URL",
            "DAEMON_WS_URL",
            "SERVICES_OSS_PROVIDER",
            "TABTIN_PUBLIC_BASE_URL",
            "UPDATER_OSS_ENDPOINT",
            "UPDATER_CDN_ENDPOINT",
            "EMAIL_HOST",
            "EMAIL_BACKEND",
            "SERVICES_EMAIL_PROVIDER",
        ):
            env.pop(key, None)
    env.update(extra_env or {})

    script = """
import json
import dotenv

dotenv.load_dotenv = lambda *args, **kwargs: False
import tabtin.settings as settings

print("EDITION_RESULT=" + json.dumps({
    "edition": settings.TABTIN_EDITION,
    "openai_api_key": settings.OPENAI_API_KEY,
    "openai_base_url": settings.OPENAI_BASE_URL,
    "qwen_base_url": settings.QWEN_BASE_URL,
    "ark_base_url": settings.ARK_BASE_URL,
    "daemon_server_url": settings.DAEMON_SERVER_URL,
    "daemon_ws_url": settings.DAEMON_WS_URL,
    "storage_provider": settings.SERVICES_OSS_PROVIDER,
    "public_base_url": settings.TABTIN_PUBLIC_BASE_URL,
    "local_public_base_url": settings.LOCAL_OSS_PUBLIC_BASE_URL,
    "updater_oss_endpoint": settings.UPDATER_OSS_ENDPOINT,
    "updater_cdn_endpoint": settings.UPDATER_CDN_ENDPOINT,
    "aliyun_oss_endpoint": settings.ALIYUN_OSS_ENDPOINT,
    "email_provider": settings.SERVICES_EMAIL_PROVIDER,
    "email_backend": settings.EMAIL_BACKEND,
    "email_host": settings.EMAIL_HOST,
    "email_user": settings.EMAIL_HOST_USER,
    "email_provider_configured": settings.EMAIL_PROVIDER_CONFIGURED,
    "database_name": settings.DATABASES["default"]["NAME"],
    "database_user": settings.DATABASES["default"]["USER"],
}, sort_keys=True))
"""
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=DJANGO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def _payload(result: subprocess.CompletedProcess[str]) -> dict:
    assert result.returncode == 0, result.stdout + result.stderr
    result_line = next(
        line for line in result.stdout.splitlines()
        if line.startswith("EDITION_RESULT=")
    )
    return json.loads(result_line.removeprefix("EDITION_RESULT="))


def test_community_settings_start_without_ai_or_email_provider() -> None:
    payload = _payload(
        _import_settings(edition="community", include_saas_secrets=False)
    )

    assert payload == {
        "aliyun_oss_endpoint": "",
        "ark_base_url": "",
        "daemon_server_url": "",
        "daemon_ws_url": "",
        "database_name": "tabtin",
        "database_user": "tabtin_runtime",
        "edition": "community",
        "email_backend": "django.core.mail.backends.console.EmailBackend",
        "email_host": "",
        "email_provider": "disabled",
        "email_provider_configured": False,
        "email_user": "",
        "local_public_base_url": "http://127.0.0.1:6060/api/services/oss/local-object",
        "openai_api_key": "",
        "openai_base_url": "",
        "public_base_url": "http://127.0.0.1:6060",
        "qwen_base_url": "",
        "storage_provider": "local",
        "updater_cdn_endpoint": "",
        "updater_oss_endpoint": "",
    }


def test_community_settings_keep_explicit_third_party_endpoints() -> None:
    payload = _payload(
        _import_settings(
            edition="community",
            include_saas_secrets=False,
            extra_env={
                "OPENAI_BASE_URL": "https://llm.community.example/v1",
                "TABTIN_PUBLIC_BASE_URL": "https://server.community.example",
            },
        )
    )

    assert payload["openai_base_url"] == "https://llm.community.example/v1"
    assert payload["public_base_url"] == "https://server.community.example"
    assert payload["local_public_base_url"] == (
        "https://server.community.example/api/services/oss/local-object"
    )


def test_community_settings_consume_generated_secret_files(tmp_path: Path) -> None:
    secret_root = tmp_path / "installation-secrets"
    values = ensure_installation_secrets(secret_root)
    paths = secret_file_paths(secret_root)
    env = {
        "PYTHONPATH": str(DJANGO_ROOT),
        "DJANGO_SETTINGS_MODULE": "tabtin.settings",
        "TABTIN_EDITION": "community",
        "DEBUG": "false",
        "SECRET_KEY_FILE": str(paths["SECRET_KEY"]),
        "JWT_SECRET_KEY_FILE": str(paths["JWT_SECRET_KEY"]),
        "CREDENTIAL_ENCRYPTION_KEY_FILE": str(paths["CREDENTIAL_ENCRYPTION_KEY"]),
        "CENTRIFUGO_API_KEY_FILE": str(paths["CENTRIFUGO_API_KEY"]),
        "CENTRIFUGO_TOKEN_SECRET_FILE": str(paths["CENTRIFUGO_TOKEN_SECRET"]),
        "CENTRIFUGO_PROXY_SECRET_FILE": str(paths["CENTRIFUGO_PROXY_SECRET"]),
        "PG_DB_PASSWORD_FILE": str(paths["PG_RUNTIME_PASSWORD"]),
        "ENABLE_HTTPS_SECURITY": "false",
        "OPENAI_BASE_URL": "",
        "QWEN_BASE_URL": "",
        "DAEMON_SERVER_URL": "",
        "DAEMON_WS_URL": "",
        "UPDATER_OSS_ENDPOINT": "",
        "UPDATER_CDN_ENDPOINT": "",
        "EMAIL_HOST": "",
        "EMAIL_BACKEND": "",
        "SERVICES_EMAIL_PROVIDER": "",
    }
    script = """
import json
import tabtin.settings as settings
print("SECRET_FILE_RESULT=" + json.dumps({
    "database_name": settings.DATABASES["default"]["NAME"],
    "database_user": settings.DATABASES["default"]["USER"],
    "secret_key_loaded": bool(settings.SECRET_KEY),
    "jwt_distinct": settings.JWT_SECRET_KEY != settings.SECRET_KEY,
    "credential_loaded": bool(settings.CREDENTIAL_ENCRYPTION_KEY),
    "centrifugo_distinct": len({
        settings.CENTRIFUGO_API_KEY,
        settings.CENTRIFUGO_TOKEN_SECRET,
        settings.CENTRIFUGO_PROXY_SECRET,
    }) == 3,
}))
"""

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=DJANGO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert all(value not in result.stdout + result.stderr for value in values.values())
    line = next(line for line in result.stdout.splitlines() if line.startswith("SECRET_FILE_RESULT="))
    assert json.loads(line.removeprefix("SECRET_FILE_RESULT=")) == {
        "database_name": "tabtin",
        "database_user": "tabtin_runtime",
        "secret_key_loaded": True,
        "jwt_distinct": True,
        "credential_loaded": True,
        "centrifugo_distinct": True,
    }


def test_community_production_settings_have_no_hardcoded_secret_fallback() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "import tabtin.settings"],
        cwd=DJANGO_ROOT,
        env={
            "PYTHONPATH": str(DJANGO_ROOT),
            "DJANGO_SETTINGS_MODULE": "tabtin.settings",
            "TABTIN_EDITION": "community",
            "DEBUG": "false",
        },
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode != 0
    assert "SECRET_KEY" in result.stderr


def test_community_settings_reject_an_explicit_company_endpoint() -> None:
    result = _import_settings(
        edition="community",
        include_saas_secrets=False,
        extra_env={"OPENAI_BASE_URL": "https://gptapi.xmov.ai/v1"},
    )

    assert result.returncode != 0
    assert "company endpoint" in result.stderr


def test_missing_edition_preserves_saas_settings_defaults() -> None:
    payload = _payload(
        _import_settings(edition=None, include_saas_secrets=True)
    )

    assert payload["edition"] == "saas"
    assert payload["openai_api_key"] == "saas-openai-key"
    assert payload["openai_base_url"] == "https://gptapi.xmov.ai/v1"
    assert payload["qwen_base_url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert payload["ark_base_url"] == "https://ark.cn-beijing.volces.com/api/v3"
    assert payload["daemon_server_url"] == "https://api.example.com"
    assert payload["daemon_ws_url"] == "wss://ws.example.com"
    assert payload["storage_provider"] == "aliyun"
    assert payload["email_provider"] == "tencent"
    assert payload["email_backend"] == "django.core.mail.backends.smtp.EmailBackend"
    assert payload["email_host"] == "smtp.exmail.qq.com"
    assert payload["email_provider_configured"] is True
    assert payload["database_name"] == "tabtin_single"
    assert payload["database_user"] == "tabtin_single"


def test_unknown_edition_makes_settings_import_fail_clearly() -> None:
    result = _import_settings(
        edition="self_hosted",
        include_saas_secrets=True,
    )

    assert result.returncode != 0
    assert "Unsupported TABTIN_EDITION" in result.stderr

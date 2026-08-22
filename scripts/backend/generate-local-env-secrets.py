#!/usr/bin/env python3
"""Fill missing local development secrets without printing their values."""

from __future__ import annotations

import base64
import os
from pathlib import Path
import secrets
import sys
import tempfile


SECRET_NAMES = (
    "SECRET_KEY",
    "JWT_SECRET_KEY",
    "CREDENTIAL_ENCRYPTION_KEY",
    "CENTRIFUGO_API_KEY",
    "CENTRIFUGO_PROXY_SECRET",
    "CENTRIFUGO_TOKEN_SECRET",
)

INSECURE_SECRET_KEY = "django-insecure-dev-placeholder-change-before-deploy"


def _values_from_lines(lines: list[str]) -> tuple[dict[str, int], dict[str, str]]:
    positions: dict[str, int] = {}
    values: dict[str, str] = {}
    for index, line in enumerate(lines):
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in SECRET_NAMES:
            positions[key] = index
            values[key] = value.strip()
    return positions, values


def _derived_credential_key(secret_key: str) -> str:
    """Match the legacy DEBUG fallback so existing local ciphertext stays readable."""
    import hashlib

    derived = hashlib.sha256(secret_key.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(derived).decode("ascii")


def fill_missing_secrets(env_file: Path, override_file: Path | None = None) -> list[str]:
    original = env_file.read_text(encoding="utf-8")
    lines = original.splitlines()
    positions, values = _values_from_lines(lines)
    override_values: dict[str, str] = {}
    if override_file is not None and override_file.is_file():
        _, override_values = _values_from_lines(
            override_file.read_text(encoding="utf-8").splitlines()
        )

    generated: list[str] = []
    for key in SECRET_NAMES:
        if override_values.get(key):
            continue
        current = values.get(key, "")
        if current and not (key == "SECRET_KEY" and current == INSECURE_SECRET_KEY):
            continue
        if key == "SECRET_KEY":
            value = f"django-insecure-{secrets.token_urlsafe(48)}"
        elif key == "CREDENTIAL_ENCRYPTION_KEY":
            effective_secret = override_values.get("SECRET_KEY") or values["SECRET_KEY"]
            value = _derived_credential_key(effective_secret)
        else:
            value = secrets.token_urlsafe(48)
        assignment = f"{key}={value}"
        if key in positions:
            lines[positions[key]] = assignment
        else:
            lines.append(assignment)
        values[key] = value
        generated.append(key)

    if not generated:
        return []

    rendered = "\n".join(lines) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=env_file.parent, delete=False
    ) as handle:
        handle.write(rendered)
        temporary = Path(handle.name)
    os.chmod(temporary, 0o600)
    os.replace(temporary, env_file)
    return generated


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(
            "usage: generate-local-env-secrets.py <env-file> [override-env-file]",
            file=sys.stderr,
        )
        return 2
    env_file = Path(sys.argv[1])
    override_file = Path(sys.argv[2]) if len(sys.argv) == 3 else None
    generated = fill_missing_secrets(env_file, override_file)
    if generated:
        print("✅ 已生成缺失的本地开发密钥：" + ", ".join(generated))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

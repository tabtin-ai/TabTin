"""Per-installation secrets for the Community edition.

The official installation path persists one opaque file per secret.  Runtime
processes receive only the files they consume, so values do not need to be
copied into container environments, command lines, images, or logs.
"""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sys
from typing import Iterator, Mapping

from cryptography.fernet import Fernet


logger = logging.getLogger(__name__)

APPLICATION_SECRET_NAMES = (
    "SECRET_KEY",
    "JWT_SECRET_KEY",
    "CREDENTIAL_ENCRYPTION_KEY",
    "CENTRIFUGO_API_KEY",
    "CENTRIFUGO_PROXY_SECRET",
    "CENTRIFUGO_TOKEN_SECRET",
)

DATABASE_SECRET_NAMES = (
    "PG_INIT_PASSWORD",
    "PG_MIGRATOR_PASSWORD",
    "PG_RUNTIME_PASSWORD",
)

ALL_SECRET_NAMES = APPLICATION_SECRET_NAMES + DATABASE_SECRET_NAMES
CENTRIFUGO_CONFIG_NAME = "centrifugo.json"
_SAFE_VALUE = re.compile(r"^[A-Za-z0-9_=-]{32,256}$")


def secret_file_paths(root: Path) -> dict[str, Path]:
    """Return the closed installation secret manifest."""
    return {name: root / name for name in ALL_SECRET_NAMES}


def read_secret_file(path: Path, *, label: str) -> str:
    """Read one URL-safe secret without normalising or mutating it."""
    try:
        value = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"missing {label} secret") from exc
    if not _SAFE_VALUE.fullmatch(value):
        raise ValueError(f"invalid {label} secret")
    return value


def _generate_secret(name: str) -> str:
    if name == "CREDENTIAL_ENCRYPTION_KEY":
        return Fernet.generate_key().decode("ascii")
    length = 64 if name in {"SECRET_KEY", "JWT_SECRET_KEY"} else 48
    return secrets.token_urlsafe(length)


def _atomic_write(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o440)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o440)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _exclusive_lock(path: Path) -> Iterator[None]:
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


def ensure_installation_secrets(
    root: Path,
    *,
    owner_uid: int | None = None,
    owner_gid: int | None = None,
) -> dict[str, str]:
    """Create missing installation secrets once and validate persisted values.

    Existing files are all validated before any missing file is generated.  A
    malformed installation therefore fails closed without silently rotating a
    different credential.
    """
    root.mkdir(mode=0o750, parents=True, exist_ok=True)
    paths = secret_file_paths(root)

    with _exclusive_lock(root / ".lock"):
        values: dict[str, str] = {}
        for name, path in paths.items():
            if path.exists():
                values[name] = read_secret_file(path, label=name)

        occupied = set(values.values())
        for name, path in paths.items():
            if name in values:
                continue
            value = _generate_secret(name)
            while value in occupied:
                value = _generate_secret(name)
            _atomic_write(path, value)
            values[name] = value
            occupied.add(value)

        if len(set(values.values())) != len(values):
            raise ValueError("Community installation secrets must be unique")
        Fernet(values["CREDENTIAL_ENCRYPTION_KEY"].encode("ascii"))

        for path in paths.values():
            os.chmod(path, 0o440)
            if owner_uid is not None or owner_gid is not None:
                os.chown(
                    path,
                    owner_uid if owner_uid is not None else -1,
                    owner_gid if owner_gid is not None else -1,
                )

    logger.info("Community installation secrets ready: count=%d", len(values))
    return values


def _integer_environment(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"invalid {name}") from exc
    if value < 0:
        raise ValueError(f"invalid {name}")
    return value


def _render_centrifugo_config(
    *,
    root: Path,
    template_path: Path,
    values: Mapping[str, str],
    runtime_uid: int,
    runtime_gid: int,
) -> Path:
    try:
        rendered = template_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError("missing Community Centrifugo template") from exc
    replacements = {
        "__CENTRIFUGO_API_KEY__": values["CENTRIFUGO_API_KEY"],
        "__CENTRIFUGO_PROXY_SECRET__": values["CENTRIFUGO_PROXY_SECRET"],
        "__CENTRIFUGO_TOKEN_SECRET__": values["CENTRIFUGO_TOKEN_SECRET"],
    }
    for marker, value in replacements.items():
        if rendered.count(marker) < 1:
            raise ValueError("invalid Community Centrifugo template")
        rendered = rendered.replace(marker, value)
    if "__CENTRIFUGO_" in rendered:
        raise ValueError("unresolved Community Centrifugo template marker")
    try:
        json.loads(rendered)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid Community Centrifugo configuration") from exc

    destination = root / CENTRIFUGO_CONFIG_NAME
    if destination.exists() and destination.read_text(encoding="utf-8") == rendered:
        os.chmod(destination, 0o440)
    else:
        _atomic_write(destination, rendered)
    os.chown(destination, runtime_uid, runtime_gid)
    return destination


def initialize_community_installation(root: Path) -> None:
    """Converge installation secrets and their least-privilege ownership."""
    runtime_uid = _integer_environment("TABTIN_COMMUNITY_RUNTIME_UID", 10001)
    runtime_gid = _integer_environment("TABTIN_COMMUNITY_RUNTIME_GID", 10001)
    postgres_uid = _integer_environment("TABTIN_COMMUNITY_POSTGRES_UID", 999)
    postgres_gid = _integer_environment("TABTIN_COMMUNITY_POSTGRES_GID", 999)
    values = ensure_installation_secrets(root)

    # The directory is traversable, while every value remains protected by
    # its own owner/mode.  Long-running runtime processes cannot read the
    # init or migrator passwords from the shared installation volume.
    os.chmod(root, 0o755)
    for name, path in secret_file_paths(root).items():
        if name == "PG_INIT_PASSWORD":
            owner_uid, owner_gid, mode = postgres_uid, postgres_gid, 0o400
        elif name == "PG_MIGRATOR_PASSWORD":
            owner_uid, owner_gid, mode = 0, 0, 0o400
        else:
            owner_uid, owner_gid, mode = runtime_uid, runtime_gid, 0o440
        os.chown(path, owner_uid, owner_gid)
        os.chmod(path, mode)

    template = Path(
        os.environ.get(
            "TABTIN_COMMUNITY_CENTRIFUGO_TEMPLATE",
            "/app/community-assets/centrifugo.template.json",
        )
    )
    _render_centrifugo_config(
        root=root,
        template_path=template,
        values=values,
        runtime_uid=runtime_uid,
        runtime_gid=runtime_gid,
    )
    logger.info("Community installation secret layout ready")


def resolve_secret_setting(
    name: str,
    environment: Mapping[str, str],
    *,
    required: bool = True,
) -> str:
    """Resolve ``NAME`` or ``NAME_FILE`` with an unambiguous contract."""
    raw_value = environment.get(name, "")
    file_name = environment.get(f"{name}_FILE", "")
    if raw_value and file_name:
        raise ValueError(f"{name} and {name}_FILE cannot both be configured")
    if file_name:
        return read_secret_file(Path(file_name), label=name)
    if raw_value:
        return raw_value
    if required:
        raise ValueError(f"missing {name} secret")
    return ""


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action != "init":
        raise SystemExit("usage: python -m tabtin.community_secrets init")
    root = Path(
        os.environ.get(
            "TABTIN_COMMUNITY_SECRET_ROOT",
            "/run/tabtin-community-secrets",
        )
    )
    initialize_community_installation(root)
    print(f"[community-secrets] ready count={len(ALL_SECRET_NAMES)}")


if __name__ == "__main__":
    main()

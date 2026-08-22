from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from django.conf import settings
from packaging.version import InvalidVersion, Version


@dataclass(frozen=True)
class ClientBuild:
    client_type: str = ""
    client_version: str = ""
    source_sha: str = ""


@dataclass(frozen=True)
class ServerBuild:
    release_version: str = ""
    source_sha: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            "release_version": self.release_version,
            "source_sha": self.source_sha,
        }


def _header(request, name: str, max_length: int) -> str:
    return str(request.headers.get(name, "") or "").strip()[:max_length]


def parse_client_build(request) -> ClientBuild:
    return ClientBuild(
        client_type=_header(request, "X-Client-Type", 32).lower(),
        client_version=_header(request, "X-Client-Version", 64),
        source_sha=_header(request, "X-Client-Source-Sha", 64).lower(),
    )


def get_server_build() -> ServerBuild:
    return ServerBuild(
        release_version=str(getattr(settings, "TABTIN_SERVER_VERSION", "") or "").strip(),
        source_sha=str(getattr(settings, "TABTIN_GIT_SHA", "") or "").strip().lower(),
    )


def is_version_at_least(
    current: str,
    minimum: str,
    *,
    kind: Literal["release", "client"],
) -> bool:
    current = str(current or "").strip()
    minimum = str(minimum or "").strip()
    if not current or not minimum:
        return False
    if kind in {"release", "client"}:
        try:
            return Version(current) >= Version(minimum)
        except InvalidVersion:
            return False
    return False

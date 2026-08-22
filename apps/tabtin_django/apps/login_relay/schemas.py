from __future__ import annotations

import json
import math
import re
from typing import Any, Optional
from uuid import UUID

from ninja import Schema
from pydantic import Field, field_validator, model_validator

from apps.services.agent_engine.utils.common.thread_id import (
    ACTION_RESULT_THREAD_PREFIXES,
    validate_thread_id_prefix,
)


MAX_COOKIE_COUNT = 100
MAX_COOKIE_VALUE_LENGTH = 4096
MAX_RELAY_PAYLOAD_BYTES = 256 * 1024

_DOMAIN_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_TAB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def normalize_domain(value: str, *, allow_leading_dot: bool) -> str:
    raw = (value or "").strip().lower().rstrip(".")
    has_leading_dot = raw.startswith(".")
    host = raw[1:] if has_leading_dot else raw
    if not host or len(host) > 253:
        raise ValueError("domain is invalid")
    if any(token in host for token in ("://", "/", "\\", ":", "@")):
        raise ValueError("domain must be a hostname")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError("domain is invalid") from exc
    if len(host) > 253:
        raise ValueError("domain is invalid")
    labels = host.split(".")
    if any(not _DOMAIN_LABEL_RE.fullmatch(label) for label in labels):
        raise ValueError("domain is invalid")
    return f".{host}" if allow_leading_dot and has_leading_dot else host


def domains_overlap(left: str, right: str) -> bool:
    left_host = left.lstrip(".")
    right_host = right.lstrip(".")
    return (
        left_host == right_host
        or left_host.endswith(f".{right_host}")
        or right_host.endswith(f".{left_host}")
    )


class RelayCookie(Schema):
    name: str = Field(min_length=1, max_length=256)
    value: str = Field(max_length=MAX_COOKIE_VALUE_LENGTH)
    domain: str = Field(min_length=1, max_length=254)
    path: str = Field(min_length=1, max_length=2048)
    secure: bool
    httpOnly: bool
    sameSite: Optional[str] = Field(default=None, max_length=20)
    expirationDate: Optional[float] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip() or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
            raise ValueError("cookie name is invalid")
        return value

    @field_validator("domain")
    @classmethod
    def validate_domain(cls, value: str) -> str:
        return normalize_domain(value, allow_leading_dot=True)

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError("cookie path must start with '/'")
        return value

    @field_validator("sameSite")
    @classmethod
    def validate_same_site(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.lower()
        if normalized not in {"unspecified", "no_restriction", "lax", "strict", "none"}:
            raise ValueError("sameSite is invalid")
        return value

    @field_validator("expirationDate")
    @classmethod
    def validate_expiration_date(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and (not math.isfinite(value) or value < 0):
            raise ValueError("expirationDate is invalid")
        return value


def relay_cookie_payload(cookies: list[RelayCookie]) -> list[dict[str, Any]]:
    return [cookie.model_dump(exclude_none=True) for cookie in cookies]


class CreatePackageIn(Schema):
    space_id: UUID
    thread_id: str = Field(min_length=1, max_length=255)
    domain: str = Field(min_length=1, max_length=253)
    tab_id: Optional[str] = Field(default=None, min_length=1, max_length=128)
    cookies: list[RelayCookie] = Field(min_length=1, max_length=MAX_COOKIE_COUNT)

    @field_validator("thread_id")
    @classmethod
    def validate_thread_id(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 0x20 for char in value):
            raise ValueError("thread_id is invalid")
        error = validate_thread_id_prefix(
            value,
            allowed_prefixes=ACTION_RESULT_THREAD_PREFIXES,
        )
        if error:
            raise ValueError(error)
        return value

    @field_validator("domain")
    @classmethod
    def validate_domain(cls, value: str) -> str:
        return normalize_domain(value, allow_leading_dot=False)

    @field_validator("tab_id")
    @classmethod
    def validate_tab_id(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not _TAB_ID_RE.fullmatch(value):
            raise ValueError("tab_id is invalid")
        return value

    @model_validator(mode="after")
    def validate_cookie_scope_and_size(self):
        if any(not domains_overlap(cookie.domain, self.domain) for cookie in self.cookies):
            raise ValueError("cookie domain is outside relay domain")
        payload_bytes = len(
            json.dumps(
                relay_cookie_payload(self.cookies),
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        if payload_bytes > MAX_RELAY_PAYLOAD_BYTES:
            raise ValueError("relay cookie payload is too large")
        return self


class ImportResultOut(Schema):
    success: bool
    imported_count: Optional[int] = None
    reloaded: Optional[bool] = None
    error: Optional[str] = None
    error_code: Optional[str] = None


class CreatePackageOut(Schema):
    package_id: UUID
    import_result: ImportResultOut


class ConsumeOut(Schema):
    domain: str
    cookies: list[RelayCookie]

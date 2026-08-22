"""Helpers for long-lived public asset references.

Business tables should store OSS object keys, not bucket/CDN URLs. API responses
can then build a stable public URL from the configured asset domain.
"""

from __future__ import annotations

from urllib.parse import parse_qs, quote, urlencode, urlparse

from django.conf import settings


def _normalized_domain(value: str) -> str:
    domain = (value or "").strip().rstrip("/")
    if not domain:
        return ""
    parsed = urlparse(domain)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return f"https://{domain}"


def _known_asset_hosts() -> set[str]:
    hosts: set[str] = set()
    bucket = getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "") or ""
    endpoint = (getattr(settings, "ALIYUN_OSS_ENDPOINT", "") or "").removeprefix("https://").removeprefix("http://").strip("/")
    for value in (
        getattr(settings, "ASSET_PUBLIC_DOMAIN", "") or "",
        getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "") or "",
    ):
        parsed = urlparse(_normalized_domain(value))
        if parsed.hostname:
            hosts.add(parsed.hostname)
    if bucket and endpoint:
        hosts.add(f"{bucket}.{endpoint}")
    return hosts


def _fallback_bucket_domain() -> str:
    bucket = getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "") or ""
    endpoint = (getattr(settings, "ALIYUN_OSS_ENDPOINT", "") or "").removeprefix("https://").removeprefix("http://").strip("/")
    if not bucket or not endpoint:
        return ""
    return f"https://{bucket}.{endpoint}"


def _local_public_base_url() -> str:
    if getattr(settings, "SERVICES_OSS_PROVIDER", "").lower() != "local":
        return ""
    return (getattr(settings, "LOCAL_OSS_PUBLIC_BASE_URL", "") or "").strip()


def public_asset_object_key_from_ref(ref: str) -> str | None:
    """Return an OSS object key for platform-owned refs.

    External URLs are intentionally returned as ``None`` so callers can preserve
    them instead of treating arbitrary URLs as our OSS keys.
    """
    value = (ref or "").strip()
    if not value or value.startswith(("data:", "blob:")):
        return None

    parsed = urlparse(value)
    if parsed.scheme and parsed.netloc:
        local_base = _local_public_base_url()
        if local_base and value.startswith(local_base.rstrip("/")):
            return (parse_qs(parsed.query).get("object_key") or [""])[0] or None
        hostname = parsed.hostname or ""
        if hostname in _known_asset_hosts():
            return parsed.path.lstrip("/") or None
        return None

    return parsed.path.lstrip("/") or None


def normalize_public_asset_ref(ref: str) -> str:
    """Normalize platform-owned asset refs to object keys for persistence."""
    value = (ref or "").strip()
    if not value:
        return ""
    object_key = public_asset_object_key_from_ref(value)
    if object_key:
        return object_key
    return value


def build_public_asset_url(ref: str) -> str:
    """Build the long-lived public URL for a platform asset ref."""
    value = (ref or "").strip()
    if not value:
        return ""
    object_key = public_asset_object_key_from_ref(value)
    if not object_key:
        return value

    local_base = _local_public_base_url()
    if local_base:
        return f"{local_base}?{urlencode({'object_key': object_key})}"

    domain = _normalized_domain(
        getattr(settings, "ASSET_PUBLIC_DOMAIN", "") or getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "")
    ) or _fallback_bucket_domain()
    if not domain:
        return value
    return f"{domain}/{quote(object_key, safe='/')}"

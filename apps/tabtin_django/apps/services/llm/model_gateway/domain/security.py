"""Typed, immutable security-policy inputs and safe diagnostics."""

from __future__ import annotations

from ipaddress import IPv4Address, IPv6Address
from typing import Literal, Protocol

from ._base import StableKey, StrictFrozenModel


class SecretFinding(StrictFrozenModel):
    severity: Literal["blocking", "warning"] = "blocking"
    rule_code: str
    source: str
    path: str | None = None
    line: int | None = None
    column: int | None = None
    length_category: Literal["short", "medium", "long"]
    fingerprint: str
    remediation: str


class ResolvedAddress(StrictFrozenModel):
    address: IPv4Address | IPv6Address


class Resolver(Protocol):
    def resolve_all(self, host: str) -> tuple[ResolvedAddress, ...]: ...


class EndpointSecurityPolicy(StrictFrozenModel):
    exact_hosts: tuple[str, ...] = ()
    subdomain_suffixes: tuple[str, ...] = ()
    approved_regions: tuple[StableKey, ...] = ()
    allowed_ports: tuple[int, ...] = (443,)
    allow_ip_literals: bool = False
    require_dns_verification: bool = False
    publication_environment: Literal["development", "test", "production"] = "production"
    local_development_exception: bool = False
    allow_cross_origin_redirects: bool = False
    allow_credential_forwarding_cross_origin: bool = False


class EndpointDiagnostic(StrictFrozenModel):
    severity: Literal["blocking", "warning"]
    rule_code: str
    path: str
    message: str


class EndpointValidationResult(StrictFrozenModel):
    canonical_url: str | None
    normalized_host: str | None
    static_endpoint_valid: bool
    dns_verified: bool
    publishable: bool
    diagnostics: tuple[EndpointDiagnostic, ...]

"""Pure endpoint normalization, allowlist, DNS seam, and SSRF policy."""

from __future__ import annotations

import ipaddress
import idna
from urllib.parse import unquote, urlsplit, urlunsplit

from ..domain.security import EndpointDiagnostic, EndpointSecurityPolicy, EndpointValidationResult, Resolver


def normalize_host(host: str) -> str:
    if not host or "%" in host or any(ord(char)<32 for char in host): raise ValueError("invalid host")
    host=host.rstrip(".").lower()
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        try: return idna.encode(host,uts46=False,std3_rules=True).decode("ascii")
        except idna.IDNAError as exc: raise ValueError("invalid IDNA host") from exc


def classify_address(value: str) -> str:
    address=ipaddress.ip_address(value)
    if isinstance(address,ipaddress.IPv6Address) and address.ipv4_mapped: address=address.ipv4_mapped
    if address.is_loopback: return "loopback"
    if address.is_link_local: return "link_local"
    if address.is_unspecified: return "unspecified"
    if address.is_multicast: return "multicast"
    if address.is_reserved: return "reserved"
    if address.is_private: return "private"
    if not address.is_global: return "reserved"
    return "public"


def _host_allowed(host: str, policy: EndpointSecurityPolicy) -> bool:
    if host in {normalize_host(item) for item in policy.exact_hosts}: return True
    return any(host.endswith("."+normalize_host(suffix)) for suffix in policy.subdomain_suffixes)


def validate_endpoint(url: str, *, region: str | None, policy: EndpointSecurityPolicy, resolver: Resolver | None = None) -> EndpointValidationResult:
    issues=[]; canonical=None; host=None; dns_verified=False
    def add(code,message,severity="blocking"): issues.append(EndpointDiagnostic(severity=severity,rule_code=code,path="endpoint_url",message=message))
    if any(ord(char)<32 for char in url) or "\\" in url: add("endpoint_ambiguous","endpoint contains control or backslash ambiguity")
    try:
        parsed=urlsplit(url)
        if parsed.scheme!="https": add("endpoint_https_required","production endpoint must use HTTPS")
        if parsed.username is not None or parsed.password is not None: add("endpoint_userinfo_forbidden","endpoint userinfo is forbidden")
        if parsed.query: add("endpoint_query_forbidden","base endpoint query is forbidden")
        if parsed.fragment: add("endpoint_fragment_forbidden","endpoint fragment is forbidden")
        if not parsed.hostname: add("endpoint_host_missing","endpoint host is required")
        else: host=normalize_host(parsed.hostname)
        port=parsed.port or 443
        if port not in policy.allowed_ports: add("endpoint_port_denied","endpoint port is not approved")
        segments=[unquote(item) for item in parsed.path.split("/")]
        if any(item in {".",".."} for item in segments): add("endpoint_path_traversal","endpoint path traversal is forbidden")
        if host:
            is_ip=True
            try: ipaddress.ip_address(host)
            except ValueError: is_ip=False
            local=host=="localhost" or (is_ip and classify_address(host)=="loopback")
            if local and policy.local_development_exception and policy.publication_environment=="development":
                add("local_development_endpoint","local endpoint is non-publishable","warning")
            else:
                if local: add("local_endpoint_denied","local endpoint exception is disabled")
                if is_ip and not policy.allow_ip_literals: add("ip_literal_denied","IP literal endpoints are not approved")
                if not _host_allowed(host,policy): add("host_not_approved","endpoint host is not approved")
            if region and policy.approved_regions and region not in policy.approved_regions: add("region_not_approved","endpoint region is not approved")
            if is_ip:
                category=classify_address(host)
                if category!="public" and not (local and policy.local_development_exception and policy.publication_environment=="development"): add("ssrf_address_denied","endpoint address is non-public")
                if policy.require_dns_verification and category=="public": dns_verified=True
            elif policy.require_dns_verification:
                if resolver is None: add("dns-verification-unavailable","DNS verification is required but offline mode has no resolver")
                else:
                    try: addresses=tuple(sorted({str(item.address) for item in resolver.resolve_all(host)}))
                    except Exception: addresses=(); add("dns_resolution_failed","DNS resolution failed safely")
                    if not addresses: add("dns_empty_result","DNS verification returned no addresses")
                    dns_verified=bool(addresses)
                    for address in addresses:
                        if classify_address(address)!="public": dns_verified=False; add("ssrf_resolved_address_denied","resolved endpoint contains a non-public address")
            netloc=f"[{host}]" if host and ":" in host else (host or "")
            if port!=443: netloc+=f":{port}"
            canonical=urlunsplit(("https",netloc,parsed.path.rstrip("/") or "","",""))
    except (ValueError,UnicodeError): add("endpoint_parse_error","endpoint URL is malformed")
    dns_codes={"dns-verification-unavailable","dns_resolution_failed","dns_empty_result","ssrf_resolved_address_denied"}
    static_endpoint_valid=not any(item.severity=="blocking" and item.rule_code not in dns_codes for item in issues)
    blocking=any(item.severity=="blocking" for item in issues)
    publishable=static_endpoint_valid and not blocking and (dns_verified if policy.require_dns_verification else True) and not any(item.rule_code=="local_development_endpoint" for item in issues)
    return EndpointValidationResult(canonical_url=canonical,normalized_host=host,static_endpoint_valid=static_endpoint_valid,dns_verified=dns_verified,publishable=publishable,diagnostics=tuple(sorted(issues,key=lambda item:(item.rule_code,item.path))))


def validate_redirect_target(source_endpoint: str, redirect_target: str, endpoint_policy: EndpointSecurityPolicy, resolver: Resolver | None = None, *, region: str | None = None, credentials_would_be_forwarded: bool = False) -> EndpointValidationResult:
    result=validate_endpoint(redirect_target,region=region,policy=endpoint_policy,resolver=resolver)
    diagnostics=list(result.diagnostics)
    redirect_blocking=False
    try:
        source=urlsplit(source_endpoint); target=urlsplit(redirect_target)
        source_origin=(source.scheme,normalize_host(source.hostname or ""),source.port or 443)
        target_origin=(target.scheme,normalize_host(target.hostname or ""),target.port or 443)
        cross_origin=source_origin!=target_origin
        if cross_origin and not endpoint_policy.allow_cross_origin_redirects:
            redirect_blocking=True
            diagnostics.append(EndpointDiagnostic(severity="blocking",rule_code="redirect_origin_denied",path="redirect_target",message="cross-origin redirect is not approved"))
        if cross_origin and credentials_would_be_forwarded and not endpoint_policy.allow_credential_forwarding_cross_origin:
            redirect_blocking=True
            diagnostics.append(EndpointDiagnostic(severity="blocking",rule_code="redirect_credentials_denied",path="redirect_target",message="credentials cannot be forwarded across origins"))
    except (ValueError,UnicodeError):
        redirect_blocking=True
        diagnostics.append(EndpointDiagnostic(severity="blocking",rule_code="redirect_origin_invalid",path="redirect_target",message="redirect origin cannot be normalized"))
    diagnostics=sorted(diagnostics,key=lambda item:(item.rule_code,item.path))
    blocking=any(item.severity=="blocking" for item in diagnostics)
    return EndpointValidationResult(canonical_url=result.canonical_url,normalized_host=result.normalized_host,static_endpoint_valid=result.static_endpoint_valid and not redirect_blocking,dns_verified=result.dns_verified,publishable=result.publishable and not blocking,diagnostics=tuple(diagnostics))

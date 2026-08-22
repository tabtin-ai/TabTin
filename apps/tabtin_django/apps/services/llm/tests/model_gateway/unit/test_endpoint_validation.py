import ipaddress

import pytest

from apps.services.llm.model_gateway.domain.security import EndpointSecurityPolicy, ResolvedAddress
from apps.services.llm.model_gateway.validation.endpoints import classify_address, normalize_host, validate_endpoint, validate_redirect_target


def policy(**changes):
    values={"exact_hosts":("api.example.test",),"subdomain_suffixes":("service.example.test",),"approved_regions":("cn-north",),"allowed_ports":(443,),"publication_environment":"production"}
    values.update(changes); return EndpointSecurityPolicy(**values)


def codes(url,**kwargs): return {item.rule_code for item in validate_endpoint(url,region=kwargs.pop("region","cn-north"),policy=kwargs.pop("policy",policy()),**kwargs).diagnostics}


def test_valid_https_endpoint_has_deterministic_canonical_form():
    result=validate_endpoint("https://API.EXAMPLE.TEST/v1/",region="cn-north",policy=policy())
    assert result.publishable and result.canonical_url=="https://api.example.test/v1"


@pytest.mark.parametrize("url,rule",[
    ("http://api.example.test/v1","endpoint_https_required"),
    ("https://user:pass@api.example.test/v1","endpoint_userinfo_forbidden"),
    ("https://api.example.test/v1?token=x","endpoint_query_forbidden"),
    ("https://api.example.test/v1#x","endpoint_fragment_forbidden"),
    ("https://api.example.test:8443/v1","endpoint_port_denied"),
    ("https://api.example.test:bad/v1","endpoint_parse_error"),
    ("https://api.example.test/a/../v1","endpoint_path_traversal"),
    ("https://api.example.test\\attacker.test/v1","endpoint_ambiguous"),
    ("https://api.example.test/\nunsafe","endpoint_ambiguous"),
    ("https://%61pi.example.test/v1","endpoint_parse_error"),
])
def test_endpoint_structure_rejections(url,rule): assert rule in codes(url)


def test_host_normalization_idna_trailing_dot_and_subdomain_boundary():
    assert normalize_host("BÜCHER.Example.")=="xn--bcher-kva.example"
    assert validate_endpoint("https://a.service.example.test",region="cn-north",policy=policy()).publishable
    assert "host_not_approved" in codes("https://service.example.test.attacker.test")


def test_region_and_literal_port_policy():
    assert "region_not_approved" in codes("https://api.example.test",region="us-west")
    assert "ip_literal_denied" in codes("https://[2001:4860:4860::8888]",policy=policy(exact_hosts=("2001:4860:4860::8888",)))


@pytest.mark.parametrize("address,category",[
    ("8.8.8.8","public"),("127.0.0.1","loopback"),("10.0.0.1","private"),("169.254.169.254","link_local"),("0.0.0.0","unspecified"),("224.0.0.1","multicast"),("240.0.0.1","reserved"),("::ffff:127.0.0.1","loopback")])
def test_ssrf_address_classification(address,category): assert classify_address(address)==category


class FakeResolver:
    def __init__(self,*addresses,fail=False): self.addresses=addresses; self.fail=fail; self.calls=0
    def resolve_all(self,host):
        self.calls+=1
        if self.fail: raise RuntimeError("hostile resolver detail")
        return tuple(ResolvedAddress(address=ipaddress.ip_address(item)) for item in self.addresses)


def test_all_dns_results_examined_and_mixed_result_blocked():
    resolver=FakeResolver("8.8.8.8","10.0.0.1","2001:4860:4860::8888")
    assert "ssrf_resolved_address_denied" in codes("https://api.example.test",policy=policy(require_dns_verification=True),resolver=resolver)
    assert resolver.calls==1


def test_injected_safe_resolver_satisfies_dns_verification():
    result=validate_endpoint("https://api.example.test",region="cn-north",policy=policy(require_dns_verification=True),resolver=FakeResolver("8.8.8.8","2001:4860:4860::8888"))
    assert result.static_endpoint_valid and result.dns_verified and result.publishable


def test_offline_default_never_calls_dns_and_required_dns_fails_closed():
    result=validate_endpoint("https://api.example.test",region="cn-north",policy=policy(require_dns_verification=True))
    assert result.static_endpoint_valid and not result.dns_verified and not result.publishable
    assert "dns-verification-unavailable" in {item.rule_code for item in result.diagnostics}


def test_dns_failure_and_empty_results_are_safe():
    result=codes("https://api.example.test",policy=policy(require_dns_verification=True),resolver=FakeResolver(fail=True))
    assert {"dns_resolution_failed","dns_empty_result"}<=result


def test_local_development_exception_is_explicit_and_non_publishable():
    denied=validate_endpoint("https://localhost:443",region=None,policy=EndpointSecurityPolicy(publication_environment="development"))
    allowed=validate_endpoint("https://localhost:443",region=None,policy=EndpointSecurityPolicy(publication_environment="development",local_development_exception=True))
    assert not denied.publishable and not allowed.publishable and any(x.severity=="warning" for x in allowed.diagnostics)


def test_redirect_target_reuses_complete_policy():
    assert "endpoint_userinfo_forbidden" in {x.rule_code for x in validate_redirect_target("https://api.example.test","https://u:p@api.example.test",policy(),region="cn-north").diagnostics}


def test_deployment_profile_cannot_self_whitelist_arbitrary_host():
    from pydantic import ValidationError
    from apps.services.llm.model_gateway.domain._base import CredentialPoolRef, LifecycleState
    from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile
    from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity, ExactRef
    h="sha256:"+"a"*64
    with pytest.raises(ValidationError):
        DeploymentProfile(schema_version="1",identity=ArtifactIdentity(kind="deployment-profile",key="fictional",revision="1",canonical_hash=h),endpoint_key="fictional",endpoint_url="https://attacker.test",approved_hosts=("attacker.test",),protocol_readiness_ref=ExactRef(kind="protocol-readiness",key="fictional",revision="1",expected_hash=h),credential_pool_ref=CredentialPoolRef(pool_key="fictional"),lifecycle=LifecycleState.ACTIVE)


def test_redirect_same_origin_and_cross_origin_credential_policy():
    same=validate_redirect_target("https://api.example.test/v1","https://api.example.test/v2",policy(),region="cn-north")
    assert same.publishable
    cross_policy=policy(exact_hosts=("api.example.test","other.example.test"),allow_cross_origin_redirects=True)
    cross=validate_redirect_target("https://api.example.test","https://other.example.test",cross_policy,region="cn-north",credentials_would_be_forwarded=True)
    assert "redirect_credentials_denied" in {item.rule_code for item in cross.diagnostics} and not cross.publishable


@pytest.mark.parametrize("target,rule",[
    ("http://api.example.test","endpoint_https_required"),
    ("https://u:p@api.example.test?token=x","endpoint_userinfo_forbidden"),
    ("https://127.0.0.1","ssrf_address_denied"),
    ("https://169.254.169.254","ssrf_address_denied"),
])
def test_redirect_target_full_policy_revalidation(target,rule):
    result=validate_redirect_target("https://api.example.test",target,policy(exact_hosts=("api.example.test","127.0.0.1","169.254.169.254"),allow_ip_literals=True,allow_cross_origin_redirects=True),region="cn-north")
    assert rule in {item.rule_code for item in result.diagnostics} and not result.publishable

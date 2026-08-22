import io
import json
import socket
import ipaddress
from pathlib import Path

import pytest
from django.core.management.base import CommandError, OutputWrapper

from apps.services.llm.management.commands.model_gateway_validate import Command
from apps.services.llm.model_gateway.domain.diagnostics import StructuralDiagnostic
from apps.services.llm.model_gateway.domain._base import CredentialPoolRef, LifecycleState
from apps.services.llm.model_gateway.domain.deployments import DeploymentProfile
from apps.services.llm.model_gateway.domain.identities import ArtifactIdentity, ExactRef
from apps.services.llm.model_gateway.domain.security import EndpointSecurityPolicy, ResolvedAddress
from apps.services.llm.model_gateway import calculate_canonical_hash


def command_output(root, output_format="text"):
    command=Command(); stream=io.StringIO(); command.stdout=OutputWrapper(stream)
    command.handle(artifact_root=str(root), format=output_format)
    return stream.getvalue()


def write_endpoint_deployment(root:Path):
    h="sha256:"+"0"*64
    artifact=DeploymentProfile(schema_version="1",identity=ArtifactIdentity(kind="deployment-profile",key="fictional-deployment",revision="1",canonical_hash=h),endpoint_key="fictional-endpoint",endpoint_url="https://api.example.test/v1",endpoint_policy_ref=ExactRef(kind="platform-safety-policy",key="trusted-endpoint-policy",revision="1",expected_hash=h),region="cn-north",protocol_readiness_ref=ExactRef(kind="protocol-readiness",key="fictional-readiness",revision="1",expected_hash=h),credential_pool_ref=CredentialPoolRef(pool_key="fictional-pool"),lifecycle=LifecycleState.ACTIVE)
    digest=calculate_canonical_hash(artifact); artifact=artifact.model_copy(update={"identity":artifact.identity.model_copy(update={"canonical_hash":digest})})
    path=root/"deployment-profile"/"fictional-deployment"/"1"/"artifact.json"; path.parent.mkdir(parents=True); path.write_text(artifact.model_dump_json())


def install_runtime_guards(monkeypatch):
    def blocked(*args,**kwargs): raise AssertionError("external side effect attempted")
    monkeypatch.setattr(socket,"socket",blocked)
    monkeypatch.setattr(socket,"getaddrinfo",blocked)
    monkeypatch.setattr(socket,"create_connection",blocked)
    try:
        from django.db.backends.utils import CursorWrapper
        monkeypatch.setattr(CursorWrapper,"execute",blocked)
        monkeypatch.setattr(CursorWrapper,"executemany",blocked)
    except ImportError:
        pass


def test_command_valid_empty_root_is_zero_and_stable(monkeypatch,tmp_path):
    install_runtime_guards(monkeypatch)
    assert command_output(tmp_path)=="OK\n"
    first=command_output(tmp_path,"json"); second=command_output(tmp_path,"json")
    assert first==second and json.loads(first)=={"blocking":False,"issues":[]}


def test_command_aggregates_bad_packages_and_returns_nonzero(monkeypatch,tmp_path):
    install_runtime_guards(monkeypatch)
    for name in ("package-one","package-two"):
        path=tmp_path/name/"wrong"/"1"/"artifact.json"; path.parent.mkdir(parents=True); path.write_text('{"arbitrary_private_value":"must-not-echo"}')
    command=Command(); stream=io.StringIO(); command.stdout=OutputWrapper(stream)
    with pytest.raises(CommandError): command.handle(artifact_root=str(tmp_path),format="json")
    payload=json.loads(stream.getvalue())
    assert payload["blocking"] is True and len(payload["issues"])==2
    assert "must-not-echo" not in stream.getvalue()
    assert payload["issues"]==sorted(payload["issues"],key=lambda issue:(issue["rule_code"],issue.get("path") or "",issue["message"]))


def test_command_module_has_no_runtime_service_imports():
    source=__import__("inspect").getsource(Command)
    for name in ("proxy","factory","wire_adapter","billing","key_manager","requests","httpx"):
        assert name not in source.lower()


def test_command_warning_only_returns_zero(monkeypatch,tmp_path):
    import apps.services.llm.management.commands.model_gateway_validate as module
    monkeypatch.setattr(module,"validate_artifacts",lambda artifacts:(StructuralDiagnostic(severity="warning",rule_code="fixture_warning",path="fixture",message="safe warning"),))
    output=command_output(tmp_path,"json"); payload=json.loads(output)
    assert payload["blocking"] is False and payload["issues"][0]["severity"]=="warning"


def test_command_aggregates_raw_secret_with_loader_error_without_value_echo(monkeypatch,tmp_path):
    install_runtime_guards(monkeypatch)
    value="SyntheticCredential_9Xq7Lm2P4R8T6V1N"; path=tmp_path/"broken"/"artifact.json"; path.parent.mkdir(); path.write_text('{"api_key":"'+value+'",')
    command=Command(); stream=io.StringIO(); command.stdout=OutputWrapper(stream)
    with pytest.raises(CommandError): command.handle(artifact_root=str(tmp_path),format="json")
    output=stream.getvalue(); rules={item["rule_code"] for item in json.loads(output)["issues"]}
    assert {"load_error","secret_field_raw"}<=rules and value not in output


def test_command_endpoint_policy_is_trusted_input_and_default_dns_is_offline(monkeypatch,tmp_path):
    install_runtime_guards(monkeypatch); write_endpoint_deployment(tmp_path)
    command=Command(); command.endpoint_policy=EndpointSecurityPolicy(exact_hosts=("api.example.test",),approved_regions=("cn-north",),require_dns_verification=True)
    stream=io.StringIO(); command.stdout=OutputWrapper(stream)
    with pytest.raises(CommandError): command.handle(artifact_root=str(tmp_path),format="json")
    assert "dns-verification-unavailable" in {item["rule_code"] for item in json.loads(stream.getvalue())["issues"]}


@pytest.mark.parametrize("addresses,denied",[(('8.8.8.8',),False),(('8.8.8.8','10.0.0.1'),True)])
def test_command_injected_resolver_checks_all_addresses(monkeypatch,tmp_path,addresses,denied):
    install_runtime_guards(monkeypatch); write_endpoint_deployment(tmp_path)
    class Resolver:
        def resolve_all(self,host): return tuple(ResolvedAddress(address=ipaddress.ip_address(value)) for value in addresses)
    command=Command(); command.endpoint_policy=EndpointSecurityPolicy(exact_hosts=("api.example.test",),approved_regions=("cn-north",),require_dns_verification=True); command.endpoint_resolver=Resolver()
    stream=io.StringIO(); command.stdout=OutputWrapper(stream)
    with pytest.raises(CommandError): command.handle(artifact_root=str(tmp_path),format="json")
    rules={item["rule_code"] for item in json.loads(stream.getvalue())["issues"]}
    assert ("ssrf_resolved_address_denied" in rules) is denied
    assert "dns-verification-unavailable" not in rules

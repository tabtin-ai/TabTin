from contextlib import contextmanager
from dataclasses import FrozenInstanceError
import pytest
from apps.services.llm.protocol_adapters import *

@pytest.fixture
def context(): return ProtocolExecutionContext(ProtocolType.OPENAI_COMPATIBLE,"https://example.invalid/v1",ResolvedCredential("fictional-test-secret"))
@pytest.fixture
def adapter(): return OpenAICompatibleProtocolAdapter()

def test_contracts_are_frozen_and_secret_safe(context):
    assert "fictional" not in repr(context.credential)
    with pytest.raises(FrozenInstanceError): context.endpoint="https://changed.invalid"
    with pytest.raises(ProtocolContractError): CanonicalLLMRequest("m",(),fields={"bad":1.2})

def test_registry_is_exact_and_fail_closed():
    registry=build_default_protocol_registry()
    assert isinstance(registry.resolve(ProtocolType.OPENAI_COMPATIBLE),OpenAICompatibleProtocolAdapter)
    with pytest.raises(ModelProtocolNotConfigured): registry.resolve(None)
    with pytest.raises(UnsupportedProtocolType): registry.resolve("openai")
    with pytest.raises(FrozenProtocolRegistry): registry.register(OpenAICompatibleProtocolAdapter())

def test_request_preserves_adapted_fields_and_redacts(context,adapter):
    fields={"thinking":{"type":"enabled"},"reasoning_effort":"high","extension":{"safe":True}}
    request=CanonicalLLMRequest("synthetic-model",({"role":"user","content":"synthetic-a"},),fields=fields)
    prepared=adapter.build_request(request,context)
    assert prepared.method=="POST" and prepared.url=="https://example.invalid/v1/chat/completions"
    assert prepared.body["thinking"]["type"]=="enabled" and prepared.body["reasoning_effort"]=="high"
    rendered=str(prepared.diagnostic_summary)+prepared.fingerprint
    assert "fictional-test-secret" not in rendered and "synthetic-a" not in rendered
    changed=ProtocolExecutionContext(context.protocol_type,context.endpoint,ResolvedCredential("another-fictional"))
    assert adapter.build_request(request,changed).fingerprint==prepared.fingerprint
    same_shape=CanonicalLLMRequest("synthetic-model",({"role":"user","content":"synthetic-b"},),fields=fields)
    assert adapter.build_request(same_shape,context).fingerprint==prepared.fingerprint

def test_usage_and_errors(context,adapter):
    usage=adapter.normalize_usage({"prompt_tokens":2,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":1},"completion_tokens_details":{"reasoning_tokens":2}},context)
    assert usage.total_tokens.value==5 and usage.total_tokens.source=="derived"
    assert usage.cached_input_tokens.value==1 and usage.reasoning_tokens.value==2
    assert adapter.normalize_error(UpstreamFailure("response_headers",429,"rate_limit"),context).retryable
    assert adapter.normalize_error(UpstreamFailure("connect",401),context).is_authentication

def test_sse_preserves_payload_and_adapter_does_not_render_client_done(context,adapter):
    payload='{"choices":[{"delta":{"content":"x"}}],"extension":{"n":1}}'
    response=UpstreamStreamResponse(200,[f"data: {payload}\r\n".encode(),b"\r\n",b": ping\n",b"\n",b"data: [DONE]\n",b"\n"])
    events=list(adapter.parse_stream(response,context))
    assert events[0].original_payload==payload
    assert [event.kind for event in events]==[StreamEventKind.DATA,StreamEventKind.KEEPALIVE,StreamEventKind.PROTOCOL_DONE]
    assert all(event.original_payload!="data: [DONE]" for event in events)

def test_malformed_truncated_and_stream_error(context,adapter):
    response=UpstreamStreamResponse(200,[b"data: {bad}\n",b"\n",b'data: {"error":{"code":"safe-code"}}\n',b"\n",b'data: {"choices":[]}'])
    events=list(adapter.parse_stream(response,context))
    assert [e.kind for e in events]==[StreamEventKind.PROTOCOL_ERROR]*3
    assert events[1].error.upstream_code=="safe-code"

def test_open_stream_uses_only_injected_transport(context,adapter):
    prepared=adapter.build_request(CanonicalLLMRequest("m",()),context)
    class FakeTransport:
        calls=0
        @contextmanager
        def open_stream(self,request): self.calls+=1; yield UpstreamStreamResponse(200,[])
    class Observer:
        def __init__(self): self.events=[]
        def observe(self,event,**safe): self.events.append((event,safe))
    transport=FakeTransport(); observer=Observer()
    with adapter.open_stream(prepared,transport,observer): pass
    assert transport.calls==1
    assert [event for event,_ in observer.events]==["request_start","response_headers","stream_end"]

def test_no_vendor_identity_in_adapter_source():
    import inspect, apps.services.llm.protocol_adapters.openai_compatible as module
    source=inspect.getsource(module).lower()
    assert all(word not in source for word in ("kimi","moonshot","doubao","volcengine","provider_key","llmproviderkey"))


def test_runtime_modules_do_not_import_protocol_adapter_or_gateway_projection():
    from pathlib import Path

    llm_root = Path(__file__).resolve().parents[2]
    runtime_targets = (
        llm_root / "proxy_service.py",
        llm_root / "proxy_api.py",
        llm_root / "wire_adapter",
        llm_root / "runtime_profile",
        llm_root / "catalog",
        llm_root / "providers",
        llm_root / "apps.py",
    )
    forbidden = (
        "protocol_adapters",
        "ModelGatewayProjectionBinding",
        "ModelGatewayProjectionRevision",
        "current_projection_revision",
        "model_gateway.apply",
        "model_gateway.loading",
    )
    findings = []
    for target in runtime_targets:
        paths = (target,) if target.is_file() else target.rglob("*.py")
        for path in paths:
            text = path.read_text(encoding="utf-8")
            for marker in forbidden:
                if marker in text:
                    findings.append(f"{path.relative_to(llm_root)}:{marker}")
    assert findings == []

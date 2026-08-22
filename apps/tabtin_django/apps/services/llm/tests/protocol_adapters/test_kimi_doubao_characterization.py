import pytest
from apps.services.llm.protocol_adapters import *

CASES=(
 ("kimi-k2.5",{"thinking":{"type":"enabled"}}),
 ("kimi-k2.6",{"thinking":{"type":"disabled"}}),
 ("kimi-k2.7-code",{"thinking":{"type":"enabled"}}),
 ("kimi-k3",{"reasoning_effort":"max"}),
 ("doubao-seed-2.0-lite",{"thinking":{"type":"enabled"},"reasoning_effort":"high"}),
 ("doubao-seed-evolving",{"thinking":{"type":"disabled"},"reasoning_effort":"standard"}),
)

@pytest.mark.parametrize("model,adapted",CASES)
def test_six_runtime_models_use_one_generic_adapter_and_preserve_fields(model,adapted):
    adapter=OpenAICompatibleProtocolAdapter()
    context=ProtocolExecutionContext(ProtocolType.OPENAI_COMPATIBLE,"https://example.invalid/v1",ResolvedCredential("fictional"))
    prepared=adapter.build_request(CanonicalLLMRequest(model,(),fields=adapted),context)
    for key,value in adapted.items(): assert prepared.body[key]==value
    assert "service_tier" not in prepared.body and "latency_mode" not in prepared.body
    assert type(adapter) is OpenAICompatibleProtocolAdapter

import json
import pytest
from apps.services.llm.protocol_adapters.shadow import compare_protocol_observations,safe_hash
from apps.services.llm.protocol_adapters.reporting import render_shadow

def test_shadow_same_input_deterministic_and_offline():
    input={"fixture":"synthetic","shape":{"messages":1}}
    observation={"same_input_hash":safe_hash(input),"method":"POST","path":"/v1/chat/completions","events":["data","protocol_done"]}
    one=compare_protocol_observations(package="kimi-k2-5-draft-binding:1",protocol_type="OPENAI_COMPATIBLE",fixture_key="k25",same_input=input,legacy=observation,adapter=dict(reversed(tuple(observation.items()))),evidence_refs=("fixture:k25",))
    two=compare_protocol_observations(package="kimi-k2-5-draft-binding:1",protocol_type="OPENAI_COMPATIBLE",fixture_key="k25",same_input=input,legacy=observation,adapter=observation,evidence_refs=("fixture:k25",))
    assert one.comparison_hash==two.comparison_hash and not one.has_blocker
    assert json.loads(render_shadow(one,"json"))["has_blocker"] is False
    assert render_shadow(one,"jsonl")==render_shadow(two,"jsonl")

def test_shadow_rejects_different_input_and_marks_mismatch():
    source={"fixture":"a"}; digest=safe_hash(source)
    with pytest.raises(ValueError,match="same-input-mismatch"):
        compare_protocol_observations(package="x:1",protocol_type="OPENAI_COMPATIBLE",fixture_key="x",same_input=source,legacy={"same_input_hash":digest},adapter={"same_input_hash":safe_hash({"fixture":"b"})})
    result=compare_protocol_observations(package="x:1",protocol_type="OPENAI_COMPATIBLE",fixture_key="x",same_input=source,legacy={"same_input_hash":digest,"method":"POST"},adapter={"same_input_hash":digest,"method":"GET"})
    assert result.has_blocker

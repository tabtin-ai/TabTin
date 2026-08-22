import json
from pathlib import Path

import jsonschema
import pytest

from apps.services.llm.model_gateway.loading.loader import ArtifactLoadError, load_artifact_file

H="sha256:"+"a"*64


def capability_payload():
    return {"schema_version":"1","identity":{"kind":"model-capability","key":"fictional-model","revision":"1","canonical_hash":H},"model_family":"fictional-model","capabilities":[],"context_window":100,"max_output_tokens":10,"modality":"text"}


def schema(name):
    path=Path(__file__).parents[3]/"model_gateway"/"schemas"/"v1"/name
    return json.loads(path.read_text())


def test_valid_schema_payload_constructs_same_typed_artifact(tmp_path):
    payload=capability_payload(); jsonschema.validate(payload,schema("model-capability-spec.schema.json"))
    path=tmp_path/"artifact.json"; path.write_text(json.dumps(payload))
    loaded=load_artifact_file(path).model_dump(mode="json")
    assert all(loaded[key]==value for key,value in payload.items())


@pytest.mark.parametrize("mutation",[
    lambda p:p.update(extra="unknown"),
    lambda p:p.update(context_window="100"),
    lambda p:p["identity"].update(revision="latest"),
])
def test_schema_and_typed_loader_reject_same_invalid_shapes(tmp_path,mutation):
    payload=capability_payload(); mutation(payload)
    with pytest.raises(jsonschema.ValidationError): jsonschema.validate(payload,schema("model-capability-spec.schema.json"))
    path=tmp_path/"artifact.json"; path.write_text(json.dumps(payload))
    with pytest.raises(ArtifactLoadError): load_artifact_file(path)


def test_rate_card_decimal_and_timezone_parity(tmp_path):
    payload={"schema_version":"1","identity":{"kind":"rate-card","key":"fictional-rate","revision":"1","canonical_hash":H},"binding_ref":{"kind":"model-deployment-binding","key":"fictional-binding","revision":"1","expected_hash":H},"validity":{"valid_from":"2026-01-01T00:00:00Z","valid_until":None},"rates":[{"schema_version":"1","unit":"input-token","amount":"0.0100","currency":"CNY"}],"pricing_scheme":"metered","non_billed_reason":None,"deployment_ref":None,"service_profile":None}
    jsonschema.validate(payload,schema("rate-card.schema.json")); path=tmp_path/"artifact.json"; path.write_text(json.dumps(payload)); assert load_artifact_file(path).rates[0].amount=="0.0100"

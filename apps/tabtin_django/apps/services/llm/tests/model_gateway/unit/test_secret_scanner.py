import json

import pytest

from apps.services.llm.model_gateway.validation.secret_scanner import SECRET_FIELDS, reference_contract, scan_artifact_file, scan_raw_tree

HASH = "sha256:" + "a" * 64


def artifact(kind, **fields):
    return {"identity": {"kind": kind, "key": "fixture", "revision": "1", "canonical_hash": HASH}, **fields}


@pytest.mark.parametrize("field",sorted(SECRET_FIELDS))
def test_each_prohibited_secret_field_is_detected_without_value_disclosure(field):
    value="SyntheticCredential_9Xq7Lm2P4R8T6V1N"
    findings=scan_raw_tree({field:value},"fixture.json")
    assert len(findings)==1 and findings[0].rule_code=="secret_field"
    assert value not in findings[0].model_dump_json()


def test_mixed_case_nested_unknown_secret_field_is_detected():
    assert scan_raw_tree({"unknown":{"Client_Secret":"SyntheticCredential_1234567890"}},"fixture.yaml")[0].path=="$.unknown.Client_Secret"


def test_anchored_names_avoid_token_and_key_false_positives():
    safe={"context_window_tokens":100,"max_output_tokens":10,"reasoning_tokens":2,"token_budget":50,"token_price":"0.01","token_usage":4,"artifact_key":"fictional","mapping_key":"map","model_key":"model","evidence_key":"evidence"}
    assert scan_raw_tree(safe,"fixture.json")==()


def test_exact_ref_is_allowed_but_arbitrary_ref_value_is_blocked():
    good={"kind":"model-capability","key":"fictional","revision":"1","expected_hash":"sha256:"+"a"*64}
    assert scan_raw_tree(artifact("model-deployment-binding",capability_ref=good),"fixture.json")==()
    assert scan_raw_tree(artifact("model-deployment-binding",capability_ref="SyntheticCredential_1234567890"),"fixture.json")[0].rule_code=="invalid_opaque_reference"


def test_approved_optional_exact_ref_accepts_none():
    assert scan_raw_tree(artifact("deployment-profile",replacement_ref=None),"fixture.json")==()


def test_nested_approved_optional_exact_ref_accepts_none():
    value=artifact("model-capability",capabilities=[{"runtime_mapping_ref":None,"preprocessing_ref":None,"retention_ref":None}])
    assert scan_raw_tree(value,"fixture.json")==()


def test_required_exact_ref_rejects_none():
    findings=scan_raw_tree(artifact("model-deployment-binding",capability_ref=None),"fixture.json")
    assert {item.rule_code for item in findings}=={"invalid_opaque_reference"}


def test_unknown_ref_field_does_not_accept_none():
    findings=scan_raw_tree(artifact("model-capability",future_ref=None),"fixture.json")
    assert {item.rule_code for item in findings}=={"invalid_opaque_reference"}


def test_no_optional_opaque_reference_is_declared_by_current_schema():
    assert reference_contract("deployment-profile","$.credential_pool_ref")=="required-opaque-stable-key"
    assert reference_contract("deployment-profile","$.future_pool_ref")=="unknown"


@pytest.mark.parametrize("pool_key",["a","platform-kimi-primary"],ids=["minimum-stable-key","hyphenated-stable-key"])
def test_valid_credential_pool_reference(pool_key):
    value=artifact("deployment-profile",credential_pool_ref={"pool_key":pool_key})
    assert scan_raw_tree(value,"fixture.json")==()


def test_valid_credential_pool_reference_scan_is_deterministic():
    value=artifact("deployment-profile",credential_pool_ref={"pool_key":"platform-kimi-primary"})
    assert scan_raw_tree(value,"fixture.json")==scan_raw_tree(value,"fixture.json")


@pytest.mark.parametrize("pool_ref",[
    {},
    {"pool_key":""},
    {"pool_key":1},
    {"pool_key":"Bad Key"},
    {"pool_key":{"nested":"value"}},
    {"pool_key":["value"]},
    {"pool_key":"https://example.test/pool"},
    {"pool_key":"platform-primary","label":"extra"},
    {"pool_key":"test-api-key"},
    {"pool_key":"a9zy8xw7vu6ts5rq4po3nm2lk1ji0hgfedcb"},
],ids=["missing","empty","non-string","malformed","nested","list","url","extra","credential-prefix","high-entropy"])
def test_invalid_credential_pool_reference_is_blocked(pool_ref):
    findings=scan_raw_tree(artifact("deployment-profile",credential_pool_ref=pool_ref),"fixture.json")
    assert "invalid_opaque_reference" in {item.rule_code for item in findings}


@pytest.mark.parametrize("field",["api_key","secret_key","access_token","authorization","credential_value"])
def test_secret_sibling_inside_credential_pool_reference_remains_blocking(field):
    pool={"pool_key":"platform-kimi-primary",field:"SyntheticCredential_1234567890"}
    findings=scan_raw_tree(artifact("deployment-profile",credential_pool_ref=pool),"fixture.json")
    assert "invalid_opaque_reference" in {item.rule_code for item in findings}
    assert "secret_field" in {item.rule_code for item in findings}
    assert "Synthetic" not in "".join(item.model_dump_json() for item in findings)


def test_invalid_reference_does_not_suppress_nested_secret():
    value=artifact("model-deployment-binding",capability_ref={"api_key":"SyntheticCredential_1234567890"})
    codes={item.rule_code for item in scan_raw_tree(value,"fixture.json")}
    assert {"invalid_opaque_reference","secret_field"}<=codes


@pytest.mark.parametrize("body,code",[
    ('authorization: Bearer SyntheticToken_12345678901234567890','authorization_material'),
    ('value: sk_SyntheticCredential1234567890','known_credential_format'),
    ('value: -----BEGIN PRIVATE KEY-----','private_key_marker'),
    ('url: https://user:password@example.test/v1','url_userinfo'),
    ('url: https://example.test/v1?token=SyntheticToken123456','url_query_secret'),
])
def test_raw_known_formats_are_detected(body,code,tmp_path):
    path=tmp_path/"invalid.yaml"; path.write_text(body)
    findings=scan_artifact_file(path)
    assert code in {item.rule_code for item in findings}
    assert "Synthetic" not in "".join(item.model_dump_json() for item in findings)


def test_invalid_source_still_reports_secret_and_never_echoes_source_line(tmp_path):
    value="SyntheticCredential_9Xq7Lm2P4R8T6V1N"; path=tmp_path/"broken.json"; path.write_text('{"api_key":"'+value+'",')
    findings=scan_artifact_file(path)
    assert findings and value not in "".join(item.model_dump_json() for item in findings)


def test_entropy_threshold_and_safe_formats():
    candidate="A9zY8xW7vU6tS5rQ4pO3nM2lK1jI0hGfEdCb"
    assert "high_entropy_candidate" in {item.rule_code for item in scan_raw_tree({"value":candidate},"x")}
    safe=["short-value","sha256:"+"a"*64,"123e4567-e89b-12d3-a456-426614174000","2026-08-05T12:00:00Z","0.000510"]
    assert all(scan_raw_tree({"value":value},"x")==() for value in safe)

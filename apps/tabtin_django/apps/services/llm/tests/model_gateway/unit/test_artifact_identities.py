import pytest
from pydantic import ValidationError

from apps.services.llm.model_gateway import ArtifactIdentity, ExactRef


HASH = "sha256:" + "a" * 64


def test_valid_exact_identity_and_serialization():
    identity = ArtifactIdentity(kind="model-capability", key="fictional-model", revision="1", canonical_hash=HASH)
    assert identity.model_dump_json() == '{"kind":"model-capability","key":"fictional-model","revision":"1","canonical_hash":"' + HASH + '"}'


@pytest.mark.parametrize("field", ["kind", "key", "revision", "canonical_hash"])
def test_identity_requires_every_component(field):
    values = {"kind": "model-capability", "key": "fictional-model", "revision": "1", "canonical_hash": HASH}
    values.pop(field)
    with pytest.raises(ValidationError):
        ArtifactIdentity.model_validate(values)


@pytest.mark.parametrize("values", [
    {"key": "Not_Stable"}, {"revision": "latest"}, {"revision": "1.1"},
    {"canonical_hash": "a" * 64}, {"canonical_hash": "sha256:" + "A" * 64},
])
def test_invalid_identity_values(values):
    base = {"kind": "model-capability", "key": "fictional-model", "revision": "1", "canonical_hash": HASH}
    with pytest.raises(ValidationError):
        ArtifactIdentity.model_validate(base | values)


def test_identity_is_immutable_and_reference_is_exact():
    identity = ArtifactIdentity(kind="model-capability", key="fictional-model", revision="1", canonical_hash=HASH)
    with pytest.raises(ValidationError):
        identity.key = "changed"
    ref = ExactRef(kind="model-capability", key="fictional-model", revision="1", expected_hash=HASH)
    assert ref.revision == "1"


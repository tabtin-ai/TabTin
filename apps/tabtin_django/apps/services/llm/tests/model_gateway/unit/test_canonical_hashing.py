import json
import subprocess
import sys

from apps.services.llm.model_gateway import calculate_canonical_hash, verify_canonical_hash


def artifact(key="fictional-model", revision="1", value="x", stored_hash="sha256:" + "0" * 64):
    return {"schema_version": "1", "identity": {"kind": "model-capability", "key": key, "revision": revision, "canonical_hash": stored_hash}, "value": value}


def test_hash_is_deterministic_and_excludes_stored_self_hash():
    first = artifact(stored_hash="sha256:" + "a" * 64)
    second = artifact(stored_hash="sha256:" + "b" * 64)
    digest = calculate_canonical_hash(first)
    assert digest == calculate_canonical_hash(second)
    assert digest.startswith("sha256:") and len(digest) == 71
    assert verify_canonical_hash(first, digest)


def test_content_identity_key_and_revision_change_hash():
    base = calculate_canonical_hash(artifact())
    assert base != calculate_canonical_hash(artifact(value="y"))
    assert base != calculate_canonical_hash(artifact(key="another-model"))
    assert base != calculate_canonical_hash(artifact(revision="2"))


def test_presentation_order_and_fresh_process_are_stable():
    value = artifact()
    local = calculate_canonical_hash(value)
    code = "from apps.services.llm.model_gateway import calculate_canonical_hash; import json; print(calculate_canonical_hash(json.loads(" + repr(json.dumps(value)) + ")))"
    result = subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True)
    assert result.stdout.strip() == local
    assert local == calculate_canonical_hash(dict(reversed(list(value.items()))))


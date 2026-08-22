"""Bounded, schema-aware secret scanning with value-safe diagnostics."""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from ..domain.security import SecretFinding
from ..loading.loader import ArtifactLoadError, LoaderLimits, load_artifact_file, parse_raw_artifact


SECRET_FIELDS = frozenset({"api_key","secret_key","client_secret","access_key_id","secret_access_key","private_key","password","authorization","bearer_token","access_token","refresh_token","credential_value","encrypted_secret_payload"})
SAFE_FIELDS = frozenset({"context_window_tokens","max_output_tokens","input_tokens","output_tokens","reasoning_tokens","cached_input_tokens","token_budget","token_price","token_usage","token_count","token_limit","key","model_key","mapping_key","evidence_keys","canonical_hash","expected_hash"})
RAW_RULES = (
    ("secret_field_raw", re.compile(r"(?i)[\"']?(?:api_key|secret_key|client_secret|access_key_id|secret_access_key|private_key|password|authorization|bearer_token|access_token|refresh_token|credential_value|encrypted_secret_payload)[\"']?\s*[:=]\s*[\"']?[^\s,}\"']{8,}")),
    ("authorization_material", re.compile(r"(?im)^\s*authorization\s*[:=]\s*(?:bearer\s+)?[^\s]{8,}")),
    ("bearer_material", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{12,}")),
    ("private_key_marker", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("known_credential_format", re.compile(r"\b(?:sk|ak|tok)_[A-Za-z0-9]{20,}\b")),
    ("url_userinfo", re.compile(r"https?://[^\s/@:]+:[^\s/@]+@")),
    ("url_query_secret", re.compile(r"(?i)[?&](?:token|secret|api_key|access_key)=[^&\s]+")),
)
_SAFE_VALUE = (re.compile(r"^sha256:[0-9a-f]{64}$"), re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",re.I), re.compile(r"^\d{4}-\d{2}-\d{2}T"), re.compile(r"^\d+(?:\.\d+)?$"))
_STABLE_KEY = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_CREDENTIAL_PREFIX = re.compile(r"^(?:sk|ak|tok)[_-]", re.I)

ReferenceContract = Literal[
    "optional-exact",
    "required-exact",
    "optional-opaque-stable-key",
    "required-opaque-stable-key",
    "unknown",
]

_OPTIONAL_EXACT_REFS = {
    ("model-capability", "$.capabilities.runtime_mapping_ref"),
    ("model-capability", "$.capabilities.preprocessing_ref"),
    ("model-capability", "$.capabilities.retention_ref"),
    ("deployment-profile", "$.endpoint_policy_ref"),
    ("deployment-profile", "$.replacement_ref"),
    ("runtime-wire-mapping", "$.capability_ref"),
    ("protocol-readiness", "$.contract_evidence_ref"),
    ("protocol-readiness", "$.allowlist_ref"),
    ("extension-target-allowlist", "$.mapping_schema_ref"),
    ("rate-card", "$.deployment_ref"),
    ("rollout-policy", "$.replacement_ref"),
}
_REQUIRED_EXACT_REFS = {
    ("product-control-mapping", "$.capability_ref"),
    ("runtime-wire-mapping", "$.product_mapping_ref"),
    ("deployment-profile", "$.protocol_readiness_ref"),
    ("model-deployment-binding", "$.capability_ref"),
    ("model-deployment-binding", "$.deployment_ref"),
    ("model-deployment-binding", "$.rollout_ref"),
    ("rate-card", "$.binding_ref"),
    ("projection-revision", "$.deployment_ref"),
    ("projection-revision", "$.binding_ref"),
}
_REQUIRED_OPAQUE_REFS = {
    ("deployment-profile", "$.credential_pool_ref"),
}


def _fingerprint(value: str) -> str: return "fp:"+hashlib.sha256(value.encode()).hexdigest()[:12]
def _category(value: str) -> str: return "short" if len(value)<16 else "medium" if len(value)<40 else "long"
def _finding(code,source,value,*,path=None,line=None,column=None): return SecretFinding(rule_code=code,source=source,path=path,line=line,column=column,length_category=_category(value),fingerprint=_fingerprint(value),remediation="remove-secret-material")
def _entropy(value: str) -> float:
    counts=Counter(value); n=len(value); return -sum((count/n)*math.log2(count/n) for count in counts.values())
def _looks_secret(value: str) -> bool:
    if len(value)<32 or any(rule.fullmatch(value) for rule in _SAFE_VALUE): return False
    return bool(re.fullmatch(r"[A-Za-z0-9_+/.=-]+",value)) and _entropy(value)>=4.3
def _valid_ref(value: Any) -> bool:
    return isinstance(value,dict) and set(value)=={"kind","key","revision","expected_hash"} and isinstance(value.get("expected_hash"),str) and bool(re.fullmatch(r"sha256:[0-9a-f]{64}",value["expected_hash"]))


def _normalized_schema_path(path: str) -> str:
    return re.sub(r"\[\d+\]", "", path)


def reference_contract(artifact_kind: str | None, path: str) -> ReferenceContract:
    key = (artifact_kind or "", _normalized_schema_path(path))
    if key in _OPTIONAL_EXACT_REFS:
        return "optional-exact"
    if key in _REQUIRED_EXACT_REFS:
        return "required-exact"
    if key in _REQUIRED_OPAQUE_REFS:
        return "required-opaque-stable-key"
    return "unknown"


def _valid_pool_ref(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {"pool_key"}:
        return False
    pool_key = value.get("pool_key")
    if not isinstance(pool_key, str) or not _STABLE_KEY.fullmatch(pool_key):
        return False
    if _CREDENTIAL_PREFIX.match(pool_key) or _looks_secret(pool_key):
        return False
    return True


def scan_raw_text(path: Path, *, max_bytes: int = 1_048_576) -> tuple[SecretFinding,...]:
    path=Path(path)
    if path.is_symlink(): return ()
    with path.open("rb") as stream: data=stream.read(max_bytes+1)
    text=data[:max_bytes].decode("utf-8",errors="replace"); findings=[]
    for code,rule in RAW_RULES:
        for match in rule.finditer(text):
            findings.append(_finding(code,Path(path).name,match.group(0),line=text.count("\n",0,match.start())+1,column=match.start()-text.rfind("\n",0,match.start())))
    return tuple(findings)


def scan_raw_tree(value: Any, source: str, path: str = "$", *, artifact_kind: str | None = None) -> tuple[SecretFinding,...]:
    findings=[]
    if isinstance(value,dict):
        if path == "$" and artifact_kind is None:
            identity = value.get("identity")
            if isinstance(identity, dict) and isinstance(identity.get("kind"), str):
                artifact_kind = identity["kind"]
        for key,item in value.items():
            normalized=key.casefold(); child=f"{path}.{key}"
            if normalized in SECRET_FIELDS:
                findings.append(_finding("secret_field",source,str(item),path=child))
                continue
            if normalized.endswith("_ref") and normalized not in SAFE_FIELDS:
                contract = reference_contract(artifact_kind, child)
                is_valid = False
                if contract == "optional-exact":
                    is_valid = item is None or _valid_ref(item)
                elif contract == "required-exact":
                    is_valid = _valid_ref(item)
                elif contract == "optional-opaque-stable-key":
                    is_valid = item is None or _valid_pool_ref(item)
                elif contract == "required-opaque-stable-key":
                    is_valid = _valid_pool_ref(item)
                if not is_valid:
                    findings.append(_finding("invalid_opaque_reference",source,str(item),path=child))
                if isinstance(item, (dict, list, tuple)):
                    findings.extend(scan_raw_tree(item,source,child,artifact_kind=artifact_kind))
                continue
            findings.extend(scan_raw_tree(item,source,child,artifact_kind=artifact_kind))
    elif isinstance(value,(list,tuple)):
        for index,item in enumerate(value): findings.extend(scan_raw_tree(item,source,f"{path}[{index}]",artifact_kind=artifact_kind))
    elif isinstance(value,str) and _looks_secret(value): findings.append(_finding("high_entropy_candidate",source,value,path=path))
    return tuple(findings)


def scan_artifact_file(path: Path, *, limits: LoaderLimits | None = None) -> tuple[SecretFinding,...]:
    findings=list(scan_raw_text(path,max_bytes=(limits or LoaderLimits()).max_bytes))
    try:
        raw=parse_raw_artifact(path,limits=limits); findings.extend(scan_raw_tree(raw,Path(path).name))
        try:
            typed=load_artifact_file(path,limits=limits); findings.extend(scan_raw_tree(typed.model_dump(mode="python"),Path(path).name))
        except ArtifactLoadError: pass
    except ArtifactLoadError: pass
    unique={(f.rule_code,f.source,f.path,f.line,f.column,f.fingerprint):f for f in findings}
    return tuple(unique[key] for key in sorted(unique))

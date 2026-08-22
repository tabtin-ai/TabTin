from __future__ import annotations
from dataclasses import dataclass
import hashlib, json
from typing import Any, Mapping

def safe_hash(value: Any) -> str:
    encoded=json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=True).encode()
    return "sha256:"+hashlib.sha256(encoded).hexdigest()

@dataclass(frozen=True)
class ProtocolSurfaceComparison:
    surface: str; classification: str; legacy_hash: str; adapter_hash: str

@dataclass(frozen=True)
class ProtocolShadowComparisonResult:
    package: str; protocol_type: str; fixture_key: str; same_input_hash: str
    surfaces: tuple[ProtocolSurfaceComparison,...]; evidence_refs: tuple[str,...]; comparison_hash: str
    @property
    def has_blocker(self): return any(s.classification=="behavior_blocking_mismatch" for s in self.surfaces)
    def as_dict(self):
        return {"package":self.package,"protocol_type":self.protocol_type,"fixture_key":self.fixture_key,"same_input_hash":self.same_input_hash,"surfaces":[s.__dict__ for s in self.surfaces],"evidence_refs":list(self.evidence_refs),"comparison_hash":self.comparison_hash,"has_blocker":self.has_blocker}

def compare_protocol_observations(*,package:str,protocol_type:str,fixture_key:str,same_input:Mapping[str,Any],legacy:Mapping[str,Any],adapter:Mapping[str,Any],evidence_refs=()):
    if legacy.get("same_input_hash") != adapter.get("same_input_hash") or legacy.get("same_input_hash") != safe_hash(same_input): raise ValueError("same-input-mismatch")
    surfaces=[]
    for key in sorted(set(legacy)-{"same_input_hash"}|(set(adapter)-{"same_input_hash"})):
        left,right=legacy.get(key),adapter.get(key)
        surfaces.append(ProtocolSurfaceComparison(key,"equivalent" if left==right else "behavior_blocking_mismatch",safe_hash(left),safe_hash(right)))
    payload={"package":package,"protocol_type":protocol_type,"fixture_key":fixture_key,"same_input_hash":safe_hash(same_input),"surfaces":[s.__dict__ for s in surfaces],"evidence_refs":sorted(evidence_refs)}
    return ProtocolShadowComparisonResult(package,protocol_type,fixture_key,payload["same_input_hash"],tuple(surfaces),tuple(sorted(evidence_refs)),safe_hash(payload))

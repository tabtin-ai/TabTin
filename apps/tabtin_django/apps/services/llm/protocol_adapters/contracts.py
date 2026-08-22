from __future__ import annotations
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Mapping
from .errors import ProtocolContractError
from .types import ProtocolType, StreamEventKind

def freeze(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)): return value
    if isinstance(value, float): raise ProtocolContractError("floating-point-values-not-allowed")
    if isinstance(value, Mapping): return MappingProxyType({str(k): freeze(v) for k, v in value.items()})
    if isinstance(value, (list, tuple)): return tuple(freeze(v) for v in value)
    raise ProtocolContractError("unsupported-contract-value")

def thaw(value: Any) -> Any:
    if isinstance(value, Mapping): return {k: thaw(v) for k, v in value.items()}
    if isinstance(value, tuple): return [thaw(v) for v in value]
    return value

@dataclass(frozen=True, repr=False)
class ResolvedCredential:
    _value: str
    def __post_init__(self):
        if not self._value: raise ProtocolContractError("credential-empty")
    def reveal(self) -> str: return self._value
    def __repr__(self) -> str: return "ResolvedCredential([REDACTED])"

@dataclass(frozen=True)
class CanonicalLLMRequest:
    model: str
    messages: tuple[Mapping[str, Any], ...]
    stream: bool = True
    fields: Mapping[str, Any] = field(default_factory=dict)
    def __post_init__(self):
        object.__setattr__(self, "messages", tuple(freeze(v) for v in self.messages))
        object.__setattr__(self, "fields", freeze(self.fields))

@dataclass(frozen=True)
class ProtocolExecutionContext:
    protocol_type: ProtocolType
    endpoint: str
    credential: ResolvedCredential
    timeout_profile: str = "default"
    request_id: str = "offline"
    protocol_options: Mapping[str, Any] = field(default_factory=dict)
    def __post_init__(self): object.__setattr__(self, "protocol_options", freeze(self.protocol_options))

@dataclass(frozen=True)
class PreparedProtocolRequest:
    protocol_type: ProtocolType; method: str; url: str; headers: Mapping[str, str]; body: Mapping[str, Any]
    stream: bool; timeout_profile: str; fingerprint: str; diagnostic_summary: Mapping[str, Any]
    def __post_init__(self):
        object.__setattr__(self, "headers", freeze(self.headers)); object.__setattr__(self, "body", freeze(self.body)); object.__setattr__(self, "diagnostic_summary", freeze(self.diagnostic_summary))

@dataclass(frozen=True)
class UsageDimension:
    value: int | None; source: str

@dataclass(frozen=True)
class NormalizedUsage:
    input_tokens: UsageDimension; output_tokens: UsageDimension; total_tokens: UsageDimension
    cached_input_tokens: UsageDimension; reasoning_tokens: UsageDimension
    raw_usage: Mapping[str, Any] = field(default_factory=dict)
    def __post_init__(self): object.__setattr__(self, "raw_usage", freeze(self.raw_usage))

@dataclass(frozen=True)
class NormalizedProtocolError:
    category: str; http_status: int | None; upstream_code: str | None; retryable: bool
    is_rate_limit: bool; is_authentication: bool; diagnostic_code: str; failure_phase: str

@dataclass(frozen=True)
class UpstreamFailure:
    phase: str; http_status: int | None = None; upstream_code: str | None = None; category_hint: str | None = None

@dataclass(frozen=True)
class ProtocolStreamEvent:
    kind: StreamEventKind; original_payload: str | None = None; parsed_payload: Mapping[str, Any] | None = None
    usage: NormalizedUsage | None = None; output_character_delta: int = 0; error: NormalizedProtocolError | None = None

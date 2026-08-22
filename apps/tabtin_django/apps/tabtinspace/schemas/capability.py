"""Tabtin Space capability schemas。"""

from .common import *  # noqa: F401,F403

class CapabilityDiscoveryExecutionBindingOut(BaseModel):
    bound: bool
    binding_source: str
    device_id: Optional[str] = None
    device_fingerprint: Optional[str] = None
    device_name: Optional[str] = None
    device_type: Optional[str] = None
    device_status: Optional[str] = None
    last_heartbeat_at: Optional[str] = None
    refresh_transport: str
    can_refresh_via_backend: bool = False
    can_refresh_locally: bool = False
    reason_codes: List[str] = Field(default_factory=list)

class CapabilityDiscoverySnapshotOut(BaseModel):
    available: bool
    observed_at: Optional[str] = None
    freshness_state: str
    stale_reason: Optional[str] = None
    reason_codes: List[str] = Field(default_factory=list)
    snapshot_version: Optional[int] = None
    snapshot_source: Optional[str] = None
    runtime_tools_count: int = 0
    mcp_tools_count: int = 0
    snapshot: Optional[Dict[str, Any]] = None

class CapabilityDiscoverySpaceSummaryOut(BaseModel):
    space_id: str
    organization_id: str
    generated_at: str
    backend_type: str
    space_device_binding: Dict[str, Any] = Field(default_factory=dict)
    execution_binding: CapabilityDiscoveryExecutionBindingOut
    execution_snapshot: CapabilityDiscoverySnapshotOut

class CapabilityRefreshRequest(BaseModel):
    requested_by: str = Field(default="manual", description="刷新来源，例如 manual / ui / auto")
    timeout_seconds: int = Field(default=12, ge=1, le=30, description="等待设备 ack/result 的超时时间")

class CapabilityRefreshResponse(BaseModel):
    status: Literal["accepted", "ok", "pending", "failed", "timeout", "offline", "unsupported", "unbound"]
    reason_code: str
    refresh_request_id: Optional[str] = None
    ack: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    summary: CapabilityDiscoverySpaceSummaryOut

__all__ = [
    'CapabilityDiscoveryExecutionBindingOut',
    'CapabilityDiscoverySnapshotOut',
    'CapabilityDiscoverySpaceSummaryOut',
    'CapabilityRefreshRequest',
    'CapabilityRefreshResponse',
]

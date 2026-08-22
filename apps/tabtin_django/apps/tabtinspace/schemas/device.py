"""Tabtin Space device schemas。"""

from .common import *  # noqa: F401,F403

class DeviceRegister(BaseModel):
    """设备注册/更新请求（Electron 启动时调用）"""
    organization_id: UUID
    fingerprint: str = Field(..., description="设备唯一指纹，如 electron-{uuid} 或 electron-{machine_key}")
    device_type: str = Field(default='electron', description="设备类型: electron | daemon | cloud | mobile | iot（兼容 ios/android 入参）")
    name: str = Field(..., description="设备显示名称，如 MacBook Pro")
    os_info: Optional[Dict[str, Any]] = Field(default=None, description='{"os": "macOS", "arch": "arm64"}')
    capabilities: Optional[List[str]] = Field(default=None, description='["terminal_execute", "browser", "file"]')
    machine_key: Optional[str] = Field(
        default=None,
        max_length=64,
        description="硬件锚定密钥 sha256(machineId+profile)[:32]；同机同档注册合并用",
    )
    previous_fingerprint: Optional[str] = Field(
        default=None,
        description="兼容旧协议的首个历史 fingerprint；用于 reclaim 保留 Device.id / Space 绑定",
    )
    recovery_fingerprints: Optional[List[str]] = Field(
        default=None,
        max_length=16,
        description="客户端可证明的历史安装 fingerprint；仅在当前用户范围内恢复",
    )

    _check_fingerprint = field_validator('fingerprint')(_validate_fingerprint)

    @field_validator('previous_fingerprint')
    @classmethod
    def _check_previous_fingerprint(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        return _validate_fingerprint(v)

    @field_validator('recovery_fingerprints')
    @classmethod
    def _check_recovery_fingerprints(cls, values: Optional[List[str]]) -> Optional[List[str]]:
        if not values:
            return None
        return list(dict.fromkeys(_validate_fingerprint(value) for value in values if value))

class DeviceHeartbeat(BaseModel):
    """设备心跳请求"""
    fingerprint: str = Field(..., description="设备唯一指纹")
    capabilities: Optional[List[str]] = Field(default=None, description="设备能力列表（Daemon 上报）")
    system_info: Optional[Dict[str, Any]] = Field(default=None, description="运行时系统信息/动态能力信息（设备态上报）")

    _check_fingerprint = field_validator('fingerprint')(_validate_fingerprint)

class DeviceTokenRenew(BaseModel):
    """Daemon token 续期请求"""
    fingerprint: str = Field(..., description="设备唯一指纹")

    _check_fingerprint = field_validator('fingerprint')(_validate_fingerprint)

class DeviceOffline(BaseModel):
    """设备主动离线请求"""
    fingerprint: str = Field(..., description="设备唯一指纹")
    token: Optional[str] = Field(default=None, alias="_token", description="sendBeacon 场景的 JWT token（无法设 header）")

    _check_fingerprint = field_validator('fingerprint')(_validate_fingerprint)

class DeviceUpdate(BaseModel):
    """更新设备名称或能力列表"""
    name: Optional[str] = None
    capabilities: Optional[List[str]] = None

class DevicePushTokenRegister(BaseModel):
    """iOS APNs device token 上报。"""
    registration_id: str = Field(..., min_length=1, max_length=255, description="APNs device token（hex）")
    platform: str = Field(default='ios', pattern=r"^ios$", description="平台: ios")
    provider: str = Field(default='apns', pattern=r"^apns$", description="推送服务商: apns")
    environment: str = Field(default='production', pattern=r"^(sandbox|production)$", description="APNs 环境")
    fingerprint: Optional[str] = Field(default=None, description="设备指纹（可选，仅排障归因）")
    app_version: Optional[str] = Field(default=None, max_length=32, description="App 版本")

class DevicePushTokenRevoke(BaseModel):
    """登出时反注册推送 token"""
    registration_id: str = Field(..., min_length=1, max_length=255)
    provider: str = Field(default='apns', pattern=r"^apns$")

class DeviceActionRequest(BaseModel):
    """统一设备动作调用请求"""
    thread_id: str = Field(..., min_length=1, max_length=200, description="线程 ID，例如 chat-session-xxx")
    action: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_]*$", description="动作类型，例如 execute_in_terminal")
    params: Dict[str, Any] = Field(default_factory=dict, description="动作参数")
    timeout_seconds: int = Field(default=60, ge=1, le=600, description="等待结果超时时间（秒）")

    _check_params = field_validator("params")(_validate_params_size)

class SpaceDeviceActionRequest(BaseModel):
    """面向 CLI/系统调用的 Space 级设备动作请求"""

    model_config = ConfigDict(extra="forbid")

    space_id: UUID = Field(..., description="目标 Space ID")
    action: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_]*$", description="动作类型，例如 get_device_info")
    params: Dict[str, Any] = Field(default_factory=dict, description="动作参数")
    timeout_seconds: int = Field(default=60, ge=1, le=600, description="等待结果超时时间（秒）")

    _check_params = field_validator("params")(_validate_params_size)

class DeviceActionResponse(BaseModel):
    """统一设备动作调用响应"""
    success: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    http_status: Optional[int] = None
    degraded: bool = False
    device_fingerprint: Optional[str] = None
    device_type: Optional[str] = None
    dispatch_reason: Optional[str] = None
    required_capability: Optional[str] = None
    binding_source: Optional[str] = None

class DeviceOut(BaseModel):
    """设备输出"""
    id: UUID
    organization_id: UUID
    user_id: str
    name: str
    device_type: str
    role: str = Field(default="control", description="设备角色: control | data")
    fingerprint: str
    machine_key: str = Field(default="", description="硬件锚定密钥；空表示未上报")
    os_info: Dict[str, Any]
    capabilities: List[str]
    status: str
    last_heartbeat_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

class DeviceListResponse(BaseModel):
    devices: List[DeviceOut]
    total: int

class SpaceBindDevice(BaseModel):
    """绑定执行设备请求；恢复历史离线绑定时须显式确认。"""
    device_id: Optional[UUID] = Field(default=None, description="设备 ID，为 null 时解绑")
    expected_version: Optional[int] = Field(default=None, description="CAS 乐观并发控制：传入当前 config_version，版本不匹配时返回 409")
    recover_offline_binding: bool = Field(
        default=False,
        description="仅 owner 可显式把离线历史执行绑定恢复到指定设备",
    )

class AgentBindDevice(SpaceBindDevice):
    """绑定/解绑 Agent 执行设备请求"""

__all__ = [
    'DeviceRegister',
    'DeviceHeartbeat',
    'DevicePushTokenRegister',
    'DevicePushTokenRevoke',
    'DeviceTokenRenew',
    'DeviceOffline',
    'DeviceUpdate',
    'DeviceActionRequest',
    'SpaceDeviceActionRequest',
    'DeviceActionResponse',
    'DeviceOut',
    'DeviceListResponse',
    'SpaceBindDevice',
    'AgentBindDevice',
]

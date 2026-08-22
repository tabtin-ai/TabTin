"""Tabtin Space daemon schemas。"""

from .common import *  # noqa: F401,F403

class DaemonInstallTokenCreate(BaseModel):
    """生成 Daemon 安装 Token 请求"""
    organization_id: UUID = Field(..., description="目标组织")
    device_name: str = Field(..., description="预设设备名称")
    expires_minutes: int = Field(default=60, description="Token 有效期（分钟），默认 1 小时")

class DaemonInstallTokenOut(BaseModel):
    """安装 Token 输出"""
    token: str = Field(..., description="JWT 格式的安装 Token")
    expires_at: str = Field(..., description="过期时间 ISO 格式")

class DaemonActivate(BaseModel):
    """Daemon 设备激活请求（Token → 长期凭据）"""
    token: str = Field(..., description="安装 Token")
    fingerprint: str = Field(..., description="Daemon 生成的设备指纹")
    device_type: str = Field(default='daemon', description="设备类型")
    device_name: str = Field(default='', description="设备名称（可覆盖 Token 中的预设）")
    os_info: Optional[Dict[str, Any]] = Field(default=None, description="操作系统信息")
    capabilities: Optional[List[str]] = Field(default=None, description="设备能力列表")

    _check_fingerprint = field_validator('fingerprint')(_validate_fingerprint)

__all__ = [
    'DaemonInstallTokenCreate',
    'DaemonInstallTokenOut',
    'DaemonActivate',
]

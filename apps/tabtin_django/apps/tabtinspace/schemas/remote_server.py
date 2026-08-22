"""Tabtin Space remote_server schemas。"""

from .common import *  # noqa: F401,F403

class RemoteServerCreate(BaseModel):
    """创建 SSH 服务器"""
    name: str = Field(..., description="服务器显示名称")
    host: str = Field(..., description="主机地址")
    port: int = Field(default=22, description="SSH 端口")
    username: str = Field(..., description="登录用户名")
    auth_method: str = Field(..., description="认证方式: key | password")
    credential_value: Optional[str] = Field(default=None, description="明文密码或私钥内容（后端加密存储）")
    credential_name: Optional[str] = Field(default=None, description="凭据名称（可选）")

class RemoteServerUpdate(BaseModel):
    """更新 SSH 服务器"""
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    auth_method: Optional[str] = None
    credential_value: Optional[str] = Field(default=None, description="更新凭据时传入明文")
    status: Optional[str] = None

class RemoteServerOut(BaseModel):
    """SSH 服务器输出（不含凭据明文）"""
    id: UUID
    device_id: UUID
    name: str
    host: str
    port: int
    username: str
    auth_method: str
    has_credential: bool = False
    status: str
    last_connected_at: Optional[datetime] = None
    os_info: Dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_server(cls, server) -> "RemoteServerOut":
        return cls(
            id=server.id,
            device_id=server.device_id,
            name=server.name,
            host=server.host,
            port=server.port,
            username=server.username,
            auth_method=server.auth_method,
            has_credential=server.credential_id is not None,
            status=server.status,
            last_connected_at=server.last_connected_at,
            os_info=server.os_info,
            created_at=server.created_at,
            updated_at=server.updated_at,
        )

class RemoteServerListResponse(BaseModel):
    servers: List[RemoteServerOut]
    total: int

__all__ = [
    'RemoteServerCreate',
    'RemoteServerUpdate',
    'RemoteServerOut',
    'RemoteServerListResponse',
]

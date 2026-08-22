"""Tabtin Space mcp_connection schemas（与 remote_server schemas 同款 Ninja 风格）。"""

from .common import *  # noqa: F401,F403

class MCPConnectionCreate(BaseModel):
    """创建 MCP 连接（device 维度 / scope=local）。"""
    name: str = Field(..., description="连接显示名称")
    description: str = Field(default="", description="可选描述")
    transport: str = Field(default="stdio", description="传输方式: stdio | http")
    command: str = Field(default="", description="stdio：启动命令")
    args: List[Any] = Field(default_factory=list, description="stdio：参数数组")
    cwd: str = Field(default="", description="stdio：工作目录")
    endpoint: str = Field(default="", description="http：服务地址 URL")
    config: Dict[str, Any] = Field(default_factory=dict, description="非敏感配置（env/headers 的 key 名等）")
    credential_value: Optional[str] = Field(default=None, description="敏感凭据明文（token / env secret，后端 Fernet 加密存储）")
    credential_name: Optional[str] = Field(default=None, description="凭据名称（可选）")
    enabled: bool = Field(default=True, description="是否启用")

class MCPConnectionOrgCreate(BaseModel):
    """创建组织级远程 MCP（scope=remote，仅 http）。"""
    name: str = Field(..., description="连接显示名称")
    description: str = Field(default="", description="可选描述")
    endpoint: str = Field(..., description="Streamable HTTP URL")
    config: Dict[str, Any] = Field(default_factory=dict, description="非敏感配置（headers key 名等）")
    credential_value: Optional[str] = Field(default=None, description="敏感凭据明文")
    credential_name: Optional[str] = Field(default=None, description="凭据名称（可选）")
    enabled: bool = Field(default=True, description="是否启用")

class MCPConnectionUpdate(BaseModel):
    """更新 MCP 连接。"""
    name: Optional[str] = None
    description: Optional[str] = None
    transport: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[Any]] = None
    cwd: Optional[str] = None
    endpoint: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    credential_value: Optional[str] = Field(default=None, description="更新凭据时传入明文")
    enabled: Optional[bool] = None

class MCPConnectionProbe(BaseModel):
    """写入 probe 结果（Electron 端真连后回传健康结果，后端只存不真连）。"""
    last_probe: Dict[str, Any] = Field(default_factory=dict, description="探针健康结果")

class MCPConnectionOut(BaseModel):
    """MCP 连接输出（不含凭据明文，只暴露 has_credential 布尔）。"""
    id: UUID
    name: str
    description: str = ""
    scope: str
    device_id: Optional[UUID] = None
    organization_id: Optional[UUID] = None
    created_by_user_id: Optional[UUID] = None
    transport: str
    command: str
    args: List[Any] = []
    cwd: str
    endpoint: str
    config: Dict[str, Any] = {}
    has_credential: bool = False
    enabled: bool
    last_probe: Dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_connection(cls, conn) -> "MCPConnectionOut":
        return cls(
            id=conn.id,
            name=conn.name,
            description=getattr(conn, "description", "") or "",
            scope=conn.scope,
            device_id=conn.device_id,
            organization_id=conn.organization_id,
            created_by_user_id=getattr(conn, 'created_by_id', None),
            transport=conn.transport,
            command=conn.command,
            args=conn.args or [],
            cwd=conn.cwd,
            endpoint=conn.endpoint,
            config=conn.config or {},
            has_credential=conn.credential_id is not None,
            enabled=conn.enabled,
            last_probe=conn.last_probe or {},
            created_at=conn.created_at,
            updated_at=conn.updated_at,
        )

class MCPConnectionRuntimeConfig(BaseModel):
    """Electron main 取密后的运行时配置（不下发到 renderer）。"""
    id: UUID
    name: str
    description: str = ""
    transport: str
    command: str = ""
    args: List[Any] = []
    cwd: str = ""
    endpoint: str = ""
    env: Dict[str, str] = {}
    headers: Dict[str, str] = {}
    enabled: bool = True

class MCPConnectionListResponse(BaseModel):
    connections: List[MCPConnectionOut]
    total: int

__all__ = [
    'MCPConnectionCreate',
    'MCPConnectionOrgCreate',
    'MCPConnectionUpdate',
    'MCPConnectionProbe',
    'MCPConnectionOut',
    'MCPConnectionRuntimeConfig',
    'MCPConnectionListResponse',
]

"""Tabtin Space share schemas。"""

from .common import *  # noqa: F401,F403

class ResourcePermissionGrant(BaseModel):
    subject_type: str = Field(..., description="权限主体类型: user/role/agent")
    subject_id: str = Field(..., description="权限主体 ID")
    permission: str = Field(default='viewer', description="权限级别: viewer/editor/admin")

__all__ = [
    'ResourcePermissionGrant',
]

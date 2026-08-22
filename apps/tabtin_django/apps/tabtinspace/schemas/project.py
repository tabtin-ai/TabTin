"""Tabtin Project schemas。

Project 的物理容器是 ``Space(type=team_space)``；本 schema 以 Project 产品语言
序列化该协作房间（不含本地执行字段——执行落到成员各自的 Workspace）。
"""

from .common import *  # noqa: F401,F403


class ProjectOut(BaseModel):
    id: UUID
    organization_id: UUID
    name: str
    description: str = ""
    avatar: str = ""
    color: str = ""
    status: str
    is_archived: bool
    visibility: str = Field(default='private', description='Project 可见范围')
    member_count: int = Field(default=1, description='当前有效成员数')
    last_activity_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


__all__ = [
    'ProjectOut',
]

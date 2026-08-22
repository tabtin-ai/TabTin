"""Tabtin Space membership schemas。"""

from .common import *  # noqa: F401,F403

class OrganizationMemberBase(BaseModel):
    role: str = Field(..., description="角色：新写入仅允许 editor（存量成员可能为 admin/viewer/owner）")

class OrganizationMemberAdd(OrganizationMemberBase):
    user_id: str = Field(..., description="用户ID")

class OrganizationMemberUpdate(BaseModel):
    role: str = Field(..., description="新角色：仅允许 editor")

class OrganizationMemberOut(OrganizationMemberBase):
    id: UUID
    organization_id: UUID
    user_id: str
    joined_at: datetime
    model_config = ConfigDict(from_attributes=True)

class MemberUserOut(BaseModel):
    id: str
    nickname: str = ""
    username: str = ""
    email: str = ""
    phone: str = ""
    avatar: str = ""

class OrganizationMemberWithUserOut(OrganizationMemberOut):
    user: MemberUserOut

class OrganizationMemberListResponse(BaseModel):
    members: List[OrganizationMemberWithUserOut]
    total: int


class OrganizationMemberProfilesRequest(BaseModel):
    user_ids: List[str] = Field(default_factory=list, max_length=200)


class SpaceMembershipCreate(BaseModel):
    agent_id: Optional[UUID] = Field(default=None, description="Agent ID（个人 workspace 兼容路径）")
    user_id: Optional[str] = Field(default=None, description="User ID（团队 Space 成员邀请）")
    role: str = Field(default='viewer', description="角色：admin/editor/viewer")

    @model_validator(mode='after')
    def _validate_single_identity(self):
        if self.agent_id is None and not self.user_id:
            raise ValueError('必须指定 agent_id 或 user_id')
        if self.agent_id is not None and self.user_id:
            raise ValueError('agent_id 与 user_id 只能二选一')
        return self

class SpaceMembershipOut(BaseModel):
    id: UUID
    # Wire：前端仍读 space_id（宿主 UUID）。Workspace 行填 workspace_id；
    # ProjectMembership 行填 project_id，并把宿主 UUID 写入 space_id / workspace_id
    # 以兼容旧客户端。
    space_id: UUID
    workspace_id: Optional[UUID] = None
    project_id: Optional[UUID] = None
    agent_id: Optional[UUID] = None
    user_id: Optional[str] = None
    role: str
    permissions: Dict[str, Any] = Field(default_factory=dict)
    is_active: bool = True
    role_label: str = ''
    responsibility: str = ''
    persona_override: str = ''
    is_primary: bool = False
    joined_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode='before')
    @classmethod
    def _coerce_host_identity(cls, data):
        if isinstance(data, dict):
            workspace_id = data.get('workspace_id')
            project_id = data.get('project_id')
            host_id = data.get('space_id') or workspace_id or project_id
            if host_id is None:
                return data
            return {
                **data,
                'space_id': host_id,
                'workspace_id': workspace_id or (None if project_id else host_id),
                'project_id': project_id,
            }

        project_id = getattr(data, 'project_id', None)
        if project_id is None:
            project = getattr(data, 'project', None)
            if project is not None:
                project_id = getattr(project, 'id', None)

        workspace_id = getattr(data, 'workspace_id', None)
        if workspace_id is None:
            workspace = getattr(data, 'workspace', None)
            if workspace is not None:
                workspace_id = getattr(workspace, 'id', None)

        host_id = workspace_id or project_id
        user_id = getattr(data, 'user_id', None)
        if user_id is None:
            user = getattr(data, 'user', None)
            if user is not None:
                user_id = getattr(user, 'id', None)

        return {
            'id': getattr(data, 'id', None),
            'space_id': host_id,
            'workspace_id': workspace_id,
            'project_id': project_id,
            'agent_id': getattr(data, 'agent_id', None),
            'user_id': str(user_id) if user_id is not None else None,
            'role': getattr(data, 'role', 'viewer'),
            'permissions': getattr(data, 'permissions', None) or {},
            'is_active': bool(getattr(data, 'is_active', True)),
            'role_label': getattr(data, 'role_label', '') or '',
            'responsibility': getattr(data, 'responsibility', '') or '',
            'persona_override': getattr(data, 'persona_override', '') or '',
            'is_primary': bool(getattr(data, 'is_primary', False)),
            'joined_at': getattr(data, 'joined_at', None),
            'updated_at': getattr(data, 'updated_at', None),
        }

class SpaceMembershipListResponse(BaseModel):
    memberships: List[SpaceMembershipOut]
    total: int

__all__ = [
    'OrganizationMemberBase',
    'OrganizationMemberAdd',
    'OrganizationMemberUpdate',
    'OrganizationMemberOut',
    'MemberUserOut',
    'OrganizationMemberWithUserOut',
    'OrganizationMemberListResponse',
    'OrganizationMemberProfilesRequest',
    'SpaceMembershipCreate',
    'SpaceMembershipOut',
    'SpaceMembershipListResponse',
]

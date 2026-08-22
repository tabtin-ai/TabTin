"""TabCode API Schemas"""

from ninja import Schema
from typing import Optional


class CodeProjectCreateRequest(Schema):
    title: str
    local_path: str = ""
    git_remote_url: str = ""


class CodeProjectUpdateRequest(Schema):
    title: Optional[str] = None
    local_path: Optional[str] = None
    git_remote_url: Optional[str] = None


class CodeProjectDetailOut(Schema):
    id: str
    title: str
    local_path: str
    git_remote_url: str
    status: str
    created_at: str
    updated_at: str

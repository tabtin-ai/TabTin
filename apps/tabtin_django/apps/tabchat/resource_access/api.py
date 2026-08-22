"""兼容别名：``/api/im/resource-access-requests`` → 正典 resource_access 处理器。

旧 IM 资源卡客户端继续打此路径；新工具栏应走 ``/api/resource-access-requests``。

注意：必须使用独立 Router 实例。Django Ninja 不允许把同一个 Router
对象同时挂到 ``/resource-access-requests`` 与 ``/im/...``。
"""

from __future__ import annotations

from ninja import Router

from apps.services.common.resource_access.api import (
    CreateResourceAccessRequest,
    approve_resource_access_request as approve_canonical,
    create_resource_access_request as create_canonical,
)
from apps.tabchat.schemas import ApiResponse
from apps.users.auth.api import jwt_auth

router = Router()


@router.post("", response=ApiResponse, auth=jwt_auth)
def create_resource_access_request(request, payload: CreateResourceAccessRequest):
    return create_canonical(request, payload)


@router.post("/{request_id}/approve", response=ApiResponse, auth=jwt_auth)
def approve_resource_access_request(request, request_id: str):
    return approve_canonical(request, request_id)

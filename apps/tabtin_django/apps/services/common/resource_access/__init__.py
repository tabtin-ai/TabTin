"""资源访问申请（viewer / editor）领域包。

正典挂载：``/api/resource-access-requests``。
``/api/im/resource-access-requests`` 仅为  IM 卡兼容别名。

持久化表仍在 ``tabchat_resource_access_request``（ 建表），本包负责
领域服务与非 IM API，避免把通用权限工作流继续绑在消息主链路上。
"""

from apps.services.common.resource_access.service import (
    ResourceAccessRequestError,
    ResourceAccessRequestService,
)

__all__ = [
    "ResourceAccessRequestError",
    "ResourceAccessRequestService",
]

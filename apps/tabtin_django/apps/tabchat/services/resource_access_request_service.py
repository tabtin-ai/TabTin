"""兼容 shim：领域服务正典在 ``apps.services.common.resource_access``。"""

from apps.services.common.resource_access.service import (  # noqa: F401
    ResourceAccessRequestError,
    ResourceAccessRequestService,
    SUPPORTED_RESOURCE_TYPES,
    SUPPORTED_ROLES,
    serialize_request,
)

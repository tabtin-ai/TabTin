"""公共分享服务（PublicShareService）

提供「匿名公开链接 + organization 限定分享」的统一底座，目前面向 tabdoc / tabdata，
未来 tabslide / tabwhiteboard 等任何需要做「凭 share_id 短链匿名访问」语义的 App
都应通过继承本基类落地，避免重复实现 share_id 生成 / 密码三态 / 过期判断 /
organization 鉴权 / 横向越权防护等关键逻辑。

设计文档：``apps/tabtin_django/apps/tabdoc/PRD-shareperm-p0-fix.md`` §3。

落地要点：
- 抽象基类 + 子类继承（非 ``Generic[T]``）—— 每个 App 写一个 ``XxxShareService(PublicShareService)``
- 通过类属性 ``share_model`` / ``resource_model`` / ``db_alias`` 绑定具体模型
- 通过抽象方法 ``check_resource_admin(...)`` / ``serialize_meta(...)`` / ``serialize_content(...)``
  桥接到 App 自身的权限服务和资源序列化
- 唯一公开访问入口为 ``verify_share_access(share, password, user)`` —— 任何 meta /
  content 端点都必须先调用它
- 唯一管理入口为 ``load_resource_for_management(resource_id, operator)`` —— 任何
  create / get / close / refresh share 必须先调用它
"""

from .auth import get_authenticated_user
from .collab_token import (
    ShareCollabClaims,
    ShareCollabPrincipal,
    resolve_share_collab_auth,
    verify_share_collab_token,
)
from .exceptions import (
    PublicShareError,
    ShareExpiredError,
    ShareManagementPermissionDeniedError,
    ShareNotFoundError,
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
    ShareOrganizationMismatchError,
    SharePublicExposureAcknowledgementRequiredError,
)
from .service import PublicShareService

__all__ = [
    "PublicShareService",
    "PublicShareError",
    "ShareNotFoundError",
    "ShareExpiredError",
    "SharePasswordRequiredError",
    "SharePasswordIncorrectError",
    "SharePermissionDeniedError",
    "ShareManagementPermissionDeniedError",
    "ShareOrganizationMismatchError",
    "SharePublicExposureAcknowledgementRequiredError",
    "get_authenticated_user",
    "ShareCollabClaims",
    "ShareCollabPrincipal",
    "resolve_share_collab_auth",
    "verify_share_collab_token",
]

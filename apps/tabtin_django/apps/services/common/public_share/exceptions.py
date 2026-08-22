"""PublicShareService 异常族

所有继承 ``PublicShareError`` 的异常，含义见 PRD §3.3。view 层应：

- catch ``ShareNotFoundError`` / ``ShareExpiredError`` 返 404 / 410
- catch ``SharePasswordRequiredError`` / ``SharePasswordIncorrectError`` 返 403
- catch ``SharePermissionDeniedError`` 返 403（organization 校验失败 → 公开端点）
- catch ``ShareManagementPermissionDeniedError`` 返 403（admin 校验失败 → 管理端点）
- catch ``ShareOrganizationMismatchError`` 返 400（P1-3 跨租户校验）

设计上**异常分两组**：
1. 公开端点（meta/content）抛 ``SharePassword*`` / ``SharePermissionDenied``，
   表示「调用者没资格访问该 share」
2. 管理端点（create/close/refresh）抛 ``ShareManagementPermissionDenied``，
   表示「调用者没资格管理该 resource 的分享」

之所以分两组，是因为公开访问失败的语义与管理失败的语义不同，
日志告警 / 监控大盘需要区分（公开 403 是合法误访问，管理 403 是潜在越权尝试）。
"""

from __future__ import annotations


class PublicShareError(Exception):
    """所有 public_share 模块异常的基类。

    捕获 ``PublicShareError`` 即可一次拦截所有 share 相关错误，
    适合在 view 层兜底用 ``except PublicShareError as exc: ...``。
    """


class ShareNotFoundError(PublicShareError):
    """share_id 不存在 / share.is_active=False。

    view 层应返回 404，提示「分享不存在或已关闭」。
    """


class ShareExpiredError(PublicShareError):
    """share 已过 expire_at 或超 max_visits。

    view 层应返回 410 Gone，提示「分享已过期」。
    """


class SharePasswordRequiredError(PublicShareError):
    """share 有密码保护但调用者未提供。

    view 层应返回 403 + 业务码 PASSWORD_REQUIRED；
    前端据此弹密码输入框。
    """


class SharePasswordIncorrectError(PublicShareError):
    """share 有密码保护但调用者提供的密码不对。

    view 层应返回 403 + 业务码 INCORRECT_PASSWORD。
    """


class SharePermissionDeniedError(PublicShareError):
    """公开端点的 organization 校验失败。

    触发条件：
    - share_type='organization' 但 user=None（匿名调用）
    - share_type='organization' 但 user 不属于 share.organization_id

    view 层应返回 403 + 业务码 PERMISSION_DENIED。
    """


class ShareManagementPermissionDeniedError(PublicShareError):
    """管理端点的 admin 校验失败 —— P0-2 防越权核心。

    触发条件：
    - 调用 ``load_resource_for_management`` 时 operator=None / operator.id 缺失
    - operator 既不是 resource owner、也通不过 ``check_resource_admin``

    view 层应返回 403 + 业务码 PERMISSION_DENIED。
    安全监控应对该异常的触发频次单独埋点（潜在横向越权探测）。
    """


class ShareOrganizationMismatchError(PublicShareError):
    """organization 作用域校验失败：``target_organization_id`` 为空或
    ``!= resource.organization_id``。

    由 ``validate_organization_scope`` 抛出（本期 organization 分享严格限定为资源所属团队）。
    view 层应返回 400 + 业务码 INVALID_ORGANIZATION_ID。
    """


class SharePublicExposureAcknowledgementRequiredError(PublicShareError):
    """扩大到公网分享前缺少显式确认。

    触发条件：从「未分享 / organization」扩大到 ``share_type=public``，
    但请求未带 ``acknowledge_public_exposure=true``。

    view 层应返回 409 + 业务码 ``PUBLIC_EXPOSURE_ACK_REQUIRED``。
    """

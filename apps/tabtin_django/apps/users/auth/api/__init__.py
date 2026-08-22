"""
用户认证 API — 路由聚合入口

将 9 个子模块的 Router 聚合为单一的 `router` 对象，
保持对外接口（URL 路径）不变。

外部消费方（tabtin/urls.py）仍通过：
    from apps.users.auth.api import router as auth_router
导入，无需修改。
"""

from ninja import Router

from .auth_routes import router as _auth_router
from .token_routes import router as _token_router
from .verification_routes import router as _verification_router
from .profile_routes import router as _profile_router
from .session_routes import router as _session_router
from .password_routes import router as _password_router
from .api_key_routes import router as _api_key_router
from .docs_routes import router as _docs_router
from .device_routes import router as _device_router

router = Router()

router.add_router("", _auth_router)
router.add_router("", _token_router)
router.add_router("", _verification_router)
router.add_router("", _profile_router)
router.add_router("", _session_router)
router.add_router("", _password_router)
router.add_router("", _api_key_router)
router.add_router("", _docs_router)
router.add_router("", _device_router)

# ── 向后兼容导出 ──
# 以下符号被外部模块（admin_api / tests / urls）通过
# `from apps.users.auth.api import xxx` 引用，必须在此重新导出。

from ._shared import jwt_auth, JWTAuth  # noqa: F401
from ._shared import (  # noqa: F401
    VERIFY_SUBMIT_IP_MAX, VERIFY_SUBMIT_IP_WINDOW,
    REFRESH_TOKEN_IP_MAX, REFRESH_TOKEN_IP_WINDOW,
    REFRESH_TOKEN_SESSION_MAX, REFRESH_TOKEN_SESSION_WINDOW,
    REFRESH_GRACE_WINDOW_SECONDS,
    _check_verify_submit_ip_rate, _check_refresh_token_rate,
)
from .auth_routes import (  # noqa: F401
    register_user, login_user, login_with_verification_code,
    logout_user,
)
from .token_routes import refresh_token  # noqa: F401
from .verification_routes import (  # noqa: F401
    send_verification_code, verify_email, verify_phone,
    send_bind_email_code, bind_email,
)
from .password_routes import (  # noqa: F401
    change_password, send_current_password_reset_code, forgot_password,
    reset_current_password, reset_password,
)
from .session_routes import delete_all_sessions  # noqa: F401

"""public_share 的鉴权工具

提供 ``get_authenticated_user(request)`` —— 在使用了 ``JWTAuthOptional``
的 view 里把 ``request.auth`` 还原成「真实 User 实例或 None」，向 service
层（``PublicShareService.verify_share_access(user=...)``）提供干净接口。

为什么把 helper 放在这里而不是 permissions.py？
- ``JWTAuthOptional`` 与 ``ANONYMOUS_USER_MARKER`` 属于 auth 层基建（permissions.py）
- 「marker → None 还原」属于 public_share 这个调用方的便利封装
- 让 permissions.py 保持纯净，不引入对 public_share 的反向依赖

用法::

    from apps.services.common.public_share.auth import get_authenticated_user
    from apps.users.auth.permissions import JWTAuthOptional

    @router.get("/shared/{share_id}/content", auth=JWTAuthOptional())
    def get_shared_content(request, share_id: str):
        user = get_authenticated_user(request)
        DocumentShareService.verify_share_access(share, password=..., user=user)
        ...
"""

from __future__ import annotations

from typing import Any, Optional


def get_authenticated_user(request: Any) -> Optional[Any]:
    """从 ``request.auth`` 提取真实 User 实例，匿名访问返回 None。

    专门配合 ``apps.users.auth.permissions.JWTAuthOptional`` 使用。

    - ``request.auth`` 是 User 实例 → 直接返回
    - ``request.auth`` 是 ``ANONYMOUS_USER_MARKER`` → 返回 None
    - ``request`` 没有 auth 属性 → 返回 None（防御性兜底）

    Args:
        request: Django HttpRequest（或任何具备 .auth 属性的对象）

    Returns:
        User 实例 或 None
    """
    from apps.users.auth.permissions import ANONYMOUS_USER_MARKER

    auth = getattr(request, "auth", None)
    if auth is None or auth is ANONYMOUS_USER_MARKER:
        return None
    return auth

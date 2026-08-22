"""
API Key 安全上下文：scope 推断 + organization 约束传递

P0-9: resolve_required_scope — 根据 HTTP path + method 推断所需 scope
P0-10: ContextVar — 将 API Key organization_id 约束传递到 BaseService 层
"""

import logging
from contextvars import ContextVar
from typing import Optional

logger = logging.getLogger(__name__)

# ── P0-10: organization 约束 ContextVar ──

_api_key_organization_var: ContextVar[str] = ContextVar(
    'api_key_organization_constraint', default=''
)


def get_api_key_organization_constraint() -> str:
    return _api_key_organization_var.get()


def set_api_key_organization_constraint(wt_id: str) -> None:
    _api_key_organization_var.set(wt_id)


# ── P0-9: scope 推断 ──

# 单根契约（docs/single-root-space-prd.md §2.7）：/api/tabcode/* 路由已下架，
# scope 'code' 不再有 path 映射。保留 'code' scope 名以避免破坏可能持有该
# scope 的历史 API Key（兼容期），但路径不再触发该 scope 检查。
_PATH_SCOPE_MAP: list[tuple[str, str]] = [
    ('/api/tabdata/', 'tabdata'),
    ('/api/context/', 'space'),
    ('/api/chat/', 'agent'),
    ('/api/im/', 'agent'),
    ('/api/orchestration/', 'agent'),
    ('/api/tabdoc/', 'tabdoc'),
    ('/api/tabslide/', 'tabslide'),
    ('/api/tabvideo/', 'media'),
    ('/api/tabwhiteboard/', 'canvas'),
    ('/api/tabmemo/', 'memo'),
    ('/api/tabsite/', 'site'),
    ('/api/tabphone/', 'device'),
    ('/api/inbox/', 'inbox'),
    ('/api/services/media/', 'media'),
    ('/api/services/fn/', 'fn'),
    ('/api/services/oss/', 'storage'),
    ('/api/services/llm/', 'llm'),
    ('/api/services/billing/', 'account'),
    ('/api/services/payment/', 'account'),
    ('/api/services/speech/', 'speech'),
    ('/api/services/music/', 'music'),
    ('/api/services/sms/', 'sms'),
    ('/api/services/email/', 'email'),
    ('/api/registry/', 'registry'),
    ('/api/tracker/', 'tracker'),
    ('/api/rag/', 'rag'),
    ('/api/skills/', 'skills'),
    ('/api/credential-vault/', 'credential'),
    ('/api/channel/', 'channel'),
    ('/api/notifications/', 'notification'),
    ('/api/collab/', 'collab'),
    ('/api/capabilities/', 'capabilities'),
    ('/api/tins/', 'social'),
    ('/api/auth/admin/', 'admin'),
    ('/api/auth/', 'account'),
    ('/api/wallet/', 'account'),
    ('/api/membership/', 'account'),
    ('/api/i18n/', 'i18n'),
]

_READ_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS'})


_SCOPE_EXEMPT_PREFIXES = (
    '/api/open/',
    '/api/health',
    '/api/updates/',
    '/api/client-errors/',
    '/api/entities/',
)


def resolve_required_scope(path: str, method: str) -> Optional[str]:
    """根据请求路径和方法推断所需 API Key scope。

    返回 '{module}:read' 或 '{module}:write'。
    豁免路径（Open API / health / admin 等）返回 None。
    未映射路径 deny-by-default：返回 '*:write'（需全权限 Key）。
    """
    for exempt in _SCOPE_EXEMPT_PREFIXES:
        if path.startswith(exempt):
            return None
    for prefix, module in _PATH_SCOPE_MAP:
        if path.startswith(prefix):
            return f'{module}:read' if method in _READ_METHODS else f'{module}:write'
    logger.warning("API Key scope: 未映射路径 %s，deny-by-default", path)
    return '*:write'

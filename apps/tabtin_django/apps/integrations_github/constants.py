"""GitHub OAuth 常量（MCP 连接器平台代理）。"""

from django.conf import settings

OAUTH_STATE_TTL_SECONDS = 600
OAUTH_CLAIM_TTL_SECONDS = 120
OAUTH_STATE_CACHE_PREFIX = "github_oauth_state:"
OAUTH_CLAIM_CACHE_PREFIX = "github_oauth_claim:"

# GitHub MCP 常用读写范围；后续可按工具集收紧。
OAUTH_SCOPES = "read:user repo read:org"

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"

DEEP_LINK_DEFAULT = "tabtin://integrations/github/oauth"


def get_github_oauth_client_id() -> str:
    return getattr(settings, "GITHUB_OAUTH_CLIENT_ID", "") or ""


def get_github_oauth_client_secret() -> str:
    """禁止输出到 API 或日志。"""
    return getattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "") or ""


def get_github_oauth_redirect_uri() -> str:
    return getattr(
        settings,
        "GITHUB_OAUTH_REDIRECT_URI",
        "http://localhost:6060/api/integrations/github/oauth/callback",
    )


def get_github_oauth_success_redirect() -> str:
    return getattr(
        settings,
        "GITHUB_OAUTH_SUCCESS_REDIRECT",
        "http://localhost:6060/api/integrations/github/oauth/done",
    )


def github_oauth_configured() -> bool:
    return bool(get_github_oauth_client_id() and get_github_oauth_client_secret())

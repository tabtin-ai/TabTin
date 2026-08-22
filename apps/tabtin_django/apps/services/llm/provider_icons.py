"""Provider 品牌图标：包内 PNG → Catalog 的 icon_url + 公开下载端点。

图标文件在 ``static/llm/provider-icons/<key>.png``，同目录 SVG 是可编辑源文件。
本地 Daphne 不托管
``/static/``，因此 Catalog 下发 API 路径，由本模块视图直接读文件返回，
PNG 同时兼容浏览器与 iOS 原生图片解码。Electron 对已镜像的 SVG 可优先
本地加载，未内置的资源再回退本 API。
"""

from __future__ import annotations

from pathlib import Path

from django.http import FileResponse, Http404, HttpRequest

# provider.name → 静态文件 stem（无扩展名）
PROVIDER_ICON_KEYS: dict[str, str] = {
    "openai": "openai",
    "codex": "openai",
    "local": "openai",
    "claude": "claude",
    "anthropic": "anthropic",
    "gemini": "gemini",
    "google": "googlecloud",
    "moonshot": "kimi",
    "volcengine": "doubao",
    "bytedance": "doubao",
    "deepseek": "deepseek",
    "qwen": "qwen",
    "dashscope": "qwen",
    "minimax": "minimax",
    "minimax_bgm": "minimax",
    "zhipu": "zhipu",
    "bigmodel": "zhipu",
    "grok": "grok",
    "xai": "grok",
    "aws": "aws",
    "bedrock": "bedrock",
    "azure": "azure",
    "azure_ai": "azure",
    "azure-ai": "azure",
    "openrouter": "openrouter",
    "groq": "groq",
    "zenmux": "zenmux",
    "together": "together",
    "together_ai": "together",
    "fireworks": "fireworks",
    "fireworks_ai": "fireworks",
    "cohere": "cohere",
    "mistral": "mistral",
    "mistralai": "mistral",
    "perplexity": "perplexity",
    # 有独立文件时可打开；暂无则 catalog 不返回 icon_url
    "fal": "",
    "replicate": "",
}

# 仓库内已落地的品牌资源 stem
_AVAILABLE_ICON_FILES = frozenset({
    "openai",
    "claude",
    "gemini",
    "kimi",
    "doubao",
    "deepseek",
    "qwen",
    "minimax",
    "azure",
})

_ICON_DIR = Path(__file__).resolve().parent / "static" / "llm" / "provider-icons"

# 与 urls_deferred 中 ``/services/llm`` router 挂载一致（前缀含 /api）
PROVIDER_ICON_URL_PREFIX = "/api/services/llm/provider-icons"


def resolve_provider_icon_key(provider_name: str, explicit_key: str = "") -> str:
    """解析最终用于静态路径的 icon key；无资源时返回空串。"""
    key = (explicit_key or PROVIDER_ICON_KEYS.get(provider_name, provider_name) or "").strip()
    if not key or key not in _AVAILABLE_ICON_FILES:
        return ""
    return key


def build_provider_icon_url(provider_name: str, explicit_key: str = "") -> str:
    """返回相对站点根的 API URL（如 ``/api/services/llm/provider-icons/openai``）。"""
    key = resolve_provider_icon_key(provider_name, explicit_key)
    if not key:
        return ""
    return f"{PROVIDER_ICON_URL_PREFIX}/{key}"


def resolve_icon_file(icon_key: str) -> Path:
    """校验 key 并返回 PNG 绝对路径；非法或不存在则抛 Http404。"""
    key = (icon_key or "").strip().lower()
    if key not in _AVAILABLE_ICON_FILES:
        raise Http404("unknown provider icon")
    path = (_ICON_DIR / f"{key}.png").resolve()
    if not str(path).startswith(str(_ICON_DIR.resolve())) or not path.is_file():
        raise Http404("provider icon missing")
    return path


def serve_provider_icon(_request: HttpRequest, icon_key: str) -> FileResponse:
    """公开返回品牌 PNG（``<img>`` 无法带 JWT，故不鉴权）。"""
    path = resolve_icon_file(icon_key)
    response = FileResponse(path.open("rb"), content_type="image/png")
    response["Cache-Control"] = "public, max-age=86400"
    return response

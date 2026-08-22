"""Tool registry contract cleanup regressions."""

from apps.services.tools.domains.common.credential_tool import get_credential_tools


def test_credential_tools_declare_args_schema() -> None:
    """Credential tools use explicit schemas; ToolHub should not fall back to signature inference."""
    for tool in get_credential_tools():
        assert tool.args_schema is not None


def test_toolhub_does_not_register_builtin_llm_tools_after_w6() -> None:
    """W6 (2026-05-04): Python ToolHub no longer registers LLM tools.

    Three historical registration paths used to populate ``ToolHub``:

    1. ``apps.services.tools.domains.registry`` ran 25 ``register_provider``
       calls at import time (one per builtin domain).
    2. ``apps.channel_gateway.apps`` registered one domain per channel
       adapter (telegram / feishu / slack / ...).

    After W6 all three paths have been removed and no builtin or builtin-
    extension domains should appear in the hub. Runtime extensions that
    explicitly call ``ToolHub.register_provider`` from their own bootstrap
    code are still allowed; this guard only protects the static / Django-
    startup paths.
    """
    from apps.services.tools import ToolHub, ensure_builtin_tools_registered

    ensure_builtin_tools_registered()

    domains = set(ToolHub.list_domains())
    forbidden = {
        # 25 builtin domains formerly registered in domains/registry.py
        "common", "todo", "tabdoc", "plan", "tabdata", "think", "rag",
        "web-scraper", "device", "docparse", "media", "ssh", "credential",
        "memory", "conversation_history", "runtime",
        "cross_space", "tabmemo", "tabtracker", "tins",
        "capabilities", "tabsite", "wechat_work",
        # channel adapter domains (formerly registered by channel_gateway/tools.py)
        "telegram", "feishu", "slack", "discord", "whatsapp", "line",
        "dingtalk", "googlechat", "msteams", "mattermost", "weixin_personal",
    }
    leaked = domains & forbidden
    assert not leaked, f"ToolHub still registers retired LLM domains: {sorted(leaked)}"

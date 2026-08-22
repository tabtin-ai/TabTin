"""会话列表头像取值：Project 头像优先，普通会话回落到 Agent 自己的头像。

契约要点（向前兼容）：Project 会话的取值不变；过去恒为 None 的普通会话补上
Agent 头像，旧客户端只会从「没有头像」变成「有头像」。
"""

from apps.chat.conversation.api.session import _resolve_session_avatar


def test_project_avatar_wins():
    avatar = _resolve_session_avatar(
        project={"avatar": "project-avatar.png"},
        agent={"settings": {"avatar_url": "https://cdn.example.com/agent.png"}},
    )
    assert avatar == "project-avatar.png"


def test_project_without_avatar_falls_back_to_agent():
    avatar = _resolve_session_avatar(
        project={"avatar": None},
        agent={"settings": {"avatar_url": "https://cdn.example.com/agent.png"}},
    )
    assert avatar == "https://cdn.example.com/agent.png"


def test_plain_session_uses_agent_custom_avatar():
    avatar = _resolve_session_avatar(
        project=None,
        agent={"settings": {"avatar_url": "https://cdn.example.com/agent.png"}},
    )
    assert avatar == "https://cdn.example.com/agent.png"


def test_agent_preset_key_is_passed_through_for_client_resolution():
    """预置头像发 key，由各端解析成自己的内置图，避免后端拼死链接。"""
    avatar = _resolve_session_avatar(
        project=None,
        agent={"settings": {"avatar_key": "code-engineer"}},
    )
    assert avatar == "code-engineer"


def test_custom_url_wins_over_preset_key():
    avatar = _resolve_session_avatar(
        project=None,
        agent={
            "settings": {
                "avatar_key": "code-engineer",
                "avatar_url": "https://cdn.example.com/agent.png",
            }
        },
    )
    assert avatar == "https://cdn.example.com/agent.png"


def test_missing_or_malformed_settings_fall_back_to_brand_default():
    """有 Agent 身份但未配头像 → general-assistant；无 Agent 才是 None。

    注意：空 ``{}`` 在 Python 里是 falsy，列表序列化传入的 agent 至少带 id/name，
    测例用非空 dict 对齐真实 ``agent_info`` 形态。
    """
    assert _resolve_session_avatar(project=None, agent=None) is None
    assert _resolve_session_avatar(project=None, agent={"id": "a1"}) == "general-assistant"
    assert (
        _resolve_session_avatar(project=None, agent={"id": "a1", "settings": None})
        == "general-assistant"
    )
    assert (
        _resolve_session_avatar(project=None, agent={"id": "a1", "settings": "oops"})
        == "general-assistant"
    )
    assert (
        _resolve_session_avatar(
            project=None, agent={"id": "a1", "settings": {"avatar_url": "   "}}
        )
        == "general-assistant"
    )
    assert (
        _resolve_session_avatar(project=None, agent={"id": "a1", "settings": {}})
        == "general-assistant"
    )

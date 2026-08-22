"""
MessageSlot — 定义 system message 的排列优先级。

所有中间件注入 system message 时应携带 `_msg_slot` 字段，
NativeReactLoop 在 before_iteration 之后按此值排序。

数值越小越靠前（紧随 static system prompt 之后）。
值 >= 900 的消息会被放置在对话消息尾部（最后一条 user message 之前）。
"""

SLOT_SYSTEM_PROMPT = 0
SLOT_RECOVERY_NOTICE = 10
SLOT_TRUNCATION_NOTE = 15
SLOT_CONTEXT = 20
SLOT_ACTION_HISTORY = 25
SLOT_SKILLS = 40
SLOT_TODO = 50

SLOT_SELFCHECK = 900
SLOT_PRESSURE_WARN = 950
SLOT_DOOMLOOP_WARN = 960

MSG_SLOT_KEY = "_msg_slot"
TAIL_SLOT_THRESHOLD = 900


def reorder_system_messages(messages: list) -> list:
    """按 _msg_slot 对 system messages 重新排列。

    - 带 _msg_slot < 900 的 system messages 放在消息列表头部，按 slot 升序
    - 带 _msg_slot >= 900 的 system messages 放在最后一条 user message 之前
    - 无 _msg_slot 的 system messages 保持原位（向后兼容）
    - 非 system 消息保持相对顺序不变
    """
    if not messages:
        return messages

    head_system: list = []
    tail_system: list = []
    others: list = []

    for msg in messages:
        if not isinstance(msg, dict):
            others.append(msg)
            continue

        slot = msg.get(MSG_SLOT_KEY)
        if slot is not None and msg.get("role") == "system":
            if slot < TAIL_SLOT_THRESHOLD:
                head_system.append(msg)
            else:
                tail_system.append(msg)
        else:
            others.append(msg)

    head_system.sort(key=lambda m: m.get(MSG_SLOT_KEY, 999))
    tail_system.sort(key=lambda m: m.get(MSG_SLOT_KEY, 999))

    if not tail_system:
        return head_system + others

    last_user_idx = -1
    for i in range(len(others) - 1, -1, -1):
        if isinstance(others[i], dict) and others[i].get("role") == "user":
            last_user_idx = i
            break

    if last_user_idx < 0:
        return head_system + others + tail_system

    return (
        head_system
        + others[:last_user_idx]
        + tail_system
        + others[last_user_idx:]
    )


__all__ = [
    "SLOT_SYSTEM_PROMPT",
    "SLOT_CONTEXT",
    "SLOT_ACTION_HISTORY",
    "SLOT_SKILLS",
    "SLOT_TODO",
    "SLOT_SELFCHECK",
    "SLOT_PRESSURE_WARN",
    "SLOT_DOOMLOOP_WARN",
    "MSG_SLOT_KEY",
    "TAIL_SLOT_THRESHOLD",
    "reorder_system_messages",
]

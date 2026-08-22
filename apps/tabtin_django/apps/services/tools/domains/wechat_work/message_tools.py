"""企业微信消息历史工具。

调用企微消息相关 API：
- /appchat/get（获取群聊信息）
- 获取会话列表和消息记录

注意：企微开放 API 对消息历史的访问有较严格限制，
部分功能需要「会话内容存档」权限（审计版本），
此工具在能力范围内尽可能提供可用功能。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import tool_result_success

from ._helpers import (
    json_missing_param,
    json_wecom_api_error,
    json_wecom_transport_error,
    resolve_account_and_token,
    wecom_api_post,
)

logger = logging.getLogger(__name__)

SEVEN_DAYS_SECONDS = 7 * 24 * 3600

_ARCHIVE_HINT = (
    "获取会话列表/消息历史需要「会话内容存档」权限，"
    "请确认企业微信应用已开通该功能后重试。"
)


# ─── Input Schemas ────────────────────────────────────────


class WecomGetChatListInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    userid: str = Field(
        description="查询该用户参与的会话列表的 userid",
    )
    status_filter: str = Field(
        default="",
        description="过滤条件：group=仅群聊，dm=仅单聊，为空返回全部",
    )


class WecomGetMessagesInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    chatid: str = Field(
        description="会话 ID（群聊 chatid 或单聊 userid）",
    )
    limit: int = Field(
        default=50,
        description="拉取消息条数（最大 200）",
    )
    cursor: str = Field(
        default="",
        description="翻页游标（从上一次响应中获取，首次留空）",
    )


# ─── Tools ────────────────────────────────────────────────


class WecomGetChatListTool(BaseTool):
    name: str = "wecom_get_chat_list"
    description: str = (
        "获取企业微信中有消息的会话列表。"
        "包括群聊和单聊会话，返回会话 ID、名称、类型等信息。"
        "注意：此功能依赖企微「会话内容存档」接口权限。"
    )
    args_schema: type = WecomGetChatListInput
    risk_level: str = "safe"

    def run(
        self,
        userid: str = "",
        organization_id: str | None = None,
        status_filter: str = "",
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        if not userid:
            return json_missing_param("userid", tool_name="wecom_get_chat_list")

        try:
            data = wecom_api_post(token, "/chat/get", {
                "userid": userid,
            })
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="get_chat_list")

        if data.get("errcode") not in (0, None):
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="get_chat_list",
                hint=_ARCHIVE_HINT,
            )

        chat_list = data.get("chat_list", [])

        if status_filter == "group":
            chat_list = [c for c in chat_list if c.get("type") == "group"]
        elif status_filter == "dm":
            chat_list = [c for c in chat_list if c.get("type") != "group"]

        chats = []
        for c in chat_list:
            chats.append({
                "chatid": c.get("chatid", ""),
                "name": c.get("name", ""),
                "type": c.get("type", ""),
                "member_count": c.get("member_count", 0),
                "last_msg_time": c.get("last_msg_time", 0),
            })

        return tool_result_success(json.dumps({
            "total": len(chats),
            "chats": chats,
        }, ensure_ascii=False))


class WecomGetMessagesTool(BaseTool):
    name: str = "wecom_get_messages"
    description: str = (
        "拉取企业微信指定会话的消息历史（最近 7 天内）。"
        "需要提供会话 ID（chatid），支持分页。"
        "注意：此功能依赖企微「会话内容存档」接口权限。"
        "返回消息列表，包含发送者、内容、时间等信息。"
    )
    args_schema: type = WecomGetMessagesInput
    risk_level: str = "safe"

    def run(
        self,
        chatid: str = "",
        organization_id: str | None = None,
        limit: int = 50,
        cursor: str = "",
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        if not chatid:
            return json_missing_param("chatid", tool_name="wecom_get_messages")

        now = int(time.time())
        payload: dict = {
            "chatid": chatid,
            "limit": min(limit, 200),
            "start_time": now - SEVEN_DAYS_SECONDS,
            "end_time": now,
        }
        if cursor:
            payload["cursor"] = cursor

        try:
            data = wecom_api_post(token, "/chat/getmsg", payload)
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="get_messages")

        if data.get("errcode") not in (0, None):
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="get_messages",
                hint=_ARCHIVE_HINT,
            )

        msg_list = data.get("msg_list", [])
        messages = []
        for m in msg_list:
            messages.append({
                "msgid": m.get("msgid", ""),
                "sender": m.get("from", ""),
                "msgtype": m.get("msgtype", ""),
                "content": m.get("content", ""),
                "msgtime": m.get("msgtime", 0),
            })

        return tool_result_success(json.dumps({
            "total": len(messages),
            "messages": messages,
            "next_cursor": data.get("next_cursor", ""),
            "has_more": bool(data.get("next_cursor")),
        }, ensure_ascii=False))

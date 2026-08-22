"""企业微信会议管理工具。

调用企微会议相关 API：
- /meeting/create（创建预约会议）
- /meeting/cancel（取消会议）
- 查询会议列表
"""

from __future__ import annotations

import json
import logging
from typing import List, Optional

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


# ─── Input Schemas ────────────────────────────────────────


class WecomListMeetingsInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    userid: str = Field(
        description="查询该用户参与的会议的 userid",
    )
    begin_time: int = Field(
        default=0,
        description="查询起始时间（Unix 时间戳，秒）。0 表示当前时间",
    )
    end_time: int = Field(
        default=0,
        description="查询结束时间（Unix 时间戳，秒）。0 表示不限",
    )
    offset: int = Field(
        default=0,
        description="分页偏移量",
    )
    limit: int = Field(
        default=20,
        description="每页数量（最大 20）",
    )


class WecomCreateMeetingInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    creator_userid: str = Field(
        description="会议创建者 userid",
    )
    title: str = Field(
        description="会议标题",
    )
    start_time: int = Field(
        description="会议开始时间（Unix 时间戳，秒）",
    )
    end_time: int = Field(
        description="会议结束时间（Unix 时间戳，秒）",
    )
    invitees: List[str] = Field(
        default_factory=list,
        description="受邀人 userid 列表",
    )
    description: str = Field(
        default="",
        description="会议描述",
    )
    location: str = Field(
        default="",
        description="会议地点",
    )
    meeting_type: int = Field(
        default=0,
        description="会议类型：0=普通会议，1=周期性会议",
    )


class WecomCancelMeetingInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    meetingid: str = Field(
        description="要取消的会议 ID",
    )
    userid: str = Field(
        description="取消操作者的 userid",
    )


# ─── Tools ────────────────────────────────────────────────


class WecomListMeetingsTool(BaseTool):
    name: str = "wecom_list_meetings"
    description: str = (
        "查询企业微信会议列表。"
        "查询指定用户在时间范围内参与的所有会议。"
        "返回会议的标题、时间、参与人等信息。"
    )
    args_schema: type = WecomListMeetingsInput
    risk_level: str = "safe"

    def run(
        self,
        userid: str = "",
        organization_id: str | None = None,
        begin_time: int = 0,
        end_time: int = 0,
        offset: int = 0,
        limit: int = 20,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        if not userid:
            return json_missing_param("userid", tool_name="wecom_list_meetings")

        payload: dict = {
            "userid": userid,
            "cursor": offset,
            "limit": min(limit, 20),
        }
        if begin_time > 0:
            payload["begin_time"] = begin_time
        if end_time > 0:
            payload["end_time"] = end_time

        try:
            data = wecom_api_post(token, "/meeting/list", payload)
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="list_meetings")

        if data.get("errcode") not in (0, None):
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="list_meetings",
            )

        meeting_list = data.get("meeting_list", [])
        meetings = []
        for m in meeting_list:
            meetings.append({
                "meetingid": m.get("meetingid", ""),
                "title": m.get("title", ""),
                "start_time": m.get("start_time", 0),
                "end_time": m.get("end_time", 0),
                "creator": m.get("creator", ""),
                "location": m.get("location", ""),
                "description": m.get("description", ""),
                "status": m.get("status", 0),
                "invitees": m.get("invitees", []),
            })

        return tool_result_success(json.dumps({
            "total": len(meetings),
            "meetings": meetings,
        }, ensure_ascii=False))


class WecomCreateMeetingTool(BaseTool):
    name: str = "wecom_create_meeting"
    description: str = (
        "在企业微信中创建预约会议。"
        "需要指定创建者、标题和起止时间，可选添加受邀人和描述。"
        "创建成功后返回会议 ID。"
    )
    args_schema: type = WecomCreateMeetingInput
    risk_level: str = "review"
    available_modes: tuple = ("agent",)

    def run(
        self,
        creator_userid: str = "",
        title: str = "",
        start_time: int = 0,
        end_time: int = 0,
        organization_id: str | None = None,
        invitees: list[str] | None = None,
        description: str = "",
        location: str = "",
        meeting_type: int = 0,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        payload: dict = {
            "creator": creator_userid,
            "title": title,
            "meeting_start": start_time,
            "meeting_end": end_time,
            "type": meeting_type,
        }
        if description:
            payload["description"] = description
        if location:
            payload["location"] = location
        if invitees:
            payload["invitees"] = [{"userid": uid} for uid in invitees]

        try:
            data = wecom_api_post(token, "/meeting/create", payload)
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="create_meeting")

        if data.get("errcode") != 0:
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="create_meeting",
            )

        return tool_result_success(json.dumps({
            "status": "created",
            "meetingid": data.get("meetingid", ""),
            "title": title,
        }, ensure_ascii=False))


class WecomCancelMeetingTool(BaseTool):
    name: str = "wecom_cancel_meeting"
    description: str = (
        "取消企业微信中已创建的会议。"
        "需要提供会议 ID 和操作者 userid。"
        "取消后所有参与人会收到通知。"
    )
    args_schema: type = WecomCancelMeetingInput
    risk_level: str = "review"
    available_modes: tuple = ("agent",)

    def run(
        self,
        meetingid: str = "",
        userid: str = "",
        organization_id: str | None = None,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        if not meetingid:
            return json_missing_param("meetingid", tool_name="wecom_cancel_meeting")
        if not userid:
            return json_missing_param("userid", tool_name="wecom_cancel_meeting")

        try:
            data = wecom_api_post(token, "/meeting/cancel", {
                "meetingid": meetingid,
                "userid": userid,
            })
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="cancel_meeting")

        if data.get("errcode") != 0:
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="cancel_meeting",
            )

        return tool_result_success(json.dumps({
            "status": "cancelled",
            "meetingid": meetingid,
        }, ensure_ascii=False))

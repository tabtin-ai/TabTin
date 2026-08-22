"""企业微信日程管理工具。

调用企微 /oa/schedule/* 系列 API：
- 查询日程列表
- 创建日程
- 查询多人闲忙状态
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


class WecomListSchedulesInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    start_time: int = Field(
        description="查询起始时间（Unix 时间戳，秒）",
    )
    end_time: int = Field(
        description="查询结束时间（Unix 时间戳，秒）",
    )
    creator_userid: str = Field(
        default="",
        description="筛选创建者 userid（为空则查询所有）",
    )


class WecomCreateScheduleInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    organizer_userid: str = Field(
        description="日程组织者的 userid",
    )
    summary: str = Field(
        description="日程标题",
    )
    start_time: int = Field(
        description="开始时间（Unix 时间戳，秒）",
    )
    end_time: int = Field(
        description="结束时间（Unix 时间戳，秒）",
    )
    attendees: List[str] = Field(
        default_factory=list,
        description="参与人 userid 列表",
    )
    description: str = Field(
        default="",
        description="日程描述",
    )
    location: str = Field(
        default="",
        description="日程地点",
    )


class WecomCheckAvailabilityInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    userids: List[str] = Field(
        description="要查询闲忙状态的 userid 列表",
    )
    start_time: int = Field(
        description="查询起始时间（Unix 时间戳，秒）",
    )
    end_time: int = Field(
        description="查询结束时间（Unix 时间戳，秒）",
    )


# ─── Tools ────────────────────────────────────────────────


class WecomListSchedulesTool(BaseTool):
    name: str = "wecom_list_schedules"
    description: str = (
        "查询企业微信日程列表。"
        "指定起止时间范围，返回该范围内的所有日程。"
        "可选按创建者 userid 筛选。"
    )
    args_schema: type = WecomListSchedulesInput
    risk_level: str = "safe"

    def run(
        self,
        start_time: int = 0,
        end_time: int = 0,
        organization_id: str | None = None,
        creator_userid: str = "",
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        try:
            payload: dict = {
                "offset": 0,
                "limit": 50,
            }
            if creator_userid:
                payload["userid"] = creator_userid

            data = wecom_api_post(token, "/oa/schedule/get_by_calendar", payload)

            if data.get("errcode") == 41001 or "schedule" not in str(data):
                calendar_payload: dict = {
                    "offset": 0,
                    "limit": 50,
                }
                data = wecom_api_post(token, "/oa/schedule/list", calendar_payload)

        except Exception as exc:
            return json_wecom_transport_error(exc, operation="list_schedules")

        if data.get("errcode") not in (0, None):
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="list_schedules",
            )

        schedule_list = data.get("schedule_list", [])

        filtered = []
        for s in schedule_list:
            s_start = s.get("start_time", 0)
            s_end = s.get("end_time", 0)
            if s_end >= start_time and s_start <= end_time:
                filtered.append({
                    "schedule_id": s.get("schedule_id", ""),
                    "summary": s.get("summary", ""),
                    "start_time": s_start,
                    "end_time": s_end,
                    "organizer": s.get("organizer", ""),
                    "location": s.get("location", ""),
                    "description": s.get("description", ""),
                    "attendees": [
                        a.get("userid", "") for a in s.get("attendees", [])
                    ],
                    "status": s.get("status", 0),
                })

        return tool_result_success(json.dumps({
            "total": len(filtered),
            "schedules": filtered,
        }, ensure_ascii=False))


class WecomCreateScheduleTool(BaseTool):
    name: str = "wecom_create_schedule"
    description: str = (
        "在企业微信中创建日程。"
        "需要指定组织者、标题、起止时间，可选添加参与人和描述。"
        "创建成功后返回日程 ID。"
    )
    args_schema: type = WecomCreateScheduleInput
    risk_level: str = "review"
    available_modes: tuple = ("agent",)

    def run(
        self,
        organizer_userid: str = "",
        summary: str = "",
        start_time: int = 0,
        end_time: int = 0,
        organization_id: str | None = None,
        attendees: list[str] | None = None,
        description: str = "",
        location: str = "",
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        schedule_payload: dict = {
            "organizer": organizer_userid,
            "summary": summary,
            "start_time": start_time,
            "end_time": end_time,
        }
        if description:
            schedule_payload["description"] = description
        if location:
            schedule_payload["location"] = location
        if attendees:
            schedule_payload["attendees"] = [{"userid": uid} for uid in attendees]

        try:
            data = wecom_api_post(token, "/oa/schedule/add", {
                "schedule": schedule_payload,
            })
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="create_schedule")

        if data.get("errcode") != 0:
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="create_schedule",
            )

        return tool_result_success(json.dumps({
            "status": "created",
            "schedule_id": data.get("schedule_id", ""),
            "summary": summary,
        }, ensure_ascii=False))


class WecomCheckAvailabilityTool(BaseTool):
    name: str = "wecom_check_availability"
    description: str = (
        "查询多个企业微信成员在指定时间范围内的闲忙状态。"
        "用于创建日程或会议前检查参与人是否有空。"
        "返回每个成员的日程列表。"
    )
    args_schema: type = WecomCheckAvailabilityInput
    risk_level: str = "safe"

    def run(
        self,
        userids: list[str] | None = None,
        start_time: int = 0,
        end_time: int = 0,
        organization_id: str | None = None,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        if not userids:
            return json_missing_param("userids", tool_name="wecom_check_availability")

        try:
            data = wecom_api_post(token, "/oa/schedule/get_by_calendar", {
                "userid_list": userids,
                "start_time": start_time,
                "end_time": end_time,
            })
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="check_availability")

        if data.get("errcode") not in (0, None):
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="check_availability",
            )

        schedule_list = data.get("schedule_list", [])
        user_schedules: dict[str, list] = {uid: [] for uid in userids}

        for s in schedule_list:
            organizer = s.get("organizer", "")
            if organizer in user_schedules:
                user_schedules[organizer].append({
                    "summary": s.get("summary", ""),
                    "start_time": s.get("start_time", 0),
                    "end_time": s.get("end_time", 0),
                })
            for att in s.get("attendees", []):
                uid = att.get("userid", "")
                if uid in user_schedules:
                    user_schedules[uid].append({
                        "summary": s.get("summary", ""),
                        "start_time": s.get("start_time", 0),
                        "end_time": s.get("end_time", 0),
                    })

        availability = []
        for uid in userids:
            schedules = user_schedules.get(uid, [])
            availability.append({
                "userid": uid,
                "busy": len(schedules) > 0,
                "conflict_count": len(schedules),
                "conflicts": schedules,
            })

        return tool_result_success(json.dumps({
            "availability": availability,
        }, ensure_ascii=False))

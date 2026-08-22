"""企业微信待办管理工具。

调用企微待办相关 API：
- /oa/applyevent（创建待办）
- 查询 / 更新待办状态
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


class WecomListTodosInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    creator_userid: str = Field(
        default="",
        description="创建者 userid（为空则查询所有）",
    )
    offset: int = Field(
        default=0,
        description="分页偏移量",
    )
    limit: int = Field(
        default=50,
        description="每页数量（最大 50）",
    )


class WecomCreateTodoInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    creator_userid: str = Field(
        description="待办创建者的 userid",
    )
    title: str = Field(
        description="待办标题/内容",
    )
    assignee_userids: List[str] = Field(
        default_factory=list,
        description="待办分派人 userid 列表",
    )
    description: str = Field(
        default="",
        description="待办详细描述",
    )
    due_time: int = Field(
        default=0,
        description="截止时间（Unix 时间戳，秒）。0 表示无截止时间",
    )


class WecomUpdateTodoInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    task_id: str = Field(
        description="待办任务 ID",
    )
    status: int = Field(
        default=0,
        description="待办状态：0=未完成，1=已完成，2=已取消",
    )


# ─── Tools ────────────────────────────────────────────────


class WecomListTodosTool(BaseTool):
    name: str = "wecom_list_todos"
    description: str = (
        "查询企业微信待办任务列表。"
        "可选按创建者筛选，支持分页。"
        "返回待办的标题、状态、分派人等信息。"
    )
    args_schema: type = WecomListTodosInput
    risk_level: str = "safe"

    def run(
        self,
        organization_id: str | None = None,
        creator_userid: str = "",
        offset: int = 0,
        limit: int = 50,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        payload: dict = {
            "offset": offset,
            "limit": min(limit, 50),
        }
        if creator_userid:
            payload["creator"] = creator_userid

        try:
            data = wecom_api_post(token, "/oa/gettasklist", payload)
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="list_todos")

        if data.get("errcode") not in (0, None):
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="list_todos",
            )

        task_list = data.get("task_list", [])
        todos = []
        for t in task_list:
            todos.append({
                "task_id": t.get("task_id", ""),
                "title": t.get("title", ""),
                "creator": t.get("creator", ""),
                "status": t.get("status", 0),
                "create_time": t.get("create_time", 0),
                "due_time": t.get("due_time", 0),
                "assignees": t.get("assignees", []),
                "description": t.get("description", ""),
            })

        return tool_result_success(json.dumps({
            "total": len(todos),
            "todos": todos,
        }, ensure_ascii=False))


class WecomCreateTodoTool(BaseTool):
    name: str = "wecom_create_todo"
    description: str = (
        "在企业微信中创建待办任务。"
        "需要指定创建者和标题，可选添加分派人、描述和截止时间。"
        "创建成功后返回待办任务 ID。"
    )
    args_schema: type = WecomCreateTodoInput
    risk_level: str = "review"
    available_modes: tuple = ("agent",)

    def run(
        self,
        creator_userid: str = "",
        title: str = "",
        organization_id: str | None = None,
        assignee_userids: list[str] | None = None,
        description: str = "",
        due_time: int = 0,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        payload: dict = {
            "creator": creator_userid,
            "title": title,
        }
        if description:
            payload["description"] = description
        if due_time > 0:
            payload["due_time"] = due_time
        if assignee_userids:
            payload["assignees"] = assignee_userids

        try:
            data = wecom_api_post(token, "/oa/addtask", payload)
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="create_todo")

        if data.get("errcode") != 0:
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="create_todo",
            )

        return tool_result_success(json.dumps({
            "status": "created",
            "task_id": data.get("task_id", ""),
            "title": title,
        }, ensure_ascii=False))


class WecomUpdateTodoTool(BaseTool):
    name: str = "wecom_update_todo"
    description: str = (
        "更新企业微信待办任务的状态。"
        "支持将待办标记为已完成（1）或已取消（2）。"
    )
    args_schema: type = WecomUpdateTodoInput
    risk_level: str = "review"
    available_modes: tuple = ("agent",)

    def run(
        self,
        task_id: str = "",
        organization_id: str | None = None,
        status: int = 0,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        if not task_id:
            return json_missing_param("task_id", tool_name="wecom_update_todo")

        try:
            data = wecom_api_post(token, "/oa/updatetask", {
                "task_id": task_id,
                "status": status,
            })
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="update_todo")

        if data.get("errcode") != 0:
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="update_todo",
            )

        status_map = {0: "未完成", 1: "已完成", 2: "已取消"}
        return tool_result_success(json.dumps({
            "status": "updated",
            "task_id": task_id,
            "new_status": status_map.get(status, str(status)),
        }, ensure_ascii=False))

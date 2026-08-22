"""企业微信通讯录查询工具。

调用企微 /user/simplelist 获取部门成员，支持按姓名模糊搜索。
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import tool_result_success

from ._helpers import (
    json_wecom_api_error,
    json_wecom_transport_error,
    resolve_account_and_token,
    wecom_api_get,
)

logger = logging.getLogger(__name__)


class WecomContactLookupInput(BaseModel):
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    search_name: str = Field(
        default="",
        description="按姓名模糊搜索（为空则返回该部门全部成员）",
    )
    department_id: int = Field(
        default=1,
        description="部门 ID（默认 1 即根部门）",
    )


class WecomContactLookupTool(BaseTool):
    name: str = "wecom_contact_lookup"
    description: str = (
        "查询企业微信通讯录成员列表。"
        "可按部门查询，也可按姓名模糊搜索。"
        "返回成员的 userid 和姓名列表。"
    )
    args_schema: type = WecomContactLookupInput
    risk_level: str = "safe"

    def run(
        self,
        organization_id: str | None = None,
        search_name: str = "",
        department_id: int = 1,
    ) -> str:
        account, token_or_error = resolve_account_and_token(organization_id)
        if account is None:
            return token_or_error
        token = token_or_error

        try:
            data = wecom_api_get(token, "/user/simplelist", {
                "department_id": department_id,
                "fetch_child": 1,
            })
        except Exception as exc:
            return json_wecom_transport_error(exc, operation="contact_lookup")

        if data.get("errcode") != 0:
            return json_wecom_api_error(
                {"errcode": data.get("errcode")},
                operation="contact_lookup",
            )

        user_list = data.get("userlist", [])
        members = [
            {"userid": u.get("userid", ""), "name": u.get("name", "")}
            for u in user_list
        ]

        if search_name:
            keyword = search_name.lower()
            members = [m for m in members if keyword in m["name"].lower()]

        return tool_result_success(json.dumps({
            "total": len(members),
            "members": members,
            "department_id": department_id,
        }, ensure_ascii=False))

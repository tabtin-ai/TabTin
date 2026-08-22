"""App 事件目录 API（``/api/registry/events/*``）。

2026-05-28 URL 归位：从 ``/api/scheduler/events`` 搬到 ``/api/registry/events``，
跟 ``services.common.app_registry`` 配对，挂 registry 前缀更贴合"平台级 App
元数据查询"的语义。原 ``apps/tracker/scheduler_api.py`` 随 ScheduledJob 子系统
整体下线，事件目录两个端点迁入本文件。

**不要求登录**——事件本体是平台 schema 的公开声明，无敏感信息；让 CLI / Agent
在未鉴权场景也能查询能力清单（与 ``/skills/registry`` 同形态，charter §6.3）。

业务事件由各 App 在 ``packages/apps/<id>/app.json`` 的 ``events[]`` 字段声明。
后端 loader（``apps.services.common.app_registry``）启动时一次性扫描聚合，
本路由是平台对外的**唯一**业务事件查询接口（charter §6.3）。

i18n key 沿用 ``scheduler.*`` namespace（zh-CN/en-US 已对齐，
``apps/tracker/tests/test_i18n_keys.py`` 钉死），仅 URL 路径归位。
"""

from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Router, Query

from apps.i18n import _
from apps.tabdata.api_helpers import (
    success_response,
    not_found_response,
)

router = Router(tags=["Events Registry"])


@router.get("/events", response={200: dict}, auth=None)
def list_app_events(
    request: HttpRequest,
    app: Optional[str] = Query(None, description="按 app_id 过滤；为空时聚合所有 App"),
):
    """列出所有 App 声明的业务事件（charter v1.8 §6.3）。

    输出格式：
    ```
    {
      "events": [
        {
          "app_id": "tabmail",
          "key": "tabmail.email.received",
          "label": "收到新邮件",
          "description": "...",
          "filterable_fields": ["from", "subject", "labels"],
          "ai_filterable": true,
          "payload_schema": [
            {"name": "from", "type": "string", "required": true}, ...
          ]
        },
        ...
      ],
      "total": N
    }
    ```
    """
    from apps.services.common.app_registry import (
        get_all_app_events,
        get_app,
    )

    if app:
        # app 过滤：app_id 不存在 → 空列表（不报错，CLI 友好）
        app_def = get_app(app)
        if app_def is None:
            return success_response({"events": [], "total": 0})
        pairs = [(app_def.id, ev) for ev in app_def.events]
    else:
        pairs = list(get_all_app_events())

    items = [_serialize_app_event(app_id, ev) for app_id, ev in pairs]
    return success_response({"events": items, "total": len(items)})


@router.get("/events/{event_key}", response={200: dict, 404: dict}, auth=None)
def show_app_event(request: HttpRequest, event_key: str):
    """单个事件详情（charter v1.8 §6.3）。

    用于 ``tabtin event show <event_key>`` —— 给 Agent / 用户查看 payload_schema
    + filterable_fields 来构造 trigger filter。
    """
    from apps.services.common.app_registry import find_event

    found = find_event(event_key)
    if found is None:
        return not_found_response(_("scheduler.business_event_resource", event_key=event_key))
    app_id, ev = found
    return success_response(_serialize_app_event(app_id, ev))


def _serialize_app_event(app_id: str, ev) -> dict:
    """AppEventDefinition → dict（CLI / HTTP 输出统一格式）。

    payload_schema 在 dataclass 中是 ``((name, type, required), ...)``
    出于 frozen dataclass 兼容；对外暴露时展开为 list-of-dict 更友好。
    """
    return {
        "app_id": app_id,
        "key": ev.key,
        "label": ev.label,
        "description": ev.description,
        "filterable_fields": list(ev.filterable_fields),
        "ai_filterable": ev.ai_filterable,
        "payload_schema": [
            {"name": name, "type": typ, "required": required}
            for (name, typ, required) in ev.payload_schema
        ],
    }

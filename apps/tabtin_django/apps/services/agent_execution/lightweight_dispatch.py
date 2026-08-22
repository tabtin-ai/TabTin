"""轻量模式入口：``RemoteAgentDispatcher`` 未绑设备分支的内部跳板。

W13 D1/D2：当 Agent 的 ``control_device`` 为空（用户主动选了"不绑定设备
（纯对话）"）时，对话由云端 ``agent_engine`` 的轻量引擎处理。本函数把
``app_context.runtime_mode='lightweight'`` 注入后，转发给
``ChatService.send_message_sync``。

放在 ``services/agent_execution/`` 内部，是因为：
* 这本质上是 ChatService 的另一种"自我转发"，调用方就是 agent_execution 内部；
* 北极星 grep 把 ``services/agent_execution/`` 排除在外，保持指标语义干净
  （目录外的所有 ``ChatService.send_message_sync`` 调用都意味着"云端编排
  消费者"，含义明确）。

W13d 之后 ``ChatService`` 会读取 ``runtime_mode='lightweight'`` 自动收窄
工具集；W13d 之前该字段被忽略，行为退化为现状（全工具云端跑），完全兼容。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def dispatch_lightweight(
    *,
    session_id: str,
    user,
    message: str,
    model_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    blocks: Optional[list] = None,
    attachments: Optional[list] = None,
    client_type: Optional[str] = None,
    execution_profile: Optional[str] = None,
    app_context: Optional[Dict[str, Any]] = None,
    agent_mode: Optional[str] = None,
    api_token_space_ids: Optional[List[str]] = None,
    client_message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """注入 runtime_mode='lightweight' 后调 ``ChatService.send_message_sync``。"""
    enriched_ctx: Dict[str, Any] = dict(app_context or {})
    enriched_ctx.setdefault("runtime_mode", "lightweight")

    from apps.services.agent_execution.chat_service import ChatService

    return ChatService.send_message_sync(
        session_id=session_id,
        user=user,
        message=message,
        model_id=model_id,
        agent_name=agent_name,
        blocks=blocks,
        attachments=attachments,
        client_type=client_type,
        execution_profile=execution_profile,
        app_context=enriched_ctx,
        agent_mode=agent_mode,
        api_token_space_ids=api_token_space_ids,
        client_message_id=client_message_id,
    )


__all__ = ["dispatch_lightweight"]

"""
remote_agent — 云端编排消费者的统一路由层。

W13 引入：本地 AgentRuntime 真正接管原本由 ``ChatService.send_message_sync``
覆盖的 6 个云端编排消费者（scheduler / channel_gateway / tabtinspace 等）。
``RemoteAgentDispatcher`` 是这些调用方应当对接的唯一入口；它的签名 100%
兼容 ``ChatService.send_message_sync``，并按 control_device 状态做三分支路由：

1. control_device 未绑定（用户主动选了"轻量模式"）
   → 内部转发回 ``ChatService.send_message_sync``（注入
     ``app_context.runtime_mode='lightweight'``），交给云端轻量引擎处理。
2. control_device 绑了但离线
   → 立刻返回 ``error_category='device_offline'`` 的兼容字典，
     在 ``client_type='server'`` 场景下额外向 Agent owner 推送桌面通知。
3. control_device 绑了且在线
   → 通过 ``PromptForwardService.forward_prompt(runtime_mode='local')``
     把 prompt 推给设备上的 DaemonAgentHost / ElectronAgentHost，
     阻塞轮询 Redis ``runtime:result:{task_id}`` 直到拿到结果或超时。

"""

from apps.services.remote_agent.dispatcher import RemoteAgentDispatcher

__all__ = ["RemoteAgentDispatcher"]

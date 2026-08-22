"""
agent_execution — 服务端 Agent 执行入口。

ChatService（send_message_sync）及其子服务的统一归属包。
从 orchestration 物理搬迁而来。W10 之后 ChatService 是纯薄壳：
prepare → ingest → contextualize → route，所有 ReAct / 工具执行都在
客户端 ``@tabtin/agent-runtime`` 中完成。

Public API:
    ChatService          — 唯一的外部入口（send_message_sync）

Semi-public (子模块级):
    model_resolver       — 模型解析（仅供 ChatService 内部编排使用）
    context_assembler    — 上下文组装

Deprecated（W7+ 待清理）:
    result_finalizer     — Wave 11 云端编排时代的 Stage 6 结果收尾。
        W10 ChatService 简化为薄壳后整模块所有 export 已 0 业务 caller
        （chat_service.py 0 import；agent_execution/__init__.py 0 re-export）；
        Wave 6 路径权限治理验证发现并登记。**保守保留**理由：跨文件依赖链
        （conversation_store.save_interrupt / state_types.__interrupt__ /
        rule_engine.build_interrupt_payload / PromptForwardService 的
        peek_interrupt_state + restore_interrupt 链路）需要联动 langgraph
        state schema 改动一并清理，跨 sprint 强行清会越界。整组移除作
        L54 独立专项归并到 W7+ langgraph 残骸彻底清理。
        **请勿** import 此模块的任何 export—— ChatService 已不需要。
"""

from apps.services.agent_execution.chat_service import ChatService

__all__ = ["ChatService"]

"""
Context Assembler — 会话上下文组装与 Agent 输入 state 构建。

从 ChatService 提取的 Stage 3 上下文逻辑：
- 会话上下文读取（Session.context → dict）
- identity / 权限身份解析
- 多模态消息归一化
- Agent input state 构建（首次 / 后续对话）
- assemble_full_context：Stage 3 统一编排入口
"""

from typing import Dict, Any, NamedTuple, Optional, List

import logging

from apps.chat.conversation.services.message_role_policy import (
    is_system_authored_message,
    llm_role_for_persisted_message,
)
from apps.i18n import get_text as _i18n
from apps.services.agent_engine.services.group_runtime_service import GroupRuntimeService
from apps.services.agent_engine.state.agent_state import create_initial_state
from apps.services.common.chat_stream_publisher import (
    ChatStreamPublisher as Publisher,
)
from apps.services.agent_engine.services.billing_gateway import (
    resolve_billing_identity as _resolve_billing_identity,
)

logger = logging.getLogger(__name__)

__all__ = [
    "wrap_user_query",
    "repair_incomplete_tool_calls",
    "sanitize_historical_tool_names",
    "get_session_context",
    "resolve_identity_context",
    "PreparedContent",
    "prepare_message_content",
    "build_agent_input_state",
    "enrich_state_permissions",
    "ContextualizeResult",
    "assemble_full_context",
]


# ──────────────────────────────────────────────
#  历史 tool_name 净化（dogfood P0 修复 2026-04-30）
# ──────────────────────────────────────────────

import re

# LLM 上游对 tool function name 的硬正则约束（OpenAI / Anthropic 共同要求）：
# `^[a-zA-Z0-9_-]{1,64}$`，不允许点号 / CJK / 空格。
_TOOL_NAME_SAFE_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_RETIRED_CURRENT_TOOL_NAMES = {
    "bash",
    "web_fetch",
    "read_file",
    "write_file",
    "delete_file",
    "plan_exit",
}


def _sanitize_tool_name(raw_name: Any) -> Any:
    """非法字符替换为下划线 + 截断到 64。

    与本地 Runtime 的 `sanitizeHistoricalToolName`（packages/agent-runtime/src/
    history/select-recent-history.ts）行为对称——仍存在的历史点号工具名会被
    转成当前 canonical 名；已退休的旧 FC 名统一收敛为 `unknown_tool`，避免跨轮
    历史继续把旧工具名教给模型。

    传入 None / 非字符串 / 空字符串时原样返回（不抛错），让 caller 决定如何处理。
    """
    if not isinstance(raw_name, str) or not raw_name:
        return raw_name
    if _TOOL_NAME_SAFE_RE.match(raw_name):
        return "unknown_tool" if raw_name in _RETIRED_CURRENT_TOOL_NAMES else raw_name
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", raw_name)[:64]
    if safe in _RETIRED_CURRENT_TOOL_NAMES:
        logger.info(
            "[cross-turn] retired historical tool name sanitized to unknown_tool: %r",
            raw_name,
        )
        return "unknown_tool"
    if safe != raw_name:
        logger.info(
            "[cross-turn] sanitized historical tool name: %r → %r",
            raw_name,
            safe,
        )
    return safe or "unknown_tool"


def sanitize_historical_tool_names(messages: list) -> list:
    """对历史 messages 里的 tool name 做兼容性净化（in-place 修改）。

    背景（dogfood P0 修复 2026-04-30）：4 月 30 日改名前注册过的旧工具名
    （如 `tabdoc.create_document` / `tabmail.send_email`）带
    点号，违反 LLM 上游 `^[a-zA-Z0-9_-]{1,64}$` 正则。新对话工具列表已全部
    改名，但**旧 session 持久化的 messages 里**仍含旧名 tool_use / tool_calls，
    跨轮装填时若原样喂回 LLM 上游会被 400 reject。

    本函数在历史装填阶段把仍存在的非法 tool name 替换为下划线版
    （`tabdoc.create_document` → `tabdoc_create_document`，与新工具名一致）；
    已退休的旧 FC 名只保留为 `unknown_tool`，不再作为当前工具名喂回模型。
    与本地 Runtime `sanitizeHistoricalToolName` 对称。

    兼容两种 tool_use 序列化格式：
      - OpenAI 风格：``{"role": "assistant", "tool_calls": [{"function": {"name": ...}}]}``
      - Anthropic content-blocks 风格：``{"role": "assistant", "content":
        [{"type": "tool_use", "name": ...}]}``

    不动 ``role == "tool"`` 消息上的 ``name`` 字段——OpenAI 规范里 tool 消息的
    ``name`` 直接呼应 assistant 的 tool_calls.function.name，sanitize 后
    会自动对齐（前一条 assistant 已被净化）。

    仅对 messages 内的 tool_use / tool_calls 净化；不动外部传入工具定义本身
    的 name（那是新工具的真实 name 字段，已合规）。
    """
    if not messages:
        return messages

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")

        # OpenAI 风格：assistant.tool_calls[].function.name
        if role == "assistant":
            tool_calls = msg.get("tool_calls")
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function")
                    if isinstance(fn, dict) and "name" in fn:
                        fn["name"] = _sanitize_tool_name(fn["name"])

        # Anthropic content-blocks 风格：content[].name where type == "tool_use"
        # （也兼容 user 消息里的 tool_result block——虽然 tool_result 没 name 字段，
        #  但旧 LangChain 中间格式里偶尔会有 ToolMessage.name 透传，一并兜底）
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "tool_use" and "name" in block:
                    block["name"] = _sanitize_tool_name(block["name"])

        # OpenAI tool 消息的 name 字段（与 tool_calls.function.name 对齐）
        # 注：role=="tool" 消息有 tool_call_id 配对，name 字段是可选 metadata；
        # 净化保险起见也覆盖。
        if role == "tool" and isinstance(msg.get("name"), str):
            msg["name"] = _sanitize_tool_name(msg["name"])

    return messages


# ──────────────────────────────────────────────
#  纯工具函数（从 chat_service 模块级搬入）
# ──────────────────────────────────────────────

def wrap_user_query(content):
    """将用户消息内容用 <user_query> 标签包裹（用户消息标签格式）。

    支持两种格式：
    - str: 直接包裹（幂等：已包裹则跳过）
    - list (OpenAI multimodal): 合并所有 text 元素后统一包裹为一个标签

    多模态注意事项：list 中所有 text 元素会被合并到首位后统一包裹，
    图片等非文本元素跟在其后，原始交错顺序不保留
    （如 [text1, image, text2] → [merged_text, image]）。
    这是已知的设计取舍，保证 <user_query> 标签唯一且完整。
    """
    if isinstance(content, str):
        if content.lstrip().startswith("<user_query>"):
            return content
        return f"<user_query>\n{content}\n</user_query>"
    if isinstance(content, list):
        text_parts: list[str] = []
        text_indices: list[int] = []
        for i, item in enumerate(content):
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "")
                if text.lstrip().startswith("<user_query>"):
                    return content
                text_parts.append(text)
                text_indices.append(i)
        if not text_parts:
            return content
        if len(text_parts) == 1:
            idx = text_indices[0]
            wrapped = list(content)
            wrapped[idx] = {**content[idx], "text": f"<user_query>\n{text_parts[0]}\n</user_query>"}
            return wrapped
        merged_text = "\n".join(text_parts)
        idx_set = set(text_indices)
        non_text_items = [item for i, item in enumerate(content) if i not in idx_set]
        return [{"type": "text", "text": f"<user_query>\n{merged_text}\n</user_query>"}, *non_text_items]
    return content


def _iter_content_blocks(msg: dict) -> list:
    content = msg.get("content")
    return content if isinstance(content, list) else []


def _snapshot_blocks_for_llm_context(blocks: list) -> list:
    """share snapshot 的工具卡只用于 UI；恢复给 LLM 时转成历史说明。"""
    llm_blocks: list[dict] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "")
        if block_type.endswith("tool_use"):
            name = str(block.get("label") or block.get("name") or "工具").strip()
            llm_blocks.append({
                "type": "text",
                "text": f"[历史工具调用：{name}，参数和结果已从续接快照中省略]",
            })
            continue
        llm_blocks.append(block)
    return llm_blocks


def repair_incomplete_tool_calls(messages: list) -> list:
    """Repair tool_use messages that lack a matching tool_result.

    For each assistant message containing tool_use blocks without a
    corresponding tool result, inject a synthetic expired result so the
    LLM doesn't stall waiting for a response that will never come.

    两种消息风格都扫（ 补齐）：
      - OpenAI 风：assistant.tool_calls[] / role=tool + tool_call_id
      - Anthropic 风：assistant.content[].tool_use / user.content[].tool_result
        （`chat_messages_to_llm_messages` 产出即此风格，此前扫不到——
        云端 recovery 的未配对 tool_use 从未被注入 expired，模型会
        因半拉子 tool_use 报协议错或幻觉等待）
    修复注入按各自风格：OpenAI 风补 role=tool 行；Anthropic 风补
    `{"role":"user","content":[tool_result …]}` 消息。
    """
    if not messages:
        return messages

    pending_openai: dict = {}
    pending_anthropic: dict = {}
    for msg in messages:
        role = msg.get("role") if isinstance(msg, dict) else None
        if role == "assistant":
            tool_calls = msg.get("tool_calls") or []
            for tc in tool_calls:
                tc_id = tc.get("id") if isinstance(tc, dict) else None
                if tc_id:
                    pending_openai[tc_id] = tc
            for block in _iter_content_blocks(msg):
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    block_id = block.get("id")
                    if block_id:
                        pending_anthropic[block_id] = block
        elif role == "tool":
            tc_id = msg.get("tool_call_id")
            if tc_id:
                pending_openai.pop(tc_id, None)
        elif role == "user":
            for block in _iter_content_blocks(msg):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tu_id = block.get("tool_use_id")
                    if tu_id:
                        pending_anthropic.pop(tu_id, None)

    if not pending_openai and not pending_anthropic:
        return messages

    reason = (
        "Previous tool execution was interrupted and not completed. "
        "The user has sent a new message."
    )
    repair_messages = []
    for tc_id in pending_openai:
        repair_messages.append({
            "role": "tool",
            "tool_call_id": tc_id,
            "content": f'{{"status": "expired", "reason": "{reason}"}}',
        })
    if pending_anthropic:
        repair_messages.append({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tu_id,
                    "content": f'{{"status": "expired", "reason": "{reason}"}}',
                    "is_error": True,
                }
                for tu_id in pending_anthropic
            ],
        })

    return messages + repair_messages


# ──────────────────────────────────────────────
#  会话上下文
# ──────────────────────────────────────────────

def get_session_context(session) -> Dict[str, Any]:
    """从 session.context 读取上下文信息（支持多 App 类型）。

    Returns:
        上下文字典，包含专用列字段 + context_data 中的 App 特有字段
    """
    _empty: Dict[str, Any] = {
        'current_table_id': '',
        'current_space_id': '',
        'current_project_id': str(getattr(session, 'project_id', '') or ''),
        'current_view_id': '',
        'recent_tables': [],
        'recent_spaces': [],
        'recent_views': [],
        'identity_kind': 'user',
        'identity_user_id': '',
        'group_runtime': GroupRuntimeService.extract_from_context_data(None),
    }

    if not hasattr(session, 'context'):
        logger.warning("[context_assembler] Session has no context object")
        return _empty

    try:
        ctx = session.context
        ctx_data = getattr(ctx, 'context_data', None) or {}
        context: Dict[str, Any] = {
            'current_table_id': ctx.current_table_id or '',
            'current_space_id': ctx.current_space_id or '',
            'current_project_id': str(ctx.current_project_id or getattr(session, 'project_id', '') or ''),
            'current_view_id': getattr(ctx, 'current_view_id', '') or '',
            'recent_tables': ctx.recent_tables or [],
            'recent_spaces': ctx.recent_spaces or [],
            'recent_views': getattr(ctx, 'recent_views', []) or [],
        }

        try:
            from apps.services.common.app_registry import get_all_context_field_names
            _ctx_keys = (
                ('current_app_type',) + get_all_context_field_names()
                + ('sandbox_path', 'current_folder_path', 'open_tabs')
            )
            for key in _ctx_keys:
                if key in ctx_data:
                    context[key] = ctx_data[key]
        except Exception as e:
            logger.warning(
                "[context_assembler] context_data parsing failed "
                "(dedicated columns retained): %s", e,
            )

        context.update(
            resolve_identity_context(
                organization_id=getattr(session, 'organization_id', None),
                user_id=(
                    getattr(session, 'user_id', None)
                    or getattr(getattr(session, 'user', None), 'id', None)
                ),
            )
        )

        _runtime_space_id = str(
            getattr(session, 'workspace_id', None)
            or context.get('current_space_id')
            or ''
        ).strip()
        if _runtime_space_id:
            context["group_runtime"] = GroupRuntimeService.build_snapshot(
                space_id=_runtime_space_id,
                context_data=ctx_data,
            ).to_dict()
        else:
            normalized_group_runtime = GroupRuntimeService.extract_from_context_data(ctx_data)
            context["group_runtime"] = {
                **normalized_group_runtime,
                "resolved_roles": [],
                "is_active": False,
            }

        logger.info(
            "[context_assembler] Context loaded: app_type=%s, space_id=%s, table_id=%s",
            context.get("current_app_type", ""),
            context.get("current_space_id"),
            context.get("current_table_id"),
        )
        return context
    except Exception as e:
        logger.warning("[context_assembler] Failed to load context: %s", e)
        return _empty


def resolve_identity_context(
    *,
    organization_id: Optional[str],
    user_id: Optional[str],
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """统一解析 identity 与显式 execution agent。"""
    merged = dict(context or {})
    identity_user_id = str(
        merged.get("identity_user_id") or user_id or ""
    ).strip()
    explicit_execution_agent_id = str(
        merged.get("_execution_agent_id")
        or merged.get("execution_agent_id")
        or ""
    ).strip()

    result: Dict[str, Any] = {
        "identity_kind": str(merged.get("identity_kind") or "user"),
        "identity_user_id": identity_user_id,
    }

    if explicit_execution_agent_id:
        result["_execution_agent_id"] = explicit_execution_agent_id

    return result


# ──────────────────────────────────────────────
#  消息内容归一化
# ──────────────────────────────────────────────

class PreparedContent(NamedTuple):
    plain_text: str
    vision_parts: Optional[list]
    context_text: str
    blocks: Optional[list]
    vision_dropped: bool


def prepare_message_content(
    messages: List[str],
    blocks: Optional[list],
    model_instance,
    user_id: str,
    client_message_id: Optional[str] = None,
) -> PreparedContent:
    """上下文引用解析 + 多模态归一化。

    **阶段 6 议题 2 治理**：

    旧实现把 ``context_text`` 用字面前缀 ``"\\n\\n---\\nReferenced context data:\\n"``
    拼接到 user message ——纯字符串落盘到 ``ChatMessage.content_blocks_json`` 后
    跨轮重放时，Agent 看到的还是当时的 schema 快照，但表 / 文档可能已被改了。
    全链路没有任何"数据可能已变"提示。

    新实现用 ``build_user_context_wrapper`` SSoT 套统一 ``<context type="referenced"
    stale_after_turn="<client_message_id>">...</context>`` 外壳，让 history 装填
    阶段（``select-recent-history.ts``）能识别 stale 并替换为指针。Python 端实现
    与 TS 端 ``@tabtin/agent-prompt`` 的 ``buildUserContextWrapper`` 输出
    byte-identical（contract test 锁定）。

    ``client_message_id``：本轮 user message 的客户端 UUID。Django 路径上由
    ``ChatService.send_message`` 注入并透传到本函数。缺省 ``None`` 时 wrapper 不挂
    stale_after_turn——向后兼容旧调用方（譬如老移动端 / 外部 API token 路径），
    但跨轮 stale 检测对那些路径会失效（next-best：仍保持治理前的行为）。
    """
    from apps.chat.conversation.services.context_resolver import resolve_context_blocks
    from apps.chat.conversation.services.block_normalizer import normalize_user_message_for_agent
    from apps.services.agent_execution.user_context_wrapper import build_user_context_wrapper

    context_text = ''
    if blocks:
        try:
            from apps.chat.conversation.services.context_resolver import MAX_CONTEXT_TOKENS
            ref_budget = MAX_CONTEXT_TOKENS
            if model_instance:
                ctx_window = getattr(model_instance, 'context_window_tokens', 0)
                if ctx_window and ctx_window > 0:
                    ref_budget = max(MAX_CONTEXT_TOKENS, min(int(ctx_window * 0.10), 30000))
            context_text, blocks = resolve_context_blocks(blocks, user_id, max_context_tokens=ref_budget)
        except Exception as e:
            logger.warning("[context_assembler] ContextResolver failed: %s", e)

    merged_message = "\n".join(messages)
    if context_text:
        wrapper = build_user_context_wrapper(
            type="referenced",
            body=context_text,
            attrs={"stale_after_turn": client_message_id} if client_message_id else None,
        )
        merged_message = f"{merged_message}\n\n{wrapper}"

    plain_text, vision_parts = normalize_user_message_for_agent(
        merged_message, blocks, client_message_id=client_message_id,
    )

    vision_dropped = False
    if vision_parts and model_instance:
        from apps.services.llm.utils.capabilities import get_capability_flag
        if not get_capability_flag(model_instance, "supports_vision", default=False):
            logger.warning(
                "[context_assembler] Model %s does not support vision, "
                "image content ignored", model_instance.model_name,
            )
            vision_parts = None
            vision_dropped = True

    return PreparedContent(plain_text, vision_parts, context_text, blocks, vision_dropped)


# ──────────────────────────────────────────────
#  Agent input state 构建
# ──────────────────────────────────────────────

def _split_assistant_tool_results(messages: list[dict]) -> list[dict]:
    """assistant 消息里 co-locate 的 tool_result 拆成后续 user 消息。

    ChatMessage 落库形态（persist_message）把本轮 tool_result 与 assistant
    的 text/tool_use co-locate 在同一行——这是展示/落库形态；但 Anthropic
    协议里 tool_result 必须以 user 消息回给模型。与本地
    `reconstructMessagesFromBlockRecords` 同构拆分，保证「云端副本重建的
    LLM 历史 = 本机 block 重建」。
    """
    out: list[dict] = []
    for msg in messages:
        if msg.get("role") != "assistant" or not isinstance(msg.get("content"), list):
            out.append(msg)
            continue
        blocks = msg["content"]
        tool_results = [
            b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"
        ]
        if not tool_results:
            out.append(msg)
            continue
        assistant_blocks = [
            b for b in blocks if not (isinstance(b, dict) and b.get("type") == "tool_result")
        ]
        if assistant_blocks:
            out.append({**msg, "content": assistant_blocks})
        out.append({"role": "user", "content": tool_results})
    return out


def _chat_message_rows_to_recovery_messages(rows: list[dict]) -> list[dict]:
    """把 ChatMessage 主时间线行转换成可喂给 runtime 的 LLM messages。"""
    if not rows:
        return []

    from apps.services.agent_engine.services.blocks_to_llm_context import (
        chat_messages_to_llm_messages,
    )

    chat_messages: list[dict] = []
    kinds: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        role = row.get("role")
        if role not in {"user", "assistant", "system"}:
            continue
        content_blocks = row.get("content_blocks_json")
        if not isinstance(content_blocks, list):
            content_blocks = []
        text_summary = row.get("text_summary")
        if not content_blocks and isinstance(text_summary, str) and text_summary.strip():
            content_blocks = [{"type": "text", "text": text_summary}]
        if not content_blocks:
            continue
        message_kind = str(row.get("message_kind") or "llm")
        metadata = row.get("metadata")
        if isinstance(metadata, dict) and metadata.get("share_snapshot") is True:
            content_blocks = _snapshot_blocks_for_llm_context(content_blocks)
        if role == "system":
            if not is_system_authored_message(
                message_kind=message_kind,
                metadata=metadata,
            ):
                continue
        chat_messages.append({
            "role": llm_role_for_persisted_message(
                role=role,
                message_kind=message_kind,
            ),
            "content_blocks_json": content_blocks,
        })
        kinds.append(message_kind)

    recovered = chat_messages_to_llm_messages(chat_messages)
    # chat_messages_to_llm_messages 逐条一一对应，kinds 按 index 对齐。
    # 只有真 user query（kind=llm）包 <user_query>；environment_context /
    # agent_profile_context / compaction_summary 是 runtime 注入的结构化上下文，
    # 不能当用户话术包装。
    for idx, msg in enumerate(recovered):
        kind = kinds[idx] if idx < len(kinds) else "llm"
        if msg.get("role") == "user" and kind == "llm":
            msg["content"] = wrap_user_query(msg.get("content"))
    split = _split_assistant_tool_results(recovered)
    return sanitize_historical_tool_names(repair_incomplete_tool_calls(split))


#  /  / ：与本地 block 重建同口径的 recovery kind 集合——llm（正文）、
# environment_context / agent_profile_context（历史注入上下文）、compaction_summary
# （压缩检查点）。
# tool_artifact / error_envelope / hitl_interaction 是展示气泡，不进 LLM 历史。
# system_prompt_context仅审计落库，本轮规则走 llmRequest.system，不进恢复历史。
_RECOVERY_MESSAGE_KINDS = (
    "llm",
    "environment_context",
    "agent_profile_context",
    "external_archive_context",
    "compaction_summary",
)


def _load_recovery_messages_from_chat_messages(session_id: Any) -> list[dict]:
    """从 ChatMessage 主时间线恢复 LLM context。

    这是移动端/瘦客户端的兜底路径：当 PG ConversationState 缺失时，至少
    让 Agent 看到已经落库的主对话历史。子 Agent 消息与 tool_artifact 气泡
    不属于主 LLM 时间线，避免混入后让模型误判当前对话。

     对齐本地 block 重建口径：
      - kind 取 `_RECOVERY_MESSAGE_KINDS`（原来只取 llm，丢历史环境上下文
        与压缩检查点）；
      - 存在 compaction_summary 时从**最后一个**检查点起截断（原来把压缩前
        的全量历史也喂回去，上下文膨胀且与本机不一致）。
    """
    from django.db.models import Q
    from apps.chat.conversation.models import ChatMessage

    rows = list(
        ChatMessage.objects
        .filter(
            session_id=session_id,
            message_kind__in=_RECOVERY_MESSAGE_KINDS,
            role__in=["user", "assistant", "system"],
        )
        .filter(Q(subagent_run_id="") | Q(subagent_run_id__isnull=True))
        .order_by("created_at", "id")
        .values("role", "content_blocks_json", "text_summary", "message_kind", "metadata")
    )
    # 压缩检查点截断：最后一条 compaction_summary（含）之后才是当前有效历史。
    last_checkpoint = -1
    for idx, row in enumerate(rows):
        if row.get("message_kind") == "compaction_summary":
            last_checkpoint = idx
    if last_checkpoint >= 0:
        rows = rows[last_checkpoint:]
    return _chat_message_rows_to_recovery_messages(rows)


_PROJECT_TASK_CONTEXT_MARKER = '<project_task_context>'


def _project_task_turn_instruction(session) -> str:
    """仅为绑定 TaskRun 的执行会话补充 Project 工作契约。"""
    try:
        from apps.tabtinspace.services.project_task_runtime import (
            build_project_task_turn_instruction,
        )
        return build_project_task_turn_instruction(session)
    except Exception:
        logger.warning(
            '[context_assembler] project task context resolution failed: session=%s',
            getattr(session, 'id', None),
            exc_info=True,
        )
        return ''


def _inject_project_task_turn_context(messages: list[dict], instruction: str) -> list[dict]:
    """替换上轮 Task 契约，避免它在长会话里累积成陈旧提示。"""
    if not instruction:
        return messages
    without_previous = [
        message for message in messages
        if not (
            message.get('role') == 'system'
            and isinstance(message.get('content'), str)
            and _PROJECT_TASK_CONTEXT_MARKER in message['content']
        )
    ]
    return [*without_previous, {'role': 'system', 'content': instruction}]


def build_agent_input_state(
    *,
    session,
    user,
    effective_thread_id: str,
    context: Dict[str, Any],
    plain_text: str,
    vision_parts,
    is_first_message: bool,
    model_id: Optional[str],
    user_selected_model: bool,
    client_type: Optional[str],
    execution_profile: Optional[str],
    resolved_agent_name: str,
    agent_mode: Optional[str] = None,
    execution_user=None,
    execution_context=None,
) -> Dict[str, Any]:
    """构建 Agent 输入 state（区分首次/后续对话）。"""
    user_msg_content = vision_parts if vision_parts else plain_text
    effective_user = execution_user or user
    project_task_instruction = (
        _project_task_turn_instruction(session)
        if context.get('current_app_type') == 'project_task'
        else ''
    )

    if is_first_message:
        input_state = create_initial_state(
            user_id=str(effective_user.id),
            organization_id=session.organization_id,
            session_id=str(session.id),
            user_message=wrap_user_query(plain_text),
            thread_id=effective_thread_id,
            context=context,
            model_id=model_id,
            client_type=client_type,
            execution_profile=execution_profile,
            agent_mode=agent_mode,
        )
        input_state["_user_selected_model"] = user_selected_model
        input_state['messages'] = _inject_project_task_turn_context(
            input_state.get('messages', []),
            project_task_instruction,
        )
        if vision_parts:
            wrapped_vision = wrap_user_query(vision_parts)
            for msg in input_state.get("messages", []):
                if msg.get("role") == "user":
                    msg["content"] = wrapped_vision
    else:
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore

        existing_state = ConversationStore.load_state(
            effective_thread_id,
            expected_user_id=str(effective_user.id),
        )
        if existing_state:
            existing_messages = existing_state.get("messages", [])
            existing_messages = repair_incomplete_tool_calls(existing_messages)
            # 兜底：以防 conversation_store 装载路径之外有其他 messages 注入路径
            # （比如 in-memory state 直接传入），同样净化历史 tool name。
            existing_messages = sanitize_historical_tool_names(existing_messages)
            existing_messages = _inject_project_task_turn_context(
                existing_messages,
                project_task_instruction,
            )
            existing_messages.append({"role": "user", "content": wrap_user_query(user_msg_content)})
            input_state = existing_state
            input_state["messages"] = existing_messages
            if not input_state.get("user_id"):
                input_state["user_id"] = str(effective_user.id)
            if not input_state.get("organization_id"):
                input_state["organization_id"] = session.organization_id
            # W5 cleanup (2026-05-26)：group_runtime_result 已 deprecated；
            # 旧路径每次显式写 None 是无意义噪声，移除。
        else:
            recovered_messages: list[dict] = []
            try:
                from apps.chat.conversation.models import ChatMessage as _CM
                _mysql_count = _CM.objects.filter(session_id=session.id).count()
                recovered_messages = _load_recovery_messages_from_chat_messages(session.id)
            except Exception:
                _mysql_count = -1

            input_state = create_initial_state(
                user_id=str(effective_user.id),
                organization_id=session.organization_id,
                session_id=str(session.id),
                user_message=wrap_user_query(user_msg_content),
                thread_id=effective_thread_id,
                context=context,
                model_id=model_id,
                client_type=client_type,
                execution_profile=execution_profile,
                agent_mode=agent_mode,
            )
            input_state["_recovered"] = True
            if recovered_messages:
                logger.info(
                    "[context_assembler] ConversationStore empty for non-first message; "
                    "recovered context from ChatMessage timeline | "
                    "thread_id=%s session_id=%s mysql_msg_count=%d recovered_msgs=%d",
                    effective_thread_id,
                    session.id,
                    _mysql_count,
                    len(recovered_messages),
                )
                input_state["messages"] = _inject_project_task_turn_context(
                    recovered_messages,
                    project_task_instruction,
                )
                input_state["_recovered_from_chat_messages"] = True
            else:
                logger.warning(
                    "[context_assembler] ConversationStore empty for non-first message; "
                    "rebuilding initial state as fallback | "
                    "thread_id=%s session_id=%s mysql_msg_count=%d",
                    effective_thread_id,
                    session.id,
                    _mysql_count,
                )
                try:
                    Publisher.publish_system_notice(
                        effective_thread_id,
                        "Agent 的对话记忆出现中断，历史上下文暂时不可用。"
                        "如 Agent 对近期操作有偏差，建议简要补充关键上下文或开启新对话。",
                        notice_type="state_recovery",
                    )
                except Exception:
                    logger.debug(
                        "[context_assembler] Recovery notice publish failed",
                        exc_info=True,
                    )

                from apps.services.common.agent_protocol.slots import (
                    MSG_SLOT_KEY,
                    SLOT_RECOVERY_NOTICE,
                )
                _recovery_msg = {
                    "role": "system",
                    "content": (
                        "[Context Recovery Notice]\n"
                        "The conversation state was lost and has been rebuilt from scratch. "
                        "Previous tool call history, todo items, and intermediate results "
                        "are unavailable. If the user references prior actions, ask them "
                        "to clarify."
                    ),
                    MSG_SLOT_KEY: SLOT_RECOVERY_NOTICE,
                }
                _msgs = input_state.get("messages", [])
                _msgs.insert(0, _recovery_msg)
                input_state["messages"] = _msgs

        if project_task_instruction and not any(
            message.get('role') == 'system'
            and isinstance(message.get('content'), str)
            and _PROJECT_TASK_CONTEXT_MARKER in message['content']
            for message in input_state.get('messages', [])
        ):
            input_state['messages'] = _inject_project_task_turn_context(
                input_state.get('messages', []),
                project_task_instruction,
            )

        input_state["model_id"] = model_id
        input_state["_user_selected_model"] = user_selected_model
        from apps.services.agent_engine.state.agent_state import apply_context_to_state
        apply_context_to_state(input_state, context)

    if execution_profile:
        input_state["execution_profile"] = execution_profile
    if agent_mode:
        input_state["agent_mode"] = agent_mode
    input_state["agent_name"] = resolved_agent_name
    if execution_context is not None and execution_context.is_team_space:
        input_state["team_space_execution"] = execution_context.to_context_fields()
        input_state["initiator_user_id"] = execution_context.initiator_user_id
        input_state["execution_owner_user_id"] = execution_context.execution_owner_user_id
    # W5 cleanup (2026-05-26)：group_runtime_result 已 deprecated；
    # 旧路径每次显式写 None 是无意义噪声，移除。
    # system_prompt 是完整 override，只接受服务端内部 key；
    # chat.send_message 的普通 app_context 不开放显式用户覆盖。
    for key in ("_request_system_prompt", "_rendered_system_prompt"):
        value = context.get(key)
        if isinstance(value, str) and value.strip():
            input_state[key] = value

    _resolve_billing_identity(input_state, session, effective_user)

    return input_state


# ──────────────────────────────────────────────
#  权限增强
# ──────────────────────────────────────────────

def enrich_state_permissions(
    input_state: Dict[str, Any],
    *,
    app_context: Optional[Dict[str, Any]],
    session,
    user,
    effective_thread_id: str,
    client_type: Optional[str] = None,
) -> None:
    """将 channel/API-token 权限信息写入 input_state。

    在 build_agent_input_state 之后调用，负责 stage-level 的权限增强。
    会原地修改 input_state。
    """
    if client_type == "channel":
        input_state["_authorization_rules"] = {
            'read': 'confirm',
            'write': 'confirm',
            'install': 'confirm',
            'delete_system': 'confirm',
            'script': 'confirm',
        }
        input_state["_channel_cautious_locked"] = True
        logger.info(
            "[context_assembler] Channel client detected, enforcing full-confirm "
            "authorization (DS-013): thread=%s, sender=%s",
            effective_thread_id,
            input_state.get("channel_sender_id", "unknown"),
        )


# ──────────────────────────────────────────────
#  Stage 3 统一编排入口
# ──────────────────────────────────────────────

class ContextualizeResult(NamedTuple):
    input_state: Dict[str, Any]
    plain_text: str
    context: Dict[str, Any]
    blocks: Optional[list]


def assemble_full_context(
    *,
    session,
    user,
    effective_thread_id: str,
    model_instance,
    model_fell_back: bool,
    final_model_id: Optional[str],
    user_selected_model: bool,
    resolved_agent_name: str,
    is_first_message: bool,
    messages: List[str],
    blocks: Optional[list],
    app_context: Optional[Dict[str, Any]],
    client_type: Optional[str],
    execution_profile: Optional[str],
    api_token_space_ids: Optional[List[str]],
    agent_mode: Optional[str],
    execution_context=None,
    client_message_id: Optional[str] = None,
) -> ContextualizeResult:
    """Stage 3 完整编排：上下文组装 + 权限 + Agent state 构建。

    将 ChatService._stage_contextualize 的全部逻辑封装为一次调用。

    ``client_message_id``（阶段 6 议题 2）：本轮客户端 user message UUID；用于
    给 referenced / attached wrapper 挂 ``stale_after_turn`` attr。
    """
    context = get_session_context(session)
    if app_context:
        context.update(app_context)

    execution_user = user
    if execution_context is not None and execution_context.is_team_space:
        execution_user = execution_context.execution_owner_user
        # current_space_id 只表示资源宿主；执行现场走 execution_space_id，
        # 协作场走 current_project_id。
        context["current_project_id"] = execution_context.collaboration_space_id
        context["collaboration_space_id"] = execution_context.collaboration_space_id
        context["execution_space_id"] = execution_context.execution_space_id
        context["initiator_user_id"] = execution_context.initiator_user_id
        context["execution_owner_user_id"] = execution_context.execution_owner_user_id

    context.update(
        resolve_identity_context(
            organization_id=str(getattr(session, "organization_id", "") or ""),
            user_id=str(getattr(execution_user, "id", "") or ""),
            context=context,
        )
    )
    logger.debug(
        "[E2E][context_assembler] Context assembled: session=%s thread=%s context_keys=%s",
        session.id, effective_thread_id, sorted(context.keys()),
    )

    _ctx_space_id = context.get("current_space_id")
    if _ctx_space_id:
        from apps.tabtinspace.services.base import BaseService as _SpaceBaseService
        if not _SpaceBaseService(user=execution_user).check_space_permission(str(_ctx_space_id)):
            logger.warning(
                "[context_assembler][AC-005] user=%s has no access to space=%s, "
                "clearing current_space_id",
                execution_user.id, _ctx_space_id,
            )
            context["current_space_id"] = ""

    prepared = prepare_message_content(
        messages, blocks, model_instance, str(user.id),
        client_message_id=client_message_id,
    )
    plain_text = prepared.plain_text
    vision_parts = prepared.vision_parts
    blocks = prepared.blocks

    if model_fell_back and user_selected_model and model_instance:
        Publisher.publish_system_notice(
            effective_thread_id,
            _i18n("agent.model_fallback", model=model_instance.model_name),
        )

    if prepared.vision_dropped:
        Publisher.publish_system_notice(
            effective_thread_id,
            _i18n("agent.vision_content_dropped"),
        )

    logger.debug(
        "[E2E][context_assembler] Message prepared: plain_text_len=%d "
        "vision_parts=%s blocks_count=%d",
        len(plain_text), bool(vision_parts), len(blocks) if blocks else 0,
    )

    input_state = build_agent_input_state(
        session=session,
        user=user,
        effective_thread_id=effective_thread_id,
        context=context,
        plain_text=plain_text,
        vision_parts=vision_parts,
        is_first_message=is_first_message,
        model_id=final_model_id,
        user_selected_model=user_selected_model,
        client_type=client_type,
        execution_profile=execution_profile,
        resolved_agent_name=resolved_agent_name,
        agent_mode=agent_mode,
        execution_user=execution_user,
        execution_context=execution_context,
    )
    if prepared.vision_dropped:
        input_state["_vision_content_dropped"] = True
    if api_token_space_ids is not None:
        input_state["_api_token_space_ids"] = api_token_space_ids

    enrich_state_permissions(
        input_state,
        app_context=app_context,
        session=session,
        user=user,
        effective_thread_id=effective_thread_id,
        client_type=client_type,
    )

    logger.info(
        "[E2E][context_assembler] input_state built: thread=%s agent=%s model=%s "
        "is_first=%s profile=%s client=%s",
        effective_thread_id, resolved_agent_name, final_model_id,
        is_first_message, execution_profile, client_type,
    )

    return ContextualizeResult(
        input_state=input_state,
        plain_text=plain_text,
        context=context,
        blocks=blocks,
    )

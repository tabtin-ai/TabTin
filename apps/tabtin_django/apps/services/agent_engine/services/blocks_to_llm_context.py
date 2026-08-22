"""W3 §3.3.2 ChatMessage.content_blocks_json → ConversationState.messages_json
转换服务（写入 LLM context 前 strip tabtin_* 块）。

== 背景 ==

W3 起 ChatMessage.content_blocks_json 与 ConversationState.messages_json 都改
Anthropic ContentBlock[] 形态。但两者职责不同：

- `chat_message.content_blocks_json` —— **用户可见消息**真相源（UI 渲染 + 历史
  回看）。包含所有 ContentBlock 类型，含 TabTin 扩展（tabtin_rich_content /
  tabtin_skill_invocation / tabtin_source_ref / tabtin_approval_request 等）。

- `conversation_state.messages_json` —— **LLM context 快照**（下次 LLM 调用入参）。
  必须是**纯 Anthropic 风** ContentBlock[]，不能含 tabtin_* 扩展（LLM 不识别）。

本模块负责 chat_message → conversation_state 的转换：

1. **strip tabtin_* 块**：转换为 Anthropic 标准块（text / image / document）
2. **保留语义关键信息**：tabtin_skill_invocation 的 injected_text 要进 LLM
   context；tabtin_rich_content(image) 要变 image block；tabtin_source_ref
   要变 text block 描述 ref + snapshot（参考 v3 §3.3.2 表）

== 转换规则（v3 §3.3.2 表） ==

| 源 block.type                    | 目标 block.type | 转换规则                                                  |
|----------------------------------|-----------------|-----------------------------------------------------------|
| `tabtin_source_ref`              | `text`          | 拼装 ref_kind + snapshot 关键信息为 text                  |
| `tabtin_rich_content(kind=image)`| `image`         | 提取 payload.url / source 转 ImageContentBlock            |
| `tabtin_rich_content(其他 kind)` | `text`          | 用 summary 字段；payload 详情走 text 描述                 |
| `tabtin_composer_preset`         | `text`          | 用 preset 渲染后的提示词（preset_id + params 描述）       |
| `tabtin_skill_invocation`        | `text`          | injected_text 直接当 text（这是 skill 注入到 LLM 的内容） |
| `tabtin_ask_user_fields`         | `text`          | 序列化 field_values 为 "field=value" 形式                 |
| `tabtin_approval_request`        | `text`          | 拼装 prompt + options 为 text 描述                        |
| 其他 Anthropic 标准 block        | 透传            | 不动                                                      |

== 设计原则 ==

- **纯函数**：所有 transform 函数都是 pure function（无 IO，仅做 dict → dict）
- **单元测试覆盖每条规则**：见 tests/test_blocks_to_llm_context.py
- **未知块类型 fallback**：未识别的 type 默认走 text block（含原 type 提示），
  不抛异常，不丢数据——LLM 收到"[unknown block type 'foo']"也能 graceful
  degradation
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


# ── tabtin_* 块类型常量集合（v3 §2.2 schema） ────────────────────────────

TABTIN_BLOCK_TYPES: frozenset[str] = frozenset({
    'tabtin_source_ref',
    'tabtin_rich_content',
    'tabtin_composer_preset',
    'tabtin_skill_invocation',
    'tabtin_ask_user_fields',
    'tabtin_approval_request',
})

# Anthropic 标准块类型（v3 §2.2 + Anthropic API spec）—— 这些 type 直接透传
ANTHROPIC_STANDARD_BLOCK_TYPES: frozenset[str] = frozenset({
    'text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking',
    'image', 'document', 'server_tool_use', 'web_search_tool_result',
    'code_execution_tool_result', 'bash_code_execution_tool_result',
    'text_editor_code_execution_tool_result', 'mcp_tool_use',
    'mcp_tool_result', 'container_upload', 'search_result',
})

# TabTin 附着在标准块上的 UI 元数据：可随 ChatMessage 持久化供历史回放，
# 但不能进入 ConversationState / 上游模型请求。
_UI_ONLY_STANDARD_BLOCK_FIELDS: frozenset[str] = frozenset({
    'presentation',
})


# ── tabtin_* → text/image/document 转换函数 ────────────────────────────


def _transform_tabtin_source_ref(block: dict[str, Any]) -> dict[str, Any]:
    """tabtin_source_ref → text（描述 ref + snapshot）。

    schema:
    ```
    {
      type: 'tabtin_source_ref',
      source_id: str,
      ref_kind: 'web' | 'doc' | 'table' | 'code' | 'memo',
      snapshot: { kind, ... }  // 按 ref_kind discriminator
    }
    ```
    """
    ref_kind = block.get('ref_kind', 'unknown')
    snapshot = block.get('snapshot', {})
    parts: list[str] = [f"[源引用: {ref_kind}]"]

    if isinstance(snapshot, dict):
        kind = snapshot.get('kind', '')
        if kind == 'web':
            url = snapshot.get('url', '')
            title = snapshot.get('title', '')
            preview = snapshot.get('preview', '')
            selected_text = snapshot.get('selected_text', '')
            if title:
                parts.append(f"标题：{title}")
            if url:
                parts.append(f"URL：{url}")
            if selected_text:
                parts.append(f"选中文本：{selected_text}")
            elif preview:
                parts.append(f"预览：{preview}")
        elif kind == 'doc':
            parts.append(f"文档 ID：{snapshot.get('doc_id', '')}")
            if snapshot.get('page'):
                parts.append(f"页码：{snapshot['page']}")
            if snapshot.get('preview'):
                parts.append(f"预览：{snapshot['preview']}")
        elif kind == 'table':
            parts.append(f"表 ID：{snapshot.get('table_id', '')}")
            if snapshot.get('csv_preview'):
                parts.append(f"CSV 预览：\n{snapshot['csv_preview']}")
        elif kind == 'code':
            parts.append(
                f"代码：{snapshot.get('file_path', '')}:"
                f"{snapshot.get('start_line', '')}-{snapshot.get('end_line', '')}"
            )
            if snapshot.get('code_excerpt'):
                lang = snapshot.get('lang', '')
                fence = f"```{lang}" if lang else "```"
                parts.append(f"{fence}\n{snapshot['code_excerpt']}\n```")
        elif kind == 'memo':
            parts.append(f"Memo ID：{snapshot.get('memo_id', '')}")
            if snapshot.get('preview'):
                parts.append(f"预览：{snapshot['preview']}")

    return {'type': 'text', 'text': '\n'.join(parts)}


def _transform_tabtin_rich_content(block: dict[str, Any]) -> dict[str, Any]:
    """tabtin_rich_content → image / text（按 kind 分支）。

    schema:
    ```
    {
      type: 'tabtin_rich_content',
      kind: 'image' | 'table_preview' | 'resource_ref' | 'file' | 'widget' | ...,
      summary: str,
      group_id: str | None,
      payload: dict | None
    }
    ```
    """
    kind = block.get('kind', '')
    summary = block.get('summary', '')
    payload = block.get('payload') if isinstance(block.get('payload'), dict) else {}

    if kind == 'image':
        # 优先从 payload 提取 url 形成 ImageContentBlock
        url = payload.get('url') or payload.get('image_url')
        if url:
            return {
                'type': 'image',
                'source': {'type': 'url', 'url': url},
            }
        # fallback：用 base64 数据
        b64_data = payload.get('base64') or payload.get('data')
        media_type = payload.get('media_type', 'image/png')
        if b64_data:
            return {
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': media_type,
                    'data': b64_data,
                },
            }
        # fallback：file_id（FileIdImageSource）
        file_id = payload.get('file_id')
        if file_id:
            return {
                'type': 'image',
                'source': {'type': 'file_id', 'file_id': file_id},
            }
        # 无 url/base64/file_id —— degraded 走 text
        return {'type': 'text', 'text': f"[图片] {summary or '<no source>'}"}

    # 其他 kind —— 走 text 描述
    parts = [f"[{kind}]"]
    if summary:
        parts.append(summary)
    if payload:
        # 截断 payload 描述避免过大；仅取 key 名 + 前 200 字 dump
        try:
            payload_str = json.dumps(payload, ensure_ascii=False, default=str)
            if len(payload_str) > 200:
                payload_str = payload_str[:200] + '...[truncated]'
            parts.append(f"详情：{payload_str}")
        except (TypeError, ValueError):
            parts.append(f"详情：[unserializable payload]")
    return {'type': 'text', 'text': '\n'.join(parts)}


def _transform_tabtin_composer_preset(block: dict[str, Any]) -> dict[str, Any]:
    """tabtin_composer_preset → text（preset 渲染描述）。

    schema:
    ```
    {
      type: 'tabtin_composer_preset',
      preset_id: str,
      params: dict,
      source: 'preset' | 'ask_user' | None,
    }
    ```
    """
    preset_id = block.get('preset_id', '')
    params = block.get('params', {}) if isinstance(block.get('params'), dict) else {}
    source = block.get('source', '')

    parts = [f"[Composer Preset：{preset_id}]"]
    if source:
        parts.append(f"来源：{source}")
    if params:
        try:
            params_str = json.dumps(params, ensure_ascii=False, default=str)
            if len(params_str) > 300:
                params_str = params_str[:300] + '...[truncated]'
            parts.append(f"参数：{params_str}")
        except (TypeError, ValueError):
            parts.append("参数：[unserializable]")
    return {'type': 'text', 'text': '\n'.join(parts)}


def _transform_tabtin_skill_invocation(block: dict[str, Any]) -> dict[str, Any]:
    """tabtin_skill_invocation → text（injected_text 直接给 LLM 看）。

    schema:
    ```
    {
      type: 'tabtin_skill_invocation',
      skill_id: str,
      skill_name: str,
      injected_text: str,            // 这是 skill 注入到 LLM context 的内容
      injected_text_summary: str,    // UI 兜底显示
    }
    ```

    LLM 看到的就是 injected_text 全文（这是 skill 设计的注入内容）；UI 看到的
    是 injected_text_summary（短描述）。本转换走 LLM 路径，用 injected_text。
    """
    injected_text = block.get('injected_text', '')
    skill_name = block.get('skill_name', '')
    if not injected_text:
        return {'type': 'text', 'text': f"[Skill: {skill_name}]"}
    return {'type': 'text', 'text': injected_text}


def _transform_tabtin_ask_user_fields(block: dict[str, Any]) -> dict[str, Any]:
    """tabtin_ask_user_fields → text（序列化 field_values）。

    schema:
    ```
    {
      type: 'tabtin_ask_user_fields',
      field_values: dict[str, Any],
    }
    ```

    把用户填写的字段值序列化为 "field_name=value" 形式让 LLM 收到。
    """
    field_values = block.get('field_values', {}) if isinstance(block.get('field_values'), dict) else {}
    if not field_values:
        return {'type': 'text', 'text': '[用户未填写]'}
    lines = ['[用户填写的字段]']
    for k, v in field_values.items():
        try:
            v_str = str(v) if not isinstance(v, (dict, list)) else json.dumps(v, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            v_str = '[unserializable]'
        lines.append(f"{k}={v_str}")
    return {'type': 'text', 'text': '\n'.join(lines)}


def _transform_tabtin_approval_request(block: dict[str, Any]) -> dict[str, Any]:
    """tabtin_approval_request → text（描述审批请求 + options）。

    schema:
    ```
    {
      type: 'tabtin_approval_request',
      approval_id: str,
      prompt: str,
      options: [{id, label}, ...],
      expires_at: str | None,
    }
    ```
    """
    prompt = block.get('prompt', '')
    options = block.get('options', []) if isinstance(block.get('options'), list) else []

    parts = [f"[审批请求] {prompt}"]
    if options:
        opts_str_parts = []
        for opt in options:
            if isinstance(opt, dict):
                opts_str_parts.append(f"{opt.get('id', '?')}: {opt.get('label', '?')}")
        if opts_str_parts:
            parts.append("选项：" + " / ".join(opts_str_parts))
    return {'type': 'text', 'text': '\n'.join(parts)}


# ── 调度表：tabtin_* type → transform function ─────────────────────────

_TABTIN_TRANSFORMERS: dict[str, Any] = {
    'tabtin_source_ref': _transform_tabtin_source_ref,
    'tabtin_rich_content': _transform_tabtin_rich_content,
    'tabtin_composer_preset': _transform_tabtin_composer_preset,
    'tabtin_skill_invocation': _transform_tabtin_skill_invocation,
    'tabtin_ask_user_fields': _transform_tabtin_ask_user_fields,
    'tabtin_approval_request': _transform_tabtin_approval_request,
}


def _transform_unknown(block: dict[str, Any]) -> dict[str, Any]:
    """fallback：未知块类型 → text（含原 type 提示，graceful degradation）。"""
    block_type = block.get('type', 'unknown')
    return {
        'type': 'text',
        'text': f"[unknown block type '{block_type}']",
    }


# ── 主入口 ──────────────────────────────────────────────────────────────


def strip_tabtin_blocks_for_llm(content_blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """W3 §3.3.2：把 ContentBlock[] 中所有 tabtin_* 块转成 Anthropic 标准块。

    Args:
        content_blocks: ChatMessage.content_blocks_json 数组

    Returns:
        新列表（不修改原列表）；tabtin_* 块按 _TABTIN_TRANSFORMERS 表转换；
        Anthropic 标准块透传；未知块走 _transform_unknown fallback。

    幂等：纯函数，多次调用结果一致。
    """
    if not content_blocks:
        return []
    result: list[dict[str, Any]] = []
    for block in content_blocks:
        if not isinstance(block, dict):
            # 非 dict（不应出现）—— 跳过避免污染下游 LLM
            logger.warning(
                "[blocks_to_llm_context] non-dict block 跳过: %r", type(block).__name__,
            )
            continue
        block_type = block.get('type', '')
        if block_type in _TABTIN_TRANSFORMERS:
            transformer = _TABTIN_TRANSFORMERS[block_type]
            result.append(transformer(block))
        elif block_type in ANTHROPIC_STANDARD_BLOCK_TYPES:
            # 标准块保留协议字段，但剥离仅供 TabTin UI 使用的展示元数据。
            # deep copy 避免下游修改污染上游持久化真相源。
            import copy as _copy
            copied = _copy.deepcopy(block)
            for field in _UI_ONLY_STANDARD_BLOCK_FIELDS:
                copied.pop(field, None)
            result.append(copied)
        else:
            # 未知 type —— graceful degradation
            logger.warning(
                "[blocks_to_llm_context] unknown block type='%s'，走 fallback",
                block_type,
            )
            result.append(_transform_unknown(block))
    return result


def chat_messages_to_llm_messages(
    chat_messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """ChatMessage 数组 → LLM 风 message 数组（用于 conversation_state.messages_json）。

    Args:
        chat_messages: 每条形如:
            ```
            { 'role': 'user' | 'assistant' | 'system', 'content_blocks': list }
            ```

    Returns:
        LLM 风 message 数组：
            ```
            [{ 'role': 'user', 'content': [strip 后的 ContentBlock[]] }, ...]
            ```

    职责分离：本函数只做"消息层"组装，不处理 system prompt / tool definitions
    等；后者由 llm_executor 在调 LLM 前补全。
    """
    result: list[dict[str, Any]] = []
    for msg in chat_messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get('role', '')
        content_blocks = msg.get('content_blocks', []) or msg.get('content_blocks_json', [])
        if not isinstance(content_blocks, list):
            content_blocks = []
        stripped = strip_tabtin_blocks_for_llm(content_blocks)
        result.append({
            'role': role,
            'content': stripped,
        })
    return result

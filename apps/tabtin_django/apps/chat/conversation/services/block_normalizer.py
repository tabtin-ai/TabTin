"""
Block 归一化器

将前端发送的 v2 结构化消息块（blocks）转换为
Agent 引擎可用的 OpenAI message 格式。

主要职责：
1. 将 image block 转为 OpenAI vision content parts
2. 将 file block 的内容提取/注入为 text part
3. 将 doc_selection / table_selection 转为 context text
4. 维持纯 text block 不变
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def normalize_user_message_for_agent(
    text: str,
    blocks: Optional[List[Dict[str, Any]]] = None,
    client_message_id: Optional[str] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    将 v2 blocks + text 归一化为 Agent 引擎可用的格式。

    ``client_message_id``（阶段 6 议题 2）：用于给 file 类 block 文本套
    ``<context type="attached" stale_after_turn=...>`` SSoT wrapper，让跨轮重放
    阶段能识别过期附件。详见 ``user_context_wrapper.py``。

    Returns:
        (plain_text, content_parts)
        - plain_text: 纯文本内容（v1 兼容）
        - content_parts: OpenAI 多模态 content 数组
          如果没有图片类 block，content_parts 为空列表，
          Agent 应使用 plain_text 作为输入
    """
    if not blocks:
        return text, []

    has_images = any(b.get("type") == "image" for b in blocks)

    # 如果没有图片，仅拼接文本并返回
    if not has_images:
        parts = [text] if text else []
        for block in blocks:
            if block.get("_resolved_text"):
                continue
            btype = block.get("type", "")
            if btype == "text" and block.get("text"):
                if block["text"] != text:  # 避免重复
                    parts.append(block["text"])
            elif btype == "file":
                parts.append(_wrap_attached_file(block, client_message_id))
            elif btype == "doc_selection":
                parts.append(_doc_selection_to_text(block))
            elif btype == "table_selection":
                parts.append(_table_selection_to_text(block))
            elif btype == "code_file":
                parts.append(_code_file_to_text(block))
            elif btype == "code_selection":
                parts.append(_code_selection_to_text(block))
            elif btype == "web_selection":
                parts.append(_web_selection_to_text(block))
            elif btype == "web_annotation":
                parts.append(_web_annotation_to_text(block))
        return "\n\n".join(parts), []

    # 有图片：构建 OpenAI 多模态 content parts
    content_parts: List[Dict[str, Any]] = []

    # 先放文本
    if text:
        content_parts.append({"type": "text", "text": text})

    for block in blocks:
        if block.get("_resolved_text"):
            continue
        btype = block.get("type", "")
        if btype == "text" and block.get("text"):
            if block["text"] != text:
                content_parts.append({"type": "text", "text": block["text"]})
        elif btype == "image":
            url = block.get("url") or block.get("preview_url") or ""
            if url:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": url, "detail": "auto"},
                })
            else:
                logger.warning("[BlockNormalizer] image block 缺少 url: %s", block)
        elif btype == "file":
            content_parts.append({"type": "text", "text": _wrap_attached_file(block, client_message_id)})
        elif btype == "doc_selection":
            content_parts.append({"type": "text", "text": _doc_selection_to_text(block)})
        elif btype == "table_selection":
            content_parts.append({"type": "text", "text": _table_selection_to_text(block)})
        elif btype == "code_file":
            content_parts.append({"type": "text", "text": _code_file_to_text(block)})
        elif btype == "code_selection":
            content_parts.append({"type": "text", "text": _code_selection_to_text(block)})
        elif btype == "web_selection":
            content_parts.append({"type": "text", "text": _web_selection_to_text(block)})
        elif btype == "web_annotation":
            content_parts.append({"type": "text", "text": _web_annotation_to_text(block)})

    # plain_text 作为 fallback
    plain_text = text or "(用户发送了图片)"
    return plain_text, content_parts


def _wrap_attached_file(block: Dict[str, Any], client_message_id: Optional[str]) -> str:
    """阶段 6 议题 2：用 user_context_wrapper SSoT 包裹 file block 的文本表示。

    旧实现把 ``[文档: foo]\\n<body>`` 字面字符串直接写入 user message，跨轮重放
    时 Agent 看到的还是当时的快照——但文档可能早被改了。新形态：

      ``<context type="attached" filename="foo.pdf" stale_after_turn="<uuid>">``
      ``[文档: foo]\\n<body>``
      ``</context>``

    history 装填阶段 ``select-recent-history.ts`` 检测到 ``stale_after_turn`` 不等于
    当前轮 id → 把 body 替换为 ``[此轮曾引用文档 foo.pdf（数据可能已变）]`` 指针。

    内层 ``[文档: foo]`` / ``[附件: foo]`` 历史前缀**保留**——LLM 既看 wrapper 也
    看 inner header，跨轮替换时把 inner body 全替换掉、只留 filename 指针。
    """
    from apps.services.agent_execution.user_context_wrapper import build_user_context_wrapper
    body = _file_block_to_text(block)
    filename = block.get("filename") or block.get("file_name") or "附件"
    attrs: Dict[str, Optional[str]] = {"filename": str(filename)}
    if client_message_id:
        attrs["stale_after_turn"] = client_message_id
    return build_user_context_wrapper(type="attached", body=body, attrs=attrs)


def has_vision_content(blocks: Optional[List[Dict[str, Any]]]) -> bool:
    """判断 blocks 中是否包含需要 vision 模型的内容"""
    if not blocks:
        return False
    return any(b.get("type") == "image" for b in blocks)


# ---------- 内部辅助 ----------

def _file_block_to_text(block: Dict[str, Any]) -> str:
    file_id = block.get("file_id") or block.get("id")
    if file_id:
        try:
            from apps.services.docparse.service import DocParseService
            summary = DocParseService.get_summary(file_id, max_tokens=2000)
            if summary:
                filename = block.get("filename", "文档")
                return f"[文档: {filename}]\n{summary}"

            from apps.services.docparse.models import ParsedDocument
            doc = ParsedDocument.objects.filter(file_record_id=file_id).first()
            filename = block.get("filename", "文档")
            if doc:
                if doc.status == ParsedDocument.Status.PARSING:
                    if doc.total_pages and doc.parsed_pages:
                        progress = f"({doc.parsed_pages}/{doc.total_pages}页)"
                    elif doc.parsed_pages:
                        progress = f"(已完成{doc.parsed_pages}页)"
                    else:
                        progress = ""
                    return (
                        f"[文档: {filename} — 正在解析中{progress}，内容将在解析完成后可用。"
                        f"你可以使用 parse_document 工具稍后重新读取此文档]"
                    )
                if doc.status == ParsedDocument.Status.FAILED:
                    return f"[文档: {filename} — 解析失败: {doc.error_message[:200] if doc.error_message else '未知错误'}]"
            else:
                mime = block.get("mime_type", "")
                if mime:
                    try:
                        from apps.services.docparse.parsers.registry import get_parser_for_mime
                        if get_parser_for_mime(mime):
                            return (
                                f"[文档: {filename} — 正在解析中，内容将在解析完成后可用。"
                                f"你可以使用 parse_document 工具稍后重新读取此文档]"
                            )
                    except Exception:
                        pass
        except Exception as exc:
            logger.debug("[BlockNormalizer] DocParse 提取失败，回退元数据: %s", exc)

    filename = block.get("filename", "未知文件")
    mime = block.get("mime_type", "")
    size = block.get("size", 0)
    url = block.get("url", "")
    parts = [f"[附件: {filename}]"]
    if mime:
        parts.append(f"类型: {mime}")
    if size:
        parts.append(f"大小: {_human_size(size)}")
    if url:
        parts.append(f"URL: {url}")
    return " | ".join(parts)


def _doc_selection_to_text(block: Dict[str, Any]) -> str:
    doc_id = block.get("doc_id", "")
    full_text = block.get("full_text", "")
    preview = block.get("preview", "")
    selection_text = full_text if isinstance(full_text, str) and full_text.strip() else preview
    result = f"[文档选区 doc_id={doc_id}]"
    if selection_text:
        result += f"\n{selection_text}"
    return result


def _table_selection_to_text(block: Dict[str, Any]) -> str:
    table_id = block.get("table_id", "")
    record_ids = block.get("record_ids", [])
    field_ids = block.get("field_ids", [])
    preview = block.get("preview", "")
    result = f"[表格选区 table_id={table_id}, records={len(record_ids)}, fields={len(field_ids)}]"
    if preview:
        result += f"\n{preview}"
    return result


def _code_file_to_text(block: Dict[str, Any]) -> str:
    file_path = block.get("file_path", "未知文件")
    language = block.get("language", "")
    preview = block.get("preview", "")
    header = f"[代码文件: {file_path}]"
    if language:
        header += f" ({language})"
    if preview:
        return f"{header}\n{preview}"
    return header


def _code_selection_to_text(block: Dict[str, Any]) -> str:
    file_path = block.get("file_path", "未知文件")
    start_line = block.get("start_line", "?")
    end_line = block.get("end_line", "?")
    language = block.get("language", "")
    preview = block.get("preview", "")
    header = f"[代码选区: {file_path} L{start_line}-L{end_line}]"
    if language:
        header += f" ({language})"
    if preview:
        return f"{header}\n{preview}"
    return header


def _web_selection_to_text(block: Dict[str, Any]) -> str:
    page_title = block.get("page_title", "未知页面")
    url = block.get("url", "")
    preview = block.get("preview", "")
    header = f"[网页选区: {page_title}]"
    if url:
        header += f" ({url})"
    if preview:
        return f"{header}\n{preview}"
    return header


def _web_annotation_to_text(block: Dict[str, Any]) -> str:
    page_title = block.get("page_title", "未知页面")
    url = block.get("url", "")
    preview = block.get("preview", "")
    selection = block.get("selection") if isinstance(block.get("selection"), dict) else {}
    dom = block.get("dom") if isinstance(block.get("dom"), dict) else {}
    screenshot_filename = block.get("screenshot_filename", "")

    header = f"[网页注释: {page_title}]"
    if url:
        header += f" ({url})"

    parts = [header]
    selected_text = selection.get("text") if isinstance(selection, dict) else ""
    if selected_text or preview:
        parts.append(f"选中文本:\n{selected_text or preview}")
    # ：注释落点内容快照（框选时已在原页面采集、穿透 shadow DOM）
    content_snapshot = block.get("content_snapshot") if isinstance(block.get("content_snapshot"), dict) else {}
    snapshot_text = content_snapshot.get("text", "")
    if snapshot_text:
        snapshot_part = f"内容快照（注释创建时已在原页面采集，可直接使用，无需再打开浏览器）:\n{snapshot_text}"
        if content_snapshot.get("truncated"):
            snapshot_part += "\n（快照超长已截断；需要更多内容时再用浏览器工具打开来源页面）"
        parts.append(snapshot_part)
    if dom:
        dom_lines = []
        for key in ("tag", "role", "selector", "xpath"):
            value = dom.get(key)
            if value:
                dom_lines.append(f"{key}: {value}")
        if dom_lines:
            parts.append("DOM 命中:\n" + "\n".join(dom_lines))
    if screenshot_filename:
        parts.append(f"截图附件: {screenshot_filename}")
    return "\n\n".join(parts)


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"

"""将飞书文档中的画板流程图降级为聊天区 Flow View。"""

from __future__ import annotations

from collections import defaultdict
import logging
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx

from .client import FeishuAPIError
from .constants import RESOURCE_KIND_DOCX
from .url_resolve import parse_feishu_resource_url

WHITEBOARD_BLOCK_TYPE = 43
MAX_FLOW_VIEW_NODES = 100
_BACKTICK_RUN_RE = re.compile(r"`+")
_WHITEBOARD_FETCH_RETRY_DELAYS = (0.25, 0.5)
_TRANSIENT_WHITEBOARD_ERROR_CODES = {2890006, 99991400}

logger = logging.getLogger(__name__)


class FeishuFlowParseError(ValueError):
    """输入资源不是可解析的飞书 Docx 画板流程图。"""


def extract_whiteboard_tokens(blocks: Iterable[Dict[str, Any]]) -> List[str]:
    """从不同版本的 Docx board block 中提取画板 token。"""
    tokens: List[str] = []
    seen = set()
    for block in blocks:
        if not isinstance(block, dict) or block.get("block_type") != WHITEBOARD_BLOCK_TYPE:
            continue
        candidates = []
        for key in ("board", "whiteboard"):
            payload = block.get(key)
            if isinstance(payload, dict):
                candidates.extend(
                    payload.get(name) for name in ("token", "whiteboard_id")
                )
        for raw_token in candidates:
            token = str(raw_token or "").strip()
            if token and token not in seen:
                seen.add(token)
                tokens.append(token)
    return tokens


def _node_id(node: Dict[str, Any]) -> str:
    return str(node.get("id") or node.get("node_id") or "").strip()


def _node_label(node: Dict[str, Any]) -> str:
    text = node.get("text")
    if isinstance(text, dict):
        label = str(text.get("text") or text.get("content") or "").strip()
        if label:
            return label
    for container_name in ("section", "table"):
        container = node.get(container_name)
        if isinstance(container, dict):
            label = str(container.get("title") or "").strip()
            if label:
                return label
    return str(node.get("name") or "").strip()


def _position_key(node: Dict[str, Any]) -> Tuple[float, float, float, str]:
    def number(value: Any) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    return (
        number(node.get("y")),
        number(node.get("x")),
        number(node.get("z_index")),
        _node_id(node),
    )


def _attached_id(endpoint: Any) -> str:
    if not isinstance(endpoint, dict):
        return ""
    attached = endpoint.get("attached_object") or endpoint.get("object")
    if isinstance(attached, dict):
        return str(attached.get("id") or attached.get("node_id") or "").strip()
    return str(endpoint.get("id") or "").strip()


def _connector_edge(node: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    connector = node.get("connector")
    if not isinstance(connector, dict):
        return None
    start = connector.get("start") or connector.get("start_object")
    end = connector.get("end") or connector.get("end_object")
    start_id = _attached_id(start)
    end_id = _attached_id(end)
    if not start_id or not end_id or start_id == end_id:
        return None

    start_arrow = str((start or {}).get("arrow_style") or "none").lower()
    end_arrow = str((end or {}).get("arrow_style") or "none").lower()
    if start_arrow not in ("", "none") and end_arrow in ("", "none"):
        return end_id, start_id
    return start_id, end_id


def _native_parent_id(node: Dict[str, Any]) -> str:
    """读取飞书思维导图和普通容器节点自带的父子关系。"""
    for key in ("mind_map_node", "mind_map"):
        payload = node.get(key)
        if isinstance(payload, dict):
            parent_id = str(payload.get("parent_id") or "").strip()
            if parent_id:
                return parent_id
    return str(node.get("parent_id") or "").strip()


def _is_transient_whiteboard_error(exc: FeishuAPIError) -> bool:
    status_code = exc.status_code or 0
    return (
        status_code == 429
        or status_code >= 500
        or exc.code in _TRANSIENT_WHITEBOARD_ERROR_CODES
    )


def _list_whiteboard_nodes_with_retry(
    client: Any,
    access_token: str,
    whiteboard_token: str,
) -> List[Dict[str, Any]]:
    """重试限流、服务端和网络瞬时错误；权限类错误交给上层降级。"""
    attempts = len(_WHITEBOARD_FETCH_RETRY_DELAYS) + 1
    for attempt in range(attempts):
        try:
            return client.list_whiteboard_nodes(access_token, whiteboard_token)
        except FeishuAPIError as exc:
            if not _is_transient_whiteboard_error(exc) or attempt == attempts - 1:
                raise
        except httpx.TransportError:
            if attempt == attempts - 1:
                raise
        time.sleep(_WHITEBOARD_FETCH_RETRY_DELAYS[attempt])
    return []


def build_flow_view_from_whiteboard_nodes(
    raw_nodes: Iterable[Dict[str, Any]],
    *,
    source_title: str = "",
) -> Dict[str, Any]:
    """把画板有向图确定性地降级为供 TabDoc 静态文本树使用的层级节点。"""
    raw = [item for item in raw_nodes if isinstance(item, dict)]
    shapes: Dict[str, Dict[str, Any]] = {}
    ignored = 0
    for item in raw:
        if item.get("type") == "connector" or isinstance(item.get("connector"), dict):
            continue
        identifier = _node_id(item)
        label = _node_label(item)
        if identifier and label:
            shapes[identifier] = item
        elif identifier:
            ignored += 1

    if not shapes:
        raise FeishuFlowParseError("画板中没有可展示的文字流程节点")

    outgoing: Dict[str, List[str]] = defaultdict(list)
    indegree = {identifier: 0 for identifier in shapes}
    invalid_edges = 0
    for item in raw:
        edge = _connector_edge(item)
        if edge is None:
            continue
        parent_id, child_id = edge
        if parent_id not in shapes or child_id not in shapes:
            invalid_edges += 1
            continue
        if child_id not in outgoing[parent_id]:
            outgoing[parent_id].append(child_id)
            indegree[child_id] += 1

    # 飞书思维导图可只通过节点 parent_id 表达层级而没有 connector。
    # 若两者冲突，以用户可见的显式连线为准。
    connector_children = {
        child_id for child_ids in outgoing.values() for child_id in child_ids
    }
    for child_id, item in shapes.items():
        if child_id in connector_children:
            continue
        parent_id = _native_parent_id(item)
        if parent_id not in shapes or parent_id == child_id:
            continue
        outgoing[parent_id].append(child_id)
        indegree[child_id] += 1

    for parent_id in outgoing:
        outgoing[parent_id].sort(key=lambda identifier: _position_key(shapes[identifier]))

    ordered_ids: List[str] = []
    parents: Dict[str, str] = {}
    discovered = set()
    dropped_edges = 0

    def visit(identifier: str, parent_id: Optional[str] = None) -> None:
        nonlocal dropped_edges
        if identifier in discovered:
            if parent_id is not None:
                dropped_edges += 1
            return
        discovered.add(identifier)
        if parent_id is not None:
            parents[identifier] = parent_id
        stack = [identifier]
        while stack:
            current_id = stack.pop()
            ordered_ids.append(current_id)
            for child_id in reversed(outgoing.get(current_id, [])):
                if child_id in discovered:
                    dropped_edges += 1
                    continue
                discovered.add(child_id)
                parents[child_id] = current_id
                stack.append(child_id)

    roots = sorted(
        (identifier for identifier, degree in indegree.items() if degree == 0),
        key=lambda identifier: _position_key(shapes[identifier]),
    )
    for root_id in roots:
        visit(root_id)
    for identifier in sorted(shapes, key=lambda item: _position_key(shapes[item])):
        if identifier not in discovered:
            visit(identifier)

    warnings: List[str] = []
    if ignored:
        warnings.append(f"已忽略 {ignored} 个没有文字的画板节点")
    if invalid_edges:
        warnings.append(f"已忽略 {invalid_edges} 条无法连接到文字节点的连线")
    if dropped_edges:
        warnings.append(f"已将 {dropped_edges} 条重复父级或环形连线降级为单一层级")
    if len(ordered_ids) > MAX_FLOW_VIEW_NODES:
        warnings.append(
            f"画板包含 {len(ordered_ids)} 个流程节点，当前仅展示前 {MAX_FLOW_VIEW_NODES} 个"
        )
        ordered_ids = ordered_ids[:MAX_FLOW_VIEW_NODES]

    nodes: List[Dict[str, str]] = []
    visible = set(ordered_ids)
    for identifier in ordered_ids:
        node: Dict[str, str] = {
            "id": identifier,
            "label": _node_label(shapes[identifier]),
            "status": "pending",
        }
        parent_id = parents.get(identifier)
        if parent_id in visible:
            node["parent_id"] = parent_id
        nodes.append(node)

    root_ids = [identifier for identifier in ordered_ids if identifier not in parents]
    title = (
        _node_label(shapes[root_ids[0]])
        if len(root_ids) == 1
        else (source_title.strip() or "飞书流程图")
    )
    return {
        "title": title,
        "summary": f"从飞书画板“{source_title.strip() or title}”解析出 {len(nodes)} 个流程节点。",
        "nodes": nodes,
        "warnings": warnings,
    }


def render_flow_view_markdown(flow: Dict[str, Any]) -> str:
    """将 Flow View 降级为 TabDoc 可稳定展示的等宽文本树。"""

    def safe_text(value: Any, fallback: str) -> str:
        return " ".join(str(value or "").split()).strip() or fallback

    title = safe_text(flow.get("title"), "飞书流程图")
    nodes = [node for node in (flow.get("nodes") or []) if isinstance(node, dict)]
    identifiers: List[str] = []
    labels: Dict[str, str] = {}
    parent_ids: Dict[str, str] = {}
    for index, node in enumerate(nodes):
        identifier = str(node.get("id") or f"__flow_node_{index}").strip()
        if identifier in labels:
            identifier = f"{identifier}_{index}"
        identifiers.append(identifier)
        labels[identifier] = safe_text(node.get("label"), "未命名步骤")
        parent_ids[identifier] = str(node.get("parent_id") or "").strip()

    known = set(identifiers)
    children: Dict[str, List[str]] = defaultdict(list)
    roots: List[str] = []
    for identifier in identifiers:
        parent_id = parent_ids[identifier]
        if parent_id and parent_id in known and parent_id != identifier:
            children[parent_id].append(identifier)
        else:
            roots.append(identifier)

    tree_lines: List[str] = []

    def append_node(identifier: str, prefix: str, connector: str) -> None:
        tree_lines.append(f"{prefix}{connector}{labels[identifier]}")
        if not connector:
            child_prefix = prefix
        else:
            child_prefix = prefix + ("   " if connector == "└─ " else "│  ")
        child_ids = children.get(identifier, [])
        for index, child_id in enumerate(child_ids):
            child_connector = "└─ " if index == len(child_ids) - 1 else "├─ "
            append_node(child_id, child_prefix, child_connector)

    for index, root_id in enumerate(roots):
        if len(roots) == 1:
            root_connector = ""
        else:
            root_connector = "└─ " if index == len(roots) - 1 else "├─ "
        append_node(root_id, "", root_connector)

    tree_text = "\n".join(tree_lines) or "未解析到可展示的流程节点"
    longest_backticks = max(
        (len(run) for run in _BACKTICK_RUN_RE.findall(tree_text)),
        default=0,
    )
    fence = "`" * max(3, longest_backticks + 1)
    return (
        f"## 流程图：{title}\n\n"
        f"{fence}text\n{tree_text}\n{fence}"
    )


def enrich_markdown_with_whiteboard_flows(
    markdown: str,
    *,
    blocks: Iterable[Dict[str, Any]],
    client: Any,
    access_token: str,
    source_title: str,
    issues: List[str],
) -> str:
    """把 Docx 画板追加为静态流程关系；单个画板失败不拖垮整篇导入。"""
    sections: List[str] = []
    for whiteboard_token in extract_whiteboard_tokens(blocks):
        try:
            raw_nodes = _list_whiteboard_nodes_with_retry(
                client,
                access_token,
                whiteboard_token,
            )
            flow = build_flow_view_from_whiteboard_nodes(
                raw_nodes,
                source_title=source_title,
            )
            sections.append(render_flow_view_markdown(flow))
            for warning in flow.get("warnings") or []:
                message = f"文档「{source_title}」流程图静态展示提示：{warning}"
                if message not in issues:
                    issues.append(message)
        except FeishuAPIError as exc:
            if _is_transient_whiteboard_error(exc):
                raise
            message = f"文档「{source_title}」流程图读取失败：{exc}"
            if message not in issues:
                issues.append(message)
        except httpx.TransportError:
            raise
        except FeishuFlowParseError as exc:
            message = f"文档「{source_title}」流程图读取失败：{exc}"
            if message not in issues:
                issues.append(message)
        except Exception as exc:
            logger.exception(
                "[FeishuFlowView] unexpected parse error title=%s whiteboard_token=%s",
                source_title,
                whiteboard_token,
            )
            message = f"文档「{source_title}」流程图解析失败：{exc}"
            if message not in issues:
                issues.append(message)

    parts = [part.strip() for part in [markdown, *sections] if part and part.strip()]
    return "\n\n".join(parts)


def parse_feishu_flow(
    client: Any,
    access_token: str,
    url: str,
) -> Dict[str, Any]:
    """解析 Wiki/Docx 链接中的首个画板，并返回 Flow View 数据。"""
    parsed = parse_feishu_resource_url(url)
    kind = parsed.get("kind")
    token = str(parsed.get("token") or "").strip()
    if parsed.get("error") or kind not in ("wiki", RESOURCE_KIND_DOCX) or not token:
        raise FeishuFlowParseError(
            str(parsed.get("error") or "仅支持飞书 Wiki 或 Docx 链接")
        )

    title = ""
    document_token = token
    if kind == "wiki":
        wiki_node = client.get_wiki_node(access_token, token)
        if not wiki_node or not wiki_node.get("selectable"):
            raise FeishuFlowParseError("无法读取该飞书 Wiki 节点")
        if wiki_node.get("import_kind") != RESOURCE_KIND_DOCX:
            raise FeishuFlowParseError("该飞书 Wiki 节点不是 Docx 文档")
        document_token = str(wiki_node.get("token") or "").strip()
        title = str(wiki_node.get("name") or "").strip()
    else:
        try:
            title = str(client.get_drive_file_name(access_token, token) or "").strip()
        except (AttributeError, FeishuAPIError):
            title = ""

    if not document_token:
        raise FeishuFlowParseError("飞书文档缺少可读取的 document token")
    blocks = client.list_docx_blocks(access_token, document_token)
    whiteboard_tokens = extract_whiteboard_tokens(blocks)
    if not whiteboard_tokens:
        raise FeishuFlowParseError("该飞书文档中没有画板流程图")

    raw_nodes = _list_whiteboard_nodes_with_retry(
        client,
        access_token,
        whiteboard_tokens[0],
    )
    result = build_flow_view_from_whiteboard_nodes(raw_nodes, source_title=title)
    if len(whiteboard_tokens) > 1:
        result["warnings"].append(
            f"文档包含 {len(whiteboard_tokens)} 个画板，当前展示第一个画板"
        )
    result["source"] = {
        "type": "feishu_whiteboard",
        "url": url,
        "document_token": document_token,
        "whiteboard_tokens": whiteboard_tokens,
    }
    return result

"""Project Task 执行结果候选的采集与发布辅助。"""

from __future__ import annotations

import re
from typing import Any, Iterable
from urllib.parse import unquote

from django.db.models import Q

from apps.tabtinspace.models import ContextItem, ProjectTaskRun, Workspace


_RESOURCE_TYPE_ALIASES = {
    'doc': 'tabdoc',
    'document': 'tabdoc',
    'table': 'tabdata',
    'file': 'tabfiles',
    'image': 'tabfiles',
}

# 对齐 Electron extractResourceLinkArtifacts：CLI 建文档后常见 markdown / 裸链。
_BARE_RESOURCE_URI_RE = re.compile(r'tabtin://resource/[^\s)\]"\'`]+')
_FENCED_CODE_RE = re.compile(r'```[\s\S]*?(?:```|$)')
_INLINE_CODE_RE = re.compile(r'`[^`\n]*`')
_TRAILING_URI_PUNCT_RE = re.compile(r'[.,;:!?。，、；：！？…]+$', re.UNICODE)
_SELF_FORMAT_TYPE_ALIASES = {'doc': 'document'}


def _normalize_resource_type(value: str) -> str:
    normalized = value.strip().lower()
    return _RESOURCE_TYPE_ALIASES.get(normalized, normalized)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _candidate_pointer(block: dict[str, Any]) -> tuple[str, str] | None:
    payload = _as_dict(block.get('payload'))
    kind = str(block.get('kind') or payload.get('kind') or '').strip().lower()
    resource_type = str(
        payload.get('resource_type') or block.get('resource_type') or ''
    ).strip().lower()
    resource_id = str(
        payload.get('resource_id') or block.get('resource_id') or ''
    ).strip()

    if kind == 'resource_ref' and resource_type and resource_id:
        return (_RESOURCE_TYPE_ALIASES.get(resource_type, resource_type), resource_id)

    artifact_kind = str(
        payload.get('artifact_kind') or block.get('artifact_kind') or ''
    ).strip().lower()
    if artifact_kind == 'oss_file':
        file_id = str(payload.get('file_id') or block.get('file_id') or '').strip()
        if file_id:
            return ('tabfiles', file_id)
    return None


def _is_truncated_resource_id(resource_type: str, resource_id: str) -> bool:
    if '\u2026' in resource_id:
        return True
    return resource_type != 'file' and '...' in resource_id


def _strip_code_segments(text: str) -> str:
    return _INLINE_CODE_RE.sub(' ', _FENCED_CODE_RE.sub(' ', text))


def iter_resource_pointers_from_text(text: Any) -> Iterable[tuple[str, str]]:
    """从正文 / 工具输出抽取 tabtin://resource/<type>/<id>（对齐 Electron）。"""
    if not isinstance(text, str) or 'tabtin://resource/' not in text:
        return
    cleaned = _strip_code_segments(text)
    if 'tabtin://resource/' not in cleaned:
        return
    for match in _BARE_RESOURCE_URI_RE.finditer(cleaned):
        href = _TRAILING_URI_PUNCT_RE.sub('', match.group(0))
        if not href.startswith('tabtin://resource/'):
            continue
        rest = href[len('tabtin://resource/'):]
        path = rest.split('?', 1)[0]
        parts = path.split('/', 1)
        if len(parts) != 2:
            continue
        raw_type = parts[0].strip().lower()
        resource_id = unquote(parts[1]).strip()
        if not raw_type or not resource_id:
            continue
        raw_type = _SELF_FORMAT_TYPE_ALIASES.get(raw_type, raw_type)
        if _is_truncated_resource_id(raw_type, resource_id):
            continue
        yield (_normalize_resource_type(raw_type), resource_id)


def _json_loads_maybe(value: Any) -> Any | None:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or text[0] not in '{[':
        return None
    try:
        import json
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def iter_resource_pointers_from_cli_json(text: Any) -> Iterable[tuple[str, str]]:
    """从 `tabtin doc create --format json` 等 CLI stdout 抽取 document/table id。"""
    root = _json_loads_maybe(text)
    if root is None:
        return

    seen: set[tuple[str, str]] = set()

    def emit(resource_type: str, resource_id: Any) -> None:
        rid = str(resource_id or '').strip()
        if not rid or _is_truncated_resource_id(resource_type, rid):
            return
        pointer = (_normalize_resource_type(resource_type), rid)
        if pointer in seen:
            return
        seen.add(pointer)

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            stdout = node.get('stdout')
            nested = _json_loads_maybe(stdout)
            if nested is not None:
                walk(nested)

            data = node.get('data')
            if isinstance(data, dict):
                for key, resource_type in (
                    ('document', 'tabdoc'),
                    ('table', 'tabdata'),
                    ('doc', 'tabdoc'),
                ):
                    obj = data.get(key)
                    if isinstance(obj, dict) and obj.get('id'):
                        emit(resource_type, obj.get('id'))
                item_type = str(
                    data.get('item_type')
                    or data.get('resource_type')
                    or data.get('type')
                    or ''
                ).strip()
                if data.get('id') and item_type:
                    normalized = _normalize_resource_type(item_type)
                    if normalized in {'tabdoc', 'tabdata'}:
                        emit(normalized, data.get('id'))

            for key, resource_type in (
                ('document', 'tabdoc'),
                ('table', 'tabdata'),
                ('doc', 'tabdoc'),
            ):
                obj = node.get(key)
                if isinstance(obj, dict) and obj.get('id'):
                    emit(resource_type, obj.get('id'))

            for value in node.values():
                if isinstance(value, (dict, list)):
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(root)
    yield from seen


def _text_chunks_from_block(block: dict[str, Any]) -> Iterable[str]:
    block_type = str(block.get('type') or '').strip().lower()
    if block_type == 'text':
        for key in ('text', 'content'):
            value = block.get(key)
            if isinstance(value, str) and value.strip():
                yield value
        return
    if block_type == 'tool_result':
        content = block.get('content')
        if isinstance(content, str) and content.strip():
            yield content
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, str) and item.strip():
                    yield item
                elif isinstance(item, dict):
                    text = item.get('text') or item.get('content')
                    if isinstance(text, str) and text.strip():
                        yield text
        return
    # 部分路径把 CLI stdout 塞进 tool_use 的结果镜像字段。
    for key in ('result', 'output', 'stdout'):
        value = block.get(key)
        if isinstance(value, str) and 'tabtin://resource/' in value:
            yield value


def iter_resource_pointers(blocks: Any) -> Iterable[tuple[str, str]]:
    if not isinstance(blocks, list):
        return
    for raw_block in blocks:
        if not isinstance(raw_block, dict):
            continue
        pointer = _candidate_pointer(raw_block)
        if pointer:
            yield pointer
        for chunk in _text_chunks_from_block(raw_block):
            yield from iter_resource_pointers_from_text(chunk)
            yield from iter_resource_pointers_from_cli_json(chunk)


def execution_source_item_q(run: ProjectTaskRun) -> Q:
    """执行结果源 ContextItem：伴生 Workspace，或同组织的 org-only 云资产。"""
    host_q = Q(workspace_id=run.workspace_id)
    organization_id = (
        Workspace.objects.filter(id=run.workspace_id)
        .values_list('organization_id', flat=True)
        .first()
    )
    if organization_id:
        host_q |= Q(
            workspace__isnull=True,
            project__isnull=True,
            organization_id=organization_id,
        )
    return host_q


def collect_run_result_items(
    run: ProjectTaskRun,
    *,
    assistant_messages=None,
) -> list[dict[str, Any]]:
    """采集 Agent 明确交付的云资源（伴生 Workspace 或同组织 org-only ContextItem）。"""

    if not run.chat_session_id:
        return []

    pointers: list[tuple[str, str]] = []
    seen_pointers: set[tuple[str, str]] = set()
    messages = assistant_messages
    if messages is None:
        messages = run.chat_session.messages.filter(role='assistant')
    messages = messages.only('content_blocks_json').order_by('created_at', 'id')
    for message in messages:
        for pointer in iter_resource_pointers(message.content_blocks_json):
            if pointer in seen_pointers:
                continue
            seen_pointers.add(pointer)
            pointers.append(pointer)

    if not pointers:
        return []

    resource_ids = [resource_id for _, resource_id in pointers]
    source_items_by_pointer: dict[tuple[str, str], list[ContextItem]] = {}
    for item in ContextItem.objects.filter(
        execution_source_item_q(run),
        resource_id__in=resource_ids,
        is_archived=False,
        trashed_at__isnull=True,
    ).order_by('-updated_at'):
        pointer = (_normalize_resource_type(item.item_type), str(item.resource_id))
        source_items_by_pointer.setdefault(pointer, []).append(item)

    candidates: list[dict[str, Any]] = []
    for resource_type, resource_id in pointers:
        matches = source_items_by_pointer.get(
            (_normalize_resource_type(resource_type), resource_id),
            [],
        )
        # 同类型同 ID 多条同样无法确定 Agent 指向哪一条，宁可不交付也不猜。
        if len(matches) != 1:
            continue
        source = matches[0]
        # org-only ContextItem 无 space_id；打开预览回退到本次执行 Workspace。
        resource_space_id = source.space_id or run.workspace_id
        candidates.append({
            'id': str(source.id),
            'context_item_id': str(source.id),
            'resource_type': resource_type,
            'resource_id': resource_id,
            'item_type': source.item_type,
            'title': source.title or '未命名交付物',
            'preview': (source.preview or '')[:2000],
            'resource_space_id': str(resource_space_id) if resource_space_id else '',
        })
    return candidates


normalize_resource_type = _normalize_resource_type

# 用户在任务工作台空白直建的候选；Agent 刷新 result_items 时不得抹掉。
USER_BLANK_ORIGIN = 'user_blank'


def _result_item_pointer(item: dict[str, Any]) -> tuple[str, str] | None:
    resource_type = str(item.get('resource_type') or item.get('item_type') or '').strip()
    resource_id = str(item.get('resource_id') or '').strip()
    if not resource_type or not resource_id:
        return None
    return _normalize_resource_type(resource_type), resource_id


def merge_result_items_preserving_user_blanks(
    existing: Any,
    collected: Any,
) -> list[dict[str, Any]]:
    """用 Agent 采集结果覆盖 run.result_items，但保留 origin=user_blank 的空白直建。

    collected 优先；同 (resource_type, resource_id) 已出现在 collected 中则不再追加 blank。
    failure 路径 collected=[] 时仍应从 existing 保留 blanks。
    """
    collected_list = [
        item for item in (collected or [])
        if isinstance(item, dict) and _result_item_pointer(item)
    ]
    seen: set[tuple[str, str]] = set()
    for item in collected_list:
        pointer = _result_item_pointer(item)
        if pointer:
            seen.add(pointer)

    preserved: list[dict[str, Any]] = []
    for item in (existing or []):
        if not isinstance(item, dict):
            continue
        if str(item.get('origin') or '') != USER_BLANK_ORIGIN:
            continue
        pointer = _result_item_pointer(item)
        if pointer is None or pointer in seen:
            continue
        seen.add(pointer)
        preserved.append(item)

    return collected_list + preserved


__all__ = [
    'USER_BLANK_ORIGIN',
    'collect_run_result_items',
    'execution_source_item_q',
    'iter_resource_pointers',
    'merge_result_items_preserving_user_blanks',
    'normalize_resource_type',
]

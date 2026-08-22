"""
ContextResolver — 上下文引用解析器

将前端传来的 context blocks（@提及表格/文档/字段、选区等）
解析为实际数据，构建 Agent 可用的上下文文本。

职责：
1. 根据 ref 类型查询实际数据（schema、采样记录、文档内容）
2. Token 预算分配（防止上下文过长）
3. 输出结构化的上下文文本，注入 Agent 输入
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Token 预算常量
MAX_CONTEXT_TOKENS = 4000  # 上下文引用的总 token 预算
MAX_TABLE_SCHEMA_TOKENS = 1500  # 单个表格 schema 预算
MAX_TABLE_RECORDS_TOKENS = 1000  # 表格采样记录预算
MAX_DOC_CONTENT_TOKENS = 2000  # 文档内容预算
MAX_FIELD_DETAIL_TOKENS = 500  # 字段详情预算

# 近似 token 计算（中英文混合约 1.5 字符 = 1 token）
CHARS_PER_TOKEN = 1.5


def estimate_tokens(text: str) -> int:
    """粗略估算 token 数"""
    return int(len(text) / CHARS_PER_TOKEN)


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    """截断文本到指定 token 预算"""
    max_chars = int(max_tokens * CHARS_PER_TOKEN)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... (内容已截断)"


def _user_can_view_table(user_id: str, table_id: str) -> bool:
    """复用 TabData 权限真源，禁止 context block 绕过资源级授权。"""
    from apps.tabdata.services.base import BaseService

    try:
        user = _get_context_user(user_id)
        if user is None:
            return False
        return BaseService(user=user).check_table_permission(
            str(table_id),
            required_role='viewer',
        )
    except Exception as exc:
        logger.warning(
            "[ContextResolver] 表格权限检查失败 user_id=%s table_id=%s error=%s",
            user_id,
            table_id,
            exc,
        )
        return False


def _get_context_user(user_id: str):
    from django.contrib.auth import get_user_model

    return get_user_model().objects.filter(id=user_id).first()


def _record_reader(user_id: str):
    """返回走原生列 + RLS 的记录服务与上下文。"""
    from apps.tabdata.services.record_service import RecordService
    from apps.tabdata.services.rls_service import RLSContext

    user = _get_context_user(user_id)
    if user is None:
        return None, None
    return RecordService(user=user), RLSContext(user_id=str(user.id))


def _filter_visible_fields(user_id: str, table_id: str, fields: list) -> list:
    """应用字段 visibility_roles，避免表格 viewer 读取隐藏列。

    复用 ``field_visibility`` 单一策略（含派生依赖闭包），消灭双真源。
    """
    from apps.tabdata.services.base import BaseService
    from apps.tabdata.services.field_visibility import (
        get_visible_fields,
        resolve_effective_table_role,
    )

    user = _get_context_user(user_id)
    if user is None:
        return []
    service = BaseService(user=user)
    if not service.check_table_permission(table_id, 'viewer'):
        return []
    role = resolve_effective_table_role(user, table_id)
    if role is None:
        return []
    return get_visible_fields(table_id, role, fields=fields)


def _table_permission_fallback(block: Dict[str, Any], label: str) -> str:
    """权限不足时只回显调用方已提交的指针，不读取任何表格数据。"""
    table_id = str(block.get('table_id') or '')
    preview = str(block.get('preview') or '')
    parts = [f"[{label}] {preview or table_id}".rstrip()]
    if table_id:
        parts.append(f"table_id: {table_id}")
    parts.append("当前用户无权读取该表格内容。")
    return "\n".join(parts)


def resolve_context_blocks(
    blocks: List[Dict[str, Any]],
    user_id: str,
    max_context_tokens: Optional[int] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    解析上下文引用块，返回:
        (context_text, resolved_blocks)
        - context_text: 完整的上下文文本（拼接所有引用的解析结果）
        - resolved_blocks: 附加了解析数据的 blocks（可选存回 DB）
        - max_context_tokens: 动态 token 预算（None 时使用 MAX_CONTEXT_TOKENS 默认值）
    """
    context_ref_types = {
        'table', 'table_selection', 'document', 'doc_selection', 'field',
        'code_file', 'code_selection', 'web_selection', 'web_annotation',
        'composer_preset',
        # ：已批准 plan 的执行引用（仅注入指针 + 执行前重读引导，不塞正文）
        'plan',
        # ─── 整个 tab 资源引用（轻量，仅注入元数据让 Agent 自主调工具）─────
        'webpage', 'memo', 'whiteboard',
        'phone_device', 'desktop_device', 'terminal_session',
        'slide', 'video', 'site', 'folder',
        'tracker', 'agenda_event',
        # ：云盘 / TabFiles 文件引用（关键 ID = file_id）
        'file',
    }
    ref_blocks = [b for b in blocks if b.get('type') in context_ref_types]

    if not ref_blocks:
        return '', blocks

    effective_budget = max_context_tokens or MAX_CONTEXT_TOKENS
    budget_per_ref = effective_budget // max(len(ref_blocks), 1)
    context_parts: List[str] = []
    resolved = list(blocks)  # 浅拷贝

    for block in ref_blocks:
        btype = block.get('type', '')
        try:
            if btype == 'table' or (btype == 'table_selection' and not block.get('record_ids')):
                # @表格名 — 注入 schema + 采样数据
                text = _resolve_table_ref(block, user_id, budget_per_ref)
            elif btype == 'table_selection':
                # 表格选区 — 注入选中记录数据
                text = _resolve_table_selection(block, user_id, budget_per_ref)
            elif btype == 'document' or btype == 'doc_selection':
                # @文档名 / 文档选区
                text = _resolve_doc_ref(block, user_id, budget_per_ref)
            elif btype == 'field':
                # @字段名
                text = _resolve_field_ref(block, user_id, budget_per_ref)
            elif btype == 'code_file':
                text = _resolve_code_file_ref(block, budget_per_ref)
            elif btype == 'code_selection':
                text = _resolve_code_selection_ref(block, budget_per_ref)
            elif btype == 'web_selection':
                text = _resolve_web_selection_ref(block, budget_per_ref)
            elif btype == 'web_annotation':
                text = _resolve_web_annotation_ref(block, budget_per_ref)
            elif btype == 'plan':
                text = _resolve_plan_ref(block, budget_per_ref)
            elif btype == 'composer_preset':
                text = _resolve_composer_preset_ref(block, budget_per_ref)
            elif btype in {
                'webpage', 'memo', 'whiteboard',
                'phone_device', 'desktop_device', 'terminal_session',
                'slide', 'video', 'site', 'folder',
                'tracker', 'agenda_event',
                'file',
            }:
                # 「添加到对话」轻量引用 — 仅渲染元数据，让 Agent 自主调工具读详情
                text = _resolve_tab_resource_ref(block, budget_per_ref)
            else:
                text = block.get('preview', '')

            if text:
                context_parts.append(text)
                # 将解析结果写回 block
                block['_resolved_text'] = text
        except Exception as e:
            logger.warning("[ContextResolver] 解析引用失败 type=%s: %s", btype, e)
            preview = block.get('preview', '')
            if preview:
                fallback = f"[{btype} 引用] {preview}"
                context_parts.append(fallback)
                block['_resolved_text'] = fallback

    context_text = "\n\n---\n\n".join(context_parts) if context_parts else ''
    return context_text, resolved


def _table_ref_machine_header(block: Dict[str, Any], table_name: str, *, selection: bool = False) -> List[str]:
    """表格引用头部：机器可读 table_id + 跨 Space 提示，供 Agent 直读全量。

    云端表格按 table_id 全局可查，不绑执行 Space；但 Agent 的 table list
    工具默认只列当前执行 Space。必须把 table_id 写进 prompt，否则 Agent
    无法用 tabtin_table_query 逃逸 workspace 作用域。
    """
    table_id = block.get('table_id', '')
    space_id = block.get('space_id', '')
    space_name = block.get('space_name', '')
    title = f"## 表格选区: {table_name}" if selection else f"## 表格: {table_name}"
    parts = [title]
    if table_id:
        parts.append(f"table_id: {table_id}")
        parts.append(
            "引用解析已按当前用户权限注入可见数据；"
            "不要只依赖当前执行 Space 的 table list。"
        )
    if space_id or space_name:
        space_label = space_name or str(space_id)
        parts.append(
            f"此表属于 Space「{space_label}」"
            f"{f' (space_id={space_id})' if space_id else ''}，"
            "可能不在当前执行 Space 的表列表中，请按 table_id 直读。"
        )
    return parts


def _resolve_table_ref(block: Dict[str, Any], user_id: str, budget: int) -> str:
    """
    解析表格引用：查询 schema + 采样记录
    """
    table_id = block.get('table_id', '')
    if not table_id:
        return block.get('preview', '')

    if not _user_can_view_table(user_id, table_id):
        logger.warning(
            "[ContextResolver] 表格引用权限不足 user_id=%s table_id=%s",
            user_id,
            table_id,
        )
        return _table_permission_fallback(block, "表格引用")

    parts = []

    try:
        # 查询 schema（模型已收敛为 Table / TableField / TableRecord）
        from apps.tabdata.models import Table, TableField
        table = Table.objects.filter(id=table_id).first()
        if not table:
            return f"[表格引用: 表格 {table_id} 未找到]"

        parts.extend(_table_ref_machine_header(block, table.name, selection=False))
        if table.description:
            parts.append(f"描述: {table.description}")

        # 获取字段列表
        fields = list(TableField.objects.filter(table_id=table_id, is_deleted=False).order_by('order'))
        fields = _filter_visible_fields(user_id, table_id, fields)
        if fields:
            field_lines = []
            for f in fields[:30]:  # 最多30个字段
                field_info = f"- {f.name} ({f.field_type})"
                if f.description:
                    field_info += f" — {f.description}"
                field_lines.append(field_info)
            parts.append("### 字段 Schema:")
            parts.append("\n".join(field_lines))

        # 采样记录
        sample_text = _get_sample_records(
            table_id,
            fields[:10],
            user_id=user_id,
            max_rows=5,
        )
        if sample_text:
            parts.append("### 采样数据:")
            parts.append(sample_text)

    except Exception as e:
        logger.warning("[ContextResolver] 查询表格数据失败 table_id=%s: %s", table_id, e)
        preview = block.get('preview', '')
        # 失败时仍保留 table_id，避免 Agent 彻底失联
        fallback_parts = [f"[表格引用] {preview or table_id}", f"table_id: {table_id}"]
        space_name = block.get('space_name', '')
        if space_name:
            fallback_parts.append(f"space: {space_name}")
        fallback_parts.append("表格数据解析失败，请重试。")
        return "\n".join(fallback_parts)

    text = "\n\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_table_selection(block: Dict[str, Any], user_id: str, budget: int) -> str:
    """
    解析表格选区：查询选中记录的实际数据
    """
    table_id = block.get('table_id', '')
    record_ids = block.get('record_ids', [])
    field_ids = block.get('field_ids', [])
    preview = block.get('preview', '')

    if not table_id:
        return f"[表格选区] {preview}" if preview else ''

    if not _user_can_view_table(user_id, table_id):
        logger.warning(
            "[ContextResolver] 表格选区权限不足 user_id=%s table_id=%s",
            user_id,
            table_id,
        )
        return _table_permission_fallback(block, "表格选区")

    try:
        from apps.tabdata.models import Table, TableField
        table = Table.objects.filter(id=table_id).first()
        if not table:
            return f"[表格选区: 表格 {table_id} 未找到]"

        parts = _table_ref_machine_header(block, table.name, selection=True)

        # 获取字段
        if field_ids:
            fields = list(TableField.objects.filter(id__in=field_ids, table_id=table_id, is_deleted=False))
        else:
            fields = list(
                TableField.objects.filter(table_id=table_id, is_deleted=False).order_by('order')[:10]
            )
        fields = _filter_visible_fields(user_id, table_id, fields)

        field_names = {str(f.id): f.name for f in fields}

        # 通过 RecordService 读取原生列并应用强制 RLS，禁止 ORM/JSON 旁路。
        if record_ids:
            reader, rls_context = _record_reader(user_id)
            visible_rows = []
            if reader is not None:
                for record_id in record_ids[:20]:
                    payload = reader.get_record_data(
                        record_id,
                        field_key_type='id',
                        rls_context=rls_context,
                    )
                    if payload:
                        visible_rows.append(payload.get('fields') or {})
            if visible_rows:
                parts.append(f"选中 {len(visible_rows)} 条记录:")
                for data in visible_rows:
                    row_parts = []
                    for fid, fname in field_names.items():
                        val = data.get(fid, '')
                        if val is not None and val != '':
                            row_parts.append(f"{fname}: {val}")
                    if row_parts:
                        parts.append("- " + " | ".join(row_parts))
        elif preview:
            parts.append(preview)

    except Exception as e:
        logger.warning("[ContextResolver] 查询选区数据失败: %s", e)
        fallback = f"[表格选区] {preview}" if preview else f"[表格选区] {table_id}"
        return (
            f"{fallback}\ntable_id: {table_id}\n"
            "表格数据解析失败，请重试。"
        )

    text = "\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_doc_ref(block: Dict[str, Any], user_id: str, budget: int) -> str:
    """
    解析文档引用/选区
    """
    doc_id = block.get('doc_id', '')
    preview = block.get('preview', '')
    full_text = block.get('full_text', '')
    selection_text = full_text if isinstance(full_text, str) and full_text.strip() else preview

    if not doc_id and selection_text:
        return f"[文档引用]\n{selection_text}"

    try:
        from apps.tabdoc.models import Document
        doc = Document.objects.filter(id=doc_id).first()
        if not doc:
            return f"[文档引用: 文档 {doc_id} 未找到]" if not selection_text else f"[文档引用]\n{selection_text}"

        parts = [f"## 文档: {doc.title}"]

        # 文档选区：优先使用完整选区文本，fallback 到 preview。
        if block.get('type') == 'doc_selection' and selection_text:
            parts.append("### 选中内容:")
            parts.append(selection_text)
        else:
            # @文档名：注入文档全文（截断）
            content = ''
            if hasattr(doc, 'description_plaintext') and doc.description_plaintext:
                content = doc.description_plaintext
            elif hasattr(doc, 'description') and doc.description:
                content = doc.description

            if content:
                parts.append("### 文档内容:")
                parts.append(truncate_to_tokens(content, budget - 200))
            elif selection_text:
                parts.append(selection_text)

    except Exception as e:
        logger.warning("[ContextResolver] 查询文档失败 doc_id=%s: %s", doc_id, e)
        return f"[文档引用] {selection_text}" if selection_text else f"[文档引用: {doc_id}]"

    text = "\n\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_field_ref(block: Dict[str, Any], user_id: str, budget: int) -> str:
    """
    解析字段引用：注入字段定义 + 样本值
    """
    field_ids = block.get('field_ids') if isinstance(block.get('field_ids'), list) else []
    field_id = block.get('field_id') or (field_ids[0] if field_ids else None)
    table_id = block.get('table_id', '')
    preview = block.get('preview', '')

    if not field_id:
        return f"[字段引用] {preview}" if preview else ''
    if not table_id:
        logger.warning(
            "[ContextResolver] 字段引用缺少 table_id user_id=%s field_id=%s",
            user_id,
            field_id,
        )
        return f"[字段引用] {preview}" if preview else ''
    if not _user_can_view_table(user_id, table_id):
        logger.warning(
            "[ContextResolver] 字段引用权限不足 user_id=%s table_id=%s field_id=%s",
            user_id,
            table_id,
            field_id,
        )
        return _table_permission_fallback(block, "字段引用")

    try:
        from apps.tabdata.models import TableField
        field = TableField.objects.filter(
            id=field_id,
            table_id=table_id,
            is_deleted=False,
        ).first()
        if not field:
            return f"[字段引用: 字段 {field_id} 未找到]"
        if not _filter_visible_fields(user_id, table_id, [field]):
            return _table_permission_fallback(block, "字段引用")

        parts = [f"## 字段: {field.name}"]
        parts.append(f"- 类型: {field.field_type}")
        if table_id:
            parts.append(f"- table_id: {table_id}")
        if field.description:
            parts.append(f"- 描述: {field.description}")

        # 采样值
        sample_text = _get_field_samples(
            field,
            user_id=user_id,
            max_samples=10,
        )
        if sample_text:
            parts.append("### 样本值:")
            parts.append(sample_text)

    except Exception as e:
        logger.warning("[ContextResolver] 查询字段失败: %s", e)
        return f"[字段引用] {preview}" if preview else ''

    text = "\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_plan_ref(block: Dict[str, Any], budget: int) -> str:
    """#2857：解析「计划」引用——注入「已批准 plan + 指针 + 执行前重读」上下文。

    plan 只存指针（file 载体 = 工作目录相对路径；document 载体 = TabDoc id），
    不含正文；正文由 Agent 执行前按指针自行读取（file → file_read；document → tabdoc 读工具），
    保证拿到最新内容。这里只注入引导，不塞快照。
    """
    plan_name = block.get('plan_name') or ''
    plan_ref = block.get('plan_ref') if isinstance(block.get('plan_ref'), dict) else {}
    ref_kind = plan_ref.get('kind')
    if ref_kind == 'file':
        pointer = plan_ref.get('path') or block.get('file_path') or ''
        locator = f"plan 文件：`{pointer}`（用 file_read 读取）" if pointer else "plan 文件"
    elif ref_kind == 'document':
        pointer = plan_ref.get('document_id') or block.get('doc_id') or ''
        locator = f"plan 文档 id：`{pointer}`（用 tabdoc 读取工具读取）" if pointer else "plan 文档"
    else:
        pointer = block.get('file_path') or block.get('doc_id') or ''
        locator = f"plan 指针：`{pointer}`" if pointer else "plan"

    header = f"## 已批准的计划：{plan_name}" if plan_name else "## 已批准的计划"
    body = (
        f"用户已批准本计划并要求执行。{locator}。"
        "执行前请先读取该 plan 获取最新内容，再按其步骤开始执行。"
    )
    text = f"{header}\n\n{body}"
    return truncate_to_tokens(text, budget)


def _resolve_code_file_ref(block: Dict[str, Any], budget: int) -> str:
    """解析代码文件引用：内容来自前端 preview，无需数据库查询"""
    file_path = block.get('file_path', '')
    language = block.get('language', '')
    preview = block.get('preview', '')

    parts = []
    header = f"## 代码文件: {file_path}" if file_path else "## 代码文件"
    if language:
        header += f" ({language})"
    parts.append(header)

    if preview:
        parts.append(preview)

    text = "\n\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_code_selection_ref(block: Dict[str, Any], budget: int) -> str:
    """解析代码选区引用：内容来自前端 preview，无需数据库查询"""
    file_path = block.get('file_path', '')
    start_line = block.get('start_line', '')
    end_line = block.get('end_line', '')
    language = block.get('language', '')
    preview = block.get('preview', '')

    parts = []
    if file_path and start_line and end_line:
        header = f"## 代码选区: {file_path} L{start_line}-L{end_line}"
    elif file_path:
        header = f"## 代码选区: {file_path}"
    else:
        header = "## 代码选区"
    if language:
        header += f" ({language})"
    parts.append(header)

    if preview:
        parts.append(preview)

    text = "\n\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_composer_preset_ref(block: Dict[str, Any], budget: int) -> str:
    """
    解析 Composer Preset 引用（用户从 App 入口主动触发的预设表单）。

    Block 结构：
        { type: 'composer_preset',
          preset_id: 'tabslide.createSlide',
          params: { topic: '...', template: 'business', ... },
          trigger_context: { source: 'home_section', ... } }

    M1 阶段策略：拍平为可读自然语言注入 Agent 上下文，明确告诉 Agent
    "用户使用了 X 预设，参数是 Y，请按此意图执行"。M2 引入 server-side
    handler 注册后，可改为按 preset_id 路由到具体 handler。
    """
    preset_id = block.get('preset_id', '')
    params = block.get('params') or {}
    trigger_context = block.get('trigger_context') or {}

    if not preset_id:
        return block.get('preview', '')

    parts = [f"## 用户预设请求: `{preset_id}`"]

    if trigger_context:
        ctx_lines = []
        for k, v in trigger_context.items():
            ctx_lines.append(f"- {k}: {v}")
        if ctx_lines:
            parts.append("**触发场景**:")
            parts.extend(ctx_lines)

    if params:
        parts.append("**用户填写的参数**:")
        for k, v in params.items():
            # 跳过 file_id 这类辅助字段，避免噪音
            if k.endswith('_file_id') or k.endswith('_file_ids'):
                continue
            v_str = _format_param_value(v)
            parts.append(f"- {k}: {v_str}")

    parts.append(
        "\n请按上述参数和场景完成用户的意图。"
        "如果需要补充信息：在 2-4 个明确选项之间选用 `ask_user`，"
        "需要用户填具体字段（每字段必须有非空 description 或 placeholder）用 `ask_form`；"
        "即将执行高风险或不可逆操作时，用 `ask_user` 或纯文本先向用户确认。"
    )

    text = "\n".join(parts)
    return truncate_to_tokens(text, budget)


def _format_param_value(value: Any) -> str:
    """把 preset 参数值格式化为可读字符串。

    防御性：dict/嵌套结构走 json.dumps；遇到 datetime/set/自定义对象等
    非 JSON-serializable 类型时降级到 repr，**不让单个字段把整个 preset
    block 拍平失败**（外层 _resolve_context_blocks 的 try/except 会把整段
    退化为 fallback 文案，丢失全部用户填写参数）。
    """
    if value is None:
        return ''
    if isinstance(value, bool):
        return '是' if value else '否'
    if isinstance(value, (list, tuple)):
        if not value:
            return '(空)'
        return ', '.join(_format_param_value(v) for v in value)
    if isinstance(value, dict):
        import json
        try:
            return json.dumps(value, ensure_ascii=False, separators=(',', ':'), default=str)
        except (TypeError, ValueError):
            return repr(value)
    s = str(value)
    if len(s) > 200:
        return s[:200] + '...'
    return s


def _resolve_web_selection_ref(block: Dict[str, Any], budget: int) -> str:
    """解析网页选区引用：内容来自前端 preview，无需数据库查询"""
    page_title = block.get('page_title', '')
    url = block.get('url', '')
    preview = block.get('preview', '')

    parts = []
    header = f"## 网页选区: {page_title}" if page_title else "## 网页选区"
    if url:
        header += f"\n来源: {url}"
    parts.append(header)

    if preview:
        parts.append(preview)

    text = "\n\n".join(parts)
    return truncate_to_tokens(text, budget)


def _resolve_web_annotation_ref(block: Dict[str, Any], budget: int) -> str:
    """解析网页注释引用：文字、DOM 命中与截图附件指针均由前端打包。"""
    page_title = block.get('page_title', '')
    url = block.get('url', '')
    preview = block.get('preview', '')
    selection = block.get('selection') if isinstance(block.get('selection'), dict) else {}
    rect = block.get('rect') if isinstance(block.get('rect'), dict) else {}
    dom = block.get('dom') if isinstance(block.get('dom'), dict) else {}
    content_snapshot = block.get('content_snapshot') if isinstance(block.get('content_snapshot'), dict) else {}
    screenshot_filename = block.get('screenshot_filename', '')

    parts = []
    header = f"## 网页注释: {page_title}" if page_title else "## 网页注释"
    if url:
        header += f"\n来源: {url}"
    parts.append(header)

    selected_text = selection.get('text') if isinstance(selection, dict) else ''
    if selected_text or preview:
        parts.append("选中文本:\n" + str(selected_text or preview))

    # ：注释落点内容快照——框选那一刻在原页面采集（穿透 shadow DOM，带完整
    # 登录态与渲染现场）。「获取注释内容」类请求直接用它回答，无需再开浏览器。
    snapshot_text = content_snapshot.get('text', '')
    if snapshot_text:
        snapshot_lines = ["内容快照（注释创建时已在原页面采集，可直接使用，无需再打开浏览器）:", str(snapshot_text)]
        if content_snapshot.get('truncated'):
            snapshot_lines.append("（快照超长已截断；需要更多内容时再用浏览器工具打开来源页面）")
        parts.append("\n".join(snapshot_lines))

    if rect:
        rect_fields = []
        for key in ('x', 'y', 'width', 'height', 'scroll_x', 'scroll_y'):
            if rect.get(key) is not None:
                rect_fields.append(f"{key}={rect.get(key)}")
        if rect_fields:
            parts.append("区域: " + ", ".join(rect_fields))

    if dom:
        dom_lines = []
        for key, label in (
            ('tag', 'tag'),
            ('role', 'role'),
            ('aria_label', 'aria-label'),
            ('selector', 'selector'),
            ('xpath', 'xpath'),
        ):
            value = dom.get(key)
            if value:
                dom_lines.append(f"{label}: {value}")
        dom_text = dom.get('text')
        if dom_text:
            dom_lines.append(f"element_text: {dom_text}")
        if dom_lines:
            parts.append("DOM 命中:\n" + "\n".join(dom_lines))

    if screenshot_filename:
        parts.append(f"截图附件: {screenshot_filename}")

    text = "\n\n".join(parts)
    return truncate_to_tokens(text, budget)


# ── 整个 tab 资源引用（来自前端「添加到对话」入口，轻量元数据） ───────────────
#
# 设计原则：
# - 不查询数据库，只把前端打包好的 ID + 标题原样渲染给 Agent
# - Agent 看到后自主决定是否调用对应工具读取详情（如 web_scraper / tabdoc_get_document /
#   table_get_records 等），由此控制 token 成本
# - 输出格式：每条一行，标注资源类型 + 标题 + 关键 ID，便于 Agent 直接复制 ID 当工具入参

_TAB_RESOURCE_LABELS: Dict[str, str] = {
    'webpage': '网页',
    'memo': '笔记',
    'whiteboard': '画板',
    'phone_device': '手机',
    'desktop_device': '桌面',
    'terminal_session': '终端会话',
    'slide': '演示文稿',
    'video': '视频',
    'site': '站点',
    'folder': '文件夹',
    'tracker': '任务追踪器',
    'agenda_event': '日程',
    'file': '文件',
}

# 每种 type 的关键 ID 字段名（Agent 调工具时直接拿这个值）
_TAB_RESOURCE_ID_FIELDS: Dict[str, List[str]] = {
    'webpage': ['url'],
    'memo': ['memo_id'],
    'whiteboard': ['canvas_id'],
    'phone_device': ['device_id'],
    'desktop_device': ['device_id'],
    'terminal_session': ['session_id', 'cwd'],
    'slide': ['slide_id'],
    'video': ['video_id'],
    'site': ['site_id'],
    'folder': ['folder_path', 'folder_kind'],
    'tracker': ['tracker_id'],
    'agenda_event': ['event_id'],
    # ：与前端 ENCODE_BY_REF_TYPE['file'] 对齐
    'file': ['file_id'],
}


def _resolve_tab_resource_ref(block: Dict[str, Any], budget: int) -> str:
    """
    解析「添加到对话」类引用：仅输出资源类型 + 标题 + 关键 ID，由 Agent 自主调工具读详情。

    输出示例：
        ## 网页: Google 搜索
        url: https://google.com
        来源标签: tabweb

        ## 笔记: 项目周报
        memo_id: memo_xxx
        来源标签: tabmemo

    title 兜底顺序：preview → 主 ID 字段 → 仅显示资源类型（不留空尾巴）。
    """
    btype = block.get('type', '')
    label = _TAB_RESOURCE_LABELS.get(btype, btype)
    title = (block.get('preview') or '').strip()
    tab_type = block.get('tab_type', '')

    id_fields = _TAB_RESOURCE_ID_FIELDS.get(btype, [])

    # title 为空时用主 ID 字段兜底，避免输出 "## 网页: " 留空尾巴
    if not title and id_fields:
        primary_id = block.get(id_fields[0])
        if primary_id:
            title = str(primary_id)

    parts = [f"## {label}: {title}" if title else f"## {label}"]

    for field_name in id_fields:
        value = block.get(field_name)
        if value:
            parts.append(f"{field_name}: {value}")

    if tab_type:
        parts.append(f"来源标签: {tab_type}")

    text = "\n".join(parts)
    return truncate_to_tokens(text, budget)


def _get_sample_records(
    table_id: str,
    fields: list,
    *,
    user_id: str,
    max_rows: int = 5,
) -> str:
    """通过 TabData 原生记录服务获取受 RLS 约束的采样记录。"""
    try:
        reader, rls_context = _record_reader(user_id)
        if reader is None:
            return ''
        result = reader.list_records(
            table_id=table_id,
            page=1,
            page_size=max_rows,
            sort_by='updated_at',
            sort_order='desc',
            field_key_type='id',
            rls_context=rls_context,
        )
        records = result.get('records') or []
        if not records:
            return ''

        field_names = [f.name for f in fields]
        field_ids = [f.id for f in fields]

        lines = []
        # 表头
        lines.append(" | ".join(field_names))
        lines.append(" | ".join(["---"] * len(field_names)))
        # 数据行
        for rec in records:
            data = rec.get('fields') or {}
            row = []
            for fid in field_ids:
                val = data.get(str(fid), '')
                val_str = str(val) if val is not None and val != '' else ''
                # 截断单元格
                if len(val_str) > 50:
                    val_str = val_str[:50] + '...'
                row.append(val_str)
            lines.append(" | ".join(row))

        return "\n".join(lines)
    except Exception as e:
        logger.warning("[ContextResolver] 采样记录失败: %s", e)
        return ''


def _get_field_samples(field, *, user_id: str, max_samples: int = 10) -> str:
    """通过 TabData 原生记录服务获取受 RLS 约束的字段样本。"""
    try:
        reader, rls_context = _record_reader(user_id)
        if reader is None:
            return ''
        result = reader.list_records(
            table_id=field.table_id,
            page=1,
            page_size=max_samples,
            sort_by='updated_at',
            sort_order='desc',
            field_key_type='id',
            rls_context=rls_context,
        )
        records = result.get('records') or []
        values = []
        field_key = str(field.id)
        for rec in records:
            data = rec.get('fields') or {}
            val = data.get(field_key, '')
            if val is not None and val != '':
                val_str = str(val)
                if len(val_str) > 100:
                    val_str = val_str[:100] + '...'
                values.append(val_str)

        return ", ".join(values) if values else ''
    except Exception as e:
        logger.warning("[ContextResolver] 字段采样失败: %s", e)
        return ''

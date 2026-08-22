"""Checkpoint 决策上下文构建——ChangeLog 聚合 + 文件列表 + 对话上下文。"""
import logging
from typing import Optional

from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

USER_PROMPT_PREVIEW_MAX_LENGTH = 200


def build_checkpoint_impact(
    *,
    agent_run_id: str,
    space_resource_ids: Optional[list] = None,
    changed_files: Optional[list] = None,
    max_changelogs: int = 30,
    max_files: int = 50,
) -> dict:
    """构建 checkpoint_context 的 impact 部分。

    聚合 ChangeLog 变更摘要（含 Subagent 级联）和代码文件列表，并通过
    :func:`apps.collab.services.contributors.collect_contributed_impact` 合并
    各业务模块（tabdata / tabdoc / tabdesign / ...）的影响维度数据。

    返回结构（Charter §3.3）::

        {
            'resources': [...],              # 既有：ChangeLog 摘要
            'resources_truncated': bool,
            'resources_total_count': int,
            'files': [...],                  # 既有：改动文件路径
            'files_truncated': bool,
            'files_total_count': int,
            'tabdata': {...},                # 新增（W0-1 CC-3）：模块 contributor 路由产物
            'tabdoc':  {...},                # 同上，仅在 contributor 注册并返回非空数据时出现
        }

    向后兼容（关键约束）：
        - 未注册任何 ImpactContributor 时，输出 dict 不会包含任何模块键
          （不返回空 ``tabdata`` 字段），与本函数 W0-1 之前的行为完全一致。
        - 模块名 collision 时由 :func:`collect_contributed_impact` 用 warning 处理，
          ``build_checkpoint_impact`` 不阻塞。
        - 模块键 vs ``resources`` / ``files`` 的命名空间隔离：模块名应避免与
          既有保留键（``resources*`` / ``files*``）冲突；如有冲突，模块 contributor
          的输出会**覆盖**既有键并打 warning，提示模块换 name（如 ``tabdata`` 而非
          ``resources``）。
    """
    from apps.collab.models import ChangeLog
    from apps.collab.services.contributors import expand_agent_run_ids

    impact = {}

    # W0-1：与 daemon / HTTP create_space_checkpoint 路径统一通过
    # ``expand_agent_run_ids`` 展开级联，避免三条路径各自实现展开 + fail-safe
    # 逻辑产生不一致。空 agent_run_id 时返回 [] 正确处理。
    all_run_ids = expand_agent_run_ids(agent_run_id) or [agent_run_id]

    cl_qs = ChangeLog.objects.using(postgres_app_db_alias()).filter(agent_run_id__in=all_run_ids)
    if space_resource_ids:
        cl_qs = cl_qs.filter(resource_id__in=space_resource_ids)
    resources_total = cl_qs.count()
    changelogs = list(cl_qs.values('resource_type', 'resource_id', 'change_type', 'summary')[:max_changelogs])

    if changelogs:
        impact["resources"] = [
            {
                "type": cl['resource_type'],
                "id": str(cl['resource_id']),
                "action": cl['change_type'],
                "summary": (cl['summary'] or '')[:200],
            }
            for cl in changelogs
        ]
        impact["resources_truncated"] = resources_total > max_changelogs
        impact["resources_total_count"] = resources_total

    files = changed_files or []
    files_total = len(files)
    if files_total > 0:
        impact["files"] = files[:max_files]
        impact["files_truncated"] = files_total > max_files
        impact["files_total_count"] = files_total

    # ── W0-1 CC-3：ImpactContributor 协议 ─────────────────────
    # 各业务模块通过 collab.services.contributors 注册的 ImpactContributor
    # 在此被回调，把模块维度数据按 contributor.name 路由进 impact。
    # Charter §3.3 / D2 协议方向。
    try:
        from apps.collab.services.contributors import collect_contributed_impact
        contributed = collect_contributed_impact(all_run_ids)
    except Exception:
        contributed = {}
        logger.warning(
            "build_checkpoint_impact: collect_contributed_impact failed "
            "(non-blocking): run=%s",
            agent_run_id, exc_info=True,
        )
    for module_name, module_impact in contributed.items():
        if module_name in impact:
            logger.warning(
                "ImpactContributor name collides with reserved key "
                "(later overrides): name=%s",
                module_name,
            )
        impact[module_name] = dict(module_impact)

    return impact


# ---------------------------------------------------------------------------
# 对话上下文构建
# ---------------------------------------------------------------------------

def build_checkpoint_conversation_context(
    *,
    agent_run_id: str,
    session_id: str = '',
    message_id: str = '',
    include_sub_conversations: bool = False,
) -> dict:
    """构建 checkpoint 的对话上下文信息。

    返回 dict 包含：
    - session_id: str
    - assistant_message_id: str
    - user_message_id: str
    - user_prompt: str（截取前 200 字符）
    - sub_conversations: list（仅 include_sub_conversations=True 时）

    数据获取优先级：
    - session_id：参数传入 > ExecutionRun.session_id（同库 PG 查询）
    - assistant_message_id：参数传入 > ChatMessage.filter(agent_run_id=X, role='assistant')
    - user_message_id：同 session 下 assistant 消息之前的最新 user 消息

    任何查询失败都 gracefully degrade，返回已获取到的部分信息，不抛异常。
    """
    ctx: dict = {
        'session_id': session_id or '',
        'assistant_message_id': message_id or '',
        'user_message_id': '',
        'user_prompt': '',
    }

    # --- 1. session_id：参数传入 > ExecutionRun.session_id ---
    if not ctx['session_id']:
        try:
            from apps.services.agent_engine.models import ExecutionRun
            er = (
                ExecutionRun.objects.using(postgres_app_db_alias())
                .filter(run_id=agent_run_id)
                .values('session_id')
                .first()
            )
            if er and er.get('session_id'):
                ctx['session_id'] = er['session_id']
        except Exception:
            logger.debug(
                "build_checkpoint_conversation_context: ExecutionRun.session_id lookup failed",
                exc_info=True,
            )

    # --- 2. assistant_message_id + 附带 created_at / content ---
    assistant_created_at = None
    assistant_content = ''

    try:
        from apps.chat.conversation.models import ChatMessage

        # W3 §3.3.1：content → text_summary 字段重命名
        if ctx['assistant_message_id']:
            amsg = (
                ChatMessage.objects
                .filter(id=ctx['assistant_message_id'])
                .values('created_at', 'text_summary', 'session_id')
                .first()
            )
        else:
            amsg = (
                ChatMessage.objects
                .filter(agent_run_id=agent_run_id, role='assistant')
                .order_by('-created_at')
                .values('id', 'session_id', 'created_at', 'text_summary')
                .first()
            )
            if amsg:
                ctx['assistant_message_id'] = str(amsg['id'])

        if amsg:
            assistant_created_at = amsg['created_at']
            assistant_content = amsg.get('text_summary') or ''
            if not ctx['session_id'] and amsg.get('session_id'):
                ctx['session_id'] = str(amsg['session_id'])
    except Exception:
        logger.debug(
            "build_checkpoint_conversation_context: assistant message lookup failed",
            exc_info=True,
        )

    # --- 3. user_message_id + user_prompt ---
    if ctx['session_id'] and assistant_created_at:
        try:
            from apps.chat.conversation.models import ChatMessage

            # W3 §3.3.1：content → text_summary 字段重命名
            umsg = (
                ChatMessage.objects
                .filter(
                    session_id=ctx['session_id'],
                    role='user',
                    created_at__lt=assistant_created_at,
                )
                .order_by('-created_at')
                .values('id', 'text_summary')
                .first()
            )
            if umsg:
                ctx['user_message_id'] = str(umsg['id'])
                ctx['user_prompt'] = (umsg.get('text_summary') or '')[:USER_PROMPT_PREVIEW_MAX_LENGTH]
        except Exception:
            logger.debug(
                "build_checkpoint_conversation_context: user message lookup failed",
                exc_info=True,
            )

    # user_prompt fallback：过短（< 20 字符）时取 assistant 回复前 200 字符
    if len(ctx['user_prompt']) < 20 and assistant_content:
        ctx['user_prompt'] = assistant_content[:USER_PROMPT_PREVIEW_MAX_LENGTH]

    # --- 4. sub_conversations ---
    if include_sub_conversations:
        ctx['sub_conversations'] = _build_sub_conversations(
            agent_run_id, ctx['assistant_message_id'],
        )

    return ctx


_RESOURCE_TYPE_LABELS_ZH = {
    "table": "表格",
    "docs": "文档",
    "design": "设计稿",
    "slide": "幻灯片",
    "video": "视频",
    "canvas": "画布",
    "code": "代码",
    "file": "代码文件",
    "site": "站点",
}

_RESOURCE_TYPE_LABELS_EN = {
    "table": "table(s)",
    "docs": "document(s)",
    "design": "design(s)",
    "slide": "slide(s)",
    "video": "video(s)",
    "canvas": "canvas(es)",
    "code": "code file(s)",
    "file": "code file(s)",
    "site": "site(s)",
}


def _smart_truncate(text: str, max_len: int) -> str:
    """在标点/空白边界截断并加省略号，避免截在句子中间。"""
    if not text or len(text) <= max_len:
        return text
    cut = text[:max_len]
    for sep in ('\n', '。', '！', '？', '；', '. ', '! ', '? ', '，', ', ', ' '):
        pos = cut.rfind(sep)
        if pos > max_len * 0.5:
            return cut[:pos + len(sep)].rstrip() + '…'
    return cut.rstrip() + '…'


def _extract_rich_user_prompt(session_id, before_time, max_msgs=3, max_chars=500):
    """从多条 user 消息中提取意图文本。支持 content_blocks_json 中的附件/选区/预设。

    W3 §3.3.1：blocks_json → content_blocks_json + content → text_summary 字段重命名
    """
    try:
        from apps.chat.conversation.models import ChatMessage

        msgs = list(
            ChatMessage.objects
            .filter(session_id=session_id, role='user', created_at__lt=before_time)
            .order_by('-created_at')
            .values('text_summary', 'content_blocks_json')[:max_msgs]
        )
        parts = []
        for msg in reversed(msgs):
            text = (msg.get('text_summary') or '').strip()
            if not text or text in ('(附件)', '(attachment)'):
                blocks = msg.get('content_blocks_json') or []
                block_texts = []
                for b in blocks:
                    if not isinstance(b, dict):
                        continue
                    btype = b.get('type', '')
                    if btype == 'text':
                        block_texts.append(b.get('text') or '')
                    elif btype in ('doc_selection', 'table_selection'):
                        block_texts.append(b.get('preview') or '')
                    elif btype == 'composer_preset':
                        block_texts.append(b.get('preview') or b.get('text') or '')
                text = ' '.join(t for t in block_texts if t).strip()
            if text:
                parts.append(text)
        return '\n'.join(parts)[:max_chars]
    except Exception:
        logger.debug("_extract_rich_user_prompt failed", exc_info=True)
        return ''


def _detect_is_cjk(text: str) -> bool:
    """Heuristic: if >20% of characters are CJK, consider it Chinese/Japanese/Korean."""
    if not text:
        return True
    cjk_count = sum(1 for ch in text if '\u4e00' <= ch <= '\u9fff' or '\u3040' <= ch <= '\u30ff')
    return cjk_count > len(text) * 0.2


def build_basic_decision_summary(
    *,
    user_prompt: str = '',
    diff_summary: Optional[dict] = None,
    impact: Optional[dict] = None,
) -> dict:
    """生成基础版决策摘要（不依赖 LLM，checkpoint 创建瞬间即可用）。

    Returns:
        {
            "intent": str,
            "outcome": str,        # legacy — human-readable text (auto-detect zh/en)
            "outcome_structured": { "files_changed": int, "insertions": int, ... },
            "status": "basic",
        }
    """
    outcome_structured: dict = {}
    is_cjk = _detect_is_cjk(user_prompt)

    if diff_summary:
        n_changed = diff_summary.get("changed", 0)
        n_ins = diff_summary.get("insertions", 0)
        n_del = diff_summary.get("deletions", 0)
        if n_changed or n_ins or n_del:
            outcome_structured["files_changed"] = n_changed
            outcome_structured["insertions"] = n_ins
            outcome_structured["deletions"] = n_del

    resource_type_counts: dict[str, int] = {}
    if impact and impact.get("resources"):
        for r in impact["resources"]:
            rtype = r.get("type", "unknown")
            resource_type_counts[rtype] = resource_type_counts.get(rtype, 0) + 1
    if resource_type_counts:
        outcome_structured["resources"] = [
            {"type": rtype, "count": count}
            for rtype, count in resource_type_counts.items()
        ]

    outcome_text = _format_outcome_text(outcome_structured, is_cjk)

    return {
        "intent": _smart_truncate(user_prompt or '', USER_PROMPT_PREVIEW_MAX_LENGTH),
        "outcome": outcome_text,
        "outcome_structured": outcome_structured,
        "status": "basic",
    }


def _format_outcome_text(outcome_structured: dict, is_cjk: bool) -> str:
    """Generate human-readable outcome from structured data, in zh or en."""
    parts: list[str] = []

    n_changed = outcome_structured.get("files_changed", 0)
    n_ins = outcome_structured.get("insertions", 0)
    n_del = outcome_structured.get("deletions", 0)
    if n_changed or n_ins or n_del:
        if is_cjk:
            seg = f"修改了 {n_changed} 个文件"
            sub = []
            if n_ins:
                sub.append(f"新增 {n_ins} 行")
            if n_del:
                sub.append(f"删除 {n_del} 行")
            if sub:
                seg += "，" + "，".join(sub)
        else:
            seg = f"Changed {n_changed} file(s)"
            sub = []
            if n_ins:
                sub.append(f"+{n_ins} lines")
            if n_del:
                sub.append(f"-{n_del} lines")
            if sub:
                seg += ", " + ", ".join(sub)
        parts.append(seg)

    resources = outcome_structured.get("resources", [])
    if resources:
        labels = _RESOURCE_TYPE_LABELS_ZH if is_cjk else _RESOURCE_TYPE_LABELS_EN
        segs = []
        for r in resources:
            rtype = r["type"]
            count = r["count"]
            label = labels.get(rtype, (f"{rtype} 资源" if is_cjk else f"{rtype} resource(s)"))
            if is_cjk:
                segs.append(f"{count} 个{label}")
            else:
                segs.append(f"{count} {label}")
        if is_cjk:
            parts.append("更新了 " + "、".join(segs))
        else:
            parts.append("Updated " + ", ".join(segs))

    if is_cjk:
        return "；".join(parts) if parts else "执行了操作"
    else:
        return "; ".join(parts) if parts else "Executed action"


def enrich_checkpoint_for_creation(
    *,
    agent_run_id: str,
    message_id: str = '',
    session_id: str = '',
    space_resource_ids: Optional[list] = None,
    diff_summary: Optional[dict] = None,
    user_prompt_override: str = '',
    include_sub_conversations: bool = True,
) -> dict:
    """构建 SpaceCheckpoint 创建所需的完整对话上下文和决策摘要。

    整合 conversation context、impact、decision_summary 的完整构建流程，
    供 daemon_checkpoint_service 和 collab/api 两个入口共用，消除重复逻辑。

    Args:
        session_id: 调用方已知的 session_id（Daemon 路径从 thread_id 解析得到）。
            传入可跳过 ExecutionRun 反查，并保证 metadata.checkpoint_context.session_id
            与一等字段 anchor_session_id 同源（Wave 12 H1-02）。

    Returns:
        {
            'anchor_session_id': str,
            'anchor_message_id': str,
            'checkpoint_context': dict | None,
        }
        任何步骤失败都 gracefully degrade，不抛异常。
    """
    result: dict = {
        'anchor_session_id': '',
        'anchor_message_id': '',
        'checkpoint_context': None,
    }

    try:
        conv_ctx = build_checkpoint_conversation_context(
            agent_run_id=agent_run_id,
            session_id=session_id,
            message_id=message_id,
            include_sub_conversations=include_sub_conversations,
        )

        anchor_session_id = conv_ctx.get('session_id', '')
        anchor_message_id = conv_ctx.get('assistant_message_id', '') or message_id
        result['anchor_session_id'] = anchor_session_id
        result['anchor_message_id'] = anchor_message_id

        changed_files = None
        if message_id:
            try:
                from apps.chat.conversation.models import ChatMessage
                amsg = ChatMessage.objects.filter(id=message_id).values(
                    'session_id', 'created_at', 'changed_files',
                ).first()
                if amsg:
                    changed_files = amsg.get('changed_files')
                    if len(conv_ctx.get('user_prompt', '')) < 20:
                        enhanced = _extract_rich_user_prompt(
                            amsg['session_id'], amsg['created_at'],
                        )
                        if enhanced:
                            conv_ctx['user_prompt'] = enhanced
            except Exception:
                logger.debug(
                    "enrich_checkpoint: changed_files lookup failed: msg=%s",
                    message_id, exc_info=True,
                )

        # QC-08 / Wave 15：HTTP 路径（无 message_id）降级——从 diff_summary.files
        # 直接提取路径列表。这样 impact["files"] 在 HTTP 场景也能被填充，
        # 保持与 Daemon 路径对称。
        if not changed_files and isinstance(diff_summary, dict):
            files_from_diff = diff_summary.get('files') or []
            if isinstance(files_from_diff, list):
                extracted = []
                seen = set()
                for entry in files_from_diff:
                    if isinstance(entry, dict) and isinstance(entry.get('file'), str):
                        p = entry['file'].strip()
                        if p and p not in seen:
                            seen.add(p)
                            extracted.append(p)
                if extracted:
                    changed_files = extracted

        impact = build_checkpoint_impact(
            agent_run_id=agent_run_id,
            space_resource_ids=space_resource_ids,
            changed_files=changed_files,
        )

        user_prompt = user_prompt_override or conv_ctx.get('user_prompt', '')

        # session_id / assistant_message_id 同时写入一等字段（anchor_*）和 metadata 中，
        # 一等字段用于 DB 索引查询，此处 metadata 副本保证 checkpoint_context 结构自包含。
        # 前端读取时优先使用一等字段，metadata 中的作为 fallback。
        checkpoint_context: dict = {
            'user_message_id': conv_ctx.get('user_message_id', ''),
            'user_prompt': _smart_truncate(user_prompt, USER_PROMPT_PREVIEW_MAX_LENGTH),
            'session_id': anchor_session_id,
            'assistant_message_id': anchor_message_id,
            'agent_run_id': agent_run_id,
        }

        if impact:
            checkpoint_context['impact'] = impact

        sub_conversations = conv_ctx.get('sub_conversations')
        if sub_conversations:
            checkpoint_context['sub_conversations'] = sub_conversations

        checkpoint_context['decision_summary'] = build_basic_decision_summary(
            user_prompt=user_prompt,
            diff_summary=diff_summary,
            impact=impact,
        )

        result['checkpoint_context'] = checkpoint_context

    except Exception:
        logger.warning(
            "enrich_checkpoint_for_creation failed (non-blocking): run=%s msg=%s",
            agent_run_id, message_id, exc_info=True,
        )

    return result


def _build_sub_conversations(
    parent_run_id: str, parent_message_id: str,
) -> list[dict]:
    """构建子 Agent 对话引用列表（单 parent）。

    内部复用批量实现 `_build_sub_conversations_batch`，
    保证单/批量两条路径的子 Agent 识别口径一致。
    """
    if not parent_run_id:
        return []
    batch = _build_sub_conversations_batch(
        agent_run_ids=[parent_run_id],
        parent_message_id_by_run={parent_run_id: parent_message_id or ''},
    )
    return batch.get(parent_run_id, [])


def _build_sub_conversations_batch(
    *,
    agent_run_ids: list[str],
    parent_message_id_by_run: Optional[dict[str, str]] = None,
) -> dict[str, list[dict]]:
    """批量构建多个 parent agent_run_id 的子 Agent 对话引用。

    性能关键（PRD §4.3.1 / §7）：列表 API 不能逐条展开子 Agent，
    否则会引发 O(N * depth) BFS + 重复数据库查询。本函数：

    1. 对每个 parent 调用 `_resolve_cascading_run_ids`（每次 BFS 内部已批量化 SubtaskRun 查询）
    2. 合并所有 child_run_id → 根 parent 的归属关系
    3. 一次性查 ExecutionRun / SubtaskRun / ChatSession / ChatMessage
    4. 按根 parent 分桶返回

    Args:
        agent_run_ids: 本页需要展开的 parent agent_run_id 列表（已去重）
        parent_message_id_by_run: 每个 parent 的 assistant_message_id，
            用于填充 `SubConversationRef.parent_message_id`。缺失时为空串。

    Returns:
        dict[parent_run_id, list[SubConversationRef]]；
        parent 无子会话时映射为空列表。
    """
    parent_message_id_by_run = parent_message_id_by_run or {}
    result: dict[str, list[dict]] = {rid: [] for rid in agent_run_ids}

    unique_parents = [rid for rid in dict.fromkeys(agent_run_ids) if rid]
    if not unique_parents:
        return result

    try:
        from apps.collab.api import _resolve_cascading_run_ids
        from apps.services.agent_engine.models import ExecutionRun, SubtaskRun
        from apps.chat.conversation.models import ChatMessage, ChatSession

        # child_run_id -> root_parent_run_id
        child_to_root: dict[str, str] = {}
        for parent_rid in unique_parents:
            try:
                cascade = _resolve_cascading_run_ids(parent_rid)
            except Exception:
                logger.debug(
                    "_build_sub_conversations_batch: cascade failed for parent=%s",
                    parent_rid, exc_info=True,
                )
                continue
            for rid in cascade:
                if rid == parent_rid:
                    continue
                # 多 parent 竞争同一 child 时，先到先得（正常场景互不相交）
                child_to_root.setdefault(rid, parent_rid)

        if not child_to_root:
            return result

        child_run_ids = list(child_to_root.keys())

        # 1) 批量查 ExecutionRun.thread_id，筛选子线程（含 '-sub-'）
        child_runs = list(
            ExecutionRun.objects.using(postgres_app_db_alias())
            .filter(run_id__in=child_run_ids)
            .values('run_id', 'thread_id')
        )
        sub_thread_runs = [
            r for r in child_runs
            if r.get('thread_id') and '-sub-' in r['thread_id']
        ]
        if not sub_thread_runs:
            return result

        child_thread_ids = [r['thread_id'] for r in sub_thread_runs]

        # 2) 批量查 SubtaskRun.agent_name/label
        subtask_map: dict[str, dict] = {}
        for sr in (
            SubtaskRun.objects.using(postgres_app_db_alias())
            .filter(child_thread_id__in=child_thread_ids)
            .values('child_thread_id', 'agent_name', 'label')
        ):
            subtask_map.setdefault(sr['child_thread_id'], sr)

        # 3) 批量查 ChatSession（MySQL 默认库）
        session_map: dict[str, dict] = {}
        for s in ChatSession.objects.filter(
            thread_id__in=child_thread_ids,
        ).values('thread_id', 'id'):
            session_map[s['thread_id']] = s

        # 4) 批量查子 run 的 assistant 消息
        child_run_strs = [str(r['run_id']) for r in sub_thread_runs]
        msg_map: dict[str, dict] = {}
        for msg in (
            ChatMessage.objects
            .filter(agent_run_id__in=child_run_strs, role='assistant')
            .order_by('-created_at')
            .values('id', 'agent_run_id')
        ):
            msg_map.setdefault(msg['agent_run_id'], msg)

        # 5) 按根 parent 分桶组装
        for r in sub_thread_runs:
            rid_str = str(r['run_id'])
            tid = r['thread_id']
            root_parent = child_to_root.get(rid_str)
            if not root_parent or root_parent not in result:
                continue

            sr = subtask_map.get(tid) or {}
            sess = session_map.get(tid)
            amsg = msg_map.get(rid_str)

            result[root_parent].append({
                'session_id': str(sess['id']) if sess else '',
                'message_id': str(amsg['id']) if amsg else '',
                'label': sr.get('agent_name') or sr.get('label') or '',
                'parent_message_id': parent_message_id_by_run.get(root_parent, '') or '',
            })

        return result
    except Exception:
        logger.warning(
            "_build_sub_conversations_batch failed (parents=%d)",
            len(unique_parents), exc_info=True,
        )
        return result

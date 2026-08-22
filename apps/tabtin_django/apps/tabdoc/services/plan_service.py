"""
PlanService — Plan 模式三件套（create / update_todos / exit）的核心业务逻辑

设计要点：
- Plan 文档是 ``Document`` 的特化形态：``tags=['plan']`` + ``properties.plan``。
  本 service 只负责 Plan 维度的语义，复用 ``DocumentService`` / ``CollectionService``
  / ``ResourceBridge`` 完成底层 CRUD / Collection 归属 / ContextItem 同步。
- 严格遵守 "Plan vs Todo 分工"：
  * ``create_plan`` 写入初始 todos 快照；
  * ``update_todos`` 仅在 ``status == draft`` 时允许；
  * 执行期 ``todo_write`` 不通过本 service 触达 Plan 文档（由 Runtime 侧约束）。
- ``plan_exit`` 一次请求结算（approve / reject / cancelled），blocking HITL 由
  Runtime 侧管理，Django 这边只负责更新文档状态 + 返回完整 plan 正文。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction

from apps.i18n import _
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabdoc.models import Document
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.markdown_exchange import (
    markdown_to_pm_json,
    pm_json_to_markdown,
)
from apps.tabdoc.services.plan_schema import (
    PLAN_DOCUMENT_TAG,
    PLANNING_COLLECTION_ICON,
    PLANNING_COLLECTION_NAME,
    PLANNING_COLLECTION_SYSTEM_KEY,
    PlanProperties,
    PlanTodo,
    now_iso,
)
from apps.tabtinspace.models import Collection, ContextItem
from apps.tabtinspace.services.asset_host import asset_host_q, create_host_kwargs
from apps.tabtinspace.services.resource_bridge import ResourceBridge

logger = logging.getLogger("tabdoc.plan_service")

User = get_user_model()

# plan_update_todos 入参中支持的两种合并语义
TodosMergeMode = Literal["merge", "replace"]

# plan_exit 的三种 outcome
# PlanExitOutcome 已随 exit_plan 一并删除。

# 自定义属性 key：写入到 PM JSON 的 ``taskItem.attrs.todoId`` 中，便于
# update_todos 时在不依赖文本匹配的情况下回写 checked 状态。
_TODO_ID_ATTR_KEY = "todoId"


class PlanServiceError(Exception):
    """Plan service 层结构化错误。

    携带稳定的 ``code`` 字段供 API/工具层做分支判定与 i18n 映射。
    """

    def __init__(self, code: str, message: str, *, status: int = 400):
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message or code)


# ── 辅助函数 ──


def _normalize_todos(todos: Any) -> List[PlanTodo]:
    """统一把外部 todos 入参（dict / PlanTodo / pydantic）规范化为 PlanTodo 列表。

    校验交给 PlanTodo（pydantic）自身完成；id 重复时抛出。
    """
    if not todos:
        return []
    if not isinstance(todos, list):
        raise PlanServiceError("PLAN_INVALID_TODOS", "todos 必须是数组")

    seen_ids: set[str] = set()
    normalized: List[PlanTodo] = []
    for raw in todos:
        if isinstance(raw, PlanTodo):
            todo = raw
        elif isinstance(raw, dict):
            try:
                todo = PlanTodo.model_validate(raw)
            except Exception as exc:
                raise PlanServiceError(
                    "PLAN_INVALID_TODO",
                    f"todo 校验失败：{exc}",
                ) from exc
        else:
            raise PlanServiceError(
                "PLAN_INVALID_TODO",
                f"todo 必须是 dict 或 PlanTodo，收到 {type(raw).__name__}",
            )
        if todo.id in seen_ids:
            raise PlanServiceError(
                "PLAN_DUPLICATE_TODO_ID",
                f"todo id 重复：{todo.id}",
            )
        seen_ids.add(todo.id)
        normalized.append(todo)
    return normalized


def _build_initial_pm_json(plan_props: PlanProperties, plan_markdown: str) -> tuple[dict, str, str]:
    """根据 plan markdown + 结构化 todos 生成 PM JSON。

    策略：
    1. 用 ``markdown_to_pm_json`` 解析 LLM 给的 plan 正文（可能包含 ``- [ ]`` TaskList）；
    2. 如果正文里没有 TaskList 节点，根据 ``plan_props.todos`` 自动追加一段 TaskList，
       保证「正文是 todos 的可视化派生」一致性；
    3. 给所有 ``taskItem`` 节点的 ``attrs`` 加上 ``todoId``，便于 update_todos
       回写 checked 状态。匹配优先级：先按下标对应 ``plan_props.todos[i]``，
       多余/缺失的 taskItem 不强行标记。

    返回 ``(pm_json, normalized_markdown, plaintext)``。
    """
    base_md = (plan_markdown or "").strip()
    pm_json = markdown_to_pm_json(base_md) if base_md else {"type": "doc", "content": []}
    if not isinstance(pm_json, dict):
        pm_json = {"type": "doc", "content": []}
    pm_json.setdefault("type", "doc")
    pm_json.setdefault("content", [])
    if not isinstance(pm_json["content"], list):
        pm_json["content"] = []

    has_task_list = any(
        isinstance(node, dict) and node.get("type") == "taskList"
        for node in pm_json["content"]
    )
    if not has_task_list and plan_props.todos:
        todos_md = _todos_to_markdown(plan_props.todos)
        appended = markdown_to_pm_json(todos_md)
        if isinstance(appended, dict):
            pm_json["content"].extend(appended.get("content", []))

    _stamp_task_items_with_todo_ids(pm_json, plan_props.todos)

    final_markdown = pm_json_to_markdown(pm_json) or base_md
    plaintext = _extract_plaintext(pm_json)
    return pm_json, final_markdown, plaintext


def _todos_to_markdown(todos: List[PlanTodo]) -> str:
    lines: List[str] = ["", "## 待办", ""]
    for todo in todos:
        mark = "x" if todo.status == "completed" else " "
        content = (todo.content or "").strip().replace("\n", " ")
        lines.append(f"- [{mark}] {content}")
    return "\n".join(lines)


def _stamp_task_items_with_todo_ids(pm_json: dict, todos: List[PlanTodo]) -> None:
    """按下标顺序把 todo.id 写入 PM JSON 中所有 ``taskItem`` 的 attrs。

    多余的 taskItem 不动；少于 todo 数量时只覆盖前 N 个。
    """
    if not todos:
        return
    todo_iter = iter(todos)
    for node in pm_json.get("content", []):
        if not isinstance(node, dict) or node.get("type") != "taskList":
            continue
        for item in node.get("content", []):
            if not isinstance(item, dict) or item.get("type") != "taskItem":
                continue
            try:
                todo = next(todo_iter)
            except StopIteration:
                return
            attrs = item.setdefault("attrs", {})
            attrs[_TODO_ID_ATTR_KEY] = todo.id
            attrs.setdefault("checked", todo.status == "completed")


def _sync_task_list_checked(
    pm_json: dict,
    todos_by_id: Dict[str, PlanTodo],
    todos_in_order: List[PlanTodo],
) -> bool:
    """根据 ``todos_by_id`` 同步 PM JSON 内 taskItem 的 checked 状态。

    匹配优先级：
    1. ``attrs.todoId`` 精确匹配（首选，最稳）；
    2. 如果 PM JSON 内一个 taskItem 都没有 ``todoId`` attrs（前端协作回写
       可能 strip 未注册属性，参见 W3 待修：TaskItem.addAttributes），
       退化为按出现顺序对应 ``todos_in_order``。
       ※ 仅在「整段都缺 attr」时启用 fallback，避免新旧文档混合时误同步。

    返回是否有任何节点被改动。
    """
    if not todos_by_id and not todos_in_order:
        return False

    task_items: List[dict] = []
    for node in pm_json.get("content", []):
        if not isinstance(node, dict) or node.get("type") != "taskList":
            continue
        for item in node.get("content", []):
            if isinstance(item, dict) and item.get("type") == "taskItem":
                task_items.append(item)

    if not task_items:
        return False

    has_any_todo_id = any(
        (item.get("attrs") or {}).get(_TODO_ID_ATTR_KEY)
        for item in task_items
    )

    changed = False
    if has_any_todo_id:
        for item in task_items:
            attrs = item.get("attrs") or {}
            todo_id = attrs.get(_TODO_ID_ATTR_KEY)
            if not todo_id or todo_id not in todos_by_id:
                continue
            target_checked = todos_by_id[todo_id].status == "completed"
            if attrs.get("checked") != target_checked:
                attrs["checked"] = target_checked
                item["attrs"] = attrs
                changed = True
    else:
        for item, todo in zip(task_items, todos_in_order):
            attrs = item.get("attrs") or {}
            target_checked = todo.status == "completed"
            if attrs.get("checked") != target_checked or attrs.get(_TODO_ID_ATTR_KEY) != todo.id:
                attrs["checked"] = target_checked
                attrs[_TODO_ID_ATTR_KEY] = todo.id
                item["attrs"] = attrs
                changed = True

    return changed


def _extract_plaintext(pm_json: dict) -> str:
    parts: List[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            text = node.get("text")
            if isinstance(text, str):
                parts.append(text)
            for child in node.get("content", []) or []:
                _walk(child)

    _walk(pm_json)
    return " ".join(p for p in (s.strip() for s in parts) if p).strip()


def _ensure_planning_collection(space_id: UUID, *, user=None) -> Optional[Collection]:
    """查找或创建该 Space 的「规划」Collection。

    优先按 system_key='planning_root' 查找（用户重命名不影响定位），
    fallback 按 name='规划' 兼容 migration 尚未跑完的旧数据。

    W1-B 已经为 bot Space 预置该 Collection；本 Wave 自带兜底，
    任何 Space 在用 plan_create 时找不到就自动建一个，保证幂等。
    并发场景下若撞上 unique 约束，会回退为 get() 再返回。
    """
    host_q = asset_host_q(space_id)
    coll = (
        Collection.objects
        .filter(host_q, system_key=PLANNING_COLLECTION_SYSTEM_KEY)
        .first()
    )
    if coll:
        return coll

    coll = (
        Collection.objects
        .filter(host_q, parent__isnull=True, name=PLANNING_COLLECTION_NAME)
        .first()
    )
    if coll:
        if not coll.system_key:
            coll.system_key = PLANNING_COLLECTION_SYSTEM_KEY
            coll.save(update_fields=["system_key", "updated_at"])
        return coll

    try:
        # get_or_create 无法直接表达 workspace|project OR；先 filter，缺失再 create。
        coll = Collection.objects.create(
            **create_host_kwargs(space_id),
            system_key=PLANNING_COLLECTION_SYSTEM_KEY,
            parent=None,
            name=PLANNING_COLLECTION_NAME,
            icon=PLANNING_COLLECTION_ICON,
            color="",
            order=0,
            is_expanded=True,
            created_by=user,
        )
        return coll
    except IntegrityError:
        coll = (
            Collection.objects
            .filter(host_q, system_key=PLANNING_COLLECTION_SYSTEM_KEY)
            .first()
        )
        if coll:
            return coll
        logger.warning(
            "[PlanService] IntegrityError 后重查仍未找到 planning Collection space=%s",
            space_id,
        )
        return None
    except Exception:
        logger.warning(
            "[PlanService] 兜底创建 planning Collection 失败 space=%s（继续走，不阻塞 Plan 创建）",
            space_id,
            exc_info=True,
        )
        return None


def _bind_context_item_to_collection(document: Document, collection: Optional[Collection]) -> None:
    """把 Plan 文档对应的 ContextItem 移动到目标 Collection 下。

    ContextItem 由 ``ResourceBridge.on_create`` 在 transaction.on_commit 时创建，
    本函数应在 commit 之后调用（PlanService.create_plan 的实现就是这样安排的）。
    """
    if not collection:
        return
    try:
        if document.space_id:
            host_q = asset_host_q(document.space_id)
        elif document.organization_id:
            host_q = asset_host_q(organization_id=document.organization_id)
        else:
            return
        item = (
            ContextItem.objects
            .filter(
                host_q,
                item_type=document.get_context_type(),
                resource_id=str(document.id),
            )
            .first()
        )
        if not item:
            logger.warning(
                "[PlanService] Plan 文档的 ContextItem 尚未生成 doc=%s，跳过 collection 绑定",
                document.id,
            )
            return
        if str(item.collection_id or "") == str(collection.id):
            return
        item.collection_id = collection.id
        item.save(update_fields=["collection_id", "updated_at"])
        logger.info(
            "[PlanService] Plan 文档 ContextItem 绑定到 Collection: doc=%s collection=%s",
            document.id, collection.id,
        )
    except Exception:
        logger.warning(
            "[PlanService] 绑定 ContextItem 到 Collection 失败 doc=%s",
            document.id,
            exc_info=True,
        )


# ── 主 Service ──


class PlanService:
    """Plan 文档生命周期服务（Wave 1-C）。"""

    def __init__(self, user) -> None:
        if user is None:
            raise PlanServiceError("PLAN_NO_USER", "PlanService 必须携带 user", status=401)
        self.user = user
        self._doc_service = DocumentService(user=user)

    # ── plan_create ──

    def create_plan(
        self,
        *,
        organization_id: str,
        space_id: Optional[str] = None,
        name: str,
        overview: str = "",
        plan_markdown: str = "",
        todos: Optional[List[Any]] = None,
        is_project: bool = False,
        phases: Optional[List[Any]] = None,
        agent_mode_at_create: str = "plan",
        session_id: str = "",
        agent_id: str = "",
        allowed_prompts: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """创建一份 Plan 文档。

        返回 ``{"document": Document, "plan": PlanProperties, "collection_id": str|None}``。
        ：只挂 Organization；``space_id`` 废弃忽略；不挂规划 Collection
        （Collection 仍要求 Workspace/Project 宿主）。
        """
        if not organization_id:
            raise PlanServiceError("PLAN_MISSING_SCOPE", "organization_id 必填")
        if space_id:
            logger.info(
                "create_plan: ignoring deprecated space_id=%s (org-only )",
                space_id,
            )

        normalized_todos = _normalize_todos(todos)
        try:
            plan_props = PlanProperties(
                status="draft",
                session_id=session_id or "",
                agent_id=agent_id or "",
                agent_mode_at_create=agent_mode_at_create or "plan",
                name=name,
                overview=overview or "",
                is_project=bool(is_project),
                phases=phases or [],
                todos=normalized_todos,
                allowed_prompts=allowed_prompts or [],
            )
        except Exception as exc:
            raise PlanServiceError(
                "PLAN_INVALID_INPUT", f"plan 字段校验失败：{exc}"
            ) from exc

        pm_json, final_markdown, plaintext = _build_initial_pm_json(
            plan_props, plan_markdown
        )

        with transaction.atomic(using="postgresql"):
            try:
                document = self._doc_service.create_document(
                    organization_id=organization_id,
                    parent_id=None,
                    title=plan_props.name,
                    initial_content_pm_json=pm_json,
                    initial_content_markdown=final_markdown,
                    initial_content_plaintext=plaintext,
                )
            except PermissionError as exc:
                raise PlanServiceError("PLAN_PERMISSION_DENIED", str(exc), status=403) from exc
            except ValueError as exc:
                raise PlanServiceError("PLAN_INVALID_INPUT", str(exc)) from exc

            tags = list(document.tags or [])
            if PLAN_DOCUMENT_TAG not in tags:
                tags.append(PLAN_DOCUMENT_TAG)
            document.tags = tags
            document.properties = plan_props.to_document_properties(document.properties)
            document.save(update_fields=["tags", "properties", "updated_at"])

            # ：Plan 不再挂 Space，规划 Collection 暂不绑定
            collection = None
            collection_id = None

            _doc_for_commit = document
            _coll_for_commit = collection

            def _post_commit():
                _bind_context_item_to_collection(_doc_for_commit, _coll_for_commit)
                # ContextItem 已经被 ResourceBridge.on_create 写出来了；
                # 这里再走一次 on_update 推一次 metadata（tags/properties 已变化），
                # 让搜索向量 / WS 推送拿到最新快照。
                ResourceBridge.on_update(_doc_for_commit, user=self.user)

            transaction.on_commit(_post_commit, using="postgresql")

        return {
            "document": document,
            "plan": plan_props,
            "collection_id": collection_id,
        }

    # ── plan_update_todos ──

    def update_todos(
        self,
        *,
        plan_document_id: str,
        todos: List[Any],
        merge: bool = True,
    ) -> Dict[str, Any]:
        """更新 Plan 文档的 todos（draft 状态校验）。

        - ``merge=True``: 按 id 合并；新 id 追加，已有 id 局部覆盖（content / status / 都可）；
        - ``merge=False``: 全量替换 ``properties.plan.todos``。

        正文 TaskList 的 ``checked`` 状态会按 ``attrs.todoId`` 同步；找不到对应
        taskItem 的 todo 不会自动追加新节点（避免破坏用户在 draft 期手动整理过的正文）。
        """
        normalized_todos = _normalize_todos(todos)

        with transaction.atomic(using="postgresql"):
            document = self._load_plan_document(plan_document_id, required_role="editor")
            plan_props = PlanProperties.from_document(document)

            if plan_props.status != "draft":
                raise PlanServiceError(
                    "PLAN_NOT_DRAFT",
                    f"Plan 已是 {plan_props.status} 状态，不允许更新 todos",
                    status=409,
                )

            if merge:
                existing_by_id: Dict[str, PlanTodo] = {t.id: t for t in plan_props.todos}
                for todo in normalized_todos:
                    existing_by_id[todo.id] = todo
                final_todos = list(existing_by_id.values())
            else:
                final_todos = list(normalized_todos)

            plan_props.todos = final_todos
            new_properties = plan_props.to_document_properties(document.properties)
            document.properties = new_properties

            pm_json = document.description_json or {}
            todos_by_id = {t.id: t for t in final_todos}
            content_changed = isinstance(pm_json, dict) and _sync_task_list_checked(
                pm_json, todos_by_id, final_todos
            )

            update_fields = ["properties", "updated_at"]
            if content_changed:
                document.description_json = pm_json
                document.description_markdown = pm_json_to_markdown(pm_json) or document.description_markdown
                document.description_plaintext = _extract_plaintext(pm_json) or document.description_plaintext
                update_fields.extend(
                    ["description_json", "description_markdown", "description_plaintext"]
                )

            document.save(update_fields=update_fields)

            _doc_for_commit = document
            transaction.on_commit(
                lambda: ResourceBridge.on_update(_doc_for_commit, user=self.user),
                using=postgres_app_db_alias(),
            )

        return {
            "document": document,
            "plan": plan_props,
            "todos_after_update": [t.model_dump(mode="json") for t in plan_props.todos],
        }

    # ── plan_exit 已删除──
    #
    # plan 的「执行 / 结算」不再是后端状态机——改由客户端点击 PlanProposalCard
    # 「执行」按钮（切 agent 模式 + 用 plan_ref/快照拼继续消息）。云端 TabDocPlanStore
    # 仅保留 create / update_todos。draft/approved/rejected 审批状态机随之移除。

    # ── 内部 ──

    def _load_plan_document(self, plan_document_id: str, *, required_role: str) -> Document:
        try:
            document = self._doc_service.get_document(
                plan_document_id, required_role=required_role
            )
        except PermissionError as exc:
            raise PlanServiceError("PLAN_PERMISSION_DENIED", str(exc), status=403) from exc
        except ValueError as exc:
            raise PlanServiceError("PLAN_NOT_FOUND", str(exc), status=404) from exc

        # 必须确实是 Plan 文档（携带 plan tag 或 properties.plan）
        tags = document.tags or []
        has_plan_tag = PLAN_DOCUMENT_TAG in tags
        has_plan_props = isinstance(document.properties, dict) and isinstance(
            document.properties.get("plan"), dict
        )
        if not (has_plan_tag or has_plan_props):
            raise PlanServiceError(
                "PLAN_NOT_A_PLAN",
                "目标文档不是一个 Plan 文档",
                status=400,
            )
        return document


__all__ = [
    "PlanService",
    "PlanServiceError",
    "TodosMergeMode",
]

"""跨库软引用通用基础设施（v0.1 宪法 §5.1 落地 + 收尾迭代）。

== 为什么需要 ==

TabTin 双库（MySQL default + PostgreSQL）下，跨库 ``ForeignKey(to='other_app.X')``
会有三层雷：

1. **DB router 拒绝赋值**：``router.allow_relation(local, foreign)`` 默认拒绝跨库
   关系，``ChatSession.objects.create(current_model=instance)`` 抛 ``ValueError:
   the current database router prevents this relation``。
2. **Cascade delete 跨库查询**：``Foo.delete()`` 触发 Django Collector 用本库 alias
   反向查 FK 引用方，引用方表在另一个库 → ``ProgrammingError: Table doesn't exist``。
3. **物理 FK 约束遗留**：``db_constraint=False`` 只控制后续 schema 生成，对存量
   FK 物理约束 noop（Django 已知缺陷），INSERT 时仍会被 MySQL/PG 拒绝。

== 治理模式 ==

把跨库 FK 一律退化为 ``UUIDField`` 软引用 + 描述符 accessor：

- **写入**：用 ``foo.target_id = instance.id``（不能 ``foo.target = instance``）
- **读取**：``foo.target.field`` 链式访问仍可工作（描述符懒查询）
- **批量预加载**：列表场景调 ``attach_*`` helper，把 N 条 ID 一次查完注入缓存
- **cascade 语义**：原 ``on_delete=SET_NULL/CASCADE`` 的语义由调用方在 ``post_delete``
  signal 里手动维护——本模块提供 ``install_softref_cascade()`` 一行注册

== 一体化 API ==

::

    # apps/scheduler/models.py
    from apps.services.common.cross_db_softref import make_softref_property

    class GoalRun(models.Model):
        chat_session_id = models.UUIDField(null=True, blank=True, db_index=True)
        # ↓ 描述符自动注册到 SoftRefRegistry（reconcile / 体检自动可见）
        chat_session = make_softref_property(
            target_model='conversation.ChatSession',
            cache_attr='_cached_chat_session',
            id_attr='chat_session_id',
        )

    # apps/scheduler/services/chat_session_loader.py
    from apps.services.common.cross_db_softref import make_attach_helper

    attach_chat_sessions_to_goal_runs = make_attach_helper(
        target_model='conversation.ChatSession',
        cache_attr='_cached_chat_session',
        id_attr='chat_session_id',
        name='attach_chat_sessions_to_goal_runs',
    )

    # apps/tracker/signals.py
    from apps.services.common.cross_db_softref import install_softref_cascade

    install_softref_cascade(
        target_model='conversation.ChatSession',
        holder_app_label='tracker',
        holder_model='TrackerRun',
        id_attr='chat_session_id',
        action='set_null',                 # 'set_null' | 'soft_delete'
        log_prefix='[tracker]',
    )

== Telemetry / 防 N+1 ==

描述符单点 fallback fetch（"忘了调 attach helper"）会打 ``logger.warning``，但
**带 5 分钟去重**——同 ``(model, cache_attr)`` 5 分钟内只 log 一次，避免生产刷屏。

``TABTIN_SOFTREF_STRICT=1`` 环境变量可让 fallback 直接 raise，CI 跑测试时打开
能逼出所有未走预加载的列表场景。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Iterable, Sequence


__all__ = [
    "SOFTREF_CACHE_MISSING",
    "SoftRefSpec",
    "SoftRefRegistry",
    "make_softref_property",
    "make_attach_helper",
    "install_softref_cascade",
    "set_softref_cache",
    "fetch_softref_targets_map",
    "resolve_softref",
]


logger = logging.getLogger(__name__)


# 哨兵：区分"未注入缓存" vs "已注入缓存为 None"。
# 批量场景 ``attach_*`` helper 没匹配到目标 ID 时显式注入 None（"已查过、确定不存在"），
# 跟"还没查过"是两个语义——用 sentinel object 区分，避免重复 fetch。
SOFTREF_CACHE_MISSING = object()


# 开发期严格模式。CI 里 ``TABTIN_SOFTREF_STRICT=1`` 时单点 fallback 直接 raise，
# 逼出所有"忘了调 attach helper"的列表场景。生产 / 默认 dev 关闭。
_STRICT_ENV = "TABTIN_SOFTREF_STRICT"

# Fallback warning 去重：同 (model, cache_attr) 5 分钟内只 log 一次。
# 生产路径如果有遗漏 attach helper 的列表场景会刷屏，去重后既能定位又不淹没日志。
_FALLBACK_LOG_TTL_SECONDS = 300
_fallback_log_seen: dict[tuple[str, str], float] = {}
_fallback_log_lock = threading.Lock()


def _normalize_id(raw: Any) -> str | None:
    """把 UUID / str / 空值都归一化成 str | None。"""
    if raw is None or raw == "":
        return None
    return str(raw)


def _resolve_target_model(target_model: str):
    """``'app_label.ModelName'`` → Model 类，延迟解析避免循环 import。"""
    from django.apps import apps as django_apps

    if "." not in target_model:
        raise ValueError(
            f"target_model must be 'app_label.ModelName', got {target_model!r}"
        )
    app_label, model_name = target_model.split(".", 1)
    return django_apps.get_model(app_label, model_name)


# ════════════════════════════════════════════════════════════════════════════
#  SoftRefRegistry —— 所有跨库软引用的中央注册表
# ════════════════════════════════════════════════════════════════════════════
#
# 价值：让所有 softref 可发现、可枚举、可校验。基于它可以做：
#   1. ``reconcile_softrefs`` 命令：周期扫描悬空 ID 兜底
#   2. ``[softref_no_cascade]`` 体检：验证每个 softref 都注册了 cascade signal
#   3. 文档生成 / 审计报表 / 影响面分析
#
# 注册时机：
#   - 描述符 ``_SoftRefDescriptor.__set_name__`` 在 model class 创建时自动注册
#     一份"基本 spec"（不知道 cascade action）。
#   - ``install_softref_cascade(...)`` 调用时回填 ``on_orphan_action`` 等字段。


@dataclass(frozen=True)
class SoftRefSpec:
    """单条跨库软引用的元信息。"""

    holder_app: str
    """声明 softref 的 app_label，如 ``'tracker'``。"""

    holder_model: str
    """声明 softref 的 model 类名，如 ``'GoalRun'``。"""

    holder_db_table: str
    """声明 softref 的 model 物理表名，如 ``'scheduler_goal_run'``。"""

    holder_db_alias: str
    """声明 softref 的 model 所在数据库 alias，如 ``'postgresql'``。"""

    attr_name: str
    """描述符挂载的属性名（链式访问入口），如 ``'chat_session'``。"""

    id_attr: str
    """UUIDField 字段名，如 ``'chat_session_id'``。"""

    cache_attr: str
    """实例缓存属性名，如 ``'_cached_chat_session'``。"""

    target_model: str
    """被引用方 ``'app_label.ModelName'``，如 ``'conversation.ChatSession'``。"""

    target_db_alias: str | None = None
    """被引用方所在数据库 alias，注册时延迟解析；初始 None 由 SoftRefRegistry 补齐。"""

    select_related: tuple[str, ...] = ()
    """attach helper 默认 select_related。"""

    on_orphan_action: str = "report_only"
    """悬空 ID 处理方式：``'report_only'`` / ``'set_null'`` / ``'soft_delete'`` / ``'cascade'``。

    默认 ``report_only``——只有调用 ``install_softref_cascade(...)`` 后才回填成
    实际的 cascade 动作。``[softref_no_cascade]`` 体检靠这个字段判断"是否漏注册"。
    """

    no_cascade_needed: bool = False
    """显式声明"该 softref 不需要 cascade signal"——比如 LLMModel 这种
    admin-managed metadata 引用，target 极少删、删了也无所谓。

    设这个 flag 后 ``[softref_no_cascade]`` 体检静默；不设的话所有 ``report_only``
    都会被体检报 WARNING（提示"是漏了还是有意？"）。
    """

    no_cascade_reason: str = ""
    """``no_cascade_needed=True`` 时必填的原因说明，文档化为什么不需要 cascade。"""

    soft_delete_set_fields: tuple[tuple[str, Any], ...] = ()
    """``soft_delete`` action 时 UPDATE 的字段列表（dict 不能放 frozen dataclass，用 tuple）。"""

    soft_delete_extra_filter: tuple[tuple[str, Any], ...] = ()
    """``soft_delete`` action 时额外的 filter 条件（避免重复软删）。"""

    @property
    def key(self) -> tuple[str, str]:
        """``(holder_db_table, id_attr)`` 联合键，用作 Registry 唯一索引。"""
        return (self.holder_db_table, self.id_attr)


class SoftRefRegistry:
    """所有 softref 的中央注册表（进程内单例）。

    线程安全：注册操作有锁；读操作返回快照。
    """

    _specs: dict[tuple[str, str], SoftRefSpec] = {}
    _lock = threading.Lock()

    @classmethod
    def register(cls, spec: SoftRefSpec) -> None:
        """登记 spec；同 key 重复登记 → 用新 spec 覆盖（app reload 友好）。"""
        with cls._lock:
            cls._specs[spec.key] = spec

    @classmethod
    def update_spec(cls, key: tuple[str, str], **changes: Any) -> SoftRefSpec | None:
        """对已登记 spec 做局部更新。返回新 spec；key 不存在返回 None。"""
        with cls._lock:
            existing = cls._specs.get(key)
            if existing is None:
                return None
            updated = replace(existing, **changes)
            cls._specs[key] = updated
            return updated

    @classmethod
    def get(cls, holder_db_table: str, id_attr: str) -> SoftRefSpec | None:
        """按 ``(holder_db_table, id_attr)`` 取 spec。"""
        return cls._specs.get((holder_db_table, id_attr))

    @classmethod
    def all_specs(cls) -> list[SoftRefSpec]:
        """返回所有 spec 的快照列表。"""
        with cls._lock:
            return list(cls._specs.values())

    @classmethod
    def by_holder(cls, holder_app: str) -> list[SoftRefSpec]:
        """按 holder_app 过滤。"""
        return [s for s in cls.all_specs() if s.holder_app == holder_app]


# ════════════════════════════════════════════════════════════════════════════
#  Resolve / fetch / attach 公共原语
# ════════════════════════════════════════════════════════════════════════════


def fetch_softref_targets_map(
    target_model: str,
    target_ids: Iterable[Any],
    *,
    select_related: Sequence[str] = (),
) -> dict[str, Any]:
    """按 ID 批量查目标模型，返回 ``{id_str: instance}`` 映射。

    ``select_related`` 默认空——但下游调用方建议带上常访问的关联（比如 LLMModel
    几乎都要 ``provider``），避免 attach 完毕后访问关联又触发 N+1。
    """
    cleaned: set[str] = set()
    for raw in target_ids:
        normalized = _normalize_id(raw)
        if normalized:
            cleaned.add(normalized)
    if not cleaned:
        return {}

    model_cls = _resolve_target_model(target_model)
    qs = model_cls.objects.filter(id__in=cleaned)
    if select_related:
        qs = qs.select_related(*select_related)
    return {str(obj.id): obj for obj in qs}


def _emit_fallback_warning(instance, cache_attr: str, target_model: str, raw_id: str) -> None:
    """Fallback fetch warning，带 5 分钟去重，避免生产刷屏。"""
    key = (type(instance).__name__, cache_attr)
    now = time.monotonic()
    with _fallback_log_lock:
        last = _fallback_log_seen.get(key)
        if last is not None and (now - last) < _FALLBACK_LOG_TTL_SECONDS:
            return
        _fallback_log_seen[key] = now
    logger.warning(
        "[softref] %s.%s cache miss → fallback fetch (target=%s, id=%s); "
        "use attach helper in batch path to avoid N+1 (logged once per %ds)",
        type(instance).__name__, cache_attr, target_model, raw_id,
        _FALLBACK_LOG_TTL_SECONDS,
    )


def resolve_softref(
    instance,
    *,
    target_model: str,
    cache_attr: str,
    id_attr: str,
    select_related: Sequence[str] = (),
):
    """单点 softref 解析（描述符 accessor 后端）。

    1. 命中已注入缓存（含显式 ``None``）→ 直接返回
    2. ``id_attr`` 为空 → 写回缓存 ``None`` 并返回（避免重复检查链路）
    3. strict 模式 env 开启 → 直接 raise（CI 暴露未走批量预加载）
    4. fallback 单点 ``filter(id=...).first()`` + ``setattr`` 写回缓存
    """
    cached = getattr(instance, cache_attr, SOFTREF_CACHE_MISSING)
    if cached is not SOFTREF_CACHE_MISSING:
        return cached

    raw_id = getattr(instance, id_attr, None)
    if not raw_id:
        setattr(instance, cache_attr, None)
        return None

    if os.environ.get(_STRICT_ENV) == "1":
        raise RuntimeError(
            f"[softref:strict] {type(instance).__name__}.{cache_attr} cache miss; "
            f"call attach helper before accessing soft-ref property in batch path"
        )

    _emit_fallback_warning(instance, cache_attr, target_model, str(raw_id))

    model_cls = _resolve_target_model(target_model)
    qs = model_cls.objects.filter(id=raw_id)
    if select_related:
        qs = qs.select_related(*select_related)
    obj = qs.first()
    setattr(instance, cache_attr, obj)
    return obj


# ════════════════════════════════════════════════════════════════════════════
#  Property 描述符（自动注册到 Registry）
# ════════════════════════════════════════════════════════════════════════════


class _SoftRefDescriptor:
    """跨库软引用描述符——替代 ``@property``，自动注册 SoftRefRegistry。

    用 ``__set_name__`` 在 model class 创建时拿到 owner class 完成注册——这是
    Python 3.6+ 描述符协议保证的，跟 Django metaclass 无冲突。

    只读：没 ``__set__``，业务侧 ``foo.chat_session = X`` 会抛 ``AttributeError``，
    强制走 ``foo.chat_session_id = X.id`` 的写入路径（这是有意设计，让代码
    搜索能立刻发现"还在用 FK 赋值"的遗留代码）。
    """

    def __init__(
        self,
        *,
        target_model: str,
        cache_attr: str,
        id_attr: str,
        select_related: Sequence[str] = (),
        no_cascade_needed: bool = False,
        no_cascade_reason: str = "",
    ):
        if no_cascade_needed and not no_cascade_reason:
            raise ValueError(
                "no_cascade_needed=True 必须同时给 no_cascade_reason 说明，"
                "便于体检/审计可读"
            )
        self.target_model = target_model
        self.cache_attr = cache_attr
        self.id_attr = id_attr
        self.select_related = tuple(select_related)
        self.no_cascade_needed = no_cascade_needed
        self.no_cascade_reason = no_cascade_reason
        self._attr_name: str | None = None  # 由 __set_name__ 填

    def __set_name__(self, owner, name: str) -> None:
        """Model class 创建后被 Python 自动调用。

        此刻 Django ``ModelBase`` 还在 ``__new__`` 内部、``_meta`` 尚未附加
        （Django 流程：``super().__new__()`` 触发 ``__set_name__`` → 元类附加
        ``_meta`` → 发 ``class_prepared`` signal）。所以注册必须延迟到
        ``class_prepared`` 之后才能拿到 ``_meta``。
        """
        self._attr_name = name

        from django.db.models.signals import class_prepared

        def _on_prepared(sender, **kwargs):
            if sender is not owner:
                return
            self._register_to_registry(owner)
            class_prepared.disconnect(_on_prepared, dispatch_uid=dispatch_uid)

        dispatch_uid = f"softref_register::{id(self)}::{name}"
        class_prepared.connect(
            _on_prepared, weak=False, dispatch_uid=dispatch_uid,
        )

        # 极少见 case：sender model 早已 prepared（比如热重载场景），signal 不会
        # 再触发——尝试立刻注册兜底（_meta 此时若已 ready 也直接走）。
        if getattr(owner, "_meta", None) is not None:
            try:
                _ = owner._meta.app_label  # noqa: F841 — 触发 lazy attr 校验
                self._register_to_registry(owner)
                class_prepared.disconnect(_on_prepared, dispatch_uid=dispatch_uid)
            except Exception:
                # _meta 还未完全 ready，等 class_prepared
                pass

    def _register_to_registry(self, owner) -> None:
        """实际注册到 SoftRefRegistry——owner._meta 必须已就绪。"""
        from django.db import router

        meta = owner._meta
        spec = SoftRefSpec(
            holder_app=meta.app_label,
            holder_model=owner.__name__,
            holder_db_table=meta.db_table,
            holder_db_alias=router.db_for_read(owner) or "default",
            attr_name=self._attr_name or "<unknown>",
            id_attr=self.id_attr,
            cache_attr=self.cache_attr,
            target_model=self.target_model,
            select_related=self.select_related,
            no_cascade_needed=self.no_cascade_needed,
            no_cascade_reason=self.no_cascade_reason,
        )
        SoftRefRegistry.register(spec)

    def __get__(self, instance, owner):
        if instance is None:
            return self  # 类访问返回描述符本身（便于内省）
        return resolve_softref(
            instance,
            target_model=self.target_model,
            cache_attr=self.cache_attr,
            id_attr=self.id_attr,
            select_related=self.select_related,
        )


def make_softref_property(
    *,
    target_model: str,
    cache_attr: str,
    id_attr: str,
    select_related: Sequence[str] = (),
    no_cascade_needed: bool = False,
    no_cascade_reason: str = "",
) -> _SoftRefDescriptor:
    """生成跨库软引用描述符（自动注册到 SoftRefRegistry）。

    用法（在 model class body 里）::

        class GoalRun(models.Model):
            chat_session_id = models.UUIDField(null=True, blank=True, db_index=True)
            chat_session = make_softref_property(
                target_model='conversation.ChatSession',
                cache_attr='_cached_chat_session',
                id_attr='chat_session_id',
            )

    返回的描述符只读（无 setter）——业务侧务必用 ``foo.chat_session_id = ...``
    赋值。这是有意设计：让代码搜索 ``foo.chat_session = `` 能立刻发现"还在用 FK
    赋值"的遗留代码。

    Args:
        no_cascade_needed: 显式声明"target 删除时 holder 不需要做任何清理"——
            适用于 metadata 引用（比如 ``LLMModel`` 这种 admin-managed，删除时
            holder 保留 stale ID 反而是审计需要）。设这个 flag 后
            ``[softref_no_cascade]`` 体检会静默；不设的话所有未注册
            ``install_softref_cascade`` 的 softref 都会被报 WARNING。
        no_cascade_reason: ``no_cascade_needed=True`` 时必填，文档化原因。
    """
    return _SoftRefDescriptor(
        target_model=target_model,
        cache_attr=cache_attr,
        id_attr=id_attr,
        select_related=select_related,
        no_cascade_needed=no_cascade_needed,
        no_cascade_reason=no_cascade_reason,
    )


def set_softref_cache(instance, cache_attr: str, value) -> None:
    """显式注入软引用缓存。

    适用场景：
    - 创建 instance 时已经手里有目标对象，避免 attach helper 再查一次
    - 测试 fixture 里手动注入避免 DB 写入
    """
    setattr(instance, cache_attr, value)


def make_attach_helper(
    *,
    target_model: str,
    cache_attr: str,
    id_attr: str,
    select_related: Sequence[str] = (),
    name: str | None = None,
) -> Callable[[Iterable], None]:
    """生成批量预加载 helper。

    Args:
        name: 显式覆盖 ``__name__``，避免 factory 自动名跟调用方变量名打架
            （比如赋给 ``attach_chat_sessions_to_goal_runs``，但 factory 自动名是
            ``attach_chatsession_via_chat_session_id``，traceback 时混乱）。

    用法（在 services 模块里）::

        attach_chat_sessions_to_goal_runs = make_attach_helper(
            target_model='conversation.ChatSession',
            cache_attr='_cached_chat_session',
            id_attr='chat_session_id',
            name='attach_chat_sessions_to_goal_runs',
        )

    Helper 行为：
    - 跳过已注入缓存的 instance（幂等，多次调用安全）
    - 一次 ``filter(id__in=...)`` 拿齐所有目标
    - 没匹配到的 ID 显式注入 ``None``（区分"未注入"），避免下次 access 又 fallback
    """

    def _attach(instances: Iterable) -> None:
        instances_list = list(instances)
        if not instances_list:
            return

        pending: list = []
        for inst in instances_list:
            if getattr(inst, cache_attr, SOFTREF_CACHE_MISSING) is SOFTREF_CACHE_MISSING:
                pending.append(inst)

        if not pending:
            return

        ids: set[str] = set()
        for inst in pending:
            normalized = _normalize_id(getattr(inst, id_attr, None))
            if normalized:
                ids.add(normalized)
        targets_map = fetch_softref_targets_map(
            target_model, ids, select_related=select_related,
        )

        for inst in pending:
            normalized = _normalize_id(getattr(inst, id_attr, None))
            setattr(
                inst, cache_attr,
                targets_map.get(normalized) if normalized else None,
            )

    _attach.__name__ = name or (
        f"attach_{target_model.split('.')[-1].lower()}_via_{id_attr}"
    )
    _attach.__doc__ = (
        f"Batch-load {target_model} for instances by `{id_attr}`, inject into "
        f"`{cache_attr}` cache (idempotent; safe to call multiple times)."
    )
    return _attach


# ════════════════════════════════════════════════════════════════════════════
#  Cascade signal factory —— 一行注册"target 删除时清理 holder"
# ════════════════════════════════════════════════════════════════════════════


_VALID_ACTIONS = frozenset({"set_null", "soft_delete", "cascade"})


def install_softref_cascade(
    *,
    target_model: str,
    holder_app_label: str,
    holder_model: str,
    id_attr: str,
    action: str,
    soft_delete_set_fields: dict | None = None,
    soft_delete_extra_filter: dict | None = None,
    log_prefix: str | None = None,
) -> Callable:
    """注册 ``target`` ``post_delete`` cascade 到 ``holder`` 的软引用清理。

    抽象 3 处重复 boilerplate（``scheduler/signals.py`` / ``chat/conversation/signals.py``
    / ``tabdata/signals.py``），统一行为：

    - **post_delete + transaction.on_commit**：跨库 update 不能在 pre_delete 阶段
      立刻执行——主事务回滚时对端库已经写入无法回滚（脏数据）。改用 post_delete
      捕获意图 + on_commit 在主事务真正 COMMIT 后才发对端库 SQL。
    - **异常仅 warning**：跨库 cleanup 失败不阻塞已 COMMIT 的 target 删除——孤儿
      数据由 ``reconcile_softrefs`` 周期任务兜底。
    - **action 三选一**：
        - ``set_null`` UPDATE ``id_attr=NULL``（holder 字段必须 nullable）
        - ``soft_delete`` UPDATE ``is_deleted=True, deleted_at=now()``（或自定义）
        - ``cascade`` 物理 ``DELETE`` holder 记录（用于"holder 是 target 子项"场景；
          ⚠️ 跨库 cascade 不可逆，主事务 rollback 后无法恢复——必须确保 target 删除
          路径是终态、不会回滚）
    - **回填 SoftRefRegistry**：本调用同时把 ``on_orphan_action`` 写回 spec，让
      ``[softref_no_cascade]`` 体检和 ``reconcile_softrefs`` 知道"该 softref 已有
      cascade 处理"+"悬空时该走什么动作"。

    Args:
        target_model: 被引用方 ``'app_label.ModelName'``，作为 signal sender。
        holder_app_label: 声明引用的 app_label。
        holder_model: 声明引用的 model 类名（同 holder_app_label 下）。
        id_attr: holder 上的 UUIDField 字段名。
        action: ``'set_null'`` / ``'soft_delete'`` / ``'cascade'``。
        soft_delete_set_fields: ``soft_delete`` 时 SET 的字段；缺省
            ``{'is_deleted': True, 'deleted_at': <now>}``。
        soft_delete_extra_filter: ``soft_delete`` 时额外 filter（如 ``{'is_deleted': False}``
            避免重复软删）；缺省 ``{}``。
        log_prefix: 日志前缀（如 ``'[scheduler]'``），便于按模块过滤。

    Returns:
        注册好的 receiver 函数（用于测试时 disconnect / 内省）。
    """
    if action not in _VALID_ACTIONS:
        raise ValueError(
            f"action must be one of {sorted(_VALID_ACTIONS)}, got {action!r}"
        )

    from django.db import transaction as _db_transaction
    from django.db.models.signals import post_delete

    prefix = log_prefix or f"[{holder_app_label}]"

    def _receiver(sender, instance, **kwargs):
        target_id = instance.id

        def _do_cascade():
            try:
                from django.apps import apps as django_apps
                from django.utils import timezone as _tz

                holder_cls = django_apps.get_model(holder_app_label, holder_model)
                base_qs = holder_cls.objects.filter(**{id_attr: target_id})

                if action == "set_null":
                    affected = base_qs.update(**{id_attr: None})
                    if affected:
                        logger.info(
                            "%s cleared %s on %d %s(s) for deleted %s %s",
                            prefix, id_attr, affected, holder_model,
                            target_model, target_id,
                        )
                elif action == "soft_delete":
                    extra_filter = soft_delete_extra_filter or {}
                    if extra_filter:
                        base_qs = base_qs.filter(**extra_filter)
                    set_fields = soft_delete_set_fields or {
                        "is_deleted": True,
                        "deleted_at": _tz.now(),
                    }
                    # 如果调用方传了 set_fields 但其中含 callable，调用一次拿当前值
                    resolved_set = {
                        k: (v() if callable(v) else v) for k, v in set_fields.items()
                    }
                    affected = base_qs.update(**resolved_set)
                    if affected:
                        logger.info(
                            "%s soft-deleted %d %s(s) for deleted %s %s",
                            prefix, affected, holder_model,
                            target_model, target_id,
                        )
                else:  # cascade —— 物理删 holder 记录
                    affected, _ = base_qs.delete()
                    if affected:
                        logger.info(
                            "%s cascade-deleted %d %s(s) for deleted %s %s",
                            prefix, affected, holder_model,
                            target_model, target_id,
                        )
            except Exception:
                logger.warning(
                    "%s failed to cascade %s.%s for deleted %s %s; "
                    "orphan IDs will stay until reconcile_softrefs run",
                    prefix, holder_model, id_attr, target_model, target_id,
                    exc_info=True,
                )

        _db_transaction.on_commit(_do_cascade)

    # 显式 dispatch_uid，避免重复注册（多进程 / app reload 场景）
    dispatch_uid = (
        f"softref_cascade::{target_model}::{holder_app_label}.{holder_model}.{id_attr}"
    )
    post_delete.connect(_receiver, sender=target_model, weak=False, dispatch_uid=dispatch_uid)

    # 回填 SoftRefRegistry——descriptor 已经注册了 spec，这里更新 on_orphan_action
    # holder_db_table 我们这里不知道（model 可能还没 ready），用 lazy lookup
    def _backfill_registry():
        try:
            from django.apps import apps as django_apps

            holder_cls = django_apps.get_model(holder_app_label, holder_model)
            spec = SoftRefRegistry.get(holder_cls._meta.db_table, id_attr)
            if spec is None:
                logger.warning(
                    "[softref] install_softref_cascade: %s.%s not registered in "
                    "SoftRefRegistry (forgot make_softref_property?)",
                    holder_model, id_attr,
                )
                return
            kwargs: dict[str, Any] = {"on_orphan_action": action}
            if action == "soft_delete":
                if soft_delete_set_fields:
                    kwargs["soft_delete_set_fields"] = tuple(
                        soft_delete_set_fields.items()
                    )
                if soft_delete_extra_filter:
                    kwargs["soft_delete_extra_filter"] = tuple(
                        soft_delete_extra_filter.items()
                    )
            SoftRefRegistry.update_spec(spec.key, **kwargs)
        except Exception:
            logger.warning(
                "[softref] failed to backfill SoftRefRegistry for %s.%s",
                holder_model, id_attr, exc_info=True,
            )

    # apps.ready() 后再 backfill，避免 model 还没 ready
    from django.apps import apps as _apps
    if _apps.ready:
        _backfill_registry()
    else:
        # 极少见 case：signals.py 在 apps.ready 之前 import。
        # 用 connection 钩子延迟到第一次 DB 访问时执行。
        from django.db.backends.signals import connection_created
        connection_created.connect(
            lambda **_kw: _backfill_registry(),
            weak=False,
            dispatch_uid=dispatch_uid + "::backfill",
        )

    return _receiver

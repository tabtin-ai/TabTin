"""Checkpoint 资源 / 影响范围 贡献者协议与注册中心 (W0-1 CC-2 / CC-3)。

Charter §3.2 / §3.3：Checkpoint 模块在创建 SpaceCheckpoint 与构建
``checkpoint_context.impact`` 时，回调"已注册的模块贡献者"收集本轮 turn
内变更过的资源 id 与影响摘要，避免 tabdata / tabdoc / tabdesign 等模块
反向调用 Checkpoint 模块（D2 协议方向）。

设计要点
--------

1. **协议方向（D2）**：Checkpoint 模块向下调用模块贡献者；模块只实现
   ``ResourceContributor`` / ``ImpactContributor`` 协议并在 Django App
   ``ready()`` 时自行注册，不会反向 import Checkpoint 模块的 SpaceCheckpoint
   或 enrich_checkpoint_for_creation。

2. **隔离性**：单个 contributor 抛出异常 / 返回非法结构时，仅打 warning，
   不影响其他 contributor 收集，也不阻断 Checkpoint 创建主链路。

3. **向后兼容**：没有 contributor 注册时，``collect_contributed_resources``
   返回空 list，``collect_contributed_impact`` 返回空 dict——既有
   ContextItem 路径 / build_checkpoint_impact 既有维度完全不变。

4. **注册中心轻量**：参考 ``apps/collab/registry.py``（adapter 注册）的
   单进程模式 + ``RLock`` 守护，避免测试场景并发 register/clear 出现 dict 改动竞态。

5. **W0-1 范围**：本文件只定义协议 + 注册中心 + 收集器。具体的
   ``TableResourceContributor`` / ``TableImpactContributor`` 实现属于
   Wave 1 TD-2 / TD-3 范围，不在本次提交。
"""
from __future__ import annotations

import logging
import threading
from typing import (
    Any,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Protocol,
    TypedDict,
    runtime_checkable,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ResourceRef",
    "ResourceContributor",
    "ImpactContributor",
    "register_resource_contributor",
    "register_impact_contributor",
    "unregister_resource_contributor",
    "unregister_impact_contributor",
    "iter_resource_contributors",
    "iter_impact_contributors",
    "_clear_resource_contributors",
    "_clear_impact_contributors",
    "collect_contributed_resources",
    "collect_contributed_impact",
    "expand_agent_run_ids",
]


class ResourceRef(TypedDict):
    """模块贡献者返回的资源版本锚点。

    Charter §3.2：Checkpoint 模块把这些条目合并入 ``SpaceCheckpoint.version_refs``，
    保证回滚 (``restore_to_version``) 时能按 ``resource_type:resource_id`` 路由到
    对应 adapter.restore()。

    字段：
        resource_type: ``"table" / "docs" / "design" / ...``，与 collab.constants.RESOURCE_TYPES 对齐。
        resource_id: UUID 字符串，对应模块的主资源 ID（table_id / document_id / ...）。
        version_history_id: UUID 字符串，``VersionHistory.id``——本轮 turn 实际写入的版本。
    """

    resource_type: str
    resource_id: str
    version_history_id: str


@runtime_checkable
class ResourceContributor(Protocol):
    """资源贡献者协议（CC-2）。

    模块实现该协议后通过 :func:`register_resource_contributor` 注册，
    Checkpoint 创建钩子（``daemon_checkpoint_service._create_space_checkpoint``）
    会调用 ``collect_resources`` 拿到本轮 turn 涉及的资源版本锚点，并
    合并入 ``SpaceCheckpoint.version_refs``。

    属性:
        name: 用于日志识别（如 ``"tabdata"``）。**不**用作 dict key
            （ResourceContributor 的输出按 ``resource_type:resource_id``
            合并入 version_refs，无需模块名）。

    方法:
        collect_resources(agent_run_ids): 给定本轮 turn 涉及的所有
            agent_run_id（含子 Agent 级联），返回这些 run 改过的
            ``ResourceRef`` 列表。返回空 list 表示"本 turn 模块无变更"。
            **不允许返回 None**——空集合用空 list 表示。
    """

    name: str

    def collect_resources(self, agent_run_ids: List[str]) -> List[ResourceRef]:
        ...


@runtime_checkable
class ImpactContributor(Protocol):
    """影响范围贡献者协议（CC-3）。

    模块实现该协议后通过 :func:`register_impact_contributor` 注册，
    ``build_checkpoint_impact`` 会调用 ``collect_impact`` 拿到模块维度的
    影响摘要，按 ``contributor.name`` 作为 dict key 合并到输出 ``impact``
    中（如 ``impact['tabdata'] = {...}``）。

    属性:
        name: **必需**，作为 ``impact`` 输出 dict 的 key。建议使用模块短名
            （``"tabdata" / "tabdoc" / "tabdesign"``）。两个 contributor 用
            相同 name 注册时，后者覆盖前者并打 warning。

    方法:
        collect_impact(agent_run_ids): 给定本轮 turn 涉及的所有 agent_run_id，
            返回模块维度的影响摘要 dict 或 None。返回 None / 空 dict 时，
            Checkpoint 模块会忽略该模块——``impact`` 输出不会包含该模块的 key。
    """

    name: str

    def collect_impact(self, agent_run_ids: List[str]) -> Optional[Mapping[str, Any]]:
        ...


# ── 注册中心 ───────────────────────────────────────────────

_resource_contributors: Dict[str, ResourceContributor] = {}
_impact_contributors: Dict[str, ImpactContributor] = {}
_lock = threading.RLock()


def _coerce_name(contributor: Any, fallback: str) -> str:
    """提取 contributor.name 并做防御性校验。"""
    name = getattr(contributor, "name", None)
    if not isinstance(name, str) or not name:
        raise ValueError(
            f"{fallback} must define a non-empty 'name' attribute "
            f"(got {name!r} from {type(contributor).__name__})"
        )
    return name


def register_resource_contributor(contributor: ResourceContributor) -> None:
    """注册资源贡献者。

    通常在模块的 ``AppConfig.ready()`` 中调用。重名注册会覆盖前者并打
    warning（与 :func:`apps.collab.registry.register_adapter` 行为一致）。

    使用范例（Wave 1 TD-2 实施时使用）::

        # apps/tabdata/apps.py
        class TabdataConfig(AppConfig):
            def ready(self):
                from apps.collab.services.contributors import register_resource_contributor
                from apps.tabdata.contributors import TableResourceContributor
                register_resource_contributor(TableResourceContributor())
    """
    name = _coerce_name(contributor, "ResourceContributor")
    with _lock:
        if name in _resource_contributors:
            logger.warning(
                "Overriding ResourceContributor with name=%s (was %s, now %s)",
                name,
                type(_resource_contributors[name]).__name__,
                type(contributor).__name__,
            )
        _resource_contributors[name] = contributor
    logger.info(
        "Registered ResourceContributor: name=%s class=%s",
        name, type(contributor).__name__,
    )


def register_impact_contributor(contributor: ImpactContributor) -> None:
    """注册影响范围贡献者。

    与 :func:`register_resource_contributor` 对称——通常在 ``AppConfig.ready()``
    中调用。``contributor.name`` 直接作为 ``impact`` 输出 dict 的 key，
    建议用模块短名（``"tabdata" / "tabdoc" / "tabdesign"``）以便前端按统一
    schema 渲染。
    """
    name = _coerce_name(contributor, "ImpactContributor")
    with _lock:
        if name in _impact_contributors:
            logger.warning(
                "Overriding ImpactContributor with name=%s (was %s, now %s)",
                name,
                type(_impact_contributors[name]).__name__,
                type(contributor).__name__,
            )
        _impact_contributors[name] = contributor
    logger.info(
        "Registered ImpactContributor: name=%s class=%s",
        name, type(contributor).__name__,
    )


def unregister_resource_contributor(name: str) -> None:
    """移除已注册的资源贡献者；name 不存在时静默返回。

    主要供测试使用——生产路径上 contributor 在 ``AppConfig.ready()`` 注册
    后通常不需要再移除。
    """
    with _lock:
        _resource_contributors.pop(name, None)


def unregister_impact_contributor(name: str) -> None:
    """移除已注册的影响范围贡献者；name 不存在时静默返回。"""
    with _lock:
        _impact_contributors.pop(name, None)


def iter_resource_contributors() -> List[ResourceContributor]:
    """返回当前已注册的资源贡献者列表（按注册顺序的快照）。"""
    with _lock:
        return list(_resource_contributors.values())


def iter_impact_contributors() -> List[ImpactContributor]:
    """返回当前已注册的影响范围贡献者列表（按注册顺序的快照）。"""
    with _lock:
        return list(_impact_contributors.values())


def _clear_resource_contributors() -> None:
    """清空所有资源贡献者；**仅供测试使用**（前缀下划线表 private）。"""
    with _lock:
        _resource_contributors.clear()


def _clear_impact_contributors() -> None:
    """清空所有影响范围贡献者；**仅供测试使用**（前缀下划线表 private）。"""
    with _lock:
        _impact_contributors.clear()


# ── 级联 run id 展开（W0-1 修复 P0-B：daemon/HTTP/build_checkpoint_impact 统一展开） ──


def expand_agent_run_ids(agent_run_id: str) -> List[str]:
    """把单个主 ``agent_run_id`` 展开为含子 Agent 级联的全量 run id 列表。

    Charter §3.2 规定 contributor 应该接收"含子 Agent 级联"的 run id；
    daemon / HTTP / ``build_checkpoint_impact`` 三个调用方在调用 :func:`collect_contributed_resources`
    或 :func:`collect_contributed_impact` 之前都应统一调用本函数，避免协议契约
    与实际传值不一致——否则 contributor 实现者按文档假设级联已展开会漏掉子 Agent
    写入的资源。

    Fail-safe 行为：``_resolve_cascading_run_ids`` 失败时回退到 ``[agent_run_id]``，
    保证 contributor 至少能拿到主 run id；空 ``agent_run_id`` 直接返回空 list。

    与 :func:`apps.collab.services.checkpoint_context.build_checkpoint_impact` 的
    ``all_run_ids`` 路径完全对称（同样的 fail-safe 退回逻辑）。
    """
    if not agent_run_id:
        return []
    try:
        from apps.collab.api import _resolve_cascading_run_ids
        return _resolve_cascading_run_ids(agent_run_id)
    except Exception:
        logger.debug(
            "expand_agent_run_ids: _resolve_cascading_run_ids failed, "
            "falling back to single run_id=%s",
            agent_run_id, exc_info=True,
        )
        return [agent_run_id]


# ── 收集器 ────────────────────────────────────────────────


def _normalize_resource_ref(raw: Any) -> Optional[ResourceRef]:
    """把 contributor 返回的条目规范化为 :class:`ResourceRef`。

    宽松接受 dict / dataclass / Mapping，但严格要求 3 个字段都为非空字符串。
    任一字段缺失 / 类型不对则返回 None（调用方会丢弃并打 debug 日志），
    避免一个坏数据污染整张 ``version_refs``。
    """
    if isinstance(raw, Mapping):
        rt = raw.get("resource_type")
        rid = raw.get("resource_id")
        vid = raw.get("version_history_id")
    else:
        rt = getattr(raw, "resource_type", None)
        rid = getattr(raw, "resource_id", None)
        vid = getattr(raw, "version_history_id", None)
    if not (isinstance(rt, str) and rt
            and isinstance(rid, str) and rid
            and isinstance(vid, str) and vid):
        return None
    return {
        "resource_type": rt,
        "resource_id": rid,
        "version_history_id": vid,
    }


def collect_contributed_resources(
    agent_run_ids: Iterable[str],
) -> List[ResourceRef]:
    """调用所有已注册的 :class:`ResourceContributor` 并合并去重。

    供 ``daemon_checkpoint_service._create_space_checkpoint`` 在创建
    SpaceCheckpoint **前** 调用——返回的列表会被合并入 ``version_refs``。

    隔离策略：
        - 单 contributor 抛异常 → 仅 warning，跳过该 contributor 继续其他。
        - 单 contributor 返回非法条目（缺字段 / 类型错） → 跳过该条目并 debug 日志。
        - 同 ``(resource_type, resource_id)`` 重复出现 → 后注册的 contributor
          覆盖前者（与 ``dict.update`` 一致）。这通常意味着两个模块都声称
          拥有同一资源，是 contributor 实现 bug，按"后到为准"处理避免静默丢失。

    向后兼容：
        - 没有任何 contributor 注册时 → 返回空 list，调用方 SpaceCheckpoint
          创建路径行为完全不变。
    """
    run_ids = [rid for rid in agent_run_ids if isinstance(rid, str) and rid]
    contributors = iter_resource_contributors()
    if not contributors:
        return []

    merged: Dict[str, ResourceRef] = {}
    for contributor in contributors:
        contributor_name = getattr(contributor, "name", type(contributor).__name__)
        try:
            raw_refs = contributor.collect_resources(run_ids)
        except Exception:
            # 隔离 contributor 异常：与 InProcessEventBus.publish 同源思路，
            # 但 W0-1 用 warning + extra 让运维监控更易识别"丢锚点"事件。
            logger.warning(
                "ResourceContributor.collect_resources failed (isolated): name=%s",
                contributor_name,
                exc_info=True,
                extra={
                    "contributor_failure": True,
                    "contributor_kind": "resource",
                    "contributor_name": contributor_name,
                    "agent_run_ids": run_ids,
                },
            )
            continue
        if not raw_refs:
            continue
        for raw in raw_refs:
            ref = _normalize_resource_ref(raw)
            if ref is None:
                logger.warning(
                    "ResourceContributor returned malformed ref (skipped): "
                    "name=%s raw=%r",
                    contributor_name, raw,
                    extra={
                        "contributor_malformed": True,
                        "contributor_kind": "resource",
                        "contributor_name": contributor_name,
                    },
                )
                continue
            key = f"{ref['resource_type']}:{ref['resource_id']}"
            merged[key] = ref
    return list(merged.values())


def collect_contributed_impact(
    agent_run_ids: Iterable[str],
) -> Dict[str, Mapping[str, Any]]:
    """调用所有已注册的 :class:`ImpactContributor` 并按模块名归类。

    供 ``checkpoint_context.build_checkpoint_impact`` 在拼装 ``impact`` dict 时
    调用——返回的 dict 会按 ``contributor.name`` 作为 key 合并入 ``impact``。

    返回示例（注册了 tabdata + tabdoc 两个 contributor 时）::

        {
            "tabdata": {"tables_affected": [...]},
            "tabdoc":  {"documents_affected": [...]},
        }

    隔离策略：
        - 单 contributor 抛异常 → 仅 warning，跳过该 contributor 继续其他。
        - 单 contributor 返回 None 或非 Mapping 或空 Mapping → 跳过该 contributor
          （不在输出 dict 中包含该模块 key），保持向后兼容。

    向后兼容：
        - 没有任何 contributor 注册时 → 返回空 dict，``build_checkpoint_impact``
          不会在 ``impact`` 中添加任何模块键。
    """
    run_ids = [rid for rid in agent_run_ids if isinstance(rid, str) and rid]
    contributors = iter_impact_contributors()
    if not contributors:
        return {}

    # 注：``output`` 不需要做 same-name collision 检查——``_impact_contributors``
    # 注册中心已用 ``name`` 作为 dict key，``iter_impact_contributors`` 返回的
    # values() 不可能包含重名 contributor。重名注册时早在 register 阶段就被
    # warning + override 兜住。
    output: Dict[str, Mapping[str, Any]] = {}
    for contributor in contributors:
        contributor_name = getattr(contributor, "name", type(contributor).__name__)
        try:
            data = contributor.collect_impact(run_ids)
        except Exception:
            # 与 ResourceContributor 同源的隔离 + 结构化日志策略。
            logger.warning(
                "ImpactContributor.collect_impact failed (isolated): name=%s",
                contributor_name,
                exc_info=True,
                extra={
                    "contributor_failure": True,
                    "contributor_kind": "impact",
                    "contributor_name": contributor_name,
                    "agent_run_ids": run_ids,
                },
            )
            continue
        if data is None:
            continue
        if not isinstance(data, Mapping):
            logger.warning(
                "ImpactContributor returned non-Mapping (skipped): "
                "name=%s type=%s",
                contributor_name, type(data).__name__,
                extra={
                    "contributor_malformed": True,
                    "contributor_kind": "impact",
                    "contributor_name": contributor_name,
                },
            )
            continue
        if not data:
            continue
        output[contributor_name] = data
    return output

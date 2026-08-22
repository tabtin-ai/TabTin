"""将未改名的模板分身统一为「小Tin xxx版」命名。

只匹配「template_id + 旧出厂名」精确相等的行；用户已改名、历史
``{owner}代码版`` 展开名、系统默认「小Tin」一律不动。

供手动管理命令复跑；不挂自动 migration，避免发布时静默改展示名。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
from uuid import UUID

from django.db.models import Q
from django.utils import timezone

from apps.agent.models import Agent

# 旧出厂名 → 新出厂名。键为 template_id。
LEGACY_TEMPLATE_AGENT_NAMES: dict[str, str] = {
    "general-assistant": "日常版",
    "code-engineer": "代码版",
    "doc-writer": "文书版",
    "data-analyst": "数据版",
    "web-researcher": "冲浪版",
    "slide-designer": "PPT 版",
    "office-secretary": "跑腿版",
}

XIAOTIN_PREFIXED_TEMPLATE_AGENT_NAMES: dict[str, str] = {
    "general-assistant": "小Tin 日常版",
    "code-engineer": "小Tin 代码版",
    "doc-writer": "小Tin 文书版",
    "data-analyst": "小Tin 数据版",
    "web-researcher": "小Tin 冲浪版",
    "slide-designer": "小Tin PPT 版",
    "office-secretary": "小Tin 跑腿版",
}


@dataclass(frozen=True)
class RenameMatch:
    agent_id: UUID
    template_id: str
    old_name: str
    new_name: str
    organization_id: UUID
    owner_user_id: Optional[str]


@dataclass
class RenameStats:
    matched: int = 0
    updated: int = 0
    skipped_already_new: int = 0
    matches: list[RenameMatch] | None = None

    def __post_init__(self) -> None:
        if self.matches is None:
            self.matches = []


def _unchanged_legacy_name_filter() -> Q:
    query = Q()
    for template_id, legacy_name in LEGACY_TEMPLATE_AGENT_NAMES.items():
        query |= Q(template_id=template_id, name=legacy_name)
    return query


def iter_unchanged_legacy_template_agents(
    *,
    organization_id: Optional[UUID] = None,
):
    qs = Agent.objects.filter(_unchanged_legacy_name_filter()).order_by(
        "organization_id",
        "template_id",
        "id",
    )
    if organization_id is not None:
        qs = qs.filter(organization_id=organization_id)
    return qs


def rename_unchanged_legacy_template_agents(
    *,
    dry_run: bool = True,
    organization_id: Optional[UUID] = None,
) -> RenameStats:
    """把仍停在旧出厂名的模板分身改成「小Tin xxx版」。"""
    stats = RenameStats()
    now = timezone.now()
    to_update: list[Agent] = []

    for agent in iter_unchanged_legacy_template_agents(
        organization_id=organization_id,
    ).iterator(chunk_size=200):
        new_name = XIAOTIN_PREFIXED_TEMPLATE_AGENT_NAMES.get(agent.template_id)
        if not new_name:
            continue
        if agent.name == new_name:
            stats.skipped_already_new += 1
            continue

        match = RenameMatch(
            agent_id=agent.id,
            template_id=agent.template_id,
            old_name=agent.name,
            new_name=new_name,
            organization_id=agent.organization_id,
            owner_user_id=str(agent.owner_user_id) if agent.owner_user_id else None,
        )
        stats.matches.append(match)
        stats.matched += 1

        if dry_run:
            continue

        agent.name = new_name
        agent.updated_at = now
        to_update.append(agent)

    if not dry_run and to_update:
        Agent.objects.bulk_update(to_update, ["name", "updated_at"])
        stats.updated = len(to_update)

    return stats

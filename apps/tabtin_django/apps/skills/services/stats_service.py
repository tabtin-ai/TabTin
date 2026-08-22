"""Skill 使用统计服务（Wave 1 重构）。

历史背景：原本基于 ``FieldExecutionRecord``（TabData AI 字段执行记录）做统计。
AI 字段已彻底下架，``FieldExecutionRecord`` 模型已删除——基于"字段执行次数"
的统计口径不再有数据来源。

M4.5：团队携带洞察改读 ``AgentSkillLink``；设备安装登记不再
被误作用户 / Space 启用关系。

当前状态：
- ``get_skill_stats`` / ``get_top_skills``：返回空数据（用量统计源待重新设计）
- ``get_team_installs``：基于 ``AgentSkillLink`` 行 + Skill 表

后续若需要 Skill 使用洞察，应该接入新的来源（例如 Agent 对话中 ``skills.read``
的调用次数 + 设备端 telemetry），不再走"表格字段执行"路径。
"""

import logging
from typing import Optional


logger = logging.getLogger("skills.stats")


class SkillStatsService:
    """Skill 使用统计服务。"""

    @staticmethod
    def get_skill_stats(
        skill_key: str,
        organization_id: Optional[str] = None,
        days: int = 30,
    ) -> dict:
        """单个 Skill 的使用统计 — 数据源已下架，返回空骨架。"""
        return {
            "skill_key": skill_key,
            "total_executions": 0,
            "success_count": 0,
            "failed_count": 0,
            "success_rate": 0.0,
            "avg_duration_ms": 0,
            "unique_users": 0,
            "last_used_at": None,
            "daily_trend": [],
        }

    @staticmethod
    def get_top_skills(
        organization_id: Optional[str] = None,
        limit: int = 10,
        days: int = 30,
    ) -> list:
        """热门 Skill 排行 — 数据源已下架，返回空列表。"""
        return []

    @staticmethod
    def get_team_installs(organization_id: str) -> list:
        """团队携带洞察（基于 Skill + AgentSkillLink）。

        语义：列出该 organization 下 visibility=organization 的所有 user skill +
        每个 skill 在该 organization 内被启用的人数。
        """
        from apps.skills.models import AgentSkillLink, Skill

        if not organization_id:
            return []

        # 1. 该 organization 的所有 organization-visible skill
        skills = list(
            Skill.objects.filter(
                organization_id=organization_id,
                visibility=Skill.VISIBILITY_ORGANIZATION,
            ).values("skill_id", "slug", "name", "emoji", "owner_user_id")
        )
        if not skills:
            return []

        # 2. 每个 skill 的携带者（按 Agent owner 去重）
        skill_ids = [s["skill_id"] for s in skills]
        enablement_map: dict = {}
        for row in AgentSkillLink.objects.filter(
            skill_id__in=skill_ids,
            agent__organization_id=organization_id,
            enabled=True,
        ).exclude(agent__owner_user_id=None).values("skill_id", "agent__owner_user_id"):
            enablement_map.setdefault(str(row["skill_id"]), set()).add(
                str(row["agent__owner_user_id"])
            )

        all_user_ids: set = set()
        for users in enablement_map.values():
            all_user_ids.update(users)
        user_name_map = SkillStatsService._get_user_display_names(all_user_ids)

        result = []
        for s in skills:
            user_ids = enablement_map.get(str(s["skill_id"]), set())
            names = [user_name_map.get(uid) for uid in user_ids if uid in user_name_map]
            result.append({
                "skill_key": f"user:{s['slug']}",
                "name": s["name"],
                "emoji": s["emoji"] or "",
                "installed": bool(user_ids),
                "installed_by": [n for n in names if n],
            })
        return result

    @staticmethod
    def _get_user_display_names(user_ids: set) -> dict:
        """批量获取 user_id → display_name 映射。"""
        if not user_ids:
            return {}
        from apps.users.auth.models import User

        users = User.objects.filter(id__in=list(user_ids)).only(
            "id", "nickname", "username",
        )
        return {
            str(u.id): u.get_display_name()
            for u in users
        }

"""
AgentSyncService — Skill agents/*.md → SubAgentTemplate 自动同步

当 Skill 安装、更新或本地索引同步时，
从 Skill 的 agents 定义自动创建/更新/清理 SubAgentTemplate。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from django.db.models import Q

logger = logging.getLogger(__name__)


class AgentSyncService:
    """将 Skill 内的 agents 定义同步为 SubAgentTemplate 记录。"""

    @classmethod
    def sync_skill_agents(
        cls,
        *,
        space_id: str,
        skill_key: str,
        agents: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        """同步单个 Skill 的 agents 到 SubAgentTemplate。

        Returns:
            {"created": N, "updated": N, "deleted": N}
        """
        from apps.services.agent_engine.models import SubAgentTemplate

        stats = {"created": 0, "updated": 0, "deleted": 0}
        if not space_id or not skill_key:
            return stats

        existing = {
            tpl.name: tpl
            for tpl in SubAgentTemplate.objects.filter(
                space_id=space_id, skill_key=skill_key,
            )
        }
        seen_names: set[str] = set()

        for agent_def in agents:
            if not isinstance(agent_def, dict):
                continue
            name = (agent_def.get("name") or "").strip()
            if not name:
                continue
            seen_names.add(name)

            fields = cls._agent_def_to_template_fields(agent_def, skill_key)

            if name in existing:
                tpl = existing[name]
                updated = cls._update_template_fields(tpl, fields)
                if updated:
                    stats["updated"] += 1
            else:
                actual_name = cls._resolve_unique_name(space_id, name, skill_key)
                try:
                    SubAgentTemplate.objects.create(
                        space_id=space_id,
                        name=actual_name,
                        **fields,
                    )
                    stats["created"] += 1
                except Exception as exc:
                    logger.warning(
                        "[AgentSync] create failed: space=%s skill=%s agent=%s: %s",
                        space_id, skill_key, name, exc,
                    )

        stale_names = set(existing.keys()) - seen_names
        if stale_names:
            deleted_count, _ = SubAgentTemplate.objects.filter(
                space_id=space_id,
                skill_key=skill_key,
                name__in=stale_names,
            ).delete()
            stats["deleted"] = deleted_count

        if any(v > 0 for v in stats.values()):
            logger.info(
                "[AgentSync] space=%s skill=%s: %s",
                space_id, skill_key, stats,
            )

        return stats

    @classmethod
    def remove_skill_agents(cls, *, space_id: str, skill_key: str) -> int:
        """移除某 Skill 注册的所有 SubAgentTemplate。"""
        from apps.services.agent_engine.models import SubAgentTemplate

        deleted, _ = SubAgentTemplate.objects.filter(
            space_id=space_id, skill_key=skill_key,
        ).delete()
        if deleted:
            logger.info(
                "[AgentSync] removed %d templates: space=%s skill=%s",
                deleted, space_id, skill_key,
            )
        return deleted

    @classmethod
    def sync_all_local_agents(
        cls,
        *,
        space_id: str,
        skills: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        """批量同步本地 Skill 索引中的 agents。

        先同步每个 Skill 的 agents，
        再清理不再存在于索引中的 skill_key 对应的 SubAgentTemplate。
        """
        from apps.services.agent_engine.models import SubAgentTemplate

        total = {"created": 0, "updated": 0, "deleted": 0}
        active_keys: set[str] = set()

        for skill_entry in skills:
            if not isinstance(skill_entry, dict):
                continue
            skill_key = skill_entry.get("skill_key") or ""
            agents = skill_entry.get("agents")
            if not skill_key or not isinstance(agents, list) or not agents:
                continue
            active_keys.add(skill_key)
            result = cls.sync_skill_agents(
                space_id=space_id,
                skill_key=skill_key,
                agents=agents,
            )
            for k in total:
                total[k] += result.get(k, 0)

        # Wave 1 起 ``skill_key`` 全部走 canonical key 形态（user:<slug> /
        # platform:<id> / app:<...> / device:<id>），""user:"" 前缀在 user 来源
        # 上仍然适用 — sub-agent 模板只跟 user 来源 skill 走（platform / app /
        # device 没有自定义 agent role）。
        stale_tpls = SubAgentTemplate.objects.filter(
            skill_key__startswith="user:",
            space_id=space_id,
        ).exclude(
            skill_key__in=active_keys,
        )
        stale_count, _ = stale_tpls.delete()
        total["deleted"] += stale_count

        if any(v > 0 for v in total.values()):
            logger.info("[AgentSync] sync_all_local: space=%s total=%s", space_id, total)

        return total

    @staticmethod
    def _resolve_unique_name(space_id: str, name: str, skill_key: str) -> str:
        """当 (space_id, name) 已被其他 skill_key 的模板占用时，追加 skill 标识以消歧。"""
        from apps.services.agent_engine.models import SubAgentTemplate

        existing = SubAgentTemplate.objects.filter(
            space_id=space_id, name=name,
        ).exclude(skill_key=skill_key).first()
        if not existing:
            return name
        skill_suffix = skill_key.split(":")[-1] if ":" in skill_key else skill_key
        return f"{name} ({skill_suffix})"

    @staticmethod
    def _agent_def_to_template_fields(
        agent_def: Dict[str, Any],
        skill_key: str,
    ) -> Dict[str, Any]:
        """将 agent 定义（来自 agents/*.md frontmatter）转换为 SubAgentTemplate 字段。"""
        description = (agent_def.get("description") or "").strip()
        system_prompt = (agent_def.get("system_prompt") or agent_def.get("body") or "").strip()
        model_id = (agent_def.get("model") or "").strip()
        reply_mode = (agent_def.get("reply_mode") or "").strip()
        tool_domains = agent_def.get("tool_domains")
        if not isinstance(tool_domains, list):
            tool_domains = []

        subagent_type = (agent_def.get("subagent_type") or "execute").strip()
        if subagent_type not in ("explore", "plan", "execute"):
            subagent_type = "execute"

        return {
            "description": description,
            "system_prompt": system_prompt,
            "model_id": model_id,
            "reply_mode": reply_mode,
            "tool_domains": tool_domains,
            "skill_key": skill_key,
            "subagent_type": subagent_type,
            "is_enabled": True,
        }

    @staticmethod
    def _update_template_fields(
        tpl,
        fields: Dict[str, Any],
    ) -> bool:
        """更新 SubAgentTemplate 的字段（仅更新有变化的）。"""
        changed_fields: List[str] = []
        for field_name, new_val in fields.items():
            current = getattr(tpl, field_name, None)
            if current != new_val:
                setattr(tpl, field_name, new_val)
                changed_fields.append(field_name)

        if changed_fields:
            tpl.save(update_fields=changed_fields + ["updated_at"])
            return True
        return False



__all__ = ["AgentSyncService"]

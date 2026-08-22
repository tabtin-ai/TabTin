"""
SkillLinkSyncService — 自动解析 Skill 中的工具依赖并写入 ToolSkillLink

来源：
1. Skill 的 SKILL.md frontmatter 中的 `tools` 字段
2. Skill 内容中的 `_activate_tools` 引用
3. 手动 API 创建的关联
"""

import logging
import re
from typing import List, Optional, Set

from apps.capabilities.constants import CAPABILITIES_DB as DB

logger = logging.getLogger(__name__)

_ACTIVATE_TOOLS_PATTERN = re.compile(
    r'"_activate_tools"\s*:\s*\[([^\]]*)\]', re.DOTALL,
)
_TOOL_NAME_PATTERN = re.compile(r'"([a-zA-Z_][a-zA-Z0-9_.*]*)"')


class SkillLinkSyncService:
    """从 Skill 内容中提取工具引用，写入 ToolSkillLink。"""

    @staticmethod
    def sync_skill_links(skill_key: str, doc_content: str = "", metadata: dict = None):
        """解析 Skill 的文档和元数据，同步工具关联。

        Wave 1（PRD V3.3 §11.4）：``doc_content`` 默认 ``""`` —— 旧云端表 doc_content
        字段已删除（W2-0007），install/update 路径不再有原文可传；``_activate_tools``
        解析仅在 bundled skill 全文同步时仍启用，其他路径只走 metadata.tools。
        """
        from apps.capabilities.models import ToolSkillLink, LinkRelation

        tool_refs: Set[str] = set()
        relation_map: dict[str, str] = {}

        if metadata and isinstance(metadata.get("tools"), list):
            for tool_name in metadata["tools"]:
                if isinstance(tool_name, str):
                    tool_refs.add(tool_name)
                    relation_map[tool_name] = LinkRelation.REQUIRED

        if doc_content:
            for match in _ACTIVATE_TOOLS_PATTERN.finditer(doc_content):
                tools_str = match.group(1)
                for name_match in _TOOL_NAME_PATTERN.finditer(tools_str):
                    tool_name = name_match.group(1)
                    tool_refs.add(tool_name)
                    if tool_name not in relation_map:
                        relation_map[tool_name] = LinkRelation.ACTIVATES

        existing = set(
            ToolSkillLink.objects.using(DB)
            .filter(skill_key=skill_key)
            .values_list("tool_name", flat=True)
        )

        if not tool_refs:
            if existing:
                ToolSkillLink.objects.using(DB).filter(skill_key=skill_key).delete()
                logger.info("[SkillLinkSync] 清理 Skill '%s' 的全部 %d 条关联", skill_key, len(existing))
            return

        to_create = []
        for tool_name in tool_refs:
            if tool_name not in existing:
                to_create.append(ToolSkillLink(
                    tool_name=tool_name,
                    skill_key=skill_key,
                    relation_type=relation_map.get(tool_name, LinkRelation.REFERENCES),
                ))

        if to_create:
            ToolSkillLink.objects.using(DB).bulk_create(
                to_create, ignore_conflicts=True,
            )
            logger.info(
                "[SkillLinkSync] 为 Skill '%s' 创建 %d 条工具关联",
                skill_key, len(to_create),
            )

        stale = existing - tool_refs
        if stale:
            ToolSkillLink.objects.using(DB).filter(
                skill_key=skill_key, tool_name__in=stale,
            ).delete()
            logger.info(
                "[SkillLinkSync] 清理 Skill '%s' 的 %d 条过期关联",
                skill_key, len(stale),
            )

    @staticmethod
    def sync_all_user_skills():
        """Wave 1：遍历所有云端 user 来源 Skill，同步工具关联。

        Skill 表 Wave 1 起为 user 来源专用云端表（PRD V3.3 §11.4）。
        Skill 不再有 ``status='disabled'`` 概念（D3 启用关系存于 SkillEnablement
        行而非 Skill 表本身），所以本路径只同步现有的 user 来源 ToolSkillLink。
        """
        try:
            from apps.skills.models import Skill
        except ImportError:
            logger.debug("[SkillLinkSync] Skill 模型不可用")
            return

        synced = 0
        for skill in Skill.objects.all():
            SkillLinkSyncService.sync_skill_links(
                skill_key=skill.canonical_key,
                doc_content="",
                metadata={"agents": skill.agents_json or []},
            )
            synced += 1

        logger.info("[SkillLinkSync] 已同步 %d 个 user Skills", synced)

    @staticmethod
    def sync_all_bundled_skills():
        """遍历 bundled skills 目录，解析工具关联。"""
        import os
        from pathlib import Path
        from django.conf import settings

        bundled_root = Path(settings.BASE_DIR) / "apps" / "skills" / "bundled"
        if not bundled_root.exists():
            return

        count = 0
        for skill_md in bundled_root.rglob("SKILL.md"):
            rel_path = skill_md.relative_to(bundled_root)
            parts = list(rel_path.parts[:-1])

            if parts and parts[0] == "integrations":
                skill_key = "/".join(parts[1:])
            elif parts and parts[0] == "platform":
                skill_key = "/".join(parts[1:])
            else:
                skill_key = "/".join(parts)

            if not skill_key:
                continue

            try:
                content = skill_md.read_text(encoding="utf-8")
            except Exception:
                continue

            metadata = _parse_frontmatter_tools(content)
            SkillLinkSyncService.sync_skill_links(
                skill_key=skill_key,
                doc_content=content,
                metadata=metadata,
            )
            count += 1

        logger.info("[SkillLinkSync] 已处理 %d 个 bundled Skills", count)


def _parse_frontmatter_tools(content: str) -> dict:
    """从 SKILL.md frontmatter 中提取 tools 列表。"""
    import yaml

    if not content.startswith("---"):
        return {}

    end = content.find("---", 3)
    if end == -1:
        return {}

    frontmatter_str = content[3:end].strip()
    try:
        data = yaml.safe_load(frontmatter_str) or {}
    except Exception:
        return {}

    if isinstance(data.get("tools"), list):
        return {"tools": data["tools"]}
    return {}

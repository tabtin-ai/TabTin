"""Skills Registry — Wave 1（PRD V3.3）。

合并 platform / app / device / user 四层来源的 Skill 索引（D19）。

来源拆分：
- platform: 平台代码预装（``packages/skills/bundled/platform/**/SKILL.md``）—— 不进 Skill 表
- app: TabTin 自家 App 代码预装（``packages/apps/*/skills/**/SKILL.md``）—— 不进 Skill 表
- device: 本机装的 marketplace App / MCP server 自带 —— 不进 Skill 表，
  通过 LocalSkillRegistry 扫描 ``~/.agents/skills/`` 索引
- user: 用户写 / 导入 / 另存为我的副本 —— 上 Skill 云端表

无兼容负担（元原则 1）：
- 删除 source alias 兼容层（W0 决策补丁 3）
- 删除 ``LOCAL_CACHE_KEY`` Redis 缓存路径（PRD §11.5）
- 删除 ``save_local_index`` / ``get_local_index`` 草稿上云路径
- 删除 H4 fallback 复杂度
- canonical key 直接合规：``user:<slug>`` / ``platform:<id>`` / ``app:<app_id>/<id>`` /
  ``device:<id>``

启用过滤（ M4.5）：``AgentSkillLink`` 是携带 / 启用 / 私有配置真源；
``SkillEnablement`` 只补充当前 Space 执行设备上的安装版本与内容指纹。
"""

from __future__ import annotations

import logging
import time as _time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from apps.skills.services.skill_doc_parser import (
    parse_skill_doc,
    parse_agent_doc,
    beautify_slug,
    RICH_METADATA_KEYS,
)
from apps.skills.services.prompt_builder import build_available_skills_xml
from apps.skills.services.eligibility import SkillEligibilityService

logger = logging.getLogger(__name__)


_app_skill_meta_cache: Optional[Dict[str, Dict[str, Any]]] = None
_app_skill_meta_cache_ts: float = 0.0
_APP_SKILL_META_TTL: float = 3600.0


def _load_app_skill_meta() -> Dict[str, Dict[str, Any]]:
    """从 app_registry 的 CORE_APPS + MARKETPLACE_APPS 自动提取每个 App 的元数据。"""
    global _app_skill_meta_cache, _app_skill_meta_cache_ts

    now = _time.monotonic()
    import copy
    if _app_skill_meta_cache is not None and (now - _app_skill_meta_cache_ts) < _APP_SKILL_META_TTL:
        return copy.deepcopy(_app_skill_meta_cache)

    meta: Dict[str, Dict[str, Any]] = {}
    try:
        from apps.services.common.app_registry import CORE_APPS, MARKETPLACE_APPS
        for apps_dict in (CORE_APPS, MARKETPLACE_APPS):
            for app_id, app_def in apps_dict.items():
                meta[app_id] = {
                    "name": getattr(app_def, "name", app_id),
                    "description": getattr(app_def, "description", ""),
                    "tags": [getattr(app_def, "category", "")] if getattr(app_def, "category", "") else [],
                }
    except Exception:
        logger.debug("[SkillsRegistry] app_registry 不可用，app skill 元数据降级为空", exc_info=True)

    _app_skill_meta_cache = meta
    _app_skill_meta_cache_ts = now
    return meta


_STRIP_PREFIXES = ("platform",)


# ---------------------------------------------------------------------------
# Source 4 档（W0 决策补丁 2）
# ---------------------------------------------------------------------------

SOURCE_PLATFORM = "platform"
SOURCE_APP = "app"
SOURCE_DEVICE = "device"
SOURCE_USER = "user"
# ：工作区目录 Skill（Electron 扫描）；AgentSkillLink 仅记 opt-out 关闭行。
SOURCE_WORKSPACE = "workspace"

CANONICAL_SOURCES = frozenset({
    SOURCE_PLATFORM,
    SOURCE_APP,
    SOURCE_DEVICE,
    SOURCE_USER,
    SOURCE_WORKSPACE,
})


def normalize_skill_source(source: str) -> str:
    """Skill source 归一（无兼容负担：只接受 canonical 值）。

    Wave 0 决策补丁 3：旧 alias 兼容层已删除——产品未上线，
    legacy 值（system / market / local_agent / managed / marketplace）一律不再支持。
    传入未识别值时静默归 ``user``（防御性兜底，避免 raw API 输入炸服务）。
    """
    s = (source or "").strip().lower()
    if s in CANONICAL_SOURCES:
        return s
    return SOURCE_USER


def normalize_skill_key(key: str) -> str:
    """Canonical key 校验（不做 legacy → canonical 映射）。

    Wave 0 决策补丁 3：source alias 删除后，调用方务必直接传 canonical key，
    本函数仅做"格式合规"判断 + 简单清理（trim）。
    """
    return (key or "").strip()


# ---------------------------------------------------------------------------
# Bundled / app skill 扫描（与 Wave 0 之前一致）
# ---------------------------------------------------------------------------

# SCR-007: system skills cache with TTL so rolling deployments
# eventually refresh without requiring process restarts.
_system_skills_cache: Optional[List[Dict[str, Any]]] = None
_system_skills_cache_ts: float = 0.0
_SYSTEM_SKILLS_CACHE_TTL: float = 3600.0  # 1 hour


def invalidate_system_skills_cache() -> None:
    """Force reload of bundled system skills on next access."""
    global _system_skills_cache, _system_skills_cache_ts
    _system_skills_cache = None
    _system_skills_cache_ts = 0.0


def _scan_skill_dirs(root: Path) -> list[Path]:
    """递归扫描 root 下所有包含 SKILL.md 的目录。"""
    results: list[Path] = []
    if not root.is_dir():
        return results
    for item in sorted(root.iterdir()):
        if not item.is_dir() or item.name.startswith((".", "_")):
            continue
        if (item / "SKILL.md").exists():
            results.append(item)
        else:
            results.extend(_scan_skill_dirs(item))
    return results


def _bundled_skills_root() -> Path:
    """Repository-owned platform Skills root.

    Django may still expose compatibility APIs while those endpoints are being
    contracted, but platform built-in Skill source files are no longer owned by
    the Django app directory.
    """
    from apps.services.repo_root import get_repo_root

    return get_repo_root() / "packages" / "skills" / "bundled"


def _derive_skill_id(skill_dir: Path, bundled_dir: Path) -> str:
    """根据 skill 目录的相对路径生成 skill_id（剥离 platform/ 前缀）。"""
    rel = skill_dir.relative_to(bundled_dir)
    parts = rel.parts
    if parts and parts[0] in _STRIP_PREFIXES:
        parts = parts[1:]
    return "/".join(parts)


def _extract_md_body(content: str) -> str:
    """剥掉 YAML frontmatter，返回正文（用作 sub-agent system prompt）。"""
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return content.strip()
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "\n".join(lines[idx + 1:]).strip()
    return content.strip()


def scan_skill_agents(skill_dir: Path) -> List[Dict[str, Any]]:
    """扫描 ``<skill_dir>/agents/*.md``，解析为 sub-agent 角色定义列表。

    给 platform / app 来源 skill 用——SubAgentTemplate 注册需要这份数据。
    user 来源走 ``Skill.agents_json``，不调此函数。
    """
    agents: List[Dict[str, Any]] = []
    agents_dir = skill_dir / "agents"
    if not agents_dir.is_dir():
        return agents
    for item in sorted(agents_dir.iterdir()):
        if not item.is_file() or not item.name.endswith(".md"):
            continue
        if item.name.startswith((".", "_")):
            continue
        try:
            content = item.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        parsed = parse_agent_doc(content)
        if not parsed.get("has_frontmatter") or not parsed.get("name"):
            continue
        agents.append({
            "name": parsed.get("name") or item.stem,
            "description": parsed.get("description") or "",
            "model": parsed.get("model"),
            "reply_mode": parsed.get("reply_mode"),
            "tool_domains": parsed.get("tool_domains") or [],
            "system_prompt": _extract_md_body(content),
            "subagent_type": parsed.get("subagent_type") or "execute",
        })
    return agents


# ---------------------------------------------------------------------------
# SkillsRegistryService
# ---------------------------------------------------------------------------


class SkillsRegistryService:
    """合并 platform / app / device / user 四层来源的 Skill 索引（D19）。

    Wave 1 重构（无兼容负担）：
    - 删除草稿上云路径（``save_local_index`` / ``get_local_index`` 废弃）
    - 删除旧 H4 fallback（device 走独立扫描）
    - ``list_user_skills`` 改读云端 ``Skill`` 表（visibility 决定可见性）
    - 加 ``enabled`` 过滤层：Agent 携带行存在且 enabled=True 才进 ``<skills>`` 索引
    """

    @staticmethod
    def _build_skill_key(source: str, skill_id: str, app_id: Optional[str] = None) -> str:
        """构造 canonical key（W0 决策 3 V2）。"""
        if app_id:
            return f"{source}:{app_id}/{skill_id}"
        return f"{source}:{skill_id}"

    @staticmethod
    def _build_location(skill_key: str) -> str:
        return f"skills://{skill_key}"

    # ------------------------------------------------------------------
    # Platform / App / Device 扫描（不进云端 Skill 表）
    # ------------------------------------------------------------------

    @classmethod
    def list_platform_skills(cls) -> List[Dict[str, Any]]:
        """扫 ``packages/skills/bundled/`` → platform 来源（D19）。

        SCR-007: 缓存有 TTL（默认 1 小时）。
        """
        global _system_skills_cache, _system_skills_cache_ts
        import copy

        now = _time.monotonic()
        if (
            _system_skills_cache is not None
            and (now - _system_skills_cache_ts) < _SYSTEM_SKILLS_CACHE_TTL
        ):
            return copy.deepcopy(_system_skills_cache)

        bundled_dir = _bundled_skills_root()
        if not bundled_dir.exists():
            _system_skills_cache = []
            _system_skills_cache_ts = now
            return []

        normalized: List[Dict[str, Any]] = []
        for skill_dir in _scan_skill_dirs(bundled_dir):
            doc_path = skill_dir / "SKILL.md"
            try:
                content = doc_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            parsed = parse_skill_doc(content)
            skill_id = _derive_skill_id(skill_dir, bundled_dir)
            skill_key = cls._build_skill_key(SOURCE_PLATFORM, skill_id)
            entry: Dict[str, Any] = {
                "skill_id": skill_id,
                "name": parsed.get("name") or skill_id,
                "display_name": parsed.get("display_name") or beautify_slug(skill_id),
                "description": parsed.get("description"),
                "version": parsed.get("version"),
                "source": SOURCE_PLATFORM,
                "app_id": None,
                "skill_key": skill_key,
                "doc_path": str(doc_path),
                "path": str(skill_dir),
                "tags": parsed.get("tags") or [],
                "status": "enabled",
                "meta": {},
                "agents": scan_skill_agents(skill_dir),
            }
            for rk in RICH_METADATA_KEYS:
                rv = parsed.get(rk)
                if rv is not None:
                    entry[rk] = rv
            normalized.append(entry)

        _system_skills_cache = normalized
        _system_skills_cache_ts = now
        return copy.deepcopy(normalized)

    @classmethod
    def list_system_skills(cls) -> List[Dict[str, Any]]:
        """Backward 兼容别名 → ``list_platform_skills``（Wave 1 改名前的旧叫法）。"""
        return cls.list_platform_skills()

    @classmethod
    def list_app_skills(cls) -> List[Dict[str, Any]]:
        """列出 app package 来源内置 Skills。

        `app_strategy` / `APP_SECTIONS` 是 Agent 当前 App 场景提示，不是
        SKILL.md 能力文档，因此不再投影进 Skills catalog。
        """
        normalized: List[Dict[str, Any]] = []

        # 1. packages/apps/*/skills/**/SKILL.md
        try:
            from apps.skills.services.app_package_skills import AppPackageSkillsService
            app_skills = AppPackageSkillsService.list_skills()
            for raw in app_skills:
                if not isinstance(raw, dict):
                    continue
                skill_id = (raw.get("skill_id") or "").strip()
                if not skill_id:
                    continue
                app_id = raw.get("app_id")
                skill_key = cls._build_skill_key(SOURCE_APP, skill_id, app_id=app_id)
                entry: Dict[str, Any] = {
                    "skill_id": skill_id,
                    "name": raw.get("name") or skill_id,
                    "display_name": raw.get("display_name") or beautify_slug(skill_id),
                    "description": raw.get("description"),
                    "version": raw.get("version"),
                    "source": SOURCE_APP,
                    "app_id": app_id,
                    "distribution": raw.get("distribution"),
                    "skill_key": skill_key,
                    "doc_path": raw.get("doc_path"),
                    "path": raw.get("path"),
                    "tags": raw.get("tags") or [],
                    "status": "enabled",
                    "meta": {"origin": "app_package"},
                    "agents": raw.get("agents") or [],
                }
                for rk in RICH_METADATA_KEYS:
                    rv = raw.get(rk)
                    if rv is not None:
                        entry[rk] = rv
                normalized.append(entry)
        except Exception:
            logger.debug("[SkillsRegistry] app_package_skills scan failed", exc_info=True)

        return normalized

    @classmethod
    def list_market_skills(cls) -> List[Dict[str, Any]]:
        """Backward 兼容别名 → ``list_app_skills``（"市场"就是 app 来源，Wave 1 收口）。"""
        return cls.list_app_skills()

    @classmethod
    def list_device_skills(cls) -> List[Dict[str, Any]]:
        """device 来源 placeholder（D19 + W0 决策补丁 2）。

        device skill 的真实扫描在客户端 LocalSkillRegistry 完成（marketplace App
        装在 ``~/.agents/skills/``，Daemon / Electron 端最了解本机状态）。

        服务端这里只能返回已被推送上来的索引项（如有客户端通过 IPC 上报）。
        当前 Wave 1 默认返回空列表，由客户端在 UI 渲染时直接 merge 自己扫描的结果。
        """
        return []

    # ------------------------------------------------------------------
    # User 来源（云端权威）
    # ------------------------------------------------------------------

    @classmethod
    def list_user_skills_visible(
        cls,
        *,
        user_id: Optional[str],
        organization_id: Optional[str],
        agent_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """列出能新启用或已由当前 Agent 携带的 user 来源 skill。

        Visibility 三档过滤（D5 / §6.4）：
        - private：仅 owner 自己看到
        - organization：所属 organization 全体成员看到
        - public：仅 review_status=approved 的版本进入此列表（D13）

        owner 自启用例外（§6.10）：owner 的 private / public 原件始终可见。
        organization 快照属于组织货架，即使 owner 是自己也必须匹配当前组织。

        已携带关系不受后续 visibility 收紧影响；``agent_id`` 缺省时仅返回当前
        可新启用集合，供无 Space 上下文的市场视图使用。
        """
        if not user_id:
            return []

        try:
            from apps.skills.models import AgentSkillLink, Skill
            from django.db.models import Q
        except Exception:
            return []

        # private / public 原件跟 owner 走；组织快照始终按当前组织隔离。
        own = Q(owner_user_id=user_id) & ~Q(
            visibility=Skill.VISIBILITY_ORGANIZATION,
        )
        carried = Q()
        if agent_id:
            carried_skill_ids = AgentSkillLink.objects.filter(
                agent_id=agent_id,
                skill_id__isnull=False,
            ).values_list("skill_id", flat=True)
            carried = Q(skill_id__in=carried_skill_ids)

        # organization 可见（含 owner 自己，visibility=organization 且 organization 匹配）。
        # 用户手动共享即对团队可见，不再用“是否发布过”替用户判断内容成熟度。
        team = Q()
        if organization_id:
            team = (
                Q(visibility=Skill.VISIBILITY_ORGANIZATION)
                & Q(organization_id=organization_id)
            )

        # public approved（review P1 修复 — D13 审核闸门）：
        # 必须 annotate Exists(SkillPublishedVersion review_status=approved)
        # 才能进入可见列表，否则未过审的 public skill 会泄露到普通用户视图。
        from apps.skills.models import SkillPublishedVersion
        from django.db.models import Exists, OuterRef
        approved_subquery = SkillPublishedVersion.objects.filter(
            skill=OuterRef("pk"),
            review_status=SkillPublishedVersion.REVIEW_APPROVED,
        )

        own_or_team_qs = Skill.objects.filter(own | team | carried)
        public_qs = Skill.objects.filter(
            visibility=Skill.VISIBILITY_PUBLIC,
        ).exclude(owner_user_id=user_id).annotate(
            _has_approved=Exists(approved_subquery),
        ).filter(_has_approved=True)

        # 用 union 合并避免 annotate 影响 own/team queryset 评估顺序。
        skills_qs = list(own_or_team_qs) + list(public_qs)

        team_skill_ids = [
            skill.skill_id
            for skill in skills_qs
            if skill.visibility == Skill.VISIBILITY_ORGANIZATION
        ]
        acquired_copy_by_source = {
            str(copy.copied_from_skill_id): copy
            for copy in Skill.objects.filter(
                owner_user_id=user_id,
                copied_from_skill_id__in=team_skill_ids,
            )
        }

        normalized: List[Dict[str, Any]] = []
        seen_skill_ids: set[str] = set()
        for skill in skills_qs:
            skill_id = str(skill.skill_id)
            if skill_id in seen_skill_ids:
                continue
            seen_skill_ids.add(skill_id)
            entry = skill.to_index_entry()
            acquired_copy = acquired_copy_by_source.get(skill_id)
            if acquired_copy:
                entry["acquired_copy_skill_id"] = str(acquired_copy.skill_id)
                entry["acquired_copy_skill_key"] = acquired_copy.canonical_key
            entry["doc_path"] = None
            entry["path"] = None
            entry["tags"] = []
            entry["status"] = "enabled"
            entry["meta"] = {"origin": "user_skill"}
            for rk in RICH_METADATA_KEYS:
                rv = (skill.agents_json or {}).get(rk) if isinstance(skill.agents_json, dict) else None
                if rv is not None:
                    entry[rk] = rv
            normalized.append(entry)
        return normalized

    @classmethod
    def list_user_skills_owned(
        cls,
        *,
        user_id: str,
    ) -> List[Dict[str, Any]]:
        """仅列出 owner = user_id 的所有 user skill（用于 owner 视角）。"""
        if not user_id:
            return []
        try:
            from apps.skills.models import Skill
        except Exception:
            return []

        normalized: List[Dict[str, Any]] = []
        for skill in Skill.objects.filter(owner_user_id=user_id):
            normalized.append(skill.to_index_entry())
        return normalized

    # ------------------------------------------------------------------
    # 启用关系 + Eligibility
    # ------------------------------------------------------------------

    @classmethod
    def resolve_agent_skill_state(
        cls,
        space_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Return Agent intent + 用户总闸合成 + Device 安装事实。

        ：Skill HTTP 已不再传 space_id；本方法首选按 agent_id 内部推导。
        为兼容旧内部调用，若仍显式传入 space_id 则作为 workspace 锚点参与解析。
        """
        from apps.skills.models import AgentSkillLink, SkillEnablement
        from apps.skills.services.space_context import (
            SkillSpaceContextError,
            resolve_skill_agent_context,
            resolve_skill_space_context,
        )
        from apps.skills.services.user_preference_service import (
            UserSkillPreferenceService,
        )

        if not agent_id:
            raise SkillSpaceContextError(
                "agent_id 必填：Skill 归属身份，不再从 Workspace 反推"
            )
        if space_id:
            context = resolve_skill_space_context(space_id, agent_id=agent_id)
        else:
            context = resolve_skill_agent_context(
                agent_id=agent_id, workspace_id=None,
            )

        from apps.agent.models import Agent as AgentModel
        from apps.skills.services.agent_link_writer import AgentSkillLinkWriter

        agent_row = (
            AgentModel.objects.filter(id=context.agent_id)
            .only("id", "is_default", "owner_user_id", "template_id")
            .first()
        )
        preference_user_id = user_id or (
            getattr(agent_row, "owner_user_id", None) if agent_row else None
        )
        links = list(AgentSkillLink.objects.filter(agent_id=context.agent_id))
        user_gate = UserSkillPreferenceService.map_for_user(
            preference_user_id,
            [link.skill_canonical_key for link in links],
        )

        mapping: Dict[str, Dict[str, Any]] = {}
        for link in links:
            config = dict(link.config_json or {})
            config["carried"] = True
            locked = (
                agent_row is not None
                and AgentSkillLinkWriter.is_agent_skill_locked(
                    agent=agent_row,
                    skill_canonical_key=link.skill_canonical_key,
                    source=link.source,
                    distribution=config.get("distribution"),
                )
            )
            # 系统预置分身的锁定 Skill 强制注入（忽略总闸与脏 agent.enabled）。
            if locked:
                config.update(
                    UserSkillPreferenceService.compose_enablement(
                        agent_enabled=True,
                        user_enabled=True,
                    )
                )
            else:
                config.update(
                    UserSkillPreferenceService.compose_enablement(
                        agent_enabled=bool(link.enabled),
                        user_enabled=UserSkillPreferenceService.resolve_from_map(
                            user_gate, link.skill_canonical_key,
                        ),
                    )
                )
            config["installed_version_seq"] = None
            config["install_content_hash"] = None
            config["installed_on_device"] = False
            mapping[link.skill_canonical_key] = config

        if context.device_id:
            for install in SkillEnablement.objects.filter(device_id=context.device_id):
                composed = UserSkillPreferenceService.compose_enablement(
                    agent_enabled=False,
                    user_enabled=UserSkillPreferenceService.resolve_from_map(
                        user_gate, install.skill_canonical_key,
                    ),
                )
                state = mapping.setdefault(
                    install.skill_canonical_key,
                    {
                        "carried": False,
                        **composed,
                        "installed_version_seq": None,
                        "install_content_hash": None,
                        "installed_on_device": False,
                    },
                )
                state["installed_version_seq"] = install.installed_version_seq
                state["install_content_hash"] = install.install_content_hash or ""
                state["installed_on_device"] = True
        return mapping

    @classmethod
    def merge_skills(
        cls,
        *,
        platform_skills: Optional[Iterable[Dict[str, Any]]] = None,
        app_skills: Optional[Iterable[Dict[str, Any]]] = None,
        device_skills: Optional[Iterable[Dict[str, Any]]] = None,
        user_skills: Optional[Iterable[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        """合并 4 层来源，按 platform > app > device > user 优先级去重。"""
        priority_sources = [SOURCE_PLATFORM, SOURCE_APP, SOURCE_DEVICE, SOURCE_USER]
        buckets = {
            SOURCE_PLATFORM: list(platform_skills or []),
            SOURCE_APP: list(app_skills or []),
            SOURCE_DEVICE: list(device_skills or []),
            SOURCE_USER: list(user_skills or []),
        }

        merged: List[Dict[str, Any]] = []
        seen: set[str] = set()
        shadowed_ids: set[str] = set()
        owner_source: Dict[str, str] = {}

        def _normalize_id(entry: Dict[str, Any]) -> str:
            raw = entry.get("skill_id") or entry.get("name") or ""
            return str(raw).strip().lower()

        for source in priority_sources:
            bucket = buckets.get(source, [])
            for entry in bucket:
                sid = _normalize_id(entry)
                if sid and sid in shadowed_ids:
                    logger.debug(
                        "Skill '%s' from source '%s' shadowed by '%s'",
                        sid, source, owner_source.get(sid, "unknown"),
                    )
                    continue
                if not sid or sid in seen:
                    continue
                seen.add(sid)
                owner_source[sid] = source
                normalized_entry = {
                    **entry,
                    "source": normalize_skill_source(entry.get("source", source)),
                }
                merged.append(normalized_entry)
            for entry in bucket:
                sid = _normalize_id(entry)
                if sid:
                    shadowed_ids.add(sid)
        return merged

    @classmethod
    def _get_disabled_app_ids(cls, user_id: str, organization_id: str) -> set:
        """Get the set of app_ids that are disabled for this organization."""
        try:
            from apps.tabtinspace.services.app_settings_service import AppSettingsService
            #  过渡：AppSettingsService 仍按 space 维度签名；组织级禁用
            # 集合语义等同于「用户在该组织下禁用的 App」。若接口未来支持 org 直
            # 参数，此处可直连；当前先返回空集不阻断主链路。
            disabled = AppSettingsService.resolve_disabled_apps(user_id, organization_id)
            return set(disabled) if disabled else set()
        except Exception:
            return set()

    @classmethod
    def list_available_skills(
        cls,
        *,
        user_id: Optional[str],
        organization_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        space_id: Optional[str] = None,  # 内部兼容：workspace 锚点，HTTP 不再传
        eligibility_context: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """列出注入索引：用户总闸开 AND Agent 携带且 enabled。

        ：Skill HTTP 已不再传 space_id；``agent_id`` + ``organization_id`` 是首选签名。
        """
        if not user_id or not agent_id:
            return []

        from apps.skills.services.skill_service import SkillService

        if space_id:
            context = SkillService._resolve_space_context(space_id, agent_id=agent_id)
        else:
            context = SkillService._resolve_agent_context(agent_id)
        resolved_org_id = str(context.organization_id or organization_id or "")
        resolved_agent_id = str(context.agent_id)

        platform_skills = cls.list_platform_skills()
        app_skills = cls.list_app_skills()
        device_skills = cls.list_device_skills()
        user_skills = cls.list_user_skills_visible(
            user_id=user_id,
            organization_id=resolved_org_id or None,
            agent_id=resolved_agent_id,
        )

        merged = cls.merge_skills(
            platform_skills=platform_skills,
            app_skills=app_skills,
            device_skills=device_skills,
            user_skills=user_skills,
        )
        for entry in merged:
            skill_key = entry.get("skill_key")
            if not skill_key:
                skill_key = cls._build_skill_key(
                    normalize_skill_source(entry.get("source", "")) or SOURCE_PLATFORM,
                    entry.get("skill_id") or entry.get("name") or "",
                    app_id=entry.get("app_id"),
                )
                entry["skill_key"] = skill_key
            entry.setdefault("location", cls._build_location(skill_key))

        # 组织级 App 禁用过滤（有则拦截，无则跳过；不因签名切换而中断主链路）
        if resolved_org_id:
            disabled_apps = cls._get_disabled_app_ids(user_id, resolved_org_id)
            if disabled_apps:
                merged = [
                    entry for entry in merged
                    if not (entry.get("app_id") and entry["app_id"] in disabled_apps)
                ]

        # ── 用户总闸 AND Agent 携带过滤──
        skill_state = cls.resolve_agent_skill_state(
            space_id=space_id,
            agent_id=resolved_agent_id,
            user_id=str(user_id),
        )
        merged = cls._filter_by_agent_links(merged, skill_state)

        # ── Eligibility 过滤（保留原行为）──
        eligible = SkillEligibilityService.filter_eligible(
            merged,
            skill_settings=skill_state,
            platform=(eligibility_context or {}).get("platform"),
            available_bins=(eligibility_context or {}).get("bins"),
            available_env=(eligibility_context or {}).get("env"),
            user_id=user_id,
        )
        return eligible

    @classmethod
    def _filter_by_agent_links(
        cls,
        skills: List[Dict[str, Any]],
        skill_state: Dict[str, Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Filter solely by the Agent carrying SSoT."""
        return [
            entry
            for entry in skills
            if skill_state.get(entry.get("skill_key", ""), {}).get("enabled") is True
        ]

    @classmethod
    def get_skill_by_key(
        cls,
        *,
        user_id: Optional[str],
        skill_key: str,
        organization_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        space_id: Optional[str] = None,
        skills_cache: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional[Dict[str, Any]]:
        """精确匹配 + id/name fallback 查找 Skill。"""
        if not skill_key:
            return None
        skills = skills_cache or cls.list_available_skills(
            user_id=user_id,
            organization_id=organization_id,
            agent_id=agent_id,
            space_id=space_id,
        )

        # Layer 1: exact match
        for entry in skills:
            if entry.get("skill_key") == skill_key:
                return entry

        # Layer 2: id/name fallback
        token = skill_key
        if ":" in token:
            token = token.split(":", 1)[1]
        token_lower = token.lower()
        for entry in skills:
            sid = str(entry.get("skill_id") or "").strip()
            name = str(entry.get("name") or "").strip()
            if token == sid or (name and token_lower == name.lower()):
                return entry

        return None

    @classmethod
    def build_skills_prompt(
        cls,
        *,
        user_id: Optional[str],
        organization_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        space_id: Optional[str] = None,
        active_app_types: Optional[set] = None,
    ) -> str:
        skills = cls.list_available_skills(
            user_id=user_id,
            organization_id=organization_id,
            agent_id=agent_id,
            space_id=space_id,
        )
        return build_available_skills_xml(skills, active_app_types=active_app_types)


__all__ = [
    "SkillsRegistryService",
    "invalidate_system_skills_cache",
    "normalize_skill_key",
    "normalize_skill_source",
    "SOURCE_PLATFORM",
    "SOURCE_APP",
    "SOURCE_DEVICE",
    "SOURCE_USER",
    "SOURCE_WORKSPACE",
    "CANONICAL_SOURCES",
]

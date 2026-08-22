"""SkillPackageLoader — 统一加载 Skill 包（Wave 1 重构）。

来源优先级（与 ``SkillsRegistryService`` 一致）：
1. DB（``Skill`` 表，user 来源）
2. bundled 系统 Skill（platform 来源）
3. packages/ 下的 App Skill（app 来源）

加载逻辑：
    skill_id_or_canonical_key → 查找 Skill 包 → 返回 SkillPackage（doc_content,
    script_content, metadata）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

from apps.skills.services.skill_doc_parser import parse_skill_doc

logger = logging.getLogger("tabdata.skill_package_loader")


@dataclass
class SkillPackage:
    """Skill 包：脚本 + 方法论文本 + 元数据。"""

    skill_id: str
    name: str = ""
    description: str = ""
    version: str = ""

    doc_content: str = ""

    has_main: bool = False
    script_content: str = ""
    script_language: str = "python"

    main_timeout: int = 30
    agent_model: str = "auto"
    input_schema: list = field(default_factory=list)
    output_schema: dict = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    source: str = ""        # platform / app / device / user / file
    source_path: str = ""

    @property
    def can_run_script(self) -> bool:
        return self.has_main and bool(self.script_content.strip())

    @property
    def has_doc(self) -> bool:
        return bool(self.doc_content.strip())


class SkillPackageLoader:
    """统一 Skill 包加载器。

    用法：
        package = SkillPackageLoader.load("user:weekly-report")
        package = SkillPackageLoader.load("platform:visualization/tabtin-widget")
    """

    @classmethod
    def load(
        cls,
        skill_id: str,
        organization_id: Optional[str] = None,
        *,
        requesting_user_id: Optional[str] = None,
        database_skill_id: Optional[str] = None,
    ) -> Optional[SkillPackage]:
        """加载 Skill 包。"""
        if not skill_id:
            return None

        # 1. user 来源（DB）— canonical key 形式 user:<slug>
        if skill_id.startswith("user:"):
            slug = skill_id.split(":", 1)[1]
            pkg = cls._load_from_user_db(
                slug=slug,
                organization_id=organization_id,
                requesting_user_id=requesting_user_id,
                database_skill_id=database_skill_id,
            )
            if pkg:
                return pkg

        # 2. platform 来源 — bundled
        if skill_id.startswith("platform:"):
            local_id = skill_id.split(":", 1)[1]
            pkg = cls._load_from_bundled(local_id)
            if pkg:
                return pkg

        # 3. app 来源 — packages/apps/*/skills/<id>/
        if skill_id.startswith("app:"):
            local_id = skill_id.split(":", 1)[1]
            pkg = cls._load_from_known_paths(local_id)
            if pkg:
                return pkg
            # canonical app key 形如 app:<app_id>/<skill_id>（registry 产出口径，
            # 见 registry_service._build_skill_key）。_load_from_known_paths 是按
            # packages/apps/*/skills/<local_id> 搜索的，带 <app_id>/ 前缀时无法命中
            # 真实目录 packages/apps/<app_id>/skills/<skill_id>。这里用末段（真实
            # skill 目录名）兜底重试，让 canonical key 与裸 id 一样可被解析。
            if "/" in local_id:
                pkg = cls._load_from_known_paths(local_id.rsplit("/", 1)[1])
                if pkg:
                    return pkg

        # Backward path：传入裸 id（无 source 前缀）— 依次尝试
        pkg = cls._load_from_user_db(
            slug=skill_id,
            organization_id=organization_id,
            requesting_user_id=requesting_user_id,
            database_skill_id=database_skill_id,
        )
        if pkg:
            return pkg

        pkg = cls._load_from_bundled(skill_id)
        if pkg:
            return pkg

        pkg = cls._load_from_known_paths(skill_id)
        if pkg:
            return pkg

        logger.debug("skill_package_loader.not_found skill_id=%s", skill_id)
        return None

    @classmethod
    def _load_from_user_db(
        cls,
        *,
        slug: str,
        organization_id: Optional[str] = None,
        requesting_user_id: Optional[str] = None,
        database_skill_id: Optional[str] = None,
    ) -> Optional[SkillPackage]:
        """从 ``Skill`` 表加载 user 来源 skill。

        ``Skill`` 表只存元数据 + agents_json，SKILL.md 全文存在 PR
        ``PackageFile``（path='SKILL.md'）。详情读取固定使用 Skill 指向的最新
        已发布版本，保证组织精选展示的是不可变快照而不是 owner 草稿。
        """
        if not slug:
            return None
        try:
            from django.db.models import Q

            from apps.skills.models import Skill

            skills = Skill.objects.filter(slug=slug)
            if database_skill_id:
                skills = skills.filter(skill_id=database_skill_id)
            if requesting_user_id:
                visible = Q(owner_user_id=requesting_user_id) | Q(
                    visibility=Skill.VISIBILITY_PUBLIC,
                )
                if organization_id:
                    visible |= Q(
                        visibility=Skill.VISIBILITY_ORGANIZATION,
                        organization_id=organization_id,
                    )
                skills = skills.filter(visible)
            skill = skills.first()
            if not skill:
                return None

            doc_content = ""
            if skill.package_id and skill.latest_version_seq:
                from apps.services.package_registry.models import PackageVersion
                from apps.services.package_registry.services import read_skill_md_content

                version = PackageVersion.objects.filter(
                    package_id=skill.package_id,
                    version_seq=skill.latest_version_seq,
                    status=PackageVersion.Status.PUBLISHED,
                ).first()
                if version:
                    doc_content = read_skill_md_content(skill.package_id, version) or ""
            return SkillPackage(
                skill_id=skill.canonical_key,
                name=skill.name,
                description=skill.description,
                version=str(skill.latest_version_seq) if skill.latest_version_seq else "",
                doc_content=doc_content,
                metadata={"agents": skill.agents_json or []},
                source="user",
            )
        except Exception as exc:
            logger.warning("skill_package_loader.db_error slug=%s error=%s", slug, exc)
            return None

    @classmethod
    def list_bundled_skill_ids(cls) -> list:
        """列出所有 bundled 系统 Skill 的 ID（platform 来源）。"""
        from apps.skills.services.registry_service import _scan_skill_dirs, _derive_skill_id, _bundled_skills_root

        bundled_root = _bundled_skills_root()
        if not bundled_root.is_dir():
            return []
        return [
            _derive_skill_id(d, bundled_root)
            for d in _scan_skill_dirs(bundled_root)
        ]

    @classmethod
    def _load_from_bundled(cls, skill_id: str) -> Optional[SkillPackage]:
        """从 ``packages/skills/bundled/`` 加载 platform skill。"""
        from apps.skills.services.registry_service import _STRIP_PREFIXES, _bundled_skills_root

        bundled_root = _bundled_skills_root()

        direct = bundled_root / skill_id
        if direct.is_dir():
            return cls._load_from_directory(direct, skill_id, source="platform")

        for prefix in _STRIP_PREFIXES:
            prefixed = bundled_root / prefix / skill_id
            if prefixed.is_dir():
                return cls._load_from_directory(prefixed, skill_id, source="platform")

        return None

    @classmethod
    def _load_from_known_paths(cls, skill_id: str) -> Optional[SkillPackage]:
        """从 ``packages/`` 下的已知路径查找 app skill。"""
        project_root = Path(__file__).parent.parent.parent.parent.parent.parent
        packages_dir = project_root / "packages"

        if not packages_dir.is_dir():
            return None

        search_dirs = [
            packages_dir / "apps",
            packages_dir / "infrastructure",
            packages_dir / "runtimes",
        ]

        for base_dir in search_dirs:
            if not base_dir.is_dir():
                continue
            for app_dir in base_dir.iterdir():
                if not app_dir.is_dir():
                    continue
                skill_dir = app_dir / "skills" / skill_id
                if skill_dir.is_dir():
                    pkg = cls._load_from_directory(skill_dir, skill_id, source="app")
                    if pkg:
                        return pkg

        return None

    @classmethod
    def _load_from_directory(
        cls,
        skill_dir: Path,
        skill_id: str,
        source: str = "file",
    ) -> Optional[SkillPackage]:
        """从目录加载 Skill 包。"""
        doc_path = skill_dir / "SKILL.md"
        main_py_path = skill_dir / "main.py"
        main_js_path = skill_dir / "main.js"

        doc_content = ""
        if doc_path.exists():
            try:
                doc_content = doc_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass

        if not doc_content and not main_py_path.exists() and not main_js_path.exists():
            return None

        parsed = parse_skill_doc(doc_content) if doc_content else {}

        script_content = ""
        script_language = "python"
        has_main = False

        if main_py_path.exists():
            try:
                script_content = main_py_path.read_text(encoding="utf-8", errors="replace")
                script_language = "python"
                has_main = True
            except OSError:
                pass
        elif main_js_path.exists():
            try:
                script_content = main_js_path.read_text(encoding="utf-8", errors="replace")
                script_language = "javascript"
                has_main = True
            except OSError:
                pass

        if parsed.get("has_main") is True:
            has_main = True

        return SkillPackage(
            skill_id=skill_id,
            name=parsed.get("name") or skill_id,
            description=parsed.get("description") or "",
            version=parsed.get("version") or "",
            doc_content=doc_content,
            has_main=has_main,
            script_content=script_content,
            script_language=parsed.get("main_runtime") or script_language,
            main_timeout=parsed.get("main_timeout") or 30,
            agent_model=parsed.get("agent_model") or "auto",
            input_schema=parsed.get("input_schema") or [],
            output_schema=parsed.get("output_schema") or {},
            metadata=parsed,
            source=source,
            source_path=str(skill_dir),
        )


__all__ = ["SkillPackageLoader", "SkillPackage"]

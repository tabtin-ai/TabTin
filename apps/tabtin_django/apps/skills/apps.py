import logging
import re
import threading

from django.apps import AppConfig

from apps.services.startup_jobs import should_skip_startup_background_jobs

logger = logging.getLogger(__name__)


def _once_across_workers(cache_key: str, ttl: int = 60) -> bool:
    """跨 worker 去重：仅第一个调用的 worker 返回 True，其余返回 False。"""
    try:
        from django.core.cache import cache
        return bool(cache.add(cache_key, "1", timeout=ttl))
    except Exception:
        return True


def _deferred_validate_skill_tools():
    """延迟校验 Skill tools 与 ToolHub 的一致性（仅 WARNING，不阻塞启动）。"""
    if not _once_across_workers("startup:validate_skill_tools"):
        return
    try:
        from apps.skills.management.commands.validate_skill_tools import (
            _get_toolhub_tools,
            _scan_skill_files,
        )
        from apps.services.repo_root import get_repo_root

        repo_root = get_repo_root()
        scan_dirs = [
            repo_root / "packages",
            repo_root / "apps" / "tabtin_django" / "apps" / "skills" / "bundled",
        ]
        skill_tools_map = _scan_skill_files(scan_dirs)
        if not skill_tools_map:
            return

        toolhub_tools = _get_toolhub_tools()
        if not toolhub_tools:
            return

        for skill_name, tools in skill_tools_map.items():
            missing = [t for t in tools if t not in toolhub_tools]
            if missing:
                logger.warning(
                    "[SkillValidation] %s declares tools not in ToolHub: %s",
                    skill_name,
                    ", ".join(missing),
                )
    except Exception:
        logger.debug("[SkillValidation] deferred validation skipped", exc_info=True)


def _deferred_validate_prompt_skill_keys():
    """延迟校验 prompts/apps/*.py 中的 skill_key 引用（仅 WARNING）。"""
    if not _once_across_workers("startup:validate_prompt_skill_keys"):
        return
    try:
        from pathlib import Path
        from apps.skills.services.registry_service import SkillsRegistryService

        prompts_dir = (
            Path(__file__).resolve().parents[1]
            / "services" / "agent_engine" / "prompts" / "apps"
        )
        if not prompts_dir.exists():
            return

        pattern = re.compile(r'skills\.read\(["\']([^"\']+)["\']\)')
        system_keys = {
            s.get("skill_key") for s in SkillsRegistryService.list_system_skills()
            if s.get("skill_key")
        }

        for py_file in sorted(prompts_dir.glob("*.py")):
            if py_file.name == "__init__.py":
                continue
            content = py_file.read_text(encoding="utf-8", errors="replace")
            for key in pattern.findall(content):
                if key.startswith("platform:") and key not in system_keys:
                    logger.warning(
                        "[SkillValidation] %s references unknown system skill_key: %s",
                        py_file.name, key,
                    )
    except Exception:
        logger.debug("[SkillValidation] prompt skill_key validation skipped", exc_info=True)


class SkillsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.skills"
    verbose_name = "Skills"

    def ready(self):
        if should_skip_startup_background_jobs():
            logger.debug("[SkillValidation] startup validation skipped for management command")
            return

        timer = threading.Timer(5.0, _deferred_validate_skill_tools)
        timer.daemon = True
        timer.start()
        timer2 = threading.Timer(6.0, _deferred_validate_prompt_skill_keys)
        timer2.daemon = True
        timer2.start()

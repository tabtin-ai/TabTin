"""
ToolSyncService — 将代码定义的工具同步到 DB

同步来源：
1. ToolHub 所有域（builtin 后端工具）
2. action-tools manifest.json（前端工具）
3. ExtensionRegistry（Extension 工具）

原则：
- builtin / manifest / extension 来源以代码为准，DB 是索引
- custom 来源以 DB 为准，同步不覆盖
- 代码中消失的工具标记为 deprecated（不删除）
"""

import logging
import threading
from typing import Any, Dict, List, Optional

from django.db import transaction

from apps.capabilities.constants import CAPABILITIES_DB as DB

logger = logging.getLogger(__name__)


# ─── 映射辅助 ──────────────────────────────────────────

_DOMAIN_CATEGORY_MAP = {
    "common": "platform",
    "chat": "platform",
    "todo": "platform",
    "think": "platform",
    "rag": "platform",
    "docparse": "platform",
    "media": "service",
    "ssh": "runtime",
    "terminal": "runtime",
    "gui": "runtime",
    "action-tools": "platform",
    "web-scraper": "service",
}

_EXECUTION_TARGET_MAP = {
    "frontend": "frontend",
    "backend": "backend",
    "hybrid": "hybrid",
    "client": "frontend",
    "server": "backend",
}


def _infer_category(domain: str, app_id: Optional[str], source: str) -> str:
    if source == "extension":
        return "extension"
    if domain in _DOMAIN_CATEGORY_MAP:
        return _DOMAIN_CATEGORY_MAP[domain]
    if app_id:
        return "app"
    return "platform"


def _normalize_execution_target(raw: Optional[str]) -> str:
    if not raw:
        return "backend"
    return _EXECUTION_TARGET_MAP.get(raw, raw)


# ─── ToolHub 同步 ──────────────────────────────────────

def _collect_toolhub_tools() -> List[Dict[str, Any]]:
    """Collect ToolHub builtin/extension tool metadata for DB sync.

    W6 (2026-05-04): Python ToolHub no longer registers LLM tools, so this
    walk normally returns an empty list. The loop is preserved to support
    runtime-registered Extension domains (if any) without forcing this
    sync service to be aware of the deprecation.
    """
    try:
        from apps.services.tools import ToolHub
    except ImportError:
        logger.warning("[ToolSync] ToolHub 不可用，跳过 builtin 同步")
        return []

    skip_domains = {"action-tools"}
    results = []

    for provider_info in ToolHub.list_providers():
        domain = provider_info.get("domain", "")
        if domain in skip_domains:
            continue

        source_type = provider_info.get("source", "builtin")
        app_id = provider_info.get("app_id", "")

        try:
            tools = ToolHub.get_tools(domain=domain)
        except Exception:
            logger.warning("[ToolSync] 加载域 '%s' 失败", domain, exc_info=True)
            continue

        for tool in tools:
            name = getattr(tool, "name", None)
            if not name:
                continue

            desc = getattr(tool, "description", "") or ""
            risk = getattr(tool, "risk_level", "safe") or "safe"
            execution_mode = getattr(tool, "execution_mode", "server") or "server"
            tool_app_id = getattr(tool, "app_id", None) or app_id or domain
            is_optional = getattr(tool, "optional", False)

            params_schema = {}
            args_schema = getattr(tool, "args_schema", None)
            if args_schema:
                try:
                    params_schema = args_schema.model_json_schema()
                except Exception:
                    pass

            display = getattr(tool, "display_name", None) or name.replace("_", " ").title()

            results.append({
                "name": name,
                "display_name": display,
                "description": desc,
                "category": _infer_category(domain, tool_app_id, source_type),
                "provider_id": tool_app_id,
                "domain": domain,
                "tags": [],
                "interface_type": "function_call",
                "execution_target": _normalize_execution_target(execution_mode),
                "parameters_schema": params_schema,
                "return_schema": {},
                "risk_level": risk if risk in ("safe", "review", "strict") else "safe",
                "permissions": [],
                "optional": bool(is_optional),
                "source": "builtin" if source_type == "builtin" else "extension",
                "source_ref": f"toolhub:{domain}",
                "version": "0.0.0",
            })

    return results


def _collect_manifest_tools() -> List[Dict[str, Any]]:
    """从 action-tools manifest.json 收集前端工具。"""
    try:
        from apps.services.tools import load_action_tool_manifest
    except ImportError:
        logger.warning("[ToolSync] action_tool_manifest 不可用，跳过 manifest 同步")
        return []

    valid_risks = frozenset({"safe", "review", "strict"})
    data = load_action_tool_manifest()
    tools = data.get("tools", [])
    results = []

    for tool in tools:
        name = tool.get("name", "")
        if not name:
            continue

        app_id = tool.get("appId", "")
        tags = tool.get("tags", [])
        exec_target = tool.get("executionTarget", "frontend")

        results.append({
            "name": name,
            "display_name": tool.get("displayName") or name.replace("_", " ").title(),
            "description": tool.get("description", ""),
            "category": _infer_category("action-tools", app_id, "manifest"),
            "provider_id": app_id or "action-tools",
            "domain": "action-tools",
            "tags": tags,
            "interface_type": "function_call",
            "execution_target": _normalize_execution_target(exec_target),
            "parameters_schema": tool.get("parameters", {}),
            "return_schema": {},
            "risk_level": tool["riskLevel"] if tool.get("riskLevel") in valid_risks else "review",
            "permissions": tool.get("permissions", []),
            "optional": tool.get("optional", False),
            "source": "manifest",
            "source_ref": "action-tools/manifest.json",
            "version": "0.0.0",
        })

    return results


# ─── 核心同步逻辑 ──────────────────────────────────────

class ToolSyncService:
    """工具同步服务 — 将代码定义的工具同步到 RegisteredTool 表。"""

    @staticmethod
    def sync_all() -> Dict[str, int]:
        """执行全量同步，返回统计。"""
        from apps.capabilities.models import RegisteredTool, ToolSource

        all_tools: Dict[str, Dict[str, Any]] = {}

        for tool_data in _collect_toolhub_tools():
            all_tools[tool_data["name"]] = tool_data

        manifest_skipped = []
        for tool_data in _collect_manifest_tools():
            if tool_data["name"] not in all_tools:
                all_tools[tool_data["name"]] = tool_data
            else:
                manifest_skipped.append(tool_data["name"])
        if manifest_skipped:
            logger.info(
                "[ToolSync] %d 个 manifest 工具因与后端同名被跳过（双注册，后端优先）: %s",
                len(manifest_skipped), sorted(manifest_skipped),
            )

        stats = {"created": 0, "updated": 0, "deprecated": 0, "skipped": 0, "total": 0}
        stats["total"] = len(all_tools)

        synced_names = set()

        changed_names = []

        with transaction.atomic(using=DB):
            for name, data in all_tools.items():
                synced_names.add(name)
                try:
                    with transaction.atomic(using=DB):
                        existing = RegisteredTool.objects.using(DB).filter(name=name).first()
                        if existing:
                            if existing.source == ToolSource.CUSTOM:
                                stats["skipped"] += 1
                                continue

                            changed = False
                            for field_name in (
                                "display_name", "description", "category", "provider_id",
                                "domain", "tags", "interface_type", "execution_target",
                                "parameters_schema", "return_schema", "risk_level",
                                "permissions", "optional", "source", "source_ref",
                            ):
                                new_val = data.get(field_name)
                                if new_val is not None and getattr(existing, field_name) != new_val:
                                    setattr(existing, field_name, new_val)
                                    changed = True

                            if existing.status == "deprecated":
                                existing.status = "active"
                                changed = True

                            if changed:
                                existing.save(using=DB)
                                stats["updated"] += 1
                                changed_names.append(name)
                        else:
                            RegisteredTool.objects.using(DB).create(**data)
                            stats["created"] += 1
                            changed_names.append(name)
                except Exception:
                    logger.warning("[ToolSync] 同步工具 '%s' 失败", name, exc_info=True)

            deprecated_count = (
                RegisteredTool.objects
                .using(DB)
                .exclude(source=ToolSource.CUSTOM)
                .exclude(name__in=synced_names)
                .filter(status="active")
                .update(status="deprecated")
            )
            stats["deprecated"] = deprecated_count

        logger.info(
            "[ToolSync] 同步完成: total=%d created=%d updated=%d deprecated=%d skipped=%d",
            stats["total"], stats["created"], stats["updated"],
            stats["deprecated"], stats["skipped"],
        )

        try:
            from apps.capabilities.services.tool_embedding import ToolEmbeddingService
            from apps.capabilities.models import ToolEmbedding

            # 1) 增量索引：本次 sync 新增/更新的工具
            if changed_names:
                indexed = 0
                for tool in RegisteredTool.objects.using(DB).filter(
                    name__in=changed_names, status="active",
                ):
                    try:
                        if ToolEmbeddingService.index_tool(
                            tool_id=str(tool.id), tool_name=tool.name,
                            display_name=tool.display_name,
                            description=tool.description or "",
                            tags=tool.tags, category=tool.category,
                            provider_id=tool.provider_id,
                            documentation=tool.documentation or "",
                        ):
                            indexed += 1
                    except Exception:
                        logger.warning("[ToolSync] 增量索引工具 '%s' 失败", tool.name, exc_info=True)
                logger.info("[ToolSync] 增量 embedding 索引: %d/%d", indexed, len(changed_names))

            # 2) Backfill：补全历史存量中缺少 embedding 的 active 工具
            embedded_names = set(
                ToolEmbedding.objects.using(DB).values_list("tool_name", flat=True)
            )
            missing_tools = (
                RegisteredTool.objects.using(DB)
                .filter(status="active")
                .exclude(name__in=embedded_names)
            )
            missing_count = missing_tools.count()
            if missing_count > 0:
                backfilled = 0
                for tool in missing_tools.iterator():
                    try:
                        if ToolEmbeddingService.index_tool(
                            tool_id=str(tool.id), tool_name=tool.name,
                            display_name=tool.display_name,
                            description=tool.description or "",
                            tags=tool.tags, category=tool.category,
                            provider_id=tool.provider_id,
                            documentation=tool.documentation or "",
                        ):
                            backfilled += 1
                    except Exception:
                        logger.warning("[ToolSync] backfill 索引工具 '%s' 失败", tool.name, exc_info=True)
                logger.info("[ToolSync] Backfill embedding 索引: %d/%d", backfilled, missing_count)
        except Exception:
            logger.warning("[ToolSync] 同步后 embedding 索引失败", exc_info=True)

        return stats


# ─── 启动时调度 ──────────────────────────────────────

_sync_scheduled = False


def schedule_tool_sync():
    """在 AppConfig.ready() 中调用，延迟执行同步避免阻塞启动。"""
    from django.conf import settings
    from apps.services.startup_jobs import should_skip_startup_background_jobs

    if getattr(settings, 'RUNNING_TESTS', False):
        return
    if should_skip_startup_background_jobs():
        logger.debug("[ToolSync] startup sync skipped for management command")
        return

    global _sync_scheduled
    if _sync_scheduled:
        return
    _sync_scheduled = True

    _ADVISORY_LOCK_ID = 748269001  # capabilities tool sync

    def _do_sync():
        import time
        time.sleep(3)

        try:
            from django.db import connections
            conn = connections[DB]
            conn.ensure_connection()
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = 'public' "
                    "AND table_name = 'capabilities_registered_tool'"
                )
                if not cursor.fetchone():
                    logger.info("[ToolSync] 表未创建，跳过同步（请先执行迁移）")
                    return
        except Exception:
            logger.warning("[ToolSync] DB 未就绪，跳过同步", exc_info=True)
            return

        lock_acquired = False
        try:
            from django.db import connections
            conn = connections[DB]
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(%s)", [_ADVISORY_LOCK_ID])
                lock_acquired = cursor.fetchone()[0]
            if not lock_acquired:
                logger.info("[ToolSync] 另一个 worker 正在同步，跳过")
                return

            stats = ToolSyncService.sync_all()
            logger.info("[ToolSync] 启动同步结果: %s", stats)
        except Exception:
            logger.warning("[ToolSync] 启动同步失败", exc_info=True)
        finally:
            if lock_acquired:
                try:
                    from django.db import connections
                    conn = connections[DB]
                    with conn.cursor() as cursor:
                        cursor.execute("SELECT pg_advisory_unlock(%s)", [_ADVISORY_LOCK_ID])
                except Exception:
                    logger.warning("[ToolSync] Advisory lock 释放失败", exc_info=True)

    thread = threading.Thread(target=_do_sync, daemon=True, name="tool-sync")
    thread.start()

"""
审计 App 注册完整性（manifest 入口，默认审计 builtin）。

逐步检查 Manifest / Registry / Backend / Agent / Frontend / Tools & Skill
等维度，对必填项做格式校验，可选项仅提示缺失。

注意：
    - 默认 `distribution=builtin`，以兼容当前 infra-gate
    - 可通过 `--distribution marketplace|all` 扩大审计范围
    - marketplace 审计已接入 manifest 契约检查，但仍不是完整生命周期审计

用法:
    python manage.py audit_apps                             # builtin 全局概览
    python manage.py audit_apps --app tabdoc               # 单个 App 详细报告
    python manage.py audit_apps --distribution marketplace # marketplace 概览
    python manage.py audit_apps --app <app_id>             # 定点审计 marketplace App
    python manage.py audit_apps --strict                   # 必填项失败时退出码 1
    python manage.py audit_apps --verbose                  # 全局概览也打印详情
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from django.core.management.base import BaseCommand

from apps.services.repo_root import get_repo_root

_PROJECT_ROOT = get_repo_root()
_DJANGO_ROOT = _PROJECT_ROOT / "apps" / "tabtin_django"
_RENDERER_BASE = _PROJECT_ROOT / "apps" / "tabtin-electron" / "src" / "renderer" / "src"

# handler 文件名可能不同于 app_id
_HANDLER_ALIASES: dict[str, list[str]] = {
    "tabdata": ["table", "tabdata"],
    "tabdoc": ["tabdoc", "tabdoc", "docs"],
    "tabslide": ["slide", "tabslide"],
    "tabweb": ["browser", "tabweb"],
    "tabfolder": ["folder", "tabfolder"],
}

# ── 状态符号 ──
FAIL = "✗"     # 必填项失败
WARN = "⚠"     # 推荐项缺失
HINT = "ℹ"     # 可选提示
PASS = "✓"     # 通过
SKIP = "—"     # 不适用

_LOAD_ERRORS: list[str] = []


def _record_load_error(scope: str, exc: Exception) -> None:
    msg = f"{scope}: {type(exc).__name__}: {exc}"
    if msg not in _LOAD_ERRORS:
        _LOAD_ERRORS.append(msg)


def _read_file(path: Path) -> str:
    """安全读取文件内容。"""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def _strip_tin_prefix(app_id: str) -> str:
    return app_id[3:] if app_id.startswith("tin") else app_id


def _find_handler_file(handler_dir: Path, app_id: str) -> Optional[Path]:
    """在 handler 目录中查找匹配的文件。"""
    candidates = _HANDLER_ALIASES.get(app_id, [app_id, _strip_tin_prefix(app_id)])
    for stem in candidates:
        for ext in [".tsx", ".ts"]:
            p = handler_dir / f"{stem}{ext}"
            if p.exists():
                return p
    return None


def _normalize_app_map(apps) -> dict:
    if isinstance(apps, dict):
        return dict(apps)
    return {app_id: app_def for app_id, app_def in apps}


def _manifest_path_for(app_id: str) -> Path:
    return _PROJECT_ROOT / "packages" / "apps" / app_id / "app.json"


def _load_manifest_json(app_id: str) -> tuple[Optional[dict], Optional[str]]:
    manifest_path = _manifest_path_for(app_id)
    if not manifest_path.exists():
        return None, f"manifest 缺失: {manifest_path.relative_to(_PROJECT_ROOT)}"
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8")), None
    except Exception as exc:
        return None, f"manifest 解析失败: {type(exc).__name__}: {exc}"


def _runtime_bindings(manifest_data: Optional[dict]) -> dict:
    if not isinstance(manifest_data, dict):
        return {}
    bindings = manifest_data.get("runtimeBindings")
    return bindings if isinstance(bindings, dict) else {}


def _uses_host_backend(manifest_data: Optional[dict]) -> bool:
    if not isinstance(manifest_data, dict):
        return False
    tool_provider = (_runtime_bindings(manifest_data).get("toolProvider") or "")
    return manifest_data.get("agentRuntime") == "hostBackend" or tool_provider.startswith("django:")


def _uses_embedded_web(manifest_data: Optional[dict]) -> bool:
    return isinstance(manifest_data, dict) and manifest_data.get("uiRuntime") == "embeddedWeb"


def _uses_cli_bridge(manifest_data: Optional[dict]) -> bool:
    if not isinstance(manifest_data, dict):
        return False
    tool_provider = (_runtime_bindings(manifest_data).get("toolProvider") or "")
    return tool_provider.startswith("cli:") or manifest_data.get("cli") is not None


def _has_explicit_non_backend_binding(manifest_data: Optional[dict]) -> bool:
    if not isinstance(manifest_data, dict):
        return False
    agent_runtime = manifest_data.get("agentRuntime")
    tool_provider = (_runtime_bindings(manifest_data).get("toolProvider") or "")
    return (
        agent_runtime in {"clientBridge", "remote", "frontend"}
        or _uses_embedded_web(manifest_data)
        or _uses_cli_bridge(manifest_data)
        or tool_provider.startswith("electron:")
    )


def _skill_entry_exists(skills_dir: Path, skill_id: str) -> bool:
    return (skills_dir / skill_id / "SKILL.md").exists() or (skills_dir / f"{skill_id}.md").exists()


def _check_manifest_contract(
    app_id: str,
    app_def,
    manifest_data: Optional[dict],
    manifest_error: Optional[str] = None,
) -> list[tuple[str, str, str]]:
    results: list[tuple[str, str, str]] = []
    manifest_rel = _manifest_path_for(app_id).relative_to(_PROJECT_ROOT)

    if manifest_error:
        results.append(("Manifest", FAIL, f"[必填] {manifest_error}"))
        return results

    if not isinstance(manifest_data, dict):
        results.append(("Manifest", FAIL, "[必填] manifest 不是合法 JSON 对象"))
        return results

    results.append(("Manifest", PASS, f"[必填] manifest: {manifest_rel}"))

    if manifest_data.get("id") == app_id:
        results.append(("Manifest", PASS, f"[必填] id='{app_id}'"))
    else:
        results.append(("Manifest", FAIL, f"[必填] manifest.id 与目录不一致（期望 '{app_id}'）"))

    if manifest_data.get("name"):
        results.append(("Manifest", PASS, f"[必填] name='{manifest_data.get('name')}'"))
    else:
        results.append(("Manifest", FAIL, "[必填] manifest 缺少 name"))

    if manifest_data.get("version"):
        results.append(("Manifest", PASS, f"[必填] version='{manifest_data.get('version')}'"))
    else:
        results.append(("Manifest", FAIL, "[必填] manifest 缺少 version"))

    distribution = manifest_data.get("distribution")
    if distribution in {"builtin", "marketplace"}:
        results.append(("Manifest", PASS, f"[必填] distribution='{distribution}'"))
        if distribution != getattr(app_def, "distribution", distribution):
            results.append(("Manifest", FAIL, "[必填] manifest.distribution 与 AppRegistry 解析结果不一致"))
    else:
        results.append(("Manifest", FAIL, "[必填] distribution 必须是 builtin 或 marketplace"))

    install_scope = manifest_data.get("installScope")
    if install_scope in {"organization", "device"}:
        results.append(("Manifest", PASS, f"[必填] installScope='{install_scope}'"))
    elif distribution == "builtin":
        results.append(("Manifest", WARN, "[迁移期] builtin manifest 未显式声明 installScope，将按 organization 默认解释"))
    else:
        results.append(("Manifest", FAIL, "[必填] marketplace App 必须显式声明 installScope=organization|device"))

    runtime_support = manifest_data.get("runtimeSupport")
    if isinstance(runtime_support, dict) and runtime_support:
        results.append(("Manifest", PASS, f"[必填] runtimeSupport 已声明 {len(runtime_support)} 个运行时"))
    else:
        results.append(("Manifest", FAIL, "[必填] runtimeSupport 缺失或为空"))

    agent = manifest_data.get("agentIntegration")
    if isinstance(agent, dict):
        results.append(("Manifest", PASS, "[必填] agentIntegration 已声明"))
        if agent.get("contextType"):
            results.append(("Manifest", PASS, f"[必填] contextType='{agent.get('contextType')}'"))
        else:
            results.append(("Manifest", FAIL, "[必填] agentIntegration.contextType 缺失"))

        if isinstance(agent.get("hasPromptSection"), bool):
            results.append(("Manifest", PASS, f"[必填] hasPromptSection={agent.get('hasPromptSection')}"))
        else:
            results.append(("Manifest", FAIL, "[必填] agentIntegration.hasPromptSection 必须显式为布尔值"))
    else:
        results.append(("Manifest", FAIL, "[必填] agentIntegration 缺失或不是对象"))

    catalog = manifest_data.get("catalog")
    required_catalog_fields = ("category", "desktopGroup", "canCreate", "searchable", "isDefaultEnabled", "order")
    if isinstance(catalog, dict):
        missing_catalog_fields = [field for field in required_catalog_fields if field not in catalog]
        if missing_catalog_fields:
            results.append(("Manifest", FAIL, f"[必填] catalog 缺少字段: {', '.join(missing_catalog_fields)}"))
        else:
            results.append(("Manifest", PASS, "[必填] catalog 关键字段齐全"))
    else:
        results.append(("Manifest", FAIL, "[必填] catalog 缺失或不是对象"))

    if _uses_embedded_web(manifest_data):
        embedded_web = manifest_data.get("embeddedWeb")
        if isinstance(embedded_web, dict) and embedded_web:
            results.append(("Manifest", PASS, "[必填] uiRuntime=embeddedWeb 且 embeddedWeb 已声明"))
            url_patterns = embedded_web.get("urlPatterns")
            if isinstance(url_patterns, list) and url_patterns:
                results.append(("Manifest", PASS, f"[推荐] embeddedWeb.urlPatterns: {len(url_patterns)} 条"))
            else:
                results.append(("Manifest", WARN, "[推荐] embeddedWeb.urlPatterns 缺失或为空（URL 发现无法单源驱动）"))
        else:
            results.append(("Manifest", FAIL, "[必填] uiRuntime=embeddedWeb 时必须补齐 embeddedWeb"))

    if distribution == "marketplace":
        if install_scope in {"organization", "device"}:
            results.append(("Manifest", PASS, f"[必填] marketplace 安装层='{install_scope}'"))

        if _uses_cli_bridge(manifest_data):
            cli_block = manifest_data.get("cli")
            install_block = manifest_data.get("install") or {}
            install_type = install_block.get("type", "tarball")

            if not isinstance(cli_block, dict):
                results.append(("Manifest", FAIL, "[必填] CLI Bridge App 缺少 cli 块"))
            elif install_type == "npm-global":
                # v3.1 方向锚：npm-global 不走 tarball，只需 binary/version + install.npmPackage
                required_cli_fields = ("binary", "version")
                missing_cli_fields = [f for f in required_cli_fields if not cli_block.get(f)]
                if missing_cli_fields:
                    results.append(("Manifest", FAIL,
                                    f"[必填] cli 缺少字段 (npm-global): {', '.join(missing_cli_fields)}"))
                elif not install_block.get("npmPackage"):
                    results.append(("Manifest", FAIL,
                                    "[必填] install.type=npm-global 必须声明 install.npmPackage"))
                else:
                    results.append(("Manifest", PASS,
                                    f"[必填] cli 关键字段齐全（npm-global: {install_block['npmPackage']}）"))
            else:
                # tarball 路径（默认或显式 install.type=tarball）
                required_cli_fields = ("binary", "version", "downloadUrl", "platformMap", "archMap")
                missing_cli_fields = [f for f in required_cli_fields if not cli_block.get(f)]
                if missing_cli_fields:
                    results.append(("Manifest", FAIL,
                                    f"[必填] cli 缺少字段 (tarball): {', '.join(missing_cli_fields)}"))
                else:
                    results.append(("Manifest", PASS, "[必填] cli 关键字段齐全"))

                checksums = cli_block.get("checksums")
                if isinstance(checksums, dict) and any(v for v in checksums.values()):
                    results.append(("Manifest", PASS, "[推荐] cli.checksums 已声明"))
                else:
                    results.append(("Manifest", WARN, "[推荐] cli.checksums 为空或缺失（下载完整性校验不完整）"))

        skills_block = manifest_data.get("skills")
        if isinstance(skills_block, dict):
            directory = skills_block.get("directory")
            if directory:
                skills_dir = (_PROJECT_ROOT / "packages" / "apps" / app_id / directory).resolve()
                try:
                    skills_dir.relative_to((_PROJECT_ROOT / "packages" / "apps" / app_id).resolve())
                except ValueError:
                    results.append(("Skill", FAIL, "[必填] skills.directory 越界"))
                else:
                    if skills_dir.exists():
                        results.append(("Skill", PASS, f"[推荐] skills.directory: {skills_dir.relative_to(_PROJECT_ROOT)}"))
                    else:
                        results.append(("Skill", FAIL, f"[必填] skills.directory 不存在: {skills_dir.relative_to(_PROJECT_ROOT)}"))

                    declared_skills = list(skills_block.get("autoLoad", [])) + list(skills_block.get("onDemand", []))
                    if declared_skills and skills_dir.exists():
                        missing = [skill_id for skill_id in declared_skills if not _skill_entry_exists(skills_dir, skill_id)]
                        if missing:
                            results.append(("Skill", FAIL, f"[必填] skills 清单与目录不一致: {', '.join(missing)}"))
                        else:
                            results.append(("Skill", PASS, f"[推荐] skills 清单与目录一致: {len(declared_skills)} 项"))
            elif skills_block:
                results.append(("Skill", WARN, "[推荐] skills 块存在但未声明 directory"))

    return results


# ═══════════════════════════════════════════════════════════
#  全局级检查
# ═══════════════════════════════════════════════════════════


def _check_global_invariants(apps) -> list[tuple[str, str, str]]:
    app_defs = _normalize_app_map(apps)
    selected_app_ids = set(app_defs.keys())
    results: list[tuple[str, str, str]] = []

    # G1: context_fields 跨 App 字段名重复
    seen: dict[str, str] = {}
    dup_found = False
    for aid, adef in app_defs.items():
        for f in adef.context_fields:
            if f.name in seen and seen[f.name] != aid:
                results.append(("全局", FAIL, f"[必填] context_field '{f.name}' 在 {seen[f.name]} 和 {aid} 中重复"))
                dup_found = True
            else:
                seen[f.name] = aid
    if not dup_found:
        results.append(("全局", PASS, "[必填] context_fields 字段名无跨 App 重复"))

    # G2: order 唯一性
    orders: dict[int, str] = {}
    order_dup = False
    for aid, adef in app_defs.items():
        if adef.order in orders:
            results.append(("全局", FAIL, f"[必填] order={adef.order} 在 {orders[adef.order]} 和 {aid} 中重复"))
            order_dup = True
        else:
            orders[adef.order] = aid
    if not order_dup:
        results.append(("全局", PASS, "[必填] order 值全局唯一"))

    # G3: prompts/apps skill_key 引用
    try:
        from apps.skills.services.registry_service import SkillsRegistryService, normalize_skill_key
        prompts_dir = _DJANGO_ROOT / "apps" / "services" / "agent_engine" / "prompts" / "apps"
        if prompts_dir.exists():
            pattern = re.compile(r'skills\.read\(["\']([^"\']+)["\']\)')
            known_keys: set[str] = set()
            for s in SkillsRegistryService.list_system_skills():
                if s.get("skill_key"):
                    known_keys.add(s["skill_key"])
                    known_keys.add(normalize_skill_key(s["skill_key"]))
            try:
                from apps.skills.services.app_package_skills import AppPackageSkillsService
                for s in AppPackageSkillsService.list_skills():
                    if s.get("skill_key"):
                        known_keys.add(s["skill_key"])
                        known_keys.add(normalize_skill_key(s["skill_key"]))
            except Exception as exc:
                _record_load_error("AppPackageSkillsService.list_skills", exc)
            bad_keys = []
            for py_file in sorted(prompts_dir.glob("*.py")):
                if py_file.name == "__init__.py":
                    continue
                if selected_app_ids and py_file.stem not in selected_app_ids:
                    continue
                for key in pattern.findall(py_file.read_text(encoding="utf-8", errors="replace")):
                    if ":" not in key:
                        continue
                    canonical = normalize_skill_key(key)
                    if canonical not in known_keys and key not in known_keys:
                        bad_keys.append(f"{py_file.name} → {key}")
            if bad_keys:
                for bk in bad_keys:
                    results.append(("全局", FAIL, f"[必填] skills.read() 引用无效: {bk}"))
            else:
                results.append(("全局", PASS, "[必填] prompts skill_key 引用全部有效"))
    except ImportError:
        results.append(("全局", HINT, "无法导入 SkillsRegistryService，跳过 skill_key 校验"))

    # G-codegen: 生成物新鲜度
    try:
        import subprocess, sys
        result = subprocess.run(
            [sys.executable, str(_PROJECT_ROOT / "scripts" / "generate-context-types.py"), "--check"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            results.append(("全局", PASS, "[必填] context codegen 生成物与 manifest 一致"))
        else:
            detail = (result.stderr or result.stdout or "").strip()[:200]
            results.append(("全局", FAIL, f"[必填] context codegen 过期，请运行 python scripts/generate-context-types.py — {detail}"))
    except Exception as exc:
        results.append(("全局", WARN, f"[推荐] 无法检查 codegen 新鲜度: {type(exc).__name__}: {exc}"))

    # G4: Channel 注册完整性
    results.extend(_check_channel_registry())

    # G5: Entity 聚合完整性
    results.extend(_check_entity_completeness(app_defs))

    return results


def _check_global(apps) -> list[tuple[str, str, str]]:
    return _check_global_invariants(apps)


def _check_channel_registry() -> list[tuple[str, str, str]]:
    """校验所有已注册 ChannelAdapter 的元数据完整性。"""
    results: list[tuple[str, str, str]] = []

    try:
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        adapters = ChannelAdapterRegistry.list_all()
        if not adapters:
            results.append(("Channel", WARN, "[推荐] ChannelAdapterRegistry 为空，无已注册渠道"))
            return results

        results.append(("Channel", PASS, f"[必填] 已注册 {len(adapters)} 个 ChannelAdapter"))

        for adapter in adapters:
            aid = adapter.id
            if not getattr(adapter, "description", ""):
                results.append(("Channel", WARN, f"[推荐] Channel '{aid}' 缺少 description"))
            if not getattr(adapter, "icon", ""):
                results.append(("Channel", WARN, f"[推荐] Channel '{aid}' 缺少 icon"))

            try:
                config_fields = adapter.get_config_fields()
                config_schema = adapter.get_config_schema()
                if config_fields and not config_schema:
                    results.append(("Channel", HINT,
                        f"[可选] Channel '{aid}': get_config_fields() 有 {len(config_fields)} 字段，"
                        f"但 get_config_schema() 为空"))
                elif config_schema and not config_fields:
                    results.append(("Channel", HINT,
                        f"[可选] Channel '{aid}': get_config_schema() 有内容但 get_config_fields() 为空"))
            except Exception as exc:
                results.append(("Channel", WARN,
                    f"[推荐] Channel '{aid}': config 方法调用异常 — {exc}"))

    except ImportError:
        results.append(("Channel", WARN, "[推荐] 无法导入 ChannelAdapterRegistry，跳过渠道校验"))

    return results


def _check_entity_completeness(apps: dict) -> list[tuple[str, str, str]]:
    """校验 EntityQueryService 聚合结果的完整性。"""
    results: list[tuple[str, str, str]] = []
    builtin_apps = {
        app_id: app_def
        for app_id, app_def in _normalize_app_map(apps).items()
        if getattr(app_def, "distribution", "builtin") == "builtin"
    }

    if not builtin_apps:
        results.append(("Entity", SKIP, "[可选] 当前选择无 builtin App，跳过 Entity 完整性校验"))
        return results

    try:
        from apps.services.common.entity_query_service import EntityQueryService

        all_entities = EntityQueryService.list_all()
        entity_ids = {e.id for e in all_entities}

        for app_id in builtin_apps:
            if app_id not in entity_ids:
                results.append(("Entity", FAIL,
                    f"[必填] builtin App '{app_id}' 未出现在 EntityQueryService 结果中"))

        missing_apps = [a for a in builtin_apps if a not in entity_ids]
        if not missing_apps:
            results.append(("Entity", PASS, f"[必填] 全部 {len(builtin_apps)} 个 builtin App 存在于 EntityQueryService"))

        try:
            from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

            channel_ids = ChannelAdapterRegistry.list_ids()
            missing_channels = [c for c in channel_ids if c not in entity_ids]
            if missing_channels:
                for ch_id in missing_channels:
                    results.append(("Entity", FAIL,
                        f"[必填] Channel '{ch_id}' 未出现在 EntityQueryService 结果中"))
            elif channel_ids:
                results.append(("Entity", PASS,
                    f"[必填] 全部 {len(channel_ids)} 个 Channel 存在于 EntityQueryService"))

            expected_min = len(builtin_apps) + len(channel_ids)
            actual = len(all_entities)
            if actual < expected_min:
                results.append(("Entity", WARN,
                    f"[推荐] EntityQueryService 返回 {actual} 个实体，"
                    f"预期至少 {expected_min}（{len(builtin_apps)} builtin Apps + "
                    f"{len(channel_ids)} Channels）"))
            else:
                results.append(("Entity", PASS,
                    f"[必填] EntityQueryService 返回 {actual} 个实体"
                    f"（>= {expected_min} 预期下限）"))

        except ImportError:
            results.append(("Entity", WARN,
                "[推荐] 无法导入 ChannelAdapterRegistry，跳过 Channel→Entity 交叉校验"))

    except ImportError as exc:
        results.append(("Entity", WARN,
            f"[推荐] 无法导入 EntityQueryService ({exc})，跳过 Entity 完整性校验"))

    return results


# ═══════════════════════════════════════════════════════════
#  单个 App 检查
# ═══════════════════════════════════════════════════════════


def _audit_single_app(app_id: str, app_def) -> list[tuple[str, str, str]]:
    r: list[tuple[str, str, str]] = []
    manifest_data, manifest_error = _load_manifest_json(app_id)
    distribution = getattr(app_def, "distribution", "builtin")
    uses_host_backend = _uses_host_backend(manifest_data)

    r.extend(_check_manifest_contract(app_id, app_def, manifest_data, manifest_error))

    # ── 1. Registry ──
    r.append(("Registry", PASS, f"[必填] id={app_def.id}, name={app_def.name}, order={app_def.order}, distribution={distribution}"))

    if app_def.context_type:
        r.append(("Registry", PASS, f"[必填] context_type='{app_def.context_type}'"))

        if app_def.context_fields:
            names = [f.name for f in app_def.context_fields]
            has_rid = any(f.is_resource_id for f in app_def.context_fields)
            if has_rid:
                r.append(("Registry", PASS, f"[必填] context_fields: {names}（含 is_resource_id）"))
            else:
                r.append(("Registry", FAIL, f"[必填] context_fields 无 is_resource_id=True 字段"))

            for f in app_def.context_fields:
                if not f.name.startswith("current_"):
                    r.append(("Registry", WARN, f"[推荐] context_field '{f.name}' 建议以 'current_' 前缀命名"))
        else:
            r.append(("Registry", FAIL, "[必填] 有 context_type 但 context_fields 为空，Agent 无法获取资源上下文"))
    else:
        r.append(("Registry", SKIP, "无 context_type（前端原生/基础设施 App）"))

    if app_def.tool_domains:
        r.append(("Registry", PASS, f"[推荐] tool_domains: {list(app_def.tool_domains)}"))
    else:
        r.append(("Registry", SKIP, "[可选] 无 tool_domains"))

    if app_def.has_prompt_section:
        r.append(("Registry", PASS, f"[推荐] has_prompt_section=True"))
    else:
        r.append(("Registry", HINT, "[可选] has_prompt_section=False"))

    # ── 2. Backend Django App ──
    app_dir = _DJANGO_ROOT / "apps" / app_id
    if not app_dir.exists():
        for alias in [_strip_tin_prefix(app_id)]:
            d = _DJANGO_ROOT / "apps" / alias
            if d.exists():
                app_dir = d
                break

    if app_dir.exists():
        r.append(("Backend", PASS, f"[必填] Django App 目录: {app_dir.relative_to(_PROJECT_ROOT)}"))

        # 必要文件
        for fname in ["apps.py", "models.py"]:
            if (app_dir / fname).exists():
                r.append(("Backend", PASS, f"[必填] {fname}"))
            else:
                r.append(("Backend", FAIL, f"[必填] {fname} 缺失"))

        # apps.py 内容: AppConfig
        apps_content = _read_file(app_dir / "apps.py")
        if apps_content:
            if "AppConfig" in apps_content:
                r.append(("Backend", PASS, "[必填] apps.py 含 AppConfig"))
            else:
                r.append(("Backend", FAIL, "[必填] apps.py 未定义 AppConfig"))

        # api.py
        api_file = app_dir / "api.py"
        if api_file.exists():
            r.append(("Backend", PASS, "[推荐] api.py"))
            api_content = _read_file(api_file)
            if "Router" in api_content:
                r.append(("Backend", PASS, "[必填] api.py 使用 Ninja Router"))
            elif api_content:
                r.append(("Backend", WARN, "[推荐] api.py 建议使用 Django Ninja Router"))

            if api_content:
                has_envelope = ("success_response" in api_content or "error_response" in api_content
                                or "get_success_response" in api_content or "get_error_response" in api_content)
                if has_envelope:
                    r.append(("Backend", PASS, "[推荐] api.py 使用统一响应信封（success_response / error_response）"))
                else:
                    r.append(("Backend", WARN, "[推荐] api.py 未使用统一响应信封（建议引入 success_response / error_response）"))

                if "JWTAuth" in api_content or "jwt_auth" in api_content:
                    r.append(("Backend", PASS, "[必填] api.py 使用 JWTAuth 认证"))
                else:
                    has_write = any(
                        f"@router.{m}" in api_content
                        for m in ("post", "put", "patch", "delete")
                    )
                    if has_write:
                        r.append(("Backend", FAIL, "[必填] api.py 有写接口但未引入 JWTAuth 认证"))
                    else:
                        r.append(("Backend", HINT, "[可选] api.py 无写接口，JWTAuth 非必须"))

                # API 复杂度: 检查是否有过长的视图函数（应抽到 Service 层）
                _api_fn_re = re.compile(
                    r"^(?:def|async\s+def)\s+\w+\(", re.MULTILINE)
                fn_starts = [m.start() for m in _api_fn_re.finditer(api_content)]
                long_fns = []
                for i, start in enumerate(fn_starts):
                    end = fn_starts[i + 1] if i + 1 < len(fn_starts) else len(api_content)
                    body = api_content[start:end]
                    line_count = body.count("\n")
                    if line_count > 30:
                        fn_name_match = re.match(r"(?:async\s+)?def\s+(\w+)", body)
                        fn_name = fn_name_match.group(1) if fn_name_match else "unknown"
                        long_fns.append((fn_name, line_count))
                if long_fns:
                    names = ", ".join(f"{n}({c}行)" for n, c in long_fns)
                    has_service = ("Service" in api_content or "service" in api_content
                                   or "from apps." in api_content)
                    if not has_service:
                        r.append(("Backend", WARN,
                            f"[推荐] api.py 函数过长且无 Service 调用: {names}，建议抽取到 services/ 层"))
                    else:
                        r.append(("Backend", HINT,
                            f"[可选] api.py 函数较长: {names}，已有 Service 引用"))
        else:
            r.append(("Backend", HINT, "[可选] api.py 缺失"))

        # schemas.py
        schemas_file = app_dir / "schemas.py"
        if schemas_file.exists():
            r.append(("Backend", PASS, "[推荐] schemas.py"))
        else:
            if api_file.exists():
                r.append(("Backend", HINT, "[可选] schemas.py 缺失（API Schema 建议独立到 schemas.py）"))


        # db_router.py
        db_router_file = app_dir / "db_router.py"
        if db_router_file.exists():
            r.append(("Backend", PASS, "[必填] db_router.py"))
            dr_content = _read_file(db_router_file)
            if "PostgresAppRouter" in dr_content:
                r.append(("Backend", PASS, "[必填] 继承 PostgresAppRouter"))
            elif dr_content:
                r.append(("Backend", WARN, "[推荐] db_router.py 建议继承 PostgresAppRouter"))
            if "route_app_labels" in dr_content:
                r.append(("Backend", PASS, "[必填] 声明 route_app_labels"))
            elif dr_content:
                r.append(("Backend", WARN, "[推荐] db_router.py 缺少 route_app_labels"))
        else:
            if app_def.context_type:
                r.append(("Backend", WARN, "[推荐] db_router.py 缺失（有后端模型的 App 建议有）"))

        # services/
        svc_dir = app_dir / "services"
        if svc_dir.exists():
            r.append(("Backend", PASS, "[推荐] services/ 目录"))
        else:
            r.append(("Backend", HINT, "[可选] services/ 目录缺失"))

        # models.py 内容检查
        models_content = _read_file(app_dir / "models.py")
        if models_content and app_def.context_type:
            if "ProjectResourceModel" in models_content or "TimeStampedModel" in models_content:
                r.append(("Backend", PASS, "[必填] 模型继承 ProjectResourceModel/TimeStampedModel"))
            else:
                r.append(("Backend", WARN, "[推荐] models.py 建议继承 ProjectResourceModel 或 TimeStampedModel"))

            if "ContextSyncMixin" in models_content or "get_context_type" in models_content:
                r.append(("Backend", PASS, "[必填] 实现 ContextSyncMixin / get_context_type"))
            else:
                r.append(("Backend", WARN, "[推荐] 模型建议实现 ContextSyncMixin（get_context_type / get_context_title）"))

            if "get_context_title" in models_content:
                r.append(("Backend", PASS, "[推荐] 实现 get_context_title"))
            else:
                r.append(("Backend", WARN, "[推荐] 模型建议实现 get_context_title（Agent 需要标题信息）"))

        # migrations
        migrations = app_dir / "migrations"
        has_model_defs = (
            models_content
            and ("class " in models_content)
            and ("models.Model" in models_content or "ProjectResourceModel" in models_content
                 or "TimeStampedModel" in models_content)
        )
        if migrations.exists():
            n = len(list(migrations.glob("0*.py")))
            if n > 0:
                r.append(("Backend", PASS, f"[必填] 迁移文件: {n} 个"))
            elif has_model_defs:
                r.append(("Backend", WARN,
                    "[推荐] migrations/ 无迁移文件但 models.py 有模型定义，"
                    f"请执行: python manage.py makemigrations {app_id}"))
            else:
                r.append(("Backend", PASS, "[必填] migrations/ 存在（无模型需要迁移）"))
        else:
            if has_model_defs:
                r.append(("Backend", FAIL,
                    f"[必填] migrations/ 目录缺失但 models.py 有模型定义，"
                    f"请执行: python manage.py makemigrations {app_id}"))
            else:
                r.append(("Backend", HINT, "[可选] migrations/ 目录缺失（无模型需要迁移）"))

        # INSTALLED_APPS
        installed, routers = _get_installed_apps_and_routers()
        if installed:
            app_module = f"apps.{app_id}"
            found = any(e == app_module or e.startswith(f"{app_module}.") for e in installed)
            if found:
                r.append(("Backend", PASS, "[必填] INSTALLED_APPS 已注册"))
            else:
                r.append(("Backend", FAIL, f"[必填] 未在 INSTALLED_APPS 中注册（搜索: {app_module}）"))

        # DATABASE_ROUTERS
        if db_router_file.exists() and routers:
            router_prefix = f"apps.{app_id}.db_router."
            found = any(e.startswith(router_prefix) for e in routers)
            if found:
                r.append(("Backend", PASS, "[必填] DATABASE_ROUTERS 已注册"))
            else:
                r.append(("Backend", FAIL, "[必填] 有 db_router.py 但未在 DATABASE_ROUTERS 注册"))

        # urls 挂载（核心路由在 urls.py，非核心延迟路由在 urls_deferred.py）
        urls_content = (
            _read_file(_DJANGO_ROOT / "tabtin" / "urls.py")
            + "\n"
            + _read_file(_DJANGO_ROOT / "tabtin" / "urls_deferred.py")
        )
        if urls_content.strip() and api_file.exists():
            url_patterns = [f"/{app_id}", f"/{_strip_tin_prefix(app_id)}"]
            mounted = any(p in urls_content for p in url_patterns)
            if mounted:
                r.append(("Backend", PASS, "[必填] API 路由已挂载到 urls.py / urls_deferred.py"))
            else:
                r.append(("Backend", WARN, "[推荐] API 路由未在 urls.py / urls_deferred.py 中找到"))

    elif distribution == "marketplace" and manifest_data is None:
        r.append(("Backend", WARN, "[推荐] manifest 解析失败，无法判断 marketplace App 是否需要 Django App"))
    elif distribution == "marketplace" and not uses_host_backend and _has_explicit_non_backend_binding(manifest_data):
        r.append(("Backend", SKIP, "[可选] manifest 已声明 clientBridge/CLI/embeddedWeb，无独立 Django App（允许）"))
    elif distribution == "marketplace" and not uses_host_backend:
        r.append(("Backend", WARN, "[推荐] marketplace App 未声明 hostBackend，也未声明明确的非后端绑定，请核对 manifest"))
    elif app_def.context_type:
        r.append(("Backend", FAIL, f"[必填] Django App 目录不存在（{app_id}）"))
    else:
        r.append(("Backend", SKIP, "无独立 Django App（前端原生 App）"))

    # ── 3. Agent 系统 ──
    # AgentState TypedDict
    try:
        from apps.services.agent_engine.state.agent_state import AgentState
        state_keys = set(AgentState.__annotations__.keys())
        for f in app_def.context_fields:
            if f.name in state_keys:
                r.append(("Agent", PASS, f"[必填] AgentState 含 '{f.name}'"))
            else:
                r.append(("Agent", FAIL, f"[必填] AgentState 缺少 '{f.name}'"))
    except Exception as exc:
        if app_def.context_fields:
            r.append(("Agent", FAIL, f"[必填] 无法导入 AgentState: {type(exc).__name__}: {exc}"))

    # UpdateContextRequest Schema (后端)
    try:
        from apps.chat.conversation.schemas import UpdateContextRequest
        schema_fields = set(UpdateContextRequest.model_fields.keys())
        for f in app_def.context_fields:
            if f.name in schema_fields:
                r.append(("Agent", PASS, f"[必填] UpdateContextRequest 含 '{f.name}'"))
            else:
                r.append(("Agent", FAIL, f"[必填] UpdateContextRequest 缺少 '{f.name}'"))
    except Exception as exc:
        if app_def.context_fields:
            r.append(("Agent", FAIL, f"[必填] 无法导入 UpdateContextRequest: {type(exc).__name__}: {exc}"))

    # APP_SECTIONS（B1 双跑期：同时识别主仓 .py 与 packages/apps/<id>/prompts/<lang>/system.md）
    try:
        from apps.services.common.app_registry import APP_SECTIONS, get_prompt_source
        if app_def.has_prompt_section:
            if app_id in APP_SECTIONS:
                r.append(("Agent", PASS, "[必填] APP_SECTIONS 有对应提示词"))
            else:
                r.append(("Agent", FAIL, "[必填] has_prompt_section=True 但 APP_SECTIONS 无对应条目"))

            prompt_file = _DJANGO_ROOT / "apps" / "services" / "agent_engine" / "prompts" / "apps" / f"{app_id}.py"
            marketplace_prompts = _PROJECT_ROOT / "packages" / "apps" / app_id / "prompts"
            marketplace_md = (
                list(marketplace_prompts.glob("*/system.md"))
                if marketplace_prompts.is_dir()
                else []
            )

            if prompt_file.exists() and marketplace_md:
                source_label = get_prompt_source(app_id) or "py"
                langs = sorted({p.parent.name for p in marketplace_md})
                r.append((
                    "Agent",
                    PASS,
                    f"[必填] prompt 双源并存（B1 双跑期，运行时来源={source_label}；"
                    f"marketplace 优先于 .py）："
                    f"prompts/apps/{app_id}.py + packages/apps/{app_id}/prompts/{{{','.join(langs)}}}/system.md",
                ))
            elif prompt_file.exists():
                r.append(("Agent", PASS, f"[必填] 提示词文件 prompts/apps/{app_id}.py"))
            elif marketplace_md:
                langs = sorted({p.parent.name for p in marketplace_md})
                r.append((
                    "Agent",
                    PASS,
                    f"[必填] 提示词文件 packages/apps/{app_id}/prompts/{{{','.join(langs)}}}/system.md",
                ))
            else:
                r.append((
                    "Agent",
                    WARN,
                    f"[推荐] prompts/apps/{app_id}.py 与 packages/apps/{app_id}/prompts/<lang>/system.md 均不存在",
                ))
        elif app_id in APP_SECTIONS:
            r.append(("Agent", WARN, "[推荐] APP_SECTIONS 有条目但未声明 has_prompt_section=True"))
    except Exception as exc:
        if app_def.has_prompt_section:
            r.append(("Agent", FAIL, f"[必填] 无法导入 APP_SECTIONS: {type(exc).__name__}: {exc}"))

    # ToolHub 域
    if app_def.tool_domains:
        try:
            from apps.services.tools.hub import ToolHub
            registered = set(ToolHub.list_domains())
            for domain in app_def.tool_domains:
                if domain in registered:
                    r.append(("Agent", PASS, f"[必填] ToolHub 域 '{domain}' 已注册"))
                else:
                    r.append(("Agent", FAIL, f"[必填] ToolHub 域 '{domain}' 未注册"))
        except Exception as exc:
            r.append(("Agent", FAIL, f"[必填] 无法导入 ToolHub: {type(exc).__name__}: {exc}"))

    # ── 4. Frontend ──
    handler_dir = _RENDERER_BASE / "components" / "context-space" / "registry" / "handlers"
    home_dir = _RENDERER_BASE / "components" / "context-space" / "registry" / "homeSections"
    i18n_zh = _RENDERER_BASE / "i18n" / "locales" / "zh-CN"
    i18n_en = _RENDERER_BASE / "i18n" / "locales" / "en-US"

    # ContextTypeHandler
    handler_file = _find_handler_file(handler_dir, app_id)
    if handler_file:
        r.append(("Frontend", PASS, f"[必填] ContextTypeHandler: {handler_file.name}"))

        hc = _read_file(handler_file)
        if hc:
            if "renderPane" in hc:
                r.append(("Frontend", PASS, "[必填] handler 含 renderPane"))
            else:
                r.append(("Frontend", FAIL, "[必填] handler 缺少 renderPane"))

            if f"type:" in hc or f"type :" in hc:
                r.append(("Frontend", PASS, "[必填] handler 含 type 字段"))

            if "appId:" in hc or "appId :" in hc:
                r.append(("Frontend", PASS, "[必填] handler 含 appId 字段"))
            else:
                r.append(("Frontend", FAIL, "[必填] handler 缺少 appId 字段"))

            if "displayLabel" in hc:
                r.append(("Frontend", PASS, "[推荐] handler 含 displayLabel"))
            else:
                r.append(("Frontend", WARN, "[推荐] handler 缺少 displayLabel（产品名称）"))

            if "appMeta" in hc:
                r.append(("Frontend", PASS, "[必填] handler 含 appMeta（AI 上下文映射）"))
                if "idField" in hc or "resolve" in hc:
                    r.append(("Frontend", PASS, "[必填] appMeta 含 idField 或 resolve"))
                else:
                    r.append(("Frontend", FAIL, "[必填] appMeta 缺少 idField/resolve"))
            elif app_def.context_fields:
                r.append(("Frontend", FAIL, "[必填] handler 缺少 appMeta（有 context_fields 的 App 必须声明）"))

            if "getTabLabel" in hc:
                r.append(("Frontend", PASS, "[推荐] handler 含 getTabLabel"))
            else:
                r.append(("Frontend", WARN, "[推荐] handler 缺少 getTabLabel（标签页标题）"))

            if "getTabIcon" in hc:
                r.append(("Frontend", PASS, "[推荐] handler 含 getTabIcon"))
            else:
                r.append(("Frontend", HINT, "[可选] handler 缺少 getTabIcon"))

            if "searchable" in hc and app_def.searchable:
                r.append(("Frontend", PASS, "[推荐] handler 声明 searchable"))
                if "searchLabelKey" in hc:
                    r.append(("Frontend", PASS, "[必填] searchable 时含 searchLabelKey"))
                else:
                    r.append(("Frontend", FAIL, "[必填] searchable=true 但缺少 searchLabelKey"))

            if "quickAction" in hc:
                r.append(("Frontend", PASS, "[推荐] handler 含 quickAction"))

            if "persistOnly" in hc:
                r.append(("Frontend", PASS, "[推荐] handler 声明 persistOnly"))
    else:
        if app_def.context_type:
            if _uses_embedded_web(manifest_data):
                r.append(("Frontend", PASS, "[必填] embeddedWeb App 走通用宿主路径，无需专属 handler"))
            else:
                r.append(("Frontend", FAIL, "[必填] ContextTypeHandler 缺失"))
        else:
            r.append(("Frontend", SKIP, "无 ContextTypeHandler（无 context_type）"))

    # registry 注册检查（已改为 import.meta.glob 自动注册，只需文件存在即可）
    if handler_file:
        r.append(("Frontend", PASS, "[必填] handler 文件存在，import.meta.glob 自动注册"))

    # HomeSectionHandler
    home_candidates = _HANDLER_ALIASES.get(app_id, [app_id, _strip_tin_prefix(app_id)])
    home_file = None
    for stem in home_candidates:
        for ext in [".tsx", ".ts"]:
            p = home_dir / f"{stem}{ext}"
            if p.exists():
                home_file = p
                break
        if home_file:
            break

    if home_file:
        r.append(("Frontend", PASS, f"[推荐] HomeSectionHandler: {home_file.name}"))
    elif app_def.context_type and app_def.can_create:
        if _uses_embedded_web(manifest_data):
            r.append(("Frontend", PASS, "[推荐] embeddedWeb App 走通用 Home section，无需专属文件"))
        else:
            r.append(("Frontend", WARN, "[推荐] HomeSectionHandler 缺失（有资源列表的 App 建议有）"))
    else:
        r.append(("Frontend", SKIP, "[可选] 无 HomeSectionHandler"))

    # i18n
    i18n_found = False
    for pattern in [f"{app_id}.json", f"{_strip_tin_prefix(app_id)}.json"]:
        if (i18n_zh / pattern).exists():
            i18n_found = True
            r.append(("Frontend", PASS, f"[必填] i18n zh-CN: {pattern}"))
            break
    if not i18n_found:
        if app_def.context_type:
            r.append(("Frontend", WARN, "[推荐] 未找到 zh-CN i18n 文件"))
        else:
            r.append(("Frontend", SKIP, "[可选] 无 i18n 文件"))

    i18n_en_found = False
    for pattern in [f"{app_id}.json", f"{_strip_tin_prefix(app_id)}.json"]:
        if (i18n_en / pattern).exists():
            i18n_en_found = True
            r.append(("Frontend", PASS, f"[推荐] i18n en-US: {pattern}"))
            break
    if not i18n_en_found and i18n_found:
        r.append(("Frontend", WARN, "[推荐] 缺少 en-US i18n 文件"))

    # i18n home key 检查
    if i18n_found and app_def.context_type:
        import json as _json
        i18n_file = None
        for pattern in [f"{app_id}.json", f"{_strip_tin_prefix(app_id)}.json"]:
            p = i18n_zh / pattern
            if p.exists():
                i18n_file = p
                break
        if i18n_file:
            try:
                i18n_data = _json.loads(_read_file(i18n_file))
                home_keys = i18n_data.get("home", {})
                if home_keys:
                    r.append(("Frontend", PASS, f"[推荐] i18n 含 home 区域 ({len(home_keys)} key)"))
                else:
                    r.append(("Frontend", HINT, "[可选] i18n 无 home 区域（HomeSectionHandler 所需的 loading/empty 等）"))
            except Exception as exc:
                r.append(("Frontend", WARN, f"[推荐] i18n 解析失败: {type(exc).__name__}: {exc}"))

    # chat-client 前端类型
    chat_client_types = _PROJECT_ROOT / "packages" / "tabtin-chat-client" / "src" / "types" / "context.ts"
    if chat_client_types.exists() and app_def.context_fields:
        content = _read_file(chat_client_types)
        first_field = app_def.context_fields[0].name
        if first_field in content:
            r.append(("Frontend", PASS, f"[必填] chat-client 类型含 '{first_field}'"))
        else:
            r.append(("Frontend", FAIL, f"[必填] chat-client 缺少字段 '{first_field}'"))

    # useCreateHandlers 回调
    if app_def.can_create:
        create_handlers_file = _RENDERER_BASE / "components" / "context-space" / "hooks" / "useCreateHandlers.ts"
        if create_handlers_file.exists():
            ch_content = _read_file(create_handlers_file)
            search_variants = [app_id, _strip_tin_prefix(app_id)]
            found_handler = any(v in ch_content for v in search_variants)
            if found_handler:
                r.append(("Frontend", PASS, "[推荐] useCreateHandlers 含创建回调"))
            else:
                r.append(("Frontend", WARN, "[推荐] useCreateHandlers 缺少创建回调（can_create=True 的 App 应有）"))

    # ── 5. Tools & Skill ──
    tool_reg_dir = _DJANGO_ROOT / "tool_registry" / app_id
    if tool_reg_dir.exists():
        app_json = tool_reg_dir / "_app.json"
        if app_json.exists():
            r.append(("Tools", PASS, f"[推荐] tool_registry/{app_id}/_app.json"))
        else:
            r.append(("Tools", HINT, f"[可选] tool_registry/{app_id}/ 缺少 _app.json"))
    else:
        r.append(("Tools", SKIP, "[可选] 无 tool_registry 目录"))

    pkg_app_json = _PROJECT_ROOT / "packages" / "apps" / app_id / "app.json"
    if pkg_app_json.exists():
        r.append(("Tools", PASS, f"[推荐] packages/apps/{app_id}/app.json"))
    else:
        r.append(("Tools", HINT, f"[可选] 无 packages/apps/{app_id}/app.json"))

    # SKILL.md
    skill_dirs = [
        _PROJECT_ROOT / "packages" / "apps" / app_id / "skills",
        _DJANGO_ROOT / "apps" / "skills" / "bundled" / "platform" / app_id,
    ]
    skill_found = False
    for sd in skill_dirs:
        if sd.exists():
            skills = list(sd.rglob("SKILL.md"))
            if skills:
                skill_found = True
                r.append(("Skill", PASS, f"[推荐] SKILL.md: {len(skills)} 个 (in {sd.relative_to(_PROJECT_ROOT)})"))
    if not skill_found:
        if app_def.tool_domains:
            r.append(("Skill", WARN, "[推荐] 有 tool_domains 但未找到 SKILL.md"))
        else:
            r.append(("Skill", SKIP, "[可选] 无 SKILL.md"))

    # ── 6. RECONCILE_APPS 补偿注册 ──
    if app_def.context_type and app_def.context_fields:
        reconcile_file = _DJANGO_ROOT / "apps" / "tabtinspace" / "tasks.py"
        if reconcile_file.exists():
            rc_content = _read_file(reconcile_file)
            if f"apps.{app_id}" in rc_content:
                r.append(("Backend", PASS, "[推荐] RECONCILE_APPS 已注册"))
            else:
                r.append(("Backend", HINT, "[可选] RECONCILE_APPS 未注册（新资源型 App 建议添加补偿扫描）"))

    return r


def _get_installed_apps_and_routers() -> tuple[set[str], set[str]]:
    try:
        from django.conf import settings
        return set(getattr(settings, "INSTALLED_APPS", [])), set(getattr(settings, "DATABASE_ROUTERS", []))
    except Exception as exc:
        _record_load_error("加载 django settings(INSTALLED_APPS/DATABASE_ROUTERS)", exc)
        return set(), set()


def _summarize(checks: list[tuple[str, str, str]]) -> dict:
    total = len(checks)
    passed = sum(1 for _, s, _ in checks if s == PASS)
    failed = sum(1 for _, s, _ in checks if s == FAIL)
    warned = sum(1 for _, s, _ in checks if s == WARN)
    hinted = sum(1 for _, s, _ in checks if s == HINT)
    skipped = sum(1 for _, s, _ in checks if s == SKIP)
    fail_by_dim: dict[str, int] = {}
    warn_by_dim: dict[str, int] = {}
    for dim, s, _ in checks:
        if s == FAIL:
            fail_by_dim[dim] = fail_by_dim.get(dim, 0) + 1
        elif s == WARN:
            warn_by_dim[dim] = warn_by_dim.get(dim, 0) + 1
    return {"total": total, "passed": passed, "failed": failed,
            "warned": warned, "hinted": hinted, "skipped": skipped,
            "fail_by_dim": fail_by_dim, "warn_by_dim": warn_by_dim}


def _select_apps_for_audit(distribution: str = "builtin", app_id: Optional[str] = None) -> dict:
    from apps.services.common.app_registry import CORE_APPS, MARKETPLACE_APPS, get_app, list_apps

    if app_id:
        app_def = get_app(app_id)
        if not app_def:
            return {}
        return {app_id: app_def}

    if distribution == "builtin":
        return dict(CORE_APPS)
    if distribution == "marketplace":
        return dict(MARKETPLACE_APPS)
    return {app.id: app for app in list_apps()}


class Command(BaseCommand):
    help = "审计 App 注册完整性（manifest 入口，默认 builtin，可分流 marketplace/all）"

    def add_arguments(self, parser):
        parser.add_argument("--app", type=str, default=None,
                            help="指定单个 App ID（如 tabdoc）")
        parser.add_argument("--distribution", type=str, default="builtin",
                            choices=["builtin", "marketplace", "all"],
                            help="指定审计范围，默认 builtin（兼容 infra-gate）")
        parser.add_argument("--strict", action="store_true",
                            help="必填项失败时退出码 1（CI 模式）")
        parser.add_argument("--verbose", action="store_true",
                            help="全局概览也打印每个 App 详情")

    def handle(self, *args, **options):
        _LOAD_ERRORS.clear()
        target = options["app"]
        selected_apps = _select_apps_for_audit(options["distribution"], target)
        if target:
            self._audit_single(target, selected_apps, options)
        else:
            self._audit_all(selected_apps, options)

    def _print_unchecked_notice(self):
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [未检查项 — 需开发者自行验证]"))
        notices = [
            "Service 层 BaseService 继承与 ResourceBridge（on_create/on_update/on_archive/on_delete）调用",
            "标签页持久化 resolveTabItem 实现",
            "实时协作（Hocuspocus / CollabAdapter）配置",
            "handler backendAliases 配置（兼容旧 context_type 的 App）",
            "Context Source hook（sources/{app}.ts）实现",
            "PaneHost 入口组件接收 resourceId + projectId",
        ]
        for n in notices:
            self.stdout.write(f"    {HINT} {n}")
        self.stdout.write("")

    def _print_checks(self, checks: list[tuple[str, str, str]]):
        current_dim = ""
        for dim, status, msg in checks:
            if dim != current_dim:
                current_dim = dim
                self.stdout.write(self.style.MIGRATE_HEADING(f"\n  [{dim}]"))
            if status == PASS:
                self.stdout.write(self.style.SUCCESS(f"    {status} {msg}"))
            elif status == FAIL:
                self.stdout.write(self.style.ERROR(f"    {status} {msg}"))
            elif status == WARN:
                self.stdout.write(self.style.WARNING(f"    {status} {msg}"))
            elif status == HINT:
                self.stdout.write(f"    {status} {msg}")
            else:
                self.stdout.write(f"    {status} {msg}")

    def _audit_single(self, app_id: str, selected_apps: dict, options: dict):
        if app_id not in selected_apps:
            scope = options.get("distribution", "builtin")
            self.stderr.write(self.style.ERROR(f"App '{app_id}' 不在当前 manifest 审计集合中（distribution={scope}）。"))
            self.stderr.write(f"可用: {', '.join(sorted(selected_apps.keys())) or '无'}")
            raise SystemExit(1)

        app_def = selected_apps[app_id]
        self.stdout.write(self.style.HTTP_INFO(
            f"\n{'='*60}\n  审计报告: {app_def.name} ({app_id})\n{'='*60}"
        ))

        checks = _audit_single_app(app_id, app_def)
        if _LOAD_ERRORS:
            for err in _LOAD_ERRORS:
                checks.append(("全局", FAIL, f"[必填] 审计数据加载异常: {err}"))
        self._print_checks(checks)

        s = _summarize(checks)
        self.stdout.write(self.style.HTTP_INFO(
            f"\n  总计: {s['total']} | 通过: {s['passed']} | "
            f"必填失败: {s['failed']} | 推荐缺失: {s['warned']} | "
            f"可选提示: {s['hinted']} | 跳过: {s['skipped']}"
        ))
        self._print_unchecked_notice()

        if s["failed"] > 0 and options["strict"]:
            raise SystemExit(1)

    def _audit_all(self, selected_apps: dict, options: dict):
        if not selected_apps:
            self.stdout.write(self.style.WARNING(
                f"\n未找到可审计 App（distribution={options.get('distribution', 'builtin')}）"
            ))
            return

        self.stdout.write(self.style.HTTP_INFO(
            f"\n{'='*80}\n  TabTin App 全局审计报告（distribution={options.get('distribution', 'builtin')}）\n{'='*80}"
        ))

        # 全局检查
        global_checks = _check_global(selected_apps)
        if _LOAD_ERRORS:
            global_checks.extend([("全局", FAIL, f"[必填] 审计数据加载异常: {err}") for err in _LOAD_ERRORS])
        self._print_checks(global_checks)
        global_fails = sum(1 for _, s, _ in global_checks if s == FAIL)
        counted_load_errors = len(_LOAD_ERRORS)
        self.stdout.write("")

        # 表头
        header = f"  {'App':<14} {'Name':<12} {'总计':>4} {'通过':>4} {'必填✗':>6} {'推荐⚠':>6} {'可选ℹ':>5} {'跳过':>4}"
        self.stdout.write(self.style.MIGRATE_HEADING(header))
        self.stdout.write("  " + "─" * 72)

        all_summaries = []
        for app_id, app_def in sorted(selected_apps.items(), key=lambda x: x[1].order):
            checks = _audit_single_app(app_id, app_def)
            s = _summarize(checks)
            s["id"] = app_id
            s["name"] = app_def.name
            s["checks"] = checks
            all_summaries.append(s)

            status = PASS if s["failed"] == 0 else FAIL
            line = (f"  {app_id:<14} {app_def.name:<12} "
                    f"{s['total']:>4} {s['passed']:>4} {s['failed']:>6} "
                    f"{s['warned']:>6} {s['hinted']:>5} {s['skipped']:>4}  {status}")
            if s["failed"] > 0:
                self.stdout.write(self.style.ERROR(line))
            elif s["warned"] > 0:
                self.stdout.write(self.style.WARNING(line))
            else:
                self.stdout.write(line)

        if len(_LOAD_ERRORS) > counted_load_errors:
            self.stdout.write(self.style.MIGRATE_HEADING("\n  [全局]"))
            for err in _LOAD_ERRORS[counted_load_errors:]:
                self.stdout.write(self.style.ERROR(f"    {FAIL} [必填] 审计数据加载异常: {err}"))
            global_fails += len(_LOAD_ERRORS) - counted_load_errors

        self.stdout.write("  " + "─" * 72)

        total_apps = len(all_summaries)
        clean = sum(1 for s in all_summaries if s["failed"] == 0)
        fail_apps = total_apps - clean
        total_fails = sum(s["failed"] for s in all_summaries) + global_fails
        total_warns = sum(s["warned"] for s in all_summaries)

        self.stdout.write(self.style.HTTP_INFO(
            f"\n  共 {total_apps} 个 App | 必填全通过: {clean} | 有必填失败: {fail_apps}"
        ))
        self.stdout.write(self.style.HTTP_INFO(
            f"  必填失败合计: {total_fails} | 推荐缺失合计: {total_warns}"
        ))

        agg_fail_dim: dict[str, int] = {}
        agg_warn_dim: dict[str, int] = {}
        for s in all_summaries:
            for dim, n in s.get("fail_by_dim", {}).items():
                agg_fail_dim[dim] = agg_fail_dim.get(dim, 0) + n
            for dim, n in s.get("warn_by_dim", {}).items():
                agg_warn_dim[dim] = agg_warn_dim.get(dim, 0) + n
        if agg_fail_dim or agg_warn_dim:
            self.stdout.write(self.style.MIGRATE_HEADING("\n  按维度分布:"))
            all_dims = sorted(set(list(agg_fail_dim.keys()) + list(agg_warn_dim.keys())))
            for dim in all_dims:
                nf = agg_fail_dim.get(dim, 0)
                nw = agg_warn_dim.get(dim, 0)
                parts = []
                if nf:
                    parts.append(f"必填✗ {nf}")
                if nw:
                    parts.append(f"推荐⚠ {nw}")
                if parts:
                    line = f"    {dim:<12} {' | '.join(parts)}"
                    if nf:
                        self.stdout.write(self.style.ERROR(line))
                    else:
                        self.stdout.write(self.style.WARNING(line))

        if fail_apps > 0:
            self.stdout.write(self.style.NOTICE(
                "\n  提示: 使用 --app <id> 查看单个 App 详细报告"
            ))

        self._print_unchecked_notice()

        if options["verbose"]:
            self.stdout.write(self.style.HTTP_INFO(f"\n{'='*80}\n  详细报告\n{'='*80}"))
            for s in all_summaries:
                self.stdout.write(self.style.MIGRATE_HEADING(f"\n  ── {s['name']} ({s['id']}) ──"))
                self._print_checks(s["checks"])

        self.stdout.write("")

        if total_fails > 0 and options["strict"]:
            raise SystemExit(1)

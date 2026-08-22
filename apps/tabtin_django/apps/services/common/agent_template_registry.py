"""精品 Agent 模板静态注册表（唯一声明源）。

Refs GitHub （B1.1 模板机制层）；方案底稿
``docs/prd/agent-workspace-project-model-audit-v1.md`` §11 R3（模板/实例分离）。

模板存储形态 = manifest 文件：``packages/agents/<id>/agent.json``，模式参照
``packages/apps/*/app.json`` + ``app_registry``（启动扫描、frozen dataclass、
容错跳过坏文件）。

设计约束（SoulPreset 教训，宪法 v0.1 §3.6.1）：
- **白名单字段制**：loader 遇到白名单外字段告警并忽略，绝不让模板越界携带
  ``agent_config`` 引擎参数、记忆、审批记忆、设备、工作目录（历史上 SoulPreset
  因 ``agent_config_overrides`` 越界 + 与 persona 职责重叠而在 migration 0053 被删）。
- **升级语义 = 冻结快照**：实例化时把模板字段值拷贝到 Agent 行并写入
  ``template_id`` / ``template_version`` 溯源；模板后续更新不影响存量实例。
- ``default_mode`` 非法值（不在六模式枚举内）**拒绝整个模板**——交互模式是模板
  的核心出厂配置，坏值说明 manifest 已损坏，宁缺毋滥。

用法::

    from apps.services.common.agent_template_registry import (
        get_agent_template, list_agent_templates,
    )
"""

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from apps.services.agent_engine.agent_mode import ALL_AGENT_MODES
from apps.services.repo_root import get_repo_root

logger = logging.getLogger(__name__)

# 模板 id 必须是 slug：小写字母/数字/连字符，与目录名一致。
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# 白名单字段（已拍板口径， B1.1）。
_ALLOWED_FIELDS = frozenset({
    "id", "version", "name", "icon", "avatar_key", "tagline", "description",
    "persona", "initial_rules", "suggested_prompts", "welcome_message", "default_mode",
    "goal", "skills", "translations",
})

# 显式禁止清单：SoulPreset 死因字段。命中时用更醒目的告警措辞（同样忽略，
# 不阻断其余模板加载）。宪法 v0.1 §3.6.1：模板不得 override 引擎参数。
_FORBIDDEN_FIELDS = frozenset({
    "agent_config", "agent_config_overrides", "memory", "approval_memo",
    "device", "devices", "device_fingerprint", "working_dir", "working_dir_type",
})


@dataclass(frozen=True)
class AgentTemplateDefinition:
    """精品 Agent 模板定义（冻结快照的声明源）。"""

    id: str                                   # 模板 slug，与目录名一致
    version: str = ""                         # 实例化时写入 Agent.template_version
    name: str = ""                            # 实例化后 Agent 名称缺省值
    icon: str = ""                            # 图标标识（前端模板选择器展示）
    avatar_key: str = ""                      # 品牌头像标识 → Agent.settings.avatar_key
    tagline: str = ""                         # 一句话标语
    description: str = ""                     # 详细描述
    persona: str = ""                         # 模板出厂说明（展示用，不写入 Agent.custom_rules）
    initial_rules: str = ""                   # 简短可编辑的出厂规则 → Agent.custom_rules
    suggested_prompts: tuple[str, ...] = ()   # 推荐问题 → Agent.suggested_prompts
    welcome_message: str = ""                 # 欢迎语 → Agent.settings.welcome_message
    default_mode: str = ""                    # 六模式枚举之一；空=未声明（沿用产品默认）
    goal: str = ""                            # Agent 目标 → Agent.goal
    # skill 携带集引用清单（ B1.2）：实例化时复制为 AgentSkillLink 行
    # （AgentService._copy_template_skills，与实例化同事务）。条目须为带
    # source 前缀的 canonical key（platform:<id> / app:<app_id>/<id> / device:<id>）。
    skills: tuple[str, ...] = ()
    # 多语言文案（可选）。本期只存不消费，留给模板选择器 i18n。
    translations: Optional[dict] = None


def _str_field(data: dict, key: str) -> str:
    """读取字符串字段；非字符串降级为 '' 并告警（不阻断模板加载）。"""
    value = data.get(key, "")
    if value is None:
        return ""
    if not isinstance(value, str):
        logger.warning(
            "[AgentTemplateRegistry] %s 字段 %r 应为字符串（实际 %s），忽略",
            data.get("id", "?"), key, type(value).__name__,
        )
        return ""
    return value


def _str_tuple_field(data: dict, key: str) -> tuple[str, ...]:
    """读取字符串列表字段；非 list / 非字符串条目跳过并告警。"""
    raw = data.get(key)
    if raw is None:
        return ()
    if not isinstance(raw, list):
        logger.warning(
            "[AgentTemplateRegistry] %s 字段 %r 应为字符串列表（实际 %s），忽略",
            data.get("id", "?"), key, type(raw).__name__,
        )
        return ()
    items: list[str] = []
    for entry in raw:
        if isinstance(entry, str) and entry:
            items.append(entry)
        else:
            logger.warning(
                "[AgentTemplateRegistry] %s 字段 %r 存在非字符串条目，跳过: %r",
                data.get("id", "?"), key, entry,
            )
    return tuple(items)


def _load_template_from_manifest(manifest_path: Path) -> Optional[AgentTemplateDefinition]:
    """从 packages/agents/<id>/agent.json 解析出 AgentTemplateDefinition。

    返回 None 表示模板被拒绝（id 缺失/非法、default_mode 非法）；
    JSON 解析异常由调用方（扫描循环）容错捕获。
    """
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        logger.warning(
            "[AgentTemplateRegistry] manifest 顶层不是 JSON object，跳过: %s",
            manifest_path,
        )
        return None

    template_id = data.get("id", "")
    if not isinstance(template_id, str) or not _SLUG_RE.match(template_id):
        logger.warning(
            "[AgentTemplateRegistry] manifest id 缺失或非法（应为 slug），跳过: %s (id=%r)",
            manifest_path, template_id,
        )
        return None
    if template_id != manifest_path.parent.name:
        logger.warning(
            "[AgentTemplateRegistry] 模板 id %r 与目录名 %r 不一致（以 id 为准）: %s",
            template_id, manifest_path.parent.name, manifest_path,
        )

    # ── 白名单检查：禁止清单强告警、其余未知字段普通告警，均忽略 ──
    for key in data.keys():
        if key in _ALLOWED_FIELDS:
            continue
        if key in _FORBIDDEN_FIELDS:
            logger.warning(
                "[AgentTemplateRegistry] 模板 %s 携带禁止字段 %r（SoulPreset 教训，"
                "宪法 v0.1 §3.6.1：模板不得携带引擎参数/记忆/设备/目录），已忽略",
                template_id, key,
            )
        else:
            logger.warning(
                "[AgentTemplateRegistry] 模板 %s 携带白名单外字段 %r，已忽略",
                template_id, key,
            )

    # ── default_mode：六模式枚举强校验，非法值拒绝整个模板 ──
    default_mode = data.get("default_mode", "")
    if default_mode is None:
        default_mode = ""
    if default_mode and default_mode not in ALL_AGENT_MODES:
        logger.warning(
            "[AgentTemplateRegistry] 模板 %s 的 default_mode=%r 不在六模式枚举 %s 内，"
            "拒绝加载该模板",
            template_id, default_mode, list(ALL_AGENT_MODES),
        )
        return None

    translations = data.get("translations")
    if translations is not None and not isinstance(translations, dict):
        logger.warning(
            "[AgentTemplateRegistry] 模板 %s 的 translations 应为 object（实际 %s），忽略",
            template_id, type(translations).__name__,
        )
        translations = None

    skills = _str_tuple_field(data, "skills")
    # （一半）：skills 引用存在性告警——loader 不拒绝，但坏引用要在
    # 启动日志可见，不再静默变成实例化后的空承诺。
    _warn_missing_skill_sources(template_id, skills)

    return AgentTemplateDefinition(
        id=template_id,
        version=_str_field(data, "version"),
        name=_str_field(data, "name"),
        icon=_str_field(data, "icon"),
        avatar_key=_str_field(data, "avatar_key"),
        tagline=_str_field(data, "tagline"),
        description=_str_field(data, "description"),
        persona=_str_field(data, "persona"),
        initial_rules=_str_field(data, "initial_rules"),
        suggested_prompts=_str_tuple_field(data, "suggested_prompts"),
        welcome_message=_str_field(data, "welcome_message"),
        default_mode=default_mode if isinstance(default_mode, str) else "",
        goal=_str_field(data, "goal"),
        skills=skills,
        translations=translations,
    )


def _skill_source_candidates(canonical_key: str) -> Optional[list[Path]]:
    """把 canonical key 映射到 bundled 源目录候选列表（存在性检查用）。

    路径规则与运行时装载方字面对齐：
    - ``app:<app_id>/<slug>`` → ``packages/apps/<app_id>/skills/<slug>``，
      回退 ``packages/skills/<slug>``（首方 package skill 布局，见
      agent-runtime ``materializeAppSkill`` 的双候选解析）；
    - ``platform:<domain>/<slug>`` → ``packages/skills/bundled/platform/<domain>/<slug>``；
    - ``device:*`` → 本机注册表（``~/.agents/skills``），静态扫描无法验证，返回 None。

    返回 None 表示「无法静态验证，跳过检查」。
    """
    prefix, _, rest = canonical_key.partition(":")
    root = get_repo_root()
    if prefix == "app":
        app_id, sep, slug = rest.partition("/")
        if not sep or not app_id or not slug:
            return []
        return [
            root / "packages" / "apps" / app_id / "skills" / slug,
            root / "packages" / "skills" / slug,
        ]
    if prefix == "platform":
        domain, sep, slug = rest.partition("/")
        if not sep or not domain or not slug:
            return []
        return [root / "packages" / "skills" / "bundled" / "platform" / domain / slug]
    # device / 其他前缀：不在仓库内，静态无法验证。
    return None


def _warn_missing_skill_sources(template_id: str, skills: tuple[str, ...]) -> None:
    """skills 携带集存在性检查（ 一半：加载期告警，不拒绝模板）。

    loader 历史上只校验前缀合法、不验 Skill 真实存在——引用错了不报错，
    用户实例化后拿到的是空承诺。这里对每个条目按 bundled 源目录做静态
    存在性检查（找 ``SKILL.md``），查不到就告警（含模板 id + 非法 key），
    让坏引用在启动日志立刻可见。仍不拒绝模板 / 不剔除条目：与实例化侧
    ``_copy_template_skills`` 的「非法条目跳过不阻断」容错口径一致，
    运行期强校验（ 另一半）待 skill registry 侧统一收口。
    """
    for key in skills:
        try:
            candidates = _skill_source_candidates(key)
            if candidates is None:
                continue
            if not any((c / "SKILL.md").is_file() for c in candidates):
                logger.warning(
                    "[AgentTemplateRegistry] 模板 %s 的 skills 条目 %r 在仓库内"
                    "找不到对应技能目录（已按 app/platform 布局检查），该引用"
                    "实例化后将是空承诺，请核对 canonical key",
                    template_id, key,
                )
        except Exception:
            # 存在性检查是尽力而为的启动期提示，绝不因 IO 异常阻断模板加载。
            logger.debug(
                "[AgentTemplateRegistry] 模板 %s 的 skills 存在性检查失败: %r",
                template_id, key, exc_info=True,
            )


def _default_templates_dir() -> Path:
    return get_repo_root() / "packages" / "agents"


def _scan_all_agent_templates(
    templates_dir: Optional[Path] = None,
) -> dict[str, AgentTemplateDefinition]:
    """扫描 packages/agents/*/agent.json。

    单个 manifest 解析失败（坏 JSON / IO 异常）时跳过并告警，不阻断启动。
    ``templates_dir`` 参数仅供测试注入临时目录。
    """
    scan_dir = templates_dir or _default_templates_dir()
    templates: dict[str, AgentTemplateDefinition] = {}

    if not scan_dir.is_dir():
        logger.warning(
            "[AgentTemplateRegistry] 模板目录不存在: %s，模板列表将为空", scan_dir,
        )
        return templates

    for manifest_path in sorted(scan_dir.glob("*/agent.json")):
        try:
            template = _load_template_from_manifest(manifest_path)
        except Exception:
            logger.warning(
                "[AgentTemplateRegistry] manifest 解析失败，跳过: %s",
                manifest_path, exc_info=True,
            )
            continue
        if template is None:
            continue
        if template.id in templates:
            logger.warning(
                "[AgentTemplateRegistry] 模板 id %r 重复，仅保留首次扫描到的定义: %s",
                template.id, manifest_path,
            )
            continue
        templates[template.id] = template

    if templates:
        logger.info(
            "[AgentTemplateRegistry] 发现 %d 个 Agent 模板: %s",
            len(templates), ", ".join(templates.keys()),
        )
    return templates


AGENT_TEMPLATES: dict[str, AgentTemplateDefinition] = _scan_all_agent_templates()


def get_agent_template(template_id: str) -> Optional[AgentTemplateDefinition]:
    """根据 id 获取模板定义；未知 id 返回 None。"""
    return AGENT_TEMPLATES.get(template_id)


def list_agent_templates() -> list[AgentTemplateDefinition]:
    """获取全部模板，按 id 字母序（输出稳定可预期）。"""
    return sorted(AGENT_TEMPLATES.values(), key=lambda t: t.id)


def reload_agent_templates(templates_dir: Optional[Path] = None) -> None:
    """重扫模板目录（测试用：模拟模板更新后的重新加载）。

    生产运行时模板在启动时扫描一次即定格——「冻结快照」语义下运行中重扫
    只影响后续新实例化，不回写存量实例。
    """
    global AGENT_TEMPLATES
    AGENT_TEMPLATES = _scan_all_agent_templates(templates_dir)


__all__ = [
    "AgentTemplateDefinition",
    "AGENT_TEMPLATES",
    "get_agent_template",
    "list_agent_templates",
    "reload_agent_templates",
]

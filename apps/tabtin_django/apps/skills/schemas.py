"""Skills API schemas（Wave 1，PRD V3.3；#7118 硬切）。

#7118：Skill HTTP 契约由 ``space_id`` 收敛为 ``organization_id`` + ``agent_id``：
- ``space_id`` 语义（Workspace 执行现场）不属于 Skill 归属维度，仅供
  SubAgent 模板同步等内部路径使用，不再暴露到 Skill HTTP
- 批量启用目标从 ``enable_space_ids`` 改为 ``enable_agent_ids``（Skill 归属 Agent）

Wave 1 重构（历史）：
- ``SkillSource`` Literal 4 档（platform/app/device/user）
- 删除旧云端表的 install / update / publish-to-market / unpublish 等请求体
- 新增 ``SkillCreateRequest`` / ``SkillEnableRequest`` / ``SkillDisableRequest`` /
  ``SkillVisibilityRequest`` / ``SkillConfigUpdateRequest``（迁移到 enablement）
"""

from typing import List, Optional, Literal, Dict, Any
from ninja import Schema

SkillSource = Literal["platform", "app", "device", "user"]
SkillVisibility = Literal["private", "organization", "public"]


# ---------------------------------------------------------------------------
# Rich metadata schemas (TabTin Skill 格式规范)
# ---------------------------------------------------------------------------


class SkillRequirements(Schema):
    """Skill dependency requirements for eligibility gating."""

    bins: List[str] = []
    any_bins: List[str] = []
    env: List[str] = []
    config: List[str] = []


class SkillInstallSpec(Schema):
    """Declarative install specification for a skill dependency."""

    id: str
    kind: Literal["brew", "node", "pip", "go", "download"]
    formula: Optional[str] = None
    package: Optional[str] = None
    module: Optional[str] = None
    url: Optional[str] = None
    bins: List[str] = []
    label: Optional[str] = None
    os: Optional[List[str]] = None


class SkillTabtinMetadata(Schema):
    """``metadata.tabtin.*`` 命名空间——TabTin 扩展字段（新标准格式）。

    所有 TabTin 私有扩展字段都收敛到这里；解析层（skill_doc_parser）仍对旧的
    顶层扁平写法做归一化回退。
    """

    displayName: Optional[str] = None
    display_name: Optional[str] = None
    category: Optional[str] = None
    emoji: Optional[str] = None
    primary_env: Optional[str] = None
    os: Optional[List[str]] = None
    always: Optional[bool] = None
    tools: Optional[List[str]] = None
    auto_activate_for: Optional[List[str]] = None
    requires: Optional[SkillRequirements] = None
    install: Optional[List[SkillInstallSpec]] = None
    homepage: Optional[str] = None


class SkillMetadata(Schema):
    """Extended metadata parsed from SKILL.md frontmatter。

    新标准格式：``version`` 与 ``tabtin`` 命名空间挂在 ``metadata`` 下；旧的顶层
    扁平字段（emoji / requires / install ...）仍由解析层归一化双读后保留兼容。
    """

    version: Optional[str] = None
    tabtin: Optional[SkillTabtinMetadata] = None
    emoji: Optional[str] = None
    primary_env: Optional[str] = None
    os: Optional[List[str]] = None
    always: bool = False
    requires: Optional[SkillRequirements] = None
    install: Optional[List[SkillInstallSpec]] = None
    homepage: Optional[str] = None


# ---------------------------------------------------------------------------
# Per-skill config（ M4.5：AgentSkillLink.config_json，schema 不变）
# ---------------------------------------------------------------------------


class SkillConfig(Schema):
    """Per-skill configuration（终态存于 ``AgentSkillLink.config_json``）。"""

    enabled: Optional[bool] = None
    credential_id: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    config: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Agent definition (parsed from agents/*.md within a Skill directory)
# ---------------------------------------------------------------------------


class AgentDefinitionSchema(Schema):
    """Agent role definition from agents/*.md frontmatter."""

    name: str
    description: Optional[str] = None
    model: Optional[str] = None
    reply_mode: Optional[str] = None
    tool_domains: Optional[List[str]] = None
    subagent_type: Optional[str] = None
    filename: Optional[str] = None
    body: Optional[str] = None


# ---------------------------------------------------------------------------
# Quick use（快速使用）交互模板 — 元数据驱动，仅 user 来源 skill 进库随版本快照
# ---------------------------------------------------------------------------


class SkillQuickUseVariable(Schema):
    """单个可编辑变量槽，形态对齐前端 ``PromptVariable``。"""

    key: str
    type: str = "input"
    label: Optional[str] = None
    placeholder: Optional[str] = None
    defaultValue: Optional[Any] = None
    options: Optional[List[Dict[str, str]]] = None
    config: Optional[Dict[str, Any]] = None


class SkillQuickUsePreset(Schema):
    """单个「快速使用」preset：一段带 ``{{var}}`` 槽位的 prompt + 变量定义 + 展示名。"""

    id: Optional[str] = None
    label: str
    promptTemplate: str
    variables: List[SkillQuickUseVariable] = []
    canSubmitKeys: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# Core index entry
# ---------------------------------------------------------------------------


class SkillIndexEntry(Schema):
    skill_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    version: Optional[str] = None
    source: SkillSource
    app_id: Optional[str] = None
    skill_key: Optional[str] = None
    path: Optional[str] = None
    doc_path: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None

    visibility: Optional[SkillVisibility] = None
    owner_user_id: Optional[str] = None
    organization_id: Optional[str] = None
    package_id: Optional[str] = None

    installed: Optional[bool] = None
    enabled: Optional[bool] = None
    installed_version_seq: Optional[int] = None
    installed_version_label: Optional[str] = None
    install_content_hash: Optional[str] = None

    emoji: Optional[str] = None
    primary_env: Optional[str] = None
    os_filter: Optional[List[str]] = None
    always: bool = False
    requires: Optional[SkillRequirements] = None
    install: Optional[List[SkillInstallSpec]] = None
    homepage: Optional[str] = None

    agents: Optional[List[AgentDefinitionSchema]] = None

    quick_use: Optional[List[Dict[str, Any]]] = None


# ---------------------------------------------------------------------------
# Wave 1 API request schemas（：Skill HTTP 只认 organization_id + agent_id）
# ---------------------------------------------------------------------------


class SkillCreateRequest(Schema):
    """创建新 user 来源 Skill（默认停用）。

    ：``space_id`` 已移除。Skill 归属身份是 (owner_user, organization?, agent)；
    ``organization_id`` 用于成员鉴权与团队共享目录；``agent_id`` 用于在创建时把
    Skill 挂到当前 Agent 携带集。
    """

    organization_id: str
    agent_id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    slug: Optional[str] = None
    # 默认延续旧客户端的自动后缀行为；静态共享快照用 reject 保证重复共享显式失败。
    slug_conflict_policy: Literal["suffix", "reject"] = "suffix"
    emoji: Optional[str] = ""
    category: Optional[str] = None
    # 创建同请求内启用到这些 Agent（原 enable_space_ids 已废弃：Skill 归属 Agent）。
    enable_agent_ids: Optional[List[str]] = None


class SkillActivateVersionRequest(Schema):
    """切换当前 Agent 在用的 Skill 版本（不创建新版本）。"""

    organization_id: str
    agent_id: str
    version_seq: int


class SkillEnableRequest(Schema):
    """启用 skill（D3）。"""

    organization_id: str
    agent_id: Optional[str] = None


class SkillDisableRequest(Schema):
    """禁用 skill（D3）。"""

    organization_id: str
    agent_id: Optional[str] = None


class SkillVisibilityRequest(Schema):
    """切换 visibility（D5）。"""

    visibility: SkillVisibility
    organization_id: Optional[str] = None


class SkillCategoryUpdateRequest(Schema):
    """修改 Skill 分类（仅 owner）。"""

    organization_id: str
    agent_id: Optional[str] = None
    category: Optional[str] = None


class SkillQuickUseUpdateRequest(Schema):
    """更新「快速使用」preset 列表草稿（仅 owner，写 Skill.quick_use_json）。

    省略 / 传 null / 空列表 = 清空草稿。
    """

    organization_id: str
    quick_use: Optional[List[SkillQuickUsePreset]] = None


class SkillPublishRequest(Schema):
    """发布新版本（PRD §6.3）。

    ``files`` 每项 ``{path, content, encoding?}``：
    - ``encoding`` 省略 / ``"text"`` → ``content`` 是 UTF-8 文本；
    - ``encoding == "base64"`` → ``content`` 是二进制资源（图片/字体/图标）的 base64，
      后端解码后原样落盘，保证图片/字体等资源原样带出。
    """

    organization_id: str
    agent_id: Optional[str] = None
    version_label: str
    visibility: Optional[SkillVisibility] = None
    change_note: Optional[str] = ""
    files: Optional[List[Dict[str, Any]]] = None
    # 「快速使用」preset 列表：发布时写入 Skill.quick_use_json 并快照进本版本。
    # 省略（None）= 沿用 skill 上已有草稿；显式传入则覆盖整列。
    quick_use: Optional[List[SkillQuickUsePreset]] = None


class SkillConfigUpdateRequest(Schema):
    """更新 AgentSkillLink.config_json（Skill 归属 Agent）。

    ：``space_id`` 已移除；调用方必须显式传 ``agent_id``。
    """

    organization_id: str
    agent_id: str
    skill_canonical_key: Optional[str] = None
    enabled: Optional[bool] = None
    credential_id: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    config: Optional[Dict[str, Any]] = None


class SkillUpgradeRequest(Schema):
    """升级 Skill（PRD §6.6 / §6.7 三选一）。"""

    organization_id: str
    agent_id: str
    resolution: Optional[Literal["keep_local", "accept_new", "fork_as_copy"]] = None


class SkillImportItem(Schema):
    """批量导入中的单项（三选一来源 + 可选启用 Agent）。"""

    source_skill_id: Optional[str] = None
    name: Optional[str] = None
    url: Optional[str] = None
    files: Optional[List[Dict[str, Any]]] = None
    enable_agent_ids: Optional[List[str]] = None


class SkillImportRequest(Schema):
    """导入 Skill（批量 items[]；旧扁平字段短期兼容归一成单元素 items）。

    - ``items``: 优先；每项 ``files`` | ``url`` | ``source_skill_id`` 三选一
    - 旧字段 ``files`` / ``url`` / ``source_skill_id``：无 items 时归一为单元素
    """

    organization_id: str
    agent_id: Optional[str] = None
    items: Optional[List[SkillImportItem]] = None
    # 旧扁平字段（兼容单元素）
    source_skill_id: Optional[str] = None
    name: Optional[str] = None
    url: Optional[str] = None
    files: Optional[List[Dict[str, Any]]] = None
    enable_agent_ids: Optional[List[str]] = None

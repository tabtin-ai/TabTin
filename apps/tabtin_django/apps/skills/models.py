"""Skills 数据模型 — Wave 1（PRD V3.3）。

云端权威：用户写的 skill 上云；platform / app / device 三档不进表（W0 决策补丁 2）。

五张表：
    Skill                 — 身份与所有权（user 来源）
    SkillEnablement       — Device 安装事实（device_id, skill_id, version/hash）
    AgentSkillLink        — Agent 携带 / 子开关 / 私有配置 SSoT
    UserSkillPreference   — 用户级技能库总闸
    SkillPublishedVersion — 已发布快照（PR 包指针 + 审核）

跨库归属（PRD §11.1）：全部 PostgreSQL；通过 ``apps/skills/db_router.py`` 路由，
跟 Package / AgentAppSettings 同库便于 join。

无兼容负担（元原则 1）：旧云端表完全下线，不留 alias / 双写期。
"""

from __future__ import annotations

import uuid
from typing import Optional

from django.db import models
from django.db.models import Q


class Skill(models.Model):
    """云端权威的 user 来源 Skill 记录（PRD §5.1 / §8.1）。

    平台级（platform / app / device）来源的 skill **不进此表**——它们随代码 / 本机
    marketplace App 走，靠 `LocalSkillRegistry` 扫描索引（D19 / W0 决策补丁 2）。

    身份语义：每个 skill 由 UUID 主键 ``skill_id`` 唯一标识；``slug`` 是给人 / LLM 看
    的可读名（W0 决策 3 V2，canonical key = ``user:<slug>``），同 owner 唯一。
    """

    SOURCE_USER = "user"
    SOURCE_CHOICES = [
        (SOURCE_USER, "User"),
    ]

    VISIBILITY_PRIVATE = "private"
    VISIBILITY_ORGANIZATION = "organization"
    VISIBILITY_PUBLIC = "public"
    VISIBILITY_CHOICES = [
        (VISIBILITY_PRIVATE, "Private"),
        (VISIBILITY_ORGANIZATION, "Organization"),
        (VISIBILITY_PUBLIC, "Public"),
    ]

    skill_id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False,
        help_text="全局唯一身份（PRD U1）。UI 上不展示，仅作内部标识。",
    )

    owner_user_id = models.UUIDField(
        db_index=True,
        help_text="owner（不可变）。跨库软引用 users_auth.User。",
    )

    slug = models.CharField(
        max_length=128,
        help_text=(
            "给人 / LLM 看的 kebab-case 可读名（W0 决策 3 V2）。"
            "canonical key = ``user:<slug>``，sandbox 目录命名 = slug。"
            "同 owner 内唯一；冲突时由服务层自动加 -2 / -3 后缀。"
        ),
    )
    name = models.CharField(
        max_length=128,
        help_text="UI 展示名（用户随时可改）。",
    )
    description = models.TextField(blank=True, default="")
    emoji = models.CharField(max_length=8, blank=True, default="")
    category = models.CharField(
        max_length=32, blank=True, default="",
        help_text="Marketplace 分类（productivity / ai_media / developer / lifestyle）。",
    )

    source = models.CharField(
        max_length=16, choices=SOURCE_CHOICES, default=SOURCE_USER,
        help_text=(
            "Skill 表只存 user 来源（D19）；platform / app / device 三档由 "
            "LocalSkillRegistry 扫描索引，不进此表。"
        ),
    )

    visibility = models.CharField(
        max_length=16, choices=VISIBILITY_CHOICES, default=VISIBILITY_PRIVATE,
        help_text="Skill 级可见范围（D5）。仅控制谁能新启用，不影响已启用者。",
    )

    organization_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="visibility=organization 时归属 organization（跨库软引用）。",
    )

    copied_from_skill = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="acquired_copies",
        help_text=(
            "个人接入副本的组织精选来源。仅用于来源追踪和幂等；"
            "来源下架删除后置空，不影响个人副本。"
        ),
    )

    latest_version_seq = models.PositiveIntegerField(
        null=True, blank=True,
        help_text="指向 SkillPublishedVersion.version_seq；尚未绑定已发布版本时为 NULL。",
    )

    package_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="关联 Package Registry 的 Package（跨库软引用）。",
    )

    agents_json = models.JSONField(
        default=list, blank=True,
        help_text=(
            "Skill 包含的 sub-agent 角色定义（agents/*.md frontmatter）。"
            "AgentSyncService 据此同步到 SubAgentTemplate（W0 决策补丁 1）。"
        ),
    )

    quick_use_json = models.JSONField(
        default=list, blank=True,
        help_text=(
            "「快速使用」preset 列表的草稿工作副本（元数据驱动，不落 skill 目录文件）。"
            "形态 [{id?, label, promptTemplate, variables[], canSubmitKeys?}, ...]——"
            "一个 skill 可有多个预填示例，详情页列出供用户直观感知能力。"
            "发布时快照进 SkillPublishedVersion.quick_use_json，随版本不可变。"
        ),
    )

    install_content_hash = models.CharField(
        max_length=64, blank=True, default="",
        help_text=(
            "服务端记录的最新发布版本内容 hash（D11，与 PR bundle_sha256 对齐）。"
            "客户端启用时拷贝到 SkillEnablement.install_content_hash。"
        ),
    )

    import_source_url = models.CharField(
        max_length=2048, blank=True, default="",
        help_text=(
            "从 URL 导入时的规范化来源地址（空 = 非 URL 导入）。"
            "同 owner 的个人原件中非空值唯一，用于重复导入幂等复用；"
            "组织共享快照不参与个人导入去重。"
        ),
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "skills"
        db_table = "skills_skill"
        verbose_name = "Skill"
        verbose_name_plural = "Skills"
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner_user_id", "slug"],
                name="uq_skill_owner_slug",
            ),
            models.UniqueConstraint(
                fields=["owner_user_id", "import_source_url"],
                condition=(
                    Q(import_source_url__gt="")
                    & ~Q(visibility="organization")
                ),
                name="uq_skill_owner_import_source_url",
            ),
            models.UniqueConstraint(
                fields=["owner_user_id", "copied_from_skill"],
                condition=Q(copied_from_skill__isnull=False),
                name="uq_skill_owner_copied_from",
            ),
        ]
        indexes = [
            models.Index(fields=["owner_user_id"]),
            models.Index(fields=["organization_id", "visibility"]),
            models.Index(fields=["visibility"]),
            models.Index(fields=["package_id"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.slug} ({self.skill_id})"

    @property
    def canonical_key(self) -> str:
        """LLM / 客户端用来定位 skill 的字符串（W0 决策 3 V2 = `user:<slug>`）。"""
        return f"user:{self.slug}"

    def to_index_entry(self, *, active_version_seq: Optional[int] = None) -> dict:
        """渲染为 LocalSkillRegistry 兼容的 entry dict（API 层使用）。

        ``active_version_seq``：解析「快速使用」preset 列表时优先采用的版本（如某 Space
        实际安装的 ``installed_version_seq``）；缺省回退 ``latest_version_seq``，
        都没有已发布版本时回退草稿 ``quick_use_json``。空列表视为无快速使用。
        """
        latest_version_label = None
        latest_quick_use = None
        if self.latest_version_seq is not None:
            latest = self.published_versions.filter(
                version_seq=self.latest_version_seq,
            ).only("version_label", "quick_use_json").first()
            if latest:
                if latest.version_label:
                    latest_version_label = latest.version_label
                latest_quick_use = latest.quick_use_json or None
        # 快速使用 preset 列表：优先 Space 实际安装版本，其次最新发布版本，最后草稿工作副本。
        active_quick_use = latest_quick_use
        if active_version_seq is not None and active_version_seq != self.latest_version_seq:
            pinned = self.published_versions.filter(
                version_seq=active_version_seq,
            ).only("quick_use_json").first()
            if pinned:
                active_quick_use = pinned.quick_use_json or None
        quick_use = active_quick_use or (self.quick_use_json or None) or None
        category = (self.category or "").strip() or None
        return {
            "skill_id": str(self.skill_id),
            "slug": self.slug,
            "name": self.name,
            # user 来源：DB ``name`` 即用户维护的展示名（slug 才是机器 id）。
            "display_name": self.name,
            "description": self.description or None,
            # 版本号只来自 published version 的 SemVer label；version_seq 是内部序号，
            # 不能当版本号（否则 seq=2 会被显示成 v2.0.0，与真实 label 矛盾）。
            "version": latest_version_label,
            "latest_version_label": latest_version_label,
            "source": self.source,
            "visibility": self.visibility,
            "owner_user_id": str(self.owner_user_id),
            "organization_id": str(self.organization_id) if self.organization_id else None,
            "copied_from_skill_id": (
                str(self.copied_from_skill_id) if self.copied_from_skill_id else None
            ),
            "skill_key": self.canonical_key,
            "package_id": str(self.package_id) if self.package_id else None,
            "emoji": self.emoji or "",
            "category": category,
            "tags": [category] if category else [],
            "agents": list(self.agents_json or []),
            "quick_use": quick_use,
            "has_published": self.latest_version_seq is not None,
            "latest_version_seq": self.latest_version_seq,
            "import_source_url": self.import_source_url or "",
        }


class SkillEnablement(models.Model):
    """设备安装登记表（ M4.5/C4 换锚终态——物料就位账本；#7118 移除 legacy 列）。

    语义：**一行 = 某台设备的本地 sandbox 实际装有某 skill 的某个版本**。
    这是纯「物料」账本：记录设备 × skill × 版本 × 内容指纹，由客户端安装 /
    升级 / 本地编辑后**上报**维护（服务端不再代记）。

    与 ``AgentSkillLink`` 的分层（audit §12.2 终态）：
    - ``AgentSkillLink`` 管 **关联（意图）**——引用 / 启用 / 私有配置的唯一
      SSoT，跟 agent 走；
    - 本表管 **安装副本（物料）**——哪台设备装了什么版本、内容指纹是什么，
      供升级冲突判定（登记 hash ≠ 目标 hash = 本地有改动）与物料对账。

    ：换锚回滚快照列（user_id / space_id / enabled / config_json）已通过
    migration 0018 移除；本表模型只保留 device × skill × 版本 × 内容指纹四轴。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    device = models.ForeignKey(
        "tabtinspace.Device",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="skill_installations",
        help_text="安装所在设备。",
    )

    skill_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text="user 来源时指向 Skill 表行；platform/app/device 来源为 NULL。",
    )
    skill_canonical_key = models.CharField(
        max_length=160, db_index=True,
        help_text=(
            "Canonical key（用于 LocalSkillRegistry 检索）。"
            "格式：user:<slug> / platform:<id> / app:<app_id>/<id> / device:<id>。"
        ),
    )
    source = models.CharField(
        max_length=16,
        help_text="冗余 source 标记，便于按来源过滤（platform/app/device/user）。",
    )

    installed_version_seq = models.PositiveIntegerField(
        null=True, blank=True,
        help_text=(
            "设备本地装的版本；NULL 表示本地可编辑 Skill 尚未绑定已发布版本。"
            "platform / app / device 来源 = NULL（跟代码走，无云端版本）。"
        ),
    )
    install_content_hash = models.CharField(
        max_length=64, blank=True, default="",
        help_text=(
            "设备安装时记录的内容 hash（D11 算法）。本地当前 hash 与此值"
            "不一致 = 本地已修改。只由客户端上报更新——服务端发布新版**不**"
            "刷此值（ has_local_changes 恒真 bug 的根因修复）。"
        ),
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "skills"
        db_table = "skills_enablement"
        verbose_name = "Device Skill Install"
        verbose_name_plural = "Device Skill Installs"
        constraints = [
            models.UniqueConstraint(
                fields=["device", "skill_canonical_key"],
                name="uq_enablement_device_skill",
            ),
        ]
        indexes = [
            models.Index(fields=["skill_id"]),
            models.Index(fields=["skill_canonical_key"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"device:{self.device_id} → {self.skill_canonical_key}"


class AgentSkillLink(models.Model):
    """Agent 携带集（ B1.2，audit 底稿 §12.2「关联与安装分两层」）。

    这是 **Agent 携带 skill 的云端引用 SSoT**：一行 = 该 Agent 携带一个 skill
    引用（跟 agent 走，同一 agent 换设备携带集不变；精品 agent 模板实例化时
    按 manifest ``skills`` 清单复制此表）。

    与 ``SkillEnablement`` 的分层（audit §12.2， M4.5/C4 终态已落）：
    - 本表管 **关联（意图）**——agent 携带哪些 skill、是否启用、私有配置，
      是引用清单的唯一 SSoT；
    - ``SkillEnablement`` 管 **安装副本（物料）**——设备 × skill × 版本 ×
      内容指纹的登记账本（device 锚，由客户端上报维护）。

    Skill 身份字段约定：
    - user 来源：``skill_id`` 指向 Skill 表行，``skill_canonical_key`` = ``user:<slug>``
    - platform / app / device 来源：``skill_id`` 为 NULL，key 指向本地源注册表
    - ``config_json`` 保存 Agent 私有的 credential_id / env / config
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    agent = models.ForeignKey(
        "agent.Agent",
        on_delete=models.CASCADE,
        db_column="agent_id",
        related_name="skill_links",
        help_text="携带该 skill 的 Agent（携带集跟 agent 走）。",
    )

    skill_canonical_key = models.CharField(
        max_length=160,
        db_index=True,
        help_text=(
            "Canonical key（用于 LocalSkillRegistry 检索）。"
            "格式：user:<slug> / platform:<id> / app:<app_id>/<id> / "
            "device:<id> / workspace:<rel-path>。"
        ),
    )
    source = models.CharField(
        max_length=16,
        help_text=(
            "冗余 source 标记（platform/app/device/user/workspace），"
            "语义同 SkillEnablement.source。"
        ),
    )
    skill_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        help_text=(
            "user 来源时指向 Skill 表行；platform/app/device/workspace 来源为 NULL"
            "（同 SkillEnablement 约定）。"
        ),
    )

    enabled = models.BooleanField(
        default=True,
        help_text="是否注入（行存在=已携带）。停用置 False 保留行；摘除才删行。",
    )
    config_json = models.JSONField(
        default=dict, blank=True,
        help_text="Agent 对该 Skill 的私有配置，语义同 SkillEnablement.config_json。",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "skills"
        db_table = "skills_agent_link"
        verbose_name = "Agent Skill Link"
        verbose_name_plural = "Agent Skill Links"
        constraints = [
            models.UniqueConstraint(
                fields=["agent", "skill_canonical_key"],
                name="uq_agent_skill_link",
            ),
        ]
        indexes = [
            models.Index(fields=["agent", "enabled"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"agent:{self.agent_id} → {self.skill_canonical_key}"


class UserSkillPreference(models.Model):
    """用户级技能库总闸。

    语义：一行 = 某用户对某 skill 的全局开/关。与 ``AgentSkillLink.enabled`` 分层：
    - 本表 = 技能库总闸（跟用户走，不跟 Workspace / Agent）
    - ``AgentSkillLink.enabled`` = 该 Agent 子开关
    - 最终注入 = 总闸开 AND 携带行存在且 ``enabled``

    总闸关闭时保留 AgentSkillLink 行；runtime 不注入。
    无行 = 总闸开（opt-out）；技能库页不再暴露总闸开关。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.UUIDField(
        db_index=True,
        help_text="用户 ID（跨库软引用 User）。",
    )
    skill_canonical_key = models.CharField(
        max_length=160,
        db_index=True,
        help_text="Canonical key，格式同 AgentSkillLink.skill_canonical_key。",
    )
    enabled = models.BooleanField(
        default=True,
        help_text="用户级总闸（opt-out）：True=打开；False=关闭。无行亦视为开。",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "skills"
        db_table = "skills_user_preference"
        verbose_name = "User Skill Preference"
        verbose_name_plural = "User Skill Preferences"
        constraints = [
            models.UniqueConstraint(
                fields=["user_id", "skill_canonical_key"],
                name="uq_user_skill_preference",
            ),
        ]
        indexes = [
            models.Index(fields=["user_id", "enabled"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"user:{self.user_id} → {self.skill_canonical_key}={self.enabled}"


class SkillPublishedVersion(models.Model):
    """已发布版本快照（PRD §5.2 / §8.1）。

    复用 PR ``PackageVersion`` 作为 bundle 存储；本表存 Skill 维度元数据 + 审核状态。
    每次发布动作创建一行；不可变（除审核状态外）。
    """

    REVIEW_NOT_REQUIRED = "not_required"
    REVIEW_PENDING = "pending_review"
    REVIEW_APPROVED = "approved"
    REVIEW_REJECTED = "rejected"
    REVIEW_STATUS_CHOICES = [
        (REVIEW_NOT_REQUIRED, "Not Required"),
        (REVIEW_PENDING, "Pending Review"),
        (REVIEW_APPROVED, "Approved"),
        (REVIEW_REJECTED, "Rejected"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    skill = models.ForeignKey(
        Skill, on_delete=models.CASCADE, related_name="published_versions",
        db_constraint=True,  # 同库 PG，可以加 FK 约束
    )

    version_seq = models.PositiveIntegerField(
        help_text="单调递增（与 PR.PackageVersion.version_seq 对齐）。",
    )
    version_label = models.CharField(
        max_length=64, blank=True, default="",
        help_text="语义版本号 v1.2.3（用户可见）。",
    )

    bundle_oss_key = models.CharField(
        max_length=512, blank=True, default="",
        help_text="OSS 引用（冗余冷数据，主真相在 PR.PackageFile）。",
    )
    bundle_sha256 = models.CharField(
        max_length=64, blank=True, default="",
        help_text=(
            "完整性校验（与 PR.PackageVersion.bundle_sha256 对齐）。"
            "也是 D11 install_content_hash 的服务端值。"
        ),
    )
    local_content_hash = models.CharField(
        max_length=64, blank=True, default="",
        help_text="Owner 本地 skill-root 内容 hash，用于 Mine dirty/去重判断。",
    )

    quick_use_json = models.JSONField(
        default=list, blank=True,
        help_text=(
            "「快速使用」preset 列表的发布快照（随版本不可变）。"
            "形态与 Skill.quick_use_json 一致：[{id?, label, promptTemplate, variables[], canSubmitKeys?}, ...]。"
        ),
    )

    change_note = models.TextField(blank=True, default="")
    published_by = models.UUIDField(help_text="发布者 user_id（跨库软引用 User）。")
    published_at = models.DateTimeField(auto_now_add=True)

    review_status = models.CharField(
        max_length=16, choices=REVIEW_STATUS_CHOICES,
        default=REVIEW_NOT_REQUIRED, db_index=True,
        help_text="审核状态（D13）。private / organization = not_required；public 必审。",
    )
    reviewed_by = models.UUIDField(null=True, blank=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_note = models.TextField(
        blank=True, default="",
        help_text="审核备注（仅 admindash 内部可见，不暴露给 owner）。",
    )

    class Meta:
        app_label = "skills"
        db_table = "skills_published_version"
        verbose_name = "Skill Published Version"
        verbose_name_plural = "Skill Published Versions"
        ordering = ["-version_seq"]
        constraints = [
            models.UniqueConstraint(
                fields=["skill", "version_seq"],
                name="uq_published_skill_version",
            ),
        ]
        indexes = [
            models.Index(fields=["skill", "review_status"]),
        ]

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.skill.slug} v{self.version_seq}"


__all__ = ["Skill", "SkillEnablement", "AgentSkillLink", "SkillPublishedVersion"]

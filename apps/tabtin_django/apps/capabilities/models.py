"""
Capabilities 数据模型

三个核心模型：
1. RegisteredTool  — 统一工具注册表（工具中心）
2. ToolEmbedding   — 工具向量索引（语义检索）
3. ToolSkillLink   — 工具 ↔ Skill 多对多关联
"""

import uuid
import hashlib

from django.db import models
from django.utils import timezone
from pgvector.django import VectorField


# ─── 常量 ──────────────────────────────────────────────────

class ToolCategory:
    APP = "app"
    RUNTIME = "runtime"
    SERVICE = "service"
    EXTENSION = "extension"
    PLATFORM = "platform"
    CUSTOM = "custom"

    CHOICES = [
        (APP, "App 业务工具"),
        (RUNTIME, "运行时工具"),
        (SERVICE, "服务工具"),
        (EXTENSION, "Extension 工具"),
        (PLATFORM, "平台工具"),
        (CUSTOM, "自定义工具"),
    ]

    VALUES = {APP, RUNTIME, SERVICE, EXTENSION, PLATFORM, CUSTOM}


class InterfaceType:
    FUNCTION_CALL = "function_call"
    CLI = "cli"
    API = "api"
    HYBRID = "hybrid"

    CHOICES = [
        (FUNCTION_CALL, "Function Call"),
        (CLI, "CLI Command"),
        (API, "HTTP API"),
        (HYBRID, "Hybrid"),
    ]


class ExecutionTarget:
    FRONTEND = "frontend"
    BACKEND = "backend"
    HYBRID = "hybrid"

    CHOICES = [
        (FRONTEND, "前端执行"),
        (BACKEND, "后端执行"),
        (HYBRID, "混合执行"),
    ]


class RiskLevel:
    SAFE = "safe"
    REVIEW = "review"
    STRICT = "strict"

    CHOICES = [
        (SAFE, "安全"),
        (REVIEW, "需审核"),
        (STRICT, "严格限制"),
    ]


class ToolSource:
    BUILTIN = "builtin"
    MANIFEST = "manifest"
    EXTENSION = "extension"
    CUSTOM = "custom"

    CHOICES = [
        (BUILTIN, "内置（代码定义）"),
        (MANIFEST, "Manifest（action-tools）"),
        (EXTENSION, "Extension 提供"),
        (CUSTOM, "自定义（API 创建）"),
    ]


class ToolStatus:
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    DISABLED = "disabled"

    CHOICES = [
        (ACTIVE, "启用"),
        (DEPRECATED, "已弃用"),
        (DISABLED, "已禁用"),
    ]


class LinkRelation:
    REQUIRED = "required"
    OPTIONAL = "optional"
    ACTIVATES = "activates"
    REFERENCES = "references"

    CHOICES = [
        (REQUIRED, "必需"),
        (OPTIONAL, "可选"),
        (ACTIVATES, "动态激活"),
        (REFERENCES, "引用"),
    ]


# ─── 模型 ──────────────────────────────────────────────────

class RegisteredTool(models.Model):
    """统一工具注册表 — 工具中心的核心模型。

    收录所有形态的工具（function call / CLI / API），
    无论来源是 ToolHub builtin、action-tools manifest、Extension 还是开发者自定义。
    """

    id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False,
    )
    name = models.CharField(
        max_length=128, unique=True, db_index=True,
        verbose_name="工具唯一名",
        help_text="如 sql_query、crawl_clean_html、execute_in_terminal",
    )
    display_name = models.CharField(max_length=128, verbose_name="显示名")
    description = models.TextField(verbose_name="描述", help_text="也用于生成 embedding")

    # ── 分类 ──
    category = models.CharField(
        max_length=64, choices=ToolCategory.CHOICES, db_index=True,
        verbose_name="分类",
    )
    provider_id = models.CharField(
        max_length=64, db_index=True,
        verbose_name="提供者 ID",
        help_text="如 tabdata, terminal, llm 等",
    )
    domain = models.CharField(
        max_length=64, db_index=True,
        verbose_name="ToolHub domain",
    )
    tags = models.JSONField(default=list, blank=True, verbose_name="标签")

    # ── 形态 ──
    interface_type = models.CharField(
        max_length=32, choices=InterfaceType.CHOICES,
        default=InterfaceType.FUNCTION_CALL,
        verbose_name="接口形态",
    )
    execution_target = models.CharField(
        max_length=32, choices=ExecutionTarget.CHOICES,
        default=ExecutionTarget.BACKEND,
        verbose_name="执行位置",
    )

    # ── Schema ──
    parameters_schema = models.JSONField(
        default=dict, blank=True, verbose_name="入参 JSON Schema",
    )
    return_schema = models.JSONField(
        default=dict, blank=True, verbose_name="返回值 Schema",
    )

    # ── 权限与安全 ──
    risk_level = models.CharField(
        max_length=16, choices=RiskLevel.CHOICES,
        default=RiskLevel.SAFE, verbose_name="风险等级",
    )
    permissions = models.JSONField(
        default=list, blank=True, verbose_name="所需权限",
    )
    optional = models.BooleanField(default=False, verbose_name="是否可选工具")

    # ── 来源追踪 ──
    source = models.CharField(
        max_length=32, choices=ToolSource.CHOICES, db_index=True,
        verbose_name="来源",
    )
    source_ref = models.CharField(
        max_length=256, blank=True, default="",
        verbose_name="来源引用",
        help_text="来源路径或 ID，如 orchestration/tools/table",
    )
    version = models.CharField(
        max_length=32, default="0.0.0", verbose_name="版本",
    )

    # ── 文档 ──
    documentation = models.TextField(blank=True, default="", verbose_name="详细文档")
    examples = models.JSONField(default=list, blank=True, verbose_name="调用示例")

    # ── 状态 ──
    status = models.CharField(
        max_length=16, choices=ToolStatus.CHOICES,
        default=ToolStatus.ACTIVE, db_index=True,
        verbose_name="状态",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "capabilities_registered_tool"
        ordering = ["category", "provider_id", "name"]
        verbose_name = "注册工具"
        verbose_name_plural = "注册工具"
        indexes = [
            models.Index(fields=["category", "provider_id"]),
            models.Index(fields=["domain"]),
            models.Index(fields=["source"]),
        ]

    def __str__(self):
        return f"{self.name} ({self.provider_id})"

    @property
    def content_for_embedding(self) -> str:
        from apps.capabilities.services.tool_embedding import build_content_text
        return build_content_text(
            self.name, self.display_name, self.description or "",
            self.tags, self.category, self.provider_id,
            self.documentation or "",
        )

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.content_for_embedding.encode()).hexdigest()[:16]


class ToolEmbedding(models.Model):
    """工具向量索引 — 支持语义检索。"""

    id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False,
    )
    tool_id = models.UUIDField(db_index=True, verbose_name="工具 ID")
    tool_name = models.CharField(
        max_length=128, unique=True, db_index=True, verbose_name="工具名",
    )
    content_hash = models.CharField(
        max_length=64, verbose_name="内容哈希",
        help_text="当工具描述变化时触发重新 embedding",
    )
    embedding = VectorField(dimensions=1024, verbose_name="向量")

    embedding_model_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name="LLMModel ID")
    embedding_model_version = models.CharField(max_length=50, blank=True, default="", verbose_name="模型版本号")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "capabilities_tool_embedding"
        verbose_name = "工具向量"
        verbose_name_plural = "工具向量"

    def __str__(self):
        return f"Embedding({self.tool_name})"


class ToolSkillLink(models.Model):
    """工具 ↔ Skill 多对多关联。

    Wave 1（PRD V3.3 §11.4）：``skill_key`` 关联 PG 的 ``Skill`` 表（跟 capabilities
    在同一个 PG 库），或 bundled / app / device 来源的 canonical key 字符串。
    跨库 ref 已不再需要——Skill 表归 PG，关系直接同库即可。
    """

    id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False,
    )
    tool_name = models.CharField(
        max_length=128, db_index=True, verbose_name="工具名",
    )
    skill_key = models.CharField(
        max_length=128, db_index=True, verbose_name="Skill 标识",
    )
    relation_type = models.CharField(
        max_length=32, choices=LinkRelation.CHOICES,
        default=LinkRelation.REFERENCES, verbose_name="关联类型",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "capabilities_tool_skill_link"
        unique_together = ("tool_name", "skill_key")
        verbose_name = "工具-Skill 关联"
        verbose_name_plural = "工具-Skill 关联"
        indexes = [
            models.Index(fields=["tool_name"]),
            models.Index(fields=["skill_key"]),
        ]

    def __str__(self):
        return f"{self.tool_name} <-> {self.skill_key} ({self.relation_type})"

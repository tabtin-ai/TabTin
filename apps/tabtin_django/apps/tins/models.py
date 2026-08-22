from __future__ import annotations

import uuid

from django.db import models

from apps.tins.constants import (
    TIN_ACTIVATION_MATCH_CHOICES,
    TIN_ACTIVATION_MODE_CHOICES,
    TIN_PANEL_POSITION_CHOICES,
    TIN_RUN_LOG_ACTION_CHOICES,
    TIN_SOURCE_CHOICES,
    TIN_STATUS_CHOICES,
)


class Tin(models.Model):
    """
    Tin 定义：一个可复用的智能微应用包。

    包含 UI 面板、自动化脚本、激活条件和 Agent 指令，
    能在特定上下文中自动激活，增强用户的工作体验。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.UUIDField(db_index=True)
    space_id = models.UUIDField(null=True, blank=True, db_index=True)

    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    icon_url = models.URLField(blank=True, default="")
    version = models.CharField(max_length=50, default="1.0.0")

    status = models.CharField(
        max_length=20,
        choices=TIN_STATUS_CHOICES.as_choices(),
        default="draft",
        db_index=True,
    )
    source = models.CharField(
        max_length=30,
        choices=TIN_SOURCE_CHOICES.as_choices(),
        default="agent_generated",
    )

    # ── manifest 核心字段（冗余存储以便后端查询）──────
    activation_mode = models.CharField(
        max_length=20,
        choices=TIN_ACTIVATION_MODE_CHOICES.as_choices(),
        default="auto",
    )
    activation_rules = models.JSONField(
        default=list,
        help_text="激活规则列表，如 [{type, patterns, ...}]",
    )
    activation_match = models.CharField(
        max_length=10, default="any",
        choices=TIN_ACTIVATION_MATCH_CHOICES.as_choices(),
        help_text="规则匹配逻辑: any / all",
    )
    variables_schema = models.JSONField(
        default=dict,
        help_text="变量 schema，如 {name: {type, label, default, ...}}",
    )
    permissions = models.JSONField(
        default=list,
        help_text="权限声明列表，如 ['page_content', 'table_write']",
    )
    panel_position = models.CharField(
        max_length=20,
        choices=TIN_PANEL_POSITION_CHOICES.as_choices(),
        default="sidebar_right",
    )
    panel_width = models.IntegerField(default=360)

    # ── 文件存储 ──────────────────────────────────
    package_url = models.URLField(
        blank=True, default="",
        help_text="OSS 上的 zip 包地址",
    )
    manifest = models.JSONField(
        default=dict,
        help_text="完整的 manifest.json 内容",
    )
    panel_html = models.TextField(
        blank=True, default="",
        help_text="UI 面板 HTML 源码（用于快速渲染，避免每次下载 zip）",
    )
    content_script = models.TextField(
        blank=True, default="",
        help_text="页面注入脚本源码",
    )
    background_script = models.TextField(
        blank=True, default="",
        help_text="后台脚本源码",
    )
    agent_instructions = models.TextField(
        blank=True, default="",
        help_text="Agent 可读的上下文指令（Markdown）",
    )

    created_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tins_tin"
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["organization_id", "status"]),
        ]

    def __str__(self) -> str:
        return f"Tin({self.name}, {self.status})"


class TinInstance(models.Model):
    """
    用户在某个 Space 中安装/激活的 Tin 实例。

    同一个 Tin 定义可以被安装到多个 Space，每个实例有独立的变量配置。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tin = models.ForeignKey(
        Tin, on_delete=models.CASCADE, related_name="instances",
    )
    organization_id = models.UUIDField(db_index=True)
    space_id = models.UUIDField(db_index=True)

    is_enabled = models.BooleanField(default=True, db_index=True)
    pinned = models.BooleanField(
        default=False,
        help_text="钉选常驻（即使规则不匹配也显示在 Tray 中）",
    )
    user_variables = models.JSONField(
        default=dict,
        help_text="用户自定义变量值，覆盖 Tin 的 variables_schema 默认值",
    )
    last_activated_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tins_instance"
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["tin", "space_id"],
                name="uq_tin_instance_per_space",
            ),
        ]
        indexes = [
            models.Index(fields=["space_id", "is_enabled"]),
        ]

    def __str__(self) -> str:
        return f"TinInstance(tin={self.tin_id}, space={self.space_id})"


class TinRunLog(models.Model):
    """
    Tin 运行日志：记录 Tin 脚本执行、Agent 调用等操作。
    用于调试和审计。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    instance = models.ForeignKey(
        TinInstance, on_delete=models.CASCADE, related_name="run_logs",
    )
    action = models.CharField(
        max_length=50,
        choices=TIN_RUN_LOG_ACTION_CHOICES.as_choices(),
        help_text="操作类型：activate / deactivate / script_run / agent_invoke / goal_trigger",
    )
    input_data = models.JSONField(default=dict)
    output_data = models.JSONField(default=dict)
    error = models.TextField(blank=True, default="")
    duration_ms = models.IntegerField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tins_run_log"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["instance", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"TinRunLog({self.action}, instance={self.instance_id})"

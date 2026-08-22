"""
TabSite 站点云应用数据模型

存储架构:
  - Site 是站点主表，继承 SpaceResourceModel
  - SiteVersion 存版本快照
  - SiteFile 存站点文件（HTML/CSS/JS）
"""

from __future__ import annotations

import re

from django.db import models

from apps.services.common.base_models import (
    SpaceResourceModel,
    TimeStampedModel,
)


class Site(SpaceResourceModel):
    """站点主资源模型"""

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        PUBLISHED = "published", "已发布"
        ARCHIVED = "archived", "已归档"

    class Framework(models.TextChoices):
        VANILLA = "vanilla", "原生 HTML"
        REACT = "react", "React + Vite"

    name = models.CharField(max_length=255, verbose_name="站点名称")
    slug = models.SlugField(
        max_length=100, unique=True, verbose_name="URL 标识",
        help_text="站点访问地址标识，如 site.example.com/s/{slug}",
    )
    description = models.TextField(blank=True, default="", verbose_name="描述")
    icon = models.CharField(max_length=50, blank=True, default="", verbose_name="图标")

    # 关联
    code_project_path = models.CharField(
        max_length=1024, blank=True, default="",
        verbose_name="TabCode 项目路径",
        help_text="关联的本地代码项目路径",
    )
    tabdata_table_ids = models.JSONField(
        default=list, blank=True, verbose_name="绑定的 TabData 表",
        help_text="站点关联的 TabData 表 ID 列表",
    )
    tabdata_token_id = models.CharField(
        max_length=255, blank=True, default="",
        verbose_name="TabData API Token ID",
        help_text="为站点创建的数据访问 Token",
    )

    # 发布信息
    framework = models.CharField(
        max_length=20, choices=Framework.choices, default=Framework.REACT,
        verbose_name="技术栈",
    )
    published_url = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="发布地址",
    )
    current_version = models.PositiveIntegerField(default=0, verbose_name="当前版本号")
    dist_oss_url = models.URLField(
        max_length=2048, blank=True, default="",
        verbose_name="当前版本 OSS 地址",
        help_text="当前激活版本的 dist 产物 OSS 根地址",
    )

    # 访问控制
    is_public = models.BooleanField(default=True, verbose_name="是否公开")
    password = models.CharField(
        max_length=128, blank=True, default="",
        verbose_name="访问密码",
        help_text="非空时需要输入密码才能访问",
    )
    custom_domain = models.CharField(
        max_length=255, blank=True, default="",
        verbose_name="自定义域名",
    )

    # 统计
    total_views = models.PositiveIntegerField(default=0, verbose_name="总访问量")

    # 模板来源
    template = models.CharField(
        max_length=50, blank=True, default="",
        verbose_name="模板标识",
        help_text="创建时使用的模板: blank/dashboard/landing",
    )

    # 状态
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.DRAFT,
        db_index=True, verbose_name="状态",
    )

    # 审计
    created_by = models.ForeignKey(
        "users_auth.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    updated_by = models.ForeignKey(
        "users_auth.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )

    class Meta:
        db_table = "tabsite_site"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["organization_id", "space_id", "status"],
                name="ts_ws_sp_status_idx",
            ),
            models.Index(
                fields=["organization_id", "space_id", "-created_at"],
                name="ts_ws_sp_created_idx",
            ),
        ]

    def __str__(self):
        return f"Site({self.id}, {self.name!r})"

    # ── ContextSyncMixin ──

    def get_context_type(self) -> str:
        return "tabsite"

    def get_context_title(self) -> str:
        return self.name or "未命名站点"

    def get_context_metadata(self) -> dict:
        return {
            "slug": self.slug,
            "framework": self.framework,
            "published_url": self.published_url,
            "is_public": self.is_public,
            "current_version": self.current_version,
            "total_views": self.total_views,
            "template": self.template,
            "status": self.status,
            "dist_oss_url": self.dist_oss_url,
        }

    FRAMEWORK_LABELS = {"react": "React", "vanilla": "HTML/JS"}

    def get_context_preview(self) -> str:
        if self.description:
            return self.description[:200]
        parts = []
        label = self.FRAMEWORK_LABELS.get(self.framework, "")
        if label:
            parts.append(label)
        if self.published_url:
            parts.append(re.sub(r'^https?://', '', self.published_url))
        if self.total_views:
            parts.append(f"{self.total_views} 次访问")
        return " · ".join(parts) if parts else ""

    def get_context_status(self) -> str:
        return self.status or ""

    def is_context_archived(self) -> bool:
        return self.status == self.Status.ARCHIVED


class SiteVersion(TimeStampedModel):
    """站点版本快照"""

    site = models.ForeignKey(
        Site, on_delete=models.CASCADE, related_name="versions",
    )
    version = models.PositiveIntegerField(verbose_name="版本号")
    message = models.CharField(
        max_length=500, blank=True, default="",
        verbose_name="版本说明",
    )
    dist_url = models.URLField(
        max_length=2048, verbose_name="OSS 打包产物地址",
    )
    file_count = models.PositiveIntegerField(default=0, verbose_name="文件数量")
    total_size = models.PositiveIntegerField(default=0, verbose_name="总大小(bytes)")
    is_current = models.BooleanField(default=False, verbose_name="是否当前版本")

    published_by = models.ForeignKey(
        "users_auth.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )

    class Meta:
        db_table = "tabsite_version"
        ordering = ["-version"]
        unique_together = [("site", "version")]
        indexes = [
            models.Index(fields=["site", "-version"], name="ts_ver_site_ver_idx"),
        ]

    def __str__(self):
        return f"SiteVersion(site={self.site_id}, v{self.version})"


class SiteFile(TimeStampedModel):
    """站点文件（用于本地预览和编辑）"""

    site = models.ForeignKey(
        Site, on_delete=models.CASCADE, related_name="files",
    )
    path = models.CharField(
        max_length=500, verbose_name="文件路径",
        help_text="相对路径，如 index.html, styles/main.css",
    )
    content = models.TextField(
        blank=True, default="", verbose_name="文件内容",
    )
    content_type = models.CharField(
        max_length=100, blank=True, default="text/html",
        verbose_name="MIME 类型",
    )
    file_size = models.PositiveIntegerField(default=0, verbose_name="文件大小(bytes)")

    class Meta:
        db_table = "tabsite_file"
        ordering = ["path"]
        unique_together = [("site", "path")]

    def __str__(self):
        return f"SiteFile({self.path}, site={self.site_id})"

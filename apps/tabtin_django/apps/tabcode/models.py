"""
TabCode 数据模型

V1 阶段：TabCode 主要操作本地文件系统和 Git，后端只负责记录用户打开过
哪些代码项目（通过 ContextItem 管理），因此模型极简。

后续可扩展：代码片段收藏、执行历史记录等。
"""

import os

from django.db import models
from apps.services.common.base_models import SpaceResourceModel, TrashableModelMixin


class CodeProject(SpaceResourceModel, TrashableModelMixin):
    """
    代码项目记录

    记录用户在某个 Space 下打开的本地代码仓库/文件夹，
    主要用于 ContextItem 同步和资源列表展示。
    """

    # 项目显示名称（默认取文件夹 basename）
    title = models.CharField(max_length=255, default="")

    # 本地路径（仅客户端使用，后端只做记录）
    local_path = models.TextField(default="", blank=True)

    # Git 远程仓库 URL（可选，用于标识和展示）
    git_remote_url = models.TextField(default="", blank=True)

    # 状态
    status = models.CharField(
        max_length=20,
        choices=[("active", "Active"), ("archived", "Archived"), ("trashed", "Trashed")],
        default="active",
        db_index=True,
    )

    # 创建者
    created_by = models.ForeignKey(
        "users_auth.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tabcode_projects_created",
    )

    class Meta:
        db_table = "tabcode_code_project"
        indexes = [
            models.Index(
                fields=["space_id", "status"],
                name="tc_proj_status_idx",
            ),
        ]

    def __str__(self):
        return self.title or f"CodeProject({self.id})"

    # ── ContextSyncMixin 接口 ────────────────────────────────
    def get_context_type(self) -> str:
        return "tabcode"

    def get_context_title(self) -> str:
        return self.title or "Untitled Project"

    def get_context_metadata(self) -> dict:
        return {
            "localPath": self.local_path,
            "gitRemoteUrl": self.git_remote_url,
        }

    def get_context_preview(self) -> str:
        parts = []
        if self.git_remote_url:
            repo = self.git_remote_url.rstrip("/").rsplit("/", 1)[-1]
            if repo.endswith(".git"):
                repo = repo[:-4]
            parts.append(repo)
        if self.local_path:
            parts.append(os.path.basename(self.local_path.rstrip("/")))
        return " · ".join(dict.fromkeys(parts)) if parts else ""

    def is_context_archived(self) -> bool:
        return self.status == "archived"

"""GitHub Extension

纯 Extension（无独立 UI），提供 Issue/PR 管理和 CI 事件监听。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TYPE_CHECKING

from apps.extensions.base import (
    BaseExtension,
    ConfigField,
    EventDescriptor,
    ExtensionCapabilities,
    PayloadField,
)
from apps.extensions.constants import ExtensionType

if TYPE_CHECKING:
    from apps.extensions.models import ExtensionConnection


class GitHubExtension(BaseExtension):

    @property
    def id(self) -> str:
        return "github"

    @property
    def name(self) -> str:
        return "GitHub"

    @property
    def description(self) -> str:
        return "集成 GitHub 仓库，监听 PR/Issue 事件，Agent 可创建 Issue 和 PR"

    @property
    def icon(self) -> str:
        return "github"

    @property
    def extension_type(self) -> str:
        return ExtensionType.INTEGRATION

    @property
    def capabilities(self) -> ExtensionCapabilities:
        return ExtensionCapabilities(
            has_tools=True,
            has_events=True,
            has_inbound_webhook=True,
            has_ui=False,
            supports_oauth=True,
        )

    def get_config_fields(self) -> List[ConfigField]:
        return [
            ConfigField(key="personal_access_token", label="Personal Access Token",
                        field_type="password", required=True,
                        help_text="GitHub PAT (classic) 或 fine-grained token"),
            ConfigField(key="webhook_secret", label="Webhook Secret", field_type="password",
                        help_text="GitHub Webhook 签名密钥"),
            ConfigField(key="default_repo", label="默认仓库",
                        help_text="格式: owner/repo"),
        ]

    def get_event_types(self) -> List[EventDescriptor]:
        return [
            EventDescriptor(
                event_type="github.push",
                description="代码推送",
                payload_fields=[
                    PayloadField(key="repo", label="仓库", example="owner/repo"),
                    PayloadField(key="branch", label="分支", example="main"),
                    PayloadField(key="pusher", label="推送者", example="octocat"),
                    PayloadField(key="commit_count", label="提交数", type="number", example="3"),
                    PayloadField(key="head_message", label="最新提交信息", example="fix: typo"),
                ],
            ),
            EventDescriptor(
                event_type="github.pull_request",
                description="PR 创建/更新/合并",
                payload_fields=[
                    PayloadField(key="repo", label="仓库", example="owner/repo"),
                    PayloadField(key="action", label="动作", example="opened"),
                    PayloadField(key="number", label="PR 编号", type="number", example="42"),
                    PayloadField(key="title", label="PR 标题", example="Add new feature"),
                    PayloadField(key="author", label="作者", example="octocat"),
                ],
            ),
            EventDescriptor(
                event_type="github.issue",
                description="Issue 创建/更新",
                payload_fields=[
                    PayloadField(key="repo", label="仓库", example="owner/repo"),
                    PayloadField(key="action", label="动作", example="opened"),
                    PayloadField(key="number", label="Issue 编号", type="number", example="99"),
                    PayloadField(key="title", label="Issue 标题", example="Bug: login fails"),
                    PayloadField(key="author", label="作者", example="octocat"),
                ],
            ),
            EventDescriptor(
                event_type="github.review",
                description="PR Review",
                payload_fields=[
                    PayloadField(key="repo", label="仓库", example="owner/repo"),
                    PayloadField(key="pr_number", label="PR 编号", type="number", example="42"),
                    PayloadField(key="reviewer", label="审查者", example="reviewer1"),
                    PayloadField(key="state", label="审查状态", example="approved"),
                ],
            ),
            EventDescriptor(
                event_type="github.ci_status",
                description="CI 状态变更",
                payload_fields=[
                    PayloadField(key="repo", label="仓库", example="owner/repo"),
                    PayloadField(key="branch", label="分支", example="main"),
                    PayloadField(key="status", label="CI 状态", example="success"),
                    PayloadField(key="workflow", label="工作流名称", example="build"),
                ],
            ),
        ]

    def get_tools(self, connection: Optional["ExtensionConnection"] = None) -> list:
        # TODO: Phase 4 实现
        return []

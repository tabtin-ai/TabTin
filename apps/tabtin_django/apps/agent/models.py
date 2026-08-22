"""Agent 领域模型——纯 AI 身份，与 Workspace / Space 解耦。

表名 ``agent_agent``；组织归属仍 FK 到 ``tabtinspace.Organization``。
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class Agent(models.Model):
    """AI 身份 — 描述「谁在参与」。

    只含人格 / 规则 / 配置；设备与工作目录属于 Workspace。
    """

    TYPE_CHOICES = [('bot', 'AI 助手')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        'tabtinspace.Organization',
        on_delete=models.CASCADE,
        related_name='agents',
        verbose_name='所属组织',
    )
    owner_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='owned_agents',
        verbose_name='Agent 归属用户',
        help_text='所有 Agent 都是用户私有资源；bot Agent 用该字段记录创建者/归属用户。',
    )
    name = models.CharField(max_length=255, verbose_name='Agent 名称')
    type = models.CharField(
        max_length=20,
        choices=TYPE_CHOICES,
        default='bot',
        verbose_name='Agent 类型',
    )
    is_active = models.BooleanField(default=True, verbose_name='是否启用')
    is_default = models.BooleanField(
        default=False,
        verbose_name='是否为默认 Agent',
        help_text='每用户在组织内至多一个活跃默认 Agent；默认身份不可删除，缺失时幂等补建。',
    )

    settings = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='Agent 展示配置',
        help_text='模板冻结的欢迎语、图标与默认模式；不承载执行环境配置。',
    )
    custom_rules = models.TextField(
        blank=True,
        default='',
        verbose_name='自定义规则',
    )
    goal = models.TextField(blank=True, default='', verbose_name='Agent 目标')
    agent_config = models.JSONField(default=dict, verbose_name='Agent 安全配置')
    suggested_prompts = models.JSONField(
        default=list,
        blank=True,
        verbose_name='推荐问题',
        help_text='对话空状态展示的推荐问题，用户可覆写',
    )
    preferred_model_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='偏好模型 ID',
        help_text='用户最后一次在对话中选择的模型 ID，新对话时优先使用。',
    )
    template_id = models.CharField(
        max_length=64,
        blank=True,
        default='',
        verbose_name='来源模板 ID',
        help_text='平台 Agent 模板 slug；空字符串表示用户自建 Agent。',
    )
    template_version = models.CharField(
        max_length=32,
        blank=True,
        default='',
        verbose_name='来源模板版本',
        help_text='实例化时冻结的模板版本，仅用于溯源。',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'agent_agent'
        verbose_name = 'Agent'
        verbose_name_plural = 'Agents'
        indexes = [
            models.Index(fields=['organization', 'type'], name='ctx_agent_ws_type_idx'),
            models.Index(fields=['organization', 'owner_user'], name='ctx_agent_ws_owner_idx'),
            models.Index(fields=['organization', 'is_active'], name='ctx_agent_ws_active_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['organization', 'owner_user'],
                condition=models.Q(is_default=True, is_active=True),
                name='agent_one_active_default_per_owner',
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.organization_id})"

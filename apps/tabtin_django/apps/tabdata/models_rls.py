"""
Row Level Security (RLS) — 行级安全策略模型

TabData 应用层 RLS 实现：在查询执行前注入行级过滤条件。
设计参考 Supabase/PostgreSQL RLS，但适配 TabData 动态 schema 架构。

核心概念：
- RowPolicy = 一条命名的规则，绑定到一张表
- 策略类型：PERMISSIVE（OR 合并，默认）/ RESTRICTIVE（AND 合并）
- 操作范围：SELECT / INSERT / UPDATE / DELETE
- 条件表达式：使用 TabData 已有的 filter DSL + 运行时变量（$token.user_id 等）
- 启用/禁用：表级开关（Table.rls_enabled）

变量系统：
- $token.user_id — 当前 API Token 所属用户的 ID
- $token.metadata.xxx — Token 自定义元数据
- $current_user_id — 当前请求用户 ID
"""

import uuid
from django.db import models


class RowPolicy(models.Model):
    """行级安全策略"""

    OPERATION_SELECT = 'SELECT'
    OPERATION_INSERT = 'INSERT'
    OPERATION_UPDATE = 'UPDATE'
    OPERATION_DELETE = 'DELETE'
    OPERATION_ALL = 'ALL'
    OPERATION_CHOICES = [
        (OPERATION_SELECT, 'SELECT'),
        (OPERATION_INSERT, 'INSERT'),
        (OPERATION_UPDATE, 'UPDATE'),
        (OPERATION_DELETE, 'DELETE'),
        (OPERATION_ALL, 'ALL'),
    ]

    POLICY_PERMISSIVE = 'PERMISSIVE'
    POLICY_RESTRICTIVE = 'RESTRICTIVE'
    POLICY_TYPE_CHOICES = [
        (POLICY_PERMISSIVE, 'Permissive (OR)'),
        (POLICY_RESTRICTIVE, 'Restrictive (AND)'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    table = models.ForeignKey(
        'tabdata.Table',
        on_delete=models.CASCADE,
        related_name='row_policies',
        verbose_name='表格',
    )
    name = models.CharField(max_length=100, verbose_name='策略名称')
    operation = models.CharField(
        max_length=10,
        choices=OPERATION_CHOICES,
        default=OPERATION_ALL,
        verbose_name='操作类型',
    )
    policy_type = models.CharField(
        max_length=12,
        choices=POLICY_TYPE_CHOICES,
        default=POLICY_PERMISSIVE,
        verbose_name='策略类型',
        help_text='PERMISSIVE 策略之间 OR 合并，RESTRICTIVE 策略之间 AND 合并',
    )

    # 策略条件 — 使用 TabData filter DSL + 运行时变量
    # 格式：与 NativeQueryBuilder 的 FilterSet 兼容
    # 示例：
    # {
    #   "conjunction": "and",
    #   "filterSet": [
    #     {"field_id": "租户ID", "operator": "equals", "value": "$token.user_id"}
    #   ]
    # }
    # 简写（单条件）：
    # {"field_id": "owner", "operator": "equals", "value": "$current_user_id"}
    condition = models.JSONField(
        verbose_name='策略条件',
        help_text='Filter DSL 条件，支持 $token.user_id / $current_user_id 等运行时变量',
    )

    # 作用范围
    apply_to_tokens = models.BooleanField(
        default=True,
        verbose_name='API Token 访问时生效',
    )
    apply_to_jwt = models.BooleanField(
        default=False,
        verbose_name='JWT 用户访问时是否也生效',
    )

    is_active = models.BooleanField(default=True, verbose_name='是否启用')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_row_policy'
        verbose_name = '行级安全策略'
        verbose_name_plural = '行级安全策略'
        ordering = ['created_at']
        unique_together = [('table', 'name')]
        indexes = [
            models.Index(fields=['table', 'is_active']),
            models.Index(fields=['table', 'operation']),
        ]

    def __str__(self):
        return f'{self.name} ({self.operation}, {self.policy_type})'

    def matches_operation(self, op: str) -> bool:
        """检查此策略是否适用于指定操作"""
        if self.operation == self.OPERATION_ALL:
            return True
        return self.operation == op

"""
会员系统后台管理
"""

import logging

from django.contrib import admin
from .models import (
    MembershipTier,
    OrganizationMembership,
    OrganizationMembershipChangeLog,
)

logger = logging.getLogger(__name__)


@admin.register(MembershipTier)
class MembershipTierAdmin(admin.ModelAdmin):
    """会员等级管理"""

    list_display = [
        'name', 'tier_type', 'price', 'duration_months',
        'max_tables', 'max_members', 'sort_order', 'is_active',
    ]
    list_filter = ['is_active', 'tier_type']
    search_fields = ['name', 'tier_type', 'description']
    ordering = ['sort_order', 'price']

    fieldsets = (
        ('基本信息', {
            'fields': ('tier_type', 'name', 'description', 'is_active', 'sort_order')
        }),
        ('定价设置', {
            'fields': ('price', 'duration_months')
        }),
        ('资源配额', {
            'fields': (
                'max_tables',
                'max_records_per_table',
            )
        }),
        ('Legacy 配额（不再执行，仅兼容）', {
            'fields': (
                'max_api_calls_per_day',
                'max_crawl_tasks_per_day',
            ),
            'classes': ('collapse',),
            'description': 'Legacy, not enforced (D5) — 这些字段无执行力，实际限流由 ApiToken.rate_limit 控制。',
        }),
        ('存储与额度', {
            'fields': (
                'included_storage_bytes',
                'included_llm_credits_monthly',
                'trash_retention_days',
            )
        }),
        ('席位管理', {
            'fields': (
                'max_members',
                'base_seats',
                'extra_seat_price',
            )
        }),
        ('功能权限', {
            'fields': ('features',),
            'classes': ('collapse',)
        }),
    )


@admin.register(OrganizationMembership)
class OrganizationMembershipAdmin(admin.ModelAdmin):
    """组织会员管理"""

    list_display = [
        'organization_id', 'tier', 'status', 'start_date', 'end_date',
        'auto_renew', 'purchased_by', 'created_at',
    ]
    list_filter = ['status', 'tier', 'auto_renew', 'created_at']
    search_fields = ['organization_id', 'purchased_by', 'related_order_id']
    readonly_fields = [
        'id',
        'organization_id',
        'tier',
        'status',
        'start_date',
        'end_date',
        'billing_cycle',
        'current_actual_paid_period_price',
        'grace_period_end',
        'lifecycle_version',
        'purchased_by',
        'related_order_id',
        'created_at',
        'updated_at',
    ]
    ordering = ['-created_at']

    fieldsets = (
        ('组织信息', {
            'fields': ('organization_id', 'tier', 'status'),
            'description': '套餐、状态、周期和价格快照必须通过受控生命周期服务调整。',
        }),
        ('时间信息', {
            'fields': (
                'start_date',
                'end_date',
                'billing_cycle',
                'grace_period_end',
                'created_at',
                'updated_at',
            )
        }),
        ('续费与审计', {
            'fields': (
                'auto_renew',
                'current_actual_paid_period_price',
                'lifecycle_version',
                'purchased_by',
                'related_order_id',
            )
        }),
    )

    def has_add_permission(self, request):
        """禁止从 Django Admin 绕过生命周期服务创建会员。"""
        return False

    def has_delete_permission(self, request, obj=None):
        """禁止删除组织会员记录"""
        return False


@admin.register(OrganizationMembershipChangeLog)
class OrganizationMembershipChangeLogAdmin(admin.ModelAdmin):
    """生命周期事实只读展示，不在 Admin 内提供业务动作。"""

    list_display = [
        'id',
        'organization',
        'change_type',
        'status',
        'from_tier',
        'to_tier',
        'effective_at',
        'requested_at',
    ]
    list_filter = ['change_type', 'status', 'from_billing_cycle', 'to_billing_cycle']
    search_fields = ['organization__name', 'payment_order_id', 'reason']
    ordering = ['-created_at']

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

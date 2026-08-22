"""
TabData Django Admin 配置

提供完整的后台管理界面
"""

from django.contrib import admin
from django.utils.html import format_html
from django.urls import reverse, path
from django.utils.safestring import mark_safe
from django.shortcuts import render
from django.http import HttpResponseRedirect
import json

from .models import (
    Table, TableField,
    TableRecord, TableView, TableShare, RecordComment, RecordHistory,
    TableAdminActionLog
)
from .admin_actions import (
    check_organization_consistency,
    check_table_consistency,
    check_record_consistency,
    check_all_consistency,
    clean_orphan_organizations,
    export_consistency_report,
)


@admin.register(Table)
class TableAdmin(admin.ModelAdmin):
    """表格管理"""

    list_display = ['name', 'space_link', 'organization_link', 'owner_link', 'owner_valid', 'row_count', 'field_count', 'is_archived', 'created_at']
    list_filter = ['is_archived', 'is_public', 'is_template', 'created_at']
    search_fields = ['name', 'description', 'owner__email']
    readonly_fields = ['id', 'row_count', 'field_count', 'created_at', 'updated_at']
    actions = [
        check_table_consistency,
        export_consistency_report,
    ]

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'name', 'description', 'icon', 'owner', 'space_id', 'organization_id')
        }),
        ('来源信息', {
            'fields': ('default_source_url', 'schema_history_id'),
            'classes': ('collapse',)
        }),
        ('配置', {
            'fields': ('default_view', 'row_count', 'field_count')
        }),
        ('状态', {
            'fields': ('is_public', 'is_template', 'is_archived')
        }),
        ('时间信息', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def space_link(self, obj):
        """Space 链接"""
        if obj.space_id:
            return format_html('<span>{}</span>', obj.space_id)
        return '-'
    space_link.short_description = '所属 Space'

    def organization_link(self, obj):
        """组织链接（organization_id 不再是 FK，直接显示 ID）"""
        if obj.organization_id:
            return format_html('<span>{}</span>', obj.organization_id)
        return '-'
    organization_link.short_description = '组织'

    def owner_link(self, obj):
        """所有者链接"""
        try:
            return format_html(
                '<a href="{}">{}</a>',
                reverse('admin:users_auth_user_change', args=[obj.owner.id]),
                obj.owner.get_display_name()
            )
        except Exception:
            return format_html('<span style="color: red;">❌ User不存在</span>')
    owner_link.short_description = '所有者'

    def owner_valid(self, obj):
        """检查owner是否有效"""
        try:
            from django.contrib.auth import get_user_model
            User = get_user_model()
            User.objects.get(id=obj.owner_id)
            return format_html('<span style="color: green;">✓</span>')
        except Exception:
            return format_html('<span style="color: red; font-weight: bold;">✗</span>')
    owner_valid.short_description = '有效'


@admin.register(TableField)
class TableFieldAdmin(admin.ModelAdmin):
    """字段管理"""

    list_display = ['name', 'table_link', 'field_type', 'is_primary', 'order', 'created_at']
    list_filter = ['field_type', 'is_primary', 'is_hidden', 'created_at']
    search_fields = ['name', 'description', 'table__name']
    readonly_fields = ['id', 'created_at', 'updated_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'table', 'name', 'field_type', 'description')
        }),
        ('配置', {
            'fields': ('config', 'validation_rules')
        }),
        ('显示设置', {
            'fields': ('order', 'width', 'is_primary', 'is_hidden')
        }),
        ('默认值', {
            'fields': ('default_value',)
        }),
        ('时间信息', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def table_link(self, obj):
        """表格链接"""
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:tabdata_table_change', args=[obj.table.id]),
            obj.table.name
        )
    table_link.short_description = '所属表格'


@admin.register(TableRecord)
class TableRecordAdmin(admin.ModelAdmin):
    """记录管理"""

    list_display = ['record_preview', 'table_link', 'status', 'is_deleted', 'created_by_link', 'created_at']
    list_filter = ['status', 'is_deleted', 'created_at']
    search_fields = ['table__name']
    readonly_fields = ['id', 'data_pretty', 'refresh_metadata_pretty', 'created_at', 'updated_at']
    actions = [
        check_record_consistency,
        export_consistency_report,
    ]

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'table', 'order')
        }),
        ('数据', {
            'fields': ('data_pretty', 'refresh_metadata_pretty')
        }),
        ('状态', {
            'fields': ('status', 'is_deleted', 'tags')
        }),
        ('来源信息', {
            'fields': ('source_url',),
            'classes': ('collapse',)
        }),
        ('操作信息', {
            'fields': ('created_by', 'updated_by', 'created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def record_preview(self, obj):
        """记录预览"""
        return str(obj)[:50]
    record_preview.short_description = '记录'

    def table_link(self, obj):
        """表格链接"""
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:tabdata_table_change', args=[obj.table.id]),
            obj.table.name
        )
    table_link.short_description = '所属表格'

    def created_by_link(self, obj):
        """创建者链接"""
        if obj.created_by:
            return format_html(
                '<a href="{}">{}</a>',
                reverse('admin:users_auth_user_change', args=[obj.created_by.id]),
                obj.created_by.get_display_name()
            )
        return '-'
    created_by_link.short_description = '创建者'

    def data_pretty(self, obj):
        """格式化显示数据"""
        return mark_safe(f'<pre>{json.dumps(obj.data, ensure_ascii=False, indent=2)}</pre>')
    data_pretty.short_description = '记录数据'

    def refresh_metadata_pretty(self, obj):
        """格式化显示刷新元数据"""
        return mark_safe(f'<pre>{json.dumps(obj.refresh_metadata or {}, ensure_ascii=False, indent=2)}</pre>')
    refresh_metadata_pretty.short_description = '刷新元数据'


@admin.register(TableView)
class TableViewAdmin(admin.ModelAdmin):
    """视图管理"""

    list_display = ['name', 'table_link', 'view_type', 'is_shared', 'order', 'created_at']
    list_filter = ['view_type', 'is_shared', 'is_locked', 'created_at']
    search_fields = ['name', 'description', 'table__name']
    readonly_fields = ['id', 'created_at', 'updated_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'table', 'name', 'view_type', 'description')
        }),
        ('配置', {
            'fields': ('config', 'filters', 'sorts', 'groups')
        }),
        ('显示设置', {
            'fields': ('visible_fields', 'field_order')
        }),
        ('权限', {
            'fields': ('is_shared', 'is_locked')
        }),
        ('其他', {
            'fields': ('created_by', 'order', 'created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def table_link(self, obj):
        """表格链接"""
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:tabdata_table_change', args=[obj.table.id]),
            obj.table.name
        )
    table_link.short_description = '所属表格'


@admin.register(TableShare)
class TableShareAdmin(admin.ModelAdmin):
    """分享管理"""

    list_display = ['share_id', 'table_link', 'permission', 'visit_count', 'is_expired_status', 'created_at']
    list_filter = ['permission', 'allow_download', 'created_at']
    search_fields = ['share_id', 'table__name']
    readonly_fields = ['id', 'visit_count', 'created_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'table', 'view', 'share_id')
        }),
        ('权限设置', {
            'fields': ('permission', 'password_hash')
        }),
        ('限制条件', {
            'fields': ('expire_at', 'max_visits', 'visit_count')
        }),
        ('其他设置', {
            'fields': ('allow_download', 'watermark')
        }),
        ('创建信息', {
            'fields': ('created_by', 'created_at'),
            'classes': ('collapse',)
        }),
    )

    def table_link(self, obj):
        """表格链接"""
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:tabdata_table_change', args=[obj.table.id]),
            obj.table.name
        )
    table_link.short_description = '表格'

    def is_expired_status(self, obj):
        """是否过期"""
        if obj.is_expired():
            return format_html('<span style="color: red;">已过期</span>')
        return format_html('<span style="color: green;">有效</span>')
    is_expired_status.short_description = '状态'


@admin.register(RecordComment)
class RecordCommentAdmin(admin.ModelAdmin):
    """评论管理"""

    list_display = ['content_preview', 'record_link', 'author_link', 'created_at']
    list_filter = ['created_at']
    search_fields = ['content', 'author__email', 'record__table__name']
    readonly_fields = ['id', 'created_at', 'updated_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'record', 'author', 'parent')
        }),
        ('内容', {
            'fields': ('content', 'mentions')
        }),
        ('时间信息', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def content_preview(self, obj):
        """内容预览"""
        return obj.content[:50] + '...' if len(obj.content) > 50 else obj.content
    content_preview.short_description = '评论内容'

    def record_link(self, obj):
        """记录链接"""
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:tabdata_tablerecord_change', args=[obj.record.id]),
            str(obj.record)[:30]
        )
    record_link.short_description = '所属记录'

    def author_link(self, obj):
        """作者链接"""
        if obj.author is None:
            return obj.actor_name or obj.author_name or '未知用户'
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:users_auth_user_change', args=[obj.author.id]),
            obj.actor_name or obj.author.get_display_name()
        )
    author_link.short_description = '作者'


@admin.register(RecordHistory)
class RecordHistoryAdmin(admin.ModelAdmin):
    """历史记录管理"""

    list_display = ['record_link', 'action', 'user_link', 'created_at']
    list_filter = ['action', 'created_at']
    search_fields = ['record__table__name', 'user__email']
    readonly_fields = ['id', 'field_changes_pretty', 'created_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'record', 'action', 'user')
        }),
        ('变更内容', {
            'fields': ('field_changes_pretty',)
        }),
        ('时间信息', {
            'fields': ('created_at',)
        }),
    )

    def record_link(self, obj):
        """记录链接"""
        return format_html(
            '<a href="{}">{}</a>',
            reverse('admin:tabdata_tablerecord_change', args=[obj.record.id]),
            str(obj.record)[:30]
        )
    record_link.short_description = '记录'

    def user_link(self, obj):
        """用户链接"""
        if obj.user:
            return format_html(
                '<a href="{}">{}</a>',
                reverse('admin:users_auth_user_change', args=[obj.user.id]),
                obj.user.get_display_name()
            )
        return 'System'
    user_link.short_description = '操作者'

    def field_changes_pretty(self, obj):
        """格式化显示变更"""
        return mark_safe(f'<pre>{json.dumps(obj.field_changes, ensure_ascii=False, indent=2)}</pre>')
    field_changes_pretty.short_description = '字段变更'


@admin.register(TableAdminActionLog)
class TableAdminActionLogAdmin(admin.ModelAdmin):
    """表格后台治理日志管理。"""

    list_display = [
        'created_at',
        'action_type',
        'operator_name',
        'requested_count',
        'updated_count',
        'skipped_count',
        'dry_run',
        'success',
    ]
    list_filter = ['action_type', 'dry_run', 'success', 'created_at']
    search_fields = ['operator_name', 'trace_id', 'target_table_ids_text', 'result_message', 'error_message']
    readonly_fields = [
        'id',
        'created_at',
        'action_type',
        'operator_id',
        'operator_name',
        'requested_count',
        'updated_count',
        'skipped_count',
        'dry_run',
        'success',
        'result_message',
        'error_message',
        'target_table_ids',
        'target_table_ids_text',
        'request_payload',
        'result_payload',
        'trace_id',
        'ip_address',
        'user_agent',
    ]

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'created_at', 'action_type', 'success', 'dry_run')
        }),
        ('操作人', {
            'fields': ('operator_id', 'operator_name', 'ip_address', 'user_agent')
        }),
        ('影响范围', {
            'fields': ('requested_count', 'updated_count', 'skipped_count', 'target_table_ids', 'target_table_ids_text')
        }),
        ('结果', {
            'fields': ('result_message', 'error_message', 'trace_id')
        }),
        ('快照', {
            'fields': ('request_payload', 'result_payload'),
            'classes': ('collapse',)
        }),
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

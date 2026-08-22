"""
媒体生成服务 Django Admin 管理后台
"""

from django.contrib import admin
from django.utils.html import format_html

from .models import MediaProvider, MediaModel, MediaTask


@admin.register(MediaProvider)
class MediaProviderAdmin(admin.ModelAdmin):
    list_display = ['display_name', 'name', 'scope_display', 'status_display', 'priority', 'model_count', 'created_at']
    list_filter = ['name', 'is_active', 'scope', 'runtime_status']
    search_fields = ['display_name', 'provider_key', 'user_id']
    ordering = ['-priority', '-created_at']
    readonly_fields = ['id', 'created_at', 'updated_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'name', 'provider_key', 'display_name', 'base_url', 'api_key')
        }),
        ('作用域', {
            'fields': ('scope', 'user_id', 'organization_id'),
        }),
        ('状态', {
            'fields': ('is_active', 'priority', 'rate_limit', 'runtime_status')
        }),
        ('时间', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        })
    )

    def scope_display(self, obj):
        if obj.scope == 'user' and obj.user_id:
            return f"用户: {obj.user_id[:8]}..."
        if obj.scope == 'organization' and obj.organization_id:
            return f"工作空间: {obj.organization_id[:8]}..."
        return "全局"
    scope_display.short_description = '作用域'

    def status_display(self, obj):
        if obj.is_active:
            return format_html('<span style="color: green;">✓ 启用</span>')
        return format_html('<span style="color: red;">✗ 禁用</span>')
    status_display.short_description = '状态'

    def model_count(self, obj):
        return obj.mediamodel_set.count()
    model_count.short_description = '模型数'


@admin.register(MediaModel)
class MediaModelAdmin(admin.ModelAdmin):
    list_display = ['display_name', 'model_name', 'task_type', 'provider_display', 'billing_display', 'is_active']
    list_filter = ['task_type', 'is_active', 'billing_type', 'provider__name']
    search_fields = ['model_name', 'display_name']
    ordering = ['task_type', 'model_name']
    readonly_fields = ['id', 'created_at', 'updated_at']

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'provider', 'model_name', 'display_name', 'description', 'task_type')
        }),
        ('能力', {
            'fields': (
                'supported_sizes', 'supported_durations', 'max_prompt_length',
                'supports_negative_prompt', 'supports_prompt_extend',
                'supports_audio', 'supports_multi_shot',
            )
        }),
        ('计费', {
            'fields': ('billing_type', 'price_per_unit', 'price_unit', 'free_quota')
        }),
        ('状态', {
            'fields': ('is_active', 'created_at', 'updated_at'),
        })
    )

    def provider_display(self, obj):
        return obj.provider.display_name
    provider_display.short_description = '提供商'

    def billing_display(self, obj):
        if obj.price_per_unit:
            return f"{obj.price_per_unit} {obj.price_unit}"
        return "-"
    billing_display.short_description = '单价'


@admin.register(MediaTask)
class MediaTaskAdmin(admin.ModelAdmin):
    list_display = ['id_short', 'task_type', 'status_display', 'prompt_short', 'user_id_short', 'created_at', 'completed_at']
    list_filter = ['task_type', 'status', 'created_at']
    search_fields = ['prompt', 'user_id', 'provider_task_id']
    ordering = ['-created_at']
    readonly_fields = [
        'id', 'provider_task_id', 'result_urls', 'stored_urls',
        'result_metadata', 'created_at', 'updated_at', 'submitted_at', 'completed_at',
        'poll_count', 'next_poll_at',
    ]

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'task_type', 'status', 'provider', 'model', 'user_id', 'organization_id')
        }),
        ('输入', {
            'fields': ('prompt', 'negative_prompt', 'parameters', 'input_resources')
        }),
        ('输出', {
            'fields': ('result_urls', 'stored_urls', 'result_metadata')
        }),
        ('计费', {
            'fields': ('cost_amount', 'cost_unit')
        }),
        ('错误', {
            'fields': ('error_code', 'error_message'),
            'classes': ('collapse',)
        }),
        ('轮询', {
            'fields': ('provider_task_id', 'poll_count', 'next_poll_at'),
            'classes': ('collapse',)
        }),
        ('时间', {
            'fields': ('created_at', 'updated_at', 'submitted_at', 'completed_at'),
            'classes': ('collapse',)
        })
    )

    def id_short(self, obj):
        return str(obj.id)[:8]
    id_short.short_description = 'ID'

    def prompt_short(self, obj):
        return obj.prompt[:60] + ('...' if len(obj.prompt) > 60 else '')
    prompt_short.short_description = '提示词'

    def user_id_short(self, obj):
        return obj.user_id[:8] + '...' if obj.user_id else '-'
    user_id_short.short_description = '用户'

    def status_display(self, obj):
        colors = {
            'pending': '#999',
            'running': '#1890ff',
            'succeeded': 'green',
            'failed': 'red',
            'cancelled': '#999',
        }
        color = colors.get(obj.status, '#999')
        return format_html(f'<span style="color: {color}; font-weight: bold;">{obj.get_status_display()}</span>')
    status_display.short_description = '状态'

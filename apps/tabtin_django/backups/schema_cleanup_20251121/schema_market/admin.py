from django.contrib import admin
from django.db import models

from .models import MarketTemplate, TemplateUsage


@admin.register(MarketTemplate)
class MarketTemplateAdmin(admin.ModelAdmin):
    list_display = (
        'name',
        'slug',
        'category',
        'is_official',
        'is_active',
        'usage_count',
        'updated_at',
    )
    list_filter = ('category', 'is_active', 'is_official')
    search_fields = ('name', 'slug', 'summary', 'description')
    ordering = ('-is_official', '-display_order', 'name')
    readonly_fields = ('usage_count', 'last_used_at', 'created_at', 'updated_at')
    prepopulated_fields = {'slug': ('name',)}
    formfield_overrides = {
        models.JSONField: {
            'widget': admin.widgets.AdminTextareaWidget(
                attrs={'rows': 10, 'cols': 120, 'style': 'font-family:monospace;'}
            )
        }
    }

    fieldsets = (
        ('基础信息', {
            'fields': ('name', 'slug', 'icon', 'summary', 'description', 'category', 'tags')
        }),
        ('Schema 定义', {
            'fields': ('schema_source', 'schema_json', 'variables_schema', 'url_template')
        }),
        ('展示与预览', {
            'fields': ('preview_schema', 'preview_data', 'documentation_url')
        }),
        ('执行与刷新', {
            'fields': ('refresh_config', 'extra_metadata')
        }),
        ('状态', {
            'fields': ('is_official', 'is_active', 'display_order')
        }),
        ('统计', {
            'fields': ('usage_count', 'last_used_at', 'created_at', 'updated_at')
        }),
    )


@admin.register(TemplateUsage)
class TemplateUsageAdmin(admin.ModelAdmin):
    list_display = ('template', 'user', 'status', 'created_at')
    list_filter = ('status', 'created_at')
    search_fields = ('template__name', 'template__slug', 'user__email', 'user__username')
    readonly_fields = (
        'template',
        'user',
        'workspace_id',
        'project_id',
        'rendered_url',
        'variables_filled',
        'rendered_schema',
        'generated_schema',
        'status',
        'message',
        'created_at',
        'updated_at',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

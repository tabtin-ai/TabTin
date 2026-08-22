"""
LLM 服务 Django Admin（v0.1 应急只读通道）

仅保留 LLMUsageFact + LLMAdminAuditLog 的只读 admin。
配置请走 AdminDash。
"""

from django.contrib import admin

from ..models import LLMUsageFact, LLMAdminAuditLog


class ReadOnlyAdminMixin:
    def has_add_permission(self, *args, **kwargs):
        return False

    def has_change_permission(self, *args, **kwargs):
        return False

    def has_delete_permission(self, *args, **kwargs):
        return False


@admin.register(LLMUsageFact)
class LLMUsageFactAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = [
        'request_id', 'scene_key', 'capability_domain',
        'cost_status', 'status', 'occurred_at',
    ]
    list_filter = ['capability_domain', 'cost_status', 'status', 'effective_provider_scope']
    search_fields = ['request_id', 'scene_key', 'organization_id', 'user_id']
    ordering = ['-occurred_at']
    date_hierarchy = 'occurred_at'
    readonly_fields = [
        'id', 'request_id', 'scene_key', 'capability_domain',
        'effective_provider_scope', 'cost_status', 'prompt_bundle_version',
        'provider', 'provider_key', 'model', 'model_name',
        'organization_id', 'user_id',
        'status', 'error_code', 'error_category', 'attempt_count', 'latency_ms',
        'input_tokens', 'output_tokens', 'total_tokens',
        'cache_read_input_tokens', 'cache_creation_input_tokens',
        'duration_sec', 'asset_count', 'usage_estimated',
        'input_cost', 'output_cost', 'total_cost',
        'has_override_params', 'occurred_at', 'created_at',
    ]


@admin.register(LLMAdminAuditLog)
class LLMAdminAuditLogAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = [
        'action', 'target_type', 'target_id',
        'operator_username', 'created_at',
    ]
    list_filter = ['action', 'target_type']
    search_fields = ['target_id', 'operator_username', 'operator_id']
    ordering = ['-created_at']
    readonly_fields = [
        'id', 'operator_id', 'operator_username', 'action',
        'target_type', 'target_id', 'organization_id', 'provider_id', 'model_id',
        'changed_fields', 'before_data', 'after_data', 'extra_data', 'created_at',
    ]


admin.site.site_header = '⚠️ TabTin LLM 应急通道（只读，配置请走 AdminDash）'
admin.site.index_title = '此入口仅用于事故应急排查与审计查询'

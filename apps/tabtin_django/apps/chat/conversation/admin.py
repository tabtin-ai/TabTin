"""
Conversation Django Admin配置
"""

from django.contrib import admin
from .models import ChatSession, ChatMessage, ChatContext


@admin.register(ChatSession)
class ChatSessionAdmin(admin.ModelAdmin):
    """会话管理"""
    list_display = ('id', 'title', 'user', 'organization_id', 'status', 'created_at', 'last_message_at')
    list_filter = ('status', 'created_at')
    search_fields = ('title', 'user__email')
    readonly_fields = ('id', 'created_at', 'updated_at')

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'user', 'organization_id', 'title', 'status')
        }),
        ('时间信息', {
            'fields': ('created_at', 'updated_at', 'last_message_at'),
            'classes': ('collapse',)
        }),
    )


@admin.register(ChatMessage)
class ChatMessageAdmin(admin.ModelAdmin):
    """消息管理（W3 §3.3.1：content / agent_type / intent / blocks_json 等老字段已 drop，
    改用 text_summary / content_blocks_json / stop_reason / usage_json / error_info_json）"""
    list_display = ('id', 'session', 'role', 'content_preview', 'stop_reason', 'created_at')
    list_filter = ('role', 'stop_reason', 'created_at')
    search_fields = ('text_summary', 'session__title')
    readonly_fields = ('id', 'created_at')

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'session', 'role', 'text_summary'),
        }),
        ('结构化字段（W3）', {
            'fields': (
                'stop_reason', 'subagent_run_id', 'model_name_snapshot',
                'usage_json', 'error_info_json',
            ),
            'classes': ('collapse',),
        }),
        ('Anthropic ContentBlock[]（W3）', {
            'fields': ('content_blocks_json',),
            'classes': ('collapse',),
        }),
        ('Checkpoint 锚点', {
            'fields': (
                'checkpoint_hash', 'checkpoint_state_index',
                'checkpoint_anchor_block_id', 'checkpoint_anchor_block_index',
            ),
            'classes': ('collapse',),
        }),
        ('时间信息', {
            'fields': ('created_at', 'content_blocks_trimmed_at'),
            'classes': ('collapse',),
        }),
    )

    def content_preview(self, obj):
        """内容预览（W3 §3.3.1：content → text_summary 字段重命名）"""
        text = obj.text_summary or ''
        return text[:100] + '...' if len(text) > 100 else text
    content_preview.short_description = '消息摘要'


@admin.register(ChatContext)
class ChatContextAdmin(admin.ModelAdmin):
    """上下文管理"""
    list_display = ('id', 'session', 'current_project', 'current_space_id', 'current_table_id', 'updated_at')
    list_filter = ('created_at', 'updated_at')
    search_fields = ('session__title', 'current_space_id', 'current_table_id')
    readonly_fields = ('id', 'created_at', 'updated_at')

    fieldsets = (
        ('基本信息', {
            'fields': ('id', 'session')
        }),
        ('当前上下文', {
            'fields': ('current_project', 'current_space_id', 'current_table_id', 'current_view_id')
        }),
        ('最近访问', {
            'fields': ('recent_spaces', 'recent_tables', 'recent_views'),
            'classes': ('collapse',)
        }),
        ('其他数据', {
            'fields': ('context_data',),
            'classes': ('collapse',)
        }),
        ('时间信息', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

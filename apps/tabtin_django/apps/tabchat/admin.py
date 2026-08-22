"""TabChat Django Admin 配置"""

from django.contrib import admin

from apps.tabchat.models import (
    AgentMentionJob,
    Conversation,
    ConversationAgentWorkspace,
    ConversationMember,
    ConversationUserState,
    IMEventOutbox,
    Message,
    MessageMention,
    MessageUserState,
)


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ("id", "organization_id", "type", "name", "member_count", "last_message_at", "created_at")
    list_filter = ("type",)
    search_fields = ("id", "organization_id", "name")
    readonly_fields = ("id", "dm_hash", "created_at", "updated_at")


@admin.register(ConversationMember)
class ConversationMemberAdmin(admin.ModelAdmin):
    list_display = ("id", "conversation_id", "user_id", "agent_id", "role", "joined_at")
    list_filter = ("role",)
    search_fields = ("user_id", "conversation__id")


@admin.register(ConversationAgentWorkspace)
class ConversationAgentWorkspaceAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "conversation_id",
        "agent_id",
        "workspace_id",
        "bound_by_user_id",
        "bound_at",
    )
    search_fields = ("agent_id", "conversation__id", "workspace_id")


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ("id", "conversation_id", "seq", "sender_id", "message_type", "content_preview", "created_at")
    list_filter = ("message_type",)
    search_fields = ("sender_id", "content")

    @admin.display(description="Content Preview")
    def content_preview(self, obj):
        return obj.content[:80] if obj.content else ""


admin.site.register(ConversationUserState)
admin.site.register(MessageMention)
admin.site.register(MessageUserState)
admin.site.register(IMEventOutbox)
admin.site.register(AgentMentionJob)

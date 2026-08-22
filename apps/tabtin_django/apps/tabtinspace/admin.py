from django.contrib import admin

from .models import (
    Organization,
    OrganizationMember,
    OrganizationInvitation,
    OrganizationActivity,
    SpaceMembership,
    ContextItem,
    SpaceAdminActionLog,
    Workspace,
)


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ['name', 'owner', 'is_default', 'space_count', 'member_count', 'created_at']
    search_fields = ['name', 'description']
    readonly_fields = ['created_at', 'updated_at']


@admin.register(OrganizationMember)
class OrganizationMemberAdmin(admin.ModelAdmin):
    list_display = ['organization', 'user', 'role', 'joined_at']
    search_fields = ['organization__name', 'user__username']
    list_filter = ['role']


@admin.register(OrganizationInvitation)
class OrganizationInvitationAdmin(admin.ModelAdmin):
    list_display = ['organization', 'invite_type', 'email', 'role', 'status', 'expires_at', 'created_at']
    search_fields = ['organization__name', 'email']
    list_filter = ['invite_type', 'status', 'role']
    readonly_fields = ['created_at', 'updated_at']


@admin.register(OrganizationActivity)
class OrganizationActivityAdmin(admin.ModelAdmin):
    list_display = ['actor_name', 'action', 'resource_type', 'resource_name', 'created_at']
    search_fields = ['actor_name', 'actor_id', 'resource_name']
    list_filter = ['action', 'resource_type']
    readonly_fields = ['created_at']


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ['name', 'organization', 'kind', 'device', 'created_by', 'created_at']
    search_fields = ['name', 'working_dir']
    list_filter = ['kind']


@admin.register(SpaceMembership)
class SpaceMembershipAdmin(admin.ModelAdmin):
    list_display = ['workspace', 'agent', 'user', 'role', 'is_active', 'joined_at']
    search_fields = ['workspace__name', 'agent__name', 'user__username']
    list_filter = ['role', 'is_active']


@admin.register(ContextItem)
class ContextItemAdmin(admin.ModelAdmin):
    list_display = ['title', 'item_type', 'workspace', 'project', 'status', 'is_archived', 'created_at']
    search_fields = ['title', 'item_type']
    list_filter = ['item_type', 'is_archived', 'status']


@admin.register(SpaceAdminActionLog)
class SpaceAdminActionLogAdmin(admin.ModelAdmin):
    list_display = [
        'action_type',
        'target_type',
        'target_id',
        'operator_name',
        'dry_run',
        'success',
        'created_at',
    ]
    search_fields = ['operator_id', 'operator_name', 'trace_id', 'message', 'error_message']
    list_filter = ['action_type', 'target_type', 'dry_run', 'success']
    readonly_fields = ['created_at']

from django.contrib import admin

from apps.extensions.models import (
    ExtensionConnection,
    ExtensionEventLog,
    ExtensionWebhookSubscription,
    NotificationRule,
)


@admin.register(ExtensionConnection)
class ExtensionConnectionAdmin(admin.ModelAdmin):
    list_display = [
        "extension_id",
        "organization_id",
        "space_id",
        "name",
        "enabled",
        "status",
        "auth_type",
        "updated_at",
    ]
    list_filter = ["extension_id", "status", "enabled", "auth_type"]
    search_fields = ["organization_id", "space_id", "name"]
    readonly_fields = ["id", "created_at", "updated_at"]


@admin.register(ExtensionEventLog)
class ExtensionEventLogAdmin(admin.ModelAdmin):
    list_display = [
        "extension_id",
        "event_type",
        "organization_id",
        "status",
        "created_at",
    ]
    list_filter = ["extension_id", "event_type", "status"]
    search_fields = ["organization_id", "event_type"]
    readonly_fields = ["id", "created_at", "processed_at"]


@admin.register(ExtensionWebhookSubscription)
class ExtensionWebhookSubscriptionAdmin(admin.ModelAdmin):
    list_display = [
        "url",
        "organization_id",
        "is_active",
        "total_deliveries",
        "failed_deliveries",
        "consecutive_failures",
        "last_triggered_at",
    ]
    list_filter = ["is_active"]
    search_fields = ["organization_id", "url"]
    readonly_fields = ["id", "created_at", "updated_at"]


@admin.register(NotificationRule)
class NotificationRuleAdmin(admin.ModelAdmin):
    list_display = [
        "event_pattern",
        "organization_id",
        "space_id",
        "priority",
        "category",
        "enabled",
        "is_system",
        "sort_order",
        "updated_at",
    ]
    list_filter = ["priority", "category", "enabled", "is_system"]
    search_fields = ["organization_id", "event_pattern", "source_extension_id"]
    readonly_fields = ["id", "created_at", "updated_at"]

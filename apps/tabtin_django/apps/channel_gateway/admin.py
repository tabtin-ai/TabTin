"""Channel Gateway admin"""

from django.contrib import admin

from apps.channel_gateway.models import (
    ChannelBinding,
    ChannelAllowlistEntry,
    ChannelPairingRequest,
    ChannelAccount,
    ChannelRuntimeStatus,
    ChannelInboundMessageLog,
    ChannelOutboundMessageRecord,
)


@admin.register(ChannelBinding)
class ChannelBindingAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "peer_kind",
        "peer_id",
        "organization_id",
        "space_id",
        "session_id",
        "status",
        "updated_at",
    )
    search_fields = ("channel", "peer_id", "organization_id", "space_id", "session_id")
    list_filter = ("channel", "status")


@admin.register(ChannelAllowlistEntry)
class ChannelAllowlistAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "peer_kind",
        "peer_id",
        "organization_id",
        "allow",
        "updated_at",
    )
    search_fields = ("channel", "peer_id", "organization_id")
    list_filter = ("channel", "peer_kind", "allow")


@admin.register(ChannelAccount)
class ChannelAccountAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "organization_id",
        "name",
        "enabled",
        "updated_at",
    )
    search_fields = ("channel", "account_id", "organization_id", "name")
    list_filter = ("channel", "enabled")


@admin.register(ChannelRuntimeStatus)
class ChannelRuntimeStatusAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "organization_id",
        "status",
        "updated_at",
    )
    search_fields = ("channel", "account_id", "organization_id")
    list_filter = ("channel", "status")


@admin.register(ChannelInboundMessageLog)
class ChannelInboundMessageLogAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "peer_id",
        "message_id",
        "organization_id",
        "received_at",
    )
    search_fields = ("channel", "account_id", "peer_id", "message_id", "organization_id")
    list_filter = ("channel",)


@admin.register(ChannelOutboundMessageRecord)
class ChannelOutboundMessageRecordAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "peer_id",
        "organization_id",
        "status",
        "attempts",
        "updated_at",
    )
    search_fields = ("channel", "account_id", "peer_id", "organization_id")
    list_filter = ("channel", "status")


@admin.register(ChannelPairingRequest)
class ChannelPairingAdmin(admin.ModelAdmin):
    list_display = (
        "channel",
        "account_id",
        "peer_kind",
        "peer_id",
        "organization_id",
        "status",
        "expires_at",
        "updated_at",
    )
    search_fields = ("channel", "peer_id", "organization_id", "code")
    list_filter = ("channel", "status")

from django.contrib import admin

from .models import ChangeLog, SpaceCheckpoint, VersionHistory


@admin.register(VersionHistory)
class VersionHistoryAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "resource_type",
        "resource_id",
        "is_snapshot",
        "is_named",
        "name",
        "editor_type",
        "blob_size",
        "created_at",
    ]
    list_filter = ["resource_type", "is_snapshot", "is_named", "editor_type"]
    search_fields = ["resource_id", "name", "editor_id"]
    readonly_fields = ["id", "blob", "created_at"]
    ordering = ["-created_at"]

    using = "postgresql"

    def get_queryset(self, request):
        return super().get_queryset(request).using(self.using)

    def save_model(self, request, obj, form, change):
        obj.save(using=self.using)


@admin.register(ChangeLog)
class ChangeLogAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "resource_type",
        "resource_id",
        "change_type",
        "editor_type",
        "agent_run_id",
        "created_at",
    ]
    list_filter = ["resource_type", "change_type", "editor_type"]
    search_fields = ["resource_id", "agent_run_id", "editor_id", "summary"]
    readonly_fields = ["id", "created_at"]
    ordering = ["-created_at"]

    using = "postgresql"

    def get_queryset(self, request):
        return super().get_queryset(request).using(self.using)

    def save_model(self, request, obj, form, change):
        obj.save(using=self.using)


@admin.register(SpaceCheckpoint)
class SpaceCheckpointAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "space_id",
        "name",
        "trigger",
        "editor_type",
        "created_at",
    ]
    list_filter = ["trigger", "editor_type"]
    search_fields = ["space_id", "name", "agent_run_id"]
    readonly_fields = ["id", "created_at"]
    ordering = ["-created_at"]

    using = "postgresql"

    def get_queryset(self, request):
        return super().get_queryset(request).using(self.using)

    def save_model(self, request, obj, form, change):
        obj.save(using=self.using)

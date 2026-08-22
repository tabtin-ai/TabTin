from django.contrib import admin
from .models import (
    TableEmbedding,
    RecordEmbedding,
    DocumentEmbedding,
    SkillEmbedding,
    EmbeddingTask,
    SearchLog,
)


@admin.register(EmbeddingTask)
class EmbeddingTaskAdmin(admin.ModelAdmin):
    list_display = ("id", "task_type", "target_id", "status", "retry_count", "created_at", "completed_at")
    list_filter = ("task_type", "status")
    search_fields = ("target_id", "celery_task_id")
    readonly_fields = ("id", "created_at", "started_at", "completed_at")
    ordering = ("-created_at",)


@admin.register(SearchLog)
class SearchLogAdmin(admin.ModelAdmin):
    list_display = ("id", "user_id", "query", "results_count", "response_time_ms", "created_at")
    list_filter = ("created_at",)
    search_fields = ("query", "user_id", "session_id")
    readonly_fields = ("id", "created_at")
    ordering = ("-created_at",)


@admin.register(TableEmbedding)
class TableEmbeddingAdmin(admin.ModelAdmin):
    list_display = ("id", "table_id", "status", "version", "created_at", "updated_at")
    list_filter = ("status",)
    search_fields = ("table_id",)
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(RecordEmbedding)
class RecordEmbeddingAdmin(admin.ModelAdmin):
    list_display = ("id", "record_id", "table_id", "status", "version", "created_at")
    list_filter = ("status",)
    search_fields = ("record_id", "table_id")
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(DocumentEmbedding)
class DocumentEmbeddingAdmin(admin.ModelAdmin):
    list_display = ("id", "document_id", "organization_id", "status", "version", "created_at")
    list_filter = ("status",)
    search_fields = ("document_id", "organization_id")
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(SkillEmbedding)
class SkillEmbeddingAdmin(admin.ModelAdmin):
    list_display = ("id", "skill_key", "source", "created_at", "updated_at")
    list_filter = ("source",)
    search_fields = ("skill_key",)
    readonly_fields = ("id", "created_at", "updated_at")

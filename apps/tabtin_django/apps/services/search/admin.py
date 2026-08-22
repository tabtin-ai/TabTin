from django.contrib import admin

from .models import SearchGlobalConfig, SearchProvider


@admin.register(SearchProvider)
class SearchProviderAdmin(admin.ModelAdmin):
    list_display = ("provider_key", "display_name", "provider_type", "is_active", "priority", "updated_at")
    list_filter = ("provider_type", "is_active")
    search_fields = ("provider_key", "display_name", "base_url", "api_key_env_name")
    readonly_fields = ("created_at", "updated_at")


@admin.register(SearchGlobalConfig)
class SearchGlobalConfigAdmin(admin.ModelAdmin):
    list_display = ("default_provider_key", "default_count", "default_summary_enabled", "updated_at")
    readonly_fields = ("created_at", "updated_at")

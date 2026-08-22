from django.contrib import admin

from .models import Agent


@admin.register(Agent)
class AgentAdmin(admin.ModelAdmin):
    list_display = ['name', 'organization', 'type', 'owner_user', 'is_active', 'created_at']
    search_fields = ['name', 'organization__name']
    list_filter = ['type', 'is_active']

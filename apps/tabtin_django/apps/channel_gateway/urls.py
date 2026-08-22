"""Channel Gateway URL configuration — webhook endpoints.

These live outside the Ninja API router because they use platform-specific
auth (webhook_token) rather than JWT.
"""

from django.urls import path

from apps.channel_gateway.views.webhook import channel_webhook

urlpatterns = [
    path(
        "webhook/<str:channel_id>/<str:webhook_token>/",
        channel_webhook,
        name="channel-gateway-webhook",
    ),
]

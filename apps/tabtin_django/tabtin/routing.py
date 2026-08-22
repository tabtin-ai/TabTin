"""
WebSocket routing for the WS gateway.
"""

from django.urls import path

from apps.services.common.ws.gateway import GatewayConsumer

websocket_urlpatterns = [
    path('ws/v1/gateway', GatewayConsumer.as_asgi()),
]

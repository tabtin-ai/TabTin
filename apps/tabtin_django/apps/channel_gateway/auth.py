"""Channel Gateway service token auth."""

from __future__ import annotations

import hmac

from django.conf import settings
from ninja.security import HttpBearer


class ChannelGatewayTokenAuth(HttpBearer):
    def authenticate(self, request, token: str):
        expected = getattr(settings, "CHANNEL_GATEWAY_TOKEN", "")
        if not expected:
            return None
        if not hmac.compare_digest(token, expected):
            return None
        return {"role": "channel"}

import hmac
import json
import logging
from datetime import datetime, timezone

from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from django_redis import get_redis_connection

from apps.services.common.ws.bus import (
    device_action_last_seen_key,
    device_action_ready_key,
    device_connection_count_key,
)
from apps.services.common.ws.protocol import FINGERPRINT_SAFE

logger = logging.getLogger(__name__)


def _error(status: int, message: str) -> JsonResponse:
    return JsonResponse(
        {"success": False, "message": message, "code": status},
        status=status,
    )


@csrf_exempt
@require_POST
def query_device_presence(request):
    expected = str(
        getattr(settings, "DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN", "") or ""
    )
    authorization = request.headers.get("Authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if (
        not expected
        or not separator
        or scheme.lower() != "bearer"
        or not hmac.compare_digest(token.strip(), expected)
    ):
        return _error(401, "Unauthorized")

    try:
        payload = json.loads(request.body)
    except (TypeError, ValueError):
        return _error(400, "Invalid request")

    raw_ids = payload.get("installation_ids") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list) or len(raw_ids) > 500:
        return _error(400, "Invalid installation_ids")

    installation_ids = []
    for value in raw_ids:
        if not isinstance(value, str):
            return _error(400, "Invalid installation_ids")
        if value != value.strip() or not FINGERPRINT_SAFE.fullmatch(value):
            return _error(400, "Invalid installation_ids")
        installation_ids.append(value)

    ready_keys = {
        value: device_action_ready_key(value) for value in installation_ids
    }
    last_seen_keys = {
        value: device_action_last_seen_key(value) for value in installation_ids
    }
    connection_keys = [
        device_connection_count_key(value) for value in installation_ids
    ]
    try:
        cached = cache.get_many([*ready_keys.values(), *last_seen_keys.values()])
    except Exception:
        logger.warning("Daemon Control presence lookup failed", exc_info=True)
        cached = None
    try:
        raw_connection_counts = (
            get_redis_connection("default").mget(connection_keys)
            if connection_keys
            else []
        )
        connection_counts = dict(zip(installation_ids, raw_connection_counts))
    except Exception:
        logger.warning("Daemon Control connection lookup failed", exc_info=True)
        connection_counts = None

    items = []
    for installation_id in installation_ids:
        ready = cached is not None and cached.get(ready_keys[installation_id]) is not None
        raw_count = None if connection_counts is None else connection_counts.get(installation_id)
        try:
            connected = raw_count is not None and int(raw_count) > 0
        except (TypeError, ValueError):
            connected = False
        presence = {
            "state": (
                1
                if ready or connected
                else 3 if cached is None or connection_counts is None else 2
            )
        }
        if cached is not None:
            last_seen = cached.get(last_seen_keys[installation_id])
            if isinstance(last_seen, (int, float)):
                presence["last_seen_at"] = datetime.fromtimestamp(
                    last_seen,
                    tz=timezone.utc,
                ).isoformat().replace("+00:00", "Z")
        items.append({
            "installation_id": installation_id,
            "presence": presence,
        })
    return JsonResponse(
        {
            "success": True,
            "message": "OK",
            "code": 200,
            "data": {"items": items},
        }
    )

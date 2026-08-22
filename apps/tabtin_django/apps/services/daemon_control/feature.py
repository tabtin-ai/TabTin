from __future__ import annotations

from django.conf import settings

from apps.platform_config.services import PlatformRuntimeConfigService
from apps.services.common.runtime_build import ClientBuild


def daemon_control_enabled_for_organization(
    *,
    user_id: str,
    organization_id: str,
    client: ClientBuild | None = None,
) -> bool:
    if not getattr(settings, "DAEMON_CONTROL_ENABLED", False) or not organization_id:
        return False
    return PlatformRuntimeConfigService.evaluate_feature(
        "daemon_control",
        client=client,
        user_id=str(user_id),
        organization_id=str(organization_id),
    ).enabled

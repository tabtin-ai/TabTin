from __future__ import annotations

from apps.platform_config.services import PlatformRuntimeConfigService
from apps.services.common.runtime_build import ClientBuild


FEISHU_IMPORT_FEATURE_KEY = "feishu_import"
FEISHU_IMPORT_DISABLED_MESSAGE = "当前组织尚未开放飞书导入"


def feishu_import_enabled_for_organization(
    *,
    user_id: str,
    organization_id: str,
    client: ClientBuild | None = None,
) -> bool:
    if not organization_id:
        return False
    return PlatformRuntimeConfigService.evaluate_feature(
        FEISHU_IMPORT_FEATURE_KEY,
        client=client,
        user_id=str(user_id),
        organization_id=str(organization_id),
    ).enabled

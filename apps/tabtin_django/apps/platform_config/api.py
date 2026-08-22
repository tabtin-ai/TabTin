from __future__ import annotations

from ninja import Router

from apps.i18n.response import success_response
from apps.platform_config.services import PlatformRuntimeConfigService
from apps.services.common.runtime_build import parse_client_build
from apps.tabtinspace.models import OrganizationMember
from apps.users.auth.permissions import JWTAuth


router = Router(tags=["Platform Config"])
jwt_auth = JWTAuth()


@router.get("/product-limits/organization-create-policy", auth=jwt_auth)
def get_organization_create_policy(request):
    policy = PlatformRuntimeConfigService.get_organization_create_policy(request.auth)
    return success_response(data=policy.as_dict())


@router.get("/features/effective", auth=jwt_auth)
def get_effective_features(request, organization_id: str | None = None):
    # 当前组织由客户端上下文提供，但只在登录用户确为成员时生效。
    trusted_organization_id = ""
    if organization_id and OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=request.auth.id,
    ).exists():
        trusted_organization_id = organization_id
    return success_response(
        data=PlatformRuntimeConfigService.list_effective_features(
            client=parse_client_build(request),
            user_id=str(request.auth.id),
            organization_id=trusted_organization_id,
        )
    )

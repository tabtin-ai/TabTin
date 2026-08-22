"""Tabtin Space 路由共享依赖与 helper。"""

import logging

from uuid import UUID

from ninja import Router

from ninja.errors import HttpError

from django.http import HttpRequest

from apps.users.auth.permissions import JWTAuth, DaemonJWTAuth, JWTAuthOptional
from apps.services.billing.organization_resolver import resolve_organization_id_from_space
from apps.services.oss.services.public_assets import build_public_asset_url

from apps.tabtinspace.services import (
    OrganizationService,
    SpaceService,
    AgentService,
    ContextItemService,
    SpaceAccessService,
    DeviceService,
    CollectionService,
)

from apps.tabtinspace.services.capability_discovery_service import CapabilityDiscoveryService

from apps.tabtinspace.services.app_catalog_service import OrganizationAppCatalogService

from apps.tabtinspace.schemas.common import ErrorResponse
from apps.tabtinspace.schemas.organization import (
    OrganizationCreate,
    OrganizationUpdate,
    OrganizationOut,
    OwnershipTransferRequest,
)
from apps.tabtinspace.schemas.membership import (
    OrganizationMemberAdd,
    OrganizationMemberUpdate,
    OrganizationMemberOut,
    OrganizationMemberProfilesRequest,
    SpaceMembershipCreate,
    SpaceMembershipOut,
)
from apps.tabtinspace.schemas.space import (
    SpaceCreate,
    SpaceUpdate,
    SpaceOut,
    SpaceStatusUpdate,
    SpaceAppsSettingsUpdate,
    SpaceAppOut,
)
from apps.tabtinspace.schemas.app_catalog import (
    AppCatalogItem,
    AppCatalogOut,
    AppInstallOut,
    AppUninstallOut,
)
from apps.tabtinspace.schemas.agent import AgentCreate, AgentUpdate, AgentOut, AgentPreferredModelUpdate
from apps.tabtinspace.schemas.share import (
    ResourcePermissionGrant,
)
from apps.tabtinspace.schemas.context_item import (
    ContextItemCreate,
    ContextItemUpdate,
    ContextItemOut,
    TrashedContextItemOut,
    ReorderKnowledgeTreeSiblings,
)
from apps.tabtinspace.schemas.invitation import (
    InvitationEmailCreate,
    InvitationLinkCreate,
    InvitationDirectCreate,
    InvitationPhoneCreate,
    InvitationRespondRequest,
    InvitationOut,
    PendingInvitationOut,
)
from apps.tabtinspace.schemas.device import (
    DeviceRegister,
    DeviceHeartbeat,
    DevicePushTokenRegister,
    DevicePushTokenRevoke,
    DeviceTokenRenew,
    DeviceOffline,
    DeviceUpdate,
    DeviceActionRequest,
    SpaceDeviceActionRequest,
    DeviceOut,
    AgentBindDevice,
    SpaceBindDevice,
)
from apps.tabtinspace.schemas.capability import (
    CapabilityDiscoverySpaceSummaryOut,
    CapabilityRefreshRequest,
    CapabilityRefreshResponse,
)
from apps.tabtinspace.schemas.remote_server import (
    RemoteServerCreate,
    RemoteServerUpdate,
    RemoteServerOut,
)
from apps.tabtinspace.schemas.mcp_connection import (
    MCPConnectionCreate,
    MCPConnectionOrgCreate,
    MCPConnectionUpdate,
    MCPConnectionProbe,
    MCPConnectionOut,
)
from apps.tabtinspace.schemas.daemon import DaemonInstallTokenCreate, DaemonActivate
from apps.tabtinspace.schemas.collection import (
    CollectionCreate,
    CollectionUpdate,
    CollectionReorder,
    MoveItemsToCollection,
    SharedResourcePlacementMove,
    ReorderCollectionItems,
)

from apps.services.agent_engine.services.device_runtime_query_service import DeviceRuntimeQueryService

from apps.i18n.response import (
    success_response,
    not_found_response,
    permission_denied_response,
    error_response_with_status as error_response,
)

from apps.tabtinspace.models import Space, SpaceAppSettings, Workspace

from apps.tabtinspace.services.invitation_service import InvitationService

from apps.tabtinspace.services.base import BaseService, ServiceError

from apps.tabtinspace.services.audit_service import AuditService
from apps.services.common.db_router import postgres_app_db_alias

from apps.tabtinspace.services.permission_service import ResourcePermissionService

from apps.services.common.app_registry import list_apps

from apps.services.notification.services.notification_service import NotificationService

from apps.i18n import _

logger = logging.getLogger(__name__)


def _get_context_url_field(app_def) -> str:
    """从 AppDefinition 的 context_fields 中提取主 context 字段名。"""
    if not app_def.context_fields:
        return ""
    resource_fields = [f for f in app_def.context_fields if f.is_resource_id]
    return resource_fields[0].name if resource_fields else app_def.context_fields[0].name

RESP_ERR = {401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}
RESP_ERR_400 = {400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}
RESP_CREATE = {201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse}
RESP_CREATE_SIMPLE = {201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse}
RESP_WITH_CONFLICT = {400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse}
RESP_CREATE_WITH_CONFLICT = {201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse}

jwt_auth = JWTAuth()

daemon_jwt_auth = DaemonJWTAuth()

jwt_auth_optional = JWTAuthOptional()

# DE-20: unauthenticated activate endpoint should be throttled per IP.
_ACTIVATE_RATE_LIMIT_PER_IP = 10
_ACTIVATE_RATE_LIMIT_WINDOW = 60

def _audit(request, **kwargs):
    """非阻断审计日志 + 活动流写入"""
    try:
        ip = request.META.get('REMOTE_ADDR')
        ua = request.META.get('HTTP_USER_AGENT', '')
        return AuditService.log(
            operator=getattr(request, 'auth', None),
            ip_address=ip,
            user_agent=ua,
            **kwargs,
        )
    except Exception as e:
        logger.warning("审计日志写入失败（非阻断）: %s", e)
        return None

def _serialize_space_available_tools(user_id: str, space_id: str) -> list:
    """List the tools currently visible to LLMs in this Space.

    W6 (2026-05-04): the LLM tool SSoT lives in the TS runtime
    (Capability + ToolProvider). Python ToolHub no longer registers any
    LLM-visible tools, so this helper only returns the action-tools
    manifest (filtered by enabled apps + optional allowlist) for UI
    listing purposes. Capability-level tools (terminal / file IO / etc.)
    are surfaced by the client runtime directly and are not part of this
    HTTP response.
    """
    from apps.services.tools import get_all_action_tools
    from apps.services.agent_engine.utils.common.app_utils import resolve_enabled_action_app_ids
    from apps.tabtinspace.services.app_settings_service import AppSettingsService

    allowlist = AppSettingsService.resolve_optional_tool_allowlist(user_id, space_id)
    action_app_ids = resolve_enabled_action_app_ids(user_id, space_id)
    try:
        action_tools = get_all_action_tools(
            app_ids=action_app_ids,
            optional_tool_allowlist=allowlist,
            runtime_type=None,
        )
    except Exception as exc:
        logger.warning("列举 action-tools 失败: %s", exc)
        action_tools = []

    seen: set[str] = set()
    rows: list = []
    for tool in action_tools:
        name = getattr(tool, "name", None)
        if not isinstance(name, str) or not name or name in seen:
            continue
        seen.add(name)
        rows.append({
            "name": name,
            "description": getattr(tool, "description", "") or "",
            "domain": "action-tools",
            "optional": bool(getattr(tool, "optional", False)),
        })
    rows.sort(key=lambda r: (r["domain"], r["name"]))
    return rows


def _serialize_space_data(space, share_info: dict | None = None) -> dict:
    """将 Space ORM 实例序列化为 dict。Space 现在是纯容器。"""
    data = SpaceOut.from_orm(space).dict()
    data["avatar"] = build_public_asset_url(data.get("avatar") or "")
    if share_info:
        data["member_count"] = share_info.get("member_count", data.get("member_count", 1))
    try:
        from apps.tabtinspace.services.execution_binding import resolve_execution_binding

        binding = resolve_execution_binding(space=space)
        data["execution_agent_id"] = getattr(binding.agent, "id", None)
        data["execution_binding_source"] = binding.source
    except Exception:
        data["execution_agent_id"] = None
        data["execution_binding_source"] = None
    data["owner_execution_device_id"] = None
    data["owner_execution_device_name"] = ""
    data["owner_execution_device_status"] = ""
    if getattr(space, "type", None) == Space.SpaceType.TEAM_SPACE:
        try:
            from apps.tabtinspace.services.execution_binding import resolve_execution_binding

            execution_space = getattr(space, "execution_space", None)
            if execution_space is None and getattr(space, "execution_space_id", None):
                execution_space = Workspace.objects.select_related(
                    "agent", "device",
                ).filter(id=space.execution_space_id).first()
            execution_binding = resolve_execution_binding(space=execution_space)
            execution_device = execution_binding.device
            if execution_device is not None:
                data["owner_execution_device_id"] = getattr(execution_device, "id", None)
                data["owner_execution_device_name"] = getattr(execution_device, "name", "") or ""
                data["owner_execution_device_status"] = getattr(execution_device, "status", "") or ""
        except Exception:
            data["owner_execution_device_id"] = None
            data["owner_execution_device_name"] = ""
            data["owner_execution_device_status"] = ""
    agent = getattr(space, 'agent', None)
    if agent:
        prompts = getattr(agent, 'suggested_prompts', None)
        data['suggested_prompts'] = prompts if isinstance(prompts, list) else []
    else:
        data['suggested_prompts'] = []

    return data

def _build_share_info_map(user, organization_id=None, spaces=None) -> dict:
    """为 Space 列表补充 member_count 等可见性展示字段。"""
    from apps.tabtinspace.services.space_visibility import active_member_counts

    if not spaces:
        return {}
    space_ids = [space.id for space in spaces]
    counts = active_member_counts(space_ids)
    return {
        space_id: {"member_count": counts.get(space_id, 1)}
        for space_id in space_ids
    }

def _serialize_agent_data(agent, *, workspace=None) -> dict:
    """将 Agent ORM 实例序列化为 dict（委托 apps.agent.serializers）。"""
    from apps.agent.serializers import serialize_agent

    return serialize_agent(agent, workspace=workspace)

def _enrich_empty_previews(items, item_data: list[dict]) -> None:
    """对 preview 为空的条目，批量反查源模型补充预览信息。
    每种 item_type 仅一条 SQL，不会 N+1。
    同时回写 ContextItem 表以减少后续请求的查询。
    """
    empty_indices: dict[str, list[tuple[int, str]]] = {}
    for idx, (item, data) in enumerate(zip(items, item_data)):
        if not data.get("preview") and data.get("resource_id"):
            it = data["item_type"]
            empty_indices.setdefault(it, []).append((idx, data["resource_id"]))

    if not empty_indices:
        return

    from uuid import UUID as _UUID
    from apps.tabtinspace.resource_registry import get_resource_model

    ids_to_update: list[tuple] = []

    for it, entries in empty_indices.items():
        model_cls = get_resource_model(it)
        if not model_cls:
            continue

        resource_ids = [e[1] for e in entries]
        try:
            valid_uuids = []
            for rid in resource_ids:
                try:
                    valid_uuids.append(_UUID(rid))
                except (ValueError, AttributeError):
                    pass
            if not valid_uuids:
                continue
            resources = {
                str(r.id): r
                for r in model_cls.objects.using(postgres_app_db_alias())
                .filter(id__in=valid_uuids)
                .iterator()
            }
        except Exception as exc:
            logger.warning("[enrich_previews] batch query %s failed: %s", it, exc)
            continue

        for idx, rid in entries:
            resource = resources.get(rid)
            if not resource:
                continue
            try:
                new_preview = resource.get_context_preview()
                new_metadata = resource.get_context_metadata()
                if new_preview:
                    item_data[idx]["preview"] = new_preview
                if new_metadata:
                    item_data[idx]["metadata"] = new_metadata
                ids_to_update.append((items[idx].id, new_preview, new_metadata))
            except Exception as exc:
                logger.warning("[enrich_previews] %s/%s preview failed: %s", it, rid, exc)

    if ids_to_update:
        try:
            from django.utils import timezone
            from apps.tabtinspace.models import ContextItem as _CI
            now = timezone.now()
            for item_id, preview, metadata in ids_to_update:
                _CI.objects.using(postgres_app_db_alias()).filter(id=item_id).update(
                    preview=preview, metadata=metadata, updated_at=now,
                )
        except Exception as exc:
            logger.warning("[enrich_previews] write-back failed: %s", exc)


def _enrich_owner_info(items, item_data: list[dict]) -> None:
    """批量回填资源真实所有者 owner 与创建者 created_by 展示信息。

    - owner / owner_id：Document/Table 等资源 SSOT，缺失则为 null（不回退 created_by）
    - created_by：ContextItem.created_by_id 的展示信息
    用户展示信息一次 build_user_info_map，避免 N+1。
    """
    from apps.tabtinspace.services.resource_owner_resolver import enrich_context_item_owners

    enrich_context_item_owners(items, item_data)


def _enrich_capabilities(items, item_data: list[dict], user) -> None:
    """批量回填 can_* 能力位。"""
    from apps.tabtinspace.services.cloud_resource_acl import enrich_item_capabilities

    enrich_item_capabilities(items, item_data, user)


def _enrich_last_visited(items, item_data: list[dict], user) -> None:
    """批量回填当前用户对本页资源的 last_visited_at 到 item_data[i]['last_visited_at']。

    对本页所有 ContextItem id 一次 ResourceAccess 查询，避免 N+1。
    """
    user_id = getattr(user, "id", None)
    if not user_id:
        for data in item_data:
            data["last_visited_at"] = None
        return

    item_ids = [getattr(it, "id", None) for it in items if getattr(it, "id", None)]
    if not item_ids:
        for data in item_data:
            data["last_visited_at"] = None
        return

    try:
        from apps.tabtinspace.models import ResourceAccess
        visited_map = {
            str(row["context_item_id"]): row["last_visited_at"]
            for row in ResourceAccess.objects.filter(
                user_id=user_id, context_item_id__in=item_ids,
            ).values("context_item_id", "last_visited_at")
        }
    except Exception as exc:
        logger.warning("[enrich_last_visited] query failed: %s", exc)
        visited_map = {}

    for it, data in zip(items, item_data):
        data["last_visited_at"] = visited_map.get(str(getattr(it, "id", "")))


_RATE_LIMIT_LUA = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return current
"""

def _check_activate_rate_limit(request: HttpRequest):
    """DE-20: IP-based rate limiting for unauthenticated /devices/activate endpoint.

    Fail-open: Redis 不可用时放行请求。限速是保护层而非安全层，
    真正的防重放由 _claim_token 的 Redis SETNX 保证。
    """
    from apps.users.auth.utils import get_client_ip, hash_string
    try:
        from django_redis import get_redis_connection
        ip = get_client_ip(request)
        if not ip:
            return True
        conn = get_redis_connection("default")
        key = f"rate:activate:{hash_string(ip)[:16]}"
        count = conn.eval(_RATE_LIMIT_LUA, 1, key, _ACTIVATE_RATE_LIMIT_WINDOW)
        return int(count) <= _ACTIVATE_RATE_LIMIT_PER_IP
    except Exception as exc:
        logger.warning("Rate limit check failed (allowing request): %s", exc)
        return True

def _publish_context_sync(
    space_id,
    event_type: str,
    extra: dict | None = None,
    organization_id: str | None = None,
    *,
    recipient_user_ids=None,
):
    """推送 ContextSync WS 事件。

    ``space_id`` 可为空（ org-only 资源没有 workspace/project 宿主）——此时
    只发 organization 维度 topic，不发退化成字符串 "None" 的 space topic。

    ：云盘资源敏感事件改走用户 topic，不写 organization / space topic。
    ``recipient_user_ids`` 用于永久删除等 ACL 已失效场景（提交前快照）。
    """
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import ContextSyncEvent
        from apps.tabtinspace.services.context_sync_publisher import (
            is_cloud_resource_type,
            is_sensitive_cloud_context_sync_event,
            publish_cloud_resource_event,
        )

        resolved_organization_id = organization_id or (
            resolve_organization_id_from_space(str(space_id)) if space_id else None
        )
        payload = {
            'type': event_type,
            'space_id': str(space_id) if space_id else None,
            'organization_id': resolved_organization_id,
        }
        if extra:
            payload.update(extra)

        # 云盘资源 lifecycle / 可见性事件：只扇出到授权用户
        if is_sensitive_cloud_context_sync_event(payload) or (
            is_cloud_resource_type(payload.get('resource_type'))
            and str(event_type or '').startswith('resource_')
        ):
            created_by_id = None
            if extra and extra.get('created_by_id'):
                created_by_id = str(extra['created_by_id'])
            publish_cloud_resource_event(
                payload,
                recipient_user_ids=recipient_user_ids,
                created_by_id=created_by_id,
            )
            return

        topics = []
        if space_id:
            topics.append(f"{ContextSyncEvent.PREFIX}.{space_id}")
        if resolved_organization_id:
            topics.append(f"{ContextSyncEvent.PREFIX}.organization.{resolved_organization_id}")

        for topic in dict.fromkeys(topics):
            publish_ws_event(
                topic=topic,
                envelope=payload,
            )
    except Exception as exc:
        logger.warning("[ContextSync] WS push failed: %s", exc, exc_info=True)

def _push_context_item_ws(item, event_type: str, user=None):
    from apps.tabtinspace.services.asset_host import host_id_of

    organization_id = None
    try:
        host = getattr(item, 'workspace', None) or getattr(item, 'project', None)
        if host and getattr(host, 'organization_id', None):
            organization_id = str(host.organization_id)
        elif getattr(item, 'organization_id', None):
            # org-only 资源：没有 workspace/project 宿主，直接取自身 organization_id。
            organization_id = str(item.organization_id)
    except Exception:
        organization_id = None

    created_by_id = getattr(item, 'created_by_id', None)
    _publish_context_sync(
        space_id=host_id_of(item),
        organization_id=organization_id,
        event_type=event_type,
        extra={
            'resource_type': item.item_type,
            'resource_id': str(item.resource_id),
            'context_item_id': str(item.id),
            'title': item.title,
            'user_id': str(user.id) if user else None,
            'metadata': item.metadata,
            'status': item.status,
            'preview': item.preview,
            'is_pinned': item.is_pinned,
            'pinned_at': item.pinned_at.isoformat() if item.pinned_at else None,
            'collection_id': str(item.collection_id) if item.collection_id else None,
            'created_by_id': str(created_by_id) if created_by_id else None,
        },
    )

def _push_collection_ws(
    space_id,
    event_type: str,
    collection=None,
    extra: dict = None,
    organization_id: str | None = None,
    *,
    recipient_user_ids=None,
):
    """推送 Collection 相关 WS 事件。

     /  / ：org-only 文件夹改投递创建者（或显式接收人）
    的 user topic，不再写 organization topic，避免文件夹名/id 泄露。
    Space 宿主路径仍走 space / organization 广播（membership 语义不变）。
    """
    payload = {}
    if collection:
        payload['collection_id'] = str(collection.id)
        payload['collection_name'] = collection.name
        created_by_id = getattr(collection, 'created_by_id', None)
        if created_by_id:
            payload['created_by_id'] = str(created_by_id)
    if extra:
        payload.update(extra)

    resolved_organization_id = organization_id
    if not resolved_organization_id and space_id:
        resolved_organization_id = resolve_organization_id_from_space(str(space_id))

    # org-only：无 space 宿主时只扇出到授权用户
    if resolved_organization_id and not space_id:
        from apps.tabtinspace.services.context_sync_publisher import (
            publish_private_collection_event,
        )

        envelope = {
            'type': event_type,
            'space_id': None,
            'organization_id': str(resolved_organization_id),
        }
        envelope.update(payload)
        publish_private_collection_event(
            envelope,
            recipient_user_ids=recipient_user_ids,
            created_by_id=payload.get('created_by_id'),
        )
        return

    _publish_context_sync(
        space_id,
        event_type,
        payload,
        organization_id=resolved_organization_id,
        recipient_user_ids=recipient_user_ids,
    )

__all__ = [
    'logging',
    'UUID',
    'Router',
    'HttpError',
    'HttpRequest',
    'JWTAuth',
    'DaemonJWTAuth',
    'JWTAuthOptional',
    'ErrorResponse',
    'RESP_ERR',
    'RESP_ERR_400',
    'RESP_CREATE',
    'RESP_CREATE_SIMPLE',
    'RESP_WITH_CONFLICT',
    'RESP_CREATE_WITH_CONFLICT',
    'OrganizationService',
    'SpaceService',
    'AgentService',
    'ContextItemService',
    'SpaceAccessService',
    'DeviceService',
    'CollectionService',
    'CapabilityDiscoveryService',
    'OrganizationAppCatalogService',
    'OrganizationCreate',
    'OrganizationUpdate',
    'OrganizationOut',
    'OrganizationMemberAdd',
    'OrganizationMemberUpdate',
    'OrganizationMemberOut',
    'OrganizationMemberProfilesRequest',
    'SpaceCreate',
    'SpaceUpdate',
    'SpaceOut',
    'SpaceStatusUpdate',
    'SpaceAppsSettingsUpdate',
    'SpaceAppOut',
    'AppCatalogItem',
    'AppCatalogOut',
    'AppInstallOut',
    'AppUninstallOut',
    'AgentCreate',
    'AgentUpdate',
    'AgentOut',
    'AgentPreferredModelUpdate',
    'SpaceMembershipCreate',
    'SpaceMembershipOut',
    'ContextItemCreate',
    'ContextItemUpdate',
    'ContextItemOut',
    'TrashedContextItemOut',
    'ReorderKnowledgeTreeSiblings',
    'ErrorResponse',
    'InvitationEmailCreate',
    'InvitationLinkCreate',
    'InvitationDirectCreate',
    'InvitationPhoneCreate',
    'InvitationRespondRequest',
    'InvitationOut',
    'PendingInvitationOut',
    'OwnershipTransferRequest',
    'ResourcePermissionGrant',
    'DeviceRegister',
    'DeviceHeartbeat',
    'DevicePushTokenRegister',
    'DevicePushTokenRevoke',
    'DeviceTokenRenew',
    'DeviceOffline',
    'DeviceUpdate',
    'DeviceActionRequest',
    'SpaceDeviceActionRequest',
    'DeviceOut',
    'CapabilityDiscoverySpaceSummaryOut',
    'CapabilityRefreshRequest',
    'CapabilityRefreshResponse',
    'AgentBindDevice',
    'SpaceBindDevice',
    'RemoteServerCreate',
    'RemoteServerUpdate',
    'RemoteServerOut',
    'MCPConnectionCreate',
    'MCPConnectionOrgCreate',
    'MCPConnectionUpdate',
    'MCPConnectionProbe',
    'MCPConnectionOut',
    'DaemonInstallTokenCreate',
    'DaemonActivate',
    'CollectionCreate',
    'CollectionUpdate',
    'CollectionReorder',
    'MoveItemsToCollection',
    'SharedResourcePlacementMove',
    'ReorderCollectionItems',
    'DeviceRuntimeQueryService',
    'success_response',
    'not_found_response',
    'permission_denied_response',
    'error_response',
    'Space',
    'SpaceAppSettings',
    'InvitationService',
    'BaseService',
    'ServiceError',
    'AuditService',
    'ResourcePermissionService',
    'list_apps',
    'NotificationService',
    '_get_context_url_field',
    '_',
    'logger',
    'jwt_auth',
    'daemon_jwt_auth',
    'jwt_auth_optional',
    '_audit',
    '_serialize_space_available_tools',
    '_serialize_space_data',
    '_build_share_info_map',
    '_serialize_agent_data',
    '_enrich_empty_previews',
    '_enrich_owner_info',
    '_enrich_capabilities',
    '_enrich_last_visited',
    '_check_activate_rate_limit',
    '_publish_context_sync',
    '_push_context_item_ws',
    '_push_collection_ws',
]

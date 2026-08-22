"""Tabtin Space 分域路由聚合入口。"""

from ninja import Router

from .organization import router as organization_router

from .membership import router as membership_router

from .agent import router as agent_legacy_router

from .approval_memo import router as approval_memo_router

from .app_catalog import router as app_catalog_router

from .invitation import router as invitation_router

from .share import router as share_router

from .capability import router as capability_router

from .space import router as space_router

from .workspace import router as workspace_router

from .project import router as project_router

from .context_item import router as context_item_router

from .device import router as device_router

from .remote_server import router as remote_server_router

from .mcp_connection import router as mcp_connection_router

from .daemon import router as daemon_router

from .collection import router as collection_router

from .tabfiles import router as tabfiles_router

from .space_activity import router as space_activity_router

router = Router(tags=["Tabtin Space"])

router.add_router("", organization_router)

router.add_router("", membership_router)

# Agent 身份 CRUD 的正典是 /api/agents；旧 /api/context/agents 路径限时委托。
router.add_router("", agent_legacy_router)

# Workspace 审批记忆等仍挂在本聚合下。
router.add_router("", approval_memo_router)

router.add_router("", app_catalog_router)

router.add_router("", invitation_router)

router.add_router("", share_router)

router.add_router("", capability_router)

router.add_router("", space_router)

router.add_router("", workspace_router)

router.add_router("", project_router)

router.add_router("", context_item_router)

# Keep daemon routes ahead of device detail routes so
# `/devices/activate` does not get shadowed by `/devices/{device_id}`.
router.add_router("", daemon_router)

router.add_router("", device_router)

router.add_router("", remote_server_router)

router.add_router("", mcp_connection_router)

router.add_router("", collection_router)

router.add_router("", tabfiles_router)

router.add_router("", space_activity_router)

__all__ = ["router"]

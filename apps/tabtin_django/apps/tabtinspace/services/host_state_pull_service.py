"""执行设备 Agent Host 的权威运行状态读取服务。"""

from __future__ import annotations

from collections import defaultdict

from apps.agent.models import Agent
from apps.agent.serializers import serialize_agent
from apps.services.agent_engine.services.memory_table_service import MemoryTableService
from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
)
from apps.tabtinspace.models import Device, Workspace
from apps.tabtinspace.schemas.organization import OrganizationOut
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.workspace_service import (
    WorkspaceService,
    serialize_workspaces,
)


class HostStatePullService:
    """按执行设备的真实绑定生成 Host 可原子应用的完整上下文集合。"""

    def __init__(self, *, user) -> None:
        self.user = user

    def pull(self, device_fingerprint: str) -> dict:
        device = (
            Device.objects.filter(
                fingerprint=device_fingerprint,
                user_id=self.user.id,
                role="control",
                control_status=Device.CONTROL_STATUS_CHOICES[0][0],
            )
            .only("id", "fingerprint", "user_id")
            .first()
        )
        if device is None:
            raise ServiceError("DEVICE_NOT_FOUND", "执行设备不存在或无权访问", 404)

        # Workspace.device 是执行绑定事实源；可见性继续复用 WorkspaceService，
        # 避免 host-state 形成一套与产品列表不同的权限口径。
        workspaces = list(
            WorkspaceService(user=self.user)
            .list_workspaces()
            .filter(device_id=device.id)
            .select_related("organization")
            .order_by("organization_id", "created_at")
        )
        if not workspaces:
            return {"contexts": []}

        workspaces_by_organization: dict[str, list[Workspace]] = defaultdict(list)
        organizations = {}
        for workspace in workspaces:
            organization_id = str(workspace.organization_id)
            workspaces_by_organization[organization_id].append(workspace)
            organizations[organization_id] = workspace.organization

        agents = (
            Agent.objects.filter(
                organization_id__in=organizations.keys(),
                owner_user_id=self.user.id,
                is_active=True,
            )
            .select_related("organization")
            .order_by("organization_id", "created_at")
        )
        personal_rules = PromptForwardService.resolve_personal_rules_by_owner_id(
            self.user.id
        )
        workspace_details = {
            detail["id"]: detail for detail in serialize_workspaces(workspaces)
        }
        enabled_apps_by_workspace = {
            str(workspace.id): PromptForwardService.derive_enabled_apps_for_forward(
                workspace,
                str(self.user.id),
            )
            for workspace in workspaces
        }
        memory_enabled_by_workspace = {
            str(workspace.id): MemoryTableService.is_memory_enabled_for(
                self.user.id,
                workspace.id,
            )
            for workspace in workspaces
        }
        contexts = []
        for agent in agents:
            organization_id = str(agent.organization_id)
            agent_detail = serialize_agent(agent, personal_rules=personal_rules)
            organization_detail = OrganizationOut.model_validate(
                agent.organization
            ).model_dump()
            agent_config = agent_detail.get("agent_config") or {}
            operation_switches = (
                agent_config.get("capabilities", {})
                .get("overrides", {})
                .get("shell", {})
                .get("operation_switches")
            )
            if not isinstance(operation_switches, dict):
                operation_switches = {}
            # Agent 与 Workspace 是会话的两个独立选择维度；只要同属一个组织，
            # 用户可将任一自有 active Agent 放到任一可见且绑定本设备的 Workspace
            # 执行，因此这里有意生成笛卡尔积，而不是臆造默认绑定。
            for workspace in workspaces_by_organization[organization_id]:
                workspace_id = str(workspace.id)
                enabled_apps = enabled_apps_by_workspace[workspace_id]
                contexts.append(
                    {
                        "organizationId": organization_id,
                        "organizationDetail": organization_detail,
                        "agentDetail": agent_detail,
                        "workspaceDetail": workspace_details[workspace_id],
                        "runtimeConfig": {
                            "operationSwitches": operation_switches,
                            "memoryCapability": memory_enabled_by_workspace[workspace_id],
                            "enabledApps": [
                                {
                                    "key": app["key"],
                                    "cliKey": app.get("cli_key"),
                                    "displayName": app["display_name"],
                                    "capability": app["capability"],
                                    **(
                                        {"aliases": app["aliases"]}
                                        if app.get("aliases")
                                        else {}
                                    ),
                                }
                                for app in enabled_apps
                            ],
                        },
                    }
                )

        return {"contexts": contexts}


__all__ = ["HostStatePullService"]

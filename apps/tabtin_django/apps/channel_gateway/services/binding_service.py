"""Channel binding space/session orchestration service."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Union
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist

from apps.chat.conversation.models import ChatSession
from apps.channel_gateway.services.identity_context import resolve_channel_identity_user
from apps.services.llm.models import LLMModel
from apps.tabtinspace.models import Organization, Project, Workspace
from apps.tabtinspace.services.host_resolver import resolve_host

Host = Union[Workspace, Project]

logger = logging.getLogger(__name__)


class ChannelBindingService:
    """负责绑定场景中的 Space / Session 一致性。"""

    def __init__(self, organization_id: str):
        self.organization_id = str(organization_id)

    def ensure_organization(self) -> Organization:
        organization = Organization.objects.filter(id=self.organization_id).first()
        if not organization:
            raise ValueError("organization not found")
        return organization

    def resolve_space(self, space_id: Optional[str]) -> Optional[Host]:
        if not space_id:
            return None
        space = resolve_host(space_id)
        if not space or str(space.organization_id) != self.organization_id:
            raise ValueError("space organization mismatch")
        return space

    def ensure_session(self, session_id: str | UUID) -> ChatSession:
        session = ChatSession.objects.filter(id=session_id).first()
        if not session:
            raise ValueError("session not found")
        if str(session.organization_id) != self.organization_id:
            raise ValueError("session organization mismatch")
        self.ensure_thread_id(session)
        return session

    def resolve_identity_user(self, identity_user_id: str):
        return resolve_channel_identity_user(
            organization_id=self.organization_id,
            identity_user_id=identity_user_id,
        )

    def create_session(
        self,
        organization: Organization,
        space: Optional[Host],
        *,
        identity_user,
        agent_id: str,
        workspace_id: str,
        title: str = "Channel Session",
    ) -> ChatSession:
        from apps.services.llm.services.capability_guard import apply_chat_model_filter

        if identity_user is None or not getattr(identity_user, "id", None):
            raise ValueError("identity user required")
        from apps.tabtinspace.models import Agent, Workspace

        agent = Agent.objects.filter(
            id=agent_id,
            organization_id=organization.id,
            owner_user_id=identity_user.id,
            is_active=True,
        ).first()
        workspace = Workspace.objects.filter(
            id=workspace_id,
            organization_id=organization.id,
            created_by_id=identity_user.id,
        ).first()
        if agent is None or workspace is None:
            raise ValueError("channel requires a pre-authorized Agent × Workspace binding")

        default_model_name = getattr(settings, "DEFAULT_LLM_MODEL", "gpt-4o")
        # v0.1：LLMProvider.is_active 字段已删（0022），可路由 = routing_enabled。
        model_instance = apply_chat_model_filter(
            LLMModel.objects.filter(
                model_name=default_model_name,
                provider__routing_enabled=True,
            ),
        ).first()
        if not model_instance:
            model_instance = apply_chat_model_filter(
                LLMModel.objects.filter(provider__routing_enabled=True),
            ).first()

        session = ChatSession.objects.create(
            user=identity_user,
            organization_id=str(organization.id),
            agent=agent,
            workspace=workspace,
            title=title,
            current_model_id=model_instance.id if model_instance else None,
            default_model_id=model_instance.id if model_instance else None,
        )
        self.ensure_thread_id(session)
        self.sync_session_space(session, space)
        return session

    def ensure_thread_id(self, session: ChatSession) -> None:
        if session.thread_id:
            return
        session.thread_id = f"chat-session-{session.id}"
        session.save(update_fields=["thread_id"])

    def sync_session_space(self, session: ChatSession, space: Optional[Host]) -> None:
        """同步 handling host 到会话的执行 Workspace 或协作 Project。

        Project 只写 ``ChatSession.project`` 与 ``ChatContext.current_project_id``；
        不再把 Project.id 偷塞到 current_space_id 或 workspace FK。
        """
        from apps.tabtinspace.models import Project, Workspace

        target_space_id = str(space.id) if space else None
        target_workspace = space if isinstance(space, Workspace) else None
        target_project = space if isinstance(space, Project) else None
        legacy_resource_host = space is not None and target_workspace is None and target_project is None
        current_workspace_id = str(session.workspace_id) if session.workspace_id else None
        target_workspace_id = str(target_workspace.id) if target_workspace else None

        context = None
        try:
            context = session.context
        except (AttributeError, ObjectDoesNotExist):
            context = None

        if context is None and getattr(session, "pk", None) and target_space_id:
            from apps.chat.conversation.models import ChatContext

            context, _ = ChatContext.objects.get_or_create(
                session=session,
                defaults={
                    # 未知的旧式 host 仍是资源宿主，必须保留在
                    # current_space_id；只有明确的 Project 才不写这里。
                    "current_space_id": (
                        target_space_id
                        if target_workspace is not None or legacy_resource_host
                        else ""
                    ),
                    "current_project_id": target_project.id if target_project else None,
                },
            )

        current_context_space_id = getattr(context, "current_space_id", "") or ""
        current_context_project_id = str(getattr(context, "current_project_id", "") or "")
        normalized_target_space_id = target_space_id or ""

        if target_workspace is not None and current_workspace_id != target_workspace_id:
            session.workspace = target_workspace
            session.save(update_fields=["workspace", "updated_at"])
        elif space is None and current_workspace_id is not None:
            session.workspace = None
            session.save(update_fields=["workspace", "updated_at"])

        if str(getattr(session, "project_id", "") or "") != str(target_project.id if target_project else ""):
            session.project = target_project
            session.save(update_fields=["project", "updated_at"])

        update_fields = []
        if context is not None and (target_workspace is not None or legacy_resource_host) and current_context_space_id != normalized_target_space_id:
            context.current_space_id = normalized_target_space_id
            update_fields.append("current_space_id")
        if context is not None and current_context_project_id != str(target_project.id if target_project else ""):
            context.current_project = target_project
            update_fields.append("current_project")
        if update_fields:
            context.save(update_fields=[*update_fields, "updated_at"])

    # ------------------------------------------------------------------
    # Account config validation (signing fields enforcement)
    # ------------------------------------------------------------------

    @staticmethod
    def validate_account_signing_config(channel: str, config: Dict[str, Any]) -> List[str]:
        """Validate that signing-related config fields are present for the adapter.

        Called before saving a ChannelAccount to enforce mandatory signing
        configuration (DE-02 security fix).
        Returns a list of error strings; empty list means valid.
        """
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        adapter = ChannelAdapterRegistry.get(channel)
        if not adapter:
            return [f"unknown channel: {channel}"]
        return adapter.validate_config(config or {})

    # ------------------------------------------------------------------
    # Routing context (DB fallback when cache expires)
    # ------------------------------------------------------------------

    @staticmethod
    def get_binding_routing(
        channel: str, account_id: str, peer_id: str, organization_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Fetch persisted routing context from ChannelBinding.metadata._routing.

        Used by adapters as a DB fallback when Django cache expires.
        """
        from apps.channel_gateway.models import ChannelBinding

        meta = (
            ChannelBinding.objects
            .filter(
                channel=channel,
                account_id=account_id,
                peer_id=peer_id,
                organization_id=str(organization_id),
            )
            .values_list("metadata", flat=True)
            .first()
        )
        if meta and isinstance(meta, dict):
            return meta.get("_routing")
        return None

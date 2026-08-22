from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


BindingSource = Literal[
    "workspace.device",
    "none",
]


@dataclass(frozen=True)
class ExecutionBinding:
    device: object | None
    source: BindingSource
    agent: object | None = None


def _load_agent_by_id(agent_id) -> object | None:
    if not agent_id:
        return None

    from apps.tabtinspace.models import Agent

    try:
        return Agent.objects.filter(id=agent_id, is_active=True).first()
    except Exception:
        return None


def resolve_execution_agent(
    *,
    space=None,
    agent=None,
    agent_id=None,
    organization_id=None,
    identity_user_id=None,
):
    if agent is not None:
        return agent

    if agent_id:
        return _load_agent_by_id(agent_id)

    return None


def resolve_execution_binding(
    *,
    space=None,
    agent=None,
    agent_id=None,
    organization_id=None,
    identity_user_id=None,
) -> ExecutionBinding:
    resolved_agent = resolve_execution_agent(
        space=space,
        agent=agent,
        agent_id=agent_id,
        organization_id=organization_id,
        identity_user_id=identity_user_id,
    )

    device = getattr(space, "device", None) if space is not None else None
    if device is not None:
        return ExecutionBinding(
            device=device,
            source="workspace.device",
            agent=resolved_agent,
        )

    return ExecutionBinding(device=None, source="none", agent=resolved_agent)


def resolve_control_device(
    *,
    space=None,
    agent=None,
    agent_id=None,
    organization_id=None,
    identity_user_id=None,
):
    return resolve_execution_binding(
        space=space,
        agent=agent,
        agent_id=agent_id,
        organization_id=organization_id,
        identity_user_id=identity_user_id,
    ).device


__all__ = [
    "BindingSource",
    "ExecutionBinding",
    "resolve_execution_agent",
    "resolve_control_device",
    "resolve_execution_binding",
]

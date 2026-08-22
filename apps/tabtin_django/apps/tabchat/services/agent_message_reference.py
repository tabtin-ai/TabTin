"""Agent mention 引用快照，由 Django IM 落库。"""

from __future__ import annotations

from dataclasses import dataclass

from apps.agent.display_name import resolve_agent_display_name
from apps.agent.models import Agent
from apps.tabchat.models import AgentMentionJob


class AgentMessageReferenceError(RuntimeError):
    pass


class TransientAgentMessageReferenceError(AgentMessageReferenceError):
    pass


class PermanentAgentMessageReferenceError(AgentMessageReferenceError):
    pass


@dataclass(frozen=True)
class AgentMentionContextSnapshot:
    sender_id: str
    sender_type: str
    content: str
    seq: int
    is_referenced: bool


@dataclass(frozen=True)
class AgentMentionReactionResult:
    delivered: bool
    context: tuple[AgentMentionContextSnapshot, ...]


def build_agent_message_reference_payload(
    job: AgentMentionJob,
    agent: Agent,
) -> dict:
    final_message = getattr(job, "final_message", None)
    content = str(getattr(job, "final_content", "") or getattr(final_message, "content", ""))
    metadata = dict(getattr(job, "final_metadata", None) or getattr(final_message, "metadata", None) or {})
    return {
        "organization_id": str(job.organization_id),
        "conversation_id": str(job.conversation_ref),
        "message_ref": str(job.source_message_ref),
        "agent_id": str(agent.id),
        "agent_name": resolve_agent_display_name(agent),
        "content": content,
        "metadata": metadata,
    }


def deliver_agent_mention_reaction(
    *,
    organization_id: str,
    conversation_ref: str,
    message_ref: str,
    source_user_id: str,
    agent: Agent,
    source_message_seq: int,
) -> AgentMentionReactionResult:
    del organization_id, conversation_ref, message_ref, source_user_id, agent, source_message_seq
    return AgentMentionReactionResult(delivered=False, context=())


def deliver_agent_message_reference(job_id: str) -> bool:
    del job_id
    return False

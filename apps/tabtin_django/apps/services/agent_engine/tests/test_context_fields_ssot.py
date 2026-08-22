"""Regression tests for manifest-driven Agent context fields."""

from apps.chat.conversation.schemas import UpdateContextRequest
from apps.services.agent_engine.state._generated_context_fields import APP_CONTEXT_FIELDS
from apps.services.agent_engine.state.agent_state import AgentState
from apps.services.agent_engine.state.key_registry import immutable_keys
from apps.services.agent_engine.state.state_types import ContextState


def test_manifest_context_fields_are_available_in_all_state_types() -> None:
    """Generated manifest fields must flow into all Agent state type surfaces."""
    manifest_fields = set(APP_CONTEXT_FIELDS)

    assert manifest_fields <= set(AgentState.__annotations__)
    assert manifest_fields <= set(ContextState.__annotations__)
    assert manifest_fields <= set(UpdateContextRequest.model_fields)


def test_manifest_context_fields_are_registered_immutable() -> None:
    """Context fields are request context; StateIsolation should treat them as immutable."""
    missing = sorted(set(APP_CONTEXT_FIELDS) - set(immutable_keys()))

    assert missing == []


def test_recent_manifest_fields_do_not_need_manual_registry_updates() -> None:
    """Fields recently missed by hand-written lists are now covered by codegen consumers."""
    for field in (
        "current_tracker_id",
        "current_tracker_title",
        "current_file_id",
        "current_file_name",
    ):
        assert field in APP_CONTEXT_FIELDS
        assert field in AgentState.__annotations__
        assert field in ContextState.__annotations__
        assert field in immutable_keys()


def test_removed_tabdesign_fields_do_not_enter_agent_context_surfaces() -> None:
    """TabDesign is no longer a manifest app, so its old focus fields stay out of runtime context."""
    for field in ("current_design_id", "current_design_title"):
        assert field not in APP_CONTEXT_FIELDS
        assert field not in AgentState.__annotations__
        assert field not in ContextState.__annotations__
        assert field not in UpdateContextRequest.model_fields
        assert field not in immutable_keys()

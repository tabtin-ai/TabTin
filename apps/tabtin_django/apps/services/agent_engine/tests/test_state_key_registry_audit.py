"""State key registry audit regressions."""

from apps.services.agent_engine.state.key_registry import audit_registry_coverage
from apps.services.agent_engine.state.state_types import EngineInternalState


def test_state_key_registry_audit_has_no_drift() -> None:
    """TypedDict declarations, registry metadata, and legacy exemptions stay aligned."""
    assert audit_registry_coverage() == {"unregistered": [], "undeclared": []}


def test_active_hidden_state_keys_are_typed_not_legacy_only() -> None:
    """Hidden state keys with live consumers should remain declared in EngineInternalState."""
    for key in (
        "_ctx_window_tokens",
        "_rendered_system_prompt",
        "_request_system_prompt",
    ):
        assert key in EngineInternalState.__annotations__

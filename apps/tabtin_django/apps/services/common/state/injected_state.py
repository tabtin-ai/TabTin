"""
InjectedState shim — Pydantic metadata marker for state-injected tool parameters.

Usage::

    from apps.services.common.state.injected_state import InjectedState
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(...)
"""

try:
    from langchain_core.tools.base import InjectedToolArg
except Exception:  # pragma: no cover - only for very old langchain_core builds
    class InjectedToolArg:  # type: ignore[no-redef]
        pass


class InjectedState(InjectedToolArg):
    """Pydantic metadata marker for state-injected tool parameters.

    Attributes:
        field: The state key to inject from (e.g. "user_id", "organization_id").
    """

    __slots__ = ("field",)

    def __init__(self, field: str = "") -> None:
        self.field = field

    def __repr__(self) -> str:
        return f"InjectedState({self.field!r})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, InjectedState):
            return self.field == other.field
        return NotImplemented

    def __hash__(self) -> int:
        return hash(("InjectedState", self.field))


__all__ = ["InjectedState"]

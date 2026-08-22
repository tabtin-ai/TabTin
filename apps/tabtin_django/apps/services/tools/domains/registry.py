"""Built-in tool domains entrypoint (W6: ToolHub retired).

W6 (2026-05-04): Python ToolHub has been retired as the LLM tool registry.
The single source of truth for LLM-visible tools is the TS Runtime
(Capability + ToolProvider in ``packages/agent-runtime`` / ``apps/tabtin-electron``).
Python BaseTool implementations are demoted to "HTTP API providers" — they
remain importable so that Django HTTP routes / CLI bridges (e.g. Extension
CLI ``execute_extension_cli_command``, ``query_device_action``) can keep
delegating to per-tool ``run()`` methods, but they are no longer registered
into ``ToolHub`` and never reach the LLM.

This module historically called ``ToolHub.register_provider(...)`` for every
domain. All registrations have been removed. The remaining helpers exist only
to keep legacy import sites (tests, audit commands, sync services) wiring-
compatible — every collection helper now returns an empty result, which
naturally falls through to the TS-side SSoT.

See:
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, TypedDict

from apps.services.tools import BaseTool, ToolHub

_registry_logger = logging.getLogger(__name__)


class RegistrationHealth(TypedDict):
    loaded: List[str]
    failed: List[str]
    total: int


# ---------------------------------------------------------------------------
# Public API — kept for backward compatibility.
# All collection helpers return empty results because no domains are
# registered with ToolHub after W6.
# ---------------------------------------------------------------------------

def get_tool_registry() -> Dict[str, Dict[str, BaseTool]]:
    """Return the per-domain tool registry.

    Always empty after W6 — LLM tools live in the TS runtime SSoT.
    """
    return {}


def get_all_tools(domain: Optional[str] = None) -> List[BaseTool]:
    """Return registered ToolHub tools for a domain (always empty after W6)."""
    return []


def get_tool_by_name(tool_name: str, domain: Optional[str] = None) -> Optional[BaseTool]:
    """Lookup a registered ToolHub tool by name (always ``None`` after W6)."""
    return None


def get_tool_info(domain: Optional[str] = None) -> List[dict]:
    """Return tool metadata records for audit tooling (always empty after W6)."""
    return []


def get_action_tool_manifest_info() -> dict:
    """Return the action-tools manifest payload (still backed by manifest.json)."""
    from apps.services.tools.domains.action_tool_manifest import load_action_tool_manifest
    return load_action_tool_manifest()


def get_registration_health() -> RegistrationHealth:
    """Return registration health (always reports zero domains after W6)."""
    return RegistrationHealth(loaded=list(ToolHub.list_domains()), failed=[], total=0)


_registry_logger.info(
    "[ToolRegistry] ToolHub retired (W6). LLM tool SSoT now lives in TS runtime; "
    "Python tool implementations are reachable only via HTTP API / CLI bridge."
)


__all__ = [
    "get_tool_registry",
    "get_all_tools",
    "get_tool_by_name",
    "get_tool_info",
    "get_action_tool_manifest_info",
    "get_registration_health",
]

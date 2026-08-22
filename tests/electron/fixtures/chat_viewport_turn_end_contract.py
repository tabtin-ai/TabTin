#!/usr/bin/env python3
"""Static AST contract for chat_viewport_turn_end_case.py (no Django import).

Run: python3 tests/electron/fixtures/chat_viewport_turn_end_contract.py
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

FIXTURE_PATH = Path(__file__).with_name("chat_viewport_turn_end_case.py")


def _collect_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.keyword) and node.arg:
            names.add(node.arg)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            names.add(node.value)
    return names


def assert_turn_end_fixture_ast_contract(source: str | None = None) -> None:
    text = source if source is not None else FIXTURE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(text, filename=str(FIXTURE_PATH))
    names = _collect_names(tree)

    required = {
        "TABTIN_E2E_LIVE_SPACE_ID",
        "live_space_candidates",
        "select_execution_context",
        "select_active_user",
        "preferred_model_id",
        "control_device__status__in",
        "bound_device__status__in",
        "control_status",
        "working_dir",
        "name__startswith",
        "usesExistingExecutionSpace",
        "selectionStrategy",
        "agentReady",
        "deviceReady",
        "workingDirReady",
        "preferredModelReady",
        "membershipReady",
        "membershipProvisioned",
        "organizationMemberReady",
        "SpaceMembership",
        "OrganizationMember",
    }
    missing = sorted(required - names)
    if missing:
        raise AssertionError(
            f"chat_viewport_turn_end_case.py AST contract missing symbols: {missing}"
        )

    # Must not emit provider secrets in prepare payload keys.
    forbidden_literal_keys = {
        "providerSecret",
        "apiKey",
        "api_key",
        "accessToken",
        "refreshToken",
    }
    leaked = sorted(forbidden_literal_keys & names)
    if leaked:
        raise AssertionError(
            f"fixture must not emit provider/auth secrets in prepare payload: {leaked}"
        )

    forbidden = {
        "ensure_e2e_user",
        "OrganizationService",
        "ensure_default_space_for_member",
        "sync_execution_binding",
        "ensure_agent_membership",
    }
    present_forbidden = sorted(forbidden & names)
    if present_forbidden:
        raise AssertionError(
            f"fixture must not synthesize users/Spaces or copy bindings: {present_forbidden}"
        )

    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    selector = functions.get("select_execution_context")
    if selector is None:
        raise AssertionError("missing select_execution_context")
    selector_text = ast.get_source_segment(text, selector) or ""
    env_pos = selector_text.find("TABTIN_E2E_LIVE_SPACE_ID")
    fallback_pos = selector_text.find("for space in live_space_candidates()")
    no_candidate_pos = selector_text.find('"query:no-ready-existing-space"')
    if min(env_pos, fallback_pos, no_candidate_pos) < 0:
        raise AssertionError("selector must contain env, query fallback, and no-candidate paths")
    if not env_pos < fallback_pos < no_candidate_pos:
        raise AssertionError("env selection must be strict and precede query fallback")

    candidate_fn = functions.get("live_space_candidates")
    candidate_text = ast.get_source_segment(text, candidate_fn) if candidate_fn else ""
    required_filters = (
        "agent__is_active=True",
        'exclude(agent__preferred_model_id="")',
        'exclude(working_dir="")',
        'exclude(name__startswith="[")',
        "control_device__status__in",
        "bound_device__status__in",
    )
    missing_filters = [item for item in required_filters if item not in candidate_text]
    if missing_filters:
        raise AssertionError(f"fallback query missing readiness filters: {missing_filters}")

    # Existing execution bindings are read-only. The owner SpaceMembership may
    # be ensured so the reused user can enter the Space; ChatSession is run-scoped.
    if "Space.objects.get_or_create" in text or "Organization.objects.get_or_create" in text:
        raise AssertionError("fixture must not create Organization or Space records")
    if "SpaceMembership.objects.get_or_create" not in text:
        raise AssertionError("fixture must ensure active owner SpaceMembership")
    if "ChatSession.objects.get_or_create" not in text:
        raise AssertionError("fixture must create/get only the run-scoped ChatSession")
    if "ChatMessage.objects.filter(session=session).delete()" not in text:
        raise AssertionError("fixture must clear only the selected run-scoped session")


def main() -> None:
    assert_turn_end_fixture_ast_contract()
    print("PASS chat_viewport_turn_end_case.py AST contract")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — CLI contract runner
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)

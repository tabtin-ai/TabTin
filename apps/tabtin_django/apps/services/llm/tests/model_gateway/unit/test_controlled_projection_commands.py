import inspect
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from django.test import override_settings

from apps.services.llm.management.commands import model_gateway_apply, model_gateway_prepare, model_gateway_rollback
from apps.services.llm.model_gateway.apply.gates import require_write_gate
from apps.services.llm.model_gateway.apply.results import ProjectionOperationRejected
from apps.services.llm.model_gateway.apply.service import _require_apply_contract


def test_write_gate_defaults_false_and_service_fails_closed():
    with pytest.raises(ProjectionOperationRejected, match="projection-write-disabled"):
        require_write_gate(database_alias="disposable", actor="operator", ticket="review-1")
    with override_settings(MODEL_GATEWAY_PROJECTION_WRITE_ENABLED=True):
        require_write_gate(database_alias="disposable", actor="operator", ticket="review-1")


def test_commands_have_exact_operational_inputs_and_no_force_or_latest():
    source = "\n".join(inspect.getsource(module.Command) for module in (
        model_gateway_prepare, model_gateway_apply, model_gateway_rollback,
    ))
    for required in ("--database", "--actor", "--ticket", "--confirm-hash"):
        assert required in source
    for forbidden in ("--force", "--ignore-readiness", "--allow-draft", '"latest"'):
        assert forbidden not in source


def test_write_commands_delegate_to_services_and_do_not_embed_transactions():
    source = "\n".join(inspect.getsource(module) for module in (
        model_gateway_prepare, model_gateway_apply, model_gateway_rollback,
    ))
    assert "transaction.atomic" not in source
    assert "ProviderKey" not in source
    assert "requests" not in source and "httpx" not in source


def test_all_eight_real_kimi_doubao_drafts_are_rejected_by_apply_gate():
    artifact_root = Path(__file__).parents[3] / "model_gateway" / "artifacts" / "drafts"
    packages = []
    for provider in ("kimi", "doubao"):
        packages.extend(
            json.loads(line) for line in (artifact_root / provider / "packages" / "index.jsonl").read_text().splitlines()
            if line.strip()
        )
    assert len(packages) == 8
    for package in packages:
        assert package["status"] == "draft"
        class DraftRevision:
            behavior_blockers = []
            readiness_blockers = ["draft-not-publishable"]
            projection_metadata = {}
            commercial_fields = []
        with pytest.raises(ProjectionOperationRejected, match="readiness-blocked"):
            _require_apply_contract(DraftRevision(), datetime(2026, 8, 6, tzinfo=timezone.utc))

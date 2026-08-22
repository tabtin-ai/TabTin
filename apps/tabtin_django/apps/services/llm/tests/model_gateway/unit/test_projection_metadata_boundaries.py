import pathlib

import apps.services.llm.model_gateway.persistence as persistence


ROOT = pathlib.Path(__file__).parents[3]


def test_persistence_boundary_has_no_orm_write_network_cache_task_or_credential_dependency():
    source = pathlib.Path(persistence.__file__).read_text(encoding="utf-8")
    for token in (
        "django.db", ".save(", ".update(", ".create(", "requests.", "httpx.", "socket.",
        "celery", "cache.", "decrypt", "ProviderKey", "billing_precheck", "settle", "freeze",
    ):
        assert token not in source


def test_no_runtime_admin_api_signal_or_command_consumes_projection_metadata():
    allowed = {
        ROOT / "models.py",
        ROOT / "model_gateway" / "persistence.py",
    }
    matches = []
    for path in ROOT.rglob("*.py"):
        if path in allowed or "/model_gateway/apply/" in path.as_posix() or "management/commands/model_gateway_" in path.as_posix() or "/tests/" in path.as_posix() or "/migrations/" in path.as_posix():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if "ModelGatewayProjectionBinding" in text or "ModelGatewayProjectionRevision" in text or "ModelGatewayProjectionEvent" in text:
            matches.append(path)
    assert matches == []


def test_pr8_exposes_only_explicit_prepare_apply_and_rollback_commands():
    command_root = ROOT / "management" / "commands"
    names = {path.stem for path in command_root.glob("model_gateway_*.py")}
    assert {"model_gateway_prepare", "model_gateway_apply", "model_gateway_rollback"} <= names
    assert names.isdisjoint({"model_gateway_bootstrap", "model_gateway_sync", "model_gateway_update_pointer"})

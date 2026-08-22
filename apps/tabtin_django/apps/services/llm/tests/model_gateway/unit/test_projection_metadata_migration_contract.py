import ast
import importlib
from pathlib import Path

migration_module = importlib.import_module(
    "apps.services.llm.migrations.0057_model_gateway_projection_metadata",
)
MIGRATION_PATH = Path(migration_module.__file__)


def operation_names():
    return [operation.__class__.__name__ for operation in migration_module.Migration.operations]


def test_migration_depends_on_the_single_current_llm_leaf():
    assert migration_module.Migration.dependencies == [("llm", "0056_kimi_k2x_binary_thinking_correction")]


def test_migration_is_schema_only_and_reversible():
    names = operation_names()
    assert names.count("CreateModel") == 3
    assert names.count("AddField") == 1
    assert names.count("AddIndex") == 6
    assert names.count("AddConstraint") == 11
    assert not {"RunPython", "RunSQL", "AlterField", "RemoveField"} & set(names)
    assert all(getattr(operation, "reversible", True) for operation in migration_module.Migration.operations)


def test_migration_creates_only_projection_metadata_models():
    created = {
        operation.name
        for operation in migration_module.Migration.operations
        if operation.__class__.__name__ == "CreateModel"
    }
    assert created == {
        "ModelGatewayProjectionBinding",
        "ModelGatewayProjectionRevision",
        "ModelGatewayProjectionEvent",
    }


def test_migration_contains_no_seed_or_runtime_mutation_symbols():
    source = MIGRATION_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    assert not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) for node in ast.walk(tree))
    for token in ("Kimi", "Doubao", "LLMProvider", "LLMModel", "ProviderKey", "RunPython", "RunSQL"):
        assert token not in source


def test_migration_has_no_external_runtime_or_credential_imports():
    source = MIGRATION_PATH.read_text(encoding="utf-8")
    for token in ("requests", "httpx", "socket", "celery", "cache", "credential", "billing"):
        assert token not in source.casefold()

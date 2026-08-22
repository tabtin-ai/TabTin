import ast
from pathlib import Path


def test_public_import_has_no_runtime_or_io_dependencies():
    package = Path(__file__).parents[3] / "model_gateway"
    forbidden = ("django", "requests", "httpx", "apps.services.llm.proxy", "apps.services.llm.billing", "apps.services.llm.wire_adapter")
    imported = []
    for source in package.rglob("*.py"):
        for node in ast.walk(ast.parse(source.read_text())):
            if isinstance(node, ast.Import): imported.extend((source,alias.name) for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module: imported.append((source,node.module))
    assert not any(
        (name == prefix or name.startswith(prefix + "."))
        and not (
            prefix == "django"
            and (source.name == "snapshot.py" or "/model_gateway/apply/" in source.as_posix())
        )
        for source, name in imported for prefix in forbidden
    )

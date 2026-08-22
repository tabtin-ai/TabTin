import inspect
import io
import json

from django.core.management.base import OutputWrapper

from apps.services.llm.management.commands.model_gateway_shadow_compare import Command


def test_empty_root_is_stable_and_does_not_query_database(monkeypatch, tmp_path):
    import apps.services.llm.management.commands.model_gateway_shadow_compare as module
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    monkeypatch.setattr(module, "read_database_snapshot", lambda **kwargs: (_ for _ in ()).throw(AssertionError("unexpected DB")))
    command = Command()
    stream = io.StringIO()
    command.stdout = OutputWrapper(stream)
    command.handle(artifact_root=str(tmp_path), legacy_fixture_root=str(fixtures), package=None, database="default", format="json")
    assert json.loads(stream.getvalue()) == {"results": []}


def test_command_exposes_no_write_runtime_or_network_option():
    source = inspect.getsource(Command)
    for token in ("apply", "autofill", "cutover", ".save(", "objects.update(", ".delete(", "requests.", "httpx.", "billing_precheck", "freeze", "settle"):
        assert token not in source

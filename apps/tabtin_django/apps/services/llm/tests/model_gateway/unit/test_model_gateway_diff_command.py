import inspect
import io
import json

import pytest

from django.core.management.base import CommandError, OutputWrapper

from apps.services.llm.management.commands.model_gateway_diff import Command


def test_diff_command_empty_root_is_stable_and_does_not_touch_database(monkeypatch,tmp_path):
    import apps.services.llm.management.commands.model_gateway_diff as module
    monkeypatch.setattr(module,"read_database_snapshot",lambda **kwargs: (_ for _ in ()).throw(AssertionError("unexpected DB access")))
    command=Command(); stream=io.StringIO(); command.stdout=OutputWrapper(stream)
    command.handle(artifact_root=str(tmp_path),package=None,format="json",database="default")
    assert json.loads(stream.getvalue())=={"blocking":False,"plans":[]}


def test_diff_command_has_no_write_or_apply_interface():
    source=inspect.getsource(Command)
    for token in (".save(",".delete(",".update(","bulk_create","bulk_update","apply","rollback","autofill","task.delay","cache.set"):
        assert token not in source


def test_invalid_package_blocks_before_snapshot_query(monkeypatch, tmp_path):
    import apps.services.llm.management.commands.model_gateway_diff as module

    (tmp_path / "invalid.json").write_text("{", encoding="utf-8")
    monkeypatch.setattr(module, "read_database_snapshot", lambda **kwargs: (_ for _ in ()).throw(AssertionError("unexpected DB access")))
    command = Command()
    command.stdout = OutputWrapper(io.StringIO())
    with pytest.raises(CommandError):
        command.handle(artifact_root=str(tmp_path), package=None, format="json", database="default")


def test_reviewed_mapping_source_is_explicit_command_input():
    source = inspect.getsource(Command.handle)
    assert 'getattr(self, "reviewed_mappings", {})' in source
    assert "reviewed_mapping=reviewed_mappings.get" in source


def test_diff_command_only_adds_rate_cards_by_exact_binding_reference():
    source = inspect.getsource(Command.handle)
    assert "item.binding_ref.kind == binding.identity.kind" in source
    assert "item.binding_ref.key == binding.identity.key" in source
    assert "item.binding_ref.revision == binding.identity.revision" in source
    assert "item.binding_ref.expected_hash == binding.identity.canonical_hash" in source

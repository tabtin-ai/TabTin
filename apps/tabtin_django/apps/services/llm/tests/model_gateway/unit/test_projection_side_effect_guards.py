import io
import inspect

from celery import current_app
from django.core.cache import cache
from django.core.management.base import OutputWrapper
from django.db.models import Model, QuerySet
from django.dispatch import Signal

from apps.services.llm.management.commands.model_gateway_diff import Command
from apps.services.llm.model_gateway.projection.compiler import compile_projection
from apps.services.llm.model_gateway.projection.diff import render_projection_diff


def fail_side_effect(*args, **kwargs):
    raise AssertionError("unexpected side effect")


def test_empty_command_has_no_model_queryset_cache_task_or_signal_side_effect(monkeypatch, tmp_path):
    monkeypatch.setattr(Model, "save", fail_side_effect)
    monkeypatch.setattr(Model, "delete", fail_side_effect)
    for method in ("update", "delete", "bulk_create", "bulk_update", "update_or_create", "get_or_create"):
        monkeypatch.setattr(QuerySet, method, fail_side_effect)
    for method in ("set", "add", "delete"):
        monkeypatch.setattr(cache, method, fail_side_effect)
    monkeypatch.setattr(current_app, "send_task", fail_side_effect)
    monkeypatch.setattr(Signal, "send", fail_side_effect)
    monkeypatch.setattr(Signal, "send_robust", fail_side_effect)
    command = Command()
    command.stdout = OutputWrapper(io.StringIO())
    command.handle(artifact_root=str(tmp_path), package=None, format="json", database="default")


def test_compiler_and_renderer_have_no_orm_or_side_effect_imports():
    source = inspect.getsource(compile_projection) + inspect.getsource(render_projection_diff)
    for forbidden in ("objects.", "QuerySet", "django.db", ".save(", ".delete(", ".delay(", ".apply_async(", "cache."):
        assert forbidden not in source


def test_command_exposes_no_write_repair_or_rollback_option():
    source = inspect.getsource(Command.add_arguments)
    for forbidden in ("--apply", "--fix", "--autofill", "--rollback"):
        assert forbidden not in source

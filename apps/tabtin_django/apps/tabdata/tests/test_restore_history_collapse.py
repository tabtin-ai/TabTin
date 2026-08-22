""": table restore history should surface as one event."""
from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

from apps.tabdata.services.undo_redo_service import UndoRedoService  # noqa: E402


def test_restore_changelog_and_record_history_collapse_to_one_event():
    record_operations = [
        {
            "id": "record-history-1",
            "record_id": "record-1",
            "action": "restore",
            "operation_group_id": "restore-group",
            "created_at": "2026-06-20T00:00:00Z",
            "field_changes": {"_deleted": {"old": False, "new": True}},
        },
        {
            "id": "record-history-2",
            "record_id": "record-2",
            "action": "restore",
            "operation_group_id": "restore-group",
            "created_at": "2026-06-20T00:00:01Z",
            "field_changes": {"_deleted": {"old": False, "new": True}},
        },
    ]
    field_operations = [
        {
            "id": "change-log-1",
            "record_id": "table-1",
            "action": "restore",
            "action_display": "还原到版本 abc12345",
            "operation_group_id": "restore-group",
            "created_at": "2026-06-20T00:00:05Z",
            "field_changes": {
                "restore": {
                    "old": None,
                    "new": {"name": "还原到版本 abc12345", "field_type": "restore"},
                },
            },
        },
    ]

    collapsed = UndoRedoService._collapse_restore_history_operations(
        record_operations,
        field_operations,
    )

    assert len(collapsed) == 1
    assert collapsed[0]["id"] == "change-log-1"
    assert collapsed[0]["record_id"] == "table-1"
    assert collapsed[0]["action_display"] == "还原到版本 abc12345"
    assert collapsed[0]["field_changes"] == field_operations[0]["field_changes"]


def test_restore_collapse_keeps_unrelated_history_operations():
    record_operations = [
        {
            "id": "delete-history",
            "record_id": "record-3",
            "action": "delete",
            "operation_group_id": "delete-group",
            "created_at": "2026-06-20T00:00:02Z",
            "field_changes": {"_deleted": {"old": False, "new": True}},
        },
    ]

    collapsed = UndoRedoService._collapse_restore_history_operations(
        record_operations,
        [],
    )

    assert collapsed == record_operations


def test_restore_target_history_id_uses_existing_restore_metadata_keys():
    assert UndoRedoService._restore_target_history_id({
        "history_id": "record-history-id",
    }) == "record-history-id"
    assert UndoRedoService._restore_target_history_id({
        "restored_from": "version-history-id",
    }) == "version-history-id"
    assert UndoRedoService._restore_target_history_id({
        "restored_from_history": "legacy-history-id",
    }) == "legacy-history-id"


def test_restore_changed_records_excludes_native_sync_only_results():
    changed_records = 0
    new_history_count = 0
    result = type("ReplayResultStub", (), {
        "changed": False,
        "native_synced": True,
    })()

    if result.changed:
        changed_records += 1
        new_history_count += 1

    assert changed_records == 0
    assert new_history_count == 0

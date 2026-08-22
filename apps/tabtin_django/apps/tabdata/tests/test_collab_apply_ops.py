from unittest.mock import patch
from uuid import UUID

from apps.tabdata.services.collab_service import CollabService, _is_valid_collab_position_id


def test_position_id_protocol_validation_rejects_unknown_malformed_and_oversized_values():
    assert _is_valid_collab_position_id("p1:a0") is True
    assert _is_valid_collab_position_id("p2:a0") is False
    assert _is_valid_collab_position_id("p1:not:a-key") is False
    assert _is_valid_collab_position_id("p1:a0" + ("1" * 1024)) is False


def test_table_changes_to_apply_ops_groups_cells_and_filters_owned_fields():
    assert CollabService.table_changes_to_apply_ops(
        [
            {"record_id": "rec-1", "field_id_hex": "fld_a", "value": "A", "after_record_id": "anchor-1"},
            {"record_id": "rec-1", "field_id_hex": "fld_b", "value": "B"},
            {"record_id": "rec-2", "field_id_hex": "fld_a", "value": "C"},
            {"record_id": "rec-3", "type": "delete"},
        ],
        owned_fields=["fld_a"],
    ) == [
        {"op": "map.delete", "path": ["records"], "key": "rec-3"},
        {"op": "map.delete", "path": ["rowOrderMap"], "key": "rec-3"},
        {
            "op": "map.patch",
            "path": ["records", "rec-1"],
            "values": {"fld_a": "A"},
        },
        {
            "op": "order.after",
            "path": ["rowOrderMap"],
            "key": "rec-1",
            "after_key": "anchor-1",
        },
        {
            "op": "map.patch",
            "path": ["records", "rec-2"],
            "values": {"fld_a": "C"},
        },
    ]


def test_upsert_record_prefers_order_after_over_order_set():
    """#5897：upsert_record 带 after_record_id 时走 order.after，不再 order.set 数字。"""
    assert CollabService.table_changes_to_apply_ops(
        [
            {
                "record_id": "new-1",
                "type": "upsert_record",
                "fields": {"fld_a": "hello"},
                "order": 999.0,
                "after_record_id": "existing-tail",
            },
            {
                "record_id": "new-2",
                "type": "upsert_record",
                "fields": {"fld_a": "world"},
                "order": 1000.0,
                "after_record_id": None,
            },
        ],
    ) == [
        {
            "op": "map.patch",
            "path": ["records", "new-1"],
            "values": {"fld_a": "hello"},
        },
        {
            "op": "order.after",
            "path": ["rowOrderMap"],
            "key": "new-1",
            "after_key": "existing-tail",
        },
        {
            "op": "map.patch",
            "path": ["records", "new-2"],
            "values": {"fld_a": "world"},
        },
        {
            "op": "order.after",
            "path": ["rowOrderMap"],
            "key": "new-2",
            "after_key": None,
        },
    ]


def test_upsert_record_with_no_cells_still_creates_record_shell_before_ordering():
    assert CollabService.table_changes_to_apply_ops(
        [
            {
                "record_id": "restored-empty",
                "type": "upsert_record",
                "fields": {},
                "order": 999.0,
                "after_record_id": "existing-tail",
            },
        ],
    ) == [
        {
            "op": "map.patch",
            "path": ["records", "restored-empty"],
            "values": {},
        },
        {
            "op": "order.after",
            "path": ["rowOrderMap"],
            "key": "restored-empty",
            "after_key": "existing-tail",
        },
    ]


def test_upsert_record_falls_back_to_order_set_without_after_key():
    assert CollabService.table_changes_to_apply_ops(
        [
            {
                "record_id": "legacy-1",
                "type": "upsert_record",
                "fields": {"fld_a": "x"},
                "order": 3.0,
            },
        ],
    ) == [
        {
            "op": "map.patch",
            "path": ["records", "legacy-1"],
            "values": {"fld_a": "x"},
        },
        {
            "op": "order.set",
            "path": ["rowOrderMap"],
            "positions": {"legacy-1": 3.0},
        },
    ]


def test_reorder_record_clears_position_id_and_projects_legacy_order_atomically():
    assert CollabService.table_changes_to_apply_ops(
        [
            {
                "record_id": "moved-1",
                "type": "reorder_record",
                "order": 2500.0,
                "after_record_id": "anchor-1",
            },
            {
                "record_id": "moved-2",
                "type": "reorder_record",
                "order": 2600.0,
                "after_record_id": "moved-1",
            },
        ],
        owned_fields=["fld_a"],
    ) == [
        {
            "op": "map.patch",
            "path": ["records", "moved-1"],
            "values": {"__position_id": None, "__order": 2500.0},
        },
        {
            "op": "order.after",
            "path": ["rowOrderMap"],
            "key": "moved-1",
            "after_key": "anchor-1",
        },
        {
            "op": "map.patch",
            "path": ["records", "moved-2"],
            "values": {"__position_id": None, "__order": 2600.0},
        },
        {
            "op": "order.after",
            "path": ["rowOrderMap"],
            "key": "moved-2",
            "after_key": "moved-1",
        },
    ]


def test_rebalance_record_order_only_invalidates_stale_position_id():
    assert CollabService.table_changes_to_apply_ops(
        [
            {
                "record_id": "rebased-1",
                "type": "rebalance_record_order",
                "order": 1000.0,
            },
        ],
        owned_fields=[],
    ) == [
        {
            "op": "map.patch",
            "path": ["records", "rebased-1"],
            "values": {"__position_id": None, "__order": 1000.0},
        },
    ]


def test_apply_ops_posts_to_unified_collab_live_command_endpoint():
    with (
        patch("apps.collab.apply_ops.assert_collab_action_allowed"),
        patch("apps.services.common.live_api.call_live_api_safe") as mock_call,
    ):
        mock_call.return_value = {"status": "error", "code": "collab_apply_ops_failed"}

        result = CollabService.apply_ops(
            module="table",
            document_name="table:example",
            op_id="op-1",
            ops=[{"op": "map.patch", "path": ["records", "r1"], "values": {"f1": "v1"}}],
        )

    assert result == {"status": "error", "code": "collab_apply_ops_failed"}
    mock_call.assert_called_once_with(
        "/collab/apply-ops",
        {
            "resource_type": "table",
            "document_name": "table:example",
            "op_id": "op-1",
            "ops": [{"op": "map.patch", "path": ["records", "r1"], "values": {"f1": "v1"}}],
        },
        timeout=10,
        max_retries=0,
        source="apply_ops:table:table:example",
    )


def test_apply_table_ops_builds_table_document_name():
    table_id = UUID("11111111-1111-1111-1111-111111111111")
    with patch.object(CollabService, "apply_ops") as mock_apply:
        mock_apply.return_value = {"status": "ok"}

        result = CollabService.apply_table_ops(
            table_id=table_id,
            op_id="op-1",
            ops=[{"op": "map.delete", "path": ["records"], "key": "rec-1"}],
        )

    assert result == {"status": "ok"}
    mock_apply.assert_called_once_with(
        module="table",
        document_name=f"table:{table_id}",
        op_id="op-1",
        ops=[{"op": "map.delete", "path": ["records"], "key": "rec-1"}],
        timeout=10,
        origin_id="",
        editor_type="",
        editor_id="",
        editor_name="",
        agent_run_id="",
        system_policy="",
        require_store_success=False,
        record_lifecycle_revalidation_ids=None,
    )


def test_apply_ops_forwards_strict_store_and_record_lifecycle_revalidation_options():
    record_id = "22222222-2222-2222-2222-222222222222"
    with (
        patch("apps.collab.apply_ops.assert_collab_action_allowed"),
        patch("apps.services.common.live_api.call_live_api_safe") as mock_call,
    ):
        mock_call.return_value = {"store_completed": True}

        result = CollabService.apply_table_ops(
            table_id=UUID("11111111-1111-1111-1111-111111111111"),
            op_id="repair-1",
            ops=[{"op": "map.set", "path": ["meta"], "key": "probe", "value": "1"}],
            require_store_success=True,
            record_lifecycle_revalidation_ids=[record_id],
            editor_type="system",
            system_policy="trusted_internal",
        )

    assert result == {"store_completed": True}
    assert mock_call.call_args.args[1]["require_store_success"] is True
    assert mock_call.call_args.args[1]["record_lifecycle_revalidation_ids"] == [record_id]

from unittest.mock import patch

from apps.collab.api import collab_apply_ops
from apps.collab.schemas import CollabApplyOpsRequest


def test_collab_apply_ops_rejects_virtual_file_resource():
    status, body = collab_apply_ops(
        None,
        CollabApplyOpsRequest(
            resource_type="file",
            document_name="file:1",
            op_id="op-1",
            ops=[{"type": "noop"}],
        ),
    )

    assert status == 400
    assert body["code"] == "invalid_collab_module"


def test_collab_apply_ops_forwards_valid_command():
    with patch("apps.collab.api.CollabApplyOpsService.apply_ops") as mock_apply:
        mock_apply.return_value = {"status": "ok", "data": {"applied": 1}}

        result = collab_apply_ops(
            None,
            CollabApplyOpsRequest(
                resource_type="table",
                document_name="table:1",
                op_id="op-1",
                ops=[{"op": "map.delete", "path": ["records"], "key": "rec-1"}],
                origin_id="user-1",
                editor_type="user",
                editor_id="user-1",
                editor_name="User",
                agent_run_id="",
                system_policy="",
            ),
        )

    assert result == {"status": "ok", "data": {"applied": 1}}
    mock_apply.assert_called_once_with(
        module="table",
        document_name="table:1",
        op_id="op-1",
        ops=[{"op": "map.delete", "path": ["records"], "key": "rec-1"}],
        origin_id="user-1",
        editor_type="user",
        editor_id="user-1",
        editor_name="User",
        agent_run_id="",
        system_policy="",
    )

from unittest.mock import patch

from apps.collab.apply_ops import CollabApplyOpsService


def test_apply_ops_rejects_invalid_module_without_calling_live_api():
    with patch("apps.services.common.live_api.call_live_api_safe") as mock_call:
        result = CollabApplyOpsService.apply_ops(
            module="file",
            document_name="file:1",
            op_id="op-1",
            ops=[{"op": "noop"}],
        )

    assert result["status"] == "error"
    assert result["code"] == "invalid_collab_module"
    mock_call.assert_not_called()


def test_apply_ops_posts_to_collab_live():
    with patch("apps.services.common.live_api.call_live_api_safe") as mock_call, \
         patch("apps.collab.apply_ops.assert_collab_action_allowed") as mock_auth:
        mock_call.return_value = {"status": "ok"}
        result = CollabApplyOpsService.apply_slide_ops(
            slide_id="slide-1",
            op_id="op-1",
            ops=[{"op": "map.clear", "path": ["records"]}],
            editor_type="system",
            editor_id="system:test",
            system_policy="trusted_internal",
        )

    assert result == {"status": "ok"}
    mock_auth.assert_called_once()
    mock_call.assert_called_once_with(
        "/collab/apply-ops",
        {
            "resource_type": "slide",
            "document_name": "slide:slide-1",
            "op_id": "op-1",
            "ops": [{"op": "map.clear", "path": ["records"]}],
            "editor_type": "system",
            "editor_id": "system:test",
            "system_policy": "trusted_internal",
        },
        timeout=10,
        max_retries=0,
        source="apply_ops:slide:slide:slide-1",
    )


def test_apply_ops_permission_denied_does_not_call_live_api():
    from apps.collab.services.permission import CollabPermissionError

    with patch("apps.services.common.live_api.call_live_api_safe") as mock_call, \
         patch("apps.collab.apply_ops.assert_collab_action_allowed") as mock_auth:
        mock_auth.side_effect = CollabPermissionError("collab_permission_denied", "auth.permission_denied")

        result = CollabApplyOpsService.apply_docs_ops(
            document_id="doc-1",
            op_id="op-1",
            ops=[{"op": "map.clear", "path": ["records"]}],
            editor_type="user",
            editor_id="viewer-1",
        )

    assert result["status"] == "error"
    assert result["code"] == "collab_permission_denied"
    mock_call.assert_not_called()

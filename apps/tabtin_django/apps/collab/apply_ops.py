"""Y.Doc-first command client for collab-live.

This module is the backend-side boundary for collab-mode writes. It never
falls back to legacy WS/HTTP delta behavior by itself; callers must switch the
whole resource to legacy mode before using legacy writers.
"""

from typing import Any, Dict, List

from apps.collab.constants import ADAPTER_RESOURCE_TYPES
from apps.collab.services.permission import (
    CollabPermissionError,
    error_response_from_exception,
    parse_collab_document_name,
    assert_collab_action_allowed,
)


class CollabApplyOpsService:
    """Call collab-live `/collab/apply-ops` for Y.Doc-first writes."""

    @staticmethod
    def apply_ops(
        *,
        module: str,
        document_name: str,
        op_id: str,
        ops: List[Dict[str, Any]],
        timeout: int = 10,
        origin_id: str = "",
        editor_type: str = "",
        editor_id: str = "",
        editor_name: str = "",
        agent_run_id: str = "",
        system_policy: str = "",
        require_store_success: bool = False,
        record_lifecycle_revalidation_ids: List[str] | None = None,
    ) -> dict:
        if module not in ADAPTER_RESOURCE_TYPES:
            return {
                "status": "error",
                "code": "invalid_collab_module",
                "message": f"module must be one of {','.join(ADAPTER_RESOURCE_TYPES)}",
            }
        if editor_type == "agent" and not agent_run_id:
            try:
                from apps.services.common.platform_context import get_current_run_id
                agent_run_id = get_current_run_id() or ""
            except Exception:
                agent_run_id = ""
        try:
            resource_id = parse_collab_document_name(module, document_name)
            assert_collab_action_allowed(
                resource_type=module,
                resource_id=resource_id,
                action="edit",
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
                system_policy=system_policy,
            )
        except CollabPermissionError as exc:
            _status, body = error_response_from_exception(exc)
            return body

        from apps.services.common.live_api import call_live_api_safe

        body = {
            "resource_type": module,
            "document_name": document_name,
            "op_id": op_id,
            "ops": ops,
        }
        if origin_id:
            body["origin_id"] = origin_id
        if editor_type:
            body["editor_type"] = editor_type
        if editor_id:
            body["editor_id"] = editor_id
        if editor_name:
            body["editor_name"] = editor_name
        if agent_run_id:
            body["agent_run_id"] = agent_run_id
        if system_policy:
            body["system_policy"] = system_policy
        if require_store_success:
            body["require_store_success"] = True
        if record_lifecycle_revalidation_ids is not None:
            body["record_lifecycle_revalidation_ids"] = record_lifecycle_revalidation_ids
        return call_live_api_safe(
            "/collab/apply-ops",
            body,
            timeout=timeout,
            max_retries=0,
            source=f"apply_ops:{module}:{document_name}",
        )

    @staticmethod
    def apply_table_ops(
        *,
        table_id: str,
        op_id: str,
        ops: List[Dict[str, Any]],
        timeout: int = 10,
        origin_id: str = "",
        editor_type: str = "",
        editor_id: str = "",
        editor_name: str = "",
        agent_run_id: str = "",
        system_policy: str = "",
        require_store_success: bool = False,
        record_lifecycle_revalidation_ids: List[str] | None = None,
    ) -> dict:
        return CollabApplyOpsService.apply_ops(
            module="table",
            document_name=f"table:{table_id}",
            op_id=op_id,
            ops=ops,
            timeout=timeout,
            origin_id=origin_id,
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            system_policy=system_policy,
            require_store_success=require_store_success,
            record_lifecycle_revalidation_ids=record_lifecycle_revalidation_ids,
        )

    @staticmethod
    def apply_docs_ops(
        *,
        document_id: str,
        op_id: str,
        ops: List[Dict[str, Any]],
        timeout: int = 10,
        editor_type: str = "",
        editor_id: str = "",
        editor_name: str = "",
        agent_run_id: str = "",
        system_policy: str = "",
    ) -> dict:
        return CollabApplyOpsService.apply_ops(
            module="docs",
            document_name=f"docs:{document_id}",
            op_id=op_id,
            ops=ops,
            timeout=timeout,
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            system_policy=system_policy,
        )

    @staticmethod
    def apply_slide_ops(
        *,
        slide_id: str,
        op_id: str,
        ops: List[Dict[str, Any]],
        timeout: int = 10,
        editor_type: str = "",
        editor_id: str = "",
        editor_name: str = "",
        agent_run_id: str = "",
        system_policy: str = "",
    ) -> dict:
        return CollabApplyOpsService.apply_ops(
            module="slide",
            document_name=f"slide:{slide_id}",
            op_id=op_id,
            ops=ops,
            timeout=timeout,
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            system_policy=system_policy,
        )

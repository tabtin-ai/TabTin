"""
Table Event Service

表格变更事件发布：
  - 主链路：collab-live stateless broadcast（Y.js 协作实例通知）
  - 旧链路（已废弃）：WS Gateway 事件（table.events.delta/field/view）

Y.js 协作已成为 TabData 默认链路。WS Gateway 事件仅保留向后兼容，
将在后续版本中移除。
"""

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional, List

from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

_WS_PAYLOAD_SIZE_LIMIT = 512_000

_ACTION_EVENT_MAP = {
    "create_record": "INSERT",
    "update_record": "UPDATE",
    "delete_record": "DELETE",
    "records_updated": "UPDATE",
    "bulk_create": "INSERT",
    "bulk_update": "UPDATE",
    "bulk_delete": "DELETE",
}


def _action_to_event(action: str) -> str:
    """Map internal action name to Open API event type."""
    return _ACTION_EVENT_MAP.get(action, "UPDATE")


class TableEventService:
    """
    表格事件发布服务

    主链路：collab-live stateless broadcast（Y.js 协作实例）
    旧链路：WS Gateway 事件（已废弃，保留向后兼容）
    """

    _live_unavailable_logged: bool = False

    # ================================================================
    # 记录变更事件（table.events.delta）
    # @deprecated — Y.js 协作链路自动同步记录数据，此方法保留向后兼容
    # ================================================================

    def publish_table_update(
        self,
        table_id: str,
        *,
        record_ids: Optional[List[str]] = None,
        action: str = "records_updated",
        metadata: Optional[Dict[str, Any]] = None,
        records: Optional[List[Dict[str, Any]]] = None,
        latest_version: Optional[int] = None,
    ) -> bool:
        """
        发布表格记录数据变更事件。

        Args:
            table_id: 表格 ID
            record_ids: 变更的记录 ID 列表
            action: 动作类型（create_record / update_record / delete_record 等）
            metadata: 附加元数据
            records: 已序列化的记录数据列表（可选；携带后前端可直接合并）
            latest_version: 变更后的最新版本号（可选）

        Returns:
            bool: 是否成功发布到 WS channel layer
        """
        _meta = metadata or {}
        rls_affected = _meta.get("rls_affected", False)

        if rls_affected:
            ws_payload: Dict[str, Any] = {
                "table_id": table_id,
                "action": action,
                "metadata": _meta,
                "rls_affected": True,
            }
            event_id = new_event_id()
            envelope = build_envelope(
                "table.events.delta",
                event_id,
                ws_payload,
                event_id=event_id,
                table_id=table_id,
            )
            result = publish_ws_event(f"table.events.{table_id}", envelope)

            open_envelope = build_envelope(
                "table.open.record_change",
                event_id,
                {
                    "table_id": table_id,
                    "event": _action_to_event(action),
                    "rls_affected": True,
                    "timestamp": _meta.get("timestamp"),
                },
                event_id=event_id,
                table_id=table_id,
            )
            publish_ws_event(f"table.open.{table_id}", open_envelope)

            return result

        ws_payload: Dict[str, Any] = {
            "table_id": table_id,
            "record_ids": record_ids or [],
            "action": action,
            "metadata": _meta,
        }

        inline_records: Optional[List[Dict[str, Any]]] = None
        if records is not None:
            try:
                records_json = json.dumps(records, ensure_ascii=False)
                if len(records_json.encode("utf-8")) <= _WS_PAYLOAD_SIZE_LIMIT:
                    inline_records = records
                else:
                    logger.info(
                        "[TableEventService] 增量数据 %d 字节超限，降级为纯通知",
                        len(records_json.encode("utf-8")),
                    )
            except (TypeError, ValueError):
                logger.warning("[TableEventService] 序列化增量记录失败，降级为纯通知")

        if inline_records is not None:
            ws_payload["records"] = inline_records
            ws_payload["delta"] = True
        if latest_version is not None:
            ws_payload["latest_version"] = latest_version

        event_id = new_event_id()
        envelope = build_envelope(
            "table.events.delta",
            event_id,
            ws_payload,
            event_id=event_id,
            table_id=table_id,
        )
        result = publish_ws_event(f"table.events.{table_id}", envelope)

        open_envelope = build_envelope(
            "table.open.record_change",
            event_id,
            {
                "table_id": table_id,
                "event": _action_to_event(action),
                "record_ids": record_ids or [],
                "records": inline_records,
                "timestamp": _meta.get("timestamp"),
            },
            event_id=event_id,
            table_id=table_id,
        )
        publish_ws_event(f"table.open.{table_id}", open_envelope)

        return result

    # ================================================================
    # 字段结构变更事件（table.events.field）
    # ================================================================

    def publish_field_change(
        self,
        table_id: str,
        *,
        action: str,
        field_ids: Optional[List[str]] = None,
        fields: Optional[List[Dict[str, Any]]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        发布字段结构变更事件。

        Args:
            table_id: 表格 ID
            action: 变更类型 — create_field / update_field / delete_field / reorder_fields / batch_create_fields
            field_ids: 变更的字段 ID 列表
            fields: 字段快照数据列表（可选；创建/更新时携带方便前端直接合并）
            metadata: 附加元数据

        Returns:
            bool: 是否成功发布
        """
        ws_payload: Dict[str, Any] = {
            "table_id": table_id,
            "action": action,
            "field_ids": field_ids or [],
            "metadata": metadata or {},
        }
        if fields is not None:
            ws_payload["fields"] = fields

        event_id = new_event_id()
        envelope = build_envelope(
            "table.events.field",
            event_id,
            ws_payload,
            event_id=event_id,
            table_id=table_id,
        )
        result = publish_ws_event(f"table.events.{table_id}", envelope)

        # Open API Realtime: field schema changes
        open_envelope = build_envelope(
            "table.open.schema_change",
            event_id,
            {"table_id": table_id, "event": "SCHEMA", "action": action, "field_ids": field_ids or []},
            event_id=event_id,
            table_id=table_id,
        )
        publish_ws_event(f"table.open.{table_id}", open_envelope)

        self._broadcast_to_live(
            document_name=f"table:{table_id}",
            event="table.schema.changed",
            payload=ws_payload,
        )

        return result

    # ================================================================
    # 视图变更事件（table.events.view）
    # ================================================================

    def publish_view_change(
        self,
        table_id: str,
        *,
        action: str,
        view_id: str,
        view: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        发布视图变更事件。

        Args:
            table_id: 表格 ID
            action: 变更类型 — create_view / update_view / delete_view / set_default_view
            view_id: 视图 ID
            view: 视图快照数据（可选；创建/更新时携带方便前端直接合并）
            metadata: 附加元数据

        Returns:
            bool: 是否成功发布
        """
        ws_payload: Dict[str, Any] = {
            "table_id": table_id,
            "action": action,
            "view_id": view_id,
            "metadata": metadata or {},
        }
        if view is not None:
            ws_payload["view"] = view

        event_id = new_event_id()
        envelope = build_envelope(
            "table.events.view",
            event_id,
            ws_payload,
            event_id=event_id,
            table_id=table_id,
        )
        result = publish_ws_event(f"table.events.{table_id}", envelope)

        self._broadcast_to_live(
            document_name=f"table:{table_id}",
            event="table.view.changed",
            payload=ws_payload,
        )

        return result

    def publish_comment_change(self, table_id: str) -> None:
        """广播评论集合失效；RLS 表严格禁发，避免泄露隐藏行活动频率。"""
        normalized_table_id = str(table_id)
        try:
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import Table

            table = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id=normalized_table_id)
                .only("rls_enabled")
                .first()
            )
        except Exception:
            logger.warning(
                "comment invalidation RLS guard failed; suppressing event table_id=%s",
                normalized_table_id,
                exc_info=True,
            )
            return
        if table is None or table.rls_enabled:
            return
        self._broadcast_to_live(
            document_name=f"table:{normalized_table_id}",
            event="table.comment.changed",
            payload={"table_id": normalized_table_id},
        )


    # ================================================================
    # collab-live stateless broadcast（Y.js 协作实例通知）
    # ================================================================

    @staticmethod
    def _broadcast_to_live(
        document_name: str,
        event: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        通过 collab-live /internal/stateless-broadcast 广播 stateless 事件。

        非阻断：调用失败仅记录日志，不影响主流程。
        高频调用场景，连接不可用时自动降级日志级别避免刷屏。
        """
        from apps.services.common.live_api import call_live_api_safe

        result = call_live_api_safe(
            "/internal/stateless-broadcast",
            {
                "document_name": document_name,
                "event": event,
                "source": "django",
                "op_id": str(uuid.uuid4()),
                "ts": datetime.utcnow().isoformat() + "Z",
                "payload": payload or {},
            },
            timeout=5,
            max_retries=0,
            source=f"table_broadcast:{document_name}",
            quiet=True,
        )

        if "error" in result:
            err_msg = result["error"]
            if "服务不可用" in err_msg:
                if not TableEventService._live_unavailable_logged:
                    logger.warning(
                        "[TableEventService] stateless-broadcast 不可用，"
                        "后续同类错误降级为 debug: %s",
                        err_msg,
                    )
                    TableEventService._live_unavailable_logged = True
                else:
                    logger.debug(
                        "[TableEventService] stateless-broadcast 不可用: %s",
                        err_msg,
                    )
        else:
            TableEventService._live_unavailable_logged = False


table_event_service = TableEventService()

__all__ = ["TableEventService", "table_event_service"]

"""
TabDoc Event Service

通过 WS Gateway 发布文档相关事件。
事件类型:
  - doc.events.save     — 文档保存完成（编辑者信息、版本号）
  - doc.events.editor   — 编辑者变更（Agent 开始/停止编辑）
  - doc.events.version  — 新版本历史创建
  - doc.events.comment  — 评论创建/删除（Electron / org 成员）
  - share.events.comment — 同上，fan-out 到可评论分享链（分享页）
"""

import logging
from typing import Any, Dict, Optional

from django.db.models import Q
from django.utils import timezone

from apps.services.common.ws.bus import publish_ws_event_reliable
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger("tabdoc.events")

COMMENT_ACTIONS = frozenset({"created", "deleted"})
COMMENT_THREAD_ACTIONS = frozenset({"created", "status_changed", "anchor_changed", "deleted"})
COMMENT_MESSAGE_ACTIONS = frozenset({"created", "deleted"})


class DocEventService:
    """文档事件发布服务（WS Gateway 封装）"""

    def publish_save(
        self,
        document_id: str,
        *,
        editor_type: str = "",
        editor_id: str = "",
        latest_version: int = 0,
        metadata: Optional[Dict[str, Any]] = None,
        document: Optional[Any] = None,
    ) -> bool:
        """
        发布文档保存完成事件。

        前端收到后更新文档状态（如"已保存"指示器）。
        """
        ws_payload: Dict[str, Any] = {
            "document_id": document_id,
            "editor_type": editor_type,
            "editor_id": editor_id,
            "latest_version": latest_version,
            "metadata": metadata or {},
        }
        # : 前端 metadata PATCH 用 base_updated_at 做二级 CAS；
        # 若 save 事件只推版本、不推 updated_at，客户端会带着过期 updated_at
        # 打出「当前版本 N，提交版本 N」的伪冲突。
        if document is not None:
            updated_at = getattr(document, "updated_at", None)
            if updated_at is not None:
                try:
                    ws_payload["updated_at"] = updated_at.isoformat()
                except AttributeError:
                    ws_payload["updated_at"] = str(updated_at)

        event_id = new_event_id()
        envelope = build_envelope(
            "doc.events.save",
            event_id,
            ws_payload,
            event_id=event_id,
        )
        # INT-34: 传入 document 避免 _bridge_to_event_bus 重复查询 DB
        self._bridge_to_event_bus(
            document_id, "tabdoc.content.saved",
            document=document,
            editor_type=editor_type, editor_id=editor_id,
            latest_version=latest_version,
        )

        try:
            publish_ws_event_reliable(f"doc.events.{document_id}", envelope)
            return True
        except Exception:
            logger.warning(
                "[DocEventService] WS 推送失败但 EventBus 已触发（降级模式）: doc=%s",
                document_id, exc_info=True,
            )
            return False

    def publish_editor_change(
        self,
        document_id: str,
        *,
        editor_type: str = "",
        editor_id: str = "",
        action: str = "start",  # "start" / "stop"
        editor_name: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        document: Optional[Any] = None,
    ) -> bool:
        """
        发布编辑者变更事件。

        前端收到后显示 "Agent 正在编辑..." 或 "某某正在编辑..."。
        """
        ws_payload: Dict[str, Any] = {
            "document_id": document_id,
            "editor_type": editor_type,
            "editor_id": editor_id,
            "editor_name": editor_name,
            "action": action,
            "metadata": metadata or {},
        }

        event_id = new_event_id()
        envelope = build_envelope(
            "doc.events.editor",
            event_id,
            ws_payload,
            event_id=event_id,
        )
        self._bridge_to_event_bus(
            document_id, "tabdoc.editor.changed",
            document=document,
            editor_type=editor_type, editor_id=editor_id,
            action=action,
        )
        # INT-32: 统一使用 reliable 发布，与 publish_save/publish_version_created 一致
        try:
            publish_ws_event_reliable(f"doc.events.{document_id}", envelope)
            return True
        except Exception:
            logger.error(
                "[DocEventService] publish_editor_change failed for doc=%s",
                document_id, exc_info=True,
            )
            return False

    def publish_version_created(
        self,
        document_id: str,
        *,
        history_id: str = "",
        is_snapshot: bool = True,
        editor_type: str = "",
        editor_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        document: Optional[Any] = None,
    ) -> bool:
        """
        发布新版本历史创建事件。

        前端收到后可刷新版本历史列表。
        """
        ws_payload: Dict[str, Any] = {
            "document_id": document_id,
            "history_id": history_id,
            "is_snapshot": is_snapshot,
            "editor_type": editor_type,
            "editor_id": editor_id,
            "metadata": metadata or {},
        }

        event_id = new_event_id()
        envelope = build_envelope(
            "doc.events.version",
            event_id,
            ws_payload,
            event_id=event_id,
        )
        self._bridge_to_event_bus(
            document_id, "tabdoc.version.created",
            document=document,
            editor_type=editor_type, editor_id=editor_id,
            history_id=history_id,
        )
        try:
            publish_ws_event_reliable(f"doc.events.{document_id}", envelope)
            return True
        except Exception:
            logger.error(
                "[DocEventService] publish_version_created failed for doc=%s",
                document_id, exc_info=True,
            )
            return False

    def publish_comment_created(
        self,
        document_id: str,
        *,
        comment_id: str,
        comment_author_id: str = "",
        mention_user_ids: Optional[list[str]] = None,
        share_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        document: Optional[Any] = None,
    ) -> bool:
        """兼容入口：发布评论创建事件。"""
        return self.publish_comment_change(
            document_id,
            action="created",
            comment_id=comment_id,
            comment_author_id=comment_author_id,
            mention_user_ids=mention_user_ids,
            share_id=share_id,
            metadata=metadata,
            document=document,
        )

    def publish_comment_change(
        self,
        document_id: str,
        *,
        action: str,
        comment_id: str,
        comment_author_id: str = "",
        mention_user_ids: Optional[list[str]] = None,
        share_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        document: Optional[Any] = None,
    ) -> bool:
        """发布评论变更到 ``doc.events``，并 fan-out 到可评论的 ``share.events``。"""
        normalized_action = (action or "created").strip().lower()
        if normalized_action not in COMMENT_ACTIONS:
            normalized_action = "created"

        mentions = list(mention_user_ids or [])
        ws_payload: Dict[str, Any] = {
            "document_id": document_id,
            "comment_id": comment_id,
            "comment_author_id": comment_author_id,
            "mention_user_ids": mentions,
            "action": normalized_action,
            "metadata": metadata or {},
        }
        if share_id:
            ws_payload["share_id"] = share_id

        if normalized_action == "created":
            self._bridge_to_event_bus(
                document_id,
                "tabdoc.document.commented",
                document=document,
                doc_id=document_id,
                comment_id=comment_id,
                comment_author_id=comment_author_id,
                mention_user_ids=mentions,
            )

        ok = True
        try:
            event_id = new_event_id()
            envelope = build_envelope(
                "doc.events.comment",
                event_id,
                ws_payload,
                event_id=event_id,
            )
            publish_ws_event_reliable(f"doc.events.{document_id}", envelope)
        except Exception:
            ok = False
            logger.error(
                "[DocEventService] publish_comment_change doc.events failed for doc=%s comment=%s action=%s",
                document_id, comment_id, normalized_action, exc_info=True,
            )

        for target_share_id in self._list_commentable_share_ids(document_id):
            share_payload = dict(ws_payload)
            share_payload["share_id"] = target_share_id
            try:
                share_event_id = new_event_id()
                share_envelope = build_envelope(
                    "share.events.comment",
                    share_event_id,
                    share_payload,
                    event_id=share_event_id,
                )
                publish_ws_event_reliable(f"share.events.{target_share_id}", share_envelope)
            except Exception:
                ok = False
                logger.error(
                    "[DocEventService] publish_comment_change share.events failed for share=%s comment=%s",
                    target_share_id, comment_id, exc_info=True,
                )

        return ok

    def publish_comment_thread_change(
        self,
        document_id: str,
        *,
        action: str,
        thread_id: str,
        actor_id: str = "",
        status: str = "",
        scope: str = "",
        anchor_status: str = "",
    ) -> bool:
        normalized_action = (action or "created").strip().lower()
        if normalized_action not in COMMENT_THREAD_ACTIONS:
            normalized_action = "created"
        return self._publish_comment_domain_change(
            document_id,
            entity="thread",
            action=normalized_action,
            payload={
                "thread_id": thread_id,
                "actor_id": actor_id,
                "status": status,
                "scope": scope,
                "anchor_status": anchor_status,
            },
        )

    def publish_comment_message_change(
        self,
        document_id: str,
        *,
        action: str,
        thread_id: str,
        message_id: str,
        actor_id: str = "",
        message_kind: str = "",
    ) -> bool:
        normalized_action = (action or "created").strip().lower()
        if normalized_action not in COMMENT_MESSAGE_ACTIONS:
            normalized_action = "created"
        return self._publish_comment_domain_change(
            document_id,
            entity="message",
            action=normalized_action,
            payload={
                "thread_id": thread_id,
                "message_id": message_id,
                "actor_id": actor_id,
                "message_kind": message_kind,
            },
        )

    def _publish_comment_domain_change(
        self,
        document_id: str,
        *,
        entity: str,
        action: str,
        payload: Dict[str, Any],
    ) -> bool:
        event_payload = {
            "document_id": document_id,
            "action": action,
            **payload,
        }
        ok = True
        try:
            event_id = new_event_id()
            envelope = build_envelope(
                f"doc.events.comment_{entity}",
                event_id,
                event_payload,
                event_id=event_id,
            )
            publish_ws_event_reliable(f"doc.events.{document_id}", envelope)
        except Exception:
            ok = False
            logger.error(
                "[DocEventService] comment %s event failed: doc=%s action=%s",
                entity, document_id, action, exc_info=True,
            )

        for share_id in self._list_commentable_share_ids(document_id):
            share_payload = {**event_payload, "share_id": share_id}
            try:
                event_id = new_event_id()
                envelope = build_envelope(
                    f"share.events.comment_{entity}",
                    event_id,
                    share_payload,
                    event_id=event_id,
                )
                publish_ws_event_reliable(f"share.events.{share_id}", envelope)
            except Exception:
                ok = False
                logger.error(
                    "[DocEventService] share comment %s event failed: share=%s action=%s",
                    entity, share_id, action, exc_info=True,
                )
        return ok

    @staticmethod
    def _list_commentable_share_ids(document_id: str) -> list[str]:
        """文档下仍有效、且允许评论的分享短链 ID。"""
        try:
            from apps.tabdoc.models import DocumentShare
            from apps.tabdoc.services.share_service import SHARE_COMMENTABLE_PERMISSIONS, TABDOC_DB

            now = timezone.now()
            rows = (
                DocumentShare.objects.using(TABDOC_DB)
                .filter(
                    document_id=document_id,
                    is_active=True,
                    permission__in=sorted(SHARE_COMMENTABLE_PERMISSIONS),
                )
                .filter(Q(expire_at__isnull=True) | Q(expire_at__gt=now))
                .values_list("share_id", flat=True)
            )
            return [str(share_id) for share_id in rows if share_id]
        except Exception:
            logger.warning(
                "[DocEventService] list commentable shares failed for doc=%s",
                document_id, exc_info=True,
            )
            return []

    def _bridge_to_event_bus(
        self,
        document_id: str,
        event_type: str,
        *,
        document: Optional[Any] = None,
        **extra,
    ) -> None:
        """将文档内容级事件桥接到 EventBus，供 TabAgenda Goal 等自动化消费。

        INT-34: 接受可选 document 参数，调用方已持有完整对象时直接使用，
        避免每次保存多 1 次 DB 查询。
        """
        try:
            doc = document
            if doc is None:
                from apps.tabdoc.models import Document
                doc = Document.objects.only(
                    "id", "title", "organization_id", "space_id",
                ).get(id=document_id)
            organization_id = str(doc.organization_id)
            space_id = str(doc.space_id) if doc.space_id else None
            title = doc.title or ""
        except Exception:
            logger.error(
                "[DocEventService] bridge lookup failed for doc=%s",
                document_id, exc_info=True,
            )
            return

        try:
            from apps.extensions.event_bus import Event, EventBus

            event = Event(
                source="tabdoc",
                event_type=event_type,
                organization_id=organization_id,
                space_id=space_id,
                payload={
                    "resource_id": document_id,
                    "resource_type": "tabdoc",
                    "title": title,
                    "action": event_type.rsplit(".", 1)[-1],
                    **extra,
                },
            )
            EventBus.emit(event)
        except Exception as exc:
            logger.warning("[DocEventService] EventBus emit failed: %s", exc)


doc_event_service = DocEventService()

__all__ = ["DocEventService", "doc_event_service"]

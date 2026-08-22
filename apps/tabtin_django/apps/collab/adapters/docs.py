from django.conf import settings
"""
TabDoc Collab Adapter

TabDoc 的数据格式特殊：description_binary 是 Y.js CRDT 二进制（非 JSON）。
版本快照直接存压缩后的 Y.js binary 或 JSON snapshot（兼容旧数据）。
diff 计算通过 collab-live 的 /yjs/compute-diff 端点完成。
"""
import base64
import binascii
import json
import logging
import zlib
from typing import Any, Optional

from .base import CollabAdapter

logger = logging.getLogger("collab.adapters.docs")

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')


def unwrap_binary_snapshot(data: bytes | memoryview) -> tuple[bytes, bool]:
    """
    归一化历史上误塞进 binary 字段的 wrapper。

    TabDoc 的运行时契约是 description_binary 存原始 Y.js update bytes。
    版本历史曾出现 {"format": "binary_snapshot", "binary_b64": "..."} 这种
    JSON wrapper 被当作 bytes 写回当前文档；读取端必须先解包，不能把 JSON
    文本交给 Y.applyUpdate。
    """
    raw = bytes(data)
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return raw, False

    if not isinstance(parsed, dict) or parsed.get("format") != "binary_snapshot":
        return raw, False

    encoded = parsed.get("binary_b64")
    if not isinstance(encoded, str) or not encoded.strip():
        raise ValueError("binary_snapshot missing binary_b64")

    try:
        return base64.b64decode(encoded, validate=True), True
    except (binascii.Error, ValueError) as exc:
        raise ValueError("binary_snapshot contains invalid binary_b64") from exc


class DocsCollabAdapter(CollabAdapter):
    resource_type = "docs"

    # ── 版本历史：序列化 ─────────────────────────────

    def serialize_snapshot(self, data: Any) -> bytes:
        """
        将文档数据序列化为压缩 blob。

        data 可以是：
        - bytes: Y.js binary（直接 zlib 压缩）
        - dict: JSON snapshot（{"format": "json_snapshot", ...}）
        """
        if isinstance(data, (bytes, memoryview)):
            raw = bytes(data)
        elif isinstance(data, dict):
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        else:
            raw = str(data).encode("utf-8")
        return zlib.compress(raw, level=6)

    def deserialize_snapshot(self, blob: bytes) -> Optional[Any]:
        """
        反序列化压缩 blob。

        返回：
        - bytes: Y.js binary
        - dict: JSON snapshot（旧格式）
        """
        try:
            raw = blob if isinstance(blob, bytes) else bytes(blob)
            decompressed = zlib.decompress(raw)
            try:
                parsed = json.loads(decompressed.decode("utf-8"))
                if isinstance(parsed, dict) and parsed.get("format") == "json_snapshot":
                    return parsed
                if isinstance(parsed, dict) and parsed.get("format") == "binary_snapshot":
                    return unwrap_binary_snapshot(decompressed)[0]
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
            return unwrap_binary_snapshot(decompressed)[0]
        except Exception as e:
            logger.error("Failed to deserialize docs snapshot: %s", e)
            return None

    # ── 版本历史：增量 diff ──────────────────────────

    def compute_diff(self, base_data: Any, current_data: Any) -> Optional[bytes]:
        """
        计算 Y.js binary diff。

        通过 collab-live 的 /yjs/compute-diff 端点完成。
        如果任一端不是 Y.js binary，返回 None（强制全量快照）。

        DV-001: API 失败时抛异常（由调用方决定 fallback 策略），不再静默返回 None。
        DV-004: max_retries=0 避免后台任务阻塞 Celery Worker。
        """
        if not isinstance(base_data, bytes) or not isinstance(current_data, bytes):
            return None

        from apps.services.common.live_api import call_live_api

        old_b64 = base64.b64encode(base_data).decode()
        new_b64 = base64.b64encode(current_data).decode()

        result = call_live_api("/yjs/compute-diff", {
            "old_binary_b64": old_b64,
            "new_binary_b64": new_b64,
        }, max_retries=0, timeout=5)

        diff_b64 = result.get("diff_b64", "")
        if not diff_b64:
            return None

        diff_bytes = base64.b64decode(diff_b64)
        if len(diff_bytes) >= len(current_data) * 0.8:
            return None

        return zlib.compress(diff_bytes, level=6)

    def apply_diff(self, base_data: Any, diff_blob: bytes) -> Any:
        """
        应用 Y.js diff，通过 collab-live 的 /yjs/apply-diff 端点。
        """
        if not isinstance(base_data, bytes):
            raise RuntimeError(
                f"apply_diff requires binary base_data, got {type(base_data).__name__}"
            )

        try:
            from apps.services.common.live_api import call_live_api

            raw_diff = zlib.decompress(diff_blob if isinstance(diff_blob, bytes) else bytes(diff_blob))
            base_b64 = base64.b64encode(base_data).decode()
            diff_b64 = base64.b64encode(raw_diff).decode()

            result = call_live_api("/yjs/apply-diff", {
                "base_binary_b64": base_b64,
                "diffs_b64": [diff_b64],
            })

            merged_b64 = result.get("merged_b64", "")
            if not merged_b64:
                # P0-02 fix: 空 merged_b64 表示 diff 未成功应用，抛出异常
                # 让 rebuild_data 走 DIFF_APPLY_FAILED 错误诊断路径，
                # 而非静默返回 base_data 导致恢复到错误的版本
                raise RuntimeError(
                    "collab-live /yjs/apply-diff returned empty merged_b64"
                )
            return base64.b64decode(merged_b64)
        except Exception as e:
            raise RuntimeError(f"Failed to apply Y.js diff: {e}") from e

    # ── 版本历史：元数据 ─────────────────────────────

    def get_content_stats(self, data: Any) -> dict:
        if isinstance(data, bytes):
            return {"binary_size": len(data)}
        if isinstance(data, dict):
            return {"format": data.get("format", "unknown")}
        return {}

    # ── 协作：资源与权限 ─────────────────────────────

    def get_resource(self, resource_id: str) -> Optional[Any]:
        from apps.tabdoc.models import Document

        try:
            return Document.objects.using(DB).get(
                id=resource_id, status="active", trashed_at__isnull=True,
            )
        except Document.DoesNotExist:
            return None

    def get_resource_for_rollback(self, resource_id: str) -> Optional[Any]:
        from apps.tabdoc.models import Document

        try:
            return Document.objects.using(DB).get(id=resource_id)
        except Document.DoesNotExist:
            return None

    def check_permission(self, user, resource: Any, action: str = "edit") -> bool:
        if not user:
            return False
        try:
            from apps.tabdoc.services.document_service import DocumentService

            svc = DocumentService(user=user)
            required_role = "editor" if action == "edit" else "viewer"
            if not svc.check_document_permission(resource, required_role=required_role):
                return False
            if action == "edit":
                svc.assert_document_collab_writable(resource)
            else:
                svc.assert_document_viewable(resource)
            return True
        except (ValueError, PermissionError):
            return False
        except Exception:
            logger.exception("Permission check failed for doc %s", resource.id)
            return False

    # ── 协作：快照与持久化 ────────────────────────────

    def build_snapshot(self, resource: Any) -> dict:
        """
        构造文档快照。

        返回与 TabDoc 的 /documents/{id}/binary 一致的结构。
        """
        binary_data = (
            unwrap_binary_snapshot(resource.description_binary)[0]
            if resource.description_binary
            else b""
        )
        b64_data = base64.b64encode(binary_data).decode() if binary_data else ""
        description_markdown = resource.description_markdown or ""
        if not binary_data:
            from apps.tabdoc.services.document_service import normalize_tabdata_snapshot

            _, description_markdown = normalize_tabdata_snapshot(
                resource.description_json or {},
                description_markdown,
            )

        return {
            "document_id": str(resource.id),
            "binary_b64": b64_data,
            "has_binary": bool(binary_data),
            "latest_version": resource.latest_version,
            "description_markdown": description_markdown,
        }

    def persist_changes(self, resource: Any, changes: dict, editor_info: dict) -> dict:
        """
        处理 collab-live onStore 传入的变更。

        先用短事务 select_for_update 刷新 document 实例，获取最新版本号，
        然后在事务外调用 save_from_hocuspocus（内部自带 select_for_update + CAS）。
        短事务避免持锁期间等待 call_live_api HTTP 调用（CRT-05）。
        changes 结构: { update_blob_b64, description_html?, description_json? }
        """
        from django.db import transaction

        from apps.tabdoc.models import Document
        from apps.tabdoc.services.document_service import DocumentService

        update_b64 = changes.get("update_blob_b64", "")
        if not update_b64:
            return {"skipped": True}

        update_blob = base64.b64decode(update_b64)

        with transaction.atomic(using=DB):
            fresh_doc = (
                Document.objects.using(DB)
                .select_for_update()
                .get(id=resource.id)
            )

        svc = DocumentService(user=None)
        doc_update = svc.save_from_hocuspocus(
            fresh_doc,
            update_blob=update_blob,
            editor_type=editor_info.get("editor_type", "user"),
            editor_id=editor_info.get("editor_id", ""),
            description_html=changes.get("description_html"),
            description_json=changes.get("description_json"),
        )

        return {"doc_update_id": str(doc_update.id) if doc_update else None}

    # ── 恢复 ────────────────────────────────────────

    def get_version_data(self, resource: Any) -> Any:
        """返回 Y.js binary bytes（用于版本存储和恢复）。"""
        if resource.description_binary:
            return unwrap_binary_snapshot(resource.description_binary)[0]
        if resource.description_json or resource.description_markdown:
            from apps.tabdoc.services.document_service import normalize_tabdata_snapshot

            description_json, description_markdown = normalize_tabdata_snapshot(
                resource.description_json or {},
                resource.description_markdown or "",
            )
            return {
                "format": "json_snapshot",
                "title": resource.title,
                "description_json": description_json,
                "description_markdown": description_markdown,
                "description_plaintext": resource.description_plaintext or "",
            }
        return b""

    def prepare_restore(self, resource: Any, data: Any) -> dict | None:
        """
        AP-011: 在 DB 事务外执行 HTTP IO，避免持锁期间等待 collab-live。

        对 Y.js binary 数据调用 /convert/binary-to-formats 转换为 JSON/MD/plaintext，
        返回转换结果 dict。事务内的 restore() 直接使用此结果。
        """
        binary_data = data
        if isinstance(data, dict) and data.get("format") == "binary_snapshot":
            try:
                binary_data = base64.b64decode(data.get("binary_b64", ""))
            except Exception:
                logger.exception("Failed to decode binary_snapshot during restore prep")
                return None
        if not isinstance(binary_data, bytes):
            return None
        try:
            binary_data = unwrap_binary_snapshot(binary_data)[0]
        except ValueError:
            logger.exception("Failed to unwrap binary_snapshot during restore prep")
            return None
        try:
            from apps.services.common.live_api import call_live_api

            b64 = base64.b64encode(binary_data).decode()
            return call_live_api("/convert/binary-to-formats", {"binary_b64": b64})
        except Exception:
            logger.exception("Failed to convert binary to formats during restore prep")
            return None

    def restore(self, resource: Any, data: Any, *, prepared: Any = None, user=None) -> None:
        """
        将文档恢复到指定版本。

        data 可以是 bytes（Y.js binary）或 dict（JSON snapshot）。
        prepared 来自 prepare_restore()，包含 binary→formats 转换结果。

        CL-007: push_and_update_binary 及 binary→formats 转换通过
        transaction.on_commit 延迟到外层事务提交后执行，避免在
        _do_restore 的 transaction.atomic 持锁期间进行 HTTP IO
        （最坏 60s 阻塞并发请求）。

        CSC-005: 当 prepared 为 None（collab-live 不可用）时，不清空
        description_json/markdown/plaintext，保留旧值。on_commit 回调
        成功后再更新为新值，并推送到 collab-live。这样窗口期内用户看到
        的是旧版本的 JSON/MD，而非空内容。
        """
        from django.db import transaction
        from django.utils import timezone

        from apps.tabdoc.models import Document
        from apps.tabdoc.services.document_service import DocumentService, normalize_tabdata_snapshot
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        svc = DocumentService(user=None)
        svc.assert_document_content_editable(resource)

        from django.db.models import F

        # DEF-007: 递增 latest_version，使 restore 事务提交后、force_close 执行前
        # 的竞态窗口内，collab-live 的 persist_changes → save_from_hocuspocus 因
        # CAS 版本不匹配（locked_doc.latest_version != document.latest_version）
        # 而拒绝写入，防止用户新编辑覆盖刚恢复的数据
        update_fields = {
            "updated_at": timezone.now(),
            "latest_version": F("latest_version") + 1,
        }
        restore_metadata = getattr(resource, "_version_history_restore_metadata", {}) or {}
        metadata_has_title = (
            isinstance(restore_metadata, dict)
            and "tabdoc_title" in restore_metadata
        )

        if isinstance(data, dict) and data.get("format") == "json_snapshot":
            description_json, description_markdown = normalize_tabdata_snapshot(
                data.get("description_json", {}),
                data.get("description_markdown", ""),
            )
            update_fields["description_binary"] = None
            update_fields["description_json"] = description_json
            update_fields["description_markdown"] = description_markdown
            update_fields["description_plaintext"] = data.get("description_plaintext", "")
            if "title" in data:
                update_fields["title"] = data["title"]
        elif isinstance(data, bytes) or (
            isinstance(data, dict) and data.get("format") == "binary_snapshot"
        ):
            if isinstance(data, dict):
                try:
                    binary_data = base64.b64decode(data.get("binary_b64", ""))
                except Exception as exc:
                    raise ValueError("invalid binary_snapshot payload") from exc
                if "title" in data:
                    update_fields["title"] = data["title"]
            else:
                binary_data = unwrap_binary_snapshot(data)[0]
                if metadata_has_title:
                    update_fields["title"] = restore_metadata.get("tabdoc_title") or ""
            update_fields["description_binary"] = binary_data
            formats_applied = False
            # P0-01 fix: 检查 prepared 是否包含实际转换数据，
            # 避免仅含 _vh_created_at 等元数据的 dict 触发此分支
            if prepared and ("json" in prepared or "markdown" in prepared or "html" in prepared):
                try:
                    description_json, description_markdown = normalize_tabdata_snapshot(
                        prepared.get("json", {}),
                        prepared.get("markdown", ""),
                    )
                    update_fields["description_markdown"] = description_markdown
                    update_fields["description_json"] = description_json
                    update_fields["description_plaintext"] = prepared.get("plaintext", "")
                    formats_applied = True
                except Exception:
                    logger.exception("Failed to apply prepared formats during restore")
            if not formats_applied:
                # CSC-005: 保留旧值而非清空，防止 on_commit 执行前的窗口期内
                # 用户打开文档时读取到空内容。旧 JSON/MD 虽对应恢复前版本，
                # 但比空值更安全；on_commit 成功后会更新为正确的新版本内容。
                update_fields["description_json"] = resource.description_json or {}
                update_fields["description_markdown"] = resource.description_markdown or ""
                update_fields["description_plaintext"] = resource.description_plaintext or ""
                logger.warning(
                    "restore: prepared is None, keeping old JSON/MD as fallback during on_commit window. doc=%s",
                    resource.id,
                )

        # P1-15 fix: select_for_update 行锁防止并发写入，即使不通过
        # restore_to_version（有 Redis 恢复锁）路径调用也有保护
        with transaction.atomic(using=DB):
            locked = (
                Document.objects.using(DB)
                .select_for_update()
                .filter(id=resource.id)
                .first()
            )
            if locked is None:
                raise RuntimeError(
                    f"restore: document row not found or not lockable: {resource.id}"
                )
            rows = Document.objects.using(DB).filter(id=resource.id).update(**update_fields)
            if rows == 0:
                raise RuntimeError(
                    f"restore: update affected 0 rows for document {resource.id}"
                )
        resource.refresh_from_db(using=DB)

        if "title" in update_fields:
            def _deferred_resource_update():
                try:
                    fresh = Document.objects.using(DB).get(id=resource.id)
                    ResourceBridge.on_update(fresh, user=user)
                except Exception:
                    logger.warning(
                        "restore: resource bridge update failed for doc %s (non-blocking)",
                        resource.id,
                        exc_info=True,
                    )

            transaction.on_commit(_deferred_resource_update, using=DB)

        # QuerySet.update() 不触发 post_save 信号，需手动更新 search_vector 和 RAG 索引
        def _deferred_search_reindex():
            try:
                fresh = Document.objects.using(DB).get(id=resource.id)
                svc._update_search_vector(fresh, plaintext=fresh.description_plaintext or "")
            except Exception:
                logger.warning("restore: search_vector update failed for doc %s (non-blocking)", resource.id, exc_info=True)
            try:
                from apps.rag.tasks import index_document_task
                index_document_task.delay(str(resource.id), force=True)
            except Exception as exc:
                from apps.maintenance.celery_utils import is_broker_connection_error
                if not is_broker_connection_error(exc):
                    logger.warning("restore: RAG reindex failed for doc %s (non-blocking)", resource.id, exc_info=True)

        transaction.on_commit(_deferred_search_reindex, using=DB)

        resource_id = resource.id

        if isinstance(data, dict) and data.get("format") == "json_snapshot" and update_fields.get("description_json"):
            restored_json = update_fields["description_json"]

            def _deferred_push_binary():
                try:
                    fresh = Document.objects.using(DB).get(id=resource_id)
                    DocumentService.push_and_update_binary(
                        fresh,
                        restored_json,
                        agent_id="system:collab_restore",
                        editor_type="system",
                    )
                except Exception:
                    logger.exception(
                        "Deferred push_and_update_binary failed for doc %s", resource_id,
                    )

            transaction.on_commit(_deferred_push_binary, using=DB)

        elif (
            isinstance(data, bytes)
            or (isinstance(data, dict) and data.get("format") == "binary_snapshot")
        ) and not prepared:
            if isinstance(data, dict):
                try:
                    binary_data = base64.b64decode(data.get("binary_b64", ""))
                except Exception as exc:
                    raise ValueError("invalid binary_snapshot payload") from exc
            else:
                binary_data = data

            # BUG-1 fix: 在闭包外捕获 agent_run_id，deferred 执行时线程上下文已变
            try:
                from apps.services.common.platform_context import get_current_run_id
                _captured_run_id = get_current_run_id() or ""
            except (ImportError, Exception):
                _captured_run_id = ""

            def _deferred_convert_and_push():
                try:
                    from apps.services.common.live_api import call_live_api

                    b64 = base64.b64encode(binary_data).decode()
                    result = call_live_api("/convert/binary-to-formats", {"binary_b64": b64})
                    desc_json, desc_md = normalize_tabdata_snapshot(
                        result.get("json", {}),
                        result.get("markdown", ""),
                    )
                    Document.objects.using(DB).filter(id=resource_id).update(
                        description_markdown=desc_md,
                        description_json=desc_json,
                        description_plaintext=result.get("plaintext", ""),
                    )
                    # : 用 VH 原始 Y.js binary 做 xml.fragment.replace（replace 语义），
                    # 禁止 markdown→update 往返（会丢失 TabData 块与复杂组件）。
                    try:
                        from apps.collab.apply_ops import CollabApplyOpsService
                        update_b64 = base64.b64encode(binary_data).decode()
                        result_push = CollabApplyOpsService.apply_docs_ops(
                            document_id=str(resource_id),
                            op_id=_captured_run_id or f"docs:{resource_id}:restore",
                            ops=[{
                                "op": "xml.fragment.replace",
                                "fragment": "default",
                                "update_b64": update_b64,
                            }],
                            editor_type="system",
                            editor_id="system:collab_restore",
                            editor_name="system:collab_restore",
                            system_policy="trusted_internal",
                        )
                        if "error" in result_push or result_push.get("status") == "error":
                            raise RuntimeError(result_push.get("error") or result_push.get("message") or result_push.get("code"))
                    except Exception:
                        logger.warning(
                            "Deferred xml.fragment.replace apply-ops failed for doc %s (non-blocking)",
                            resource_id, exc_info=True,
                        )
                except Exception:
                    logger.exception(
                        "Deferred binary-to-formats conversion failed for doc %s",
                        resource_id,
                    )

            transaction.on_commit(_deferred_convert_and_push, using=DB)

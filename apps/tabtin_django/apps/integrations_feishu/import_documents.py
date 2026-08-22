"""飞书云文档 Docx → TabDoc（官方 Markdown 导出）。"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.db import transaction

from .client import FeishuAPIError, FeishuAuthError, FeishuClient
from .constants import DOCX_BLOCK_TYPE_FILE, DOCX_BLOCK_TYPE_IMAGE
from .feishu_images import enrich_feishu_docx_markdown_images
from .feishu_markdown import normalize_feishu_docx_markdown
from .flow_view import enrich_markdown_with_whiteboard_flows
from .import_errors import (
    is_auth_api_error,
    raise_if_provider_reauthenticated,
    user_facing_import_error,
)
from .models import FeishuImportJob

logger = logging.getLogger(__name__)

# 官方 docs/v1/content 限 5 QPS；文档间略间隔
_DOC_GAP_SECONDS = 0.25


@contextmanager
def _locked_import_job(job: FeishuImportJob):
    with transaction.atomic():
        yield FeishuImportJob.objects.select_for_update().get(id=job.id)


def _bind_private_image_assets(
    pm_json: Dict[str, Any],
    assets: List[Dict[str, str]],
) -> set[str]:
    """Replace transient import URLs with stable file IDs in ProseMirror JSON."""
    file_id_by_url = {
        str(asset.get("url") or ""): str(asset.get("file_id") or "")
        for asset in assets
        if asset.get("url") and asset.get("file_id")
    }
    bound: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            if value.get("type") == "image" and isinstance(value.get("attrs"), dict):
                attrs = value["attrs"]
                file_id = file_id_by_url.get(str(attrs.get("src") or ""))
                if file_id:
                    attrs["fileId"] = file_id
                    attrs["src"] = ""
                    bound.add(file_id)
            for child in value.get("content", []) or []:
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(pm_json)
    return bound


def import_feishu_documents(
    job: FeishuImportJob,
    *,
    client: FeishuClient,
    access_token: str,
    documents: List[Dict[str, Any]],
    issues: List[str],
) -> List[Dict[str, Any]]:
    """逐篇导出 Markdown 并 create_document；单项失败记 issues，不拖死整单。"""
    from apps.tabdoc.services.document_service import DocumentService

    docs = list(documents or [])
    total = len(docs)
    if total == 0:
        return []

    # 重投递时沿用 job.result 里已成功创建的文档，避免重复 create_document
    prior = dict(job.result or {})
    prior_created = prior.get("created_documents") or []
    created: List[Dict[str, Any]] = [
        dict(item) for item in prior_created if isinstance(item, dict)
    ]
    failed_documents: List[Dict[str, Any]] = [
        dict(item)
        for item in (prior.get("failed_documents") or [])
        if isinstance(item, dict)
    ]

    service = DocumentService(user=job.user)
    org_id = str(job.organization_id)
    collection_id = str(job.collection_id) if job.collection_id else None
    already_tokens = {
        str(item.get("doc_token") or "")
        for item in created
        if item.get("doc_token")
    }

    for idx, row in enumerate(docs):
        doc_token = str(row.get("doc_token") or "").strip()
        preferred = str(row.get("name") or "").strip()
        # 前端树浏览偶发用 token 充 name；视为未知，走 metas 回填
        if preferred == doc_token:
            preferred = ""
        name = preferred
        doc_type = str(row.get("doc_type") or "docx").strip().lower() or "docx"

        _set_docs_phase(
            job,
            created,
            failed_documents,
            issues,
            done=idx,
            total=total,
        )

        if doc_type != "docx":
            error = "不支持导入此类文档"
            issues.append(f"跳过不支持导入的文档「{name or '未命名文档'}」")
            _record_failed_document(failed_documents, doc_token, name, error)
            continue
        if not doc_token:
            error = "缺少文档标识"
            issues.append(f"跳过无效文档项「{name or '未命名'}」（缺少 doc_token）")
            _record_failed_document(failed_documents, doc_token, name, error)
            continue
        # Celery 重投递：已成功落库的文档不再 create_document
        if doc_token in already_tokens:
            continue

        if not name:
            try:
                name = client.get_drive_file_name(
                    access_token, doc_token, doc_type="docx",
                ) or ""
            except Exception:
                name = ""
        name = name or "未命名文档"

        try:
            docx_blocks: List[Dict[str, Any]] = []
            image_assets: List[Dict[str, str]] = []
            markdown = normalize_feishu_docx_markdown(
                client.get_docx_markdown(access_token, doc_token) or "",
            )
            markdown = enrich_feishu_docx_markdown_images(
                markdown,
                client=client,
                access_token=access_token,
                doc_token=doc_token,
                organization_id=job.organization_id,
                user_id=str(getattr(job.user, "id", "") or ""),
                issues=issues,
                doc_title=name,
                collected_blocks=docx_blocks,
                uploaded_assets=image_assets,
            )
            source_image_count = sum(
                1
                for block in docx_blocks
                if int(block.get("block_type") or 0) == DOCX_BLOCK_TYPE_IMAGE
            )
            unsupported_file_block_count = sum(
                1
                for block in docx_blocks
                if int(block.get("block_type") or 0) == DOCX_BLOCK_TYPE_FILE
            )
            if unsupported_file_block_count:
                issues.append(
                    f"文档「{name}」包含 {unsupported_file_block_count} 个文件块，"
                    "当前暂不支持导入到 TabDoc；源文件未复制，导出占位已从正文隐藏"
                )
            markdown = enrich_markdown_with_whiteboard_flows(
                markdown,
                blocks=docx_blocks,
                client=client,
                access_token=access_token,
                source_title=name,
                issues=issues,
            )
            create_kwargs: Dict[str, Any] = {
                "organization_id": org_id,
                "title": name,
                "initial_content_markdown": markdown,
                "collection_id": collection_id,
            }
            bound_file_ids: set[str] = set()
            if image_assets:
                from apps.tabdoc.services.markdown_exchange import (
                    markdown_to_pm_json,
                    pm_json_to_markdown,
                )

                pm_json = markdown_to_pm_json(markdown)
                bound_file_ids = _bind_private_image_assets(pm_json, image_assets)
                expected_file_ids = {
                    str(asset.get("file_id") or "") for asset in image_assets
                }
                if bound_file_ids != expected_file_ids:
                    raise RuntimeError("飞书文档图片未能完整绑定到文档节点")
                create_kwargs.update({
                    "initial_content_pm_json": pm_json,
                    "initial_content_markdown": pm_json_to_markdown(pm_json),
                    "initial_content_plaintext": service._extract_plaintext_from_json(pm_json),
                })

            document = service.create_document(**create_kwargs)
            if bound_file_ids:
                from apps.services.oss.models import FileRecord, FileUsage

                records = {
                    str(item.id): item
                    for item in FileRecord.objects.filter(id__in=bound_file_ids)
                }
                for file_id in bound_file_ids:
                    file_record = records.get(file_id)
                    if not file_record:
                        raise RuntimeError("飞书文档图片文件记录不存在")
                    FileUsage.add_usage(
                        file_record,
                        getattr(job.user, "id", None),
                        module="tabdoc",
                        context_type="document",
                        context_id=str(document.id),
                    )
                for usage in FileUsage.objects.filter(
                    file_record_id__in=bound_file_ids,
                    module="tabdoc",
                    context_type="feishu_import",
                    context_id=doc_token,
                    is_active=True,
                ):
                    usage.deactivate()
            created.append({
                "doc_token": doc_token,
                "name": name,
                "tabdoc_id": str(document.id),
                "doc_type": "docx",
                "fidelity": {
                    "source_images": source_image_count,
                    "imported_images": len(image_assets),
                    "unsupported_file_blocks": unsupported_file_block_count,
                },
            })
            already_tokens.add(doc_token)
            failed_documents = [
                item
                for item in failed_documents
                if str(item.get("doc_token") or "") != doc_token
            ]
        except FeishuAuthError:
            raise
        except FeishuAPIError as exc:
            if is_auth_api_error(exc):
                raise FeishuAuthError("飞书授权已失效，请重新授权") from exc
            error = user_facing_import_error(exc)
            msg = f"导入文档「{name}」失败：{error}"
            logger.warning(
                "[FeishuImportDocs] import failed doc_token=%s error=%s",
                doc_token,
                exc,
            )
            issues.append(msg)
            _record_failed_document(failed_documents, doc_token, name, error)
        except Exception as exc:
            error = user_facing_import_error(exc)
            msg = f"导入文档「{name}」失败：{error}"
            logger.exception("[FeishuImportDocs] unexpected error doc_token=%s", doc_token)
            issues.append(msg)
            _record_failed_document(failed_documents, doc_token, name, error)

        if idx + 1 < total:
            time.sleep(_DOC_GAP_SECONDS)

    _set_docs_phase(
        job,
        created,
        failed_documents,
        issues,
        done=total,
        total=total,
    )
    return created


def _record_failed_document(
    failed_documents: List[Dict[str, Any]],
    doc_token: str,
    name: str,
    error: str,
) -> None:
    failed_documents[:] = [
        item
        for item in failed_documents
        if str(item.get("doc_token") or "") != doc_token
    ]
    failed_documents.append({
        "doc_token": doc_token,
        "name": name or "未命名文档",
        "error": error or "导入失败",
    })


def _set_docs_phase(
    job: FeishuImportJob,
    created: List[Dict[str, Any]],
    failed_documents: List[Dict[str, Any]],
    issues: List[str],
    *,
    done: int,
    total: int,
) -> None:
    with _locked_import_job(job) as locked:
        result = dict(locked.result or {})
        raise_if_provider_reauthenticated(result)
        result["phase"] = "docs"
        result["created_documents"] = created
        result["failed_documents"] = failed_documents
        result["issues"] = issues[-50:]
        # 文档阶段 progress：done/total 仅计文档；表格进度已在 result 中保留
        table_progress = (
            result.get("progress")
            if isinstance(result.get("progress"), dict)
            else {}
        )
        table_total = int(table_progress.get("total") or 0)
        table_done = int(table_progress.get("done") or 0)
        result["progress"] = {
            "done": table_done + done,
            "total": table_total + total,
            "docs_done": done,
            "docs_total": total,
        }
        result["docs_progress"] = {"done": done, "total": total}
        locked.result = result
        locked.save(update_fields=["result", "updated_at"])
        job.result = result

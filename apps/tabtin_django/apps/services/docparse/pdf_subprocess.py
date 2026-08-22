from __future__ import annotations

import logging
import multiprocessing as mp
import os
import queue
import time
from dataclasses import asdict

from apps.services.docparse.parsers.base import ChunkResult, PageResult

logger = logging.getLogger(__name__)

_BATCH_SIZE = int(os.environ.get("DOCPARSE_PDF_CHILD_BATCH_SIZE", "3"))
_TIMEOUT_SECONDS = int(os.environ.get("DOCPARSE_PDF_CHILD_TIMEOUT_SECONDS", "120"))
_MAX_MEMORY_MB = int(os.environ.get("DOCPARSE_PDF_CHILD_MAX_MEMORY_MB", "1536"))
_QUEUE_POLL_SECONDS = 0.1

_DAEMONIC_CHILD_ERROR = "daemonic processes are not allowed to have children"


def _log_extra(**values: object) -> dict[str, object]:
    return {
        "parser_mode": "pdf_child",
        **values,
    }


def pdf_child_batch_size() -> int:
    return max(1, min(_BATCH_SIZE, 10))


def _parent_cannot_spawn_mp_child() -> bool:
    """Celery/billiard worker 子进程常为 daemon，不能再 fork mp.Process。"""
    try:
        return bool(mp.current_process().daemon)
    except Exception:
        return False


def _spawn_blocked_by_daemon_parent(exc: BaseException) -> bool:
    return (
        isinstance(exc, AssertionError)
        and _DAEMONIC_CHILD_ERROR in str(exc)
    )


def _parse_pages_in_parent(
    *,
    file_path: str,
    page_numbers: list[int],
    vision_model: str,
    user_id: str,
    organization_id: str,
    fallback_reason: str,
) -> list[PageResult]:
    logger.warning(
        "PDF 子进程不可用（%s），降级为进程内解析: pages=%s",
        fallback_reason,
        page_numbers,
        extra=_log_extra(fallback_reason=fallback_reason, parser_mode="pdf_inprocess"),
    )
    try:
        return _parse_pages(
            file_path=file_path,
            page_numbers=page_numbers,
            vision_model=vision_model,
            user_id=user_id,
            organization_id=organization_id,
        )
    except Exception as exc:
        logger.warning(
            "PDF 进程内解析失败: pages=%s error=%s",
            page_numbers,
            exc,
        )
        return [_error_page(page, str(exc)) for page in page_numbers]


def parse_pdf_page_batch_in_subprocess(
    *,
    file_path: str,
    page_numbers: list[int],
    vision_model: str,
    user_id: str,
    organization_id: str,
) -> list[PageResult]:
    if not page_numbers:
        return []

    if _parent_cannot_spawn_mp_child():
        return _parse_pages_in_parent(
            file_path=file_path,
            page_numbers=page_numbers,
            vision_model=vision_model,
            user_id=user_id,
            organization_id=organization_id,
            fallback_reason="daemon_parent",
        )

    result_queue: mp.Queue = mp.Queue(maxsize=1)
    process = mp.Process(
        target=_worker_main,
        kwargs={
            "file_path": file_path,
            "page_numbers": page_numbers,
            "vision_model": vision_model,
            "user_id": user_id,
            "organization_id": organization_id,
            "result_queue": result_queue,
        },
    )
    try:
        process.start()
    except AssertionError as exc:
        if _spawn_blocked_by_daemon_parent(exc):
            return _parse_pages_in_parent(
                file_path=file_path,
                page_numbers=page_numbers,
                vision_model=vision_model,
                user_id=user_id,
                organization_id=organization_id,
                fallback_reason="daemon_parent_start_blocked",
            )
        raise

    status, payload = _read_child_payload(process, result_queue)

    if status == "timeout":
        process.kill()
        process.join(5)
        logger.warning(
            "PDF 子进程超时，降级占位: pages=%s",
            page_numbers,
            extra=_log_extra(fallback_reason="timeout"),
        )
        return [_error_page(page, "pdf_child_timeout") for page in page_numbers]

    process.join(5)
    if process.is_alive():
        process.kill()
        process.join(5)
        logger.warning(
            "PDF 子进程结果已读取但进程未退出，已终止: pages=%s",
            page_numbers,
            extra=_log_extra(fallback_reason="post_payload_exit_timeout"),
        )

    if status == "empty" or payload is None:
        logger.warning(
            "PDF 子进程无结果，exitcode=%s pages=%s",
            process.exitcode, page_numbers,
            extra=_log_extra(fallback_reason=f"exit_{process.exitcode}"),
        )
        return [_error_page(page, f"pdf_child_exit_{process.exitcode}") for page in page_numbers]

    if payload.get("ok"):
        return [_page_from_dict(item) for item in payload.get("pages", [])]

    error = str(payload.get("error") or "pdf_child_failed")
    logger.warning("PDF 子进程失败，降级占位: pages=%s error=%s", page_numbers, error)
    return [_error_page(page, error) for page in page_numbers]


def _read_child_payload(process: mp.Process, result_queue: mp.Queue) -> tuple[str, dict | None]:
    """Drain the child queue before join() so large payloads cannot deadlock.

    multiprocessing.Queue uses a pipe underneath. If the child serializes a large
    page batch, queue.put() can block until the parent reads. Joining the process
    before reading the queue therefore turns a successful parse into a timeout.
    """
    deadline = time.monotonic() + _TIMEOUT_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "timeout", None
        try:
            payload = result_queue.get(timeout=min(_QUEUE_POLL_SECONDS, remaining))
            return "payload", payload
        except queue.Empty:
            if not process.is_alive():
                try:
                    return "payload", result_queue.get_nowait()
                except queue.Empty:
                    return "empty", None


def _worker_main(
    *,
    file_path: str,
    page_numbers: list[int],
    vision_model: str,
    user_id: str,
    organization_id: str,
    result_queue,
) -> None:
    _apply_memory_limit()
    try:
        pages = _parse_pages(
            file_path=file_path,
            page_numbers=page_numbers,
            vision_model=vision_model,
            user_id=user_id,
            organization_id=organization_id,
        )
        result_queue.put({"ok": True, "pages": [asdict(page) for page in pages]})
    except Exception as exc:
        result_queue.put({"ok": False, "error": str(exc)[:1000]})


def _apply_memory_limit() -> None:
    if _MAX_MEMORY_MB <= 0:
        return
    try:
        import resource

        limit = _MAX_MEMORY_MB * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except Exception as exc:
        logger.debug("PDF 子进程内存限制未生效: %s", exc)


def _parse_pages(
    *,
    file_path: str,
    page_numbers: list[int],
    vision_model: str,
    user_id: str,
    organization_id: str,
) -> list[PageResult]:
    import fitz
    import pdfplumber

    from apps.services.docparse.parsers.pdf_parser import PDFParser

    parser = PDFParser()
    parser._billing_user_id = user_id
    parser._billing_organization_id = organization_id
    doc = None
    plumber_pdf = None
    try:
        doc = fitz.open(file_path)
        plumber_pdf = pdfplumber.open(file_path)
        results: list[PageResult] = []
        for page_num in page_numbers:
            page_idx = page_num - 1
            try:
                fitz_page = doc[page_idx]
                plumber_page = (
                    plumber_pdf.pages[page_idx]
                    if page_idx < len(plumber_pdf.pages)
                    else None
                )
                # 子进程契约：只做 native PDF 解析，不访问 DB/计费/LLM 持久化路径。
                # Vision/OCR 需要由父 worker 后续以可恢复、可计费的任务阶段处理。
                chunks = parser.parse_page(
                    fitz_page, plumber_page, page_idx, "",
                )
                text_content = "\n".join(c.content for c in chunks if c.content)
                results.append(PageResult(
                    page_number=page_num,
                    width=fitz_page.rect.width,
                    height=fitz_page.rect.height,
                    chunks=chunks,
                    text_content=text_content,
                ))
            except Exception as exc:
                results.append(_error_page(page_num, str(exc)))
        return results
    finally:
        if plumber_pdf is not None:
            plumber_pdf.close()
        if doc is not None:
            doc.close()


def _error_page(page_number: int, error: str) -> PageResult:
    return PageResult(
        page_number=page_number,
        width=0,
        height=0,
        chunks=[ChunkResult(
            chunk_type="paragraph",
            content=f"[第 {page_number} 页解析失败]",
            sequence=1,
            metadata={
                "error": error[:500],
                "quality": "low",
                "source": "error",
            },
        )],
        text_content="",
    )


def _page_from_dict(data: dict) -> PageResult:
    chunks = [
        ChunkResult(
            chunk_type=item["chunk_type"],
            content=item["content"],
            sequence=item["sequence"],
            bbox=tuple(item["bbox"]) if item.get("bbox") else None,
            heading_level=item.get("heading_level"),
            metadata=item.get("metadata") or {},
        )
        for item in data.get("chunks", [])
    ]
    return PageResult(
        page_number=data["page_number"],
        width=data.get("width", 0),
        height=data.get("height", 0),
        chunks=chunks,
        text_content=data.get("text_content", ""),
    )

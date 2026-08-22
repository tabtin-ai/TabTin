"""
File Pipeline W3 — DocParse 临时通道同步解析 endpoint

业务目标：客户端把 PPTX 直传到 OSS `temp-parse/` 前缀后，调本 endpoint
**同步**拿到 chunks。整条链路**不**写 `ParsedDocument`、**不**入 RAG、
**不**计费。完成后**主动**删除 OSS 临时对象（lifecycle 兜底见
`apps.services.oss.management.commands.configure_temp_parse_lifecycle`）。

物理分离：
  - URL: `POST /services/docparse/parse-sync-temp`（与 `/parse/{file_record_id}`
    `/summary` `/content` 字面区分）
  - **绝不** import / 调用 `DocParseService.parse_async`、`DocParseService.parse`、
    `_persist_one_page`、`_finalize_document`、`_emit_completed`、
    `_trigger_rag_index`（这些都是持久通道路径）
  - **绝不**触发 `Celery parse_document_task` 投递
  - 直接调 parser registry 的 `parser.parse(local_path)` 然后把 chunks 序列化返
    给客户端，瞬时完成

错误处理：13 类全局 SSoT（`@tabtin/file-pipeline-errors`）字面值对齐——
W1 后端启发式 `_classify_exception_to_failure_code` 复用同一份 SSoT，
不在临时通道里重新发明 catalog。
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
import tempfile
import time

from typing import Any, Dict, List

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from apps.users.auth.permissions import JWTAuth

from apps.services.docparse.parsers.base import ParseResult
from apps.services.docparse.service import _classify_exception_to_failure_code
from apps.services.oss.services.factory import get_oss_service
from apps.services.oss.temp_parse_api import (
    TEMP_PARSE_MAX_FILE_SIZE_BYTES,
    TEMP_PARSE_MIME_WHITELIST,
    assert_temp_parse_object_key,
)
from apps.services.common.cache import is_rate_limited as cache_is_rate_limited
from apps.services.common.exceptions import ValidationException

logger = logging.getLogger(__name__)
router = Router(tags=["DocParse Temp Channel"])
jwt_auth = JWTAuth()


# ---------------------------------------------------------------------------
# 同步解析超时（adapter 端 30s 上限的稍紧子集——backend 27s + 客户端 30s
# = 客户端先 timeout，确保客户端拿到的是结构化 ParseTimeout 错误而不是
# transport-level reset。PPTX 本地 parse 通常 < 10s，留余量足够）
#
# **W3.1 收尾 L55 修复（2026-05-13）**：原版本是 post-parse elapsed 检查
# （parser.parse() 同步阻塞返回**后**才判超时），无法真正中断 python-pptx
# 同步解析。复杂 PPTX / zip-bomb 跑 60-120s，gunicorn worker 全程阻塞，
# 客户端 30s 已 cancel 但 worker 仍占用 → production worker pool DoS 攻击面。
#
# 改用 `concurrent.futures.ThreadPoolExecutor` + `future.result(timeout=...)`
# 让 endpoint 在 27s 内返回 PARSE_TIMEOUT envelope —— gunicorn worker 立即
# 释放可处理下个请求。
#
# 注意 thread 不可中断（python-pptx 同步代码 + GIL 不接 SIGTERM），底层
# thread 仍然跑直到自然结束 + GC（worker thread leak）—— 这是 Python 同步
# 解析器的固有限制。完整修复需要 multiprocessing.Process（可 .terminate()
# 真中断）+ pickle 跨进程序列化 ParseResult（启动 50-200ms / pickle 不轻），
# 或者把 PPTX 解析挪到独立 Celery worker 用 SoftTimeLimit/HardTimeLimit
# 中断（已是 docparse 持久通道方案）。本期临时通道按 D1+D2 选 ThreadPool
# 收益最大边际成本最小：endpoint 立即返回让 worker pool 不被打死，thread
# leak 可监控（warning 日志），未来 W4 抽 FileResolver 时考虑 Process。
# ---------------------------------------------------------------------------

TEMP_PARSE_SYNC_TIMEOUT_SECONDS = 27.0
DOCPARSE_ENABLE_SYNC_TEMP_PARSE = os.getenv("DOCPARSE_ENABLE_SYNC_TEMP_PARSE", "0").lower() in {
    "1", "true", "yes", "on",
}


# ---------------------------------------------------------------------------
# Rate limit（W3.1 收尾 L50 修复 2026-05-13）：每用户 30/min
#
# 临时通道红线"不写 FileRecord/FileUsage/ParsedDocument" 让审计 / 计费追踪
# 完全缺失，比持久通道更适合滥用（持久通道至少 FileRecord 留痕 + FileUsage
# 计配额）。叠加 L55 的 thread leak（python-pptx 不可中断），单恶意用户
# `50MB zip-bomb × 30/min × python-pptx 同步阻塞` 可以打满 gunicorn worker
# pool。
#
# 复用 13 类 SSoT 的 NETWORK_ERROR 错误码（不开新 RATE_LIMITED 类避免扩 SSoT
# 工作量；NETWORK_ERROR LLM-facing hint "check connectivity and retry once"
# 在 rate limit 场景语义近似——"系统暂时不可用，等等再来"），message 明确
# "请求频率超限"让 LLM 转述时给用户准确指引。
#
# 已存在的 RateLimitMiddleware 默认按 services 模块走 600/120 read/write，
# 临时通道 30/min 显著紧于通用配额。endpoint 显式 rate check 让单元测试
# 能直接触发（中间件不在 SimpleTestCase 路径里跑），同时在 production 双
# 闸门生效（中间件 + endpoint 内）。
# ---------------------------------------------------------------------------

TEMP_PARSE_SYNC_RATE_LIMIT = 30
TEMP_PARSE_RATE_WINDOW_SECONDS = 60


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ParseSyncTempRequest(Schema):
    """同步解析请求（与 OSS presign 的 mime_type 字段同款 schema 约束）。

    **W5 L57（2026-05-14）**：`mime_type` 加 `min_length=1` + 正则约束。
    与 `oss/temp_parse_api.py::TempParsePresignRequest.mime_type` 严格一致——
    避免空串 / 半成品 / 含奇怪 token 的 mime_type 绕过下游白名单 set 比对（'' not in
    set 永远 False，但流程会触发 ValidationException 给出非自描述的错误信息）。
    """

    # **W5 L57（2026-05-14）**：temp_object_key 也加 schema-level min_length=1 + max_length=256。
    # assert_temp_parse_object_key 业务函数在 endpoint 内部检空 / 长度，但同款理由
    # （422 比 200 OK 业务错精确）；max_length=256 与 _is_temp_parse_object_key
    # 的 256 字符上限对齐（schema 校验后业务函数仍做完整 4 步校验：前缀 + 路径
    # 穿越 + 深度 + user 归属，避免重复校验上层规则）。
    temp_object_key: str = Field(
        min_length=1,
        max_length=256,
        description="OSS temp-parse/ 前缀对象键（1-256 字符非空）",
    )
    mime_type: str = Field(
        min_length=1,
        max_length=255,
        pattern=r"^[a-zA-Z][a-zA-Z0-9!#$&\-^_+.]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_+.]*$",
        description="MIME 类型（非空），必须在 TEMP_PARSE_MIME_WHITELIST 内",
    )


class ChunkData(Schema):
    type: str
    content: str
    page: int
    heading_level: int = 0


class ParseSyncTempResponse(Schema):
    success: bool
    message: str = ""
    chunks: List[ChunkData] = []
    duration_ms: int = 0
    pages: int = 0
    title: str = ""
    failure_code: str = ""


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/parse-sync-temp", auth=jwt_auth, response=ParseSyncTempResponse)
def parse_sync_temp(request: HttpRequest, data: ParseSyncTempRequest) -> dict:
    """W3 临时通道同步 parse：download → parse → delete OSS object → 返 chunks。

    红线：
      1. **不写** `ParsedDocument` / `DocumentPage` / `DocumentChunk`
      2. **不写** `FileRecord` / `FileUsage`
      3. **不进** Celery 队列
      4. **不进** RAG 索引
      5. parse 完成（成功 / 失败）后**立即**删 OSS object（不等 lifecycle）
    """
    user_id = str(getattr(request.auth, "id", "")) if getattr(request, "auth", None) else ""
    started_ms = time.monotonic()
    if not DOCPARSE_ENABLE_SYNC_TEMP_PARSE:
        return _failure(
            "同步临时解析入口已关闭，请使用后台 DocParse/TabDoc import job",
            failure_code="unsupported_format",
            started_ms=started_ms,
        )

    # ── 0. Rate limit（W3.1 L50）：每用户 30/min ─────────────────────
    # JWTAuth 已先拦匿名请求；user_id 必非空。client key 用 user:{id} 与
    # 中间件 _get_client_identifier 同款命名，避免双闸门统计粒度漂移。
    if user_id:
        rl_limited, rl_count, rl_ttl = cache_is_rate_limited(
            "docparse_temp_parse_sync",
            f"user:{user_id}",
            TEMP_PARSE_SYNC_RATE_LIMIT,
            TEMP_PARSE_RATE_WINDOW_SECONDS,
        )
        if rl_limited:
            logger.warning(
                "parse-sync-temp rate limited: user=%s count=%d limit=%d ttl=%ds",
                user_id[:8], rl_count, TEMP_PARSE_SYNC_RATE_LIMIT, rl_ttl,
            )
            return _failure(
                f"临时通道解析请求频率超限（{TEMP_PARSE_SYNC_RATE_LIMIT}/min）"
                f"——请等待 {max(1, rl_ttl)}s 后重试",
                failure_code="network_failed",
                started_ms=started_ms,
            )

    # ── 1. 校验 temp_object_key 归属 + 防穿越 ─────────────────────────
    try:
        assert_temp_parse_object_key(data.temp_object_key, user_id=user_id)
    except ValidationException as exc:
        logger.warning(
            "parse-sync-temp 拒绝非法 object_key: user=%s key=%s err=%s",
            user_id[:8] if user_id else "anon", data.temp_object_key, exc,
        )
        return {
            "success": False,
            "message": str(exc),
            "failure_code": "invalid_param_format",
        }

    # ── 2. 校验 mime 在白名单 ─────────────────────────────────────────
    if data.mime_type not in TEMP_PARSE_MIME_WHITELIST:
        return {
            "success": False,
            "message": (
                f"mime {data.mime_type} 不在临时通道白名单"
                f"（当前白名单: {sorted(TEMP_PARSE_MIME_WHITELIST)}）"
            ),
            "failure_code": "unsupported_format",
        }

    # ── 3. 下载 → 解析 → 删除（finally 兜底删除）─────────────────────
    return _do_parse_sync_temp(
        temp_object_key=data.temp_object_key,
        mime_type=data.mime_type,
        started_ms=started_ms,
    )


def _do_parse_sync_temp(
    *, temp_object_key: str, mime_type: str, started_ms: float,
) -> dict:
    """实际 download → parse → delete 流程。抽出来便于单测 mock。"""
    from apps.services.docparse.parsers.registry import get_parser_for_mime

    oss_service = get_oss_service()

    # 临时本地落盘（PPTX 必须落盘，python-pptx 不接受 BytesIO 路径风格）
    suffix = os.path.splitext(temp_object_key)[1] or ".pptx"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="tabtin_temp_parse_")
    local_path = tmp.name
    tmp.close()

    try:
        # ── 3a. 下载到本地 ──────────────────────────────────────────
        # 注意：finally 块**无条件**尝试 delete OSS object（即便 download
        # 失败 OSS 上对象可能已存在），所以这里不需要标记 download_failed。
        try:
            dl_result = oss_service.download_file(temp_object_key, local_path=local_path)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "parse-sync-temp 下载 OSS 异常: key=%s err=%s",
                temp_object_key, exc, exc_info=True,
            )
            return _failure(
                "OSS 下载失败",
                failure_code="network_failed",
                started_ms=started_ms,
            )

        if not dl_result.get("success"):
            return _failure(
                f"OSS 下载失败：{dl_result.get('message', 'unknown')}",
                failure_code="network_failed",
                started_ms=started_ms,
            )

        actual_size = 0
        try:
            actual_size = os.path.getsize(local_path)
        except OSError:
            pass

        if actual_size <= 0:
            # **W3 Review 3 M9 修复（2026-05-13）**：原版本归 file_not_found，
            # SSoT FILE_NOT_FOUND hint 引导 LLM 用 glob_search 找文件——但 OSS
            # 对象存在（download success），只是字节为 0。实际场景是"客户端
            # presign 后 PUT 半途中断 / 客户端 bug 上传 0 字节"。归 corrupted
            # 让 LLM 引导用户"重传"。
            return _failure(
                "OSS 对象为空（presign 后 PUT 上传未完成或客户端上传 0 字节）",
                failure_code="corrupted",
                started_ms=started_ms,
            )
        if actual_size > TEMP_PARSE_MAX_FILE_SIZE_BYTES:
            return _failure(
                f"文件超出上限：{actual_size} bytes > {TEMP_PARSE_MAX_FILE_SIZE_BYTES}",
                failure_code="file_too_large",
                started_ms=started_ms,
            )

        # ── 3b. 解析 ─────────────────────────────────────────────────
        parser_cls = get_parser_for_mime(mime_type)
        if not parser_cls:
            return _failure(
                f"未注册 parser for mime={mime_type}",
                failure_code="unsupported_format",
                started_ms=started_ms,
            )

        # **W3.1 收尾 L55 修复（2026-05-13）**：用 ThreadPoolExecutor +
        # future.result(timeout=...) 让 endpoint 在 timeout 时立即返回，不
        # 等 thread 自然结束（gunicorn worker 立即释放可处理下个请求；
        # python-pptx 同步解析不可中断的 thread 仍跑到自然结束 + GC，
        # 是 thread leak 但 worker pool 不会被打死）。
        elapsed_before_parse = time.monotonic() - started_ms
        remaining_timeout = max(
            1.0, TEMP_PARSE_SYNC_TIMEOUT_SECONDS - elapsed_before_parse,
        )

        # ThreadPoolExecutor 不用 with（with 块退出会等所有 task 结束，
        # cancel_futures 只影响 not yet started 的 task；in-progress task
        # 仍跑——退出阻塞 endpoint 直到 thread 自然结束 = 失去 timeout 收益）。
        # 改为 finally + shutdown(wait=False) 让 endpoint 立即返回。
        executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="tabtin_temp_parse",
        )
        try:
            future = executor.submit(parser_cls().parse, local_path)
            try:
                parse_result: ParseResult = future.result(timeout=remaining_timeout)
            except concurrent.futures.TimeoutError:
                # in-progress task: future.cancel() 对 thread 已启动的任务无效
                # （Python concurrent.futures 限制），但调用以释放 future 引用。
                future.cancel()
                logger.warning(
                    "parse-sync-temp 解析超时（thread 仍在后台运行至自然结束 + GC，"
                    "endpoint 立即返回不阻塞 worker）: key=%s mime=%s "
                    "timeout=%.1fs elapsed_before_parse=%.1fs",
                    temp_object_key, mime_type, remaining_timeout, elapsed_before_parse,
                )
                return _failure(
                    f"解析耗时超过 {TEMP_PARSE_SYNC_TIMEOUT_SECONDS}s 限制",
                    failure_code="parse_timeout",
                    started_ms=started_ms,
                )
            except Exception as exc:  # noqa: BLE001
                # parser.parse 自身抛异常（BadZipFile / 加密 / 损坏等）→
                # _classify_exception_to_failure_code 派发 13 类
                failure_code = _classify_exception_to_failure_code(exc)
                logger.warning(
                    "parse-sync-temp 解析失败: key=%s mime=%s code=%s err=%s",
                    temp_object_key, mime_type, failure_code, exc,
                )
                return _failure(
                    f"解析失败: {exc}",
                    failure_code=failure_code,
                    started_ms=started_ms,
                )
        finally:
            # 关键：wait=False 让 endpoint 立即返回，不等 thread 自然结束。
            # cancel_futures=True (Python 3.9+) 取消 not yet started 的 task；
            # in-progress task 仍跑（不可中断），直到自然结束被 GC。
            try:
                executor.shutdown(wait=False, cancel_futures=True)
            except TypeError:
                # Python < 3.9 不支持 cancel_futures；降级
                executor.shutdown(wait=False)

        chunks = _serialize_chunks(parse_result)
        duration_ms = int((time.monotonic() - started_ms) * 1000)

        logger.info(
            "parse-sync-temp 成功: key=%s mime=%s pages=%d chunks=%d duration_ms=%d",
            temp_object_key, mime_type, len(parse_result.pages), len(chunks), duration_ms,
        )

        return {
            "success": True,
            "message": "OK",
            "chunks": chunks,
            "duration_ms": duration_ms,
            "pages": len(parse_result.pages),
            "title": parse_result.title or "",
            "failure_code": "",
        }
    finally:
        # ── 3c. 主动删除 OSS 对象（无论成功 / 失败 / 异常）──────────
        # 跨 Wave 不变量：临时通道完成后 OSS 对象必须被清理；lifecycle policy
        # 仅作 defense-in-depth 兜底。
        # download 阶段就失败的也尝试删除（OSS 上对象可能已存在），失败静默
        # 让 lifecycle 兜底。
        try:
            del_result = oss_service.delete_file(temp_object_key)
            if isinstance(del_result, dict) and not del_result.get("success", False):
                logger.warning(
                    "parse-sync-temp 删除 OSS 对象失败（lifecycle 兜底）: key=%s reason=%s",
                    temp_object_key, del_result.get("message", "unknown"),
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "parse-sync-temp 删除 OSS 对象异常（lifecycle 兜底）: key=%s err=%s",
                temp_object_key, exc,
            )

        # 清理本地临时文件
        try:
            if os.path.exists(local_path):
                os.unlink(local_path)
        except OSError:
            pass


def _failure(message: str, *, failure_code: str, started_ms: float) -> dict:
    duration_ms = int((time.monotonic() - started_ms) * 1000)
    return {
        "success": False,
        "message": message,
        "chunks": [],
        "duration_ms": duration_ms,
        "pages": 0,
        "title": "",
        "failure_code": failure_code,
    }


def _serialize_chunks(parse_result: ParseResult) -> List[Dict[str, Any]]:
    """ParseResult.pages → flat List[ChunkData]。"""
    out: List[Dict[str, Any]] = []
    for page in parse_result.pages:
        page_num = page.page_number
        for chunk in page.chunks:
            out.append({
                "type": chunk.chunk_type,
                "content": chunk.content,
                "page": page_num,
                "heading_level": chunk.heading_level or 0,
            })
    return out

"""
File Pipeline W3 — DocParse 临时通道 (`parse-sync-temp`) 单测

红线钉死（产品决策 D）：
  1. **不写** ParsedDocument / DocumentPage / DocumentChunk
  2. **不写** FileRecord / FileUsage
  3. **不进** Celery 队列（不调 parse_document_task）
  4. **不进** RAG 索引（不调 trigger_rag_index_task）
  5. parse 完成（成功 / 失败 / 异常）后**主动** delete OSS object

测试覆盖：
  - 成功路径：download → parse → 返 chunks → delete OSS
  - 失败路径：parser 抛 BadZipFile → CORRUPTED + 仍 delete OSS
  - 失败路径：mime 不在白名单 → unsupported_format
  - 失败路径：object_key 非 temp-parse/ 前缀 → invalid_param_format
  - 失败路径：object_key user 段不匹配 → invalid_param_format（防越权）
  - 失败路径：OSS download 失败 → network_failed + 不调 parser
  - 失败路径：本地空文件 → file_not_found
  - 失败路径：解析超时 → parse_timeout
  - **红线**：所有路径下 ParsedDocument / DocumentPage / DocumentChunk
    / FileRecord / FileUsage 表行数 = 0
  - **红线**：模块不 import parse_async / parse_document_task / trigger_rag_index_task
"""
from __future__ import annotations

import io
import os
import tokenize
import unittest
import zipfile
from unittest.mock import MagicMock, patch


def _extract_code_tokens(file_path: str) -> str:
    """读源文件返"只含真实代码 token"拼接串，跳过 comment / docstring。

    用于红线扫描——避免源码 docstring / comment 里"绝不调 parse_async"等
    描述性引用误触发 assertNotIn。
    """
    with open(file_path, "r", encoding="utf-8") as fp:
        source = fp.read()
    out: list[str] = []
    try:
        toks = tokenize.tokenize(io.BytesIO(source.encode("utf-8")).readline)
        for tok in toks:
            if tok.type in (tokenize.COMMENT, tokenize.STRING, tokenize.ENCODING,
                            tokenize.NEWLINE, tokenize.NL, tokenize.INDENT,
                            tokenize.DEDENT, tokenize.ENDMARKER):
                continue
            out.append(tok.string)
    except tokenize.TokenizeError:
        return source
    return " ".join(out)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from django.test import SimpleTestCase  # noqa: E402

import apps.services.docparse.temp_parse_api as temp_parse_api  # noqa: E402
from apps.services.docparse.parsers.base import (  # noqa: E402
    ChunkResult,
    PageResult,
    ParseResult,
)
from apps.services.docparse.temp_parse_api import (  # noqa: E402
    ParseSyncTempRequest,
    parse_sync_temp,
    _do_parse_sync_temp,
    _serialize_chunks,
)

temp_parse_api.DOCPARSE_ENABLE_SYNC_TEMP_PARSE = True


PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _user_seg_for(user_id: str) -> str:
    # **W3 Review 1 H4 / Review 2 M3 修复后**：与 oss/temp_parse_api.py
    # `_user_key_segment` 同源（sha256[:16]，避免双源 8 字符碰撞）
    import hashlib
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]


# ────────────────────────────────────────────────────────────────────
# **W5 L57（2026-05-14）**：mime_type Schema 校验钉死
# ────────────────────────────────────────────────────────────────────


class ParseSyncTempRequestSchemaValidationTest(SimpleTestCase):
    """ParseSyncTempRequest.mime_type 加 min_length=1 + pattern 后校验钉死。

    与 OSS presign 的 TempParsePresignRequest.mime_type schema 一致——避免
    空串 / 注入 / 半成品 mime 绕过下游白名单 set 比对（'' not in set 永远 False，
    用户拿到的是不自描述的"mime 不在白名单"错误）。
    """

    def test_empty_mime_type_rejected_at_schema_layer(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            ParseSyncTempRequest(
                temp_object_key=_valid_temp_key(),
                mime_type="",
            )

    def test_mime_type_without_slash_rejected(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            ParseSyncTempRequest(
                temp_object_key=_valid_temp_key(),
                mime_type="totallyinvalid",
            )

    def test_mime_type_injection_chars_rejected(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            ParseSyncTempRequest(
                temp_object_key=_valid_temp_key(),
                mime_type='application/pdf";DROP TABLE foo;--',
            )

    def test_legitimate_pptx_mime_passes(self):
        req = ParseSyncTempRequest(
            temp_object_key=_valid_temp_key(),
            mime_type=PPTX_MIME,
        )
        self.assertEqual(req.mime_type, PPTX_MIME)

    # ─── W5 L57 temp_object_key schema-level 校验 ─────────────────────
    def test_empty_temp_object_key_rejected_at_schema_layer(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            ParseSyncTempRequest(
                temp_object_key="",
                mime_type=PPTX_MIME,
            )

    def test_excessively_long_temp_object_key_rejected(self):
        from pydantic import ValidationError
        # max_length=256，与 _is_temp_parse_object_key 业务上限一致
        with self.assertRaises(ValidationError):
            ParseSyncTempRequest(
                temp_object_key="a" * 257,
                mime_type=PPTX_MIME,
            )


def _make_request(user_id: str = "01234567-89ab-cdef-0123-456789abcdef"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    return req


def _valid_temp_key(user_id: str = "01234567-89ab-cdef-0123-456789abcdef") -> str:
    seg = _user_seg_for(user_id)
    return f"temp-parse/{seg}/abc123def.pptx"


def _make_fake_parse_result() -> ParseResult:
    chunks_p1 = [
        ChunkResult(chunk_type="heading", content="Welcome", sequence=1, heading_level=1),
        ChunkResult(chunk_type="paragraph", content="This is slide 1 body.", sequence=2),
    ]
    chunks_p2 = [
        ChunkResult(chunk_type="heading", content="Q3 Plan", sequence=1, heading_level=1),
        ChunkResult(
            chunk_type="table",
            content="| Item | Value |\n| --- | --- |\n| Foo | 42 |",
            sequence=2,
        ),
        ChunkResult(chunk_type="note", content="[演讲备注]\nRemember to mention growth.", sequence=3),
    ]
    return ParseResult(
        pages=[
            PageResult(page_number=1, width=960, height=540, chunks=chunks_p1, text_content=""),
            PageResult(page_number=2, width=960, height=540, chunks=chunks_p2, text_content=""),
        ],
        title="Welcome",
        parse_method="structural",
    )


# ────────────────────────────────────────────────────────────────────
# 序列化辅助
# ────────────────────────────────────────────────────────────────────


class SerializeChunksTest(SimpleTestCase):

    def test_serialize_flatten_pages_into_chunks_with_page_numbers(self):
        result = _make_fake_parse_result()
        out = _serialize_chunks(result)
        self.assertEqual(len(out), 5)  # 2 + 3

        # 第一页两个 chunk 都应该 page=1
        self.assertEqual(out[0]["page"], 1)
        self.assertEqual(out[1]["page"], 1)
        # 第二页三个 chunk 都应该 page=2
        self.assertEqual(out[2]["page"], 2)
        self.assertEqual(out[2]["type"], "heading")
        self.assertEqual(out[2]["heading_level"], 1)
        self.assertEqual(out[3]["type"], "table")


# ────────────────────────────────────────────────────────────────────
# Endpoint 入口校验
# ────────────────────────────────────────────────────────────────────


class ParseSyncTempInputValidationTest(SimpleTestCase):

    def test_sync_temp_parse_disabled_by_default_contract(self):
        old = temp_parse_api.DOCPARSE_ENABLE_SYNC_TEMP_PARSE
        temp_parse_api.DOCPARSE_ENABLE_SYNC_TEMP_PARSE = False
        try:
            result = parse_sync_temp(
                _make_request(),
                ParseSyncTempRequest(
                    temp_object_key=f"temp-parse/{_user_seg_for('01234567-89ab-cdef-0123-456789abcdef')}/foo.pptx",
                    mime_type=PPTX_MIME,
                ),
            )
        finally:
            temp_parse_api.DOCPARSE_ENABLE_SYNC_TEMP_PARSE = old
        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "unsupported_format")
        self.assertIn("同步临时解析入口已关闭", result["message"])

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    def test_non_temp_parse_prefix_rejected(self, _mock_oss):
        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(
                temp_object_key="chat/attachments/abc.pptx",
                mime_type=PPTX_MIME,
            ),
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "invalid_param_format")

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    def test_wrong_user_segment_rejected(self, _mock_oss):
        # user A 的请求带着 user B 的 temp object_key
        user_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        seg_b = _user_seg_for(user_b)
        result = parse_sync_temp(
            _make_request(user_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            ParseSyncTempRequest(
                temp_object_key=f"temp-parse/{seg_b}/foo.pptx",  # user B 的 segment
                mime_type=PPTX_MIME,
            ),
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "invalid_param_format")

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    def test_unsupported_mime_rejected(self, _mock_oss):
        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(
                temp_object_key=_valid_temp_key(),
                mime_type="application/pdf",
            ),
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "unsupported_format")


# ────────────────────────────────────────────────────────────────────
# 主流程 + 失败分支
# ────────────────────────────────────────────────────────────────────


class ParseSyncTempMainFlowTest(SimpleTestCase):

    def _patch_get_oss(self, *, download_success=True, download_size=2048, fail_msg=None):
        """构造 mock oss service（download_file 返成功 + 写一个真实 PPTX 字节到 local_path）。"""
        mock = MagicMock()

        def fake_download(object_key, local_path=None):
            # 写一个最小 pptx zip 让 os.path.getsize 返非 0
            if download_success and local_path:
                with zipfile.ZipFile(local_path, "w") as zf:
                    zf.writestr("ppt/presentation.xml", "<x/>")
                return {"success": True, "data": {"file_size": os.path.getsize(local_path)}}
            return {"success": False, "message": fail_msg or "boom"}

        mock.download_file.side_effect = fake_download
        mock.delete_file.return_value = {"success": True, "data": {}}
        return mock

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime")
    def test_success_flow_returns_chunks_and_deletes_oss(self, mock_get_parser, mock_get_oss):
        mock_oss = self._patch_get_oss()
        mock_get_oss.return_value = mock_oss

        # parser 返一个稳定的假 ParseResult
        mock_parser_cls = MagicMock()
        mock_parser_cls.return_value.parse.return_value = _make_fake_parse_result()
        mock_get_parser.return_value = mock_parser_cls

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertTrue(result["success"], msg=f"got: {result}")
        self.assertEqual(result["pages"], 2)
        self.assertEqual(result["title"], "Welcome")
        self.assertEqual(len(result["chunks"]), 5)

        # **红线**：parse 完成后必须主动 delete OSS object
        mock_oss.delete_file.assert_called_once_with(_valid_temp_key())

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime")
    def test_parser_throws_BadZipFile_returns_corrupted_and_deletes_oss(
        self, mock_get_parser, mock_get_oss,
    ):
        mock_oss = self._patch_get_oss()
        mock_get_oss.return_value = mock_oss

        mock_parser_cls = MagicMock()
        mock_parser_cls.return_value.parse.side_effect = zipfile.BadZipFile("File is not a zip file")
        mock_get_parser.return_value = mock_parser_cls

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        # _classify_exception_to_failure_code 把 BadZipFile 归入 CORRUPTED（W1.3 fix-6）
        self.assertEqual(result["failure_code"], "corrupted")
        # 仍然主动 delete
        mock_oss.delete_file.assert_called_once()

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    def test_oss_download_failure_returns_network_failed(self, mock_get_oss):
        mock_oss = self._patch_get_oss(download_success=False, fail_msg="connection reset")
        mock_get_oss.return_value = mock_oss

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "network_failed")
        # 即便 download 失败也要尝试 delete（OSS 上对象可能已存在）
        mock_oss.delete_file.assert_called_once()

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    def test_oss_download_exception_returns_network_failed(self, mock_get_oss):
        mock_oss = MagicMock()
        mock_oss.download_file.side_effect = RuntimeError("OSS SDK panic")
        mock_oss.delete_file.return_value = {"success": True, "data": {}}
        mock_get_oss.return_value = mock_oss

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "network_failed")
        mock_oss.delete_file.assert_called_once()

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    def test_empty_local_file_returns_corrupted(self, mock_get_oss):
        # **W3 Review 3 M9 修复后**：OSS 对象 0 字节归 corrupted（客户端 PUT
        # 半途中断），不归 file_not_found（SSoT FILE_NOT_FOUND 会引导 glob_search
        # 找文件，对 OSS 对象无意义）
        mock = MagicMock()

        def fake_download(object_key, local_path=None):
            open(local_path, "w").close()
            return {"success": True, "data": {"file_size": 0}}

        mock.download_file.side_effect = fake_download
        mock.delete_file.return_value = {"success": True, "data": {}}
        mock_get_oss.return_value = mock

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "corrupted")

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime", return_value=None)
    def test_parser_not_registered_returns_unsupported_format(self, _mock_reg, mock_get_oss):
        mock_oss = self._patch_get_oss()
        mock_get_oss.return_value = mock_oss

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "unsupported_format")
        mock_oss.delete_file.assert_called_once()

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime")
    @patch("apps.services.docparse.temp_parse_api.TEMP_PARSE_SYNC_TIMEOUT_SECONDS", 0.5)
    def test_short_timeout_with_blocking_parser_triggers_parse_timeout(
        self, mock_get_parser, mock_get_oss,
    ):
        """**W3.1 收尾 L55 改造后**：原版本用 instant mock parser + timeout=0 测
        timeout 兼容 post-parse elapsed 检查（任何 elapsed > 0 都触发）。
        ThreadPoolExecutor 真中断后必须用**真阻塞** parser 才能触发 timeout
        （mock instant return 不会撞 future.result(timeout) 的 TimeoutError）。

        timeout=0.5s + parser 阻塞 2.0s → endpoint 在 ~0.5s 内返 parse_timeout，
        不等 parser 完成。同时也仍 delete OSS（finally 兜底）。
        """
        import time as _time

        mock_oss = self._patch_get_oss()
        mock_get_oss.return_value = mock_oss

        mock_parser_cls = MagicMock()
        def slow_parse(local_path):  # noqa: ARG001
            _time.sleep(2.0)
            return _make_fake_parse_result()
        mock_parser_cls.return_value.parse.side_effect = slow_parse
        mock_get_parser.return_value = mock_parser_cls

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "parse_timeout")
        # 即便 timeout 也仍然 delete OSS（finally 兜底不回归）
        mock_oss.delete_file.assert_called_once()


# ────────────────────────────────────────────────────────────────────
# **W3.1 收尾 L55（2026-05-13）**：ThreadPoolExecutor 真中断超时钉死
#
# 原版本 timeout 检查是 post-parse elapsed（parser.parse() 同步阻塞返
# 回**后**才判超时），一份 60s 的 zip-bomb PPTX 让 endpoint 阻塞 60s，
# gunicorn worker 全程被占——production worker pool DoS 攻击面。
#
# 修复后用 `concurrent.futures.ThreadPoolExecutor` + `future.result(timeout=...)`，
# endpoint 在 timeout 时立即返回 PARSE_TIMEOUT envelope，gunicorn worker
# 立即释放（thread 仍跑直到自然结束 + GC，是 thread leak 但 worker pool
# 不被打死）。
#
# 钉死项：
#   1. parser.parse 阻塞 5s + TEMP_PARSE_SYNC_TIMEOUT_SECONDS=1.0 →
#      endpoint 在 ~1s 内返 parse_timeout（不是 5s 后才返）
#   2. 反向：完整 5s 阻塞下 endpoint 真实耗时 < 3s（远小于 5s）
#   3. timeout 后 OSS delete 仍调（finally 兜底）
# ────────────────────────────────────────────────────────────────────


class ParseSyncTempThreadPoolTimeoutTest(SimpleTestCase):
    """L55：ThreadPoolExecutor 真中断 — endpoint 在 timeout 内返回不阻塞 worker"""

    def _patch_get_oss_with_zip(self):
        mock = MagicMock()

        def fake_download(object_key, local_path=None):
            with zipfile.ZipFile(local_path, "w") as zf:
                zf.writestr("ppt/presentation.xml", "<x/>")
            return {"success": True, "data": {}}

        mock.download_file.side_effect = fake_download
        mock.delete_file.return_value = {"success": True, "data": {}}
        return mock

    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime")
    @patch("apps.services.docparse.temp_parse_api.TEMP_PARSE_SYNC_TIMEOUT_SECONDS", 1.0)
    def test_blocking_parser_returns_timeout_within_timeout_window_not_after(
        self, mock_get_parser, mock_get_oss,
    ):
        """**关键**：parser 阻塞 5s + timeout=1s → endpoint 必须 < 3s 内返
        parse_timeout，不能等 5s 全跑完。

        endpoint 真实耗时 < 5s 钉死 ThreadPoolExecutor `future.result(timeout=)`
        + `executor.shutdown(wait=False)` 真生效；如果回归到原 post-parse
        elapsed 检查，endpoint 会等 5s 全跑完才返回，本测试立即失败。
        """
        import time as _time

        mock_oss = self._patch_get_oss_with_zip()
        mock_get_oss.return_value = mock_oss

        # parser 阻塞 5s（模拟 zip-bomb / 复杂 PPTX）
        BLOCKING_SECONDS = 5.0
        mock_parser_cls = MagicMock()
        def slow_parse(local_path):  # noqa: ARG001
            _time.sleep(BLOCKING_SECONDS)
            return _make_fake_parse_result()
        mock_parser_cls.return_value.parse.side_effect = slow_parse
        mock_get_parser.return_value = mock_parser_cls

        t0 = _time.monotonic()
        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )
        elapsed = _time.monotonic() - t0

        # **核心断言 1**：endpoint 在 timeout 内返回（< 3s 远小于 5s parser 阻塞）
        self.assertLess(
            elapsed, 3.0,
            msg=(
                f"L55 回归：endpoint 阻塞 {elapsed:.1f}s 等待 parser，"
                f"应 < 3s（timeout=1s + ThreadPool 立即返回）。"
                f"如果 ≥ 5s 说明回归到 post-parse elapsed 检查，"
                f"gunicorn worker 全程阻塞 → production DoS"
            ),
        )

        # **核心断言 2**：返 parse_timeout envelope
        self.assertFalse(result["success"])
        self.assertEqual(result["failure_code"], "parse_timeout")

        # **核心断言 3**：timeout 后仍主动 delete OSS object（finally 兜底不回归）
        mock_oss.delete_file.assert_called_once()


# ────────────────────────────────────────────────────────────────────
# **W3.1 收尾 L50（2026-05-13）**：rate limit 钉死
# ────────────────────────────────────────────────────────────────────


class ParseSyncTempRateLimitTest(SimpleTestCase):
    """L50：每用户 30/min，超出返 NETWORK_ERROR envelope"""

    @patch("apps.services.docparse.temp_parse_api.cache_is_rate_limited")
    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime")
    def test_RATE_LIMIT_triggered_returns_network_failed_envelope(
        self, mock_get_parser, mock_get_oss, mock_rate_limit,
    ):
        # 模拟超 30/min → limited / count=31 / ttl=42
        mock_rate_limit.return_value = (True, 31, 42)
        mock_oss = MagicMock()
        mock_get_oss.return_value = mock_oss

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertFalse(result["success"])
        # 13 类 SSoT 复用 NETWORK_ERROR
        self.assertEqual(result["failure_code"], "network_failed")
        self.assertIn("频率超限", result["message"])
        self.assertIn("42", result["message"])

        # **反向**：rate limit 触发后**不**调 OSS download（短路在 rate check）
        mock_oss.download_file.assert_not_called()
        mock_oss.delete_file.assert_not_called()
        # 不调 parser（因为根本没到 parser 阶段）
        mock_get_parser.assert_not_called()

        # 调 cache 仅 1 次
        self.assertEqual(mock_rate_limit.call_count, 1)
        rl_call = mock_rate_limit.call_args
        self.assertEqual(rl_call.args[0], "docparse_temp_parse_sync")
        self.assertTrue(rl_call.args[1].startswith("user:"))
        from apps.services.docparse.temp_parse_api import (
            TEMP_PARSE_SYNC_RATE_LIMIT,
            TEMP_PARSE_RATE_WINDOW_SECONDS,
        )
        self.assertEqual(rl_call.args[2], TEMP_PARSE_SYNC_RATE_LIMIT)
        self.assertEqual(rl_call.args[3], TEMP_PARSE_RATE_WINDOW_SECONDS)

    @patch("apps.services.docparse.temp_parse_api.cache_is_rate_limited")
    @patch("apps.services.docparse.temp_parse_api.get_oss_service")
    @patch("apps.services.docparse.parsers.registry.get_parser_for_mime")
    def test_RATE_LIMIT_not_triggered_passes_through_to_parse(
        self, mock_get_parser, mock_get_oss, mock_rate_limit,
    ):
        mock_rate_limit.return_value = (False, 1, 60)

        # 用 _patch_get_oss_with_zip 同款 mock
        mock = MagicMock()
        def fake_download(object_key, local_path=None):
            with zipfile.ZipFile(local_path, "w") as zf:
                zf.writestr("ppt/presentation.xml", "<x/>")
            return {"success": True, "data": {}}
        mock.download_file.side_effect = fake_download
        mock.delete_file.return_value = {"success": True, "data": {}}
        mock_get_oss.return_value = mock

        mock_parser_cls = MagicMock()
        mock_parser_cls.return_value.parse.return_value = _make_fake_parse_result()
        mock_get_parser.return_value = mock_parser_cls

        result = parse_sync_temp(
            _make_request(),
            ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
        )

        self.assertTrue(result["success"], msg=f"got: {result}")
        # 走完整链路：download → parse → delete
        mock.download_file.assert_called_once()
        mock.delete_file.assert_called_once()


# ────────────────────────────────────────────────────────────────────
# 红线：所有持久化模型 0 条新增
# ────────────────────────────────────────────────────────────────────


class ParseSyncTempRedLineTest(SimpleTestCase):
    """**最关键的红线**：临时通道**绝对不**触碰任何持久化模型表"""

    def test_RED_LINE_persistent_managers_not_called_across_all_paths(self):
        """**红线**：用 mock manager 拦截所有持久化模型写入。

        把 ParsedDocument / DocumentPage / DocumentChunk / FileRecord / FileUsage
        的 `.objects` manager / `.add_usage` 方法换成会 raise 的 mock，跑完
        所有 endpoint 路径后断言这些 mock 都没被调过。
        """
        from apps.services.docparse.models import (
            DocumentChunk,
            DocumentPage,
            ParsedDocument,
        )
        from apps.services.oss.models import FileRecord, FileUsage

        boom_objects = MagicMock()
        boom_objects.create.side_effect = AssertionError("RED LINE：临时通道写持久化模型")
        boom_objects.update_or_create.side_effect = AssertionError("RED LINE：临时通道写持久化模型")
        boom_objects.bulk_create.side_effect = AssertionError("RED LINE：临时通道 bulk 写")
        # filter / get / first 不阻断（可能是 _classify_exception 内部用？实际没用，
        # 但为了避免误伤把 query 类放过去）
        boom_objects.filter.return_value = MagicMock()

        with patch("apps.services.docparse.temp_parse_api.get_oss_service") as mock_get_oss, \
             patch("apps.services.docparse.parsers.registry.get_parser_for_mime") as mock_get_parser, \
             patch.object(ParsedDocument, "objects", boom_objects), \
             patch.object(DocumentPage, "objects", boom_objects), \
             patch.object(DocumentChunk, "objects", boom_objects), \
             patch.object(FileRecord, "objects", boom_objects), \
             patch.object(FileUsage, "add_usage", side_effect=AssertionError("RED LINE：FileUsage.add_usage")):

            mock_oss = MagicMock()
            mock_oss.delete_file.return_value = {"success": True, "data": {}}

            def fake_download(object_key, local_path=None):
                with zipfile.ZipFile(local_path, "w") as zf:
                    zf.writestr("ppt/presentation.xml", "<x/>")
                return {"success": True, "data": {}}

            mock_oss.download_file.side_effect = fake_download
            mock_get_oss.return_value = mock_oss

            mock_parser_cls = MagicMock()
            mock_parser_cls.return_value.parse.return_value = _make_fake_parse_result()
            mock_get_parser.return_value = mock_parser_cls

            for _ in range(5):
                parse_sync_temp(
                    _make_request(),
                    ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
                )

            # 失败路径
            mock_parser_cls.return_value.parse.side_effect = zipfile.BadZipFile("not a zip")
            mock_parser_cls.return_value.parse.return_value = None
            for _ in range(3):
                parse_sync_temp(
                    _make_request(),
                    ParseSyncTempRequest(temp_object_key=_valid_temp_key(), mime_type=PPTX_MIME),
                )

            # invalid 路径
            for _ in range(3):
                parse_sync_temp(
                    _make_request(),
                    ParseSyncTempRequest(temp_object_key="chat/attachments/x.pptx", mime_type=PPTX_MIME),
                )

        # **断言**：所有写入方法都没被调过
        boom_objects.create.assert_not_called()
        boom_objects.update_or_create.assert_not_called()
        boom_objects.bulk_create.assert_not_called()

    def test_RED_LINE_module_does_not_import_persistent_writes(self):
        """**红线**：temp_parse_api 模块不能 import 持久通道核心服务。

        用 `tokenize` 跳过 docstring / comment，只检查真实代码 token。
        （docstring 里 "绝不调 parse_async" 这类描述应被忽略）
        """
        import apps.services.docparse.temp_parse_api as mod

        forbidden = [
            # 持久化模型写入
            "_persist_one_page",
            "_finalize_document",
            # Celery 队列
            "parse_async",
            "parse_document_task",
            # RAG 索引
            "trigger_rag_index",
            "_trigger_rag_index",
            # 持久通道事件推送
            "_emit_completed",
            "_emit_failed",
            "publish_parse_completed",
            "publish_parse_failed",
            # FileRecord / FileUsage 写入
            "FileRegistryService",
            "register_uploaded_file",
        ]

        code_tokens = _extract_code_tokens(mod.__file__)
        for word in forbidden:
            self.assertNotIn(
                word, code_tokens,
                msg=f"红线：parse-sync-temp 不能在代码里引用 {word}（docstring / comment 提及不算）",
            )


if __name__ == "__main__":
    unittest.main()

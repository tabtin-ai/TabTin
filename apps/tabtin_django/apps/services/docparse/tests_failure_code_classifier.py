"""
W1.4 收尾：`_classify_exception_to_failure_code` 启发式分类器单测

为什么要补这套测试：
  - W1 引入 13 类全局 ErrorCode（@tabtin/file-pipeline-errors SSoT），后端
    `_classify_exception_to_failure_code` 是这条链路的源头——根据后端解析过程
    抛出的异常 message / type name 映射到 13 类之一。
  - 该函数 14 条 if 分支 phrase **顺序敏感**（"etimedout" 含 "timeout" 子串
    靠 PARSE_TIMEOUT 在 NETWORK_ERROR 之前命中；类似 "is not a zip file" 含
    "file" 不能误判为 FILE_NOT_FOUND），任意 phrase 笔误 / 分支顺序错位都会让
    13 类失败 UX 链路在源头错乱。
  - W1.3 fix-6 加 `zipfile.BadZipFile` 没有补对应单测——该缺口被 harness 第
    4 轮独立 Review 抓到，登记 §七 L30，本期补齐。

测试覆盖（共 ≥ 19 个 case）：
  1. 13 类正向 case：每个 FailureCode 用一条 representative exception 打中
  2. 4 个关键易混淆负向 case（W1.1 / W1.3 修复行为钉死）：
     - `"fetch corrupt stream"` 不应是 CORRUPTED（要的是 UNKNOWN_ERROR）
     - `"RetryableUploadAbortedException"` 不应是 USER_ABORTED（要的是 UNKNOWN_ERROR）
     - `"etimedout"` 含 "timeout" 子串 → 仍是 PARSE_TIMEOUT 而不是 NETWORK_ERROR
     - `zipfile.BadZipFile` 实例 → CORRUPTED（W1.3 fix-6 行为钉死）
  3. 1 个 SSoT 对齐 case：所有上述返回值都在 `ParsedDocument.FailureCode` 13
     类枚举内（防止该函数返回未注册 enum 字面值）

跑通命令：
  cd apps/tabtin_django && python manage.py test \
      apps.services.docparse.tests_failure_code_classifier
"""
from __future__ import annotations

import unittest
import zipfile

from unittest.mock import patch

from apps.services.docparse.models import ParsedDocument
from apps.services.docparse.service import (
    _classify_exception_to_failure_code,
    _classify_high_failure_pdf_failure_code,
    _pdf_high_failure_threshold_hit,
)


class _Custom(Exception):
    """供"name 严格匹配"分支用的占位异常类——在 case 中按需重命名。"""


def _make_named_exception(class_name: str, message: str = '') -> Exception:
    """动态构造一个带指定 type name 的异常实例（用于 USER_ABORTED 等 name-only 分支）。"""
    cls = type(class_name, (Exception,), {})
    return cls(message)


# ────────────────────────────────────────────────────────────────────
# W3 Review 1 H2 修复钉死：PPTX parser 中文 ValueError 5 类正确分类
# ────────────────────────────────────────────────────────────────────


class W3PptxChineseValueErrorClassifierTests(unittest.TestCase):
    """钉死 PPTX parser (pptx_parser.py:282-307) 抛的中文 ValueError 5 类
    正确归入对应 FailureCode（不再 fallback UNKNOWN_ERROR）。"""

    def test_pptx_oversize_chinese_msg(self):
        exc = ValueError("PPTX 文件过大（150.0 MB），上限 200 MB")
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_TOO_LARGE,
        )

    def test_pptx_uncompressed_oversize_chinese_msg(self):
        exc = ValueError("PPTX 解压后体积过大（3000.0 MB），上限 2048 MB")
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_TOO_LARGE,
        )

    def test_pptx_invalid_zip_chinese_msg(self):
        exc = ValueError("文件不是有效的 PPTX/ZIP 格式")
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_pptx_zip_entries_chinese_msg(self):
        exc = ValueError("PPTX 内部条目数过多（20000），上限 10000")
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_pptx_zip_bomb_chinese_msg(self):
        exc = ValueError("PPTX 压缩比异常（500:1），疑似 zip-bomb，上限 100:1")
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_pptx_legacy_ppt_chinese_msg(self):
        exc = ValueError("不支持旧版 .ppt 格式，请将文件转换为 .pptx 后重新上传")
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.UNSUPPORTED_FORMAT,
        )


# ────────────────────────────────────────────────────────────────────
# 13 类正向 case：每类至少 1 个 representative exception
# ────────────────────────────────────────────────────────────────────


class FailureCodeClassifier_13Categories_Tests(unittest.TestCase):
    """每个 FailureCode 至少 1 条 representative exception 命中"""

    def test_encrypted_via_password_in_message(self):
        # PDF 加密 → pdfjs / fitz 抛 PasswordException / "password required"
        exc = ValueError('PDF requires a password to open')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.ENCRYPTED,
        )

    def test_encrypted_via_password_in_exception_name(self):
        # PyPDF2 / pdfplumber 直接抛 PasswordError 类
        exc = _make_named_exception('PdfPasswordError', 'unable to decrypt')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.ENCRYPTED,
        )

    def test_parse_timeout_via_celery_soft_time_limit(self):
        # Celery soft timeout（最常见的 PARSE_TIMEOUT 触发）
        exc = _make_named_exception('SoftTimeLimitExceeded', '')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.PARSE_TIMEOUT,
        )

    def test_parse_timeout_via_timed_out_in_message(self):
        # 通用 "operation timed out" 措辞
        exc = TimeoutError('parsing operation timed out after 600s')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.PARSE_TIMEOUT,
        )

    def test_user_aborted_via_strict_name_match(self):
        # USER_ABORTED 用 name 严格匹配（不裸 'abort' / 'cancel' 防误判）
        exc = _make_named_exception('AbortError', 'task was aborted')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.USER_ABORTED,
        )

    def test_user_aborted_via_canceled_file_error(self):
        exc = _make_named_exception('CanceledFileError', '')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.USER_ABORTED,
        )

    def test_user_aborted_via_worker_task_aborted_error(self):
        """W1.4 收尾 Review 1 MID-2 补：第二个 USER_ABORTED 字面值
        `workertaskabortederror` 钉死覆盖。

        生产中 Celery worker 主动 abort 子任务时高频抛 `WorkerTaskAbortedError`
        异常。原测试只覆盖 `aborterror` 和 `canceledfileerror` 两个字面值，
        如果有人误改 service.py 把 `'workertaskabortederror'` typo 为
        `'workertaskaborter'` 或 `'workertaskabortexception'`，现有 case 都不
        会发现。本 case 单独钉死该字面值。
        """
        exc = _make_named_exception('WorkerTaskAbortedError', 'task aborted by worker')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.USER_ABORTED,
        )

    def test_unsupported_format_via_unsupported_file(self):
        # xlsx 老格式 / 未知 mime → "unsupported file"
        exc = ValueError('Unsupported file type for xlsx_parser: .xls')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.UNSUPPORTED_FORMAT,
        )

    def test_unsupported_format_via_unsupported_zip(self):
        # 旧 PPTX / .ppt 二进制 ZIP 不识别
        exc = ValueError('Unsupported ZIP container: missing presentation.xml')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.UNSUPPORTED_FORMAT,
        )

    def test_unsupported_format_via_generic_not_supported(self):
        # mime guess 失败 / 真二进制
        exc = ValueError('Format not supported: application/octet-stream')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.UNSUPPORTED_FORMAT,
        )

    def test_corrupted_via_invalid_pdf(self):
        # PyPDF2 / fitz 抛 "Invalid PDF header" 等
        exc = ValueError('Invalid PDF: missing xref table')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_corrupted_via_pdf_header_in_message(self):
        exc = ValueError('Bad PDF header byte at offset 0x42')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_corrupted_via_specific_corrupt_phrase(self):
        # "corrupt (workbook|sheet|pdf|file|zip|document)" 严格 phrase
        for phrase in ('corrupt workbook', 'corrupt sheet', 'corrupt pdf',
                       'corrupt file', 'corrupt zip', 'corrupt document'):
            with self.subTest(phrase=phrase):
                exc = ValueError(f'Detected: {phrase} during parse')
                self.assertEqual(
                    _classify_exception_to_failure_code(exc),
                    ParsedDocument.FailureCode.CORRUPTED,
                )

    def test_corrupted_via_zipfile_badzipfile_instance(self):
        """W1.3 fix-6 钉死：zipfile.BadZipFile 实例 → CORRUPTED

        python-docx / openpyxl 在 docx/xlsx 文件结构损坏时高频外抛此异常，
        其 message 通常是 "File is not a zip file" —— 旧版本既不命中
        "not a valid zip" 也不命中 "corrupt (...)"，会 fallback 到
        UNKNOWN_ERROR；W1.3 加了 `name == "badzipfile"` 兜底。
        """
        exc = zipfile.BadZipFile('File is not a zip file')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_corrupted_via_not_a_valid_zip(self):
        exc = ValueError('not a valid zip file')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_corrupted_via_is_not_a_zip_file(self):
        # zipfile.BadZipFile 在 message 上的常见措辞（防止被 FILE_NOT_FOUND 误吸）
        exc = ValueError('File is not a zip file')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_file_not_found_via_enoent(self):
        # OSS 下载后本地 fs 不存在
        exc = FileNotFoundError('[Errno 2] ENOENT: no such file or directory: /tmp/x.pdf')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_NOT_FOUND,
        )

    def test_file_not_found_via_no_such_file(self):
        exc = OSError('no such file at path /tmp/missing.pdf')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_NOT_FOUND,
        )

    def test_permission_denied_via_eacces(self):
        # 工作区外 / 沙箱拒绝
        exc = PermissionError('[Errno 13] EACCES: permission denied: /etc/shadow')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.PERMISSION_DENIED,
        )

    def test_permission_denied_via_eperm(self):
        exc = PermissionError('EPERM: operation not permitted')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.PERMISSION_DENIED,
        )

    def test_scanned_pdf_via_message(self):
        # 扫描件检测显式标记
        exc = RuntimeError('PDF is scanned (no text layer)')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.SCANNED_PDF,
        )

    def test_garbled_text_layer_via_underscore_token(self):
        exc = RuntimeError('garbled_text_layer detected (quality 0.12)')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.GARBLED_TEXT_LAYER,
        )

    def test_garbled_text_layer_via_human_phrase(self):
        exc = RuntimeError('garbled text layer detected')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.GARBLED_TEXT_LAYER,
        )

    def test_file_too_large_via_too_large(self):
        exc = ValueError('file too large: 120MB exceeds 100MB limit')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_TOO_LARGE,
        )

    def test_file_too_large_via_exceeds_maximum(self):
        exc = ValueError('size exceeds maximum allowed of 50MB')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_TOO_LARGE,
        )

    def test_file_too_large_via_oversize(self):
        exc = ValueError('oversize: 200MB')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.FILE_TOO_LARGE,
        )

    def test_network_error_via_network_phrase(self):
        # OSS 下载断 / DNS 失败
        exc = ConnectionError('network unreachable: getaddrinfo failed')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.NETWORK_ERROR,
        )

    def test_network_error_via_econnrefused(self):
        exc = ConnectionRefusedError('ECONNREFUSED: connection refused on 443')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.NETWORK_ERROR,
        )

    def test_network_error_via_enotfound(self):
        exc = OSError('ENOTFOUND oss.example.com')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.NETWORK_ERROR,
        )

    def test_network_error_via_connection_word(self):
        exc = ConnectionError('connection reset by peer')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.NETWORK_ERROR,
        )

    def test_invalid_parameter_falls_to_unknown_when_no_phrase(self):
        """INVALID_PARAMETER 在 fallback 链路里不命中——后端用 422 / DRF
        validation 直接回，不会进 _classify_exception_to_failure_code。

        本测试确认：纯 'invalid parameter' message **不会**被分类器主动归到
        INVALID_PARAMETER（设计取舍：参数错应在请求层早早返回，不该走解析异常
        分类器）；走 fallback UNKNOWN_ERROR 是正确的。
        """
        exc = ValueError('invalid parameter: missing field foo')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.UNKNOWN_ERROR,
        )

    def test_unknown_error_for_completely_opaque_exception(self):
        # 既不命中任何 phrase 也不是 known name
        exc = RuntimeError('weird internal failure 0xDEADBEEF')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.UNKNOWN_ERROR,
        )


# ────────────────────────────────────────────────────────────────────
# 关键易混淆负向 case（W1.1 / W1.3 修复行为钉死）
# ────────────────────────────────────────────────────────────────────


class FailureCodeClassifier_NegativeEdgeCases_Tests(unittest.TestCase):
    """钉死分支顺序敏感性 + W1.1/W1.3 fix 不被回归"""

    def test_fetch_corrupt_stream_is_not_corrupted(self):
        """W1.1 fix：'fetch corrupt stream' 等网络失败措辞**不应**误判为 CORRUPTED。

        旧实现裸 'corrupt' phrase 会把网络错误 message 归类为文件损坏，导致
        Agent 提示用户"重新导出文件"——但实际是网络问题。新实现要求严格 phrase
        组合 `corrupt (workbook|sheet|pdf|file|zip|document)`，单独 "corrupt
        stream" 不命中。

        **W1.4 收尾 Review 3 LOW-3 修复**：'fetch corrupt stream' 既不含
        `corrupt (workbook|sheet|pdf|file|zip|document)` 严格 phrase，也不含
        network / connection / econnrefused / enotfound 等 phrase →
        实际 fallback 到 UNKNOWN_ERROR。本测试只钉死"不是 CORRUPTED"
        （W1.1 fix 的核心承诺），不约束 fallback 走哪条路径。
        """
        exc = RuntimeError('fetch corrupt stream from upstream')
        self.assertNotEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_retryable_upload_aborted_exception_is_not_user_aborted(self):
        """W1.1 fix：`RetryableUploadAbortedException` 等异常 name 含 'abort'
        但不是用户主动取消——是上传重试机制内部状态，不应误判 USER_ABORTED。

        新实现用严格 name 匹配 (aborterror / workertaskabortederror /
        canceledfileerror)，不裸匹配 'abort' / 'cancel'。
        """
        exc = _make_named_exception('RetryableUploadAbortedException', 'upload retry aborted')
        self.assertNotEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.USER_ABORTED,
        )

    def test_etimedout_with_timed_out_phrase_resolves_to_parse_timeout(self):
        """分支顺序敏感性钉死：含 'timed out' 子串的 message 必须命中
        PARSE_TIMEOUT 分支（在 NETWORK_ERROR 之前）。

        当前 service.py:647 分支顺序让 PARSE_TIMEOUT 比 NETWORK_ERROR 先匹配。
        如果未来有人改顺序把 NETWORK_ERROR 提前，会让 LLM 给出"网络重试"建议
        而非"文件过大需要拆分"建议——本 case 钉死该顺序。

        **W1.4 收尾 Review 1 MID-1 修复**：原测试名 `test_etimedout_...` 暗示
        裸 'ETIMEDOUT' 命中 PARSE_TIMEOUT，但实际命中靠的是 'timed out' 子串
        （含空格）。重命名为 `test_etimedout_with_timed_out_phrase_...` 反映
        真实命中路径；裸 ETIMEDOUT 的行为另由 `test_naked_etimedout_...` 钉死。
        """
        exc = OSError('ETIMEDOUT: socket operation timed out')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.PARSE_TIMEOUT,
        )

    def test_naked_etimedout_without_timed_out_phrase_falls_back_to_unknown(self):
        """W1.4 收尾 Review 1 MID-1 补：纯 'ETIMEDOUT' 不含 'timed out' 子串
        时分类器实际行为钉死。

        当前 service.py: NETWORK_ERROR 分支匹配 `'network'/'connection'/
        'econnrefused'/'enotfound'`，**不含 'etimedout'**；PARSE_TIMEOUT 分支
        要求 'timed out' / 'softtimelimitexceeded' / 'timeoutexception'，
        **也不含裸 'etimedout'**。所以裸 ETIMEDOUT message 实际 fallback 到
        UNKNOWN_ERROR——本 case 钉死该行为。

        如果未来扩展 NETWORK 分支加入 'etimedout' phrase（合理但需配套调顺序），
        本测试会立即 fail，强制改测试反映新意图。
        """
        exc = OSError('ETIMEDOUT')
        # 当前实际走 UNKNOWN_ERROR fallback——不是 PARSE_TIMEOUT 也不是 NETWORK_ERROR
        result = _classify_exception_to_failure_code(exc)
        self.assertEqual(result, ParsedDocument.FailureCode.UNKNOWN_ERROR)
        self.assertNotEqual(result, ParsedDocument.FailureCode.PARSE_TIMEOUT)
        self.assertNotEqual(result, ParsedDocument.FailureCode.NETWORK_ERROR)

    def test_zipfile_bad_zip_file_real_instance_resolves_to_corrupted(self):
        """W1.3 fix-6 钉死：真实 `zipfile.BadZipFile` 实例（不是 mock 字符串
        message）走 name 检测分支命中 CORRUPTED。

        python-docx / openpyxl 高频外抛此异常，其 message "File is not a
        zip file" 既不含 "not a valid zip"（缺 'valid'）也不含
        "corrupt (workbook|sheet|...)"。如果不靠 name 检测会 fallback
        UNKNOWN_ERROR，用户拿不到"文件损坏，请重新导出"的精确指引。
        """
        exc = zipfile.BadZipFile('File is not a zip file')
        # type(exc).__name__.lower() == 'badzipfile'
        self.assertEqual(type(exc).__name__.lower(), 'badzipfile')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )


class FailureCodeClassifier_W2_L22_Tests(unittest.TestCase):
    """**W2 L22（2026-05-13）补**：PyMuPDF / pdfplumber / Celery 三类生产高频异常分类。

    旧版本三类全 fallback UNKNOWN_ERROR，LLM 拿不到精确指引（CORRUPTED 引导用户
    重新导出文件 / PARSE_TIMEOUT 引导用户拆小文件）。本套测试钉死新增分支行为。
    """

    def test_pymupdf_fz_error_format_resolves_to_corrupted(self):
        """PyMuPDF (fitz) 解析底层 mupdf 报错，name 形如 `FzErrorFormat`/
        `FzErrorGeneric`——本测试用动态构造异常 name 钉死 'fzerror' 子串检测分支。

        典型场景：PDF xref 表损坏 / startxref 偏移错 / 流对象长度不一致。
        """
        exc = _make_named_exception('FzErrorFormat', 'cannot find startxref')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_pymupdf_fz_error_generic_resolves_to_corrupted(self):
        exc = _make_named_exception('FzErrorGeneric', 'mupdf: format error in pdf')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_pdfplumber_pdf_syntax_error_resolves_to_corrupted(self):
        """pdfplumber/pdfminer 在 PDF 解析层抛 PDFSyntaxError——
        覆盖 EOF marker 缺失 / xref table 损坏等场景。"""
        exc = _make_named_exception('PDFSyntaxError', 'No /Root object found')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_celery_hard_time_limit_exceeded_resolves_to_parse_timeout(self):
        """Celery 硬时限 `TimeLimitExceeded`（SIGKILL）—— 与 SoftTimeLimitExceeded
        同样归 PARSE_TIMEOUT，让用户拿到"建议拆小文件"指引而非困惑的 UNKNOWN。"""
        exc = _make_named_exception('TimeLimitExceeded', 'task hard time limit (300s)')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.PARSE_TIMEOUT,
        )

    def test_pdf_format_error_phrase_resolves_to_corrupted(self):
        """常规 'format error in pdf' message → CORRUPTED（不靠 name，靠 phrase）。"""
        exc = RuntimeError('mupdf format error in pdf at offset 0x1234')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )

    def test_cannot_find_trailer_phrase_resolves_to_corrupted(self):
        exc = RuntimeError('cannot find trailer dict')
        self.assertEqual(
            _classify_exception_to_failure_code(exc),
            ParsedDocument.FailureCode.CORRUPTED,
        )


# ────────────────────────────────────────────────────────────────────
# SSoT 对齐：所有返回值必在 ParsedDocument.FailureCode 13 类枚举内
# ────────────────────────────────────────────────────────────────────


# ────────────────────────────────────────────────────────────────────
# representative exceptions：每个 FailureCode 一条 representative exception
# ————————————————————————————————————————————
# **W1.4 收尾 Review 1 LOW-1 / Review 2 MID-2 / Review 3 MID-2 抽公共 fixture**：
# 上面 13 类正向 case 各自手写了 representative exception；这里抽一份"映射表"
# 同时给 enum-边界检查（A）和 enum-完整性检查（B）共用，避免双源维护。
#
# **设计取舍**：INVALID_PARAMETER 故意 unreachable —— 设计上参数错应走请求层
# 早早返回（DRF 422 / Django ChoicesField validation），不该走解析异常分类器。
# 任何"_classify_exception_to_failure_code 内不应主动返回 INVALID_PARAMETER"
# 的承诺由 `intentionally_unreachable_codes` 集合显式声明。
# ────────────────────────────────────────────────────────────────────

REPRESENTATIVE_EXCEPTIONS: dict[str, Exception] = {
    ParsedDocument.FailureCode.FILE_NOT_FOUND: FileNotFoundError('no such file: x.pdf'),
    ParsedDocument.FailureCode.FILE_TOO_LARGE: ValueError('file too large'),
    ParsedDocument.FailureCode.PERMISSION_DENIED: PermissionError('permission denied'),
    ParsedDocument.FailureCode.ENCRYPTED: ValueError('PDF requires a password'),
    ParsedDocument.FailureCode.CORRUPTED: zipfile.BadZipFile('File is not a zip file'),
    ParsedDocument.FailureCode.SCANNED_PDF: RuntimeError('PDF is scanned'),
    ParsedDocument.FailureCode.GARBLED_TEXT_LAYER: RuntimeError('garbled_text_layer'),
    ParsedDocument.FailureCode.UNSUPPORTED_FORMAT: ValueError('Unsupported file type'),
    ParsedDocument.FailureCode.PARSE_TIMEOUT: TimeoutError('operation timed out'),
    ParsedDocument.FailureCode.USER_ABORTED: _make_named_exception('AbortError', ''),
    ParsedDocument.FailureCode.NETWORK_ERROR: ConnectionError('network unreachable'),
    ParsedDocument.FailureCode.UNKNOWN_ERROR: RuntimeError('opaque mystery 0xDEADBEEF'),
    # INVALID_PARAMETER 故意 unreachable（见上面 fixture 注释）
}

# 显式 unreachable 集合：分类器不应主动返回这些 enum，全部由请求层校验
INTENTIONALLY_UNREACHABLE_CODES: frozenset[str] = frozenset({
    ParsedDocument.FailureCode.INVALID_PARAMETER,
})


class FailureCodeClassifier_SSoTAlignment_Tests(unittest.TestCase):
    """钉死分类器与 SSoT 13 类的双向同步契约"""

    def test_all_classifier_outputs_are_valid_failure_code_values(self):
        """**enum-边界检查**：对 12 个 representative exceptions 跑分类器，断言
        每个返回值都在 `ParsedDocument.FailureCode.values` 集合内（防止函数返
        回未注册字面值——SSoT 端会被 Django choices validation / TS
        `isFilePipelineErrorCode` type guard 拒绝）。

        **本测试只校验 enum 边界**（输出是否在 13 类内），不校验语义正确性
        ——后者由各类的正向 case 各自覆盖；新 enum 加分支但 typo 字面值的
        bug 由本测试捕获。
        """
        valid_values = set(ParsedDocument.FailureCode.values)
        for expected_code, exc in REPRESENTATIVE_EXCEPTIONS.items():
            with self.subTest(exception=type(exc).__name__, message=str(exc)):
                code = _classify_exception_to_failure_code(exc)
                self.assertIn(
                    code, valid_values,
                    f'{type(exc).__name__}({exc!r}) → {code!r} 不在 FailureCode 13 类内',
                )

    def test_each_failure_code_is_reachable_by_some_representative_exception(self):
        """**enum-完整性检查**：13 类 FailureCode 中每一个（除 INVALID_PARAMETER
        外）都被至少一个 representative exception 命中。

        **W1.4 收尾 Review 2 MID-2 / Review 3 MID-2 必修**：如果未来加新
        FailureCode（如 `RATE_LIMITED`）但**忘了在
        `_classify_exception_to_failure_code` 加分支** —— 现有 12 个 representative
        exception 仍合法（在新的 14 类内），新 enum 永远不被分类器命中，
        enum-边界检查 silently pass。本测试强制每加 1 个新 FailureCode 时同步：
          1. 在 service.py `_classify_exception_to_failure_code` 加分支
          2. 在 REPRESENTATIVE_EXCEPTIONS dict 加 1 entry
          3. 或在 INTENTIONALLY_UNREACHABLE_CODES 显式声明 unreachable 设计
        """
        all_failure_codes = set(ParsedDocument.FailureCode.values)
        actually_reachable = {
            _classify_exception_to_failure_code(exc)
            for exc in REPRESENTATIVE_EXCEPTIONS.values()
        }
        uncovered = all_failure_codes - actually_reachable - INTENTIONALLY_UNREACHABLE_CODES
        self.assertEqual(
            uncovered, set(),
            f'未被任何 representative exception 命中的 FailureCode: {uncovered}\n'
            f'—— 新增 enum 时同步 (1) 在 service.py 加分类器分支 '
            f'(2) 在 REPRESENTATIVE_EXCEPTIONS dict 加 entry，'
            f'或 (3) 在 INTENTIONALLY_UNREACHABLE_CODES 显式标记 unreachable',
        )

    def test_intentionally_unreachable_codes_truly_unreachable(self):
        """钉死"故意不可达"承诺：INVALID_PARAMETER 不应被任何 representative
        exception 命中（设计取舍：参数错走 DRF 422 / Django validation，不走
        解析异常分类器）。

        如果未来分类器**意外**开始返回 INVALID_PARAMETER，违反"参数校验在请求
        层"的设计原则——本测试 fail 强制讨论是否调整设计。
        """
        actually_reachable = {
            _classify_exception_to_failure_code(exc)
            for exc in REPRESENTATIVE_EXCEPTIONS.values()
        }
        for unreachable_code in INTENTIONALLY_UNREACHABLE_CODES:
            with self.subTest(code=unreachable_code):
                self.assertNotIn(
                    unreachable_code, actually_reachable,
                    f'{unreachable_code} 标记为 INTENTIONALLY_UNREACHABLE 但被 '
                    f'representative exception 命中——违反"参数校验在请求层"设计',
                )


# ────────────────────────────────────────────────────────────────────
# W2.1 收尾 M2：`_stream_parse_pdf` skipped_scan 占比 fallback decision
# ────────────────────────────────────────────────────────────────────
#
# 为什么补这套：
#   - W2 L23 引入 ">80% 失败 + skipped_scan 占比 >= 50% → SCANNED_PDF
#     (不是 CORRUPTED)" 决策（service.py），但当时 0 单元测试覆盖。
#     §七 L37 原本登记推到 W4——harness 第 4 轮独立 Review M2 判定本期
#     该补（D2 不留 MVP 半成品；30 分钟工作量不应推 W4）。
#   - 不 mock 整个 `_stream_parse_pdf` 链路（fitz / pdfplumber / PDFParser
#     都重）—— 把决策抽成两个 helper（`_pdf_high_failure_threshold_hit` +
#     `_classify_high_failure_pdf_failure_code`），单测只 mock
#     `DocumentChunk.objects.filter(...).count()`。
#
# 测试覆盖 task 描述的 3 个 case：
#   (1) 80% 失败 + 60% skipped_scan → SCANNED_PDF（占比 >= 50%，命中）
#   (2) 80% 失败 + 30% skipped_scan → CORRUPTED（占比 < 50%，不命中）
#   (3) 50% 失败（不到 80%）→ outer threshold helper False（不进入 fallback
#       分支），不需要 mock skipped_scan 调用就能钉死。


class _StubParsedDoc:
    """轻量 ParsedDocument stub —— `_classify_high_failure_pdf_failure_code`
    只透传给 `DocumentChunk.objects.filter(page__document=parsed_doc,...)`，
    我们 mock 掉整条 filter chain，参数原样不重要。
    """

    def __repr__(self) -> str:
        return '<StubParsedDoc>'


class PdfHighFailureThresholdHelper_Tests(unittest.TestCase):
    """钉死 outer threshold helper：80% 整不算"超过"，> 80% 才进入 fallback。"""

    def test_50pct_failed_does_not_enter_fallback_branch(self):
        # 10 页解析 5 页失败 = 50%——不进入 fallback（80% 严格大于阈值）。
        # 这是 task M2 case (3) 的钉死。
        self.assertFalse(
            _pdf_high_failure_threshold_hit(failed_pages=5, actually_parsed=10),
        )

    def test_80pct_exactly_does_not_enter_fallback(self):
        # 80% 整（10/10 -> 8）不算"超过"（> 0.8 严格大于）；91% 才算。
        # 钉死"边界值" — 否则 9/10 = 0.9 与 8/10 = 0.8 在同一行的 if 上
        # 行为微差很容易被一行 ">=" / ">" 笔误打穿。
        self.assertFalse(
            _pdf_high_failure_threshold_hit(failed_pages=8, actually_parsed=10),
        )

    def test_90pct_enters_fallback(self):
        self.assertTrue(
            _pdf_high_failure_threshold_hit(failed_pages=9, actually_parsed=10),
        )

    def test_zero_actually_parsed_does_not_enter_fallback(self):
        # 保护除零 + "全跳过"场景不进 fallback
        self.assertFalse(
            _pdf_high_failure_threshold_hit(failed_pages=0, actually_parsed=0),
        )


class HighFailurePdfFailureCodeDispatch_Tests(unittest.TestCase):
    """钉死 inner helper（已被 outer threshold 命中后的二级派发）：
    skipped_scan 占比决定 SCANNED_PDF / CORRUPTED 二选一。"""

    @patch('apps.services.docparse.service.DocumentChunk')
    def test_skipped_scan_count_at_or_above_50pct_dispatches_to_scanned_pdf(self, mock_chunk):
        # **task M2 case (1)**：80% 失败（10/10 -> 8 失败）+ 60% skipped_scan
        # （8 失败页里 5 个是 skipped_scan）→ 5 >= 8 * 0.5 = 4 → SCANNED_PDF
        mock_chunk.objects.filter.return_value.count.return_value = 5
        code = _classify_high_failure_pdf_failure_code(
            _StubParsedDoc(), failed_pages=8,
        )
        self.assertEqual(code, ParsedDocument.FailureCode.SCANNED_PDF)

    @patch('apps.services.docparse.service.DocumentChunk')
    def test_skipped_scan_count_below_50pct_dispatches_to_corrupted(self, mock_chunk):
        # **task M2 case (2)**：80% 失败 + 30% skipped_scan（8 失败页里只 2 个
        # 是 skipped_scan）→ 2 < 8 * 0.5 = 4 → CORRUPTED
        mock_chunk.objects.filter.return_value.count.return_value = 2
        code = _classify_high_failure_pdf_failure_code(
            _StubParsedDoc(), failed_pages=8,
        )
        self.assertEqual(code, ParsedDocument.FailureCode.CORRUPTED)

    @patch('apps.services.docparse.service.DocumentChunk')
    def test_zero_skipped_scan_dispatches_to_corrupted_even_when_failed_pages_zero(self, mock_chunk):
        # 边界：skipped_scan_count == 0 → 即便 failed_pages * 0.5 == 0，
        # 仍走 CORRUPTED（"> 0" 是 short-circuit 保护，0 失败 0 skipped 不应
        # 错认为 SCANNED_PDF）
        mock_chunk.objects.filter.return_value.count.return_value = 0
        code = _classify_high_failure_pdf_failure_code(
            _StubParsedDoc(), failed_pages=0,
        )
        self.assertEqual(code, ParsedDocument.FailureCode.CORRUPTED)

    @patch('apps.services.docparse.service.DocumentChunk')
    def test_skipped_scan_exactly_at_50pct_dispatches_to_scanned_pdf(self, mock_chunk):
        # 边界值钉死：skipped_scan_count == failed_pages * 0.5（等于而非严格
        # 大于）—— 当前实现用 `>= failed_pages * 0.5`，所以等于阈值也归
        # SCANNED_PDF。如果未来调整为严格 `>` 本测试 fail 强制讨论。
        mock_chunk.objects.filter.return_value.count.return_value = 4
        code = _classify_high_failure_pdf_failure_code(
            _StubParsedDoc(), failed_pages=8,
        )
        self.assertEqual(code, ParsedDocument.FailureCode.SCANNED_PDF)

    @patch('apps.services.docparse.service.DocumentChunk')
    def test_filter_call_targets_skipped_scan_source(self, mock_chunk):
        # 钉死"查的是 metadata__source='skipped_scan'"——不是其他 source
        # （vision / text_layer / error）。如果未来改 chunk source 字段名
        # 但忘了同步 filter 参数，本测试捕获。
        mock_chunk.objects.filter.return_value.count.return_value = 0
        stub_doc = _StubParsedDoc()
        _classify_high_failure_pdf_failure_code(stub_doc, failed_pages=10)
        mock_chunk.objects.filter.assert_called_once_with(
            page__document=stub_doc,
            metadata__source='skipped_scan',
        )


if __name__ == '__main__':
    unittest.main()

"""
File Pipeline W3 — OSS 临时通道 (`temp-parse-presign`) 单测

红线钉死（产品决策 D）：
  1. **不写** FileRecord / FileUsage（任意 endpoint 调用前后表行数 = 0）
  2. **不**调 FileRegistryService.register_uploaded_file
  3. object_key 强制 `temp-parse/{user_short}/...` 前缀（与持久通道
     `chat/attachments/` 物理分离）
  4. lifecycle policy 配置仅对 `temp-parse/` 前缀生效（不污染持久通道）

测试覆盖：
  - presign 成功路径：返 1h TTL + 正确前缀 object_key
  - 校验：mime 不在白名单 → 拒绝
  - 校验：扩展名 vs mime 不匹配 → 拒绝
  - 校验：文件名含路径分隔符 → 拒绝
  - 校验：超 50MB → 拒绝
  - 校验：assert_temp_parse_object_key 拒绝任意非 temp-parse/ 前缀
  - 校验：assert_temp_parse_object_key 拒绝 user 段不匹配
  - **红线**：FileRecord / FileUsage 表行数在所有路径下都不增加
  - **红线**：lifecycle 命令配置的 prefix 与代码常量一致
"""
from __future__ import annotations

import io
import os
import tokenize
import unittest
from unittest.mock import MagicMock, patch


def _extract_code_tokens(file_path: str) -> str:
    """读取源文件，返回**只**含真实代码 token（NAME/OP/...）的拼接串，跳过
    comment / docstring / string literal——用于红线扫描"代码层"是否引用了
    禁止的标识符，避免 docstring / comment 里提及关键字误触发。
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
        # 解析失败时退化为 raw source 比对（保持红线生效，不 silent fall through）
        return source
    return " ".join(out)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.exceptions import ValidationException  # noqa: E402
from apps.services.oss.temp_parse_api import (  # noqa: E402
    TEMP_PARSE_MAX_FILE_SIZE_BYTES,
    TEMP_PARSE_OBJECT_KEY_PREFIX,
    TEMP_PARSE_PRESIGN_TTL_SECONDS,
    TempParsePresignRequest,
    _user_key_segment,
    _validate_temp_parse_input,
    assert_temp_parse_object_key,
    temp_parse_presign,
)


# ────────────────────────────────────────────────────────────────────
# 校验函数单元测试（不依赖 db）
# ────────────────────────────────────────────────────────────────────


class TempParseInputValidationTest(SimpleTestCase):
    """`_validate_temp_parse_input` 校验逻辑全覆盖"""

    def test_valid_pptx_passes(self):
        ext, mime = _validate_temp_parse_input(
            TempParsePresignRequest(
                file_name="presentation.pptx",
                file_size_bytes=1024 * 1024,
                mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        )
        self.assertEqual(ext, ".pptx")
        self.assertEqual(
            mime,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )

    def test_filename_with_path_separator_rejected(self):
        with self.assertRaises(ValidationException):
            _validate_temp_parse_input(
                TempParsePresignRequest(
                    file_name="../etc/passwd.pptx",
                    file_size_bytes=100,
                    mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )
            )

    def test_filename_no_extension_rejected(self):
        with self.assertRaises(ValidationException):
            _validate_temp_parse_input(
                TempParsePresignRequest(
                    file_name="noext",
                    file_size_bytes=100,
                    mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )
            )

    def test_unsupported_extension_rejected(self):
        with self.assertRaises(ValidationException):
            _validate_temp_parse_input(
                TempParsePresignRequest(
                    file_name="report.doc",  # 老 .doc 不支持
                    file_size_bytes=100,
                    mime_type="application/msword",
                )
            )

    def test_mime_extension_mismatch_rejected(self):
        with self.assertRaises(ValidationException):
            _validate_temp_parse_input(
                TempParsePresignRequest(
                    file_name="x.pptx",
                    file_size_bytes=100,
                    mime_type="application/pdf",
                )
            )

    def test_oversized_file_rejected(self):
        with self.assertRaises(ValidationException) as ctx:
            _validate_temp_parse_input(
                TempParsePresignRequest(
                    file_name="big.pptx",
                    file_size_bytes=TEMP_PARSE_MAX_FILE_SIZE_BYTES + 1,
                    mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )
            )
        self.assertIn("超出临时通道上限", str(ctx.exception))


class TempParsePresignRequestSchemaValidationTest(SimpleTestCase):
    """**W5 L57（2026-05-14）**：mime_type Schema 校验钉死

    覆盖：空串 / 空格 / 注入字符 / 超长 / 缺斜杠 / 等的拒绝；合法 mime 通过。
    """

    def test_empty_mime_type_rejected_at_schema_layer(self):
        # min_length=1 在 pydantic 层 raise（在到达 _validate_temp_parse_input
        # 之前），用户拿到的是 422 而不是 500
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type="",
            )

    def test_whitespace_only_mime_type_rejected(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            # pattern 不允许首字符是空格（必须是字母）
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type="   ",
            )

    def test_mime_type_without_slash_rejected(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type="totallyinvalid",
            )

    def test_mime_type_injection_chars_rejected(self):
        from pydantic import ValidationError
        # 含 `;` / 引号 / 换行等注入字符的 mime 应被拒
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type='application/pdf";DROP TABLE foo;--',
            )
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type="application/pdf\nX-Inject: bad",
            )

    def test_mime_type_excessive_length_rejected(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type="a/" + "b" * 300,  # > max_length=255
            )

    def test_legitimate_mime_types_pass_schema(self):
        # 合法 mime 应通过 schema 层（白名单不一致由 _validate_temp_parse_input 拦）
        for mime in (
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "image/png",
            "image/jpeg",
        ):
            req = TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=100,
                mime_type=mime,
            )
            self.assertEqual(req.mime_type, mime)

    # ─── W5 L57 file_name schema-level 校验 ───────────────────────────
    def test_empty_file_name_rejected_at_schema_layer(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="",
                file_size_bytes=100,
                mime_type="application/pdf",
            )

    def test_excessively_long_file_name_rejected(self):
        from pydantic import ValidationError
        # max_length=200，让客户端早失败而不是塞进 OSS object_key 路径
        with self.assertRaises(ValidationError):
            TempParsePresignRequest(
                file_name="a" * 201,
                file_size_bytes=100,
                mime_type="application/pdf",
            )

    def test_legitimate_file_name_passes_schema(self):
        # schema 通过（字符内容 / 扩展名 / 路径穿越由 _validate_temp_parse_input 拦）
        req = TempParsePresignRequest(
            file_name="presentation.pptx",
            file_size_bytes=100,
            mime_type="application/pdf",
        )
        self.assertEqual(req.file_name, "presentation.pptx")


class TempParseObjectKeyAssertionTest(SimpleTestCase):
    """`assert_temp_parse_object_key` 安全校验全覆盖"""

    def test_non_temp_parse_prefix_rejected(self):
        with self.assertRaises(ValidationException):
            assert_temp_parse_object_key("chat/attachments/abc.pptx", user_id="user-1")
        with self.assertRaises(ValidationException):
            assert_temp_parse_object_key("anything/else.pptx", user_id="user-1")
        with self.assertRaises(ValidationException):
            assert_temp_parse_object_key("", user_id="user-1")

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValidationException):
            assert_temp_parse_object_key(f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/x/../y.pptx", user_id="x")
        with self.assertRaises(ValidationException):
            assert_temp_parse_object_key(f"{TEMP_PARSE_OBJECT_KEY_PREFIX}//y/z.pptx", user_id="x")

    def test_wrong_user_segment_rejected(self):
        # 用户 A 的 key 但用户 B 的 user_id 校验 → 拒绝
        user_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        user_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        seg_a = _user_key_segment(user_a)
        with self.assertRaises(ValidationException) as ctx:
            assert_temp_parse_object_key(
                f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/{seg_a}/abc.pptx",
                user_id=user_b,
            )
        self.assertIn("归属校验失败", str(ctx.exception))

    def test_correct_user_segment_passes(self):
        user_id = "01234567-89ab-cdef-0123-456789abcdef"
        seg = _user_key_segment(user_id)
        # **W3 Review 1 H4 / Review 2 M3 修复后**：seg 是 sha256(user_id)[:16]
        # 16 字符（之前是裸 user_id 前 8 字符）
        self.assertEqual(len(seg), 16)
        # 不暴露 user_id 任何前缀
        self.assertNotIn(seg, user_id.replace("-", ""))
        assert_temp_parse_object_key(
            f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/{seg}/abc.pptx",
            user_id=user_id,
        )

    def test_collision_resistance_two_distinct_user_ids_get_distinct_segments(self):
        # **W3 Review 1 H4 修复钉死**：sha256[:16] 64-bit 空间生日悖论 ~4B 后
        # 才碰撞；任何两个真实 user_id 必须得到不同 seg 防越权读取
        user_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        user_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        self.assertNotEqual(_user_key_segment(user_a), _user_key_segment(user_b))

    def test_anon_user_id_raises_not_silent_anon_segment(self):
        # **W3 Review 1 H4 修复**：原版本 anon 段共享让 anon 用户互相可读；
        # 现改为 raise（JWTAuth 已先拦，但本检查作 defense-in-depth）
        with self.assertRaises(ValidationException):
            _user_key_segment("")

    def test_too_short_path_rejected(self):
        with self.assertRaises(ValidationException):
            assert_temp_parse_object_key(f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/file.pptx", user_id="x")


# ────────────────────────────────────────────────────────────────────
# Endpoint 端到端单测：必要时 mock OSS service
# ────────────────────────────────────────────────────────────────────


class TempParsePresignEndpointTest(SimpleTestCase):
    """`temp_parse_presign` endpoint 行为 + 红线钉死

    用 `SimpleTestCase` + mock 一切 OSS / DB 调用，红线通过：
      1. `mock` `FileRecord.objects` / `FileUsage.objects` —— 任何 `.create()`
         调用都会 raise（不依赖测试 db schema）
      2. 静态扫描：模块源码不能含 `register_uploaded_file` / `parse_async`
         / `FileUsage.add_usage` 等持久化 API 字面值
    """

    def _make_request(self, user_id: str = "user-12345678-1234-1234-1234-123456789abc"):
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = user_id
        return req

    @patch("apps.services.oss.temp_parse_api.get_oss_service")
    def test_presign_success_returns_temp_parse_prefix_key(self, mock_get_oss):
        mock_oss = MagicMock()
        mock_oss.generate_presigned_url.return_value = "https://oss.example.com/signed-url"
        mock_get_oss.return_value = mock_oss

        result = temp_parse_presign(
            self._make_request(),
            TempParsePresignRequest(
                file_name="slides.pptx",
                file_size_bytes=2 * 1024 * 1024,
                mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["expires_in"], TEMP_PARSE_PRESIGN_TTL_SECONDS)
        self.assertEqual(result["presigned_url"], "https://oss.example.com/signed-url")
        # **红线**：object_key 前缀必须是 `temp-parse/` 与持久通道物理分离
        self.assertTrue(result["temp_object_key"].startswith(f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/"))
        # **红线**：不能出现 chat/attachments/ 等持久通道前缀
        self.assertNotIn("chat/attachments", result["temp_object_key"])

    @patch("apps.services.oss.temp_parse_api.get_oss_service")
    def test_presign_calls_oss_with_1h_ttl(self, mock_get_oss):
        mock_oss = MagicMock()
        mock_oss.generate_presigned_url.return_value = "https://oss.example.com/signed-url"
        mock_get_oss.return_value = mock_oss

        temp_parse_presign(
            self._make_request(),
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=1024,
                mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
        )

        call_kwargs = mock_oss.generate_presigned_url.call_args.kwargs
        self.assertEqual(call_kwargs["expiration"], TEMP_PARSE_PRESIGN_TTL_SECONDS)
        self.assertEqual(call_kwargs["method"], "PUT")

    @patch("apps.services.oss.temp_parse_api.get_oss_service")
    def test_invalid_mime_returns_error_envelope(self, _mock_get_oss):
        result = temp_parse_presign(
            self._make_request(),
            TempParsePresignRequest(
                file_name="x.doc",
                file_size_bytes=1024,
                mime_type="application/msword",
            ),
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "invalid_param_format")

    # ──────────────────────────────────────────────────────────────────
    # **W3.1 收尾 L50（2026-05-13）**：rate limit 触发钉死
    #
    # mock cache_is_rate_limited 返 limited=True 验证：
    #   1. endpoint 返 success=false + error_code='network_failed'（13 类
    #      SSoT 复用 NETWORK_ERROR）
    #   2. message 含"频率超限"中文文案让 LLM 转述准确
    #   3. message 含 ttl 让用户知道等多久
    #   4. 反向：rate limit 触发后**不**调 OSS presign（避免无谓 OSS API call）
    # ──────────────────────────────────────────────────────────────────

    @patch("apps.services.oss.temp_parse_api.cache_is_rate_limited")
    @patch("apps.services.oss.temp_parse_api.get_oss_service")
    def test_RATE_LIMIT_triggered_returns_network_failed_envelope(
        self, mock_get_oss, mock_rate_limit,
    ):
        # 模拟用户已撞到 30/min 上限：limited=True / count=31 / ttl=42
        mock_rate_limit.return_value = (True, 31, 42)
        mock_oss = MagicMock()
        mock_get_oss.return_value = mock_oss

        result = temp_parse_presign(
            self._make_request(),
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=1024,
                mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
        )

        self.assertFalse(result["success"])
        # 13 类 SSoT 复用 NETWORK_ERROR（kind: network_failed）
        self.assertEqual(result["error_code"], "network_failed")
        # 中文 message 让 LLM 转述准确
        self.assertIn("频率超限", result["message"])
        self.assertIn("42", result["message"])  # ttl 透传

        # **反向**：rate limit 触发后必须**不**调 OSS presign（短路在 rate limit 检查）
        mock_oss.generate_presigned_url.assert_not_called()
        # 调用 cache 仅 1 次（一次 rate check）
        self.assertEqual(mock_rate_limit.call_count, 1)
        # cache key 用 user:{id} 命名（与中间件统一），用 user:user-12345678 前缀
        rl_call = mock_rate_limit.call_args
        self.assertEqual(rl_call.args[0], "oss_temp_parse_presign")
        self.assertTrue(rl_call.args[1].startswith("user:"))
        # limit / window 与代码常量一致
        from apps.services.oss.temp_parse_api import (
            TEMP_PARSE_PRESIGN_RATE_LIMIT,
            TEMP_PARSE_RATE_WINDOW_SECONDS,
        )
        self.assertEqual(rl_call.args[2], TEMP_PARSE_PRESIGN_RATE_LIMIT)
        self.assertEqual(rl_call.args[3], TEMP_PARSE_RATE_WINDOW_SECONDS)

    @patch("apps.services.oss.temp_parse_api.cache_is_rate_limited")
    @patch("apps.services.oss.temp_parse_api.get_oss_service")
    def test_RATE_LIMIT_not_triggered_passes_through_to_presign(
        self, mock_get_oss, mock_rate_limit,
    ):
        # rate 未撞顶 → endpoint 应正常走完 presign 流程
        mock_rate_limit.return_value = (False, 5, 60)
        mock_oss = MagicMock()
        mock_oss.generate_presigned_url.return_value = "https://oss.example.com/signed"
        mock_get_oss.return_value = mock_oss

        result = temp_parse_presign(
            self._make_request(),
            TempParsePresignRequest(
                file_name="x.pptx",
                file_size_bytes=1024,
                mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
        )

        self.assertTrue(result["success"])
        mock_oss.generate_presigned_url.assert_called_once()

    # ──────────────────────────────────────────────────────────────────
    # 红线：endpoint 调用前后 FileRecord / FileUsage 表行数 = 0
    # ──────────────────────────────────────────────────────────────────

    @patch("apps.services.oss.temp_parse_api.get_oss_service")
    def test_RED_LINE_no_file_record_or_file_usage_persisted(self, mock_get_oss):
        """**红线**：endpoint 调用过程中不能调 FileRecord.objects.create / FileUsage.add_usage。

        用 `patch.object(FileRecord, 'objects')` 把 manager 换成会 raise 的 mock，
        任何写入操作（.create / .save）都会立即报错让测试失败。
        """
        from apps.services.oss.models import FileRecord, FileUsage

        mock_oss = MagicMock()
        mock_oss.generate_presigned_url.return_value = "https://oss.example.com/signed-url"
        mock_get_oss.return_value = mock_oss

        boom_manager = MagicMock()
        boom_manager.create.side_effect = AssertionError("RED LINE：临时通道不能写 FileRecord")
        boom_manager.filter.side_effect = AssertionError("RED LINE：临时通道不能查/写 FileRecord")

        boom_usage = MagicMock()
        boom_usage.add_usage.side_effect = AssertionError(
            "RED LINE：临时通道不能调 FileUsage.add_usage"
        )

        with patch.object(FileRecord, "objects", boom_manager), \
             patch.object(FileUsage, "add_usage", boom_usage.add_usage):
            for _ in range(5):
                result = temp_parse_presign(
                    self._make_request(),
                    TempParsePresignRequest(
                        file_name="x.pptx",
                        file_size_bytes=1024,
                        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    ),
                )
                self.assertTrue(result["success"])

        # 验证：mock 的"危险"方法都没被调过
        boom_manager.create.assert_not_called()
        boom_manager.filter.assert_not_called()
        boom_usage.add_usage.assert_not_called()

    def test_RED_LINE_module_does_not_import_FileRegistryService(self):
        """**红线**：temp_parse_api 模块不能 import 持久通道核心服务。

        防止未来开发者图省事 import + 调用，把临时通道污染成持久通道。
        用 `tokenize` 跳过 docstring / 注释，只检查真实代码 token。
        """
        import apps.services.oss.temp_parse_api as temp_parse_api_module

        # W4 (2026-05-13) L59 收：扩字面值列表覆盖更多"持久通道相邻字面值"。
        forbidden = [
            "FileRegistryService",
            "register_uploaded_file",
            "FileUsage",
            "parse_async",
            "parse_document_task",
            # W4 L59：扩字面值
            "confirm_upload",       # 持久通道 OSS confirm endpoint
            "ParsedDocument",       # 持久化模型
            "DocumentChunk",        # 持久化模型
            "DocumentPage",         # 持久化模型
            "publish_parse_completed",  # 持久通道事件 publish
            "trigger_rag_index",    # RAG 索引入口
        ]

        code_tokens = _extract_code_tokens(temp_parse_api_module.__file__)
        for word in forbidden:
            self.assertNotIn(
                word, code_tokens,
                msg=f"红线：temp_parse_api 不能在代码里引用 {word}（comment / docstring 提及不算）",
            )


# ────────────────────────────────────────────────────────────────────
# Lifecycle command 配置一致性钉死
# ────────────────────────────────────────────────────────────────────


class TempParseLifecycleCommandConstantsTest(SimpleTestCase):
    """lifecycle 命令使用的 prefix 与 endpoint 代码常量必须一致"""

    def test_command_prefix_matches_endpoint_constant(self):
        from apps.services.oss.management.commands.configure_temp_parse_lifecycle import (
            TEMP_PARSE_PREFIX,
            LIFECYCLE_RULE_ID,
            EXPIRATION_DAYS,
        )

        # `TEMP_PARSE_PREFIX` 在 command 里多一个尾 `/`（lifecycle policy 语义）
        self.assertEqual(TEMP_PARSE_PREFIX, f"{TEMP_PARSE_OBJECT_KEY_PREFIX}/")
        # 规则 id 必须含 `tabtin` 前缀以避免与运维其它规则冲突
        self.assertTrue(LIFECYCLE_RULE_ID.startswith("tabtin-"))
        # 兜底周期至少 1 天（OSS 最小粒度），不能 < 1
        self.assertGreaterEqual(EXPIRATION_DAYS, 1)


if __name__ == "__main__":
    unittest.main()

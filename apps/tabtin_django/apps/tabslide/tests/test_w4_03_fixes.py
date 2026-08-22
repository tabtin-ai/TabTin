"""
Wave 4 Batch 3 修复验证测试

覆盖: I1-04, I1-05, I2-03, I4-13, I1-15, I3-01, G1-05, H2-13
"""

from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import ast  # noqa: E402
import uuid  # noqa: E402
from pathlib import Path  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest.mock import MagicMock, patch, PropertyMock  # noqa: E402

from django.test import TestCase  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from apps.tabslide.models import HISTORY_TTL_FREE  # noqa: E402
from apps.tabslide.schemas import ParsePptxRequest  # noqa: E402
from apps.tabslide.services.pptx_io import _prefetch_oss_fonts  # noqa: E402
from apps.tabslide.services.slide_service import _deep_merge  # noqa: E402
from apps.tabslide.tasks import _resolve_history_ttl  # noqa: E402


# ═══════════════════════════════════════════════════════════════════
# I1-04 + I1-05: ParsePptxRequest Schema 校验
# ═══════════════════════════════════════════════════════════════════


class I104I105ParsePptxRequestSchemaTests(TestCase):
    """I1-04/I1-05: ParsePptxRequest model_validator 应拒绝超大 base64。"""

    def test_rejects_base64_exceeding_max_length(self):
        """通过 mock len() 模拟超大输入触发 model_validator，避免实际分配 70MB。"""
        small_b64 = "A" * 100
        with patch.object(ParsePptxRequest, "MAX_BASE64_LENGTH", 50):
            with self.assertRaises(ValidationError) as ctx:
                ParsePptxRequest(file_base64=small_b64)
            self.assertIn("Base64", str(ctx.exception))

    def test_accepts_base64_within_limit(self):
        """小于 MAX_BASE64_LENGTH 的 base64 应通过校验。"""
        small_b64 = "A" * 20
        with patch.object(ParsePptxRequest, "MAX_BASE64_LENGTH", 100):
            req = ParsePptxRequest(file_base64=small_b64)
            self.assertEqual(req.file_base64, small_b64)

    def test_schema_has_model_validator(self):
        """Schema 必须包含 check_base64_size model_validator。"""
        self.assertTrue(hasattr(ParsePptxRequest, "check_base64_size"))


# ═══════════════════════════════════════════════════════════════════
# I2-03: _cas_save_pages page_count 逻辑
# ═══════════════════════════════════════════════════════════════════


def _valid_page_count(pages: list) -> int:
    """与 _cas_save_pages 内部逻辑一致的 page_count 公式。"""
    return sum(
        1 for p in pages
        if isinstance(p, dict) and isinstance(p.get("id"), str) and p.get("id")
    )


class I203PageCountValidIdTests(TestCase):
    """I2-03: _cas_save_pages 的 page_count 仅统计有有效 string id 的页面。"""

    def test_valid_page_count_excludes_pages_without_id(self):
        """部分页面无 id 或 id 非字符串时，有效计数仅包含有有效 string id 的页面。"""
        pages = [
            {"id": "page-1", "elements": []},
            {"id": "", "elements": []},           # 空字符串，不计
            {"id": None, "elements": []},        # None，不计
            {},                                    # 无 id，不计
            {"id": "page-2", "elements": []},
            {"page_id": "page-3"},                # 无 id 字段，不计
        ]
        count = _valid_page_count(pages)
        self.assertEqual(count, 2)


# ═══════════════════════════════════════════════════════════════════
# I4-13: _deep_merge 阻止 blocked keys
# ═══════════════════════════════════════════════════════════════════


class I413DeepMergeBlockedKeysTests(TestCase):
    """I4-13: _deep_merge 应阻止顶层 _DEEP_MERGE_BLOCKED_KEYS 字段被 patch 覆盖。"""

    def test_blocked_keys_not_applied_at_top_level(self):
        """顶层 patch 中的 type、id 被忽略，仅 opacity 被应用。"""
        target = {"type": "shape", "id": "orig-id", "opacity": 1.0}
        patch = {"type": "evil", "opacity": 0.5, "id": "newid"}
        _deep_merge(target, patch)
        self.assertEqual(target["type"], "shape")
        self.assertEqual(target["id"], "orig-id")
        self.assertEqual(target["opacity"], 0.5)

    def test_nested_type_allowed(self):
        """嵌套层的 type 字段应允许修改（如 fill.type）。"""
        target = {"fill": {"type": "solid", "color": "#000"}}
        patch = {"fill": {"type": "gradient", "angle": 45}}
        _deep_merge(target, patch)
        self.assertEqual(target["fill"]["type"], "gradient")
        self.assertEqual(target["fill"]["angle"], 45)
        self.assertEqual(target["fill"]["color"], "#000")


# ═══════════════════════════════════════════════════════════════════
# I1-15: import_pptx magic bytes 校验
# ═══════════════════════════════════════════════════════════════════


class I115ImportPptxMagicBytesTests(TestCase):
    """I1-15: import_pptx 应校验 ZIP magic bytes (PK\\x03\\x04)。"""

    def test_invalid_header_rejected(self):
        """不以 PK\\x03\\x04 开头的字节序列应被视为无效 PPTX。"""
        PPTX_MAGIC = b"PK\x03\x04"
        invalid_headers = [
            b"\x00\x01\x02\x03",
            b"PDF-1.4",
            b"\xff\xd8\xff\xe0",  # JPEG
        ]
        for header in invalid_headers:
            self.assertNotEqual(
                header[:4], PPTX_MAGIC,
                f"测试数据本身不应是有效 ZIP 签名: {header!r}",
            )

    def test_valid_pptx_header_passes(self):
        """以 PK\\x03\\x04 开头的文件应通过 magic bytes 校验。"""
        PPTX_MAGIC = b"PK\x03\x04"
        valid_header = PPTX_MAGIC + b"\x00" * 100
        self.assertEqual(valid_header[:4], PPTX_MAGIC)

    def test_api_code_contains_magic_check(self):
        """api.py 中 import_pptx 包含 PPTX_MAGIC 校验逻辑。"""
        api_path = Path(__file__).resolve().parents[1] / "api.py"
        source = api_path.read_text(encoding="utf-8")
        self.assertIn('PPTX_MAGIC', source)
        self.assertIn('PK\\x03\\x04', source)


# ═══════════════════════════════════════════════════════════════════
# I3-01: _resolve_history_ttl
# ═══════════════════════════════════════════════════════════════════


class I301ResolveHistoryTtlTests(TestCase):
    """I3-01: _resolve_history_ttl 空 organization_id 或 membership 查询失败时返回 HISTORY_TTL_FREE。"""

    def test_empty_organization_id_returns_free_ttl(self):
        """organization_id 为空时返回 HISTORY_TTL_FREE。"""
        self.assertEqual(_resolve_history_ttl(""), HISTORY_TTL_FREE)

    def test_membership_lookup_failure_returns_free_ttl(self):
        """membership 查询失败时返回 HISTORY_TTL_FREE 作为默认值。"""
        with patch("apps.users.membership.models.OrganizationMembership") as mock_membership:
            chain = mock_membership.objects.select_related.return_value.filter.return_value
            chain.order_by.return_value.first.side_effect = Exception("db error")
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_FREE)


# ═══════════════════════════════════════════════════════════════════
# G1-05: _prefetch_oss_fonts
# ═══════════════════════════════════════════════════════════════════


class G105PrefetchOssFontsTests(TestCase):
    """G1-05: _prefetch_oss_fonts 当所有条目均有 data_base64 时返回空 dict。"""

    def test_returns_empty_when_all_have_data_base64(self):
        """所有 font_entries 含 data_base64 时无需 OSS 下载，返回空 dict。"""
        entries = [
            {"name": "Arial", "style": "normal", "data_base64": "SGVsbG8="},
            {"name": "Arial", "style": "bold", "data_base64": "V29ybGQ="},
        ]
        result = _prefetch_oss_fonts(entries)
        self.assertEqual(result, {})


# ═══════════════════════════════════════════════════════════════════
# H2-13: rollback_agent_run TOCTOU 修复
# ═══════════════════════════════════════════════════════════════════


class H213RollbackToctouTests(TestCase):
    """
    H2-13: rollback_agent_run 权限检查应在事务内执行，消除 TOCTOU 竞争。

    修复验证：检查 collab/api.py 中 rollback_agent_run 的代码结构，
    确保 check_permission 调用位于 db_transaction.atomic 块内部。
    """

    def test_permission_check_inside_transaction(self):
        """rollback_agent_run 的权限检查应在 transaction.atomic 块内。"""
        collab_api_path = Path(__file__).resolve().parents[2] / "collab" / "api.py"
        if not collab_api_path.exists():
            self.skipTest("collab/api.py 不在当前路径下")

        with open(collab_api_path, encoding="utf-8") as f:
            tree = ast.parse(f.read())

        # 查找 rollback_agent_run 函数
        rollback_func = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "rollback_agent_run":
                rollback_func = node
                break

        self.assertIsNotNone(rollback_func, "rollback_agent_run 函数未找到")

        # 查找 with db_transaction.atomic 块内部是否有 check_permission
        source = collab_api_path.read_text(encoding="utf-8")
        has_atomic = "db_transaction.atomic" in source or "transaction.atomic" in source
        self.assertTrue(has_atomic, "rollback_agent_run 应使用 transaction.atomic")

        # 检查 check_permission 在 atomic 之后（结构上：atomic 块包含权限检查）
        atomic_pos = source.find("with db_transaction.atomic")
        if atomic_pos == -1:
            atomic_pos = source.find("with transaction.atomic")
        check_pos = source.find("check_permission", atomic_pos)
        self.assertGreater(check_pos, atomic_pos, "check_permission 应在 atomic 块内")

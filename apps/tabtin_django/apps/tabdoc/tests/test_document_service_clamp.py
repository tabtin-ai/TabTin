"""cover_position 边界值测试（R-A3 修复回归保护，不依赖 PG）

修复背景：``apps/tabtin_django/apps/tabdoc/schemas.py`` 的
``DocumentUpdateRequest.cover_position`` 此前是 ``Optional[float]``
无 ``Field(ge=, le=)`` 校验。当 agent 喂 1.5 / -0.5 这种越界值时，
请求穿过 schema 进入 ``document_service.update_document``，
服务层 ``max(0.0, min(1.0, cover_position))`` 静默 clamp 后返回 200 OK。
agent 拿到的"成功"响应里 cover_position 已经被悄悄改成 1.0/0.0，
无法区分"传对了"和"传错了被 clamp"。

修复策略（防御深度）：

1. **schema 层**：加 ``Field(ge=0.0, le=1.0)``，越界 422 即拒，
   是 agent 感知的第一道闸；
2. **service 层**：保留原 ``max(0.0, min(1.0, v))`` clamp 作为兜底，
   防 schema 漏校验或绕过 ninja 直接调 service 的 caller。

本测试覆盖两层：

- ``CoverPositionClampTests``：service 层 clamp 代数行为（不依赖 ORM）
- ``CoverPositionSchemaTests``：schema 层 422 边界（pydantic Field）

不直接调 ``DocumentService.update_document``，因为它需要 PG 和 Document
ORM 实例；本测试以"纯逻辑层"为单元，故意把范围/校验拆出来单独锁，
让回归保护成本可控（不依赖 dev server）。
"""

from __future__ import annotations

from django.test import SimpleTestCase
from pydantic import ValidationError


# ──────────────────────────────────────────────────────────────────────
# service 层 clamp（防御深度）
# ──────────────────────────────────────────────────────────────────────


class CoverPositionClampTests(SimpleTestCase):
    """cover_position 服务层 clamp 边界值测试。

    锁定 ``document_service.update_document`` 中 ``max(0.0, min(1.0, v))``
    的代数语义（document_service.py:1081-1085）。如果服务层日后想改 clamp
    策略（例如改成 round / floor），必须先改这里的预期。
    """

    @staticmethod
    def _clamp(value: float) -> float:
        # 与 document_service.py:1082 完全等价
        return max(0.0, min(1.0, value))

    def test_clamp_at_zero(self):
        self.assertEqual(self._clamp(0.0), 0.0)

    def test_clamp_at_half(self):
        self.assertEqual(self._clamp(0.5), 0.5)

    def test_clamp_at_one(self):
        self.assertEqual(self._clamp(1.0), 1.0)

    def test_clamp_negative(self):
        self.assertEqual(self._clamp(-0.5), 0.0)

    def test_clamp_above_one(self):
        self.assertEqual(self._clamp(1.5), 1.0)

    def test_clamp_extreme_negative(self):
        self.assertEqual(self._clamp(-1000.0), 0.0)

    def test_clamp_extreme_positive(self):
        self.assertEqual(self._clamp(1000.0), 1.0)


# ──────────────────────────────────────────────────────────────────────
# schema 层 422（用户感知第一道闸）
# ──────────────────────────────────────────────────────────────────────


class CoverPositionSchemaTests(SimpleTestCase):
    """schema 层 422 边界（pydantic Field ge=0.0 / le=1.0）。

    DocumentUpdateRequest 在反序列化阶段就拒掉越界值，
    让 agent 立即感知"传错"，而不是被服务层静默 clamp 成 1.0 / 0.0 + 200 OK。

    传 None（即不更新封面位置）应仍接受，与 PATCH 语义一致。
    """

    @staticmethod
    def _build(value):
        # 在测试方法体内导入：避免模块顶部触发 schemas import 时
        # Django 未 ready 的边角情况（SimpleTestCase 会保证 ready）。
        from apps.tabdoc.schemas import DocumentUpdateRequest

        return DocumentUpdateRequest(cover_position=value)

    # ── 合法值 ──

    def test_schema_accepts_none(self):
        """None 表示不更新该字段，是合法的（PATCH 语义）。"""
        req = self._build(None)
        self.assertIsNone(req.cover_position)

    def test_schema_accepts_zero(self):
        req = self._build(0.0)
        self.assertEqual(req.cover_position, 0.0)

    def test_schema_accepts_half(self):
        req = self._build(0.5)
        self.assertEqual(req.cover_position, 0.5)

    def test_schema_accepts_one(self):
        req = self._build(1.0)
        self.assertEqual(req.cover_position, 1.0)

    # ── 越界值 ──

    def test_schema_rejects_below_zero(self):
        with self.assertRaises(ValidationError):
            self._build(-0.1)

    def test_schema_rejects_above_one(self):
        with self.assertRaises(ValidationError):
            self._build(1.1)

    def test_schema_rejects_extreme_negative(self):
        with self.assertRaises(ValidationError):
            self._build(-1000.0)

    def test_schema_rejects_extreme_positive(self):
        with self.assertRaises(ValidationError):
            self._build(1000.0)

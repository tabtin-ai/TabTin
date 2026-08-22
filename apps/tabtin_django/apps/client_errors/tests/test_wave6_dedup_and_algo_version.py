"""Wave 6 单元测试：``_extract_frontend_dedup_count`` 输入边界 + 算法版本号常量。

端到端入库行为（dedup_count 累加 event_count、algo_version 写入、backfill 幂等、
merge warning）由 management command 覆盖——本仓库默认 pytest 跑 SQLite 替代，
PG-only 字段在 setup_databases 阶段会因为 mysql migrate（``CONVERT TO CHARACTER
SET utf8mb4``）爆炸；client_errors 数据库行为最稳的验证方式是
``python manage.py verify_dedup_key`` / ``verify_group_merge`` /
``backfill_fingerprint_algo_version``，全部对真 PG 操作。

这边只覆盖与 DB 无关的纯逻辑：
- ``_extract_frontend_dedup_count`` 7 类输入边界
- ``FINGERPRINT_ALGO_VERSION`` 常量正整数 sanity
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.client_errors.api import (
    _FRONTEND_DEDUP_COUNT_MAX,
    _extract_frontend_dedup_count,
)
from apps.client_errors.models import FINGERPRINT_ALGO_VERSION


class ExtractFrontendDedupCountTest(SimpleTestCase):
    """``_extract_frontend_dedup_count`` 输入边界覆盖。

    Wave 6 Round 2 P2-2：返回 ``(clamped_value, raw_or_none)`` tuple。
    ``raw_or_none`` 仅在真的发生 clamp 时非 None，让 caller 在 ``_sanitize_extra``
    之前显式合并到 extra（不再 mutate 入参）。
    """

    def test_no_extra(self):
        self.assertEqual(_extract_frontend_dedup_count({}), (0, None))
        self.assertEqual(_extract_frontend_dedup_count(None), (0, None))  # type: ignore[arg-type]

    def test_missing_key(self):
        self.assertEqual(_extract_frontend_dedup_count({"foo": "bar"}), (0, None))

    def test_zero_or_negative(self):
        self.assertEqual(_extract_frontend_dedup_count({"frontend_dedup_count": 0}), (0, None))
        self.assertEqual(_extract_frontend_dedup_count({"frontend_dedup_count": -5}), (0, None))

    def test_normal_value(self):
        self.assertEqual(_extract_frontend_dedup_count({"frontend_dedup_count": 50}), (50, None))
        self.assertEqual(_extract_frontend_dedup_count({"frontend_dedup_count": 1}), (1, None))

    def test_clamp_to_max(self):
        # 超过上限 → clamp + 返回 raw
        self.assertEqual(
            _extract_frontend_dedup_count({"frontend_dedup_count": 1_000_000}),
            (_FRONTEND_DEDUP_COUNT_MAX, 1_000_000),
        )
        # 边界值 = 上限（不触发 clamp，raw=None）
        self.assertEqual(
            _extract_frontend_dedup_count({"frontend_dedup_count": _FRONTEND_DEDUP_COUNT_MAX}),
            (_FRONTEND_DEDUP_COUNT_MAX, None),
        )
        # 上限+1 触发 clamp → raw = 上限+1
        self.assertEqual(
            _extract_frontend_dedup_count({"frontend_dedup_count": _FRONTEND_DEDUP_COUNT_MAX + 1}),
            (_FRONTEND_DEDUP_COUNT_MAX, _FRONTEND_DEDUP_COUNT_MAX + 1),
        )

    def test_invalid_types_ignored(self):
        """非 int / bool / 字符串 / None 都不应被错误识别为 dedup count。

        bool 是 int 的子类——必须显式排除，否则 ``True`` 会被当成 1
        让事件被错误标记 dedup_count=1（实际场景：误传 boolean flag 进 extra）。
        """
        for invalid in ("haha", True, False, None, 3.14, [1, 2], {"a": 1}):
            self.assertEqual(
                _extract_frontend_dedup_count({"frontend_dedup_count": invalid}),
                (0, None),
                f"应忽略非法类型 {invalid!r}",
            )

    def test_extra_not_dict(self):
        # 防御 caller 传非 dict（理论上 schema 限制，但纵深防御）
        self.assertEqual(_extract_frontend_dedup_count("string"), (0, None))  # type: ignore[arg-type]
        self.assertEqual(_extract_frontend_dedup_count([]), (0, None))  # type: ignore[arg-type]

    def test_does_not_mutate_input(self):
        """Round 2 P2-2 核心契约：本函数**不**改 caller 持有的 extra dict。"""
        original = {"frontend_dedup_count": 1_000_000, "session_id": "x"}
        before = dict(original)
        clamped, raw = _extract_frontend_dedup_count(original)
        self.assertEqual(clamped, _FRONTEND_DEDUP_COUNT_MAX)
        self.assertEqual(raw, 1_000_000)
        # 关键：caller 的 extra 不被改写
        self.assertEqual(original, before)
        self.assertNotIn("_frontend_dedup_count_raw", original)


class FingerprintAlgoVersionConstantTest(SimpleTestCase):
    """常量本身的 sanity check——避免有人误改成 0 / 负数。"""

    def test_constant_is_positive_int(self):
        self.assertIsInstance(FINGERPRINT_ALGO_VERSION, int)
        # bool 也是 int 子类——必须显式排除
        self.assertNotIsInstance(FINGERPRINT_ALGO_VERSION, bool)
        self.assertGreaterEqual(FINGERPRINT_ALGO_VERSION, 1)
        # PositiveSmallIntegerField 上限 32767
        self.assertLessEqual(FINGERPRINT_ALGO_VERSION, 32767)

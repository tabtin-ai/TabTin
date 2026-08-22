"""
DOC-004 回归测试

验证 merge_updates 的事务外乐观锁使用 latest_version（整数计数器），
而非 updated_at（时间戳），防止毫秒精度碰撞导致误判。
"""
from __future__ import annotations

import inspect
import os
import re
import unittest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django
django.setup()


class TestDOC004MergeOptimisticLock(unittest.TestCase):
    """DOC-004: merge_updates 乐观锁使用 latest_version 替代 updated_at"""

    def _get_merge_updates_source(self) -> str:
        from apps.tabdoc.services.document_service import DocumentService
        return inspect.getsource(DocumentService.merge_updates)

    def test_optimistic_lock_uses_latest_version(self):
        """事务外格式转换的乐观锁应使用 latest_version 而非 updated_at"""
        src = self._get_merge_updates_source()

        # 找到事务外乐观锁区域：DOC-004 注释后的 filter() 调用
        doc004_idx = src.find("DOC-004")
        self.assertGreater(doc004_idx, 0, "源码中应包含 DOC-004 标记")

        post_tx_src = src[doc004_idx:]
        self.assertIn(
            "latest_version=merge_version",
            post_tx_src,
            "事务外乐观锁应使用 latest_version=merge_version",
        )

    def test_optimistic_lock_not_uses_updated_at(self):
        """事务外乐观锁的 filter 条件不应使用 updated_at"""
        src = self._get_merge_updates_source()

        # 提取事务外乐观锁区域（DOC-004 标记之后的 filter 调用）
        doc004_idx = src.find("DOC-004: 乐观锁使用")
        self.assertGreater(doc004_idx, 0, "源码中应包含 DOC-004 乐观锁标记")

        post_tx_src = src[doc004_idx:]

        filter_calls = re.findall(r"\.filter\([^)]+\)", post_tx_src)
        for call in filter_calls:
            self.assertNotIn(
                "updated_at=merge_ts",
                call,
                f"事务外 filter 不应使用 updated_at=merge_ts: {call}",
            )

    def test_merge_version_captured_in_transaction(self):
        """merge_version 应在事务内从 locked_doc 获取"""
        src = self._get_merge_updates_source()

        # 事务块范围：从 transaction.atomic 到第二个 CRT-05 标记
        atomic_idx = src.find("transaction.atomic")
        self.assertGreater(atomic_idx, 0)

        # 第二个 CRT-05 标记（事务外格式转换的注释）
        second_crt05_idx = src.find("CRT-05:", atomic_idx)
        self.assertGreater(second_crt05_idx, atomic_idx)

        tx_body = src[atomic_idx:second_crt05_idx]

        self.assertIn(
            "merge_version",
            tx_body,
            "merge_version 应在事务内被赋值",
        )
        self.assertIn(
            "locked_doc.latest_version",
            tx_body,
            "merge_version 应从 locked_doc.latest_version 获取",
        )

    def test_save_from_hocuspocus_uses_latest_version(self):
        """save_from_hocuspocus 也使用 latest_version 做 CAS，二者应一致"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.save_from_hocuspocus)
        self.assertIn(
            "locked_doc.latest_version",
            src,
            "save_from_hocuspocus 应使用 latest_version 做 CAS",
        )


if __name__ == "__main__":
    unittest.main()

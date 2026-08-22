"""Wave 2 E2E-W2-2 — A3 update-by-filter 1000 行 preflight + commit + RH

PRD §A3 / Wave 2 退出条件
-------------------------

> A3 update-by-filter 1000 行:
> - preflight 返回正确 matched_total
> - confirm_token 签发验签通过
> - commit 成功
> - RecordHistory 1000 条

设计要点:
1. preflight 签发 confirm_token（HMAC-SHA256 签名 + nonce 防重放）
2. commit 校验 token → 原子 UPDATE RETURNING → cascade → RH 写入
3. W2.perf-fix2 实测基线: 1000 行 p95 = 1010ms（远低于 PRD §A3 5s SLA）

运行
----

需 ``RUN_PROD_MODE_FIXTURE_TESTS=1``（D23 决策）:

.. code-block:: bash

    cd apps/tabtin_django && source venv/bin/activate
    RUN_PROD_MODE_FIXTURE_TESTS=1 python -m pytest \\
        apps/tabdata/tests/e2e/test_w2_e2e_2_update_by_filter.py -v
"""
from __future__ import annotations

import os
import time
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.constants import TABDATA_DB_ALIAS  # noqa: E402
from apps.tabdata.models import (  # noqa: E402
    Table,
    TableField,
    TableRecord,
)

_REQUIRES_PROD_MODE = pytest.mark.skipif(
    os.environ.get("RUN_PROD_MODE_FIXTURE_TESTS") != "1",
    reason=(
        "E2E-W2-2 需要 prod-mode 真表; "
        "设置 RUN_PROD_MODE_FIXTURE_TESTS=1 运行"
    ),
)

N_ROWS = 1000
A3_SLA_MS = 5000


@_REQUIRES_PROD_MODE
class TestW2E2E2UpdateByFilter:
    """Wave 2 E2E-W2-2: A3 update-by-filter 全链路。"""

    @pytest.fixture(autouse=True)
    def setup_table(self):
        """创建真表 + 1000 行 records。"""
        from apps.tabdata.services.table_service import TableService
        from apps.tabdata.services.record_service import RecordService
        from apps.tabdata.tests.e2e.conftest import RealUser

        self.user = RealUser(id=uuid4())
        self.space_id = str(uuid4())

        table_svc = TableService(user=self.user)
        self.table = table_svc._get_or_create_test_table(
            space_id=self.space_id,
            name=f"w2_e2e2_{uuid4().hex[:8]}",
        )
        self.table_id = str(self.table.id)

        number_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=self.table.id, field_type="number", is_deleted=False,
        ).first()
        text_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=self.table.id, field_type="text", is_deleted=False,
        ).first()

        if not number_field or not text_field:
            pytest.skip("测试表缺少 number 或 text 字段")

        self.number_field_id = str(number_field.id)
        self.text_field_id = str(text_field.id)
        self.number_field_name = number_field.name
        self.text_field_name = text_field.name

        record_svc = RecordService(user=self.user)
        records_data = []
        for i in range(N_ROWS):
            records_data.append({
                self.number_field_id: i,
                self.text_field_id: f"filter_test_{i}",
            })
        record_svc.batch_create_records(
            table_id=self.table_id,
            records_data=records_data,
        )

        self.total_rows = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=self.table.id, is_deleted=False,
        ).count()
        assert self.total_rows >= N_ROWS

        yield

        try:
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=self.table.id
            ).delete()
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=self.table.id
            ).delete()
            Table.objects.using(TABDATA_DB_ALIAS).filter(
                id=self.table.id
            ).delete()
        except Exception:
            pass

    def _get_service(self):
        from apps.tabdata.services.update_by_filter_service import (
            UpdateByFilterService,
        )
        from unittest.mock import patch as mock_patch

        svc = UpdateByFilterService(user=self.user, space_id=self.space_id)
        svc.check_table_permission = lambda *a, **k: True
        svc._is_agent_request = lambda: False
        return svc

    def test_preflight_matched_total_correct(self):
        """preflight 返回正确的 matched_total。"""
        svc = self._get_service()
        filter_clause = {
            self.number_field_id: {"$gte": 0},
        }
        patch = {self.text_field_id: "preflight_check"}

        result = svc.preflight(
            table_id=self.table_id,
            filter_clause=filter_clause,
            patch=patch,
        )

        assert "matched_total" in result
        assert result["matched_total"] >= N_ROWS, (
            f"matched_total={result['matched_total']}, expected >= {N_ROWS}"
        )
        assert "confirm_token" in result
        assert len(result["confirm_token"]) > 0
        assert "sample_records" in result

    def test_confirm_token_issue_and_verify(self):
        """confirm_token 签发 → 验签一致性。"""
        from apps.tabdata.services.confirm_token import (
            verify_confirm_token_signature,
        )

        svc = self._get_service()
        filter_clause = {self.number_field_id: {"$gte": 0}}
        patch = {self.text_field_id: "token_verify"}

        result = svc.preflight(
            table_id=self.table_id,
            filter_clause=filter_clause,
            patch=patch,
        )

        token_str = result["confirm_token"]
        payload = verify_confirm_token_signature(token_str)

        assert payload.table_id == self.table_id
        assert payload.user_id == str(self.user.id)
        assert payload.matched_total >= N_ROWS

    def test_commit_success_and_rh_1000(self):
        """preflight → commit 全链路成功 + RecordHistory 1000 条。"""
        from apps.tabdata.models import RecordHistory

        svc = self._get_service()
        filter_clause = {self.number_field_id: {"$gte": 0}}
        patch = {self.text_field_id: "committed_value"}

        rh_before = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=self.table.id, action="update",
        ).count()

        preflight_result = svc.preflight(
            table_id=self.table_id,
            filter_clause=filter_clause,
            patch=patch,
        )

        start = time.monotonic()
        status, response = svc.commit(
            table_id=self.table_id,
            confirm_token=preflight_result["confirm_token"],
            filter_clause=filter_clause,
            patch=patch,
        )
        duration_ms = (time.monotonic() - start) * 1000

        assert status == 200, f"commit 返回 {status}: {response}"
        assert response["updated_count"] >= N_ROWS, (
            f"updated_count={response['updated_count']}, expected >= {N_ROWS}"
        )
        assert len(response["committed_ids"]) >= N_ROWS

        rh_after = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=self.table.id, action="update",
        ).count()
        rh_delta = rh_after - rh_before
        assert rh_delta >= N_ROWS, (
            f"RecordHistory delta = {rh_delta}, expected >= {N_ROWS}"
        )

    def test_commit_latency_under_sla(self):
        """commit 1000 行单次延迟 < 5s（PRD §A3 SLA）。"""
        svc = self._get_service()
        filter_clause = {self.number_field_id: {"$gte": 0}}
        patch = {self.text_field_id: "perf_test"}

        preflight_result = svc.preflight(
            table_id=self.table_id,
            filter_clause=filter_clause,
            patch=patch,
        )

        start = time.monotonic()
        status, response = svc.commit(
            table_id=self.table_id,
            confirm_token=preflight_result["confirm_token"],
            filter_clause=filter_clause,
            patch=patch,
        )
        duration_ms = (time.monotonic() - start) * 1000

        assert status == 200
        assert duration_ms < A3_SLA_MS, (
            f"A3 commit {N_ROWS} rows = {duration_ms:.0f}ms, "
            f"SLA = {A3_SLA_MS}ms"
        )

    def test_preflight_empty_filter_rejected(self):
        """空 filter_clause 被拒绝（W2.perf-fix2 用户 P0-4）。"""
        from apps.tabdata.services.update_by_filter_service import (
            A3PreflightError,
        )

        svc = self._get_service()
        with pytest.raises(A3PreflightError) as exc_info:
            svc.preflight(
                table_id=self.table_id,
                filter_clause={},
                patch={self.text_field_id: "nope"},
            )
        assert "EMPTY_FILTER" in str(exc_info.value.code)

    def test_preflight_empty_patch_rejected(self):
        """空 patch 被拒绝（W2.perf-fix2 用户 P0-6）。"""
        from apps.tabdata.services.update_by_filter_service import (
            A3PreflightError,
        )

        svc = self._get_service()
        with pytest.raises(A3PreflightError) as exc_info:
            svc.preflight(
                table_id=self.table_id,
                filter_clause={self.number_field_id: {"$gte": 0}},
                patch={},
            )
        assert "EMPTY_PATCH" in str(exc_info.value.code)

    def test_commit_nonce_replay_returns_cached(self):
        """同一 token commit 两次 → 第二次幂等返回缓存结果（nonce 防重放）。"""
        svc = self._get_service()
        filter_clause = {self.number_field_id: {"$gte": 0}}
        patch = {self.text_field_id: "nonce_replay_test"}

        preflight_result = svc.preflight(
            table_id=self.table_id,
            filter_clause=filter_clause,
            patch=patch,
        )

        status1, resp1 = svc.commit(
            table_id=self.table_id,
            confirm_token=preflight_result["confirm_token"],
            filter_clause=filter_clause,
            patch=patch,
        )
        assert status1 == 200

        status2, resp2 = svc.commit(
            table_id=self.table_id,
            confirm_token=preflight_result["confirm_token"],
            filter_clause=filter_clause,
            patch=patch,
        )
        assert status2 == 200
        assert resp2["updated_count"] == resp1["updated_count"]

    def test_commit_filter_tampered_rejected(self):
        """commit 时 filter 被篡改 → 拒绝（ConfirmTokenFilterChanged）。"""
        from apps.tabdata.services.update_by_filter_service import (
            UpdateByFilterService,
        )
        from apps.tabdata.exceptions import ConfirmTokenFilterChanged

        svc = self._get_service()
        filter_clause = {self.number_field_id: {"$gte": 0}}
        patch = {self.text_field_id: "tamper_test"}

        preflight_result = svc.preflight(
            table_id=self.table_id,
            filter_clause=filter_clause,
            patch=patch,
        )

        tampered_filter = {self.number_field_id: {"$gte": 999}}
        with pytest.raises(ConfirmTokenFilterChanged):
            svc.commit(
                table_id=self.table_id,
                confirm_token=preflight_result["confirm_token"],
                filter_clause=tampered_filter,
                patch=patch,
            )

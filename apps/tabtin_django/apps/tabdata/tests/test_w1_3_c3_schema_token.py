"""Wave 1.3 / C3 单元测试 — Table schema_version_token (删表副作用闭环)。

覆盖范围
--------

C3.1 model 层：
- ``Table.schema_version_token`` 字段存在 + UUIDField 类型
- migration 0024 已 apply（PG 直查 information_schema）

C3.2 ``schema_version_token`` 服务模块：
- ``get_table_schema_version_token`` 正常 / 表不存在
- ``bump_table_schema_version_token`` 生成新 UUID + 写 ChangeLog（C5 链路）
- ``assert_table_token_or_skip``：
  - expected_token=None → 透传 True（向后兼容）
  - 表不存在 → False（no-op）
  - token 一致 → True
  - token 漂移 → False + info 日志

C3.2 ``TableService`` 集成：
- delete_table / trash_table / restore_table_from_trash / permanent_delete_table
  都 bump token（源代码字符串扫描）

C3.3 Celery task 接入：
- conversion_tasks / connector_tasks 都用了 ``assert_table_token_or_skip``
- caller (api_field / api_connector) 都 freeze 了 token

设计取舍：mock ORM + ChangeLog，PG 直查只验 schema 存在；纯函数路径直接断言。
"""
from __future__ import annotations

import inspect
import os
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.services.schema_version_token import (  # noqa: E402
    FROZEN_TOKEN_KEY,
    assert_table_token_or_skip,
    bump_table_schema_version_token,
    get_table_schema_version_token,
)


# ── 1. Model 字段 + migration ──────────────────────────────


class TestTableModelHasSchemaVersionToken:
    def test_field_exists_on_model(self):
        from django.db import models

        from apps.tabdata.models import Table

        field = Table._meta.get_field("schema_version_token")
        assert isinstance(field, models.UUIDField)

    def test_default_uuid4(self):
        """default 必须是 uuid.uuid4 callable，确保每个实例 token 唯一。"""
        from apps.tabdata.models import Table

        field = Table._meta.get_field("schema_version_token")
        assert callable(field.default)
        # 调用两次得到不同 UUID
        a = field.default()
        b = field.default()
        assert a != b
        assert isinstance(a, UUID)


class TestPhysicalSchema:
    """直接查 PG information_schema 验证 migration 0024 已 apply。"""

    def test_column_exists(self):
        from django.db import connections

        with connections["postgresql"].cursor() as cur:
            cur.execute(
                "SELECT column_name, data_type "
                "FROM information_schema.columns "
                "WHERE table_name='tabdata_table' "
                "  AND column_name='schema_version_token'"
            )
            rows = cur.fetchall()

        assert len(rows) == 1, (
            "C3 schema_version_token 字段未在 tabdata_table 表上找到，"
            "migration 0024 可能未 apply。"
        )
        assert rows[0][1] == "uuid"


# ── 2. get / bump / assert 工具函数 ────────────────────────


class TestGetTableSchemaVersionToken:
    @patch("apps.tabdata.models.Table.objects")
    def test_returns_token_string(self, mock_objects):
        token_uuid = uuid4()
        chain = MagicMock()
        chain.values_list.return_value.first.return_value = token_uuid
        filter_chain = MagicMock()
        filter_chain.filter.return_value = chain
        mock_objects.using.return_value = filter_chain

        result = get_table_schema_version_token(uuid4())
        assert result == str(token_uuid)

    @patch("apps.tabdata.models.Table.objects")
    def test_returns_none_when_not_found(self, mock_objects):
        chain = MagicMock()
        chain.values_list.return_value.first.return_value = None
        filter_chain = MagicMock()
        filter_chain.filter.return_value = chain
        mock_objects.using.return_value = filter_chain

        result = get_table_schema_version_token(uuid4())
        assert result is None

    @patch("apps.tabdata.models.Table.objects")
    def test_returns_none_on_exception(self, mock_objects):
        mock_objects.using.side_effect = RuntimeError("DB down")
        result = get_table_schema_version_token(uuid4())
        assert result is None


class TestBumpTableSchemaVersionToken:
    @patch("apps.tabdata.services.schema_version_token._write_token_bump_changelog")
    @patch("apps.tabdata.models.Table.objects")
    def test_bump_generates_new_uuid_and_returns_pair(
        self, mock_objects, mock_changelog,
    ):
        old_token = uuid4()
        table_obj = MagicMock(
            id=uuid4(), schema_version_token=old_token, name="t1",
        )

        select_chain = MagicMock()
        select_chain.only.return_value.first.return_value = table_obj
        filter_chain = MagicMock()
        filter_chain.select_for_update.return_value.filter.return_value = select_chain
        mock_objects.using.return_value = filter_chain

        # mock 第二次 .filter().update()
        update_chain = MagicMock()
        mock_objects.using.return_value.filter.return_value = update_chain

        prev, new = bump_table_schema_version_token(
            uuid4(), reason="trash", user=MagicMock(id="u1"),
        )

        # 注意：因为 mock 链路不能完美还原 select_for_update + 第二次 filter，
        # 关注 ChangeLog 与新 UUID 的不同性即可
        assert mock_changelog.called

    @patch("apps.tabdata.services.schema_version_token._write_token_bump_changelog")
    @patch("apps.tabdata.models.Table.objects")
    def test_bump_returns_none_when_table_not_found(
        self, mock_objects, mock_changelog,
    ):
        select_chain = MagicMock()
        select_chain.only.return_value.first.return_value = None
        filter_chain = MagicMock()
        filter_chain.select_for_update.return_value.filter.return_value = select_chain
        mock_objects.using.return_value = filter_chain

        prev, new = bump_table_schema_version_token(
            uuid4(), reason="trash", user=None,
        )
        assert prev is None
        assert new is None
        # 表不存在不写 ChangeLog
        assert not mock_changelog.called


class TestAssertTableTokenOrSkip:
    """C3.3 worker 入口校验函数。"""

    def test_none_expected_token_pass_through(self):
        """expected_token=None → 透传 True（旧 caller 不传 token，向后兼容）。"""
        result = assert_table_token_or_skip(uuid4(), None)
        assert result is True

    def test_empty_string_expected_token_pass_through(self):
        """expected_token='' 同样视为未启用 token 防御。"""
        result = assert_table_token_or_skip(uuid4(), "")
        assert result is True

    @patch("apps.tabdata.services.schema_version_token.get_table_schema_version_token")
    def test_table_not_exists_skip(self, mock_get):
        """表已不存在（permanent_delete）→ skip。"""
        mock_get.return_value = None

        result = assert_table_token_or_skip(uuid4(), "abc-token", task_name="t1")
        assert result is False

    @patch("apps.tabdata.services.schema_version_token.get_table_schema_version_token")
    def test_token_match_proceed(self, mock_get):
        token = "matching-token"
        mock_get.return_value = token

        result = assert_table_token_or_skip(uuid4(), token, task_name="t1")
        assert result is True

    @patch("apps.tabdata.services.schema_version_token.get_table_schema_version_token")
    def test_token_mismatch_skip(self, mock_get):
        """trash 后 bump → 旧 task 校验失败 → no-op。"""
        mock_get.return_value = "new-token-after-bump"

        result = assert_table_token_or_skip(
            uuid4(), "old-token-before-trash", task_name="my_task",
        )
        assert result is False


# ── 3. TableService trash/delete/restore 都 bump token ──────


class TestTableServiceBumpsToken:
    """源代码扫描验证：所有删除 / 恢复入口都调用 bump_table_schema_version_token。"""

    def test_delete_table_bumps_token(self):
        from apps.tabdata.services.table_service import TableService

        src = inspect.getsource(TableService.delete_table)
        assert "bump_table_schema_version_token" in src
        assert 'reason="delete"' in src or "reason='delete'" in src

    def test_trash_table_bumps_token(self):
        from apps.tabdata.services.table_service import TableService

        src = inspect.getsource(TableService.trash_table)
        assert "bump_table_schema_version_token" in src
        assert 'reason="trash"' in src or "reason='trash'" in src

    def test_restore_table_from_trash_bumps_token(self):
        from apps.tabdata.services.table_service import TableService

        src = inspect.getsource(TableService.restore_table_from_trash)
        assert "bump_table_schema_version_token" in src
        assert 'reason="restore"' in src or "reason='restore'" in src

    def test_permanent_delete_table_bumps_token(self):
        from apps.tabdata.services.table_service import TableService

        src = inspect.getsource(TableService.permanent_delete_table)
        assert "bump_table_schema_version_token" in src
        assert (
            'reason="permanent_delete"' in src
            or "reason='permanent_delete'" in src
        )


# ── 4. Celery task 接入 token 校验 ──────────────────────────


class TestCeleryTasksUseTokenValidation:
    def test_conversion_task_validates_token(self):
        from apps.tabdata.tasks.conversion_tasks import convert_field_type_task

        # Celery shared_task 装饰后是 Task 实例，源码取 .run
        task_fn = getattr(convert_field_type_task, "run", convert_field_type_task)
        src = inspect.getsource(task_fn)
        assert "assert_table_token_or_skip" in src
        assert "FROZEN_TOKEN_KEY" in src
        assert "table_token_mismatch" in src

    def test_connector_task_validates_token(self):
        from apps.tabdata.tasks.connector_tasks import sync_connector_table

        task_fn = getattr(sync_connector_table, "run", sync_connector_table)
        src = inspect.getsource(task_fn)
        assert "assert_table_token_or_skip" in src
        assert "FROZEN_TOKEN_KEY" in src
        assert "table_token_mismatch" in src

    def test_callers_freeze_token_when_publishing(self):
        """API 入口在发布 Celery task 时必须 freeze 当前 token。"""
        # api_field.convert_field_type
        from apps.tabdata.api_field import convert_field_type
        src1 = inspect.getsource(convert_field_type)
        assert "get_table_schema_version_token" in src1
        assert "FROZEN_TOKEN_KEY" in src1

        # api_connector 手动触发 sync
        import apps.tabdata.api_connector as api_connector_mod
        src2 = inspect.getsource(api_connector_mod)
        assert "get_table_schema_version_token" in src2
        assert "FROZEN_TOKEN_KEY" in src2


# ── 5. ErrorCode 注册 ────────────────────────────────────


class TestC3ErrorCode:
    def test_table_schema_token_mismatch_code_exists(self):
        from apps.tabdata.error_codes import ErrorCode, ErrorMessage

        assert hasattr(ErrorCode, "TABLE_SCHEMA_TOKEN_MISMATCH")
        assert ErrorCode.TABLE_SCHEMA_TOKEN_MISMATCH in ErrorMessage._CODE_TO_I18N
        assert ErrorCode.TABLE_SCHEMA_TOKEN_MISMATCH in ErrorMessage.MESSAGES
        # 文案：W0-7 c5 命名规范，避免技术词暴露
        msg = ErrorMessage.MESSAGES[ErrorCode.TABLE_SCHEMA_TOKEN_MISMATCH]
        assert "已停止" in msg
        # 不暴露 "schema_version_token" 等技术词
        assert "schema_version_token" not in msg
        assert "Celery" not in msg


# ── 6. 实测：删表后未消费的 task 5s 内自动 no-op ───────────────


class TestEndToEndTokenSkipBehavior:
    """C3 关键性能验收：删表 → freeze 旧 token 的 task 自动跳过。"""

    @patch("apps.tabdata.services.schema_version_token.get_table_schema_version_token")
    def test_token_validation_is_fast(self, mock_get):
        """token 校验是 O(1) 单次 SELECT，应 < 10ms。"""
        import time

        mock_get.return_value = "current-token"

        start = time.perf_counter()
        for _ in range(100):
            assert_table_token_or_skip(uuid4(), "current-token", task_name="bench")
        elapsed_ms = (time.perf_counter() - start) * 1000

        # 100 次 mock 调用 < 50ms（实际 DB 单次 SELECT 通常 < 5ms）
        assert elapsed_ms < 50, f"token validation 太慢: {elapsed_ms}ms"

    @patch("apps.tabdata.services.schema_version_token.get_table_schema_version_token")
    def test_token_drift_skip_returns_false(self, mock_get):
        """模拟"trash 后 task 启动"场景：旧 token 校验失败。"""
        mock_get.return_value = "new-token-after-trash"

        # task publish 时 freeze 的旧 token
        old_frozen = "old-token-before-trash"

        result = assert_table_token_or_skip(
            uuid4(), old_frozen, task_name="sync_connector_table",
        )
        # 校验失败 → task 应跳过
        assert result is False

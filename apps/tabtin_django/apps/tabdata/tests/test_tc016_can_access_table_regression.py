"""
TC-016 回归测试

TC-016: can_access_table 中 space_id=None 时，若 table_ids 显式包含该表，
应返回 True 而非 False。修复历史遗留数据表（space_id 为 null）被合法 Token 403 的问题。
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import uuid  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402


def _make_mock_token(*, table_ids=None, space_ids=None):
    """构造一个具有 can_access_table 方法的 mock Token 对象。

    直接导入真实 can_access_table 方法，绑定到 mock 上以测试实际逻辑。
    """
    from apps.tabdata.models_token import TableApiToken

    token = MagicMock(spec=TableApiToken)
    token.table_ids = table_ids
    token.space_ids = space_ids

    token.can_access_table = TableApiToken.can_access_table.__get__(token, type(token))
    token.can_access_space = TableApiToken.can_access_space.__get__(token, type(token))
    return token


class TestTC016CanAccessTableSpaceIdNone:
    """TC-016: space_id=None 时 can_access_table 不应错误返回 False"""

    def test_table_in_table_ids_space_id_none_returns_true(self):
        """核心场景：table_ids 包含目标表，space_id 为 None（历史遗留），应返回 True"""
        table_id = str(uuid.uuid4())
        space_id_val = str(uuid.uuid4())
        token = _make_mock_token(
            table_ids=[table_id],
            space_ids=[space_id_val],
        )

        result = token.can_access_table(table_id, space_id=None)
        assert result is True, (
            "table_ids 显式包含该表，即使 space_id 为 None（历史遗留数据），也应返回 True"
        )

    def test_table_not_in_table_ids_returns_false(self):
        """table_ids 不包含目标表时，无论 space_id 如何都应返回 False"""
        table_id = str(uuid.uuid4())
        other_table = str(uuid.uuid4())
        token = _make_mock_token(
            table_ids=[other_table],
            space_ids=[str(uuid.uuid4())],
        )

        assert token.can_access_table(table_id, space_id=None) is False
        assert token.can_access_table(table_id, space_id=str(uuid.uuid4())) is False

    def test_no_table_ids_restriction_space_ids_set_space_id_none_returns_false(self):
        """table_ids 为 None（无表级限制），space_ids 有值但 space_id 为 None，应返回 False"""
        table_id = str(uuid.uuid4())
        token = _make_mock_token(
            table_ids=None,
            space_ids=[str(uuid.uuid4())],
        )

        result = token.can_access_table(table_id, space_id=None)
        assert result is False, (
            "无表级授权时，space_id=None 应返回 False"
        )

    def test_no_restrictions_returns_true(self):
        """table_ids 和 space_ids 均为 None 时，任何表都应可访问"""
        token = _make_mock_token(table_ids=None, space_ids=None)
        assert token.can_access_table(str(uuid.uuid4()), space_id=None) is True
        assert token.can_access_table(str(uuid.uuid4()), space_id=str(uuid.uuid4())) is True

    def test_table_in_ids_matching_space_returns_true(self):
        """标准场景：table_ids 和 space_ids 交集匹配，应返回 True"""
        table_id = str(uuid.uuid4())
        space_id = str(uuid.uuid4())
        token = _make_mock_token(
            table_ids=[table_id],
            space_ids=[space_id],
        )

        assert token.can_access_table(table_id, space_id=space_id) is True

    def test_table_in_ids_wrong_space_returns_false(self):
        """table_ids 包含表但 space_id 不匹配时，应返回 False（交集逻辑）"""
        table_id = str(uuid.uuid4())
        token = _make_mock_token(
            table_ids=[table_id],
            space_ids=[str(uuid.uuid4())],
        )

        wrong_space = str(uuid.uuid4())
        assert token.can_access_table(table_id, space_id=wrong_space) is False

    def test_no_table_ids_matching_space_returns_true(self):
        """table_ids 为 None 但 space_ids 匹配时，应返回 True"""
        space_id = str(uuid.uuid4())
        token = _make_mock_token(
            table_ids=None,
            space_ids=[space_id],
        )

        assert token.can_access_table(str(uuid.uuid4()), space_id=space_id) is True

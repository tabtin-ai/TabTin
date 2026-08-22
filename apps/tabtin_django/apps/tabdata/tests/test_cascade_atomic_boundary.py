"""L71 / W0-4 §6.3 反模式回归保护 — cascade 事务边界守门测试。

目标
====

1. **入口断言主断言**(运行时正反向):
   - 不在 ``transaction.atomic(using=TABDATA_DB_ALIAS)`` 内调
     ``CascadeService.propagate_cell_changes`` → 必须 ``RuntimeError``
   - 在 atomic 内调 → 不报错(空参数早返回也算成功)
   - 经 ``DjangoCascadeAdapter`` 走同款断言 → 双层守门生效

2. **基类软警告语义守护**:
   - ``_handle_cascade_compute`` 内 cascade raise → savepoint rollback,
     不污染外层主事务,handler 仅写 warning 继续

3. **装饰器物理移除回归保护**(辅助断言):
   - ``CascadeService.propagate_cell_changes`` 源码不应再含
     ``@transaction.atomic`` 装饰器(防误回退)

设计取舍
========

不依赖真实 PG/ORM 连接 — 用 ``MagicMock`` + ``patch`` 让所有断言在不连
PG 的情况下也能跑过。

主断言用"运行时行为"(直接调函数验证 RuntimeError),源码文本断言作为
辅助(允许失败但触发 deprecation warning,W0-4 §6.3 选型)。
"""

from __future__ import annotations

import inspect
import os
import warnings
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.constants import TABDATA_DB_ALIAS  # noqa: E402
from apps.tabdata.infrastructure.cascade_adapter import (  # noqa: E402
    DjangoCascadeAdapter,
)
from apps.tabdata.services.cascade_service import CascadeService  # noqa: E402


# ════════════════════════════════════════════════════════════════
# 1. CascadeService.propagate_cell_changes 入口断言主断言
# ════════════════════════════════════════════════════════════════


class TestCascadeEntryAssertion:
    """W0-4 §3.0 / §6.1 — 入口断言运行时正反向验证。"""

    def test_raises_runtime_error_outside_atomic(self):
        """不在 atomic 内调 → RuntimeError(主断言)。"""
        # mock connections 模拟"不在 atomic 内"
        fake_conn = MagicMock()
        fake_conn.in_atomic_block = False
        fake_connections = {TABDATA_DB_ALIAS: fake_conn}
        with patch(
            'apps.tabdata.services.cascade_service.connections',
            fake_connections,
        ):
            with pytest.raises(RuntimeError) as exc_info:
                CascadeService.propagate_cell_changes(
                    table_id='00000000-0000-0000-0000-000000000000',
                    changed_field_ids=['00000000-0000-0000-0000-000000000001'],
                    record_ids=['00000000-0000-0000-0000-000000000002'],
                )
        # 文案应含 atomic 关键字,便于运维 grep
        assert 'atomic' in str(exc_info.value).lower()
        # 应明确指出方法名,便于栈跟踪定位
        assert 'propagate_cell_changes' in str(exc_info.value)

    def test_inside_atomic_no_error_with_empty_args(self):
        """在 atomic 内调用,空参数早返回 — 入口断言通过 + 函数返回 []。

        通过 mock connections 让 in_atomic_block=True,且不真连 PG。
        """
        fake_conn = MagicMock()
        fake_conn.in_atomic_block = True
        fake_connections = {TABDATA_DB_ALIAS: fake_conn}
        with patch(
            'apps.tabdata.services.cascade_service.connections',
            fake_connections,
        ):
            # 空 changed_field_ids → 早返回 []
            result = CascadeService.propagate_cell_changes(
                table_id='00000000-0000-0000-0000-000000000000',
                changed_field_ids=[],
                record_ids=['00000000-0000-0000-0000-000000000002'],
            )
            assert result == []
            # 空 record_ids 也早返回 []
            result = CascadeService.propagate_cell_changes(
                table_id='00000000-0000-0000-0000-000000000000',
                changed_field_ids=['00000000-0000-0000-0000-000000000001'],
                record_ids=[],
            )
            assert result == []

    def test_error_message_describes_transaction_contract(self):
        """错误信息应说明关联标题传播的事务约束。"""
        fake_conn = MagicMock()
        fake_conn.in_atomic_block = False
        fake_connections = {TABDATA_DB_ALIAS: fake_conn}
        with patch(
            'apps.tabdata.services.cascade_service.connections',
            fake_connections,
        ):
            with pytest.raises(RuntimeError) as exc_info:
                CascadeService.propagate_cell_changes(
                    table_id='t', changed_field_ids=['f'], record_ids=['r'],
                )
        msg = str(exc_info.value)
        assert '关联标题传播' in msg
        assert '同一事务' in msg


# ════════════════════════════════════════════════════════════════
# 2. DjangoCascadeAdapter 双层守门
# ════════════════════════════════════════════════════════════════


class TestCascadeAdapterAssertion:
    """W0-4 §6.1 — adapter 提供更早的 fail-fast,handler 路径漏 atomic
    时异常栈在 adapter 即可定位,无需到 CascadeService 主入口才报错。"""

    def test_adapter_raises_outside_atomic(self):
        """adapter 入口断言:不在 atomic 内 → RuntimeError(早于主入口)。"""
        adapter = DjangoCascadeAdapter()
        fake_conn = MagicMock()
        fake_conn.in_atomic_block = False
        fake_connections = {TABDATA_DB_ALIAS: fake_conn}
        with patch(
            'apps.tabdata.infrastructure.cascade_adapter.connections',
            fake_connections,
        ):
            with pytest.raises(RuntimeError) as exc_info:
                adapter.propagate_cell_changes(
                    table_id='t', changed_field_ids=['f'], record_ids=['r'],
                )
        assert 'atomic' in str(exc_info.value).lower()
        # adapter 文案应明确指出是 adapter 层,便于区分主入口
        assert 'DjangoCascadeAdapter' in str(exc_info.value)

    def test_adapter_inside_atomic_delegates_to_service(self):
        """adapter 在 atomic 内 → 透传调主服务(再触发主入口断言或正常返回)。

        通过 patch 主服务为 MagicMock,验证 adapter 确实走透传逻辑。
        """
        adapter = DjangoCascadeAdapter()
        fake_conn = MagicMock()
        fake_conn.in_atomic_block = True
        fake_connections = {TABDATA_DB_ALIAS: fake_conn}
        with patch(
            'apps.tabdata.infrastructure.cascade_adapter.connections',
            fake_connections,
        ):
            with patch.object(
                CascadeService, 'propagate_cell_changes', return_value=[],
            ) as mock_main:
                result = adapter.propagate_cell_changes(
                    table_id='t', changed_field_ids=['f1'], record_ids=['r1'],
                )
                assert result == []
                mock_main.assert_called_once()
                # 验证参数透传(str 类型保证)
                kwargs = mock_main.call_args.kwargs
                assert kwargs['table_id'] == 't'
                assert kwargs['changed_field_ids'] == ['f1']
                assert kwargs['record_ids'] == ['r1']




# ════════════════════════════════════════════════════════════════
# 4. 装饰器物理移除回归保护(辅助源码断言)
# ════════════════════════════════════════════════════════════════


class TestDecoratorRemovedFromSource:
    """L71 / W0-4 §6.3 — 防止后续 PR 把 ``@transaction.atomic`` 装饰器加回。

    主断言用运行时正反向(上面 TestCascadeEntryAssertion);
    本类用源码文本辅助断言,捕捉"装饰器误回退"低级错误。
    """

    def test_propagate_cell_changes_no_atomic_decorator(self):
        """``CascadeService.propagate_cell_changes`` 源码不应含
        ``@transaction.atomic`` 装饰器(W0-4 §3.0 / R10 修订要求)。"""
        try:
            source = inspect.getsource(CascadeService.propagate_cell_changes)
        except OSError:
            pytest.skip("源码不可访问,跳过文本断言")
            return
        if '@transaction.atomic' in source:
            warnings.warn(
                "propagate_cell_changes 源码包含 @transaction.atomic,"
                "可能是误回退。请优先依赖运行时主断言判断。",
                DeprecationWarning,
                stacklevel=2,
            )
            pytest.fail(
                'propagate_cell_changes 不应再带 @transaction.atomic 装饰器,'
                '事务由调用方负责，关联标题传播必须与记录写入处于同一事务'
            )

    def test_classmethod_signature_unchanged(self):
        """烟雾测试:类方法签名稳定,装饰器移除不影响调用约定。"""
        assert hasattr(CascadeService, 'propagate_cell_changes')
        assert callable(CascadeService.propagate_cell_changes)
        # 仍是 classmethod(检查 __self__ 是 CascadeService 类)
        bound = CascadeService.propagate_cell_changes
        assert getattr(bound, '__self__', None) is CascadeService


# ════════════════════════════════════════════════════════════════
# 5. 基类 _handle_cascade_compute 软警告语义守护
# ════════════════════════════════════════════════════════════════


class TestHandlerBaseCascadeSavepointSemantics:
    """装饰器移除后，基类
    ``_handle_cascade_compute`` 必须用显式 ``savepoint=True`` 包裹,
    保留"cascade 失败 = 软警告"语义,避免:

    - cascade 内 DB 异常 → PG 事务进入 InFailedSqlTransaction
    - try/except 救不了 → 后续主写入全部失败 → 整批 1000 行 rollback
    """

    def test_source_contains_savepoint_atomic_wrapper(self):
        """源码层守护:基类 ``_handle_cascade_compute`` 必须含
        ``with transaction.atomic(using=TABDATA_DB_ALIAS, savepoint=True)``。"""
        from apps.tabdata.handlers import _base as handler_base
        try:
            source = inspect.getsource(
                handler_base.RecordHandlerBase._handle_cascade_compute,
            )
        except OSError:
            pytest.skip("源码不可访问,跳过文本断言")
            return
        assert 'transaction.atomic' in source, (
            '_handle_cascade_compute 必须用 with transaction.atomic 包裹 '
            'cascade 调用 (W0-4 §3.3:装饰器移除后保留软警告隔离语义)'
        )
        assert 'savepoint=True' in source, (
            '_handle_cascade_compute 的 atomic 必须显式 savepoint=True '
            '(W0-4 §3.3:装饰器隐式 savepoint 移除后,显式声明保留隔离语义)'
        )


# ════════════════════════════════════════════════════════════════
# 6. update_by_filter_service._propagate_cascade 同款守护
# ════════════════════════════════════════════════════════════════


class TestUpdateByFilterCascadeSavepointSemantics:
    """L71 P1-3 / W0-4 §3.3 — A3 路径 ``_propagate_cascade`` 与基类语义
    必须对齐(显式 savepoint 包裹),避免 update-by-filter 主事务被 cascade
    异常污染。"""

    def test_source_contains_savepoint_atomic_wrapper(self):
        """源码层守护:``_propagate_cascade`` 必须含
        ``with transaction.atomic(using=TABDATA_DB_ALIAS, savepoint=True)``。"""
        from apps.tabdata.services.update_by_filter_service import (
            UpdateByFilterService,
        )
        try:
            source = inspect.getsource(
                UpdateByFilterService._propagate_cascade,
            )
        except OSError:
            pytest.skip("源码不可访问,跳过文本断言")
            return
        assert 'transaction.atomic' in source, (
            '_propagate_cascade 必须用 with transaction.atomic 包裹 '
            'cascade 调用 (L71:与 _handle_cascade_compute 对齐)'
        )
        assert 'savepoint=True' in source, (
            '_propagate_cascade 的 atomic 必须显式 savepoint=True '
            '(L71:保留 A3 主事务在 cascade 异常时的健康状态)'
        )

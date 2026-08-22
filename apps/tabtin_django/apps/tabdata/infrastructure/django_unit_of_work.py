"""
DjangoUnitOfWork — IUnitOfWork 的 Django 实现

职责：
  - 使用 Django 的 transaction.atomic 提供事务边界
  - 使用 savepoint 支持批量操作中的"部分成功"语义
  - 所有事务操作路由到 TABDATA_DB_ALIAS（PostgreSQL）

设计决策：
  - with_transaction 使用 transaction.atomic(using=db_alias)，
    对应现有 record_service.py 中散布的 transaction.atomic 调用。
  - with_savepoint 同样使用 transaction.atomic（Django 在嵌套调用时
    自动创建 savepoint），用于批量更新中逐条处理的部分失败回滚。
  - 事务完成后的回调（如 EventBus.publish_many）不在此类管理，
    由 Handler 在 with_transaction 返回后显式调用。
"""
from __future__ import annotations

import logging
from typing import Callable, TypeVar

from django.db import transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.ports import IUnitOfWork

logger = logging.getLogger('tabdata.infrastructure.unit_of_work')

T = TypeVar('T')


class DjangoUnitOfWork(IUnitOfWork):

    def __init__(self, db_alias: str = TABDATA_DB_ALIAS) -> None:
        self._db = db_alias

    def with_transaction(self, work: Callable[[], T]) -> T:
        with transaction.atomic(using=self._db):
            return work()

    def with_savepoint(self, work: Callable[[], T]) -> T:
        with transaction.atomic(using=self._db, savepoint=True):
            return work()
